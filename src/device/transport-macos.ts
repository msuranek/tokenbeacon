import { execFile } from "node:child_process";
import { close as closeFd, constants, existsSync, open as openFd } from "node:fs";
import tty from "node:tty";
import type { DeviceConfig } from "./config.ts";
import { LineAssembler } from "./lines.ts";
import {
  DISPLAY_PRODUCT_NAME,
  ESPRESSIF_VID,
  TransportError,
  type DeviceCandidate,
  type DeviceConnection,
  type DeviceTransport,
} from "./transport.ts";

/**
 * macOS: finds the display with `ioreg` (fixed arguments, no shell) and talks
 * to it through its /dev/cu.* call-out device as a raw tty. No npm packages.
 */

const IOREG = "/usr/sbin/ioreg";
const STTY = "/bin/stty";
const CALLOUT = /^\/dev\/cu\.[A-Za-z0-9._-]{1,64}$/;
const SERIAL = /^[0-9A-Za-z]{1,64}$/;
/** Pending output larger than this means the device stopped reading. */
const MAX_PENDING_WRITE_BYTES = 4_096;

export class MacTransport implements DeviceTransport {
  private readonly config: Exclude<DeviceConfig, { mode: "off" }>;

  constructor(config: Exclude<DeviceConfig, { mode: "off" }>) {
    this.config = config;
  }

  async discover(): Promise<DeviceCandidate[]> {
    if (this.config.mode === "port") {
      return existsSync(this.config.port) ? [{ id: this.config.port, port: this.config.port, serial: null }] : [];
    }
    const output = await run(IOREG, ["-r", "-c", "IOUSBHostDevice", "-l", "-w0"], 5_000, 8 * 1024 * 1024).catch(() => {
      throw new TransportError("discover_failed");
    });
    return parseIoregDisplays(output);
  }

  async open(candidate: DeviceCandidate): Promise<DeviceConnection> {
    if (!CALLOUT.test(candidate.port) && candidate.port !== (this.config.mode === "port" ? this.config.port : "")) {
      throw new TransportError("open_failed");
    }
    return openTty(candidate.port);
  }

  dispose(): void {}
}

/**
 * Picks TokenBeacon displays out of `ioreg -r -c IOUSBHostDevice -l` output:
 * vendor 0x303A, product name "TokenBeacon Display" and a /dev/cu.* call-out
 * device. Only the device's own properties (before its first child) count.
 */
export function parseIoregDisplays(output: string): DeviceCandidate[] {
  const candidates: DeviceCandidate[] = [];
  const blocks = output.split(/^(?=\+-o )/m).filter((block) => block.startsWith("+-o "));
  for (const block of blocks) {
    const lines = block.split("\n");
    const firstChild = lines.findIndex((line, index) => index > 0 && line.includes("+-o "));
    const own = (firstChild === -1 ? lines : lines.slice(0, firstChild)).join("\n");
    const vendor = Number(/"idVendor" = (\d+)/.exec(own)?.[1]);
    const product = /"USB Product Name" = "([^"]*)"/.exec(own)?.[1];
    if (vendor !== ESPRESSIF_VID || product !== DISPLAY_PRODUCT_NAME) continue;
    const serialRaw = /"kUSBSerialNumberString" = "([^"]*)"/.exec(own)?.[1] ?? "";
    const serial = SERIAL.test(serialRaw) ? serialRaw : null;
    for (const match of block.matchAll(/"IOCalloutDevice" = "([^"]*)"/g)) {
      if (CALLOUT.test(match[1])) candidates.push({ id: match[1], port: match[1], serial });
    }
  }
  return candidates;
}

/** Opens a serial tty in raw mode. Exported for the pseudo-terminal integration test. */
export async function openTty(port: string): Promise<DeviceConnection> {
  // A plain descriptor (not a FileHandle): tty.ReadStream owns and closes it.
  const fd = await new Promise<number>((resolve, reject) =>
    openFd(port, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK, (error, descriptor) => {
      if (!error) return resolve(descriptor);
      const code = error.code;
      reject(new TransportError(code === "EBUSY" ? "busy" : code === "ENOENT" ? "not_found" : "open_failed"));
    }),
  );
  try {
    // Raw bytes, no echo, ignore modem lines, keep DTR on close (no reset).
    await run(STTY, ["-f", port, "raw", "-echo", "clocal", "-hupcl"], 2_000, 64 * 1024);
    if (!tty.isatty(fd)) throw new Error("not a tty");
  } catch {
    closeFd(fd, () => undefined);
    throw new TransportError("open_failed");
  }
  const stream = new tty.ReadStream(fd);
  return new StreamConnection(stream);
}

class StreamConnection implements DeviceConnection {
  private readonly stream: tty.ReadStream;
  private readonly lineListeners: Array<(line: string) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private closed = false;
  private readonly assembler = new LineAssembler((line) => {
    for (const listener of this.lineListeners) listener(line);
  });

  constructor(stream: tty.ReadStream) {
    this.stream = stream;
    stream.on("data", (chunk: Buffer) => this.assembler.push(chunk));
    const finish = () => this.finish();
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  }

  write(line: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("closed"));
    if (this.stream.writableLength > MAX_PENDING_WRITE_BYTES) return Promise.reject(new Error("device not reading"));
    return new Promise((resolve, reject) => {
      this.stream.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): void {
    this.stream.destroy();
    this.finish();
  }

  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
}

function run(file: string, args: string[], timeout: number, maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer, encoding: "utf8", windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}
