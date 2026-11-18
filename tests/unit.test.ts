import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { assignByLongestRoot } from "../src/assignment.ts";
import { resolveCodexHome } from "../src/config.ts";
import { contextUsedPercent } from "../src/metrics.ts";
import { MIN_NODE_VERSION, runtimeProblems } from "../src/runtime-check.mjs";

test("context formula matches the context-left value Codex displays", () => {
  assert.equal(contextUsedPercent(125_767, 258_400), 46);
  assert.equal(contextUsedPercent(0, 258_400), 0);
  assert.equal(contextUsedPercent(258_400, 258_400), 100);
  assert.equal(contextUsedPercent(100, 12_000), 100);
});

test("path assignment uses directory boundaries and the longest root", () => {
  const projects = [
    { id: "parent", rootPaths: ["/work/app"] },
    { id: "child", rootPaths: ["/work/app/packages/monitor"] },
  ];
  assert.equal(assignByLongestRoot("/work/app/packages/monitor/src", projects, "posix"), "child");
  assert.equal(assignByLongestRoot("/work/application", projects, "posix"), null);
  assert.equal(assignByLongestRoot("relative/path", projects, "posix"), null);
  assert.equal(assignByLongestRoot("", projects, "posix"), null);
});

describe("CODEX_HOME resolution", () => {
  const home = path.resolve("/home/tester");
  const cwd = path.resolve("/work/dir");
  test("defaults to ~/.codex", () => {
    assert.equal(resolveCodexHome({}, home, cwd), path.join(home, ".codex"));
    assert.equal(resolveCodexHome({ CODEX_HOME: "" }, home, cwd), path.join(home, ".codex"));
    assert.equal(resolveCodexHome({ CODEX_HOME: "   " }, home, cwd), path.join(home, ".codex"));
  });
  test("honours absolute, relative and ~ values", () => {
    assert.equal(resolveCodexHome({ CODEX_HOME: "/data/codex" }, home, cwd), path.resolve("/data/codex"));
    assert.equal(resolveCodexHome({ CODEX_HOME: "profiles/work" }, home, cwd), path.join(cwd, "profiles", "work"));
    assert.equal(resolveCodexHome({ CODEX_HOME: "~/alt-codex" }, home, cwd), path.join(home, "alt-codex"));
    assert.equal(resolveCodexHome({ CODEX_HOME: "~" }, home, cwd), home);
  });
  test("Windows: %USERPROFILE%\\.codex by default, ~\\ and drive paths", () => {
    const winHome = "C:\\Users\\Jane Doe";
    const winCwd = "C:\\Users\\Jane Doe\\tokenbeacon";
    const resolve = (value?: string) =>
      resolveCodexHome(value === undefined ? {} : { CODEX_HOME: value }, winHome, winCwd, "win32");
    assert.equal(resolve(), "C:\\Users\\Jane Doe\\.codex");
    assert.equal(resolve("~\\alt-codex"), "C:\\Users\\Jane Doe\\alt-codex");
    assert.equal(resolve("~/alt-codex"), "C:\\Users\\Jane Doe\\alt-codex");
    assert.equal(resolve("D:\\codex-data"), "D:\\codex-data");
    assert.equal(resolve("profiles\\work"), "C:\\Users\\Jane Doe\\tokenbeacon\\profiles\\work");
    // On macOS "~\\" is an ordinary (odd) relative name, as before.
    assert.equal(resolveCodexHome({ CODEX_HOME: "~\\x" }, "/Users/jane", "/work", "posix"), "/work/~\\x");
  });
});

describe("Node.js runtime check", () => {
  test("supported versions", () => {
    assert.equal(MIN_NODE_VERSION, "22.18.0");
    for (const version of ["v22.18.0", "v22.20.1", "v23.6.0", "v24.0.0", "v25.2.1", "v26.1.0"]) {
      assert.deepEqual(runtimeProblems(version, { typescript: "strip" }), [], version);
    }
    // Older releases without process.features.typescript are judged by version.
    assert.deepEqual(runtimeProblems("v24.0.0", {}), []);
  });
  test("unsupported versions produce actionable messages", () => {
    for (const version of ["v18.20.0", "v20.19.0", "v22.17.1", "v23.5.0"]) {
      const problems = runtimeProblems(version, {});
      assert.equal(problems.length, 1, version);
      assert.match(problems[0], /requires|required|needs/);
    }
    assert.match(runtimeProblems("v24.0.0", { typescript: false })[0], /type stripping/i);
    assert.match(runtimeProblems("garbage", {})[0], /Unrecognised/);
  });
});
