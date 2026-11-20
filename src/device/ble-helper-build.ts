import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the macOS Bluetooth helper (an app bundle, see ble-helper/) with the
 * Xcode Command Line Tools – once after installation and again only when its
 * sources change. Builds are keyed by a SHA-256 of the sources and the build
 * settings and kept in ~/Library/Caches/TokenBeacon/ble-helper/<key>/.
 * Fixed tools and arguments, no shell, no downloads.
 */

export const HELPER_SOURCE_DIR = fileURLToPath(new URL("./ble-helper/", import.meta.url));
export const HELPER_APP_NAME = "TokenBeaconBLE.app";
export const HELPER_EXECUTABLE = "tokenbeacon-ble";
export const HELPER_BUNDLE_ID = "dev.tokenbeacon.ble-helper";
const SOURCES = ["TokenBeaconBLE.swift", "Info.plist"] as const;
/** Bump when the build command changes; part of the cache key. */
const BUILD_RECIPE = "swiftc -O -swift-version 5 -target <arch>-apple-macos13.0; codesign ad-hoc; v1";
const BUILD_TIMEOUT_MS = 300_000;
const STAMP = "build.sha256";
const KEY_DIR = /^[0-9a-f]{16}$/;

export type HelperBuildFailure = "swift_unavailable" | "build_failed";

export class HelperBuildError extends Error {
  readonly code: HelperBuildFailure;

  constructor(code: HelperBuildFailure) {
    super(code);
    this.code = code;
    this.name = "HelperBuildError";
  }
}

export type RunTool = (file: string, args: string[], timeoutMs: number) => Promise<void>;

export interface HelperBuildOptions {
  cacheDir?: string;
  sourceDir?: string;
  arch?: string;
  /** Runs a build tool; replaced in tests. */
  run?: RunTool;
  log?: (line: string) => void;
}

export function defaultHelperCacheDir(): string {
  return path.join(os.homedir(), "Library", "Caches", "TokenBeacon", "ble-helper");
}

export function helperSourceHash(sourceDir: string = HELPER_SOURCE_DIR, arch: string = process.arch): string {
  const hash = createHash("sha256").update(`${BUILD_RECIPE}\n${arch}\n`);
  for (const name of SOURCES) hash.update(`${name}\n`).update(readFileSync(path.join(sourceDir, name)));
  return hash.digest("hex");
}

/** Path of the helper app for the current sources, building it first if needed. */
export async function ensureBleHelper(options: HelperBuildOptions = {}): Promise<string> {
  const sourceDir = options.sourceDir ?? HELPER_SOURCE_DIR;
  const cacheDir = options.cacheDir ?? defaultHelperCacheDir();
  const arch = options.arch ?? process.arch;
  const run = options.run ?? runTool;
  const hash = helperSourceHash(sourceDir, arch);
  const keyDir = path.join(cacheDir, hash.slice(0, 16));
  const app = path.join(keyDir, HELPER_APP_NAME);
  if (isBuilt(keyDir, app, hash)) return app;

  options.log?.("Bluetooth display: building the TokenBeacon BLE helper (first use or after an update)…");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const work = path.join(cacheDir, `.build-${randomBytes(6).toString("hex")}`);
  try {
    const workApp = path.join(work, HELPER_APP_NAME);
    const macos = path.join(workApp, "Contents", "MacOS");
    mkdirSync(macos, { recursive: true, mode: 0o700 });
    copyFileSync(path.join(sourceDir, "Info.plist"), path.join(workApp, "Contents", "Info.plist"));
    const target = `${arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;
    try {
      await run("/usr/bin/xcrun", ["--find", "swiftc"], 30_000);
    } catch {
      throw new HelperBuildError("swift_unavailable");
    }
    await run(
      "/usr/bin/xcrun",
      [
        "swiftc", "-O", "-swift-version", "5", "-target", target,
        "-module-cache-path", path.join(work, "module-cache"),
        path.join(sourceDir, "TokenBeaconBLE.swift"),
        "-o", path.join(macos, HELPER_EXECUTABLE),
      ],
      BUILD_TIMEOUT_MS,
    ).catch(() => {
      throw new HelperBuildError("build_failed");
    });
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, workApp], 60_000).catch(() => {
      throw new HelperBuildError("build_failed");
    });
    rmSync(keyDir, { recursive: true, force: true });
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    renameSync(workApp, app);
    writeFileSync(path.join(keyDir, STAMP), `${hash}\n`, { mode: 0o600 });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  removeOldBuilds(cacheDir, path.basename(keyDir));
  options.log?.("Bluetooth display: helper ready.");
  return app;
}

function isBuilt(keyDir: string, app: string, hash: string): boolean {
  try {
    return readFileSync(path.join(keyDir, STAMP), "utf8").trim() === hash && existsSync(path.join(app, "Contents", "MacOS", HELPER_EXECUTABLE));
  } catch {
    return false;
  }
}

/** Only removes this cache's own build folders (16 hex digits). */
function removeOldBuilds(cacheDir: string, keep: string): void {
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (entry !== keep && KEY_DIR.test(entry)) rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
    }
  } catch {
    // cleanup is best effort
  }
}

const runTool: RunTool = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), TMPDIR: os.tmpdir() };
    if (process.env.DEVELOPER_DIR) env.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
    execFile(file, args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
