import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as sqlite from "node:sqlite";

/**
 * Builds synthetic, anonymous Codex home directories for tests.
 * Nothing here reads or touches the developer's real ~/.codex.
 */

type Writable = {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
};
const Database = ((sqlite as Record<string, unknown>).Database ?? sqlite.DatabaseSync) as new (
  file: string,
) => Writable;

export const NOW_MS = Date.UTC(2026, 10, 16, 12, 0, 0);
export const IDS = {
  projectA: "11111111-1111-4111-8111-111111111111",
  projectB: "22222222-2222-4222-8222-222222222222",
  threadExplicit: "aaaaaaaa-0000-4000-8000-000000000001",
  threadCatalog: "aaaaaaaa-0000-4000-8000-000000000002",
  threadPath: "aaaaaaaa-0000-4000-8000-000000000003",
  threadUnassigned: "aaaaaaaa-0000-4000-8000-000000000004",
  threadGuardian: "aaaaaaaa-0000-4000-8000-000000000005",
  threadArchived: "aaaaaaaa-0000-4000-8000-000000000006",
  threadOutside: "aaaaaaaa-0000-4000-8000-000000000007",
};

export interface Fixture {
  root: string;
  codexHome: string;
  outsideDir: string;
  cleanup(): void;
}

export function createTempRoot(): { root: string; cleanup(): void } {
  const root = mkdtempSync(path.join(tmpdir(), "tokenbeacon-fixture-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function hasZstd(): boolean {
  return spawnSync("zstd", ["--version"], { stdio: "ignore" }).status === 0;
}

export function rolloutLines(options: {
  model?: string;
  effort?: string;
  total?: number;
  last?: number;
  window?: number;
  rateLimits?: boolean;
}): string {
  const lines: unknown[] = [
    { timestamp: "2026-11-16T11:00:00.000Z", type: "session_meta", payload: { id: "x" } },
    {
      timestamp: "2026-11-16T11:00:01.000Z",
      type: "turn_context",
      payload: { model: options.model ?? "gpt-fixture", effort: options.effort ?? "medium" },
    },
    "this line is not json and must be ignored",
    {
      timestamp: "2026-11-16T11:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: options.total ?? 1_000 },
          last_token_usage: { total_tokens: options.last ?? 50_000 },
          model_context_window: options.window ?? 200_000,
        },
        rate_limits: options.rateLimits
          ? {
              // Relative to NOW_MS: 5-hour window ends in 2 h, weekly in 3 days.
              primary: { used_percent: 42, window_minutes: 300, resets_at: (NOW_MS + 2 * 3_600_000) / 1000 },
              secondary: { used_percent: 7, window_minutes: 10_080, resets_at: (NOW_MS + 3 * 86_400_000) / 1000 },
            }
          : undefined,
      },
    },
    { timestamp: "2026-11-16T11:00:03.000Z", type: "future_event_kind", payload: { anything: true } },
  ];
  return `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`;
}

interface BuildOptions {
  /** Which databases to create. Defaults to all. */
  databases?: Array<"state" | "history" | "desktop">;
  /** Older/smaller schema: drops many optional columns and tables. */
  legacySchema?: boolean;
}

/** A complete synthetic Codex home with the currently known schema. */
export function createFixtureCodexHome(options: BuildOptions = {}): Fixture {
  const { root, cleanup } = createTempRoot();
  const codexHome = path.join(root, "codex-home");
  const outsideDir = path.join(root, "outside");
  const sessions = path.join(codexHome, "sessions", "2026", "11", "16");
  const workRoot = path.join(root, "work");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(path.join(codexHome, "sqlite"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const rollout = (name: string) => path.join(sessions, `rollout-${name}.jsonl`);
  writeFileSync(rollout("explicit"), rolloutLines({ total: 1_000, last: 50_000, rateLimits: true }));
  writeFileSync(rollout("catalog"), rolloutLines({ total: 2_000, last: 12_000 }));
  writeFileSync(rollout("path"), rolloutLines({ total: 3_000 }));
  writeFileSync(path.join(outsideDir, "rollout-outside.jsonl"), rolloutLines({ total: 999_999 }));

  const databases = options.databases ?? ["state", "history", "desktop"];
  const legacy = options.legacySchema === true;

  if (databases.includes("state")) {
    const db = new Database(path.join(codexHome, "state_5.sqlite"));
    if (legacy) {
      // Older/alternative shape: no project tables, seconds-based timestamps,
      // no name/recency/model/reasoning/project columns.
      db.exec(`CREATE TABLE threads (
        id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, created_at INTEGER,
        updated_at INTEGER, cwd TEXT, tokens_used INTEGER)`);
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)");
      insert.run(IDS.threadExplicit, rollout("explicit"), "Legacy thread", NOW_MS / 1000 - 60, NOW_MS / 1000, path.join(workRoot, "a"), 1_234);
      insert.run(IDS.threadPath, rollout("path"), null, NOW_MS / 1000 - 120, NOW_MS / 1000 - 60, path.join(workRoot, "b"), 0);
    } else {
      db.exec(`CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER,
        created_at_ms INTEGER, updated_at_ms INTEGER)`);
      db.exec(`CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
      db.exec(`CREATE TABLE threads (
        id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
        source TEXT, cwd TEXT, title TEXT, tokens_used INTEGER, archived INTEGER,
        model TEXT, reasoning_effort TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
        thread_source TEXT, preview TEXT, recency_at INTEGER, recency_at_ms INTEGER,
        name TEXT, project_id TEXT, agent_role TEXT, attached_thread_parent_id TEXT,
        some_future_column TEXT)`);
      const project = db.prepare("INSERT INTO projects VALUES (?, ?, '{}', ?, ?, ?)");
      project.run(IDS.projectA, "Alpha", 1, NOW_MS - 10_000, NOW_MS - 10_000);
      project.run(IDS.projectB, "Beta", 0, NOW_MS - 20_000, NOW_MS - 20_000);
      const root = db.prepare("INSERT INTO project_roots VALUES (?, ?, ?)");
      root.run(IDS.projectA, 0, path.join(workRoot, "alpha"));
      root.run(IDS.projectB, 0, path.join(workRoot, "beta"));

      const thread = db.prepare(`INSERT INTO threads (id, rollout_path, source, cwd, title, tokens_used, archived,
        model, reasoning_effort, created_at_ms, updated_at_ms, thread_source, preview, recency_at_ms, name, project_id, agent_role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      thread.run(IDS.threadExplicit, rollout("explicit"), "vscode", path.join(workRoot, "beta"), "Explicit", 10, 0, "gpt-db", "low", NOW_MS - 5_000, NOW_MS - 1_000, "user", null, NOW_MS - 1_000, null, IDS.projectA, null);
      thread.run(IDS.threadCatalog, rollout("catalog"), "vscode", "/nowhere", "Catalog", 0, 0, null, null, NOW_MS - 5_000, NOW_MS - 2_000, "user", null, NOW_MS - 2_000, null, null, null);
      thread.run(IDS.threadPath, rollout("path"), "cli", path.join(workRoot, "alpha", "src"), "", 0, 0, null, null, NOW_MS - 5_000, NOW_MS - 3_000, "user", "Preview title", NOW_MS - 3_000, null, null, null);
      thread.run(IDS.threadUnassigned, path.join(sessions, "rollout-missing.jsonl"), "vscode", "/somewhere/else", "Unassigned", 77, 0, "gpt-db", null, NOW_MS - 5_000, NOW_MS - 4_000, "user", null, NOW_MS - 4_000, null, null, null);
      thread.run(IDS.threadGuardian, rollout("explicit"), '{"subagent":{"other":"guardian"}}', path.join(workRoot, "alpha"), "Guardian", 0, 0, null, null, NOW_MS, NOW_MS, "guardian_review", null, NOW_MS, null, null, "reviewer");
      thread.run(IDS.threadArchived, rollout("explicit"), "vscode", path.join(workRoot, "alpha"), "Archived", 0, 1, null, null, NOW_MS, NOW_MS, "user", null, NOW_MS, null, null, null);
      thread.run(IDS.threadOutside, path.join(outsideDir, "rollout-outside.jsonl"), "vscode", path.join(workRoot, "alpha"), "Outside rollout", 0, 0, null, null, NOW_MS - 6_000, NOW_MS - 6_000, "user", null, NOW_MS - 6_000, null, null, null);
    }
    db.close();
  }

  if (databases.includes("history")) {
    const db = new Database(path.join(codexHome, "thread_history_1.sqlite"));
    if (legacy) {
      db.exec("CREATE TABLE thread_items (thread_id TEXT, item_type TEXT)");
      db.prepare("INSERT INTO thread_items VALUES (?, 'contextCompaction')").run(IDS.threadExplicit);
    } else {
      db.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
        created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER,
        started_at_ms INTEGER, completed_at_ms INTEGER)`);
      const item = db.prepare(`INSERT INTO thread_items (thread_id, item_type, created_at_ms, completed_at_ms) VALUES (?, ?, ?, ?)`);
      item.run(IDS.threadExplicit, "contextCompaction", NOW_MS - 3_000, NOW_MS - 2_900);
      item.run(IDS.threadExplicit, "contextCompaction", NOW_MS - 2_000, NOW_MS - 1_900);
      item.run(IDS.threadExplicit, "message", NOW_MS - 1_000, NOW_MS - 900);
    }
    db.close();
  }

  if (databases.includes("desktop") && !legacy) {
    const db = new Database(path.join(codexHome, "sqlite", "codex.db"));
    db.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT,
      missing_candidate INTEGER, source_recency_at INTEGER, project_id TEXT, cwd TEXT)`);
    const entry = db.prepare(`INSERT INTO local_thread_catalog (host_id, thread_id, missing_candidate, source_recency_at, project_id)
      VALUES (?, ?, ?, ?, ?)`);
    entry.run("local", IDS.threadExplicit, 0, NOW_MS / 1000 - 1, null);
    entry.run("local", IDS.threadCatalog, 0, NOW_MS / 1000 - 2, IDS.projectB);
    entry.run("local", IDS.threadPath, 0, NOW_MS / 1000 - 3, null);
    entry.run("local", IDS.threadUnassigned, 0, NOW_MS / 1000 - 4, null);
    entry.run("local", IDS.threadOutside, 0, NOW_MS / 1000 - 6, null);
    entry.run("remote-host", IDS.threadGuardian, 0, NOW_MS / 1000, null);
    db.close();
  }

  return { root, codexHome, outsideDir, cleanup };
}
