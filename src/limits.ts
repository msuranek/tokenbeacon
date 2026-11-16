import { epochToIso, metric, unavailable } from "./metrics.ts";
import type {
  LimitKind,
  LimitWindow,
  MonitorSnapshot,
  RecordedLimitWindow,
  RolloutTelemetry,
} from "./types.ts";

/**
 * Account rate limits recorded by Codex in rollout `token_count` events.
 *
 * - Codex reports several limit buckets (`limit_id`), e.g. "codex" and
 *   "premium". The 5-hour and weekly account limits come from "codex"; older
 *   records without a limit_id are the same bucket ("legacy codex").
 * - Each window (5-hour, weekly) is tracked on its own. A record without a
 *   valid window never replaces the last valid one.
 * - A window whose resetsAt has passed is "expired": the percentage from the
 *   previous window is not reported, because the new window's usage is
 *   unknown until Codex records it. Nothing is estimated.
 */

export const MAIN_LIMIT_BUCKET = "codex";

const WINDOW_KINDS: Record<number, LimitKind> = { 300: "fiveHour", 10_080: "weekly" };

export function limitBucket(limitId: unknown): string {
  return typeof limitId === "string" && limitId.trim() ? limitId.trim() : MAIN_LIMIT_BUCKET;
}

export function parseRecordedWindow(
  value: unknown,
  observedAt: string | null,
): (RecordedLimitWindow & { kind: LimitKind }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const usedRaw = raw.used_percent ?? raw.usedPercent;
  const minutesRaw = raw.window_minutes ?? raw.windowDurationMins;
  if (typeof usedRaw !== "number" || typeof minutesRaw !== "number") return null;
  if (!Number.isFinite(usedRaw) || !Number.isFinite(minutesRaw) || usedRaw < 0) return null;
  const kind = WINDOW_KINDS[minutesRaw];
  if (!kind) return null;
  return {
    kind,
    usedPercent: usedRaw,
    windowMinutes: minutesRaw,
    resetsAt: epochToIso(raw.resets_at ?? raw.resetsAt),
    observedAt,
  };
}

/** Merges one `rate_limits` payload into the per-bucket, per-window state. */
export function recordRateLimits(
  target: RolloutTelemetry["rateLimitsByBucket"],
  rateLimits: unknown,
  observedAt: string | null,
): void {
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) return;
  const raw = rateLimits as Record<string, unknown>;
  const bucket = limitBucket(raw.limit_id);
  for (const candidate of [raw.primary, raw.secondary]) {
    const window = parseRecordedWindow(candidate, observedAt);
    if (!window) continue;
    const windows = (target[bucket] ??= {});
    const existing = windows[window.kind];
    if (!existing || timeOf(window.observedAt) >= timeOf(existing.observedAt)) {
      const { kind, ...recorded } = window;
      windows[kind] = recorded;
    }
  }
}

/** Picks the newest recorded "codex" window of each kind and evaluates expiry at `now`. */
export function selectLimits(
  telemetries: Iterable<RolloutTelemetry | null>,
  now: number,
): MonitorSnapshot["limits"] {
  const newest: Partial<Record<LimitKind, { window: RecordedLimitWindow; source: string }>> = {};
  for (const telemetry of telemetries) {
    const windows = telemetry?.rateLimitsByBucket[MAIN_LIMIT_BUCKET];
    if (!windows) continue;
    for (const kind of ["fiveHour", "weekly"] as const) {
      const window = windows[kind];
      if (!window) continue;
      const current = newest[kind];
      if (!current || timeOf(window.observedAt) > timeOf(current.window.observedAt)) {
        newest[kind] = { window, source: telemetry.sourceKind };
      }
    }
  }
  return {
    fiveHour: evaluate(newest.fiveHour, now),
    weekly: evaluate(newest.weekly, now),
  };
}

function evaluate(
  entry: { window: RecordedLimitWindow; source: string } | undefined,
  now: number,
): MonitorSnapshot["limits"]["fiveHour"] {
  if (!entry) return unavailable();
  const { window, source } = entry;
  const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const expired = Number.isFinite(resetsAtMs) && resetsAtMs <= now;
  const value: LimitWindow = {
    usedPercent: expired ? null : window.usedPercent,
    windowMinutes: window.windowMinutes,
    resetsAt: window.resetsAt,
    status: expired ? "expired" : "active",
  };
  return metric(value, "last-known", window.observedAt, source);
}

function timeOf(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
