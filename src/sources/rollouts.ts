import { createReadStream, promises as fs, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { recordRateLimits } from "../limits.ts";
import type { RawUsage, RolloutTelemetry } from "../types.ts";

interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  offset: number;
  carry: string;
  telemetry: RolloutTelemetry;
}

export interface RolloutCacheStats {
  entries: number;
  hits: number;
  misses: number;
  decompressions: number;
}

/** Why the last refresh could not read some rollouts (counts only, no paths). */
export interface RolloutIssues {
  missing: number;
  outsideStorage: number;
  invalidName: number;
  zstdMissing: number;
  failed: number;
}

/** Rollouts live only in these directories below the Codex home. */
export const ROLLOUT_DIRECTORIES = ["sessions", "archived_sessions"] as const;
const ROLLOUT_FILE_NAME = /^rollout-[^/\\]+\.jsonl(\.zst)?$/;

type Resolution =
  | { kind: "ok"; path: string }
  | { kind: "missing" | "outsideStorage" | "invalidName" };

class RolloutReadError extends Error {
  readonly reason: keyof RolloutIssues;

  constructor(reason: keyof RolloutIssues) {
    super(reason);
    this.reason = reason;
  }
}

export class RolloutCache {
  readonly codexHome: string;
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private decompressions = 0;
  private issues: RolloutIssues = emptyIssues();

  /**
   * @param codexHome Rollout paths come from the database; they are only read
   * when they resolve (after following symlinks) to a regular `rollout-*.jsonl`
   * or `rollout-*.jsonl.zst` file inside one of ROLLOUT_DIRECTORIES.
   */
  constructor(codexHome: string) {
    this.codexHome = path.resolve(codexHome);
  }

  lastIssues(): RolloutIssues {
    return { ...this.issues };
  }

  async readMany(
    rolloutPaths: string[],
    concurrency = 12,
  ): Promise<Map<string, RolloutTelemetry | null>> {
    const unique = [...new Set(rolloutPaths)];
    const issues = emptyIssues();
    const output = new Map<string, RolloutTelemetry | null>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
      while (cursor < unique.length) {
        const index = cursor++;
        const requestedPath = unique[index];
        try {
          output.set(requestedPath, await this.read(requestedPath));
        } catch (error) {
          issues[error instanceof RolloutReadError ? error.reason : "failed"] += 1;
          output.set(requestedPath, null);
        }
      }
    });
    await Promise.all(workers);
    this.issues = issues;
    return output;
  }

  stats(): RolloutCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      decompressions: this.decompressions,
    };
  }

  private async read(requestedPath: string): Promise<RolloutTelemetry | null> {
    const resolution = resolveRolloutPath(this.codexHome, requestedPath);
    if (resolution.kind !== "ok") throw new RolloutReadError(resolution.kind);
    const resolvedPath = resolution.path;
    const info = await fs.stat(resolvedPath);
    const cached = this.entries.get(resolvedPath);
    const compressed = resolvedPath.endsWith(".zst");

    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      this.hits += 1;
      return cached.telemetry;
    }

    this.misses += 1;
    if (compressed) {
      this.decompressions += 1;
      const telemetry = emptyTelemetry("jsonl.zst");
      await parseZstdLines(resolvedPath, (line) => applyLine(telemetry, line));
      this.entries.set(resolvedPath, {
        path: resolvedPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: info.size,
        carry: "",
        telemetry,
      });
      return telemetry;
    }

    const canContinue =
      cached !== undefined &&
      !cached.path.endsWith(".zst") &&
      info.size >= cached.offset &&
      info.mtimeMs >= cached.mtimeMs &&
      info.size > cached.size;
    const telemetry = canContinue ? cached.telemetry : emptyTelemetry("jsonl");
    const start = canContinue ? cached.offset : 0;
    const prefix = canContinue ? cached.carry : "";
    const carry = await parseJsonlRange(resolvedPath, start, prefix, (line) =>
      applyLine(telemetry, line),
    );
    this.entries.set(resolvedPath, {
      path: resolvedPath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: info.size,
      carry,
      telemetry,
    });
    return telemetry;
  }
}

function emptyIssues(): RolloutIssues {
  return { missing: 0, outsideStorage: 0, invalidName: 0, zstdMissing: 0, failed: 0 };
}

/**
 * Confines a database-provided rollout path to the Codex rollout storage.
 *
 * The path (relative paths are resolved against the Codex home) is resolved
 * with realpath, which removes `..` segments and follows every symlink,
 * including the file itself. Only a regular `rollout-*.jsonl[.zst]` file whose
 * real location lies inside the real location of one of ROLLOUT_DIRECTORIES is
 * accepted. Returns the real path, which is what gets opened.
 */
export function resolveRolloutPath(codexHome: string, requestedPath: string): Resolution {
  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
    return { kind: "invalidName" };
  }
  const home = path.resolve(codexHome);
  const requested = path.resolve(home, requestedPath);
  const realRoots = ROLLOUT_DIRECTORIES.flatMap((directory) => {
    try {
      return [realpathSync(path.join(home, directory))];
    } catch {
      return [];
    }
  });
  const candidates = requested.endsWith(".zst") ? [requested] : [requested, `${requested}.zst`];
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue; // Missing (or dangling symlink); try the compressed variant.
    }
    if (!realRoots.some((root) => isInside(root, real))) return { kind: "outsideStorage" };
    if (!ROLLOUT_FILE_NAME.test(path.basename(real))) return { kind: "invalidName" };
    try {
      if (!statSync(real).isFile()) return { kind: "invalidName" };
    } catch {
      continue;
    }
    return { kind: "ok", path: real };
  }
  return { kind: "missing" };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function emptyTelemetry(sourceKind: "jsonl" | "jsonl.zst"): RolloutTelemetry {
  return {
    model: null,
    modelObservedAt: null,
    reasoningEffort: null,
    usageRecord: null,
    tokenCountTotal: null,
    lastTokenUsage: null,
    modelContextWindow: null,
    tokenObservedAt: null,
    rateLimitsByBucket: {},
    sourceKind,
  };
}

async function parseJsonlRange(
  filePath: string,
  start: number,
  prefix: string,
  onLine: (line: string) => void,
): Promise<string> {
  if ((await fs.stat(filePath)).size === start) return prefix;
  const stream = createReadStream(filePath, { start, encoding: "utf8" });
  let buffer = prefix;
  for await (const chunk of stream) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  return buffer;
}

async function parseZstdLines(filePath: string, onLine: (line: string) => void): Promise<void> {
  const child = spawn("zstd", ["-q", "-d", "-c", "--", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new RolloutReadError("zstdMissing") : error),
    );
    child.once("close", resolve);
  });
  // Observe the rejection immediately; it is awaited after the output is consumed.
  completion.catch(() => undefined);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) onLine(line);
  }
  const exitCode = await completion;
  if (exitCode !== 0) throw new Error(`zstd failed (${exitCode}): ${stderr.trim()}`);
}

function applyLine(telemetry: RolloutTelemetry, line: string): void {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = record.type;
  const payload = asRecord(record.payload);
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;

  if (type === "turn_context") {
    if (typeof payload.model === "string") telemetry.model = payload.model;
    if (typeof payload.effort === "string") telemetry.reasoningEffort = payload.effort;
    telemetry.modelObservedAt = timestamp;
    return;
  }

  if (type === "token_usage_record") {
    const usage = asUsage(payload.thread_token_usage);
    if (usage) telemetry.usageRecord = usage;
    telemetry.tokenObservedAt = timestamp;
    return;
  }

  if (type === "event_msg" && payload.type === "token_count") {
    const info = asRecord(payload.info);
    const total = asUsage(info.total_token_usage);
    const last = asUsage(info.last_token_usage);
    if (total) telemetry.tokenCountTotal = total;
    if (last) telemetry.lastTokenUsage = last;
    if (typeof info.model_context_window === "number") {
      telemetry.modelContextWindow = info.model_context_window;
    }
    telemetry.tokenObservedAt = timestamp;
    // Per bucket and per window; records without a valid window are ignored.
    recordRateLimits(telemetry.rateLimitsByBucket, payload.rate_limits ?? info.rate_limits, timestamp);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asUsage(value: unknown): RawUsage | null {
  const record = asRecord(value);
  return typeof record.total_tokens === "number" ? (record as RawUsage) : null;
}
