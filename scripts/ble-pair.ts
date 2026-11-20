/**
 * Pairs a TokenBeacon Display phone as the Bluetooth display (macOS).
 *
 *   npm run ble:pair
 *
 * Finds phones running the TokenBeacon Display app, lets each prove its key,
 * and pairs only the phone whose display ID you type from its screen.
 * Optional: TOKENBEACON_DEVICE_ID limits the search to one phone.
 */
import { createInterface } from "node:readline/promises";
import { pairBluetoothDisplay } from "../src/device/ble-pair.ts";
import { PairingStore } from "../src/device/ble-trust.ts";
import { readDeviceConfig } from "../src/device/config.ts";
import { MacBleTransport } from "../src/device/transport-ble-macos.ts";

if (process.platform !== "darwin") {
  console.error("The Bluetooth display is supported on macOS only.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("Run `npm run ble:pair` in a terminal: you need to type the display ID shown on the phone.");
  process.exit(1);
}
const { config, problem } = readDeviceConfig({ ...process.env, TOKENBEACON_DEVICE: "ble" }, "darwin");
if (problem || config.mode !== "ble") {
  console.error("TOKENBEACON_DEVICE_ID must be the 16-digit display ID shown in the phone app.");
  process.exit(1);
}
const readline = createInterface({ input: process.stdin, output: process.stdout });
const result = await pairBluetoothDisplay({
  transport: new MacBleTransport({ deviceId: config.deviceId, log: (line) => console.log(line) }),
  store: new PairingStore(),
  deviceId: config.deviceId,
  ask: (question) => readline.question(question),
  print: (line) => console.log(line),
});
readline.close();
process.exit(result === "paired" || result === "already_paired" ? 0 : 1);
