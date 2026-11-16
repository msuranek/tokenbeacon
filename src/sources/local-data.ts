import { existsSync, statSync } from "node:fs";
import path from "node:path";
import * as sqlite from "node:sqlite";
import { resolveCodexHome } from "../config.ts";

/**
 * Read-only access to Codex's local SQLite databases.
 *
 * The databases are internal to Codex and change between versions. Nothing
 * here assumes one schema version: every database, table and column is
 * detected first, queries select only columns that exist, and each source
 * degrades on its own. A missing or unreadable source yields empty data and a
 * status code instead of an exception, so the server keeps running.
 *
 * Status details are stable codes and never contain paths.
 */

export type SourceState = "ok" | "degraded" | "unavailable";

export interface SourceStatus {
  state: SourceState;
  /** Stable, path-free codes, e.g. "missing", "missing_column:threads.model". */
  detail: string | null;
}

export interface LocalProjectRow {
  id: string;
  name: string;
  updatedAtMs: number;
  rootPaths: string[];
}

export interface LocalThreadRow {
  id: string;
  title: string;
  rolloutPath: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  recencyAtMs: number;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  tokensUsed: number;
  projectId: string | null;
  archived: boolean;
  catalogProjectId: string | null;
  catalogRecencyAtMs: number;
}

export interface CompactionSummary {
  count: number;
  lastAtMs: number | null;
}

export interface LocalSnapshotRows {
  projects: LocalProjectRow[];
  threads: LocalThreadRow[];
  /** null when compaction history is unavailable (unknown, not zero). */
  compactions: Map<string, CompactionSummary> | null;
  /** How thread visibility was decided. */
  visibility: "catalog" | "heuristic";
  watermarks: {
    stateDb: string | null;
    historyDb: string | null;
    desktopDb: string | null;
  };
  sources: {
    codexHome: SourceStatus;
    stateDb: SourceStatus;
    historyDb: SourceStatus;
    desktopCatalog: SourceStatus;
  };
}

type SqliteRow = Record<string, unknown>;
type Schema = Map<string, Set<string>>;

interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}

type SqliteConstructor = new (file: string, options: { readOnly: boolean }) => SqliteHandle;

// Newer Node releases rename DatabaseSync to Database (DatabaseSync becomes a
// deprecated alias). Prefer the new name when it exists.
const SqliteDatabase: SqliteConstructor =
  ((sqlite as Record<string, unknown>).Database as SqliteConstructor | undefined) ??
  (sqlite.DatabaseSync as unknown as SqliteConstructor);

interface OpenSource {
  db: SqliteHandle | null;
  schema: Schema;
  status: SourceStatus;
}

// Columns the monitor knows how to use. Anything else is ignored; anything
// missing degrades the corresponding value to unavailable.
const PROJECT_COLUMNS = ["id", "name", "position", "updated_at_ms", "updated_at"];
const PROJECT_ROOT_COLUMNS = ["project_id", "path", "position"];
const THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "name",
  "title",
  "preview",
  "created_at_ms",
  "created_at",
  "updated_at_ms",
  "updated_at",
  "recency_at_ms",
  "recency_at",
  "cwd",
  "model",
  "reasoning_effort",
  "tokens_used",
  "project_id",
  "archived",
  "thread_source",
  "source",
  "agent_role",
  "attached_thread_parent_id",
];
const CATALOG_COLUMNS = ["thread_id", "host_id", "missing_candidate", "project_id", "source_recency_at"];
const HISTORY_COLUMNS = ["thread_id", "item_type", "completed_at_ms", "started_at_ms", "created_at_ms"];

// Columns whose absence is worth reporting as degradation.
const EXPECTED: Record<string, string[]> = {
  projects: ["id", "name", "updated_at_ms"],
  project_roots: ["project_id", "path"],
  threads: ["id", "rollout_path", "cwd", "model", "reasoning_effort", "tokens_used", "archived"],
  local_thread_catalog: ["thread_id", "host_id", "missing_candidate", "project_id", "source_recency_at"],
  thread_items: ["thread_id", "item_type"],
};

export class LocalDataSource {
  readonly codexHome: string;
  readonly statePath: string;
  readonly historyPath: string;
  readonly desktopPath: string;

  constructor(codexHome = resolveCodexHome()) {
    this.codexHome = path.resolve(codexHome);
    this.statePath = path.join(this.codexHome, "state_5.sqlite");
    this.historyPath = path.join(this.codexHome, "thread_history_1.sqlite");
    this.desktopPath = path.join(this.codexHome, "sqlite", "codex.db");
  }

  read(): LocalSnapshotRows {
    const observedAt = new Date().toISOString();
    const homeStatus = inspectDirectory(this.codexHome);
    if (homeStatus.state === "unavailable") {
      const skipped: SourceStatus = { state: "unavailable", detail: "codex_home_unavailable" };
      return {
        projects: [],
        threads: [],
        compactions: null,
        visibility: "heuristic",
        watermarks: { stateDb: null, historyDb: null, desktopDb: null },
        sources: { codexHome: homeStatus, stateDb: skipped, historyDb: skipped, desktopCatalog: skipped },
      };
    }

    const state = openSource(this.statePath);
    const history = openSource(this.historyPath);
    const desktop = openSource(this.desktopPath);
    try {
      // A read transaction gives each short query group a consistent WAL snapshot.
      for (const source of [state, history, desktop]) beginRead(source);

      const stateNotes: string[] = [];
      const projects = readProjects(state, stateNotes);
      const catalog = readCatalog(desktop);
      const threadRows = readThreads(state, stateNotes);
      const compactions = readCompactions(history);

      // The desktop catalog is the verified visibility boundary: it excludes
      // guardian/review/subagent rows that also exist in state_5.sqlite. SQLite
      // cannot join independent files in strict read-only mode without ATTACH,
      // so the set is built in memory. Without the catalog, a conservative
      // heuristic over the thread's own columns is used instead.
      const visibility = catalog ? "catalog" : "heuristic";
      const threads = threadRows
        .filter((row) => (catalog ? catalog.has(String(row.id)) : looksUserVisible(row)))
        .map((row) => toThreadRow(row, catalog?.get(String(row.id))))
        .sort((left, right) => right.recencyAtMs - left.recencyAtMs || left.id.localeCompare(right.id));

      finalizeStatus(state, stateNotes);
      for (const source of [state, history, desktop]) commitRead(source);

      return {
        projects,
        threads,
        compactions,
        visibility,
        watermarks: {
          stateDb: state.db ? observedAt : null,
          historyDb: history.db ? observedAt : null,
          desktopDb: desktop.db ? observedAt : null,
        },
        sources: {
          codexHome: homeStatus,
          stateDb: state.status,
          historyDb: history.status,
          desktopCatalog: desktop.status,
        },
      };
    } finally {
      for (const source of [state, history, desktop]) closeQuietly(source);
    }
  }
}

// ---------------------------------------------------------------------------
// Source opening and schema detection
// ---------------------------------------------------------------------------

function inspectDirectory(directory: string): SourceStatus {
  try {
    if (!existsSync(directory)) return { state: "unavailable", detail: "codex_home_missing" };
    if (!statSync(directory).isDirectory()) {
      return { state: "unavailable", detail: "codex_home_not_directory" };
    }
    return { state: "ok", detail: null };
  } catch {
    return { state: "unavailable", detail: "codex_home_unreadable" };
  }
}

function openSource(filePath: string): OpenSource {
  const unavailable = (detail: string): OpenSource => ({
    db: null,
    schema: new Map(),
    status: { state: "unavailable", detail },
  });
  try {
    if (!existsSync(filePath)) return unavailable("missing");
    if (!statSync(filePath).isFile()) return unavailable("not_file");
  } catch {
    return unavailable("unreadable");
  }

  let db: SqliteHandle | null = null;
  try {
    db = openReadOnly(filePath);
    const schema = readSchema(db);
    return { db, schema, status: { state: "ok", detail: null } };
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // Already closed or never fully opened.
      }
    }
    return unavailable(sqliteErrorCode(error));
  }
}

export function openReadOnly(filePath: string): SqliteHandle {
  const database = new SqliteDatabase(filePath, { readOnly: true });
  database.exec("PRAGMA query_only = ON");
  // Defence in depth: refuse to continue if the connection is not read-only.
  const check = database.prepare("PRAGMA query_only").get() as SqliteRow | undefined;
  if (!check || Number(Object.values(check)[0]) !== 1) {
    database.close();
    throw new Error("query_only_not_enforced");
  }
  return database;
}

function readSchema(db: SqliteHandle): Schema {
  const schema: Schema = new Map();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all() as SqliteRow[];
  for (const table of tables) {
    const name = String(table.name);
    const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as SqliteRow[];
    schema.set(name, new Set(columns.map((column) => String(column.name))));
  }
  return schema;
}

function sqliteErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("not a database") || message.includes("file is encrypted")) return "not_sqlite";
  if (message.includes("malformed")) return "corrupt";
  if (message.includes("locked") || message.includes("busy")) return "busy";
  if (message.includes("unable to open")) return "open_failed";
  if (message.includes("query_only_not_enforced")) return "read_only_not_enforced";
  return "open_failed";
}

function beginRead(source: OpenSource): void {
  if (!source.db) return;
  try {
    source.db.exec("BEGIN");
  } catch {
    // Reads still work without an explicit transaction, only less consistently.
  }
}

function commitRead(source: OpenSource): void {
  if (!source.db) return;
  try {
    source.db.exec("COMMIT");
  } catch {
    // Nothing to commit for a read; ignore.
  }
}

function closeQuietly(source: OpenSource): void {
  if (!source.db) return;
  try {
    source.db.exec("ROLLBACK");
  } catch {
    // No transaction was active.
  }
  try {
    source.db.close();
  } catch {
    // Already closed.
  }
}

/** Selects the wanted columns that exist; null when a required one is missing. */
function selectAvailable(
  source: OpenSource,
  table: string,
  wanted: string[],
  required: string[],
  notes: string[],
  where: string[] = [],
): SqliteRow[] | null {
  if (!source.db) return null;
  const columns = source.schema.get(table);
  if (!columns) {
    notes.push(`missing_table:${table}`);
    return null;
  }
  for (const column of EXPECTED[table] ?? []) {
    if (!columns.has(column)) notes.push(`missing_column:${table}.${column}`);
  }
  if (required.some((column) => !columns.has(column))) return null;
  const selected = wanted.filter((column) => columns.has(column));
  // Identifiers come from the fixed allowlists above, never from data.
  const sql = `SELECT ${selected.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  }`;
  try {
    return source.db.prepare(sql).all() as SqliteRow[];
  } catch (error) {
    notes.push(`query_failed:${table}:${sqliteErrorCode(error)}`);
    return null;
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function finalizeStatus(source: OpenSource, notes: string[]): void {
  if (!source.db || notes.length === 0) return;
  const unique = [...new Set(notes)];
  const fatal = unique.some((note) => note === "missing_table:threads" || note.startsWith("query_failed:threads"));
  source.status = { state: fatal ? "unavailable" : "degraded", detail: unique.join(",") };
}

// ---------------------------------------------------------------------------
// Per-source readers
// ---------------------------------------------------------------------------

function readProjects(state: OpenSource, notes: string[]): LocalProjectRow[] {
  const rows = selectAvailable(state, "projects", PROJECT_COLUMNS, ["id"], notes);
  if (!rows) return [];
  const rootRows =
    selectAvailable(state, "project_roots", PROJECT_ROOT_COLUMNS, ["project_id", "path"], notes) ?? [];
  const roots = new Map<string, Array<{ path: string; position: number }>>();
  for (const row of rootRows) {
    const projectId = nullableString(row.project_id);
    const rootPath = nullableString(row.path);
    if (!projectId || !rootPath) continue;
    const bucket = roots.get(projectId) ?? [];
    bucket.push({ path: rootPath, position: finiteOr(row.position, bucket.length) });
    roots.set(projectId, bucket);
  }
  return rows
    .map((row, index) => ({ row, index, position: finiteOr(row.position, Number.MAX_SAFE_INTEGER) }))
    .filter(({ row }) => nullableString(row.id) !== null)
    .sort((left, right) => left.position - right.position || String(left.row.id).localeCompare(String(right.row.id)))
    .map(({ row }) => {
      const id = String(row.id);
      return {
        id,
        name: nullableString(row.name) ?? "",
        updatedAtMs: toEpochMs(row.updated_at_ms) || toEpochMs(row.updated_at),
        rootPaths: (roots.get(id) ?? []).sort((a, b) => a.position - b.position).map((root) => root.path),
      };
    });
}

function readThreads(state: OpenSource, notes: string[]): SqliteRow[] {
  const columns = state.schema.get("threads");
  const where = columns?.has("archived") ? ["archived = 0"] : [];
  return selectAvailable(state, "threads", THREAD_COLUMNS, ["id"], notes, where) ?? [];
}

interface CatalogEntry {
  projectId: string | null;
  recencyAtMs: number;
}

function readCatalog(desktop: OpenSource): Map<string, CatalogEntry> | null {
  const notes: string[] = [];
  const columns = desktop.schema.get("local_thread_catalog");
  const where: string[] = [];
  if (columns?.has("host_id")) where.push("host_id = 'local'");
  if (columns?.has("missing_candidate")) where.push("missing_candidate = 0");
  const rows = selectAvailable(desktop, "local_thread_catalog", CATALOG_COLUMNS, ["thread_id"], notes, where);
  if (desktop.db) {
    if (!rows) desktop.status = { state: "unavailable", detail: [...new Set(notes)].join(",") || "unusable" };
    else if (notes.length) desktop.status = { state: "degraded", detail: [...new Set(notes)].join(",") };
  }
  if (!rows) return null;
  return new Map(
    rows.map((row) => [
      String(row.thread_id),
      { projectId: nullableString(row.project_id), recencyAtMs: toEpochMs(row.source_recency_at) },
    ]),
  );
}

function readCompactions(history: OpenSource): Map<string, CompactionSummary> | null {
  const notes: string[] = [];
  const columns = history.schema.get("thread_items");
  if (!history.db) return null;
  if (!columns || !columns.has("thread_id") || !columns.has("item_type")) {
    history.status = {
      state: "unavailable",
      detail: !columns ? "missing_table:thread_items" : "missing_column:thread_items.thread_id_or_item_type",
    };
    return null;
  }
  const timeColumns = ["completed_at_ms", "started_at_ms", "created_at_ms"].filter((column) => columns.has(column));
  const lastAt = timeColumns.length > 0 ? `MAX(COALESCE(${timeColumns.map(quoteIdent).join(", ")}, NULL))` : "NULL";
  if (timeColumns.length === 0) notes.push("missing_column:thread_items.timestamps");
  try {
    const rows = history.db
      .prepare(
        `SELECT thread_id, COUNT(*) AS count, ${lastAt} AS last_at_ms
           FROM thread_items
          WHERE item_type = 'contextCompaction'
          GROUP BY thread_id`,
      )
      .all() as SqliteRow[];
    if (notes.length) history.status = { state: "degraded", detail: notes.join(",") };
    return new Map(
      rows.map((row) => [
        String(row.thread_id),
        { count: Number(row.count), lastAtMs: row.last_at_ms == null ? null : toEpochMs(row.last_at_ms) || null },
      ]),
    );
  } catch (error) {
    history.status = { state: "unavailable", detail: `query_failed:thread_items:${sqliteErrorCode(error)}` };
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

/**
 * Fallback visibility when the desktop catalog is unavailable. Excludes rows
 * that are recognisably internal: guardian/review threads, subagents and
 * attached child threads. This is less precise than the catalog.
 */
function looksUserVisible(row: SqliteRow): boolean {
  const threadSource = nullableString(row.thread_source);
  if (threadSource && threadSource !== "user") return false;
  if (nullableString(row.agent_role)) return false;
  if (nullableString(row.attached_thread_parent_id)) return false;
  const source = nullableString(row.source);
  if (source && source.trimStart().startsWith("{")) return false;
  return true;
}

function toThreadRow(row: SqliteRow, catalog: CatalogEntry | undefined): LocalThreadRow {
  const title =
    nullableString(row.name) ?? nullableString(row.title) ?? nullableString(row.preview) ?? "Untitled";
  return {
    id: String(row.id),
    title,
    rolloutPath: nullableString(row.rollout_path),
    createdAtMs: toEpochMs(row.created_at_ms) || toEpochMs(row.created_at),
    updatedAtMs: toEpochMs(row.updated_at_ms) || toEpochMs(row.updated_at),
    recencyAtMs: toEpochMs(row.recency_at_ms) || toEpochMs(row.recency_at),
    cwd: nullableString(row.cwd) ?? "",
    model: nullableString(row.model),
    reasoningEffort: nullableString(row.reasoning_effort),
    tokensUsed: finiteOr(row.tokens_used, 0),
    projectId: nullableString(row.project_id),
    archived: Boolean(row.archived),
    catalogProjectId: catalog?.projectId ?? null,
    catalogRecencyAtMs: catalog?.recencyAtMs ?? 0,
  };
}

function nullableString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function finiteOr(value: unknown, fallback: number): number {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
}

/** Epoch seconds or milliseconds to milliseconds; 0 when unknown. */
function toEpochMs(value: unknown): number {
  const number = finiteOr(value, 0);
  if (number <= 0) return 0;
  return number < 10_000_000_000 ? number * 1000 : number;
}
