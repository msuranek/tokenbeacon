import { readFileSync } from "node:fs";
import type { MonitorSnapshot } from "../types.ts";
import { DeviceBridge } from "./bridge.ts";
import { readDeviceConfig, readDeviceTitleSetting } from "./config.ts";
import { MacTransport } from "./transport-macos.ts";
import { WindowsTransport } from "./transport-windows.ts";

export type { DeviceStatus } from "./bridge.ts";

/**
 * Starts the optional USB display bridge, or returns null when it is off
 * (the default). Problems with the setting are reported once and never stop
 * the dashboard.
 */
export function startDeviceBridge(options: {
  getSnapshot: () => MonitorSnapshot | null;
  log: (line: string) => void;
  warn: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): DeviceBridge | null {
  const platform = options.platform ?? process.platform;
  const { config, problem } = readDeviceConfig(options.env ?? process.env, platform);
  if (problem) options.warn(PROBLEM_MESSAGES[problem]);
  if (config.mode === "off") return null;
  const titleSetting = readDeviceTitleSetting(options.env ?? process.env);
  if (titleSetting.problem) options.warn(PROBLEM_MESSAGES[titleSetting.problem]);
  const transport = platform === "win32" ? new WindowsTransport(config) : new MacTransport(config);
  const bridge = new DeviceBridge({
    config,
    transport,
    getSnapshot: options.getSnapshot,
    hostVersion: packageVersion(),
    log: options.log,
    sendTitle: titleSetting.enabled,
  });
  // Never logs the title itself.
  if (titleSetting.enabled) options.log("USB display: thread names are sent to displays that support them.");
  options.log(
    config.mode === "auto"
      ? "USB display: looking for a TokenBeacon display."
      : "USB display: using the configured port.",
  );
  void bridge.start();
  return bridge;
}

const PROBLEM_MESSAGES = {
  invalid_device_setting:
    'TOKENBEACON_DEVICE must be "auto", "off" or a port such as COM5 or /dev/cu.usbmodem1101. The USB display stays off.',
  invalid_device_serial: "TOKENBEACON_DEVICE_SERIAL must be 4–64 letters or digits. The USB display stays off.",
  invalid_device_title: 'TOKENBEACON_DEVICE_TITLE must be "on" or "off". Thread names are not sent to the display.',
  unsupported_platform: "The USB display is supported on macOS and Windows only. It stays off.",
} as const;

function packageVersion(): string {
  try {
    const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
