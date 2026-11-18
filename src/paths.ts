import path from "node:path";

/**
 * Platform-aware path helpers shared by rollout confinement, project
 * assignment and static file serving.
 *
 * Every function takes the platform explicitly (defaulting to the current one)
 * so the Windows rules are unit-tested on every OS.
 */

export type PathPlatform = "win32" | "posix";

export function currentPlatform(): PathPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

export type PathApi = typeof path.posix;

export function pathApi(platform: PathPlatform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Turns a Windows path into a plain drive (`C:\…`) or UNC (`\\server\share\…`)
 * path so it can be compared with other paths.
 *
 * - `\\?\C:\…` (extended-length, as Codex sometimes stores `rollout_path`) and
 *   `\\?\UNC\server\share\…` lose their prefix.
 * - Every other namespace path – `\\.\…` devices and pipes, `\\?\GLOBALROOT\…`,
 *   `\\?\Volume{…}\…`, NT `\??\…` – returns null: it cannot be mapped to a
 *   normal location and must never be read.
 * - Forward slashes become backslashes; `.`/`..` segments are resolved
 *   lexically (symlinks are resolved separately with realpath).
 */
export function normalizeWin32Path(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) return null;
  let value = input.replace(/\//g, "\\");
  if (value.startsWith("\\??\\")) return null;
  if (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")) {
    if (value.startsWith("\\\\.\\")) return null;
    const rest = value.slice(4);
    if (/^[A-Za-z]:(\\|$)/.test(rest)) value = rest;
    else if (/^UNC\\[^\\]+\\[^\\]+/i.test(rest)) value = `\\\\${rest.slice(4)}`;
    else return null;
  }
  // Only fully qualified paths (drive + root, or UNC) are accepted; drive-relative
  // `C:foo` and rooted `\foo` depend on per-process state.
  if (!/^[A-Za-z]:\\/.test(value) && !/^\\\\[^\\?.][^\\]*\\[^\\]+/.test(value)) return null;
  const normalized = path.win32.normalize(value);
  // A trailing separator is kept only for a drive root (`C:\`).
  return /^[A-Za-z]:\\$/.test(normalized) ? normalized : normalized.replace(/\\+$/, "");
}

/**
 * A form of an absolute path that is equal for equal locations: on Windows the
 * normalized path in lower case (NTFS is case-insensitive by default), on
 * POSIX the resolved path. Returns null when the path is not usable.
 */
export function comparablePath(input: string, platform: PathPlatform = currentPlatform()): string | null {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) return null;
  if (platform === "win32") return normalizeWin32Path(input)?.toLowerCase() ?? null;
  if (!path.posix.isAbsolute(input)) return null;
  return path.posix.resolve(input);
}

/**
 * True when `candidate` lies strictly inside `root` (a directory boundary is
 * required: `C:\data` does not contain `C:\data-old`). Unusable paths are never
 * inside anything.
 */
export function isInsidePath(root: string, candidate: string, platform: PathPlatform = currentPlatform()): boolean {
  const comparableRoot = comparablePath(root, platform);
  const comparableCandidate = comparablePath(candidate, platform);
  if (comparableRoot === null || comparableCandidate === null) return false;
  const api = pathApi(platform);
  const relative = api.relative(comparableRoot, comparableCandidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  );
}

/** True when both paths point to the same location (see comparablePath). */
export function isSamePath(left: string, right: string, platform: PathPlatform = currentPlatform()): boolean {
  const a = comparablePath(left, platform);
  return a !== null && a === comparablePath(right, platform);
}
