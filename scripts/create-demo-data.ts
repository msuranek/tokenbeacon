/**
 * Creates a fictional Codex data folder for screenshots and demos.
 *
 *   node scripts/create-demo-data.ts <empty-directory>
 *   CODEX_HOME=<empty-directory> npm start
 *
 * Every project, thread, number and timestamp here is made up. The script
 * only writes into the directory you pass, which must not exist yet or must be
 * empty; it never touches a real Codex installation. It is a development tool
 * and is not used by the application itself.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as sqlite from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

type Writable = {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
};
const Database = ((sqlite as Record<string, unknown>).Database ?? sqlite.DatabaseSync) as new (file: string) => Writable;

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/create-demo-data.ts <empty-directory>");
  process.exit(1);
}
const home = path.resolve(target);
if (existsSync(home) && readdirSync(home).length > 0) {
  console.error("The target directory must be empty, so no existing data is overwritten.");
  process.exit(1);
}

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW = 258_400;
const WORK = "/Users/demo/work";

interface DemoThread {
  title: string;
  ageMs: number;
  contextPercent: number;
  totalTokens: number;
  compactions: number;
  model?: string;
  effort?: string;
  archived?: boolean;
  /** Linked by Codex (default) or only matched by folder. */
  linked?: boolean;
}

const projects: Array<{ name: string; threads: DemoThread[] }> = [
  {
    name: "payments-api",
    threads: [
      { title: "Add idempotency keys to the refund endpoint", ageMs: 4 * MIN, contextPercent: 38, totalTokens: 1_284_310, compactions: 0 },
      { title: "Investigate flaky webhook retry test", ageMs: 3 * HOUR, contextPercent: 71, totalTokens: 6_902_118, compactions: 2 },
      { title: "Document the currency rounding rules", ageMs: 2 * DAY, contextPercent: 19, totalTokens: 412_904, compactions: 0, archived: true },
      { title: "Upgrade the Postgres driver", ageMs: 6 * DAY, contextPercent: 88, totalTokens: 15_330_472, compactions: 5, archived: true },
    ],
  },
  {
    name: "design-system",
    threads: [
      { title: "Build an accessible date picker", ageMs: 42 * MIN, contextPercent: 64, totalTokens: 3_120_557, compactions: 1, effort: "high" },
      { title: "Audit color tokens for contrast", ageMs: 1 * DAY, contextPercent: 27, totalTokens: 802_115, compactions: 0, linked: false },
    ],
  },
  {
    name: "mobile-app",
    threads: [
      { title: "Fix offline sync conflict on reconnect", ageMs: 2 * HOUR, contextPercent: 83, totalTokens: 9_874_201, compactions: 3 },
      { title: "Add haptic feedback to the checkout flow", ageMs: 3 * DAY, contextPercent: 12, totalTokens: 233_870, compactions: 0, archived: true },
    ],
  },
  {
    name: "data-pipeline",
    threads: [
      { title: "Backfill events for the March import", ageMs: 5 * HOUR, contextPercent: 45, totalTokens: 2_456_093, compactions: 1, model: "gpt-5.5-mini", effort: "low" },
    ],
  },
  {
    name: "docs-site",
    threads: [
      { title: "Migrate the changelog to MDX", ageMs: 20 * HOUR, contextPercent: 8, totalTokens: 98_442, compactions: 0, effort: "low" },
      { title: "Generate API reference from OpenAPI", ageMs: 4 * DAY, contextPercent: 52, totalTokens: 4_015_660, compactions: 1, archived: true },
    ],
  },
  {
    name: "infra",
    threads: [
      { title: "Tighten IAM policies for the build runners", ageMs: 9 * DAY, contextPercent: 33, totalTokens: 1_190_874, compactions: 0, archived: true },
    ],
  },
];

const unassigned: DemoThread[] = [
  { title: "Explain this regular expression", ageMs: 7 * HOUR, contextPercent: 4, totalTokens: 21_906, compactions: 0, effort: "low" },
];

const uuid = (prefix: number, index: number) =>
  `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

mkdirSync(path.join(home, "sqlite"), { recursive: true });
const sessions = path.join(home, "sessions", "2026", "11", "16");
mkdirSync(sessions, { recursive: true });

const state = new Database(path.join(home, "state_5.sqlite"));
state.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER, updated_at_ms INTEGER)`);
state.exec(`CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT)`);
state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, tokens_used INTEGER,
  archived INTEGER, model TEXT, reasoning_effort TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
  recency_at_ms INTEGER, thread_source TEXT, project_id TEXT)`);
const history = new Database(path.join(home, "thread_history_1.sqlite"));
history.exec(`CREATE TABLE thread_items (thread_id TEXT, item_type TEXT, created_at_ms INTEGER, completed_at_ms INTEGER)`);
const desktop = new Database(path.join(home, "sqlite", "codex.db"));
desktop.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, missing_candidate INTEGER,
  source_recency_at INTEGER, project_id TEXT)`);

let threadIndex = 0;
function addThread(thread: DemoThread, projectId: string | null, cwd: string): void {
  threadIndex += 1;
  const id = uuid(0xdead0000 + threadIndex, threadIndex);
  const at = NOW - thread.ageMs;
  const model = thread.model ?? "gpt-5.5";
  const effort = thread.effort ?? "medium";
  const contextTokens = Math.round(12_000 + ((WINDOW - 12_000) * thread.contextPercent) / 100);
  const rollout = path.join(sessions, `rollout-2026-11-16-${slug(thread.title)}.jsonl`);
  const lines = [
    { timestamp: new Date(at - 30 * MIN).toISOString(), type: "turn_context", payload: { model, effort } },
    {
      timestamp: new Date(at).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            // Same shape as Codex: total = input + output; cached input is part
            // of input and reasoning is part of output.
            input_tokens: Math.round(thread.totalTokens * 0.96),
            cached_input_tokens: Math.round(thread.totalTokens * 0.81),
            output_tokens: thread.totalTokens - Math.round(thread.totalTokens * 0.96),
            reasoning_output_tokens: Math.round(thread.totalTokens * 0.01),
            total_tokens: thread.totalTokens,
          },
          last_token_usage: { total_tokens: contextTokens },
          model_context_window: WINDOW,
        },
        rate_limits:
          threadIndex === 1
            ? {
                limit_id: "codex",
                primary: { used_percent: 42, window_minutes: 300, resets_at: Math.round((NOW + 2 * HOUR + 13 * MIN) / 1000) },
                secondary: { used_percent: 63, window_minutes: 10_080, resets_at: Math.round((NOW + 3 * DAY + 5 * HOUR) / 1000) },
              }
            : undefined,
      },
    },
  ];
  writeFileSync(rollout, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  let storedPath = rollout;
  if (thread.archived) {
    // Archived threads are compressed like Codex does; the database keeps the .jsonl path.
    writeFileSync(`${rollout}.zst`, zstdCompressSync(readFileSync(rollout)));
    unlinkSync(rollout);
    storedPath = rollout;
  }

  const linked = thread.linked ?? true;
  state
    .prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'user', ?)`)
    .run(id, storedPath, cwd, thread.title, thread.totalTokens, model, effort, at - HOUR, at, at, linked ? projectId : null);
  desktop.prepare(`INSERT INTO local_thread_catalog VALUES ('local', ?, 0, ?, ?)`).run(id, Math.round(at / 1000), null);
  for (let index = 0; index < thread.compactions; index += 1) {
    const when = at - (index + 1) * 40 * MIN;
    history.prepare(`INSERT INTO thread_items VALUES (?, 'contextCompaction', ?, ?)`).run(id, when, when + 20_000);
  }
}

projects.forEach((project, position) => {
  const projectId = uuid(0xbeef0000 + position, position + 1);
  const root = `${WORK}/${project.name}`;
  state.prepare(`INSERT INTO projects VALUES (?, ?, ?, ?)`).run(projectId, project.name, position, NOW - DAY);
  state.prepare(`INSERT INTO project_roots VALUES (?, 0, ?)`).run(projectId, root);
  for (const thread of project.threads) addThread(thread, projectId, `${root}/src`);
});
for (const thread of unassigned) addThread(thread, null, "/Users/demo/scratch");

state.close();
history.close();
desktop.close();

console.log(`Demo Codex data created (${threadIndex} fictional threads).`);
console.log(`Start the dashboard with: CODEX_HOME=${JSON.stringify(home)} npm start`);
