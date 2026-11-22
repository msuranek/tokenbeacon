import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { limitBucket, recordRateLimits, selectLimits } from "../src/limits.ts";
import { SnapshotService } from "../src/snapshot-service.ts";
import { LocalDataSource } from "../src/sources/local-data.ts";
import type { RolloutTelemetry } from "../src/types.ts";
import { createTempRoot } from "./helpers/fixture-codex-home.ts";

// Synthetic data only. All times are fixed; nothing depends on the real clock.
const NOW = Date.UTC(2026, 10, 16, 17, 42, 0); // 17:42 UTC
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => ms / 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function rateLimits(options: {
  limitId?: string | null;
  fiveHour?: { used: number; resetsAt: number } | "empty" | null;
  weekly?: { used: number; resetsAt: number } | "empty" | null;
}) {
  const window = (value: { used: number; resetsAt: number } | "empty" | null | undefined, minutes: number) =>
    value === "empty" ? {} : value ? { used_percent: value.used, window_minutes: minutes, resets_at: sec(value.resetsAt) } : null;
  return {
    limit_id: options.limitId === undefined ? "codex" : options.limitId,
    limit_name: null,
    primary: window(options.fiveHour, 300),
    secondary: window(options.weekly, 10_080),
    credits: null,
    plan_type: "fixture",
  };
}

function telemetry(events: Array<{ at: number; rateLimits: unknown }>, kind: "jsonl" | "jsonl.zst" = "jsonl"): RolloutTelemetry {
  const result: RolloutTelemetry = {
    model: null,
    modelObservedAt: null,
    reasoningEffort: null,
    usageRecord: null,
    tokenCountTotal: null,
    lastTokenUsage: null,
    modelContextWindow: null,
    tokenObservedAt: null,
    contextObservedAt: null,
    contextChangedAt: null,
    settingsChangedAt: null,
    rateLimitsByBucket: {},
    sourceKind: kind,
  };
  for (const event of events) recordRateLimits(result.rateLimitsByBucket, event.rateLimits, iso(event.at));
  return result;
}

describe("limit buckets", () => {
  test("limit_id null or missing is legacy codex", () => {
    assert.equal(limitBucket(null), "codex");
    assert.equal(limitBucket(undefined), "codex");
    assert.equal(limitBucket(""), "codex");
    assert.equal(limitBucket("codex"), "codex");
    assert.equal(limitBucket("premium"), "premium");
  });

  test("legacy limit_id: null records are used as the codex bucket", () => {
    const t = telemetry([
      { at: NOW - HOUR, rateLimits: rateLimits({ limitId: null, fiveHour: { used: 10, resetsAt: NOW + HOUR }, weekly: { used: 2, resetsAt: NOW + DAY } }) },
    ]);
    const limits = selectLimits([t], NOW);
    assert.equal(limits.fiveHour.value?.usedPercent, 10);
    assert.equal(limits.weekly.value?.usedPercent, 2);
  });

  test("a newer codex record replaces an older legacy one", () => {
    const t = telemetry([
      { at: NOW - 2 * HOUR, rateLimits: rateLimits({ limitId: null, fiveHour: { used: 10, resetsAt: NOW + HOUR } }) },
      { at: NOW - HOUR, rateLimits: rateLimits({ limitId: "codex", fiveHour: { used: 33, resetsAt: NOW + HOUR } }) },
    ]);
    assert.equal(selectLimits([t], NOW).fiveHour.value?.usedPercent, 33);
  });

  test("a newer premium record never replaces the codex limits", () => {
    const codex = telemetry([
      { at: NOW - HOUR, rateLimits: rateLimits({ fiveHour: { used: 40, resetsAt: NOW + HOUR }, weekly: { used: 50, resetsAt: NOW + DAY } }) },
    ]);
    const premium = telemetry([
      { at: NOW - MIN, rateLimits: rateLimits({ limitId: "premium", fiveHour: { used: 99, resetsAt: NOW + HOUR }, weekly: { used: 99, resetsAt: NOW + DAY } }) },
      { at: NOW, rateLimits: rateLimits({ limitId: "premium", fiveHour: "empty", weekly: "empty" }) },
    ]);
    const limits = selectLimits([premium, codex], NOW);
    assert.equal(limits.fiveHour.value?.usedPercent, 40);
    assert.equal(limits.weekly.value?.usedPercent, 50);
    assert.equal(limits.fiveHour.observedAt, iso(NOW - HOUR));
  });

  test("an empty premium record in the same file does not hide the codex record", () => {
    const t = telemetry([
      { at: NOW - HOUR, rateLimits: rateLimits({ fiveHour: { used: 40, resetsAt: NOW + HOUR } }) },
      { at: NOW - MIN, rateLimits: rateLimits({ limitId: "premium", fiveHour: "empty", weekly: "empty" }) },
    ]);
    assert.equal(selectLimits([t], NOW).fiveHour.value?.usedPercent, 40);
  });
});

describe("invalid and empty windows", () => {
  test("records without valid windows never replace the last valid snapshot", () => {
    const t = telemetry([
      { at: NOW - HOUR, rateLimits: rateLimits({ fiveHour: { used: 61, resetsAt: NOW + HOUR }, weekly: { used: 12, resetsAt: NOW + DAY } }) },
      { at: NOW - 30 * MIN, rateLimits: rateLimits({ fiveHour: "empty", weekly: "empty" }) },
      { at: NOW - 20 * MIN, rateLimits: rateLimits({ fiveHour: null, weekly: null }) },
      { at: NOW - 10 * MIN, rateLimits: { limit_id: "codex", primary: { used_percent: "97", window_minutes: 300 } } },
      { at: NOW - 5 * MIN, rateLimits: { limit_id: "codex", primary: { used_percent: Number.NaN, window_minutes: 300 } } },
      { at: NOW - 4 * MIN, rateLimits: { limit_id: "codex", primary: { used_percent: 5, window_minutes: 60 } } },
      { at: NOW - 3 * MIN, rateLimits: null },
      { at: NOW - 2 * MIN, rateLimits: "garbage" },
    ]);
    const limits = selectLimits([t], NOW);
    assert.equal(limits.fiveHour.value?.usedPercent, 61);
    assert.equal(limits.weekly.value?.usedPercent, 12);
    assert.equal(limits.fiveHour.observedAt, iso(NOW - HOUR));
  });

  test("no valid record at all is unavailable", () => {
    const t = telemetry([{ at: NOW, rateLimits: rateLimits({ fiveHour: "empty", weekly: "empty" }) }]);
    const limits = selectLimits([t, null], NOW);
    assert.equal(limits.fiveHour.state, "unavailable");
    assert.equal(limits.fiveHour.value, null);
    assert.equal(limits.weekly.state, "unavailable");
  });

  test("each window is tracked on its own", () => {
    const t = telemetry([
      { at: NOW - HOUR, rateLimits: rateLimits({ fiveHour: { used: 30, resetsAt: NOW + HOUR }, weekly: { used: 20, resetsAt: NOW + DAY } }) },
      { at: NOW - MIN, rateLimits: rateLimits({ fiveHour: null, weekly: { used: 21, resetsAt: NOW + DAY } }) },
    ]);
    const limits = selectLimits([t], NOW);
    assert.equal(limits.fiveHour.value?.usedPercent, 30);
    assert.equal(limits.fiveHour.observedAt, iso(NOW - HOUR));
    assert.equal(limits.weekly.value?.usedPercent, 21);
    assert.equal(limits.weekly.observedAt, iso(NOW - MIN));
  });
});

describe("expired windows", () => {
  // The real case: recorded 15:00 UTC with 97%/90%, 5-hour window ended 16:34 UTC.
  const recordedAt = Date.UTC(2026, 10, 16, 15, 0, 5);
  const fiveHourReset = Date.UTC(2026, 10, 16, 16, 34, 15);
  const weeklyReset = Date.UTC(2026, 10, 19, 10, 35, 46);
  const real = () =>
    telemetry([
      {
        at: recordedAt,
        rateLimits: rateLimits({ fiveHour: { used: 97, resetsAt: fiveHourReset }, weekly: { used: 90, resetsAt: weeklyReset } }),
      },
    ]);

  test("expired 5-hour window: no historical percentage, times kept", () => {
    const limits = selectLimits([real()], NOW);
    assert.equal(limits.fiveHour.value?.status, "expired");
    assert.equal(limits.fiveHour.value?.usedPercent, null, "the previous window's 97% must not be reported");
    assert.equal(limits.fiveHour.value?.resetsAt, iso(fiveHourReset));
    assert.equal(limits.fiveHour.observedAt, iso(recordedAt));
    assert.equal(limits.fiveHour.state, "last-known");
    // Nothing estimated: no 0% used / 100% left anywhere.
    assert.ok(!JSON.stringify(limits.fiveHour).includes('"usedPercent":0'));
  });

  test("the weekly window is evaluated separately and stays active", () => {
    const limits = selectLimits([real()], NOW);
    assert.equal(limits.weekly.value?.status, "active");
    assert.equal(limits.weekly.value?.usedPercent, 90);
  });

  test("before the reset the 5-hour window is active", () => {
    const limits = selectLimits([real()], fiveHourReset - 1);
    assert.equal(limits.fiveHour.value?.status, "active");
    assert.equal(limits.fiveHour.value?.usedPercent, 97);
  });

  test("exactly at resetsAt the window counts as expired", () => {
    assert.equal(selectLimits([real()], fiveHourReset).fiveHour.value?.status, "expired");
  });

  test("expired weekly window", () => {
    const limits = selectLimits([real()], weeklyReset + MIN);
    assert.equal(limits.weekly.value?.status, "expired");
    assert.equal(limits.weekly.value?.usedPercent, null);
    assert.equal(limits.weekly.observedAt, iso(recordedAt));
  });

  test("a window without resetsAt is never declared expired", () => {
    const t = telemetry([{ at: NOW - DAY, rateLimits: { limit_id: "codex", primary: { used_percent: 5, window_minutes: 300 } } }]);
    const limits = selectLimits([t], NOW);
    assert.equal(limits.fiveHour.value?.status, "active");
    assert.equal(limits.fiveHour.value?.resetsAt, null);
  });
});

describe("transition between two windows", () => {
  const oldReset = NOW - 30 * MIN;
  const newReset = NOW + 4.5 * HOUR;

  test("a new record in the next window restores the normal percentage", () => {
    const old = telemetry([{ at: NOW - 2 * HOUR, rateLimits: rateLimits({ fiveHour: { used: 97, resetsAt: oldReset } }) }]);
    assert.equal(selectLimits([old], NOW).fiveHour.value?.status, "expired");

    // A different thread records the new window after the reset.
    const fresh = telemetry([{ at: NOW - 5 * MIN, rateLimits: rateLimits({ fiveHour: { used: 3, resetsAt: newReset } }) }]);
    const limits = selectLimits([old, fresh], NOW);
    assert.equal(limits.fiveHour.value?.status, "active");
    assert.equal(limits.fiveHour.value?.usedPercent, 3);
    assert.equal(limits.fiveHour.value?.resetsAt, iso(newReset));
    assert.equal(limits.fiveHour.observedAt, iso(NOW - 5 * MIN));
  });

  test("the same thread continuing into the next window", () => {
    const t = telemetry([
      { at: NOW - 2 * HOUR, rateLimits: rateLimits({ fiveHour: { used: 97, resetsAt: oldReset } }) },
      { at: NOW - MIN, rateLimits: rateLimits({ fiveHour: { used: 1, resetsAt: newReset } }) },
    ]);
    const limits = selectLimits([t], NOW);
    assert.equal(limits.fiveHour.value?.status, "active");
    assert.equal(limits.fiveHour.value?.usedPercent, 1);
  });

  test("selection does not depend on the order of rollout files", () => {
    const a = telemetry([{ at: NOW - 2 * HOUR, rateLimits: rateLimits({ fiveHour: { used: 97, resetsAt: oldReset } }) }], "jsonl.zst");
    const b = telemetry([{ at: NOW - 5 * MIN, rateLimits: rateLimits({ fiveHour: { used: 3, resetsAt: newReset } }) }]);
    assert.deepEqual(selectLimits([a, b], NOW), selectLimits([b, a], NOW));
    assert.equal(selectLimits([b, a], NOW).fiveHour.source, "jsonl");
  });
});

describe("limits end to end from rollout files", () => {
  test("parser + snapshot: premium, empty and legacy records, expired 5-hour window", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const sessions = path.join(root, "sessions", "2026", "11", "16");
    mkdirSync(sessions, { recursive: true });
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path.join(root, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, updated_at_ms INTEGER, archived INTEGER)");
    const rollout = path.join(sessions, "rollout-limits.jsonl");
    db.prepare("INSERT INTO threads VALUES (?, ?, 'Limits', ?, 0)").run("aaaaaaaa-0000-4000-8000-0000000000aa", rollout, NOW);
    db.close();

    const line = (at: number, rl: unknown) =>
      JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rl } });
    writeFileSync(
      rollout,
      [
        line(NOW - 5 * HOUR, rateLimits({ limitId: null, fiveHour: { used: 10, resetsAt: NOW - 3 * HOUR }, weekly: { used: 80, resetsAt: NOW + DAY } })),
        line(NOW - 3 * HOUR, rateLimits({ fiveHour: { used: 97, resetsAt: NOW - HOUR }, weekly: { used: 90, resetsAt: NOW + DAY } })),
        line(NOW - 2 * HOUR, rateLimits({ limitId: "premium", fiveHour: "empty", weekly: "empty" })),
        line(NOW - HOUR, rateLimits({ fiveHour: "empty", weekly: "empty" })),
      ].join("\n") + "\n",
    );

    // One service for both refreshes, so the incremental (appended) rollout read is exercised.
    const service = new SnapshotService(new LocalDataSource(root), undefined, () => NOW);
    const snapshot = await service.refresh();
    assert.equal(snapshot.limits.fiveHour.value?.status, "expired");
    assert.equal(snapshot.limits.fiveHour.value?.usedPercent, null);
    assert.equal(snapshot.limits.fiveHour.observedAt, iso(NOW - 3 * HOUR));
    assert.equal(snapshot.limits.weekly.value?.status, "active");
    assert.equal(snapshot.limits.weekly.value?.usedPercent, 90);
    assert.equal(snapshot.limits.weekly.observedAt, iso(NOW - 3 * HOUR));

    // Codex records the new window: the next refresh shows a normal percentage again.
    writeFileSync(
      rollout,
      line(NOW - MIN, rateLimits({ fiveHour: { used: 2, resetsAt: NOW + 4 * HOUR }, weekly: { used: 91, resetsAt: NOW + DAY } })) + "\n",
      { flag: "a" },
    );
    const next = await service.refresh();
    assert.equal(next.limits.fiveHour.value?.status, "active");
    assert.equal(next.limits.fiveHour.value?.usedPercent, 2);
    assert.equal(next.limits.weekly.value?.usedPercent, 91);
  });
});
