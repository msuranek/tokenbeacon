import { currentPlatform, type PathPlatform } from "./paths.ts";

/**
 * How to start TokenBeacon with one environment variable set, written for the
 * user's shell: POSIX shells on macOS, PowerShell and cmd on Windows. Returns
 * one line per shell, ready to print in a terminal hint.
 */
export function startCommandLines(
  name: "CODEX_HOME" | "TOKENBEACON_PORT",
  value: string,
  platform: PathPlatform = currentPlatform(),
): string[] {
  if (platform === "win32") {
    return [
      `PowerShell: $env:${name} = "${value}"; npm start`,
      `cmd:        set "${name}=${value}" && npm start`,
    ];
  }
  return [`${name}=${value} npm start`];
}

/** An example Codex data folder for hints (never the user's real path). */
export function exampleCodexHome(platform: PathPlatform = currentPlatform()): string {
  return platform === "win32" ? "D:\\path\\to\\.codex" : "/path/to/.codex";
}
