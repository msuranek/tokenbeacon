// device-state/v1: the line protocol between TokenBeacon and the optional USB
// display. Pure functions only – no I/O, no timers. Specification:
// docs/device-protocol.md, schema: docs/device-protocol.schema.json.
//
// Data minimization is part of the protocol: messages carry only limit and
// context percentages, their freshness state and ages in seconds. Never names,
// IDs, paths, prompts, token counts, models or credentials.

import type { LimitWindow, MetricValue, MonitorSnapshot, ThreadView } from "../types.ts";

export const PROTOCOL_VERSION = 1;
/** Longest line in either direction, in UTF-8 bytes, including the newline. */
export const MAX_LINE_BYTES = 512;
/** A state message is sent at least this often, even when nothing changed. */
export const HEARTBEAT_SECONDS = 10;
export const DEVICE_NAME = "tokenbeacon-display";
export const HOST_NAME = "tokenbeacon";
const MAX_INT = 2_147_483_647;

export type ValueState = "current" | "last-known" | "unavailable";

export type LimitField =
  | { st: "unavailable" }
  | { st: "current" | "last-known"; win: "expired"; age?: number }
  | { st: "current" | "last-known"; left: number; win: "active"; reset?: number; age?: number };

/**
 * `title` (optional, P-037): the name of the thread the context belongs to.
 * Sent only to a device that announced the "title" capability, and only when
 * the user turned it on (TOKENBEACON_DEVICE_TITLE=on).
 */
export type ContextField = { st: "unavailable" } | { st: "current" | "last-known"; used: number; age?: number; title?: string };

export interface StateMessage {
  tb: 1;
  t: "state";
  seq: number;
  five: LimitField;
  week: LimitField;
  ctx: ContextField;
  next: number;
}

export interface HostHello {
  tb: 1;
  t: "hello";
  host: typeof HOST_NAME;
  ver: string;
  nonce: string;
}

export type HostMessage = StateMessage | HostHello;

export type DeviceMessage =
  | { type: "hello"; firmware: string; protocols: number[]; nonce: string; deviceId: string; caps: string[] }
  | { type: "alive"; seq: number; uptimeSeconds: number }
  | { type: "error"; code: string };

/** Stable codes for rejected lines. Never contain the rejected content. */
export type LineError =
  | "line_too_long"
  | "bad_json"
  | "unsupported_version"
  | "unknown_type"
  | "unknown_device"
  | "bad_field";

export type ParseResult<T> = { ok: true; message: T } | { ok: false; code: LineError };

const NONCE = /^[0-9a-f]{8,32}$/;
const DEVICE_ID = /^[0-9a-f]{4,32}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,31}$/;
const CAPABILITY = /^[a-z0-9_]{1,16}$/;
const MAX_CAPABILITIES = 8;

/** Device capability: show the name of the thread the context belongs to (P-037). */
export const TITLE_CAPABILITY = "title";
/**
 * Technical limit for `ctx.title` in UTF-8 bytes. With the largest possible
 * state line (about 250 bytes) it stays well under MAX_LINE_BYTES, and the
 * device keeps it in a fixed buffer. Longer titles are cut at a character
 * boundary and end with "...".
 */
export const MAX_TITLE_BYTES = 200;
// C0/C1 controls and DEL are never part of a title on the wire.
const TITLE_CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");

// ---------------------------------------------------------------------------
// Host -> device

/** The next sequence number; wraps to 0 after 2^31 - 1. */
export function nextSeq(seq: number): number {
  return seq >= MAX_INT ? 0 : seq + 1;
}

export function buildHello(version: string, nonce: string): HostHello {
  if (!VERSION.test(version)) throw new Error("invalid host version");
  if (!NONCE.test(nonce)) throw new Error("invalid nonce");
  return { tb: 1, t: "hello", host: HOST_NAME, ver: version, nonce };
}

/**
 * Builds the display state from a snapshot. `nowMs` is the send time; all
 * times become ages or countdowns in whole seconds because the device has no
 * clock. Missing values are sent as "unavailable", never estimated.
 */
export function buildStateMessage(
  snapshot: MonitorSnapshot,
  seq: number,
  nowMs: number,
  options: { title?: boolean } = {},
): StateMessage {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_INT) throw new Error("invalid seq");
  const thread = mostRecentThread(snapshot);
  const message: StateMessage = {
    tb: 1,
    t: "state",
    seq,
    five: limitField(snapshot.limits.fiveHour, nowMs),
    week: limitField(snapshot.limits.weekly, nowMs),
    ctx: contextField(thread, nowMs),
    next: HEARTBEAT_SECONDS,
  };
  // The title always comes from the same thread as the context value.
  if (options.title && message.ctx.st !== "unavailable" && thread) {
    const room = MAX_LINE_BYTES - Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8") - Buffer.byteLength(',"title":""');
    const title = fitTitle(thread.title, Math.min(MAX_TITLE_BYTES, room));
    if (title) message.ctx = { ...message.ctx, title };
  }
  return message;
}

/**
 * The thread title as the dashboard shows it, cut so that its JSON form takes
 * at most `maxBytes` UTF-8 bytes. Cuts only between whole characters (grapheme
 * clusters), never inside a UTF-8 sequence, and ends a cut title with "...".
 * Control characters become spaces. Returns null when nothing is left.
 */
export function fitTitle(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || maxBytes < 4) return null;
  const text = value.replace(new RegExp(TITLE_CONTROL.source, "g"), " ").replace(/\s+/g, " ").trim();
  if (!text || !text.isWellFormed()) return null;
  const jsonBytes = (part: string) => Buffer.byteLength(JSON.stringify(part), "utf8") - 2;
  if (jsonBytes(text) <= maxBytes) return text;
  const segments = Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text), (part) => part.segment);
  let cut = "";
  for (const segment of segments) {
    if (jsonBytes(cut + segment) + 3 > maxBytes) break;
    cut += segment;
  }
  cut = cut.trimEnd();
  return cut ? `${cut}...` : null;
}

/** A title as it may appear on the wire: 1–MAX_TITLE_BYTES bytes, well-formed, no control characters. */
export function isWireTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.isWellFormed() &&
    !TITLE_CONTROL.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_TITLE_BYTES
  );
}

/** One JSON line with a trailing newline. Throws if it would exceed MAX_LINE_BYTES. */
export function serializeMessage(message: HostMessage): string {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("message too long");
  return line;
}

function limitField(metric: MetricValue<LimitWindow> | null | undefined, nowMs: number): LimitField {
  if (!metric || metric.state === "unavailable" || metric.value === null) return { st: "unavailable" };
  const st = metric.state;
  const window = metric.value;
  const age = ageSeconds(metric.observedAt, nowMs);
  if (window.status === "expired") return withAge({ st, win: "expired" }, age);
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return { st: "unavailable" };
  const field: LimitField = { st, left: clampPercent(100 - window.usedPercent), win: "active" };
  const reset = secondsUntil(window.resetsAt, nowMs);
  if (reset !== undefined) field.reset = reset;
  return withAge(field, age);
}

function contextField(thread: ThreadView | null, nowMs: number): ContextField {
  const metric = thread?.contextUsedPercent;
  if (!metric || metric.state === "unavailable" || typeof metric.value !== "number" || !Number.isFinite(metric.value)) {
    return { st: "unavailable" };
  }
  return withAge({ st: metric.state, used: clampPercent(metric.value) }, ageSeconds(metric.observedAt, nowMs));
}

/** The thread with the latest activity across projects and unassigned threads. */
function mostRecentThread(snapshot: MonitorSnapshot): ThreadView | null {
  let best: ThreadView | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  const threads = [
    ...snapshot.projects.flatMap((project) => (project.latestThread ? [project.latestThread, ...project.otherThreads] : [])),
    ...snapshot.unassignedThreads,
  ];
  for (const thread of threads) {
    const at = thread.lastActivityAt.value ? Date.parse(thread.lastActivityAt.value) : Number.NaN;
    if (Number.isFinite(at) && at > bestMs) {
      best = thread;
      bestMs = at;
    }
  }
  return best;
}

function withAge<T extends object>(field: T, age: number | undefined): T & { age?: number } {
  return age === undefined ? field : { ...field, age };
}

function ageSeconds(iso: string | null, nowMs: number): number | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  return Math.min(MAX_INT, Math.max(0, Math.floor((nowMs - at) / 1_000)));
}

function secondsUntil(iso: string | null, nowMs: number): number | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.floor((at - nowMs) / 1_000);
  return seconds > 0 ? Math.min(MAX_INT, seconds) : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Parsing. Lines are untrusted input: bounded, whitelisted, never echoed.

/** Parses a line from the device. Unknown fields are ignored. */
export function parseDeviceLine(line: string): ParseResult<DeviceMessage> {
  const object = parseLineObject(line);
  if (!object.ok) return object;
  const record = object.message;
  switch (record.t) {
    case "hello": {
      if (record.dev !== DEVICE_NAME) return fail("unknown_device");
      const protocols = record.proto;
      if (
        typeof record.fw !== "string" || !VERSION.test(record.fw) ||
        !Array.isArray(protocols) || protocols.length < 1 || protocols.length > 8 ||
        !protocols.every((value) => Number.isInteger(value) && value >= 1 && value <= 255) ||
        typeof record.nonce !== "string" || !NONCE.test(record.nonce) ||
        typeof record.id !== "string" || !DEVICE_ID.test(record.id)
      ) {
        return fail("bad_field");
      }
      // Optional capabilities (later firmware); unknown names are kept but unused.
      const caps = record.caps;
      if (
        caps !== undefined &&
        (!Array.isArray(caps) || caps.length > MAX_CAPABILITIES || !caps.every((cap) => typeof cap === "string" && CAPABILITY.test(cap)))
      ) {
        return fail("bad_field");
      }
      return {
        ok: true,
        message: {
          type: "hello",
          firmware: record.fw,
          protocols: [...protocols] as number[],
          nonce: record.nonce,
          deviceId: record.id,
          caps: caps === undefined ? [] : [...new Set(caps as string[])],
        },
      };
    }
    case "alive":
      if (!isCount(record.seq) || !isCount(record.up)) return fail("bad_field");
      return { ok: true, message: { type: "alive", seq: record.seq as number, uptimeSeconds: record.up as number } };
    case "err":
      if (typeof record.code !== "string" || !ERROR_CODE.test(record.code)) return fail("bad_field");
      return { ok: true, message: { type: "error", code: record.code } };
    default:
      return fail("unknown_type");
  }
}

/**
 * Parses a line from the host with the rules every device must apply. The
 * firmware implements the same rules; tests/device-vectors keeps both in step.
 */
export function parseHostLine(line: string): ParseResult<HostMessage> {
  const object = parseLineObject(line);
  if (!object.ok) return object;
  const record = object.message;
  if (record.t === "hello") {
    if (
      record.host !== HOST_NAME ||
      typeof record.ver !== "string" || !VERSION.test(record.ver) ||
      typeof record.nonce !== "string" || !NONCE.test(record.nonce)
    ) {
      return fail("bad_field");
    }
    return { ok: true, message: { tb: 1, t: "hello", host: HOST_NAME, ver: record.ver, nonce: record.nonce } };
  }
  if (record.t === "state") {
    const five = readLimit(record.five);
    const week = readLimit(record.week);
    const ctx = readContext(record.ctx);
    const next = record.next;
    if (!isCount(record.seq) || !five || !week || !ctx || !Number.isInteger(next) || (next as number) < 1 || (next as number) > 60) {
      return fail("bad_field");
    }
    return { ok: true, message: { tb: 1, t: "state", seq: record.seq as number, five, week, ctx, next: next as number } };
  }
  return fail("unknown_type");
}

function parseLineObject(line: string): ParseResult<Record<string, unknown>> {
  if (typeof line !== "string") return fail("bad_json");
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return fail("line_too_long");
  const text = line.replace(/\r?\n$/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("bad_json");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("bad_json");
  const record = value as Record<string, unknown>;
  if (record.tb !== PROTOCOL_VERSION) return fail(Number.isInteger(record.tb) ? "unsupported_version" : "bad_field");
  if (typeof record.t !== "string") return fail("bad_field");
  return { ok: true, message: record };
}

function readLimit(value: unknown): LimitField | null {
  if (!isRecord(value)) return null;
  if (value.st === "unavailable") return { st: "unavailable" };
  if (value.st !== "current" && value.st !== "last-known") return null;
  const st: "current" | "last-known" = value.st;
  if (value.age !== undefined && !isCount(value.age)) return null;
  const age = value.age as number | undefined;
  if (value.win === "expired") {
    if (value.left !== undefined) return null; // an ended window never carries a percentage
    return withAge({ st, win: "expired" as const }, age);
  }
  if (value.win !== "active" || !isPercent(value.left)) return null;
  if (value.reset !== undefined && !isCount(value.reset)) return null;
  const field: LimitField = { st, left: value.left as number, win: "active" };
  if (value.reset !== undefined) field.reset = value.reset as number;
  return withAge(field, age);
}

function readContext(value: unknown): ContextField | null {
  if (!isRecord(value)) return null;
  if (value.st === "unavailable") return { st: "unavailable" };
  if (value.st !== "current" && value.st !== "last-known") return null;
  const st: "current" | "last-known" = value.st;
  if (!isPercent(value.used) || (value.age !== undefined && !isCount(value.age))) return null;
  if (value.title !== undefined && !isWireTitle(value.title)) return null;
  const field = withAge({ st, used: value.used as number }, value.age as number | undefined);
  return value.title === undefined ? field : { ...field, title: value.title as string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_INT;
}

function isPercent(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;
}

function fail(code: LineError): { ok: false; code: LineError } {
  return { ok: false, code };
}
