export type MetricState = "current" | "last-known" | "unavailable";

export interface MetricValue<T> {
  value: T | null;
  state: MetricState;
  observedAt: string | null;
  source: string | null;
}

export interface TokenUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number;
}

export type LimitWindowStatus = "active" | "expired";

export interface LimitWindow {
  /**
   * Share of the window's limit used, as recorded by Codex. null when the
   * window has expired: the previous window's usage must not be shown as current.
   */
  usedPercent: number | null;
  windowMinutes: number;
  resetsAt: string | null;
  /** "expired": resetsAt has passed and Codex has not recorded the new window yet. */
  status: LimitWindowStatus;
}

export type LimitKind = "fiveHour" | "weekly";

/** One limit window as recorded in a rollout, before expiry is evaluated. */
export interface RecordedLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string | null;
  observedAt: string | null;
}

export interface ThreadView {
  id: string;
  title: string;
  projectId: string | null;
  assignmentSource: "state-db" | "desktop-catalog" | "path-fallback" | "unassigned";
  model: MetricValue<string>;
  reasoningEffort: MetricValue<string>;
  contextUsedPercent: MetricValue<number>;
  contextTokens: MetricValue<number>;
  contextWindowTokens: MetricValue<number>;
  inputTokens: MetricValue<number>;
  cachedInputTokens: MetricValue<number>;
  outputTokens: MetricValue<number>;
  reasoningOutputTokens: MetricValue<number>;
  totalTokens: MetricValue<number>;
  compactionCount: MetricValue<number>;
  lastCompactionAt: MetricValue<string>;
  lastActivityAt: MetricValue<string>;
  status: MetricValue<string>;
  openTarget: MetricValue<string>;
}

export interface ProjectView {
  id: string;
  name: string;
  latestThread: ThreadView | null;
  otherThreads: ThreadView[];
  lastActivityAt: string | null;
}

export interface SourceHealth {
  source: string;
  state: "ok" | "degraded" | "unavailable";
  observedAt: string | null;
  detail: string | null;
}

export interface MonitorSnapshot {
  generatedAt: string;
  sourceWatermarks: Record<string, string | null>;
  limits: {
    fiveHour: MetricValue<LimitWindow>;
    weekly: MetricValue<LimitWindow>;
  };
  projects: ProjectView[];
  unassignedThreads: ThreadView[];
  sourceHealth: SourceHealth[];
  diagnostics: {
    visibleThreadCount: number;
    assignedThreadCount: number;
    unassignedThreadCount: number;
    refreshDurationMs: number;
    rolloutCache: {
      entries: number;
      hits: number;
      misses: number;
      decompressions: number;
    };
  };
}

export interface RawUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface RolloutTelemetry {
  model: string | null;
  modelObservedAt: string | null;
  reasoningEffort: string | null;
  usageRecord: RawUsage | null;
  tokenCountTotal: RawUsage | null;
  lastTokenUsage: RawUsage | null;
  modelContextWindow: number | null;
  tokenObservedAt: string | null;
  /** Latest valid window per limit bucket (limit_id) and window kind. */
  rateLimitsByBucket: Record<string, Partial<Record<LimitKind, RecordedLimitWindow>>>;
  sourceKind: "jsonl" | "jsonl.zst";
}
