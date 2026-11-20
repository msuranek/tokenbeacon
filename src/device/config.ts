import type { PathPlatform } from "../paths.ts";

/**
 * USB display settings. The display is optional and off unless
 * TOKENBEACON_DEVICE is set:
 *   (unset), off      – no device code runs
 *   auto              – use a connected TokenBeacon display
 *   COM5 / /dev/cu.…  – use exactly this port (still verified by handshake)
 *   ble               – the TokenBeacon Display Android app over Bluetooth (macOS)
 * TOKENBEACON_DEVICE_SERIAL optionally limits "auto" to one display.
 * TOKENBEACON_DEVICE_ID optionally selects one phone for "ble" (selection
 * only; the phone is authenticated by its paired key, see ble-trust.ts).
 */
export type DeviceConfig =
  | { mode: "off" }
  | { mode: "auto"; serial: string | null }
  | { mode: "port"; port: string }
  | { mode: "ble"; deviceId: string | null };

export interface DeviceConfigResult {
  config: DeviceConfig;
  /** A stable problem code when the setting was ignored; the dashboard still starts. */
  problem: "invalid_device_setting" | "invalid_device_serial" | "invalid_device_id" | "unsupported_platform" | null;
}

const OFF = /^(|off|0|false|no)$/i;
const WINDOWS_PORT = /^COM[1-9][0-9]{0,2}$/i;
const MAC_PORT = /^\/dev\/cu\.[A-Za-z0-9._-]{1,64}$/;
const SERIAL = /^[0-9A-Za-z]{4,64}$/;
/** Display ID shown by the phone app: 16 hex digits (spaces allowed for readability). */
const DEVICE_ID = /^[0-9a-f]{16}$/;

export function readDeviceConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DeviceConfigResult {
  const raw = (env.TOKENBEACON_DEVICE ?? "").trim();
  if (OFF.test(raw)) return { config: { mode: "off" }, problem: null };
  if (platform !== "darwin" && platform !== "win32") return { config: { mode: "off" }, problem: "unsupported_platform" };
  if (raw.toLowerCase() === "ble") {
    if (platform !== "darwin") return { config: { mode: "off" }, problem: "unsupported_platform" };
    const id = (env.TOKENBEACON_DEVICE_ID ?? "").replace(/\s+/g, "").toLowerCase();
    if (id && !DEVICE_ID.test(id)) return { config: { mode: "off" }, problem: "invalid_device_id" };
    return { config: { mode: "ble", deviceId: id || null }, problem: null };
  }
  if (raw.toLowerCase() === "auto") {
    const serial = (env.TOKENBEACON_DEVICE_SERIAL ?? "").trim();
    if (serial && !SERIAL.test(serial)) return { config: { mode: "off" }, problem: "invalid_device_serial" };
    return { config: { mode: "auto", serial: serial || null }, problem: null };
  }
  const pattern = platform === "win32" ? WINDOWS_PORT : MAC_PORT;
  if (!pattern.test(raw)) return { config: { mode: "off" }, problem: "invalid_device_setting" };
  return { config: { mode: "port", port: platform === "win32" ? raw.toUpperCase() : raw }, problem: null };
}

export function devicePlatform(platform: NodeJS.Platform = process.platform): PathPlatform {
  return platform === "win32" ? "win32" : "posix";
}
