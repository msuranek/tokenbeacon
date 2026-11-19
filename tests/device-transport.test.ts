import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { DeviceBridge } from "../src/device/bridge.ts";
import { openTty, parseIoregDisplays } from "../src/device/transport-macos.ts";
import { HELPER_SCRIPT, parseHelperPorts, powershellPath, WindowsTransport } from "../src/device/transport-windows.ts";
import { TransportError, type DeviceTransport } from "../src/device/transport.ts";
import type { MonitorSnapshot } from "../src/types.ts";
import { createTempRoot } from "./helpers/fixture-codex-home.ts";

// Synthetic `ioreg -r -c IOUSBHostDevice -l -w0` output (fictional devices).
const IOREG = `+-o USB2.0 Hub@01100000  <class IOUSBHostDevice, id 0x100000a01, registered, matched, active, busy 0 (1 ms), retain 20>
  | {
  |   "idProduct" = 2071
  |   "USB Product Name" = "USB2.0 Hub"
  |   "idVendor" = 1507
  | }
  |
  +-o TokenBeacon Display@01110000  <class IOUSBHostDevice, id 0x100000a02, registered, matched, active, busy 0 (1 ms), retain 30>
    | {
    |   "idVendor" = 12346
    |   "USB Product Name" = "TokenBeacon Display"
    |   "kUSBSerialNumberString" = "C3A9F01B"
    | }
    +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000a05, registered, matched, active, busy 0 (0 ms), retain 6>
        {
          "IOCalloutDevice" = "/dev/cu.usbmodemC3A9F01B1"
        }
+-o TokenBeacon Display@01110000  <class IOUSBHostDevice, id 0x100000a02, registered, matched, active, busy 0 (1 ms), retain 30>
  | {
  |   "idVendor" = 12346
  |   "USB Product Name" = "TokenBeacon Display"
  |   "kUSBSerialNumberString" = "C3A9F01B"
  | }
  +-o IOSerialBSDClient  <class IOSerialBSDClient, id 0x100000a05, registered, matched, active, busy 0 (0 ms), retain 6>
      {
        "IOCalloutDevice" = "/dev/cu.usbmodemC3A9F01B1"
        "IODialinDevice" = "/dev/tty.usbmodemC3A9F01B1"
      }
+-o USB JTAG/serial debug unit@01120000  <class IOUSBHostDevice, id 0x100000b01, registered, matched, active, busy 0 (1 ms), retain 30>
  | {
  |   "idVendor" = 12346
  |   "USB Product Name" = "USB JTAG/serial debug unit"
  | }
  +-o IOSerialBSDClient  <class IOSerialBSDClient>
      {
        "IOCalloutDevice" = "/dev/cu.usbmodem2101"
      }
+-o Fake Display@01130000  <class IOUSBHostDevice>
  | {
  |   "idVendor" = 4660
  |   "USB Product Name" = "TokenBeacon Display"
  | }
  +-o IOSerialBSDClient  <class IOSerialBSDClient>
      {
        "IOCalloutDevice" = "/dev/cu.usbmodem3101"
      }
+-o TokenBeacon Display@01140000  <class IOUSBHostDevice>
  | {
  |   "idVendor" = 12346
  |   "USB Product Name" = "TokenBeacon Display"
  |   "kUSBSerialNumberString" = "bad serial!"
  | }
  +-o IOSerialBSDClient  <class IOSerialBSDClient>
      {
        "IOCalloutDevice" = "/dev/cu.usbmodem4101"
        "IOCalloutDevice" = "/etc/passwd"
      }
`;

describe("device transports: discovery parsing", () => {
  test("macOS: only TokenBeacon displays with a /dev/cu.* port are candidates", () => {
    assert.deepEqual(parseIoregDisplays(IOREG), [
      { id: "/dev/cu.usbmodemC3A9F01B1", port: "/dev/cu.usbmodemC3A9F01B1", serial: "C3A9F01B" },
      { id: "/dev/cu.usbmodem4101", port: "/dev/cu.usbmodem4101", serial: null },
    ]);
    assert.deepEqual(parseIoregDisplays(""), []);
  });

  test("Windows: only TokenBeacon displays on COM ports are candidates", () => {
    const json = JSON.stringify([
      { port: "COM5", product: "TokenBeacon Display", serial: "C3A9F01B" },
      { port: "COM6", product: "USB JTAG/serial debug unit", serial: "AABBCC" },
      { port: "\\\\.\\COM7", product: "TokenBeacon Display", serial: "C3A9F01B" },
      { port: "COM8", product: "TokenBeacon Display", serial: "6&2a3b&0&0000" },
      { port: "COM9", product: null, serial: null },
    ]);
    assert.deepEqual(parseHelperPorts(json), [
      { id: "COM5", port: "COM5", serial: "C3A9F01B" },
      { id: "COM8", port: "COM8", serial: null },
    ]);
    // PowerShell 5.1 turns a one-element array into an object.
    assert.deepEqual(parseHelperPorts('{"port":"COM3","product":"TokenBeacon Display","serial":"C3A9F01B"}'), [
      { id: "COM3", port: "COM3", serial: "C3A9F01B" },
    ]);
    assert.deepEqual(parseHelperPorts("not json"), []);
  });

  test("Windows helper: fixed script, absolute PowerShell path, no 1200 baud, no RTS", () => {
    assert.equal(powershellPath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.ok(!HELPER_SCRIPT.includes("1200"));
    assert.match(HELPER_SCRIPT, /RtsEnable = \$false/);
    assert.match(HELPER_SCRIPT, /'\^COM\[1-9\]\[0-9\]\{0,2\}\$'/);
    assert.ok(!/Invoke-Expression|iex |Start-Process|Remove-Item|Set-ExecutionPolicy|Invoke-WebRequest|Net\.WebClient/i.test(HELPER_SCRIPT));
    assert.ok(Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64").length < 30_000, "fits on the command line");
  });
});

/** A stand-in for the PowerShell helper process. */
class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  received: string[] = [];
  killed = false;
  constructor(ready: boolean) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        this.received.push(line);
        if (ready && line === "LIST") this.stdout.write("PORTS []\r\n");
      }
    });
    if (ready) setImmediate(() => this.stdout.write("READY\r\n"));
  }
  kill() {
    this.killed = true;
    this.emit("exit", null);
    return true;
  }
}

describe("device transports: Windows helper lifecycle", () => {
  test("a helper that is not ready in time is stopped and replaced on the next attempt", async () => {
    const helpers = [new FakeHelper(false), new FakeHelper(true)];
    let spawned = 0;
    const transport = new WindowsTransport(
      { mode: "auto", serial: null },
      { spawnHelper: () => helpers[spawned++] as unknown as ChildProcessWithoutNullStreams, startupTimeoutMs: 50 },
    );
    try {
      await assert.rejects(transport.discover(), (error: unknown) => error instanceof TransportError && error.code === "unsupported");
      assert.ok(helpers[0].received.includes("EXIT"), "the stuck helper is asked to exit");
      assert.deepEqual(await transport.discover(), []);
      assert.equal(spawned, 2, "a fresh helper is started instead of reusing the failed start");
      assert.deepEqual(await transport.discover(), []);
      assert.equal(spawned, 2, "a working helper is reused");
    } finally {
      transport.dispose();
    }
  });
});

function snapshot(): MonitorSnapshot {
  return {
    limits: {
      fiveHour: { value: { usedPercent: 42, windowMinutes: 300, resetsAt: null, status: "active" }, state: "last-known", observedAt: null, source: null },
      weekly: { value: null, state: "unavailable", observedAt: null, source: null },
    },
    projects: [],
    unassignedThreads: [],
  } as unknown as MonitorSnapshot;
}

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe("device transports: real I/O", () => {
  test(
    "macOS: the bridge talks to a fake display on a pseudo-terminal",
    { skip: (process.platform !== "darwin" && "macOS only") || (!hasPython && "python3 not available") },
    async (t) => {
      const { root, cleanup } = createTempRoot();
      t.after(cleanup);
      const script = path.join(root, "fake_display.py");
      writeFileSync(
        script,
        [
          "import os, pty, json, select",
          "master, slave = pty.openpty()",
          "print(os.ttyname(slave), flush=True)",
          "buf = b''",
          "states = 0",
          "while True:",
          "    r, _, _ = select.select([master], [], [], 15)",
          "    if not r: break",
          "    buf += os.read(master, 4096)",
          "    while b'\\n' in buf:",
          "        line, buf = buf.split(b'\\n', 1)",
          "        msg = json.loads(line)",
          "        if msg['t'] == 'hello':",
          "            os.write(master, (json.dumps({'tb':1,'t':'hello','dev':'tokenbeacon-display','fw':'0.0.0','proto':[1],'nonce':msg['nonce'],'id':'abcd1234'}) + '\\r\\n').encode())",
          "        elif msg['t'] == 'state':",
          "            states += 1",
          "            os.write(master, (json.dumps({'tb':1,'t':'alive','seq':msg['seq'],'up':states}) + '\\r\\n').encode())",
          "            print('state', msg['five']['left'], flush=True)",
        ].join("\n"),
      );
      const fake = spawn("python3", [script], { stdio: ["ignore", "pipe", "ignore"] });
      t.after(() => fake.kill());
      const output: string[] = [];
      const ttyPath = await new Promise<string>((resolve) => {
        fake.stdout.setEncoding("utf8");
        fake.stdout.on("data", (chunk: string) => {
          for (const line of chunk.split("\n").filter(Boolean)) {
            if (output.length === 0) resolve(line.trim());
            output.push(line.trim());
          }
        });
      });
      const transport: DeviceTransport = {
        discover: async () => [{ id: ttyPath, port: ttyPath, serial: null }],
        open: (candidate) => openTty(candidate.port),
        dispose: () => undefined,
      };
      const bridge = new DeviceBridge({ config: { mode: "auto", serial: null }, transport, getSnapshot: snapshot, hostVersion: "0.3.0" });
      await bridge.start();
      t.after(() => bridge.stop());
      for (let attempt = 0; attempt < 40 && !output.some((line) => line === "state 58"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(bridge.getStatus().state, "connected");
      assert.ok(output.includes("state 58"), output.join(" | "));
    },
  );

  test(
    "Windows: the PowerShell helper starts, lists ports and refuses a missing port",
    { skip: process.platform !== "win32" && "Windows only" },
    async () => {
      const transport = new WindowsTransport({ mode: "auto", serial: null });
      try {
        const candidates = await transport.discover();
        assert.ok(Array.isArray(candidates));
        await assert.rejects(
          transport.open({ id: "COM199", port: "COM199", serial: null }),
          (error: unknown) => error instanceof TransportError && ["not_found", "open_failed"].includes(error.code),
        );
        // The helper is still usable after a failed open.
        assert.ok(Array.isArray(await transport.discover()));
      } finally {
        transport.dispose();
      }
    },
  );
});
