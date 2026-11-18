import { homedir } from "node:os";

/**
 * Display-text hygiene for values that leave the process through the HTTP API.
 *
 * Project names and thread titles come from local Codex databases and may
 * contain arbitrary user input (a thread title can be the first prompt). They
 * are rendered as text by React, so this is not HTML escaping. It removes
 * characters that can spoof or corrupt the UI, redacts the user's home
 * directory, and bounds the size of each value.
 *
 * Home redaction replaces only the home folder itself with "~" and keeps the
 * rest of the text exactly as written, including its separators: on macOS
 * "/Users/jane/repo/a.ts" becomes "~/repo/a.ts", on Windows
 * "C:\Users\Jane\repo/a.ts" becomes "~\repo/a.ts".
 */

export const MAX_TITLE_LENGTH = 300;
export const MAX_PROJECT_NAME_LENGTH = 120;

// C0/C1 controls, bidirectional embedding/override/isolate controls (Trojan
// Source style spoofing), and invisible separators. ZWJ (U+200D) is kept
// because emoji sequences depend on it.
// Built from an escaped string: Node's TypeScript stripper decodes \u escapes in
// regex literals, and literal U+2028/U+2029 would terminate the line.
const UNSAFE_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff]",
  "g",
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeDisplayText(
  value: unknown,
  maxLength: number,
  fallback: string,
  home: string = homedir(),
): string {
  if (typeof value !== "string") return fallback;
  let text = value.replace(UNSAFE_CHARACTERS, " ");
  text = redactHome(text, home);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  const codePoints = Array.from(text);
  if (codePoints.length > maxLength) {
    text = `${codePoints.slice(0, Math.max(1, maxLength - 1)).join("").trimEnd()}…`;
  }
  return text;
}

export function redactHome(text: string, home: string = homedir()): string {
  if (!home || home === "/" || home.length < 2) return text;
  const windowsHome = windowsHomePattern(home);
  if (windowsHome) return text.replace(windowsHome, "~");
  const normalizedHome = home.replace(/[\\/]+$/, "");
  if (!normalizedHome) return text;
  return text.split(normalizedHome).join("~");
}

/**
 * For a Windows home such as `C:\Users\Jane Doe`, matches every common way the
 * same folder is written in text, ignoring letter case:
 * `C:\Users\Jane Doe`, `c:/users/jane doe`, JSON-escaped `C:\\Users\\Jane Doe`,
 * `\\?\C:\Users\Jane Doe`, Git Bash `/c/Users/Jane Doe` and WSL
 * `/mnt/c/Users/Jane Doe`. Returns null for anything that is not a drive path.
 */
function windowsHomePattern(home: string): RegExp | null {
  const match = /^([A-Za-z]):[\\/]+(.+?)[\\/]*$/.exec(home);
  if (!match) return null;
  const drive = match[1];
  const segments = match[2].split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return null;
  const separator = "(?:\\\\{1,2}|/)"; // \, \\ (escaped) or /
  const body = segments.map(escapeRegExp).join(separator);
  const native = `(?:\\\\{1,2}\\?\\\\{1,2})?${escapeRegExp(drive)}:${separator}${body}`;
  const posixStyle = `(?:/mnt)?/${escapeRegExp(drive)}/${segments.map(escapeRegExp).join("/")}`;
  return new RegExp(`(?:${native}|${posixStyle})`, "gi");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Only verified local thread IDs (UUIDs) may produce a deep link. */
export function threadDeepLink(threadId: string): string | null {
  return isUuid(threadId) ? `codex://threads/${threadId}` : null;
}
