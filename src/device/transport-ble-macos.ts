import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureBleHelper, HelperBuildError } from "./ble-helper-build.ts";
import { decideTrust, makeChallenge, PairingStore, PairingUnreadableError, verifyAuthResponse } from "./ble-trust.ts";
import { LineAssembler } from "./lines.ts";
import { TransportError, type DeviceCandidate, type DeviceConnection, type DeviceTransport, type TransportErrorCode } from "./transport.ts";

/**
 * macOS Bluetooth transport for the TokenBeacon Display Android app.
 *
 * Same DeviceTransport as the USB transports, so DeviceBridge (handshake,
 * heartbeat, reconnect, rate limit) and device-state/v1 are shared. The
 * Bluetooth part runs in a small helper app (ble-helper/, built on first use)
 * that is started with /usr/bin/open – public APIs only – so macOS asks for
 * Bluetooth access for the helper alone. The helper connects back to a private
 * Unix socket (0700 directory, one-time token, closed after one connection).
 *
 * Before any display data is sent, the phone must sign a fresh challenge with
 * its key; only the paired phone's key is accepted (see ble-trust.ts).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_HELPER_LINE = 8 * 1024;
export const BLE_TIMEOUTS = { CONNECT: 20_000, SCAN: 10_000, AUTH: 10_000, SEND: 5_000, CLOSE: 3_000 } as const;
/** Opening may wait for the user to confirm the pairing dialogs on the Mac and the phone. */
export const BLE_OPEN_TIMEOUT_MS = 60_000;

/** Starts the helper so that it connects to `socketPath` and sends `HELLO <token>`. */
export type LaunchHelper = (appPath: string, socketPath: string, token: string) => void;

export interface MacBleTransportOptions {
  /** Only this phone (display ID) is used; selection, not authentication. */
  deviceId: string | null;
  /** Returns the helper app path; builds it when needed. */
  prepareHelper?: () => Promise<string>;
  launchHelper?: LaunchHelper;
  pairing?: PairingStore;
  log?: (line: string) => void;
  timeouts?: Partial<typeof BLE_TIMEOUTS & { OPEN: number }>;
}

interface Waiter {
  accept: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: TransportError) => void;
  timer: NodeJS.Timeout;
  code: TransportErrorCode;
}

type HelperState = "none" | "starting" | "running";

export class MacBleTransport implements DeviceTransport {
  private readonly deviceId: string | null;
  private readonly prepareHelper: () => Promise<string>;
  private readonly launchHelper: LaunchHelper;
  private readonly pairing: PairingStore;
  private readonly log: (line: string) => void;
  private readonly timeouts: typeof BLE_TIMEOUTS & { OPEN: number };

  private state: HelperState = "none";
  private starting: Promise<void> | null = null;
  private socket: net.Socket | null = null;
  private bluetooth: "unknown" | "ready" | "off" | "unauthorized" | "unsupported" = "unknown";
  private waiter: Waiter | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private connection: BleConnection | null = null;
  private buffer = "";
  private disposed = false;
  private helperFailure: TransportErrorCode | null = null;

  constructor(options: MacBleTransportOptions) {
    this.deviceId = options.deviceId;
    this.prepareHelper = options.prepareHelper ?? (() => ensureBleHelper({ log: options.log }));
    this.launchHelper = options.launchHelper ?? launchWithOpen;
    this.pairing = options.pairing ?? new PairingStore();
    this.log = options.log ?? (() => undefined);
    this.timeouts = { ...BLE_TIMEOUTS, OPEN: BLE_OPEN_TIMEOUT_MS, ...options.timeouts };
  }

  async discover(): Promise<DeviceCandidate[]> {
    await this.start();
    if (this.bluetooth !== "ready") throw new TransportError(bluetoothCode(this.bluetooth));
    const line = await this.command("SCAN", (l) => l.startsWith("DEVICES ") || l.startsWith("ERR "), this.timeouts.SCAN, "discover_failed");
    if (!line.startsWith("DEVICES ")) throw new TransportError(this.bluetooth === "ready" ? "discover_failed" : bluetoothCode(this.bluetooth));
    let ids: unknown;
    try {
      ids = JSON.parse(line.slice("DEVICES ".length));
    } catch {
      throw new TransportError("discover_failed");
    }
    if (!Array.isArray(ids)) throw new TransportError("discover_failed");
    return ids
      .filter((id): id is string => typeof id === "string" && UUID.test(id))
      .slice(0, 8)
      .map((id) => ({ id, port: id, serial: null }));
  }

  async open(candidate: DeviceCandidate): Promise<DeviceConnection> {
    if (!UUID.test(candidate.port)) throw new TransportError("not_found");
    await this.start();
    const opened = await this.command(`OPEN ${candidate.port}`, (l) => l === "OPENED" || l.startsWith("ERR "), this.timeouts.OPEN, "open_failed");
    if (opened !== "OPENED") throw new TransportError(opened === "ERR not_found" ? "not_found" : "open_failed");
    const connection = new BleConnection(this);
    this.connection = connection;
    try {
      await this.authenticate();
    } catch (error) {
      this.closeConnection(connection);
      throw error;
    }
    return connection;
  }

  dispose(): void {
    this.disposed = true;
    this.connection?.lost();
    this.connection = null;
    this.failWaiter("open_failed");
    const socket = this.socket;
    this.socket = null;
    this.state = "none";
    if (socket) {
      socket.end("EXIT\n"); // the helper also exits when the socket closes
      setTimeout(() => socket.destroy(), 1_000).unref();
    }
  }

  // --- identity ----------------------------------------------------------------

  private async authenticate(): Promise<void> {
    const challenge = makeChallenge();
    const line = await this.command(`AUTH ${challenge.toString("base64")}`, (l) => l.startsWith("AUTHED ") || l.startsWith("ERR "), this.timeouts.AUTH, "untrusted");
    const presented = line.startsWith("AUTHED ") ? verifyAuthResponse(challenge, Buffer.from(line.slice(7), "base64")) : null;
    if (!presented) {
      this.log("Bluetooth display: a phone did not prove its identity and is ignored.");
      throw new TransportError("untrusted");
    }
    let paired;
    try {
      paired = this.pairing.load();
    } catch (error) {
      if (error instanceof PairingUnreadableError) {
        this.log("Bluetooth display: the saved pairing is damaged; no phone is trusted. Run `npm run ble:unpair` and pair again.");
        throw new TransportError("untrusted");
      }
      throw error;
    }
    const decision = decideTrust(paired, presented, this.deviceId);
    if (decision === "not_selected") throw new TransportError("not_selected");
    if (decision === "untrusted") {
      this.log("Bluetooth display: a phone that is not the paired display was ignored. To pair another phone, run `npm run ble:unpair` first.");
      throw new TransportError("untrusted");
    }
    if (decision === "pair") {
      this.pairing.save(presented);
      this.log(`Bluetooth display paired: ID ${presented.id}.`);
    }
  }

  // --- helper link ---------------------------------------------------------------

  /** @internal */
  async send(line: string): Promise<void> {
    const reply = await this.command(`SEND ${Buffer.from(line, "utf8").toString("base64")}`, (l) => l === "SENT" || l.startsWith("ERR "), this.timeouts.SEND, "open_failed");
    if (reply !== "SENT") throw new TransportError("open_failed");
  }

  /** @internal */
  closeConnection(connection: BleConnection): void {
    if (this.connection !== connection) return;
    this.connection = null;
    if (this.socket) void this.command("CLOSE", (l) => l === "CLOSED", this.timeouts.CLOSE, "open_failed").catch(() => undefined);
  }

  private start(): Promise<void> {
    if (this.disposed) return Promise.reject(new TransportError("open_failed"));
    if (this.state === "running") return Promise.resolve();
    if (this.helperFailure) return Promise.reject(new TransportError(this.helperFailure));
    if (this.starting) return this.starting;
    this.state = "starting";
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    let app: string;
    try {
      app = await this.prepareHelper();
    } catch (error) {
      // A missing compiler does not fix itself during this run; a failed build is retried on restart.
      this.helperFailure = "helper_unavailable";
      this.state = "none";
      this.log(
        error instanceof HelperBuildError && error.code === "swift_unavailable"
          ? "Bluetooth display: the Xcode Command Line Tools are needed (run `xcode-select --install`), then restart TokenBeacon."
          : "Bluetooth display: the helper could not be built; restart TokenBeacon to try again.",
      );
      throw new TransportError("helper_unavailable");
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "tokenbeacon-ble-")); // 0700
    const socketPath = path.join(dir, "s");
    const token = randomBytes(16).toString("hex");
    try {
      this.socket = await acceptHelper(socketPath, token, this.timeouts.CONNECT, () => this.launchHelper(app, socketPath, token));
    } catch {
      this.state = "none";
      throw new TransportError("helper_unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (this.disposed) {
      this.socket.destroy();
      this.socket = null;
      throw new TransportError("open_failed");
    }
    this.state = "running";
    this.bluetooth = "unknown";
    const socket = this.socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", () => undefined);
    socket.resume();
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.state = "none";
      this.connection?.lost();
      this.connection = null;
      this.failWaiter("open_failed");
    });
    // Bluetooth may need the user's permission first; discovery waits for READY.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  private command(text: string, accept: (line: string) => boolean, timeoutMs: number, code: TransportErrorCode): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const socket = this.socket;
        if (!socket || this.state !== "running") return reject(new TransportError(code));
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new TransportError(code));
        }, timeoutMs);
        timer.unref();
        this.waiter = { accept, resolve, reject, timer, code };
        socket.write(`${text}\n`);
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_HELPER_LINE && !this.buffer.includes("\n")) this.buffer = "";
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.onHelperLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onHelperLine(line: string): void {
    if (line === "READY") {
      this.bluetooth = "ready";
      return;
    }
    if (line === "ERR bluetooth_off" || line === "ERR bluetooth_unauthorized" || line === "ERR unsupported") {
      this.bluetooth = line === "ERR bluetooth_off" ? "off" : line === "ERR unsupported" ? "unsupported" : "unauthorized";
    }
    if (line.startsWith("DATA ")) {
      this.connection?.data(Buffer.from(line.slice(5), "base64"));
      return;
    }
    if (line === "LOST") {
      const connection = this.connection;
      this.connection = null;
      connection?.lost();
      return;
    }
    const waiter = this.waiter;
    if (waiter && waiter.accept(line)) {
      clearTimeout(waiter.timer);
      this.waiter = null;
      waiter.resolve(line);
    }
  }

  private failWaiter(code: TransportErrorCode): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(new TransportError(code));
    }
  }
}

function bluetoothCode(state: "unknown" | "ready" | "off" | "unauthorized" | "unsupported"): TransportErrorCode {
  if (state === "off") return "bluetooth_off";
  if (state === "unauthorized") return "bluetooth_unauthorized";
  if (state === "unsupported") return "unsupported";
  return "bluetooth_unavailable";
}

/**
 * Listens on a private socket until one client sends `HELLO <token>`, then
 * stops listening. Wrong clients are dropped; nothing else can connect after.
 * The returned socket is paused: call resume() after adding listeners.
 */
export function acceptHelper(socketPath: string, token: string, timeoutMs: number, launch: () => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const expected = Buffer.from(`HELLO ${token}`);
    const server = net.createServer({ pauseOnConnect: false });
    let settled = false;
    const finish = (error: Error | null, socket?: net.Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(socket!);
    };
    const timer = setTimeout(() => finish(new Error("helper_timeout")), timeoutMs);
    timer.unref();
    server.maxConnections = 4;
    server.on("connection", (socket) => {
      let first = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        first = Buffer.concat([first, chunk]);
        const newline = first.indexOf(0x0a);
        if (newline < 0) {
          if (first.length > 128) socket.destroy();
          return;
        }
        socket.off("data", onData);
        const hello = first.subarray(0, newline);
        const rest = first.subarray(newline + 1);
        if (settled || hello.length !== expected.length || !timingSafeEqual(hello, expected)) {
          socket.destroy();
          return;
        }
        // Paused until the caller listens, so nothing sent right after the hello is lost.
        socket.pause();
        if (rest.length > 0) socket.unshift(rest);
        finish(null, socket);
      };
      socket.on("data", onData);
      socket.on("error", () => undefined);
    });
    server.on("error", (error) => finish(error));
    server.listen(socketPath, () => {
      try {
        launch();
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

/** Starts the helper app through LaunchServices (public API, own Bluetooth permission). */
export const launchWithOpen: LaunchHelper = (appPath, socketPath, token) => {
  const child = spawn("/usr/bin/open", ["-n", "-g", "-a", appPath, "--args", "--connect", socketPath, token], {
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin", HOME: os.homedir() },
    detached: false,
  });
  child.on("error", () => undefined);
};

class BleConnection implements DeviceConnection {
  private readonly transport: MacBleTransport;
  private readonly lines = new LineAssembler((line) => this.lineListener?.(line));
  private lineListener: ((line: string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private closed = false;

  constructor(transport: MacBleTransport) {
    this.transport = transport;
  }

  write(line: string): Promise<void> {
    if (this.closed) return Promise.reject(new TransportError("open_failed"));
    return this.transport.send(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.closeConnection(this);
  }

  onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  /** Notification chunks from the phone, joined into protocol lines (max 512 bytes). */
  data(chunk: Buffer): void {
    if (!this.closed) this.lines.push(chunk);
  }

  lost(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListener?.();
  }
}
