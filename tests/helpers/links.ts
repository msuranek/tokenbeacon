import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Directory links: a junction on Windows (no special rights needed), a
 * symlink elsewhere. Both are followed by realpath like any other link.
 */
export function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * File symlinks need Developer Mode or administrator rights on Windows.
 * Returns false (instead of throwing EPERM) when they are not allowed, so the
 * caller can skip only the checks that depend on them.
 */
export function tryLinkFile(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return false;
    throw error;
  }
}

/** Whether this process may create file symlinks (always true on macOS/Linux). */
export const CAN_LINK_FILES: boolean = (() => {
  const root = mkdtempSync(path.join(tmpdir(), "tokenbeacon-link-probe-"));
  try {
    writeFileSync(path.join(root, "target"), "");
    return tryLinkFile(path.join(root, "target"), path.join(root, "link"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

export const FILE_SYMLINK_SKIP_REASON =
  "file symlinks are not allowed for this user (Windows without Developer Mode)";
