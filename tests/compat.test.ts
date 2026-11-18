import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { describe, test } from "node:test";
import { createMonitorServer, listenLoopback } from "../src/http-server.ts";
import { SnapshotService } from "../src/snapshot-service.ts";
import { LocalDataSource } from "../src/sources/local-data.ts";
import { RolloutCache, resolveRolloutPath } from "../src/sources/rollouts.ts";
import type { MonitorSnapshot, SourceHealth, ThreadView } from "../src/types.ts";
import {
  createFixtureCodexHome,
  createTempRoot,
  hasZstd,
  IDS,
  NOW_MS,
  rolloutLines,
} from "./helpers/fixture-codex-home.ts";
import { CAN_LINK_FILES, FILE_SYMLINK_SKIP_REASON, linkDirectory, tryLinkFile } from "./helpers/links.ts";

function allThreads(snapshot: MonitorSnapshot): ThreadView[] {
  return [
    ...snapshot.projects.flatMap((p) => (p.latestThread ? [p.latestThread, ...p.otherThreads] : [])),
    ...snapshot.unassignedThreads,
  ];
}

function health(snapshot: MonitorSnapshot, source: string): SourceHealth {
  const entry = snapshot.sourceHealth.find((item) => item.source === source);
  assert.ok(entry, `missing health for ${source}`);
  return entry;
}

async function snapshotFor(codexHome: string): Promise<MonitorSnapshot> {
  // Fixed clock: fixture limit windows are defined relative to NOW_MS.
  return new SnapshotService(new LocalDataSource(codexHome), undefined, () => NOW_MS).refresh();
}

function fingerprint(directory: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const info = statSync(full);
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        result.set(path.relative(directory, full), `${hash}:${info.size}:${info.mtimeMs}`);
      }
    }
  };
  walk(directory);
  return result;
}

describe("current schema fixture", () => {
  test("projects, visibility, assignment, telemetry and compactions", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const snapshot = await snapshotFor(fixture.codexHome);
    const threads = new Map(allThreads(snapshot).map((thread) => [thread.id, thread]));

    // Project order follows `position`; Beta (0) before Alpha (1) by position,
    // but the view is sorted by activity, so only check membership here.
    assert.deepEqual(snapshot.projects.map((p) => p.name).sort(), ["Alpha", "Beta"]);

    // Catalog visibility: guardian (remote host + subagent) and archived are hidden.
    assert.ok(!threads.has(IDS.threadGuardian));
    assert.ok(!threads.has(IDS.threadArchived));
    assert.equal(threads.size, 5);
    assert.equal(health(snapshot, "threadVisibility").state, "ok");

    assert.equal(threads.get(IDS.threadExplicit)!.assignmentSource, "state-db");
    assert.equal(threads.get(IDS.threadExplicit)!.projectId, IDS.projectA);
    assert.equal(threads.get(IDS.threadCatalog)!.assignmentSource, "desktop-catalog");
    assert.equal(threads.get(IDS.threadCatalog)!.projectId, IDS.projectB);
    assert.equal(threads.get(IDS.threadPath)!.assignmentSource, "path-fallback");
    assert.equal(threads.get(IDS.threadPath)!.projectId, IDS.projectA);
    assert.equal(threads.get(IDS.threadPath)!.title, "Preview title");
    assert.equal(threads.get(IDS.threadUnassigned)!.assignmentSource, "unassigned");

    const explicit = threads.get(IDS.threadExplicit)!;
    assert.equal(explicit.model.value, "gpt-fixture");
    assert.equal(explicit.model.state, "current");
    assert.equal(explicit.totalTokens.value, 1_000);
    assert.equal(explicit.contextTokens.value, 50_000);
    assert.equal(explicit.contextWindowTokens.value, 200_000);
    assert.equal(explicit.compactionCount.value, 2);
    assert.equal(threads.get(IDS.threadCatalog)!.compactionCount.value, 0);
    assert.equal(snapshot.limits.fiveHour.value?.usedPercent, 42);
    assert.equal(snapshot.limits.weekly.value?.usedPercent, 7);

    // Missing rollout: values fall back or become unavailable, never invented.
    const unassigned = threads.get(IDS.threadUnassigned)!;
    assert.equal(unassigned.contextUsedPercent.state, "unavailable");
    assert.equal(unassigned.contextUsedPercent.value, null);
    assert.equal(unassigned.totalTokens.value, 77);
    assert.equal(unassigned.totalTokens.state, "last-known");

    for (const source of ["codexHome", "stateDb", "historyDb", "desktopCatalog"]) {
      assert.equal(health(snapshot, source).state, "ok", source);
    }
    const rollouts = health(snapshot, "rollouts");
    assert.equal(rollouts.state, "degraded");
    assert.match(String(rollouts.detail), /missing:1/);
    assert.match(String(rollouts.detail), /outsideStorage:1/);
  });

  test("rollout outside Codex storage is never read", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const snapshot = await snapshotFor(fixture.codexHome);
    const outside = allThreads(snapshot).find((thread) => thread.id === IDS.threadOutside)!;
    // The outside file reports 999999 tokens; it must not appear.
    assert.equal(outside.totalTokens.value, null);
    assert.ok(!JSON.stringify(snapshot).includes("999999"));
  });

  test("CODEX_HOME given as a symlink to the data directory works", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const link = path.join(fixture.root, "codex-link");
    linkDirectory(fixture.codexHome, link);
    const snapshot = await snapshotFor(link);
    const explicit = allThreads(snapshot).find((thread) => thread.id === IDS.threadExplicit)!;
    assert.equal(explicit.totalTokens.value, 1_000);
  });
});

describe("empty and missing installations", () => {
  test("missing CODEX_HOME directory yields an empty snapshot with a clear code", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const snapshot = await snapshotFor(path.join(root, "does-not-exist"));
    assert.deepEqual(snapshot.projects, []);
    assert.deepEqual(snapshot.unassignedThreads, []);
    assert.equal(snapshot.diagnostics.visibleThreadCount, 0);
    assert.equal(health(snapshot, "codexHome").state, "unavailable");
    assert.equal(health(snapshot, "codexHome").detail, "codex_home_missing");
    assert.equal(health(snapshot, "stateDb").state, "unavailable");
    assert.equal(snapshot.limits.fiveHour.state, "unavailable");
  });

  test("CODEX_HOME pointing at a file is reported, not crashed on", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const file = path.join(root, "file");
    writeFileSync(file, "x");
    const snapshot = await snapshotFor(file);
    assert.equal(health(snapshot, "codexHome").detail, "codex_home_not_directory");
  });

  test("empty directory (fresh install) yields empty data and missing databases", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const snapshot = await snapshotFor(root);
    assert.equal(health(snapshot, "codexHome").state, "ok");
    for (const source of ["stateDb", "historyDb", "desktopCatalog"]) {
      assert.equal(health(snapshot, source).state, "unavailable", source);
      assert.equal(health(snapshot, source).detail, "missing", source);
    }
    assert.equal(snapshot.projects.length, 0);
    // Nothing was created in the empty directory.
    assert.deepEqual(readdirSync(root), []);
  });

  test("missing history database: compactions are unavailable, not zero", async (t) => {
    const fixture = createFixtureCodexHome({ databases: ["state", "desktop"] });
    t.after(fixture.cleanup);
    const snapshot = await snapshotFor(fixture.codexHome);
    assert.equal(health(snapshot, "historyDb").detail, "missing");
    for (const thread of allThreads(snapshot)) {
      assert.equal(thread.compactionCount.state, "unavailable");
      assert.equal(thread.compactionCount.value, null);
    }
  });

  test("missing desktop catalog: heuristic visibility hides internal threads", async (t) => {
    const fixture = createFixtureCodexHome({ databases: ["state", "history"] });
    t.after(fixture.cleanup);
    const snapshot = await snapshotFor(fixture.codexHome);
    const ids = new Set(allThreads(snapshot).map((thread) => thread.id));
    assert.ok(!ids.has(IDS.threadGuardian));
    assert.ok(!ids.has(IDS.threadArchived));
    assert.ok(ids.has(IDS.threadExplicit));
    assert.equal(health(snapshot, "desktopCatalog").detail, "missing");
    assert.equal(health(snapshot, "threadVisibility").state, "degraded");
  });

  test("missing state database: server-side data is empty but other sources still load", async (t) => {
    const fixture = createFixtureCodexHome({ databases: ["history", "desktop"] });
    t.after(fixture.cleanup);
    const snapshot = await snapshotFor(fixture.codexHome);
    assert.equal(health(snapshot, "stateDb").state, "unavailable");
    assert.equal(health(snapshot, "historyDb").state, "ok");
    assert.equal(allThreads(snapshot).length, 0);
  });
});

describe("schema drift", () => {
  test("legacy schema without optional tables and columns degrades per value", async (t) => {
    const fixture = createFixtureCodexHome({ legacySchema: true });
    t.after(fixture.cleanup);
    const snapshot = await snapshotFor(fixture.codexHome);
    const state = health(snapshot, "stateDb");
    assert.equal(state.state, "degraded");
    assert.match(String(state.detail), /missing_table:projects/);
    assert.match(String(state.detail), /missing_column:threads\.model/);
    assert.equal(health(snapshot, "historyDb").state, "degraded");

    const threads = new Map(allThreads(snapshot).map((thread) => [thread.id, thread]));
    assert.equal(threads.size, 2);
    const legacy = threads.get(IDS.threadExplicit)!;
    assert.equal(legacy.title, "Legacy thread");
    assert.equal(legacy.projectId, null);
    assert.equal(legacy.compactionCount.value, 1);
    assert.equal(legacy.lastCompactionAt.state, "unavailable");
    // Seconds-based timestamps are normalized.
    assert.ok(String(legacy.lastActivityAt.value).startsWith("2026-11-16"));
    assert.equal(threads.get(IDS.threadPath)!.title, "Untitled");
  });

  test("unrelated or renamed tables make the source unavailable without throwing", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const sqlite = await import("node:sqlite");
    const Db = ((sqlite as Record<string, unknown>).Database ?? sqlite.DatabaseSync) as typeof sqlite.DatabaseSync;
    for (const [file, sql] of [
      ["state_5.sqlite", "CREATE TABLE conversations (uuid TEXT)"],
      ["thread_history_1.sqlite", "CREATE TABLE thread_items (something_else TEXT)"],
    ] as const) {
      const db = new Db(path.join(root, file));
      db.exec(sql);
      db.close();
    }
    const snapshot = await snapshotFor(root);
    assert.equal(health(snapshot, "stateDb").state, "unavailable");
    assert.match(String(health(snapshot, "stateDb").detail), /missing_table:threads/);
    assert.equal(health(snapshot, "historyDb").state, "unavailable");
    assert.equal(allThreads(snapshot).length, 0);
  });

  test("threads table without id column is unavailable, not a crash", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path.join(root, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (thread_uuid TEXT, title TEXT)");
    db.exec("INSERT INTO threads VALUES ('x', 'y')");
    db.close();
    const snapshot = await snapshotFor(root);
    assert.equal(allThreads(snapshot).length, 0);
    assert.notEqual(health(snapshot, "stateDb").state, "ok");
  });

  test("corrupt or non-SQLite database files are reported", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    writeFileSync(path.join(root, "state_5.sqlite"), "this is not a sqlite database at all".repeat(200));
    mkdirSync(path.join(root, "sqlite"));
    mkdirSync(path.join(root, "sqlite", "codex.db")); // a directory where a file is expected
    const snapshot = await snapshotFor(root);
    assert.equal(health(snapshot, "stateDb").state, "unavailable");
    assert.match(String(health(snapshot, "stateDb").detail), /not_sqlite|open_failed|corrupt/);
    assert.equal(health(snapshot, "desktopCatalog").detail, "not_file");
  });

  test("health details never contain paths", async (t) => {
    const fixture = createFixtureCodexHome({ legacySchema: true });
    t.after(fixture.cleanup);
    const snapshot = await snapshotFor(fixture.codexHome);
    for (const entry of snapshot.sourceHealth) {
      assert.ok(!String(entry.detail).includes(fixture.root), entry.source);
      assert.ok(!String(entry.detail).includes("/"), `${entry.source}: ${entry.detail}`);
    }
  });
});

describe("rollout path confinement (OSR-010)", () => {
  test("only rollout files inside sessions/archived_sessions are accepted", (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const home = fixture.codexHome;
    const sessions = path.join(home, "sessions", "2026", "11", "16");
    mkdirSync(path.join(home, "archived_sessions"), { recursive: true });
    writeFileSync(path.join(home, "archived_sessions", "rollout-old.jsonl"), rolloutLines({}));
    writeFileSync(path.join(sessions, "notes.txt"), "not a rollout");
    writeFileSync(path.join(home, "rollout-at-root.jsonl"), rolloutLines({}));
    writeFileSync(path.join(home, "auth.json"), '{"token":"fixture-secret"}');
    linkDirectory(fixture.outsideDir, path.join(home, "sessions", "linked-dir"));

    const kind = (p: string) => resolveRolloutPath(home, p).kind;
    assert.equal(kind(path.join(sessions, "rollout-explicit.jsonl")), "ok");
    assert.equal(kind(path.join(home, "archived_sessions", "rollout-old.jsonl")), "ok");
    assert.equal(kind("sessions/2026/11/16/rollout-explicit.jsonl"), "ok"); // relative to CODEX_HOME
    assert.equal(kind(path.join(sessions, "rollout-nope.jsonl")), "missing");

    assert.equal(kind(path.join(fixture.outsideDir, "rollout-outside.jsonl")), "outsideStorage");
    assert.equal(kind(path.join(sessions, "..", "..", "..", "..", "..", "outside", "rollout-outside.jsonl")), "outsideStorage");
    assert.equal(kind(`${path.join(home, "sessions")}/../../outside/rollout-outside.jsonl`), "outsideStorage");
    assert.equal(kind(path.join(home, "rollout-at-root.jsonl")), "outsideStorage");
    assert.equal(kind(path.join(home, "auth.json")), "outsideStorage");
    assert.equal(kind(path.join(home, "sessions", "linked-dir", "rollout-outside.jsonl")), "outsideStorage");
    assert.equal(kind(path.join(sessions, "notes.txt")), "invalidName");
    assert.equal(kind(path.join(home, "sessions")), "outsideStorage");
    assert.equal(kind(path.join(sessions)), "invalidName"); // a directory, not a rollout file
    assert.equal(kind(`${path.join(sessions, "rollout-explicit.jsonl")}\0.zst`), "invalidName");
    assert.equal(kind(""), "invalidName");
  });

  test("file symlinks are followed only within rollout storage", { skip: !CAN_LINK_FILES && FILE_SYMLINK_SKIP_REASON }, (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const home = fixture.codexHome;
    const sessions = path.join(home, "sessions", "2026", "11", "16");
    writeFileSync(path.join(home, "auth.json"), '{"token":"fixture-secret"}');
    assert.ok(tryLinkFile(path.join(fixture.outsideDir, "rollout-outside.jsonl"), path.join(sessions, "rollout-link-out.jsonl")));
    assert.ok(tryLinkFile(path.join(sessions, "rollout-catalog.jsonl"), path.join(sessions, "rollout-link-in.jsonl")));
    assert.ok(tryLinkFile(path.join(home, "auth.json"), path.join(sessions, "rollout-auth.jsonl")));
    const kind = (p: string) => resolveRolloutPath(home, p).kind;
    assert.equal(kind(path.join(sessions, "rollout-link-in.jsonl")), "ok");
    assert.equal(kind(path.join(sessions, "rollout-link-out.jsonl")), "outsideStorage");
    assert.equal(kind(path.join(sessions, "rollout-auth.jsonl")), "outsideStorage");
  });

  test("sessions directory symlinked elsewhere is followed only within its real target", (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const home = path.join(root, "home");
    const realSessions = path.join(root, "external-volume", "sessions");
    mkdirSync(home);
    mkdirSync(realSessions, { recursive: true });
    writeFileSync(path.join(realSessions, "rollout-a.jsonl"), rolloutLines({}));
    linkDirectory(realSessions, path.join(home, "sessions"));
    assert.equal(resolveRolloutPath(home, path.join(home, "sessions", "rollout-a.jsonl")).kind, "ok");
  });

  test("compressed rollout fallback (.jsonl -> .jsonl.zst)", { skip: !hasZstd() && "zstd not installed" }, async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const sessions = path.join(fixture.codexHome, "sessions", "2026", "11", "16");
    const plain = path.join(sessions, "rollout-catalog.jsonl");
    assert.equal(spawnSync("zstd", ["-q", plain, "-o", `${plain}.zst`]).status, 0);
    unlinkSync(plain);
    const cache = new RolloutCache(fixture.codexHome);
    const result = await cache.readMany([plain]);
    const telemetry = result.get(plain);
    assert.equal(telemetry?.sourceKind, "jsonl.zst");
    assert.equal(telemetry?.tokenCountTotal?.total_tokens, 2_000);
  });

  test("missing zstd binary is reported as zstdMissing", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const sessions = path.join(fixture.codexHome, "sessions", "2026", "11", "16");
    const compressed = path.join(sessions, "rollout-fake.jsonl.zst");
    writeFileSync(compressed, "not really zstd");
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(fixture.root, "empty-bin");
    try {
      const cache = new RolloutCache(fixture.codexHome);
      const result = await cache.readMany([compressed]);
      assert.equal(result.get(compressed), null);
      assert.equal(cache.lastIssues().zstdMissing, 1);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("read-only guarantee", () => {
  test("refresh changes no byte, size or mtime and creates no files, even on read-only files", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(() => {
      // Restore permissions so cleanup can delete the tree.
      const restore = (directory: string) => {
        chmodSync(directory, 0o755);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) restore(full);
          else if (entry.isFile()) chmodSync(full, 0o644);
        }
      };
      restore(fixture.codexHome);
      fixture.cleanup();
    });
    const before = fingerprint(fixture.codexHome);
    const lock = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) lock(full);
        else if (entry.isFile()) chmodSync(full, 0o444);
      }
      chmodSync(directory, 0o555);
    };
    lock(fixture.codexHome);

    const service = new SnapshotService(new LocalDataSource(fixture.codexHome));
    const first = await service.refresh();
    await service.refresh();
    assert.equal(health(first, "stateDb").state, "ok");
    assert.equal(allThreads(first).length, 5);
    assert.deepEqual(fingerprint(fixture.codexHome), before);
  });
});

describe("server with an empty installation", () => {
  test("starts, serves an empty snapshot and reports degraded health", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const service = new SnapshotService(new LocalDataSource(path.join(root, "missing-home")));
    await service.refresh();
    const server = createMonitorServer({
      getSnapshot: () => service.current,
      getError: () => service.error,
      distRoot: path.join(root, "no-dist"),
    });
    const { port } = await listenLoopback(server, 0);
    t.after(() => server.close());

    const get = (pathName: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: pathName }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });

    const snapshot = await get("/api/snapshot");
    assert.equal(snapshot.status, 200);
    assert.deepEqual(JSON.parse(snapshot.body).projects, []);
    const healthResponse = await get("/api/health");
    const body = JSON.parse(healthResponse.body);
    assert.equal(body.status, "degraded");
    assert.ok(body.sources.some((s: SourceHealth) => s.source === "codexHome" && s.detail === "codex_home_missing"));
    assert.ok(!healthResponse.body.includes(root));
    const page = await get("/");
    assert.equal(page.status, 503);
  });
});
