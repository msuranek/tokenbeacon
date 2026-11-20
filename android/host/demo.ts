/**
 * Development tool: sends made-up display data to the TokenBeacon Display
 * Android app over Bluetooth with the real DeviceBridge, Bluetooth transport,
 * helper and pairing. Reads no Codex data at all.
 *
 *   node --no-warnings android/host/demo.ts [seconds]
 *
 * Prints only bridge states and codes.
 */
import { DeviceBridge, type DeviceStatus } from "../../src/device/bridge.ts";
import type { MonitorSnapshot } from "../../src/types.ts";
import { MacBleTransport } from "../../src/device/transport-ble-macos.ts";

const seconds = Number(process.argv[2] ?? 120);
const started = Date.now();

/** Made-up values that change slowly, so updates are visible on the phone. */
function demoSnapshot(): MonitorSnapshot {
  const now = Date.now();
  const minutes = Math.floor((now - started) / 60_000);
  const tick = Math.floor((now - started) / 15_000);
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    limits: {
      fiveHour: {
        value: { usedPercent: Math.min(100, 30 + tick), windowMinutes: 300, resetsAt: iso(started + (132 - minutes) * 60_000), status: "active" },
        state: "current",
        observedAt: iso(now - 5_000),
      },
      weekly: {
        value: { usedPercent: 52, windowMinutes: 10_080, resetsAt: iso(started + 80 * 3_600_000), status: "active" },
        state: "last-known",
        observedAt: iso(now - 300_000),
      },
    },
    projects: [],
    unassignedThreads: [
      {
        contextUsedPercent: { value: Math.min(100, 40 + 2 * tick), state: "current", observedAt: iso(now - 3_000), source: null },
        lastActivityAt: { value: iso(now - 3_000), state: "current", observedAt: null, source: null },
      },
    ],
  } as unknown as MonitorSnapshot;
}

const log = (line: string) => console.log(`[bridge] ${line}`);
const bridge = new DeviceBridge({
  config: { mode: "ble", deviceId: process.env.TOKENBEACON_DEVICE_ID ?? null },
  transport: new MacBleTransport({ deviceId: process.env.TOKENBEACON_DEVICE_ID ?? null, log }),
  getSnapshot: demoSnapshot,
  hostVersion: "0.3.0-ble-demo",
  log,
  label: "Bluetooth display",
});

let last = "";
const print = (status: DeviceStatus) => {
  const text = `${status.state}${status.detail ? ` (${status.detail})` : ""}`;
  if (text !== last) console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
  last = text;
};
const watch = setInterval(() => print(bridge.getStatus()), 250);
void bridge.start();
setTimeout(() => {
  clearInterval(watch);
  bridge.stop();
  console.log("demo finished");
  setTimeout(() => process.exit(0), 1_200);
}, seconds * 1_000);
