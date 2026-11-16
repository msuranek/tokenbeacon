import type { MetricState, MetricValue, RawUsage, TokenUsage } from "./types.ts";

export const BASELINE_TOKENS = 12_000;

export function unavailable<T>(): MetricValue<T> {
  return { value: null, state: "unavailable", observedAt: null, source: null };
}

export function metric<T>(
  value: T | null | undefined,
  state: MetricState,
  observedAt: string | null,
  source: string,
): MetricValue<T> {
  if (value === null || value === undefined) return unavailable<T>();
  return { value, state, observedAt, source };
}

export function contextUsedPercent(lastTokens: number, contextWindow: number): number {
  if (contextWindow <= BASELINE_TOKENS) return 100;
  const effectiveWindow = contextWindow - BASELINE_TOKENS;
  const used = Math.max(lastTokens - BASELINE_TOKENS, 0);
  const remaining = Math.max(effectiveWindow - used, 0);
  const remainingPercent = Math.round((remaining / effectiveWindow) * 100);
  return Math.max(0, Math.min(100, 100 - remainingPercent));
}

export function normalizeUsage(raw: RawUsage | null): TokenUsage | null {
  if (!raw || !Number.isFinite(raw.total_tokens)) return null;
  return {
    inputTokens: finiteOrNull(raw.input_tokens),
    cachedInputTokens: finiteOrNull(raw.cached_input_tokens),
    cacheWriteInputTokens: finiteOrNull(raw.cache_write_input_tokens),
    outputTokens: finiteOrNull(raw.output_tokens),
    reasoningOutputTokens: finiteOrNull(raw.reasoning_output_tokens),
    totalTokens: Number(raw.total_tokens),
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function epochToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).toISOString();
}
