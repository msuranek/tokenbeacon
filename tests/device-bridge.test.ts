import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BUSY_BACKOFF_MS,
  DeviceBridge,
  DEVICE_SILENCE_MS,
  HANDSHAKE_TIMEOUT_MS,
  TICK_MS,
  type BridgeClock,
} from "../src/device/bridge.ts";
import { readDeviceConfig } from "../src/device/config.ts";
import { LineAssembler } from "../src/device/lines.ts";
import { parseHostLine } from "../src/device/protocol.ts";
import { TransportError, type DeviceCandidate, type DeviceConnection, type DeviceTransport } from "../src/device/transport.ts";
import type { MonitorSnapshot } from "../src/types.ts";

// --- Fakes ------------------------------------------------------------------

class FakeClock implements BridgeClock {
  time = Date.parse("2026-11-19T12:00:00Z");
  now() {
    return this.time;
  }
  setInterval() {
    return 1;
  }
  clearInterval() {}
}

class FakeConnection implements DeviceConnection {
  written: string[] = [];
  closed = false;
  failWrites = false;
  private lineListener: (line: string) => void = () => undefined;
  private closeListener: () => void = () => undefined;
  async write(line: string) {
    if (this.failWrites) throw new Error("EIO");
    this.written.push(line);
  }
  close() {
    this.closed = true;
  }
  onLine(listener: (line: string) => void) {
    this.lineListener = listener;
  }
  onClose(listener: () => void) {
    this.closeListener = listener;
  }
  emit(line: string) {
    this.lineListener(line);
  }
  unplug() {
    this.closeListener();
  }
  messages() {
    return this.written.map((line) => {
      const parsed = parseHostLine(line);
      assert.ok(parsed.ok, line);
      return parsed.message;
    });
  }
  /** Answer the host hello like the firmware does. */
  answerHello(options: { dev?: string; nonce?: string; proto?: number[] } = {}) {
    const hello = this.messages().find((message) => message.t === "hello");
    assert.ok(hello && hello.t === "hello");
    this.emit(
      `${JSON.stringify({ tb: 1, t: "hello", dev: options.dev ?? "tokenbeacon-display", fw: "0.1.0", proto: options.proto ?? [1], nonce: options.nonce ?? hello.nonce, id: "c3a9f01b" })}\r\n`,
    );
  }
}

class FakeTransport implements DeviceTransport {
  candidates: DeviceCandidate[] = [{ id: "port-a", port: "port-a", serial: "AAAA1111" }];
  connections: FakeConnection[] = [];
  opened: string[] = [];
  openError: TransportError | null = null;
  discoverError = false;
  disposed = false;
  async discover() {
    if (this.discoverError) throw new Error("ioreg failed");
    return this.candidates;
  }
  async open(candidate: DeviceCandidate) {
    this.opened.push(candidate.id);
    if (this.openError) throw this.openError;
    const connection = new FakeConnection();
    this.connections.push(connection);
    return connection;
  }
  dispose() {
    this.disposed = true;
  }
  get last() {
    return this.connections.at(-1)!;
  }
}

function snapshotWith(fiveUsed: number | null): MonitorSnapshot {
  const limit = (used: number | null) => ({
    value: used === null ? null : { usedPercent: used, windowMinutes: 300, resetsAt: "2026-11-19T14:00:00Z", status: "active" },
    state: used === null ? "unavailable" : "last-known",
    observedAt: "2026-11-19T11:59:00Z",
    source: null,
  });
  return { limits: { fiveHour: limit(fiveUsed), weekly: limit(null) }, projects: [], unassignedThreads: [] } as unknown as MonitorSnapshot;
}

function setup(options: { snapshot?: MonitorSnapshot | null; serial?: string | null } = {}) {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  const logs: string[] = [];
  let snapshot: MonitorSnapshot | null = options.snapshot === undefined ? snapshotWith(42) : options.snapshot;
  const bridge = new DeviceBridge({
    config: { mode: "auto", serial: options.serial ?? null },
    transport,
    getSnapshot: () => snapshot,
    hostVersion: "0.3.0",
    log: (line) => logs.push(line),
    clock,
    nonce: () => "5f1c9a2e",
  });
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      clock.time += TICK_MS;
      await bridge.tick();
    }
  };
  const setSnapshot = (next: MonitorSnapshot | null) => {
    snapshot = next;
  };
  return { bridge, clock, transport, logs, advance, setSnapshot };
}

async function connected() {
  const context = setup();
  await context.bridge.start();
  context.transport.last.answerHello();
  await context.advance(TICK_MS);
  return context;
}

// --- Tests ------------------------------------------------------------------

describe("device bridge", () => {
  test("handshake, then state on change and as a heartbeat, at most once per second", async () => {
    const { bridge, transport, advance, setSnapshot, logs } = await connected();
    assert.equal(bridge.getStatus().state, "connected");
    assert.deepEqual(logs, ["USB display connected."]);
    const connection = transport.last;
    const states = () => connection.messages().filter((message) => message.t === "state");
    assert.equal(states().length, 1, "state right after the handshake");
    await advance(5_000);
    assert.equal(states().length, 1, "no resend while nothing changed");
    connection.emit('{"tb":1,"t":"alive","seq":0,"up":5}\n');
    setSnapshot(snapshotWith(50));
    await advance(TICK_MS);
    assert.equal(states().length, 2, "change is sent");
    setSnapshot(snapshotWith(51));
    await advance(TICK_MS);
    assert.equal(states().length, 2, "rate limited");
    await advance(1_000);
    assert.equal(states().length, 3);
    connection.emit('{"tb":1,"t":"alive","seq":2,"up":7}\n');
    await advance(10_000);
    assert.equal(states().length, 4, "heartbeat after 10 s");
    const seqs = states().map((message) => (message.t === "state" ? message.seq : -1));
    assert.deepEqual(seqs, [0, 1, 2, 3]);
  });

  test("a port that answers as another device is rejected and never retried", async () => {
    const { bridge, transport, advance } = setup();
    transport.candidates = [
      { id: "other", port: "other", serial: null },
      { id: "mine", port: "mine", serial: null },
    ];
    await bridge.start();
    transport.last.answerHello({ dev: "other-board" });
    assert.equal(bridge.getStatus().state, "unrecognized");
    assert.equal(transport.last.closed, true);
    await advance(5_000);
    assert.deepEqual(transport.opened, ["other", "mine"]);
    transport.last.answerHello();
    await advance(TICK_MS);
    assert.equal(bridge.getStatus().state, "connected");
  });

  test("wrong nonce, missing protocol version and silence during the handshake are rejected", async () => {
    for (const answer of [{ nonce: "00000000" }, { proto: [2] }]) {
      const { bridge, transport } = setup();
      await bridge.start();
      transport.last.answerHello(answer);
      assert.equal(bridge.getStatus().state, "unrecognized", JSON.stringify(answer));
    }
    const { bridge, transport, advance } = setup();
    await bridge.start();
    transport.last.emit("ESP-ROM:esp32s3-20210327\r\n"); // boot noise is ignored
    assert.equal(bridge.getStatus().state, "handshake");
    await advance(HANDSHAKE_TIMEOUT_MS + TICK_MS);
    assert.deepEqual(bridge.getStatus(), { state: "unrecognized", detail: "no_handshake" });
  });

  test("a busy port backs off and is reported once", async () => {
    const { bridge, transport, advance, logs } = setup();
    transport.openError = new TransportError("busy");
    await bridge.start();
    assert.deepEqual(bridge.getStatus(), { state: "busy", detail: "port_busy" });
    await advance(BUSY_BACKOFF_MS[0] - TICK_MS);
    assert.equal(transport.opened.length, 1);
    await advance(TICK_MS);
    assert.equal(transport.opened.length, 2);
    await advance(BUSY_BACKOFF_MS[1]);
    assert.equal(transport.opened.length, 3);
    assert.equal(logs.length, 1);
    transport.openError = null;
    await advance(BUSY_BACKOFF_MS[2]);
    transport.last.answerHello();
    await advance(TICK_MS);
    assert.equal(bridge.getStatus().state, "connected");
  });

  test("unplugging and a silent device lead to a new connection", async () => {
    const { bridge, transport, advance, logs } = await connected();
    transport.last.unplug();
    assert.deepEqual(bridge.getStatus(), { state: "searching", detail: "disconnected" });
    await advance(1_000);
    assert.equal(transport.connections.length, 2);
    transport.last.answerHello();
    await advance(TICK_MS);
    assert.equal(bridge.getStatus().state, "connected");
    assert.ok(logs.includes("USB display reconnected."));
    await advance(DEVICE_SILENCE_MS + TICK_MS);
    assert.equal(transport.connections[1].closed, true);
    assert.equal(bridge.getStatus().detail, "device_silent");
  });

  test("write failures, discovery failures and a missing snapshot never throw", async () => {
    const { bridge, transport, advance, setSnapshot } = await connected();
    transport.last.failWrites = true;
    setSnapshot(snapshotWith(10));
    await advance(1_000);
    assert.deepEqual(bridge.getStatus(), { state: "searching", detail: "write_failed" });
    transport.discoverError = true;
    await advance(5_000);
    assert.deepEqual(bridge.getStatus(), { state: "searching", detail: "discover_failed" });

    const loading = setup({ snapshot: null });
    await loading.bridge.start();
    loading.transport.last.answerHello();
    await loading.advance(3_000);
    assert.equal(loading.transport.last.messages().filter((message) => message.t === "state").length, 0);
  });

  test("auto mode can be limited to one serial number", async () => {
    const { bridge, transport, advance } = setup({ serial: "BBBB2222" });
    await bridge.start();
    assert.equal(transport.opened.length, 0);
    assert.equal(bridge.getStatus().state, "searching");
    transport.candidates = [...transport.candidates, { id: "port-b", port: "port-b", serial: "BBBB2222" }];
    await advance(5_000);
    assert.deepEqual(transport.opened, ["port-b"]);
  });

  test("stop closes the port and releases the transport", async () => {
    const { bridge, transport } = await connected();
    bridge.stop();
    assert.equal(transport.last.closed, true);
    assert.equal(transport.disposed, true);
    assert.equal(bridge.getStatus().state, "stopped");
    await bridge.tick();
    assert.equal(transport.connections.length, 1);
  });

  test("only the protocol is ever written to the port", async () => {
    const { transport, advance, setSnapshot } = await connected();
    setSnapshot(snapshotWith(77));
    await advance(2_000);
    for (const line of transport.last.written) {
      assert.ok(parseHostLine(line).ok, line);
      assert.ok(line.endsWith("\n"));
    }
  });
});

describe("device settings", () => {
  test("off unless TOKENBEACON_DEVICE is set; ports are validated per system", () => {
    assert.deepEqual(readDeviceConfig({}, "darwin"), { config: { mode: "off" }, problem: null });
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "off" }, "win32"), { config: { mode: "off" }, problem: null });
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "auto" }, "darwin"), { config: { mode: "auto", serial: null }, problem: null });
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "AUTO", TOKENBEACON_DEVICE_SERIAL: "C3A9F01B" }, "win32").config, {
      mode: "auto",
      serial: "C3A9F01B",
    });
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "com5" }, "win32").config, { mode: "port", port: "COM5" });
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "/dev/cu.usbmodem1101" }, "darwin").config, {
      mode: "port",
      port: "/dev/cu.usbmodem1101",
    });
    for (const [value, platform] of [
      ["/dev/cu.usbmodem1101", "win32"],
      ["COM5", "darwin"],
      ["/dev/tty.usbmodem1101", "darwin"],
      ["/dev/cu.../../disk0", "darwin"],
      ["\\\\.\\COM5", "win32"],
      ["COM0", "win32"],
      ["/etc/passwd", "darwin"],
    ] as const) {
      assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: value }, platform), { config: { mode: "off" }, problem: "invalid_device_setting" }, value);
    }
    assert.equal(readDeviceConfig({ TOKENBEACON_DEVICE: "auto", TOKENBEACON_DEVICE_SERIAL: "a b" }, "darwin").problem, "invalid_device_serial");
    assert.equal(readDeviceConfig({ TOKENBEACON_DEVICE: "auto" }, "linux").problem, "unsupported_platform");
  });
});

describe("line assembler", () => {
  test("splits chunks, keeps UTF-8 intact and drops over-long lines with bounded memory", () => {
    const lines: string[] = [];
    const assembler = new LineAssembler((line) => lines.push(line), 32);
    const text = Buffer.from('{"a":"ž"}\r\n{"b":2}\n', "utf8");
    for (const byte of text) assembler.push(Buffer.from([byte]));
    assembler.push(Buffer.from("x".repeat(100)));
    assembler.push(Buffer.from("y".repeat(100) + "\n{\"c\":3}\n"));
    assert.deepEqual(lines, ['{"a":"ž"}\r\n', '{"b":2}\n', '{"c":3}\n']);
    assert.equal(assembler.dropped, 1);
  });
});
