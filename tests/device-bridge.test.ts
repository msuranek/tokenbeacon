import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BUSY_BACKOFF_MS,
  DeviceBridge,
  DEVICE_SILENCE_MS,
  HANDSHAKE_RETRY_MS,
  HANDSHAKE_TIMEOUT_MS,
  TICK_MS,
  type BridgeClock,
} from "../src/device/bridge.ts";
import { readDeviceConfig, readDeviceTitleSetting } from "../src/device/config.ts";
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
  answerHello(options: { dev?: string; nonce?: string; proto?: number[]; caps?: string[] } = {}) {
    const hello = this.messages().find((message) => message.t === "hello");
    assert.ok(hello && hello.t === "hello");
    this.emit(
      `${JSON.stringify({ tb: 1, t: "hello", dev: options.dev ?? "tokenbeacon-display", fw: "0.1.0", proto: options.proto ?? [1], ...(options.caps ? { caps: options.caps } : {}), nonce: options.nonce ?? hello.nonce, id: "c3a9f01b" })}\r\n`,
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

function setup(options: { snapshot?: MonitorSnapshot | null; serial?: string | null; sendTitle?: boolean } = {}) {
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
    sendTitle: options.sendTitle,
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

describe("device bridge: recovering a known display (UX-7)", () => {
  /** Unplug, then let the bridge open the port again (no answer yet). */
  async function reopen(context: Awaited<ReturnType<typeof connected>>) {
    const before = context.transport.connections.length;
    context.transport.last.unplug();
    await context.advance(1_000);
    assert.equal(context.transport.connections.length, before + 1, "a new connection was opened");
  }

  test("a known display that misses the handshake is retried with a growing delay, never ignored", async () => {
    const context = await connected();
    const { bridge, transport, advance, logs, clock } = context;
    /** Ticks until the bridge opens the port again; returns the time since the last open. */
    const untilNextOpen = async () => {
      const opens = transport.opened.length;
      const from = clock.time;
      for (let waited = 0; transport.opened.length === opens; waited += TICK_MS) {
        assert.ok(waited < 120_000, "the bridge must retry");
        await advance(TICK_MS);
      }
      return clock.time - from;
    };
    await reopen(context);
    const gaps: number[] = [];
    for (let attempt = 0; attempt < HANDSHAKE_RETRY_MS.length + 1; attempt += 1) {
      assert.equal(bridge.getStatus().state, "handshake");
      gaps.push(await untilNextOpen()); // silent: e.g. it has not noticed the port open again
      assert.equal(transport.connections.at(-2)!.closed, true, "the silent connection is closed");
    }
    // Each gap = handshake timeout + retry delay (within one tick); the delay grows and stays at the last step.
    const expected = [...HANDSHAKE_RETRY_MS, HANDSHAKE_RETRY_MS.at(-1)!].map((delay) => delay + HANDSHAKE_TIMEOUT_MS);
    gaps.forEach((gap, index) => assert.ok(Math.abs(gap - expected[index]) <= 2 * TICK_MS, `gap ${index}: ${gap} vs ${expected[index]}`));
    assert.deepEqual(bridge.getStatus(), { state: "handshake", detail: null });
    transport.last.answerHello(); // back
    await advance(TICK_MS);
    assert.equal(bridge.getStatus().state, "connected");
    assert.equal(logs.filter((line) => line.includes("retrying")).length, 1, "the retry is logged once per outage");
    assert.ok(logs.includes("USB display reconnected."));
    // After a success the delay starts from the beginning again.
    await reopen(context);
    const gap = await untilNextOpen();
    assert.ok(Math.abs(gap - (HANDSHAKE_RETRY_MS[0] + HANDSHAKE_TIMEOUT_MS)) <= 2 * TICK_MS, `after success: ${gap}`);
    bridge.stop();
  });

  test("a port that never answered stays ignored; a known one that answers wrongly is still rejected", async () => {
    const fresh = setup();
    await fresh.bridge.start();
    await fresh.advance(HANDSHAKE_TIMEOUT_MS + TICK_MS);
    assert.deepEqual(fresh.bridge.getStatus(), { state: "unrecognized", detail: "no_handshake" });
    await fresh.advance(60_000);
    assert.equal(fresh.transport.opened.length, 1, "never retried");

    for (const answer of [{ dev: "other-board" }, { nonce: "00000000" }, { proto: [2] }]) {
      const context = await connected();
      await reopen(context);
      context.transport.last.answerHello(answer);
      assert.equal(context.bridge.getStatus().state, "unrecognized", JSON.stringify(answer));
      await context.advance(120_000);
      assert.equal(context.transport.opened.length, 2, `${JSON.stringify(answer)}: never retried`);
    }
  });

  test("the disconnect reason is logged as a stable code, without device data", async () => {
    const reasons: string[] = [];
    {
      const context = await connected();
      context.transport.last.unplug();
      reasons.push(...context.logs);
    }
    {
      const context = await connected();
      await context.advance(DEVICE_SILENCE_MS + TICK_MS);
      reasons.push(...context.logs);
    }
    {
      const context = await connected();
      context.transport.last.failWrites = true;
      context.setSnapshot(snapshotWith(10));
      await context.advance(1_000);
      reasons.push(...context.logs);
    }
    const disconnects = reasons.filter((line) => line.startsWith("USB display disconnected"));
    assert.deepEqual(disconnects, [
      "USB display disconnected (disconnected); waiting for it to come back.",
      "USB display disconnected (device_silent); waiting for it to come back.",
      "USB display disconnected (write_failed); waiting for it to come back.",
    ]);
    for (const line of reasons) assert.ok(!/port-a|AAAA1111|c3a9f01b|5f1c9a2e/.test(line), line);
  });

  test("an older firmware without capabilities recovers the same way", async () => {
    const context = await connected(); // answerHello() without caps = firmware 0.1.0
    await reopen(context);
    await context.advance(HANDSHAKE_TIMEOUT_MS + TICK_MS + HANDSHAKE_RETRY_MS[0]);
    context.transport.last.answerHello();
    await context.advance(TICK_MS + 1_000);
    assert.equal(context.bridge.getStatus().state, "connected");
    const states = context.transport.last.messages().filter((message) => message.t === "state");
    assert.ok(states.length > 0 && !("title" in states.at(-1)!.ctx));
    context.bridge.stop();
  });
});

describe("device settings", () => {
  test("thread titles for the display are off unless TOKENBEACON_DEVICE_TITLE=on", () => {
    assert.deepEqual(readDeviceTitleSetting({}), { enabled: false, problem: null });
    for (const value of ["on", "ON", "1", "true", "yes"]) assert.deepEqual(readDeviceTitleSetting({ TOKENBEACON_DEVICE_TITLE: value }), { enabled: true, problem: null });
    for (const value of ["off", "0", "false", "no", " "]) assert.equal(readDeviceTitleSetting({ TOKENBEACON_DEVICE_TITLE: value }).enabled, false);
    assert.deepEqual(readDeviceTitleSetting({ TOKENBEACON_DEVICE_TITLE: "maybe" }), { enabled: false, problem: "invalid_device_title" });
  });

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

// --- Thread title (P-037) -------------------------------------------------------

/** Synthetic threads only. The newest by activity is the one the display shows. */
function snapshotWithThreads(threads: Array<{ title: string; used: number | null; at: string }>): MonitorSnapshot {
  return {
    limits: { fiveHour: { value: null, state: "unavailable", observedAt: null, source: null }, weekly: { value: null, state: "unavailable", observedAt: null, source: null } },
    projects: [],
    unassignedThreads: threads.map((thread) => ({
      title: thread.title,
      contextUsedPercent:
        thread.used === null
          ? { value: null, state: "unavailable", observedAt: null, source: null }
          : { value: thread.used, state: "current", observedAt: thread.at, source: "jsonl" },
      lastActivityAt: { value: thread.at, state: "current", observedAt: null, source: null },
    })),
  } as unknown as MonitorSnapshot;
}

describe("device bridge: thread title (P-037)", () => {
  const threads = [
    { title: "Starší vlákno", used: 80, at: "2026-11-19T10:00:00Z" },
    { title: "Najít příčinu chybějících zástupů", used: 17, at: "2026-11-19T11:59:00Z" },
  ];

  async function connect(options: { sendTitle?: boolean; caps?: string[] }) {
    const context = setup({ snapshot: snapshotWithThreads(threads), sendTitle: options.sendTitle });
    await context.bridge.start();
    context.transport.last.answerHello({ caps: options.caps });
    await context.advance(TICK_MS);
    const states = () => context.transport.last.messages().filter((message) => message.t === "state");
    return { ...context, states };
  }

  test("sent only when turned on and the device announced the capability", async () => {
    for (const [sendTitle, caps, expected] of [
      [false, undefined, undefined],
      [false, ["title"], undefined],
      [true, undefined, undefined],
      [true, ["later_feature"], undefined],
      [true, ["title"], "Najít příčinu chybějících zástupů"],
    ] as const) {
      const { states, bridge } = await connect({ sendTitle, caps: caps ? [...caps] : undefined });
      const ctx = states().at(-1)!.ctx;
      assert.equal("title" in ctx ? ctx.title : undefined, expected, `sendTitle=${sendTitle} caps=${caps}`);
      bridge.stop();
    }
  });

  test("the title and the context always come from the same thread, and follow it when it changes", async () => {
    const context = await connect({ sendTitle: true, caps: ["title"] });
    let ctx = context.states().at(-1)!.ctx;
    assert.deepEqual(ctx.st !== "unavailable" && { used: ctx.used, title: ctx.title }, { used: 17, title: "Najít příčinu chybějících zástupů" });
    // Work moves to another thread: both values switch together, at once.
    context.setSnapshot(snapshotWithThreads([...threads, { title: "Nové vlákno – ESP32 UX", used: 42, at: "2026-11-19T12:00:30Z" }]));
    await context.advance(1_000);
    ctx = context.states().at(-1)!.ctx;
    assert.deepEqual(ctx.st !== "unavailable" && { used: ctx.used, title: ctx.title }, { used: 42, title: "Nové vlákno – ESP32 UX" });
    // A newest thread without a context value: no title either (never another thread's name).
    context.setSnapshot(snapshotWithThreads([...threads, { title: "Bez kontextu", used: null, at: "2026-11-19T12:01:00Z" }]));
    await context.advance(1_000);
    assert.deepEqual(context.states().at(-1)!.ctx, { st: "unavailable" });
    context.bridge.stop();
  });

  test("a reconnect negotiates again; the title is never logged", async () => {
    const context = await connect({ sendTitle: true, caps: ["title"] });
    const first = context.transport.last;
    first.unplug();
    await context.advance(1_000);
    assert.notEqual(context.transport.last, first, "a new connection");
    context.transport.last.answerHello(); // an older firmware answers this time
    await context.advance(TICK_MS + 1_000);
    const ctx = context.transport.last.messages().filter((message) => message.t === "state").at(-1)!.ctx;
    assert.ok(!("title" in ctx), "no title after reconnecting to a device without the capability");
    assert.ok(context.logs.every((line) => !line.includes("zástup") && !line.includes("vlákno")));
    context.bridge.stop();
  });
});
