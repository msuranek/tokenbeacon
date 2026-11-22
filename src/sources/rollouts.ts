import { createReadStream, promises as fs, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createZstdDecompress } from "node:zlib";
import { recordRateLimits } from "../limits.ts";
import { currentPlatform, isInsidePath, normalizeWin32Path, pathApi, type PathPlatform } from "../paths.ts";
import type { RawUsage, RolloutTelemetry } from "../types.ts";

interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  offset: number;
  carry: string;
  /** The read stopped inside an over-long line; skip until its newline. */
  skipping: boolean;
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
  failed: number;
}

/** Rollouts live only in these directories below the Codex home. */
export const ROLLOUT_DIRECTORIES = ["sessions", "archived_sessions"] as const;
// No separators and no ":" (a Windows drive or NTFS alternate data stream).
const ROLLOUT_FILE_NAME = /^rollout-[^/\\:]+\.jsonl(\.zst)?$/;

/**
 * Lines longer than this are skipped without being kept in memory. Codex
 * writes token counts on short lines; the longest real line seen (an embedded
 * image) was about 15 MB.
 */
export const MAX_LINE_CHARS = 64 * 1024 * 1024;

/**
 * A compressed rollout that expands beyond this is not read further and counts
 * as failed (protection against decompression bombs). The largest real
 * rollout seen was about 110 MB uncompressed.
 */
export const MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;

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
        skipping: false,
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
    const splitter = new LineSplitter((line) => applyLine(telemetry, line));
    if (canContinue) splitter.restore(cached.carry, cached.skipping);
    await parseJsonlRange(resolvedPath, start, splitter);
    this.entries.set(resolvedPath, {
      path: resolvedPath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: info.size,
      carry: splitter.carry,
      skipping: splitter.skipping,
      telemetry,
    });
    return telemetry;
  }
}

function emptyIssues(): RolloutIssues {
  return { missing: 0, outsideStorage: 0, invalidName: 0, failed: 0 };
}

export interface ResolveOptions {
  platform?: PathPlatform;
  /** Defaults to the OS realpath (`realpathSync.native` on Windows). */
  realpath?: (value: string) => string;
  isFile?: (value: string) => boolean;
}

/**
 * Confines a database-provided rollout path to the Codex rollout storage.
 *
 * On Windows the path is first normalized: an extended-length `\\?\` prefix
 * is removed, and device or volume namespace paths (`\\.\…`, `\\?\GLOBALROOT…`)
 * are refused. The path (relative paths are resolved against the Codex home) is
 * then resolved with realpath, which removes `..` segments and follows every
 * symlink or junction, including the file itself. Only a regular
 * `rollout-*.jsonl[.zst]` file whose real location lies inside the real
 * location of one of ROLLOUT_DIRECTORIES is accepted; on Windows the
 * comparison ignores letter case. Returns the real path, which is what gets
 * opened.
 */
export function resolveRolloutPath(
  codexHome: string,
  requestedPath: string,
  options: ResolveOptions = {},
): Resolution {
  const platform = options.platform ?? currentPlatform();
  const api = pathApi(platform);
  const realpath = options.realpath ?? (platform === "win32" ? realpathSync.native : realpathSync);
  const isFile = options.isFile ?? ((value: string) => statSync(value).isFile());

  if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
    return { kind: "invalidName" };
  }
  const home = api.resolve(codexHome);
  // On Windows, namespace prefixes are stripped (or refused) before relative
  // paths are resolved against the Codex home.
  // Drive-relative (`C:file`) and rooted (`\file`) Windows paths depend on
  // per-process state and are refused outright.
  if (platform === "win32" && /^(?:[A-Za-z]:(?![\\/])|[\\/](?![\\/]))/.test(requestedPath)) {
    return { kind: "outsideStorage" };
  }
  const absolute =
    platform === "win32"
      ? api.isAbsolute(requestedPath)
        ? normalizeWin32Path(requestedPath)
        : normalizeWin32Path(api.resolve(home, requestedPath))
      : api.resolve(home, requestedPath);
  if (absolute === null) return { kind: "outsideStorage" };
  const requested = absolute;
  const realRoots = ROLLOUT_DIRECTORIES.flatMap((directory) => {
    try {
      return [realpath(api.join(home, directory))];
    } catch {
      return [];
    }
  });
  const candidates = requested.endsWith(".zst") ? [requested] : [requested, `${requested}.zst`];
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpath(candidate);
    } catch {
      continue; // Missing (or dangling symlink); try the compressed variant.
    }
    if (!realRoots.some((root) => isInsidePath(root, real, platform))) return { kind: "outsideStorage" };
    if (!ROLLOUT_FILE_NAME.test(api.basename(real))) return { kind: "invalidName" };
    try {
      if (!isFile(real)) return { kind: "invalidName" };
    } catch {
      continue;
    }
    return { kind: "ok", path: real };
  }
  return { kind: "missing" };
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
    contextObservedAt: null,
    contextChangedAt: null,
    settingsChangedAt: null,
    rateLimitsByBucket: {},
    sourceKind,
  };
}

/**
 * Splits text into lines. A line longer than MAX_LINE_CHARS is dropped as soon
 * as it exceeds the limit, so memory stays bounded; reading resumes after its
 * newline. Carry and skip state can be saved and restored for incremental reads.
 */
class LineSplitter {
  carry = "";
  skipping = false;
  private readonly onLine: (line: string) => void;
  private readonly maxLineChars: number;

  constructor(onLine: (line: string) => void, maxLineChars = MAX_LINE_CHARS) {
    this.onLine = onLine;
    this.maxLineChars = maxLineChars;
  }

  restore(carry: string, skipping: boolean): void {
    this.carry = carry;
    this.skipping = skipping;
  }

  push(text: string): void {
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline >= 0) {
      if (this.skipping) {
        this.skipping = false;
      } else {
        const line = this.carry + text.slice(start, newline);
        if (line.length <= this.maxLineChars && line) this.onLine(line);
      }
      this.carry = "";
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (this.skipping) return;
    this.carry += text.slice(start);
    if (this.carry.length > this.maxLineChars) {
      this.carry = "";
      this.skipping = true;
    }
  }

  /** End of input: a final line without a newline is still a line. */
  finish(): void {
    if (!this.skipping && this.carry && this.carry.length <= this.maxLineChars) this.onLine(this.carry);
    this.carry = "";
    this.skipping = false;
  }
}

/** Reads a growing plain rollout from `start`; the unfinished last line stays in the splitter. */
async function parseJsonlRange(filePath: string, start: number, splitter: LineSplitter): Promise<void> {
  if ((await fs.stat(filePath)).size === start) return;
  const stream = createReadStream(filePath, { start, encoding: "utf8" });
  for await (const chunk of stream) splitter.push(chunk as string);
}

/**
 * Streams a zstd-compressed rollout through Node's built-in decompressor (no
 * external binary). Stops with an error when the output exceeds
 * MAX_DECOMPRESSED_BYTES.
 */
export async function parseZstdLines(
  filePath: string,
  onLine: (line: string) => void,
  limits: { maxDecompressedBytes?: number; maxLineChars?: number } = {},
): Promise<void> {
  const maxBytes = limits.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const splitter = new LineSplitter(onLine, limits.maxLineChars ?? MAX_LINE_CHARS);
  const decoder = new StringDecoder("utf8");
  const input = createReadStream(filePath);
  const decompressor = createZstdDecompress();
  input.once("error", (error) => decompressor.destroy(error));
  input.pipe(decompressor);
  let total = 0;
  try {
    for await (const chunk of decompressor) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) throw new RolloutReadError("failed");
      splitter.push(decoder.write(chunk as Buffer));
    }
    splitter.push(decoder.end());
    splitter.finish();
  } finally {
    input.destroy();
    decompressor.destroy();
  }
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
    telemetry.contextChangedAt = later(telemetry.contextChangedAt, timestamp);
    return;
  }

  if (type === "compacted" || (type === "event_msg" && payload.type === "task_started")) {
    telemetry.contextChangedAt = later(telemetry.contextChangedAt, timestamp);
    return;
  }

  if (type === "event_msg" && payload.type === "thread_settings_applied") {
    telemetry.contextChangedAt = later(telemetry.contextChangedAt, timestamp);
    telemetry.settingsChangedAt = later(telemetry.settingsChangedAt, timestamp);
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
    if (last) telemetry.contextObservedAt = timestamp;
    // Per bucket and per window; records without a valid window are ignored.
    recordRateLimits(telemetry.rateLimitsByBucket, payload.rate_limits ?? info.rate_limits, timestamp);
  }
}

/** The later of two ISO timestamps; an unparsable one is ignored. */
function later(current: string | null, next: string | null): string | null {
  if (next === null || !Number.isFinite(Date.parse(next))) return current;
  if (current === null || !Number.isFinite(Date.parse(current))) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
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
