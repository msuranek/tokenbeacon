import { randomBytes } from "node:crypto";
import type { MonitorSnapshot } from "../types.ts";
import type { DeviceConfig } from "./config.ts";
import { buildHello, buildStateMessage, HEARTBEAT_SECONDS, nextSeq, parseDeviceLine, PROTOCOL_VERSION, serializeMessage, TITLE_CAPABILITY } from "./protocol.ts";
import { TransportError, type DeviceCandidate, type DeviceConnection, type DeviceTransport } from "./transport.ts";

/**
 * Drives the optional USB display: finds a TokenBeacon display, verifies it
 * with a handshake, sends display data and reconnects after unplugging or a
 * reset. It only reads the in-memory snapshot and never throws into the
 * caller: every failure becomes a status code, so the dashboard is unaffected.
 */

export type DeviceState = "searching" | "handshake" | "connected" | "busy" | "unrecognized" | "stopped";

export interface DeviceStatus {
  state: DeviceState;
  /** Stable code for the last problem, if any. Never a port name or device data. */
  detail: string | null;
}

export interface BridgeClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface BridgeOptions {
  config: Exclude<DeviceConfig, { mode: "off" }>;
  transport: DeviceTransport;
  getSnapshot: () => MonitorSnapshot | null;
  hostVersion: string;
  log?: (message: string) => void;
  /**
   * Send the name of the thread the context belongs to (TOKENBEACON_DEVICE_TITLE=on),
   * and only to a device that announced the "title" capability in this connection.
   */
  sendTitle?: boolean;
  clock?: BridgeClock;
  nonce?: () => string;
}

export const TICK_MS = 250;
export const DISCOVERY_INTERVAL_MS = 5_000;
export const HANDSHAKE_TIMEOUT_MS = 2_000;
export const MIN_SEND_INTERVAL_MS = 1_000;
export const DEVICE_SILENCE_MS = 30_000;
export const BUSY_BACKOFF_MS = [15_000, 30_000, 60_000] as const;
/**
 * A display that already completed a handshake in this run and then stays
 * silent during a new one (still booting, or it has not noticed the port open
 * again) is tried again after these delays instead of being ignored.
 */
export const HANDSHAKE_RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;

const systemClock: BridgeClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export class DeviceBridge {
  private readonly options: BridgeOptions;
  private readonly clock: BridgeClock;
  private readonly log: (message: string) => void;
  private readonly makeNonce: () => string;
  private timer: unknown = null;
  private ticking = false;
  private status: DeviceStatus = { state: "searching", detail: null };

  private connection: DeviceConnection | null = null;
  private candidate: DeviceCandidate | null = null;
  private nonce: string | null = null;
  /** Capabilities from the device hello of the current connection only. */
  private deviceCaps = new Set<string>();
  private handshakeDeadline = 0;
  private nextDiscoveryAt = 0;
  private busyAttempts = 0;
  private readonly rejected = new Set<string>();
  /** Ports that answered as a TokenBeacon display in this run. */
  private readonly verified = new Set<string>();
  private handshakeRetries = 0;
  private seq = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastSentKey: string | null = null;
  private lastHeardAt = 0;
  private connectedOnce = false;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => undefined);
    this.makeNonce = options.nonce ?? (() => randomBytes(4).toString("hex"));
  }

  /** Starts the background loop; the returned promise settles after the first step. */
  start(): Promise<void> {
    if (this.timer !== null) return Promise.resolve();
    this.status = { state: "searching", detail: null };
    this.timer = this.clock.setInterval(() => void this.tick(), TICK_MS);
    return this.tick();
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.timer = null;
    this.closeConnection();
    this.options.transport.dispose();
    this.status = { state: "stopped", detail: null };
  }

  getStatus(): DeviceStatus {
    return { ...this.status };
  }

  /** One step of the state machine. Public for tests; overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.ticking || this.timer === null) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      if (!this.connection) {
        if (now >= this.nextDiscoveryAt) await this.discoverAndOpen(now);
      } else if (this.status.state === "handshake") {
        if (now > this.handshakeDeadline) this.handshakeTimedOut(now);
      } else if (this.status.state === "connected") {
        if (now - this.lastHeardAt > DEVICE_SILENCE_MS) {
          this.drop("device_silent", now + MIN_SEND_INTERVAL_MS);
        } else {
          await this.sendState(now);
        }
      }
    } catch {
      // Defensive: a bug here must never reach the HTTP server or the refresh loop.
      this.drop("bridge_error", this.clock.now() + DISCOVERY_INTERVAL_MS);
    } finally {
      this.ticking = false;
    }
  }

  private async discoverAndOpen(now: number): Promise<void> {
    this.nextDiscoveryAt = now + DISCOVERY_INTERVAL_MS;
    let candidates: DeviceCandidate[];
    try {
      candidates = await this.options.transport.discover();
    } catch {
      this.setStatus("searching", "discover_failed");
      return;
    }
    const config = this.options.config;
    const usable = candidates.filter(
      (candidate) =>
        !this.rejected.has(candidate.id) &&
        (config.mode !== "auto" || config.serial === null || candidate.serial === config.serial),
    );
    const candidate = usable[0];
    if (!candidate) {
      if (this.status.state !== "busy" && this.status.state !== "unrecognized") this.setStatus("searching", "no_display");
      return;
    }
    let connection: DeviceConnection;
    try {
      connection = await this.options.transport.open(candidate);
    } catch (error) {
      const code = error instanceof TransportError ? error.code : "open_failed";
      if (code === "busy") {
        const wait = BUSY_BACKOFF_MS[Math.min(this.busyAttempts, BUSY_BACKOFF_MS.length - 1)];
        this.busyAttempts += 1;
        this.nextDiscoveryAt = this.clock.now() + wait;
        if (this.status.state !== "busy") this.log("USB display: the port is in use by another program; retrying.");
        this.setStatus("busy", "port_busy");
      } else {
        this.setStatus("searching", code);
      }
      return;
    }
    if (this.timer === null) {
      connection.close(); // stopped while opening
      return;
    }
    this.busyAttempts = 0;
    this.connection = connection;
    this.candidate = candidate;
    this.nonce = this.makeNonce();
    this.handshakeDeadline = this.clock.now() + HANDSHAKE_TIMEOUT_MS;
    this.setStatus("handshake", null);
    connection.onLine((line) => this.onLine(connection, line));
    connection.onClose(() => {
      if (this.connection === connection) this.drop("disconnected", this.clock.now() + MIN_SEND_INTERVAL_MS);
    });
    await this.write(serializeMessage(buildHello(this.options.hostVersion, this.nonce)));
  }

  private onLine(connection: DeviceConnection, line: string): void {
    if (connection !== this.connection) return;
    const parsed = parseDeviceLine(line);
    if (!parsed.ok) {
      // Boot messages or noise are ignored; only another identity is a verdict.
      if (this.status.state === "handshake" && parsed.code === "unknown_device") this.reject(parsed.code);
      return;
    }
    const message = parsed.message;
    const now = this.clock.now();
    if (this.status.state === "handshake") {
      if (message.type !== "hello") return; // e.g. boot output before the answer
      if (message.nonce !== this.nonce) return this.reject("nonce_mismatch");
      if (!message.protocols.includes(PROTOCOL_VERSION)) return this.reject("unsupported_version");
      this.lastHeardAt = now;
      this.lastSentAt = Number.NEGATIVE_INFINITY;
      this.lastSentKey = null;
      this.deviceCaps = new Set(message.caps);
      if (this.candidate) this.verified.add(this.candidate.id);
      this.handshakeRetries = 0;
      this.setStatus("connected", null);
      this.log(this.connectedOnce ? "USB display reconnected." : "USB display connected.");
      this.connectedOnce = true;
      return;
    }
    if (message.type === "alive" || message.type === "error") this.lastHeardAt = now;
  }

  private async sendState(now: number): Promise<void> {
    const snapshot = this.options.getSnapshot();
    if (!snapshot || now - this.lastSentAt < MIN_SEND_INTERVAL_MS) return;
    const message = buildStateMessage(snapshot, this.seq, now, {
      title: this.options.sendTitle === true && this.deviceCaps.has(TITLE_CAPABILITY),
    });
    // Ages and countdowns change every second; the device advances them itself.
    const key = JSON.stringify(message, (name, value) => (name === "seq" || name === "age" || name === "reset" ? undefined : value));
    if (key === this.lastSentKey && now - this.lastSentAt < HEARTBEAT_SECONDS * 1_000) return;
    this.lastSentAt = now;
    this.lastSentKey = key;
    this.seq = nextSeq(this.seq);
    await this.write(serializeMessage(message));
  }

  private async write(line: string): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    try {
      await connection.write(line);
    } catch {
      if (this.connection === connection) this.drop("write_failed", this.clock.now() + MIN_SEND_INTERVAL_MS);
    }
  }

  /**
   * No answer to the hello in time. A port that never answered is ignored for
   * the rest of the run; a display that already answered in this run is only
   * retried later. A wrong identity, nonce or protocol is still a verdict
   * (reject), so retrying never makes the bridge accept another device.
   */
  private handshakeTimedOut(now: number): void {
    if (!this.candidate || !this.verified.has(this.candidate.id)) return this.reject("no_handshake");
    const wait = HANDSHAKE_RETRY_MS[Math.min(this.handshakeRetries, HANDSHAKE_RETRY_MS.length - 1)];
    if (this.handshakeRetries === 0) this.log("USB display: no answer to the handshake (no_handshake); retrying.");
    this.handshakeRetries += 1;
    this.closeConnection();
    this.nextDiscoveryAt = now + wait;
    this.setStatus("searching", "no_handshake");
  }

  /** The port answered, but not as a TokenBeacon display: never try it again in this run. */
  private reject(code: string): void {
    if (this.candidate) this.rejected.add(this.candidate.id);
    this.log(`USB display: a port did not answer as a TokenBeacon display (${code}) and is ignored.`);
    this.closeConnection();
    this.nextDiscoveryAt = this.clock.now() + DISCOVERY_INTERVAL_MS;
    this.setStatus("unrecognized", code);
  }

  private drop(code: string, retryAt: number): void {
    const wasConnected = this.status.state === "connected";
    this.closeConnection();
    this.nextDiscoveryAt = retryAt;
    // Only the stable code is logged, never port names or device data.
    if (wasConnected) this.log(`USB display disconnected (${code}); waiting for it to come back.`);
    this.setStatus("searching", code);
  }

  private closeConnection(): void {
    const connection = this.connection;
    this.connection = null;
    this.candidate = null;
    this.nonce = null;
    this.deviceCaps = new Set();
    try {
      connection?.close();
    } catch {
      // Closing a vanished port can fail; the connection is gone either way.
    }
  }

  private setStatus(state: DeviceState, detail: string | null): void {
    this.status = { state, detail };
  }
}
