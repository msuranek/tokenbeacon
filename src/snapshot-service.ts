import { performance } from "node:perf_hooks";
import { assignByLongestRoot } from "./assignment.ts";
import { selectLimits } from "./limits.ts";
import { contextUsedPercent, epochToIso, metric, normalizeUsage, unavailable } from "./metrics.ts";
import {
  MAX_PROJECT_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  sanitizeDisplayText,
  threadDeepLink,
} from "./sanitize.ts";
import { LocalDataSource, type LocalProjectRow, type LocalThreadRow } from "./sources/local-data.ts";
import { RolloutCache, type RolloutIssues } from "./sources/rollouts.ts";
import type {
  MetricState,
  MonitorSnapshot,
  ProjectView,
  RolloutTelemetry,
  ThreadView,
} from "./types.ts";

export class SnapshotService {
  readonly localData: LocalDataSource;
  readonly rollouts: RolloutCache;
  private snapshot: MonitorSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<MonitorSnapshot> | null = null;
  private lastError: Error | null = null;

  /** Clock used to decide whether a limit window has ended; injectable for tests. */
  private readonly now: () => number;

  constructor(
    localData = new LocalDataSource(),
    rollouts = new RolloutCache(localData.codexHome),
    now: () => number = Date.now,
  ) {
    this.localData = localData;
    this.rollouts = rollouts;
    this.now = now;
  }

  get current(): MonitorSnapshot | null {
    return this.snapshot;
  }

  get error(): Error | null {
    return this.lastError;
  }

  /** True until the first refresh has finished (successfully or not). */
  get loading(): boolean {
    return this.snapshot === null && this.lastError === null;
  }

  /** Concurrent callers share one in-flight refresh; reads never overlap. */
  refresh(): Promise<MonitorSnapshot> {
    if (!this.inflight) {
      this.inflight = this.refreshNow().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refreshNow(): Promise<MonitorSnapshot> {
    const started = performance.now();
    try {
      const local = this.localData.read();
      const rolloutPaths = local.threads
        .map((thread) => thread.rolloutPath)
        .filter((value): value is string => value !== null);
      const telemetryByPath = await this.rollouts.readMany(rolloutPaths);
      const rolloutIssues = this.rollouts.lastIssues();
      const projectIds = new Set(local.projects.map((project) => project.id));
      const threadViews = local.threads.map((thread) => {
        const assignment = resolveAssignment(thread, local.projects, projectIds);
        return buildThreadView(
          thread,
          assignment.projectId,
          assignment.source,
          thread.rolloutPath ? telemetryByPath.get(thread.rolloutPath) ?? null : null,
          local.compactions ? local.compactions.get(thread.id) ?? { count: 0, lastAtMs: null } : null,
        );
      });
      const projects = buildProjects(local.projects, threadViews);
      const unassignedThreads = threadViews
        .filter((thread) => thread.projectId === null)
        .sort(compareThreads);
      const assignedThreadCount = threadViews.length - unassignedThreads.length;
      const limits = selectLimits(telemetryByPath.values(), this.now());
      const failedRollouts = [...telemetryByPath.values()].filter((value) => value === null).length;
      const threadsWithoutRollout = local.threads.length - rolloutPaths.length;
      const now = new Date().toISOString();
      const refreshDurationMs = Math.round((performance.now() - started) * 100) / 100;

      const next: MonitorSnapshot = {
        generatedAt: now,
        sourceWatermarks: {
          stateDb: local.watermarks.stateDb,
          historyDb: local.watermarks.historyDb,
          desktopDb: local.watermarks.desktopDb,
          rollouts: now,
        },
        limits,
        projects,
        unassignedThreads,
        sourceHealth: [
          { source: "codexHome", ...local.sources.codexHome, observedAt: now },
          { source: "stateDb", ...local.sources.stateDb, observedAt: local.watermarks.stateDb },
          { source: "historyDb", ...local.sources.historyDb, observedAt: local.watermarks.historyDb },
          {
            source: "desktopCatalog",
            ...local.sources.desktopCatalog,
            observedAt: local.watermarks.desktopDb,
          },
          {
            source: "threadVisibility",
            state: local.visibility === "catalog" ? "ok" : local.threads.length > 0 ? "degraded" : "unavailable",
            observedAt: now,
            detail: local.visibility === "catalog" ? null : "heuristic_without_desktop_catalog",
          },
          {
            source: "rollouts",
            state:
              local.threads.length === 0
                ? "unavailable"
                : failedRollouts === 0 && threadsWithoutRollout === 0
                  ? "ok"
                  : "degraded",
            observedAt: now,
            detail: local.threads.length === 0 ? "no_threads" : describeRolloutIssues(rolloutIssues, threadsWithoutRollout),
          },
          {
            source: "appServer",
            state: "unavailable",
            observedAt: null,
            detail: "Desktop App Server uses non-reconnectable stdio transport",
          },
        ],
        diagnostics: {
          visibleThreadCount: threadViews.length,
          assignedThreadCount,
          unassignedThreadCount: unassignedThreads.length,
          refreshDurationMs,
          rolloutCache: this.rollouts.stats(),
        },
      };
      // Publish only after every source has completed, so readers see an atomic snapshot.
      this.snapshot = next;
      this.lastError = null;
      return next;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw this.lastError;
    }
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.inflight) void this.refresh().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function resolveAssignment(
  thread: LocalThreadRow,
  projects: LocalProjectRow[],
  projectIds: Set<string>,
): {
  projectId: string | null;
  source: ThreadView["assignmentSource"];
} {
  if (thread.projectId && projectIds.has(thread.projectId)) {
    return { projectId: thread.projectId, source: "state-db" };
  }
  if (thread.catalogProjectId && projectIds.has(thread.catalogProjectId)) {
    return { projectId: thread.catalogProjectId, source: "desktop-catalog" };
  }
  const pathProject = assignByLongestRoot(thread.cwd, projects);
  return pathProject
    ? { projectId: pathProject, source: "path-fallback" }
    : { projectId: null, source: "unassigned" };
}

function buildThreadView(
  thread: LocalThreadRow,
  projectId: string | null,
  assignmentSource: ThreadView["assignmentSource"],
  telemetry: RolloutTelemetry | null,
  compaction: { count: number; lastAtMs: number | null } | null,
): ThreadView {
  const observedAt = telemetry?.tokenObservedAt ?? null;
  const contextObservedAt = telemetry?.contextObservedAt ?? observedAt;
  // Current only if nothing that can change the value was recorded after it.
  const tokenState = measurementState(telemetry, observedAt, telemetry?.contextChangedAt ?? null);
  const contextState = measurementState(telemetry, contextObservedAt, telemetry?.contextChangedAt ?? null);
  const settingsState = measurementState(telemetry, telemetry?.modelObservedAt ?? null, telemetry?.settingsChangedAt ?? null);
  const rolloutSource = telemetry?.sourceKind ?? "rollout";
  const usage = normalizeUsage(telemetry?.usageRecord ?? telemetry?.tokenCountTotal ?? null);
  const lastContextTokens = telemetry?.lastTokenUsage?.total_tokens;
  const contextWindow = telemetry?.modelContextWindow;
  const hasContext = Number.isFinite(lastContextTokens) && Number.isFinite(contextWindow);
  const modelValue = telemetry?.model ?? thread.model;
  const modelState: MetricState = telemetry?.model
    ? settingsState
    : thread.model
      ? "last-known"
      : "unavailable";
  const modelSource = telemetry?.model ? rolloutSource : "stateDb";
  const effortValue = telemetry?.reasoningEffort ?? thread.reasoningEffort;
  const effortState: MetricState = telemetry?.reasoningEffort
    ? settingsState
    : thread.reasoningEffort
      ? "last-known"
      : "unavailable";
  const activity = lastActivity(thread, telemetry);
  const activityAt = activity.at;
  const totalFallback = !usage && thread.tokensUsed > 0 ? thread.tokensUsed : null;

  const deepLink = threadDeepLink(thread.id);

  return {
    id: thread.id,
    title: sanitizeDisplayText(thread.title, MAX_TITLE_LENGTH, "Untitled"),
    projectId,
    assignmentSource,
    model: metric(modelValue, modelState, telemetry?.modelObservedAt ?? activityAt, modelSource),
    reasoningEffort: metric(
      effortValue,
      effortState,
      telemetry?.modelObservedAt ?? activityAt,
      telemetry?.reasoningEffort ? rolloutSource : "stateDb",
    ),
    contextUsedPercent: hasContext
      ? metric(
          contextUsedPercent(Number(lastContextTokens), Number(contextWindow)),
          contextState,
          contextObservedAt,
          rolloutSource,
        )
      : unavailable(),
    contextTokens: metric(
      hasContext ? Number(lastContextTokens) : null,
      contextState,
      contextObservedAt,
      rolloutSource,
    ),
    contextWindowTokens: metric(
      typeof contextWindow === "number" ? contextWindow : null,
      contextState,
      contextObservedAt,
      rolloutSource,
    ),
    inputTokens: metric(usage?.inputTokens, tokenState, observedAt, rolloutSource),
    cachedInputTokens: metric(usage?.cachedInputTokens, tokenState, observedAt, rolloutSource),
    outputTokens: metric(usage?.outputTokens, tokenState, observedAt, rolloutSource),
    reasoningOutputTokens: metric(
      usage?.reasoningOutputTokens,
      tokenState,
      observedAt,
      rolloutSource,
    ),
    totalTokens: usage
      ? metric(usage.totalTokens, tokenState, observedAt, rolloutSource)
      : metric(totalFallback, "last-known", activityAt, "stateDb"),
    compactionCount: compaction
      ? metric(compaction.count, "current", localObservationTime(), "historyDb")
      : unavailable(),
    lastCompactionAt:
      compaction === null || compaction.lastAtMs === null
        ? unavailable()
        : metric(epochToIso(compaction.lastAtMs), "current", localObservationTime(), "historyDb"),
    lastActivityAt: metric(activityAt, activity.state, localObservationTime(), activity.source),
    status: unavailable(),
    openTarget: deepLink ? metric(deepLink, "current", null, "deep-link") : unavailable(),
  };
}

/**
 * When the thread last had actual work (P-033): the latest of the start of its
 * last turn (recency_at, the same in the desktop catalog) and the last work
 * event in its rollout. updated_at is not used, because opening a thread or
 * changing its settings (and other metadata changes) moves it. Only when
 * neither is known – an older database without recency and no readable
 * rollout – updated_at is the fallback, marked last-known.
 */
export function lastActivity(
  thread: Pick<LocalThreadRow, "recencyAtMs" | "catalogRecencyAtMs" | "updatedAtMs">,
  telemetry: Pick<RolloutTelemetry, "lastWorkAt"> | null,
): { at: string | null; state: MetricState; source: string } {
  const workMs = telemetry?.lastWorkAt ? Date.parse(telemetry.lastWorkAt) : Number.NaN;
  const recencyMs = Math.max(thread.recencyAtMs || 0, thread.catalogRecencyAtMs || 0);
  const best = Math.max(recencyMs, Number.isFinite(workMs) ? workMs : 0);
  if (best > 0) return { at: epochToIso(best), state: "current", source: "stateDb+desktopCatalog+rollout" };
  if (thread.updatedAtMs > 0) return { at: epochToIso(thread.updatedAtMs), state: "last-known", source: "stateDb.updated_at" };
  return { at: null, state: "unavailable", source: "stateDb" };
}

/**
 * Whether a value read from a rollout still describes the thread (D-011):
 * "current" only for a plain, still-written rollout and only if no event that
 * can change the value was recorded after it (a turn started, the settings or
 * model changed, the context was compacted). Based on the rollout's own event
 * times, never on the wall clock; nothing is estimated. Compressed (archived)
 * rollouts stay "last-known".
 */
export function measurementState(
  telemetry: RolloutTelemetry | null,
  observedAt: string | null,
  changedAt: string | null,
): MetricState {
  if (!telemetry || telemetry.sourceKind !== "jsonl") return "last-known";
  const measured = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (!Number.isFinite(measured)) return "last-known";
  const changed = changedAt ? Date.parse(changedAt) : Number.NaN;
  return Number.isFinite(changed) && changed > measured ? "last-known" : "current";
}

function buildProjects(projectRows: LocalProjectRow[], threads: ThreadView[]): ProjectView[] {
  const byProject = new Map<string, ThreadView[]>();
  for (const thread of threads) {
    if (!thread.projectId) continue;
    const bucket = byProject.get(thread.projectId) ?? [];
    bucket.push(thread);
    byProject.set(thread.projectId, bucket);
  }
  return projectRows
    .map((project) => {
      const projectThreads = (byProject.get(project.id) ?? []).sort(compareThreads);
      return {
        id: project.id,
        // Root paths are used only for server-side assignment and are never
        // sent to the browser.
        name: sanitizeDisplayText(project.name, MAX_PROJECT_NAME_LENGTH, "Untitled project"),
        latestThread: projectThreads[0] ?? null,
        otherThreads: projectThreads.slice(1),
        lastActivityAt: projectThreads[0]?.lastActivityAt.value ?? epochToIso(project.updatedAtMs),
      };
    })
    .sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));
}

function compareThreads(left: ThreadView, right: ThreadView): number {
  return (right.lastActivityAt.value ?? "").localeCompare(left.lastActivityAt.value ?? "");
}

function describeRolloutIssues(issues: RolloutIssues, withoutPath: number): string | null {
  const parts = Object.entries({ ...issues, noPath: withoutPath })
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}:${count}`);
  return parts.length ? parts.join(",") : null;
}

function localObservationTime(): string {
  return new Date().toISOString();
}
