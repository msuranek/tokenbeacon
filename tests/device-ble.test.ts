import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { DeviceBridge } from "../src/device/bridge.ts";
import { ensureBleHelper, helperSourceHash, HelperBuildError, HELPER_EXECUTABLE, type RunTool } from "../src/device/ble-helper-build.ts";
import { AUTH_CONTEXT, decideTrust, displayId, PairingStore, PairingUnreadableError, verifyAuthResponse } from "../src/device/ble-trust.ts";
import { readDeviceConfig } from "../src/device/config.ts";
import { parseHostLine } from "../src/device/protocol.ts";
import { acceptHelper, MacBleTransport } from "../src/device/transport-ble-macos.ts";
import { TransportError } from "../src/device/transport.ts";
import type { MonitorSnapshot } from "../src/types.ts";

// Everything here is synthetic: generated keys, a fake helper instead of
// Bluetooth, temporary folders instead of ~/Library.

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tb-ble-test-"));
  roots.push(dir);
  return dir;
}
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function phoneKey(curve = "P-256"): { privateKey: KeyObject; spki: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  return { privateKey, spki: publicKey.export({ format: "der", type: "spki" }) as Buffer };
}

function answer(key: { privateKey: KeyObject; spki: Buffer }, challenge: Buffer, context = AUTH_CONTEXT): Buffer {
  const signature = sign("sha256", Buffer.concat([context, challenge]), { key: key.privateKey, dsaEncoding: "der" });
  const length = Buffer.alloc(2);
  length.writeUInt16BE(key.spki.length);
  return Buffer.concat([length, key.spki, signature]);
}

describe("bluetooth display: settings", () => {
  test("ble is macOS only; the display ID is normalized and validated", () => {
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "ble" }, "darwin"), { config: { mode: "ble", deviceId: null }, problem: null });
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "BLE", TOKENBEACON_DEVICE_ID: "1A2B 3c4d 5E6F 7a8b" }, "darwin"), {
      config: { mode: "ble", deviceId: "1a2b3c4d5e6f7a8b" },
      problem: null,
    });
    assert.equal(readDeviceConfig({ TOKENBEACON_DEVICE: "ble" }, "win32").problem, "unsupported_platform");
    assert.equal(readDeviceConfig({ TOKENBEACON_DEVICE: "ble" }, "linux").problem, "unsupported_platform");
    for (const id of ["1a2b", "zz2b3c4d5e6f7a8b", "1a2b3c4d5e6f7a8b9", "../../etc"]) {
      assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "ble", TOKENBEACON_DEVICE_ID: id }, "darwin"), {
        config: { mode: "off" },
        problem: "invalid_device_id",
      });
    }
    // USB settings are unchanged.
    assert.deepEqual(readDeviceConfig({ TOKENBEACON_DEVICE: "auto" }, "darwin").config, { mode: "auto", serial: null });
    assert.equal(readDeviceConfig({}, "darwin").config.mode, "off");
  });
});

describe("bluetooth display: identity", () => {
  const challenge = Buffer.alloc(32, 7);

  test("accepts only a P-256 signature over the context and this challenge", () => {
    const key = phoneKey();
    const presented = verifyAuthResponse(challenge, answer(key, challenge));
    assert.ok(presented);
    assert.equal(presented.id, displayId(key.spki));
    assert.match(presented.id, /^[0-9a-f]{16}$/);

    assert.equal(verifyAuthResponse(Buffer.alloc(32, 8), answer(key, challenge)), null, "another challenge (replay)");
    assert.equal(verifyAuthResponse(challenge, answer(key, challenge, Buffer.from("other\n"))), null, "another context");
    assert.equal(verifyAuthResponse(challenge, answer(phoneKey("P-384"), challenge)), null, "other curve");
    const forged = answer(key, challenge);
    forged[forged.length - 2] ^= 0x01;
    assert.equal(verifyAuthResponse(challenge, forged), null, "altered signature");
    const swapped = Buffer.concat([answer(phoneKey(), challenge).subarray(0, 2 + key.spki.length), answer(key, challenge).subarray(2 + key.spki.length)]);
    assert.equal(verifyAuthResponse(challenge, swapped), null, "someone else's key with this signature");
    for (const bad of [Buffer.alloc(0), Buffer.from([0, 0]), Buffer.from([0xff, 0xff, 1, 2, 3]), Buffer.concat([answer(key, challenge), Buffer.alloc(100)])]) {
      assert.equal(verifyAuthResponse(challenge, bad), null);
    }
    assert.equal(verifyAuthResponse(Buffer.alloc(16), answer(key, challenge)), null, "short challenge");
  });

  test("trust: the paired key only; the display ID only selects", () => {
    const paired = { ...presentedOf(phoneKey()), pairedAt: "2026-11-20T00:00:00.000Z" };
    const other = presentedOf(phoneKey());
    assert.equal(decideTrust(null, other, null), "pair");
    assert.equal(decideTrust(paired, paired, null), "trusted");
    assert.equal(decideTrust(paired, other, null), "untrusted");
    // Naming the other phone's ID does not make it trusted.
    assert.equal(decideTrust(paired, other, other.id), "untrusted");
    assert.equal(decideTrust(paired, paired, other.id), "not_selected");
    assert.equal(decideTrust(null, other, paired.id), "not_selected");
  });

  test("pairing store: private file, atomic save, fails closed when damaged", () => {
    const dir = path.join(tempDir(), "Application Support", "TokenBeacon");
    const store = new PairingStore(dir);
    assert.equal(store.load(), null);
    const presented = presentedOf(phoneKey());
    store.save(presented, new Date("2026-11-20T12:00:00Z"));
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const loaded = store.load();
    assert.ok(loaded && loaded.publicKey.equals(presented.publicKey) && loaded.id === presented.id);
    assert.doesNotMatch(readFileSync(store.file, "utf8"), /PRIVATE/);

    const record = JSON.parse(readFileSync(store.file, "utf8"));
    writeFileSync(store.file, JSON.stringify({ ...record, id: "0000000000000000" }));
    assert.throws(() => store.load(), PairingUnreadableError, "an ID that does not match the key");
    writeFileSync(store.file, "{not json");
    assert.throws(() => store.load(), PairingUnreadableError);
    assert.equal(store.forget(), true);
    assert.equal(store.forget(), false);
    assert.equal(store.load(), null);
  });
});

function presentedOf(key: { spki: Buffer }) {
  return { id: displayId(key.spki), publicKey: key.spki };
}

describe("bluetooth display: helper build", () => {
  function sources(): string {
    const dir = tempDir();
    writeFileSync(path.join(dir, "TokenBeaconBLE.swift"), "print(1)\n");
    writeFileSync(path.join(dir, "Info.plist"), "<plist/>\n");
    return dir;
  }

  /** Records tool calls and creates the binary when swiftc is asked to. */
  function fakeTools(options: { swift?: boolean; fail?: boolean } = {}): { run: RunTool; calls: string[][] } {
    const calls: string[][] = [];
    const run: RunTool = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "--find" && options.swift === false) throw new Error("no swiftc");
      if (args[0] === "swiftc") {
        if (options.fail) throw new Error("compile error");
        const out = args[args.indexOf("-o") + 1];
        writeFileSync(out, "#!/bin/sh\n");
        chmodSync(out, 0o755);
      }
    };
    return { run, calls };
  }

  test("builds once, reuses the build, rebuilds only when the sources change", async () => {
    const sourceDir = sources();
    const cacheDir = path.join(tempDir(), "cache");
    const first = fakeTools();
    const app = await ensureBleHelper({ sourceDir, cacheDir, arch: "arm64", run: first.run });
    assert.ok(existsSync(path.join(app, "Contents", "MacOS", HELPER_EXECUTABLE)));
    assert.ok(existsSync(path.join(app, "Contents", "Info.plist")));
    const swiftc = first.calls.find((call) => call[1] === "swiftc")!;
    assert.equal(swiftc[0], "/usr/bin/xcrun");
    assert.ok(swiftc.includes("arm64-apple-macos13.0"), "explicit minimum macOS, or LaunchServices refuses the app");
    assert.ok(first.calls.some((call) => call[0] === "/usr/bin/codesign"));

    const second = fakeTools();
    assert.equal(await ensureBleHelper({ sourceDir, cacheDir, arch: "arm64", run: second.run }), app);
    assert.equal(second.calls.length, 0, "no rebuild without changes");

    writeFileSync(path.join(sourceDir, "TokenBeaconBLE.swift"), "print(2)\n");
    const third = fakeTools();
    const rebuilt = await ensureBleHelper({ sourceDir, cacheDir, arch: "arm64", run: third.run });
    assert.notEqual(rebuilt, app);
    assert.ok(third.calls.length > 0);
    assert.deepEqual(readdirSync(cacheDir), [path.basename(path.dirname(rebuilt))], "the old build is removed");
    assert.equal(path.basename(path.dirname(rebuilt)), helperSourceHash(sourceDir, "arm64").slice(0, 16));
  });

  test("missing compiler or a failed build leaves no partial helper", async () => {
    const sourceDir = sources();
    const cacheDir = path.join(tempDir(), "cache");
    await assert.rejects(ensureBleHelper({ sourceDir, cacheDir, run: fakeTools({ swift: false }).run }), (error: unknown) => error instanceof HelperBuildError && error.code === "swift_unavailable");
    await assert.rejects(ensureBleHelper({ sourceDir, cacheDir, run: fakeTools({ fail: true }).run }), (error: unknown) => error instanceof HelperBuildError && error.code === "build_failed");
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});

describe("bluetooth display: helper link", () => {
  test("only a client with the one-time token is accepted, then nothing else can connect", async () => {
    const socketPath = path.join(tempDir(), "s");
    const token = "0123456789abcdef0123456789abcdef";
    const accepted = acceptHelper(socketPath, token, 5_000, () => {
      const wrong = net.connect(socketPath, () => wrong.write("HELLO ffffffffffffffffffffffffffffffff\n"));
      wrong.on("error", () => undefined);
      setTimeout(() => {
        const right = net.connect(socketPath, () => right.write(`HELLO ${token}\nREADY\n`));
        right.on("error", () => undefined);
      }, 100);
    });
    const socket = await accepted;
    const first = new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(chunk.toString())));
    socket.resume();
    assert.equal(await first, "READY\n", "data after the hello is kept");
    await new Promise<void>((resolve) => {
      const late = net.connect(socketPath);
      late.on("error", () => resolve());
      late.on("connect", () => assert.fail("the socket must be closed after the helper connected"));
    });
    socket.destroy();
  });

  test("a helper that never connects times out", async () => {
    await assert.rejects(acceptHelper(path.join(tempDir(), "s"), "0123456789abcdef0123456789abcdef", 200, () => undefined), /helper_timeout/);
  });
});

// --- Transport + DeviceBridge against a fake helper ------------------------------

const PHONE = "0a1b2c3d-0000-4000-8000-00000000abcd";
const FAKE_HELPER = String.raw`
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
const [socketPath, token, keyFile, logFile, mode] = process.argv.slice(2);
const key = createPrivateKey(readFileSync(keyFile));
const spki = createPublicKey(key).export({ format: "der", type: "spki" });
const socket = net.connect(socketPath, () => {
  const say = (line) => socket.write(line + "\n");
  say("HELLO " + token);
  say(mode === "unauthorized" ? "ERR bluetooth_unauthorized" : "READY");
  let states = 0;
  createInterface({ input: socket }).on("line", (command) => {
    const [verb, arg = ""] = command.split(" ");
    appendFileSync(logFile, verb + "\n");
    if (verb === "SCAN") return say('DEVICES ["${PHONE}","not-a-uuid"]');
    if (verb === "OPEN") return say(arg === "${PHONE}" ? "OPENED" : "ERR not_found");
    if (verb === "CLOSE") return say("CLOSED");
    if (verb === "EXIT") return socket.end();
    if (verb === "AUTH") {
      if (mode === "nosign") return say("ERR auth_failed");
      const signature = sign("sha256", Buffer.concat([Buffer.from("tokenbeacon-ble-auth/v1\n"), Buffer.from(arg, "base64")]), { key, dsaEncoding: "der" });
      const length = Buffer.alloc(2); length.writeUInt16BE(spki.length);
      return say("AUTHED " + Buffer.concat([length, spki, signature]).toString("base64"));
    }
    if (verb === "SEND") {
      const line = Buffer.from(arg, "base64").toString("utf8");
      appendFileSync(logFile, "LINE " + line);
      say("SENT");
      const message = JSON.parse(line);
      if (message.t === "hello") {
        const reply = Buffer.from(JSON.stringify({ tb: 1, t: "hello", dev: "tokenbeacon-display", fw: "android-0.1.0", proto: [1], nonce: message.nonce, id: "c3a9f01b" }) + "\n");
        for (let i = 0; i < reply.length; i += 20) say("DATA " + reply.subarray(i, i + 20).toString("base64"));
      }
      if (message.t === "state") {
        states += 1;
        say("DATA " + Buffer.from(JSON.stringify({ tb: 1, t: "alive", seq: message.seq, up: states }) + "\n").toString("base64"));
        if (mode === "drop" && states === 1) say("LOST");
      }
    }
  });
});
socket.on("error", () => process.exit(0));
`;

function harness(options: { mode?: string; key?: { privateKey: KeyObject; spki: Buffer }; deviceId?: string | null; pairing?: PairingStore } = {}) {
  const dir = tempDir();
  const script = path.join(dir, "fake-helper.mjs");
  writeFileSync(script, FAKE_HELPER);
  const key = options.key ?? phoneKey();
  const keyFile = path.join(dir, "phone-key.pem");
  writeFileSync(keyFile, key.privateKey.export({ format: "pem", type: "pkcs8" }));
  const logFile = path.join(dir, "helper.log");
  writeFileSync(logFile, "");
  const pairing = options.pairing ?? new PairingStore(path.join(dir, "pairing"));
  const logs: string[] = [];
  let launches = 0;
  const transport = new MacBleTransport({
    deviceId: options.deviceId ?? null,
    pairing,
    prepareHelper: async () => "/fake/TokenBeaconBLE.app",
    launchHelper: (_app, socketPath, token) => {
      launches += 1;
      const child = spawn(process.execPath, [script, socketPath, token, keyFile, logFile, options.mode ?? ""], { stdio: "ignore" });
      children.push(child);
    },
    log: (line) => logs.push(line),
  });
  return { transport, pairing, key, logs, launches: () => launches, commands: () => readFileSync(logFile, "utf8") };
}

function snapshot(): MonitorSnapshot {
  const now = Date.now();
  return {
    limits: {
      fiveHour: { value: { usedPercent: 42, windowMinutes: 300, resetsAt: new Date(now + 7_920_000).toISOString(), status: "active" }, state: "current", observedAt: new Date(now).toISOString() },
      weekly: { value: null, state: "unavailable", observedAt: null },
    },
    projects: [],
    unassignedThreads: [],
  } as unknown as MonitorSnapshot;
}

function bridgeFor(transport: MacBleTransport, deviceId: string | null = null, logs: string[] = []) {
  return new DeviceBridge({
    config: { mode: "ble", deviceId },
    transport,
    getSnapshot: snapshot,
    hostVersion: "0.3.0",
    label: "Bluetooth display",
    log: (line) => logs.push(line),
  });
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("bluetooth display: transport and bridge", () => {
  test("first connection pairs the phone, sends only device-state/v1 after it proved its key", async () => {
    const h = harness();
    try {
      assert.deepEqual(await h.transport.discover(), [{ id: PHONE, port: PHONE, serial: null }], "invalid ids are dropped");
      const bridge = bridgeFor(h.transport);
      await bridge.start();
      await until(() => bridge.getStatus().state === "connected");
      await until(() => h.commands().includes('"t":"state"'));
      bridge.stop();
      const paired = h.pairing.load();
      assert.ok(paired && paired.publicKey.equals(h.key.spki), "the phone's public key is remembered");
      assert.ok(h.logs.some((line) => line === `Bluetooth display paired: ID ${displayId(h.key.spki)}.`));
      const commands = h.commands();
      assert.ok(commands.indexOf("AUTH") < commands.indexOf("LINE "), "identity is checked before any data");
      const sent = commands.split("\n").filter((line) => line.startsWith("LINE ")).map((line) => line.slice(5));
      for (const line of sent) assert.equal(parseHostLine(`${line}\n`).ok, true);
      assert.doesNotMatch(commands, /project|thread|path|cwd|"name"/i);
      assert.equal(h.launches(), 1, "one helper for the whole run");
    } finally {
      h.transport.dispose();
    }
  });

  test("automatic reconnect proves the paired key again", async () => {
    const h = harness({ mode: "drop" });
    const logs: string[] = [];
    const bridge = bridgeFor(h.transport, null, logs);
    try {
      await bridge.start();
      await until(() => logs.includes("Bluetooth display reconnected."), 15_000);
      assert.ok(logs.includes("Bluetooth display disconnected; waiting for it to come back."));
      assert.equal(h.commands().match(/^AUTH$/gm)?.length, 2, "a new challenge after reconnecting");
    } finally {
      bridge.stop();
    }
  });

  test("a different phone is never trusted once one is paired, even with its ID selected", async () => {
    const pairing = new PairingStore(path.join(tempDir(), "pairing"));
    pairing.save(presentedOf(phoneKey()));
    const intruder = phoneKey();
    for (const deviceId of [null, displayId(intruder.spki)]) {
      const h = harness({ key: intruder, pairing, deviceId });
      const bridge = bridgeFor(h.transport, deviceId);
      try {
        await bridge.start();
        await until(() => bridge.getStatus().state === "unrecognized");
        assert.deepEqual(bridge.getStatus(), { state: "unrecognized", detail: "untrusted" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.doesNotMatch(h.commands(), /LINE /, "no display data to an untrusted phone");
        assert.ok(h.logs.some((line) => line.includes("not the paired display")));
      } finally {
        bridge.stop();
      }
    }
  });

  test("a phone that cannot sign, or is not the selected one, is skipped", async () => {
    const unsigned = harness({ mode: "nosign" });
    let bridge = bridgeFor(unsigned.transport);
    try {
      await bridge.start();
      await until(() => bridge.getStatus().state === "unrecognized");
      assert.equal(bridge.getStatus().detail, "untrusted");
      assert.equal(unsigned.pairing.load(), null, "nothing is paired");
    } finally {
      bridge.stop();
    }
    const other = harness({ deviceId: "0000000000000000" });
    bridge = bridgeFor(other.transport, "0000000000000000");
    try {
      await bridge.start();
      await until(() => bridge.getStatus().state === "unrecognized");
      assert.equal(bridge.getStatus().detail, "not_selected");
      assert.equal(other.pairing.load(), null, "selection never pairs another phone");
    } finally {
      bridge.stop();
    }
  });

  test("Bluetooth problems and a missing helper become status codes, never exceptions", async () => {
    const denied = harness({ mode: "unauthorized" });
    await assert.rejects(denied.transport.discover(), (error: unknown) => error instanceof TransportError && error.code === "bluetooth_unauthorized");
    let bridge = bridgeFor(denied.transport);
    await bridge.start();
    assert.deepEqual(bridge.getStatus(), { state: "searching", detail: "bluetooth_unauthorized" });
    bridge.stop();

    const logs: string[] = [];
    let builds = 0;
    const missing = new MacBleTransport({
      deviceId: null,
      pairing: new PairingStore(path.join(tempDir(), "pairing")),
      prepareHelper: async () => {
        builds += 1;
        throw new HelperBuildError("swift_unavailable");
      },
      launchHelper: () => assert.fail("no helper to launch"),
      log: (line) => logs.push(line),
    });
    bridge = bridgeFor(missing);
    await bridge.start();
    assert.deepEqual(bridge.getStatus(), { state: "searching", detail: "helper_unavailable" });
    await assert.rejects(missing.discover(), (error: unknown) => error instanceof TransportError && error.code === "helper_unavailable");
    assert.equal(builds, 1, "no build attempt on every discovery");
    assert.ok(logs.some((line) => line.includes("xcode-select --install")));
    bridge.stop();
  });
});
