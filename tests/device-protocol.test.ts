import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHello,
  buildStateMessage,
  MAX_LINE_BYTES,
  nextSeq,
  parseDeviceLine,
  parseHostLine,
  serializeMessage,
  type HostMessage,
} from "../src/device/protocol.ts";
import { SnapshotService } from "../src/snapshot-service.ts";
import { LocalDataSource } from "../src/sources/local-data.ts";
import type { MonitorSnapshot, ThreadView } from "../src/types.ts";
import { createFixtureCodexHome, NOW_MS } from "./helpers/fixture-codex-home.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VECTORS = path.join(ROOT, "tests", "device-vectors");
const SCHEMA = JSON.parse(readFileSync(path.join(ROOT, "docs", "device-protocol.schema.json"), "utf8"));

interface LineVector {
  line: string;
  expect: string;
  note: string;
}

function readLines(file: string): LineVector[] {
  return readFileSync(path.join(VECTORS, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LineVector);
}

interface StateCase {
  name: string;
  now: string;
  seq: number;
  limits: MonitorSnapshot["limits"];
  threads: Array<Pick<ThreadView, "contextUsedPercent"> & { lastActivityAt: string | null }>;
  expected: string;
}

/** A snapshot with only the parts the encoder reads; threads go to "No project". */
function snapshotFrom(testCase: StateCase): MonitorSnapshot {
  return {
    limits: testCase.limits,
    projects: [],
    unassignedThreads: testCase.threads.map((thread) => ({
      contextUsedPercent: { ...thread.contextUsedPercent, source: null },
      lastActivityAt: { value: thread.lastActivityAt, state: "current", observedAt: null, source: null },
    })),
  } as unknown as MonitorSnapshot;
}

// --- Minimal JSON Schema check (the subset the protocol schema uses) --------

function schemaErrors(value: unknown, schema: Record<string, unknown>, at = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/$defs/", "");
    return schemaErrors(value, SCHEMA.$defs[name], at);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((option) => schemaErrors(value, option, at).length === 0).length;
    return matches === 1 ? [] : [`${at}: matches ${matches} of oneOf`];
  }
  const errors: string[] = [];
  if ("const" in schema && value !== schema.const) errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${at}: not an integer`);
  if (schema.type === "string" && typeof value !== "string") errors.push(`${at}: not a string`);
  if (schema.type === "array" && !Array.isArray(value)) errors.push(`${at}: not an array`);
  if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return [`${at}: not an object`];
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: pattern`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${at}: too many items`);
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items as Record<string, unknown>, `${at}[${index}]`)));
  }
  if (schema.type === "object" && value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in record)) errors.push(`${at}.${key}: required`);
    for (const [key, item] of Object.entries(record)) {
      if (properties[key]) errors.push(...schemaErrors(item, properties[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------

describe("device protocol: host encoding", () => {
  const { cases } = JSON.parse(readFileSync(path.join(VECTORS, "state-cases.json"), "utf8")) as { cases: StateCase[] };

  test("state cases produce exactly the expected line", () => {
    assert.ok(cases.length >= 5);
    for (const testCase of cases) {
      const message = buildStateMessage(snapshotFrom(testCase), testCase.seq, Date.parse(testCase.now));
      assert.equal(serializeMessage(message), `${testCase.expected}\n`, testCase.name);
    }
  });

  test("every message TokenBeacon sends matches the schema and the device rules", () => {
    const sent: HostMessage[] = [
      ...cases.map((testCase) => buildStateMessage(snapshotFrom(testCase), testCase.seq, Date.parse(testCase.now))),
      buildHello("0.3.0", "5f1c9a2e"),
    ];
    for (const message of sent) {
      assert.deepEqual(schemaErrors(message, SCHEMA), [], JSON.stringify(message));
      const parsed = parseHostLine(serializeMessage(message));
      assert.ok(parsed.ok, JSON.stringify(message));
      assert.deepEqual(parsed.message, message);
    }
  });

  test("the largest possible state line leaves room for later fields", () => {
    const limit = { st: "last-known", left: 100, win: "active", reset: 2_147_483_647, age: 2_147_483_647 } as const;
    const line = serializeMessage({
      tb: 1,
      t: "state",
      seq: 2_147_483_647,
      five: limit,
      week: limit,
      ctx: { st: "last-known", used: 100, age: 2_147_483_647 },
      next: 60,
    });
    // Today about 280 bytes; keep a quarter of the 512-byte limit free for minor versions.
    assert.ok(Buffer.byteLength(line) <= MAX_LINE_BYTES * 0.75, `${Buffer.byteLength(line)} bytes`);
  });

  test("a real snapshot reduces to display data only (no names, IDs, paths or tokens)", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const snapshot = await new SnapshotService(new LocalDataSource(fixture.codexHome), undefined, () => NOW_MS).refresh();
    const line = serializeMessage(buildStateMessage(snapshot, 1, NOW_MS));
    const threads = [
      ...snapshot.projects.flatMap((p) => (p.latestThread ? [p.latestThread, ...p.otherThreads] : [])),
      ...snapshot.unassignedThreads,
    ];
    assert.ok(threads.length > 0);
    const forbidden = [
      fixture.root,
      fixture.codexHome,
      ...snapshot.projects.flatMap((project) => [project.id, project.name]),
      ...threads.flatMap((thread) => [thread.id, thread.title, thread.model.value ?? ""]),
    ].filter((value) => value.length >= 4);
    for (const value of forbidden) assert.ok(!line.includes(value), `leaked ${value}`);
    // Only these keys can ever appear, so token counts and other fields cannot leak.
    const allowed = new Set(["tb", "t", "seq", "five", "week", "ctx", "next", "st", "left", "used", "win", "reset", "age"]);
    JSON.parse(line, (key, value) => {
      if (key !== "") assert.ok(allowed.has(key), `unexpected key ${key}`);
      return value;
    });
  });

  test("hello and sequence numbers are validated", () => {
    assert.throws(() => buildHello("0.3.0", "short"));
    assert.throws(() => buildHello("0.3.0 <x>", "5f1c9a2e"));
    assert.throws(() => buildStateMessage({ limits: {}, projects: [], unassignedThreads: [] } as unknown as MonitorSnapshot, -1, 0));
    assert.equal(nextSeq(0), 1);
    assert.equal(nextSeq(2_147_483_647), 0);
  });
});

describe("device protocol: parsing untrusted lines", () => {
  test("device rules for host lines (shared with the firmware)", () => {
    const vectors = readLines("host-to-device.jsonl");
    assert.ok(vectors.length >= 20);
    for (const vector of vectors) {
      const result = parseHostLine(vector.line);
      assert.equal(result.ok ? "ok" : result.code, vector.expect, vector.note);
    }
  });

  test("host rules for device lines", () => {
    const vectors = readLines("device-to-host.jsonl");
    assert.ok(vectors.length >= 12);
    for (const vector of vectors) {
      const result = parseDeviceLine(vector.line);
      assert.equal(result.ok ? "ok" : result.code, vector.expect, vector.note);
      if (vector.expect === "ok") {
        const json = JSON.parse(vector.line);
        delete json.extra;
        assert.deepEqual(schemaErrors(json, SCHEMA), [], vector.note);
      }
    }
  });

  test("the schema rejects every invalid host line that is still JSON", () => {
    let checked = 0;
    for (const vector of readLines("host-to-device.jsonl")) {
      if (vector.expect === "ok" || vector.expect === "line_too_long") continue;
      let json: unknown;
      try {
        json = JSON.parse(vector.line);
      } catch {
        continue;
      }
      checked += 1;
      assert.notDeepEqual(schemaErrors(json, SCHEMA), [], vector.note);
    }
    assert.ok(checked >= 10, `checked ${checked}`);
  });

  test("accepted device hello exposes only validated fields", () => {
    const result = parseDeviceLine(
      '{"tb":1,"t":"hello","dev":"tokenbeacon-display","fw":"0.1.0","proto":[1,2],"nonce":"5f1c9a2e","id":"c3a9f01b","name":"<script>"}\n',
    );
    assert.deepEqual(result, {
      ok: true,
      message: { type: "hello", firmware: "0.1.0", protocols: [1, 2], nonce: "5f1c9a2e", deviceId: "c3a9f01b" },
    });
  });

  test("error codes never echo the rejected content", () => {
    for (const vector of [...readLines("host-to-device.jsonl"), ...readLines("device-to-host.jsonl")]) {
      const result = vector.expect === "ok" ? null : parseHostLine(vector.line);
      if (result && !result.ok) assert.match(result.code, /^[a-z_]+$/);
    }
  });
});

describe("device protocol: no runtime effect yet", () => {
  test("nothing in the application imports the device module", () => {
    const sources: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) sources.push(full);
      }
    };
    walk(path.join(ROOT, "src"));
    const importers = sources.filter(
      (file) => !file.includes(`${path.sep}device${path.sep}`) && /from\s+["'][^"']*device\//.test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(importers, []);
  });
});
