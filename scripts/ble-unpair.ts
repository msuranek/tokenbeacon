/**
 * Forgets the paired Bluetooth display (TokenBeacon Display phone), so the
 * next phone that pairs over Bluetooth is trusted instead.
 *
 *   npm run ble:unpair
 *
 * Removes only TokenBeacon's own pairing record (the phone's public key).
 * To remove the Bluetooth bond itself, use System Settings → Bluetooth on the
 * Mac and Bluetooth settings on the phone.
 */
import { PairingStore } from "../src/device/ble-trust.ts";

const store = new PairingStore();
console.log(store.forget() ? "Bluetooth display pairing removed." : "No Bluetooth display was paired.");
