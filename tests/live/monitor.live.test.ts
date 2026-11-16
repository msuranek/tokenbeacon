/**
 * Opt-in smoke test against a real local Codex installation (CODEX_HOME or
 * ~/.codex). Not part of `npm test` / CI: run with `npm run test:live`.
 * It reads only; it never prints titles, names or paths.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { test } from "node:test";
import { assignByLongestRoot } from "../../src/assignment.ts";
import { contextUsedPercent } from "../../src/metrics.ts";
import { SnapshotService } from "../../src/snapshot-service.ts";
import { LocalDataSource } from "../../src/sources/local-data.ts";
import type { MonitorSnapshot, RawUsage, ThreadView } from "../../src/types.ts";

const localSource = new LocalDataSource();
const available = existsSync(localSource.statePath);

test("live read-only snapshot is complete, normalized and accurate", { skip: !available && "no local Codex data" }, async (t) => {
  const local = localSource.read();
  const service = new SnapshotService(localSource);
  const first = await service.refresh();
  const second = await service.refresh();
  const threads = flattenThreads(first);

  await t.test("all sources are readable with the installed schema", () => {
    for (const source of ["codexHome", "stateDb", "historyDb", "desktopCatalog"]) {
      const entry = first.sourceHealth.find((item) => item.source === source);
      assert.equal(entry?.state, "ok", `${source}: ${entry?.detail}`);
    }
  });

  await t.test("loads all local projects and catalog-visible threads", () => {
    assert.equal(first.projects.length, local.projects.length);
    assert.equal(first.diagnostics.visibleThreadCount, local.threads.length);
    assert.equal(threads.length, local.threads.length);
    assert.equal(new Set(threads.map((thread) => thread.id)).size, threads.length);
  });

  await t.test("every path assignment independently resolves to the reported project", () => {
    const rawById = new Map(local.threads.map((thread) => [thread.id, thread]));
    for (const thread of threads) {
      const raw = rawById.get(thread.id)!;
      if (thread.assignmentSource === "path-fallback") {
        assert.equal(assignByLongestRoot(raw.cwd, local.projects), thread.projectId);
      }
      if (thread.assignmentSource === "unassigned") assert.equal(thread.projectId, null);
    }
  });

  await t.test("latest project thread is ordered by real activity", () => {
    for (const project of first.projects) {
      if (!project.latestThread) continue;
      const all = [project.latestThread, ...project.otherThreads];
      const maximum = all
        .map((thread) => thread.lastActivityAt.value)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1);
      assert.equal(project.latestThread.lastActivityAt.value, maximum);
    }
  });

  await t.test("active rollout token and context values match an independent parser", () => {
    const rawById = new Map(local.threads.map((thread) => [thread.id, thread]));
    const candidates = threads.filter((thread) => {
      const rolloutPath = rawById.get(thread.id)?.rolloutPath;
      return rolloutPath && existsSync(rolloutPath) && !rolloutPath.endsWith(".zst");
    });
    let compared = 0;
    for (const thread of candidates) {
      const raw = rawById.get(thread.id)!;
      const reference = referenceTelemetry(raw.rolloutPath!);
      if (!reference.total || !reference.last || reference.window === null) continue;
      assert.equal(thread.totalTokens.value, reference.total.total_tokens);
      assert.equal(thread.contextTokens.value, reference.last.total_tokens);
      assert.equal(thread.contextWindowTokens.value, reference.window);
      assert.equal(
        thread.contextUsedPercent.value,
        contextUsedPercent(Number(reference.last.total_tokens), reference.window),
      );
      compared += 1;
      if (compared === 5) break;
    }
    assert.ok(compared >= 1 || candidates.length === 0, `only ${compared} active rollouts could be compared`);
  });

  await t.test("compaction projection matches each visible thread", () => {
    assert.ok(local.compactions, "compaction history unavailable");
    for (const thread of threads) {
      assert.equal(thread.compactionCount.value, local.compactions.get(thread.id)?.count ?? 0);
    }
  });

  await t.test("no rollout was rejected by the storage confinement", () => {
    const issues = service.rollouts.lastIssues();
    assert.equal(issues.outsideStorage, 0);
    assert.equal(issues.invalidName, 0);
  });

  await t.test("live snapshot does not expose local paths or rollout locations", () => {
    const json = JSON.stringify(first);
    assert.ok(!json.includes(homedir()), "home directory leaked");
    assert.ok(!json.includes('"rootPaths"'));
    for (const project of local.projects) {
      for (const root of project.rootPaths) if (root) assert.ok(!json.includes(root), "project root path leaked");
    }
    for (const thread of local.threads) {
      if (thread.rolloutPath) assert.ok(!json.includes(thread.rolloutPath), "rollout path leaked");
      if (thread.cwd.length > 1) assert.ok(!json.includes(`"${thread.cwd}"`), "cwd leaked");
    }
  });

  await t.test("unavailable metrics always carry null", () => assertUnavailableIsNull(first));

  await t.test("warm refresh reuses the rollout cache (functional, not timed)", () => {
    assert.ok(second.diagnostics.rolloutCache.hits >= 1);
    assert.equal(second.diagnostics.rolloutCache.decompressions, first.diagnostics.rolloutCache.decompressions);
  });
});

function flattenThreads(snapshot: MonitorSnapshot): ThreadView[] {
  return [
    ...snapshot.projects.flatMap((project) =>
      project.latestThread ? [project.latestThread, ...project.otherThreads] : [],
    ),
    ...snapshot.unassignedThreads,
  ];
}

function referenceTelemetry(filePath: string): { total: RawUsage | null; last: RawUsage | null; window: number | null } {
  let usageRecord: RawUsage | null = null;
  let tokenTotal: RawUsage | null = null;
  let last: RawUsage | null = null;
  let window: number | null = null;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "token_usage_record") usageRecord = record.payload?.thread_token_usage ?? usageRecord;
    if (record.type === "event_msg" && record.payload?.type === "token_count") {
      tokenTotal = record.payload.info?.total_token_usage ?? tokenTotal;
      last = record.payload.info?.last_token_usage ?? last;
      window = record.payload.info?.model_context_window ?? window;
    }
  }
  return { total: usageRecord ?? tokenTotal, last, window };
}

function assertUnavailableIsNull(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("state" in value && "value" in value && (value as { state: unknown }).state === "unavailable") {
    assert.equal((value as { value?: unknown }).value, null);
  }
  for (const child of Object.values(value)) assertUnavailableIsNull(child);
}
