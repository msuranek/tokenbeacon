// Windows path rules, tested on every OS with path.win32 and an in-memory
// file system. Names are fictional.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assignByLongestRoot } from "../src/assignment.ts";
import { comparablePath, isInsidePath, normalizeWin32Path } from "../src/paths.ts";
import { redactHome } from "../src/sanitize.ts";
import { resolveRolloutPath } from "../src/sources/rollouts.ts";

describe("normalizeWin32Path", () => {
  test("plain, extended-length and UNC paths map to one form", () => {
    assert.equal(normalizeWin32Path("C:\\Users\\Jane Doe\\.codex"), "C:\\Users\\Jane Doe\\.codex");
    assert.equal(normalizeWin32Path("C:/Users/Jane Doe/.codex/"), "C:\\Users\\Jane Doe\\.codex");
    assert.equal(normalizeWin32Path("\\\\?\\C:\\Users\\Jane Doe\\.codex"), "C:\\Users\\Jane Doe\\.codex");
    assert.equal(normalizeWin32Path("//?/C:/Users/Jane Doe/.codex"), "C:\\Users\\Jane Doe\\.codex");
    assert.equal(normalizeWin32Path("\\\\?\\UNC\\fileserver\\share\\codex"), "\\\\fileserver\\share\\codex");
    assert.equal(normalizeWin32Path("\\\\fileserver\\share\\codex\\"), "\\\\fileserver\\share\\codex");
    assert.equal(normalizeWin32Path("C:\\"), "C:\\");
    assert.equal(normalizeWin32Path("C:\\a\\b\\..\\..\\c"), "C:\\c");
    // ".." in an extended-length path is resolved lexically, never trusted.
    assert.equal(normalizeWin32Path("\\\\?\\C:\\codex\\sessions\\..\\..\\secret"), "C:\\secret");
  });

  test("device, volume and relative forms are refused", () => {
    for (const unsafe of [
      "\\\\.\\C:\\Users\\Jane Doe\\.codex\\sessions\\rollout-a.jsonl",
      "\\\\.\\pipe\\codex",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\rollout-a.jsonl",
      "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\rollout-a.jsonl",
      "\\??\\C:\\Users\\rollout-a.jsonl",
      "\\\\?\\UNC\\onlyserver",
      "C:relative\\rollout-a.jsonl",
      "\\rooted\\rollout-a.jsonl",
      "relative\\rollout-a.jsonl",
      "",
      "C:\\Users\\a\0.jsonl",
    ]) {
      assert.equal(normalizeWin32Path(unsafe), null, unsafe);
    }
  });

  test("comparison ignores case and separators but keeps directory boundaries", () => {
    assert.equal(comparablePath("\\\\?\\C:\\Users\\JANE DOE", "win32"), comparablePath("c:/users/jane doe/", "win32"));
    assert.ok(isInsidePath("C:\\Data\\Sessions", "c:\\data\\sessions\\2026\\rollout-a.jsonl", "win32"));
    assert.ok(isInsidePath("\\\\?\\C:\\Data\\Sessions", "C:\\Data\\Sessions\\rollout-a.jsonl", "win32"));
    assert.ok(!isInsidePath("C:\\Data\\Sessions", "C:\\Data\\Sessions", "win32"));
    assert.ok(!isInsidePath("C:\\Data\\Sessions", "C:\\Data\\Sessions-old\\rollout-a.jsonl", "win32"));
    assert.ok(!isInsidePath("C:\\Data\\Sessions", "D:\\Data\\Sessions\\rollout-a.jsonl", "win32"));
    assert.ok(!isInsidePath("C:\\Data\\Sessions", "\\\\.\\C:\\Data\\Sessions\\rollout-a.jsonl", "win32"));
    assert.ok(!isInsidePath("C:\\Data\\Sessions", "C:\\Data\\Sessions\\..\\auth.json", "win32"));
    // POSIX stays case-sensitive.
    assert.ok(!isInsidePath("/data/sessions", "/Data/sessions/rollout-a.jsonl", "posix"));
  });
});

describe("rollout confinement on Windows", () => {
  const HOME = "C:\\Users\\Jane Doe\\.codex";
  const SESSIONS = `${HOME}\\sessions`;
  const ARCHIVED = `${HOME}\\archived_sessions`;
  const files = new Set([
    `${SESSIONS}\\2026\\11\\18\\rollout-2026-11-18T10-00-00-a.jsonl`,
    `${ARCHIVED}\\rollout-2026-11-01T10-00-00-b.jsonl.zst`,
    `${SESSIONS}\\2026\\11\\18\\notes.txt`,
    `${SESSIONS}\\rollout-a.jsonl:secret.jsonl`,
    `${HOME}\\auth.json`,
    `${HOME}\\rollout-root.jsonl`,
    "C:\\Users\\Jane Doe\\Documents\\rollout-elsewhere.jsonl",
    "D:\\codex-copy\\sessions\\rollout-other-drive.jsonl",
    `${SESSIONS}\\rollout-junction-out.jsonl`,
  ]);
  const directories = new Set([HOME, SESSIONS, ARCHIVED, `${SESSIONS}\\2026\\11\\18`]);
  // A junction/symlink inside sessions that points outside the Codex data.
  const links = new Map([[`${SESSIONS}\\rollout-junction-out.jsonl`, `${HOME}\\auth.json`]]);

  // Like realpathSync.native: case-insensitive lookup, canonical casing, no prefix.
  const canonical = new Map([...files, ...directories].map((entry) => [entry.toLowerCase(), entry]));
  const realpath = (value: string): string => {
    const normalized = normalizeWin32Path(value);
    const hit = normalized ? canonical.get(normalized.toLowerCase()) : undefined;
    if (!hit) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return links.get(hit) ?? hit;
  };
  const isFile = (value: string) => files.has(value);
  const kind = (requested: string) => resolveRolloutPath(HOME, requested, { platform: "win32", realpath, isFile }).kind;
  const plain = `${SESSIONS}\\2026\\11\\18\\rollout-2026-11-18T10-00-00-a.jsonl`;

  test("accepts the forms Codex writes on Windows", () => {
    assert.equal(kind(plain), "ok");
    assert.equal(kind(`\\\\?\\${plain}`), "ok"); // the v0.1.1 outsideStorage bug
    assert.equal(kind(plain.toUpperCase()), "ok");
    assert.equal(kind(plain.replace(/\\/g, "/")), "ok");
    assert.equal(kind("sessions\\2026\\11\\18\\rollout-2026-11-18T10-00-00-a.jsonl"), "ok");
    assert.equal(kind(`\\\\?\\${ARCHIVED}\\rollout-2026-11-01T10-00-00-b.jsonl`), "ok"); // .zst fallback
    const resolved = resolveRolloutPath(HOME, `\\\\?\\${plain.toLowerCase()}`, { platform: "win32", realpath, isFile });
    assert.deepEqual(resolved, { kind: "ok", path: plain });
  });

  test("refuses everything outside sessions/archived_sessions", () => {
    assert.equal(kind(`${HOME}\\auth.json`), "outsideStorage");
    assert.equal(kind(`\\\\?\\${HOME}\\auth.json`), "outsideStorage");
    assert.equal(kind(`${HOME}\\rollout-root.jsonl`), "outsideStorage");
    assert.equal(kind("C:\\Users\\Jane Doe\\Documents\\rollout-elsewhere.jsonl"), "outsideStorage");
    assert.equal(kind("D:\\codex-copy\\sessions\\rollout-other-drive.jsonl"), "outsideStorage");
    assert.equal(kind(`${SESSIONS}\\..\\auth.json`), "outsideStorage");
    assert.equal(kind(`\\\\?\\${SESSIONS}\\..\\..\\Documents\\rollout-elsewhere.jsonl`), "outsideStorage");
    assert.equal(kind("..\\Documents\\rollout-elsewhere.jsonl"), "outsideStorage");
    assert.equal(kind(`${SESSIONS}\\rollout-junction-out.jsonl`), "outsideStorage");
  });

  test("refuses device namespaces, streams and non-rollout names", () => {
    assert.equal(kind(`\\\\.\\${plain}`), "outsideStorage");
    assert.equal(kind("\\\\.\\pipe\\rollout-a.jsonl"), "outsideStorage");
    assert.equal(kind("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\rollout-a.jsonl"), "outsideStorage");
    assert.equal(kind("\\??\\C:\\Users\\Jane Doe\\.codex\\sessions\\rollout-a.jsonl"), "outsideStorage");
    assert.equal(kind("C:rollout-a.jsonl"), "outsideStorage");
    assert.equal(kind(`${SESSIONS}\\rollout-a.jsonl:secret.jsonl`), "invalidName");
    assert.equal(kind(`${SESSIONS}\\2026\\11\\18\\notes.txt`), "invalidName");
    assert.equal(kind(`${SESSIONS}\\2026\\11\\18`), "invalidName");
    assert.equal(kind(`${SESSIONS}\\rollout-missing.jsonl`), "missing");
    assert.equal(kind(""), "invalidName");
    assert.equal(kind(`${plain}\0.zst`), "invalidName");
  });
});

describe("project assignment on Windows", () => {
  const projects = [
    { id: "parent", rootPaths: ["C:\\Work\\App"] },
    { id: "child", rootPaths: ["c:/work/app/packages/monitor/"] },
    { id: "share", rootPaths: ["\\\\?\\UNC\\fileserver\\team\\site"] },
  ];

  test("matches regardless of case, separators, trailing slash and \\\\?\\ prefix", () => {
    assert.equal(assignByLongestRoot("C:\\Work\\App\\src", projects, "win32"), "parent");
    assert.equal(assignByLongestRoot("c:\\work\\app", projects, "win32"), "parent");
    assert.equal(assignByLongestRoot("\\\\?\\C:\\WORK\\APP\\packages\\monitor\\src", projects, "win32"), "child");
    assert.equal(assignByLongestRoot("C:/Work/App/packages/monitor", projects, "win32"), "child");
    assert.equal(assignByLongestRoot("\\\\fileserver\\TEAM\\site\\docs", projects, "win32"), "share");
  });

  test("keeps directory boundaries and refuses unusable paths", () => {
    assert.equal(assignByLongestRoot("C:\\Work\\Application", projects, "win32"), null);
    assert.equal(assignByLongestRoot("D:\\Work\\App", projects, "win32"), null);
    assert.equal(assignByLongestRoot("Work\\App", projects, "win32"), null);
    assert.equal(assignByLongestRoot("\\\\.\\C:\\Work\\App", projects, "win32"), null);
    assert.equal(assignByLongestRoot("", projects, "win32"), null);
  });

  test("a drive root contains the whole drive", () => {
    assert.equal(assignByLongestRoot("E:\\scratch\\x", [{ id: "drive", rootPaths: ["E:\\"] }], "win32"), "drive");
  });
});

describe("home redaction on Windows", () => {
  const home = "C:\\Users\\Jane Doe";

  test("redacts every common spelling of the home folder", () => {
    const cases: Array<[string, string]> = [
      ["Fix C:\\Users\\Jane Doe\\repo\\app.ts", "Fix ~\\repo\\app.ts"],
      ["Fix c:\\users\\jane doe\\repo", "Fix ~\\repo"],
      ["Fix C:/Users/Jane Doe/repo", "Fix ~/repo"],
      ['Error at "C:\\\\Users\\\\Jane Doe\\\\repo"', 'Error at "~\\\\repo"'],
      ["Open \\\\?\\C:\\Users\\Jane Doe\\repo", "Open ~\\repo"],
      ["Bash /c/Users/Jane Doe/repo", "Bash ~/repo"],
      ["WSL /mnt/c/Users/Jane Doe/repo", "WSL ~/repo"],
      ["Two C:\\Users\\Jane Doe\\a and C:\\Users\\Jane Doe\\b", "Two ~\\a and ~\\b"],
      ["Prefix C:\\Users\\Jane Doer\\x", "Prefix ~r\\x"],
    ];
    for (const [input, expected] of cases) assert.equal(redactHome(input, home), expected, input);
    assert.equal(redactHome("Nothing to hide in D:\\Users\\Jane Doe", home), "Nothing to hide in D:\\Users\\Jane Doe");
  });

  test("handles homes with regex characters and trailing separators", () => {
    assert.equal(redactHome("C:\\Users\\a.b (c)+\\x and C:\\Users\\aXb (c)+\\y", "C:\\Users\\a.b (c)+\\"), "~\\x and C:\\Users\\aXb (c)+\\y");
  });

  test("macOS behaviour is unchanged", () => {
    assert.equal(redactHome("Fix /Users/jane/repo", "/Users/jane"), "Fix ~/repo");
    assert.equal(redactHome("Fix /Users/Jane/repo", "/Users/jane"), "Fix /Users/Jane/repo");
  });
});
