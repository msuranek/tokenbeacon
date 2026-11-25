import type { PathPlatform } from "../paths.ts";

/**
 * USB display settings. The display is optional and off unless
 * TOKENBEACON_DEVICE is set:
 *   (unset), off      – no device code runs
 *   auto              – use a connected TokenBeacon display
 *   COM5 / /dev/cu.…  – use exactly this port (still verified by handshake)
 * TOKENBEACON_DEVICE_SERIAL optionally limits "auto" to one display.
 */
export type DeviceConfig =
  | { mode: "off" }
  | { mode: "auto"; serial: string | null }
  | { mode: "port"; port: string };

export interface DeviceConfigResult {
  config: DeviceConfig;
  /** A stable problem code when the setting was ignored; the dashboard still starts. */
  problem: "invalid_device_setting" | "invalid_device_serial" | "unsupported_platform" | null;
}

const OFF = /^(|off|0|false|no)$/i;
const WINDOWS_PORT = /^COM[1-9][0-9]{0,2}$/i;
const MAC_PORT = /^\/dev\/cu\.[A-Za-z0-9._-]{1,64}$/;
const SERIAL = /^[0-9A-Za-z]{4,64}$/;

export function readDeviceConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DeviceConfigResult {
  const raw = (env.TOKENBEACON_DEVICE ?? "").trim();
  if (OFF.test(raw)) return { config: { mode: "off" }, problem: null };
  if (platform !== "darwin" && platform !== "win32") return { config: { mode: "off" }, problem: "unsupported_platform" };
  if (raw.toLowerCase() === "auto") {
    const serial = (env.TOKENBEACON_DEVICE_SERIAL ?? "").trim();
    if (serial && !SERIAL.test(serial)) return { config: { mode: "off" }, problem: "invalid_device_serial" };
    return { config: { mode: "auto", serial: serial || null }, problem: null };
  }
  const pattern = platform === "win32" ? WINDOWS_PORT : MAC_PORT;
  if (!pattern.test(raw)) return { config: { mode: "off" }, problem: "invalid_device_setting" };
  return { config: { mode: "port", port: platform === "win32" ? raw.toUpperCase() : raw }, problem: null };
}

/**
 * TOKENBEACON_DEVICE_TITLE=on sends the name of the thread whose context is
 * shown to displays that support it (P-037). Off by default.
 */
export function readDeviceTitleSetting(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; problem: "invalid_device_title" | null } {
  const raw = (env.TOKENBEACON_DEVICE_TITLE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "0" || raw === "false" || raw === "no") return { enabled: false, problem: null };
  if (raw === "on" || raw === "1" || raw === "true" || raw === "yes") return { enabled: true, problem: null };
  return { enabled: false, problem: "invalid_device_title" };
}

export function devicePlatform(platform: NodeJS.Platform = process.platform): PathPlatform {
  return platform === "win32" ? "win32" : "posix";
}
