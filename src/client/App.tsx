import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompactTokens, formatExactTokens } from "./format.ts";
import type {
  LimitWindow,
  MetricValue,
  MonitorSnapshot,
  ProjectView,
  ThreadView,
} from "../types.ts";

type ConnectionState = "connecting" | "loading" | "online" | "offline";

const POLL_INTERVAL_MS = 5_000;
const LOADING_POLL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

export function App() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());

  // Polling is a setTimeout chain: the next request starts only after the
  // previous one has finished, so slow responses can never overlap or arrive
  // out of order. Each request is aborted after REQUEST_TIMEOUT_MS.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
      let delay = POLL_INTERVAL_MS;
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store", signal: controller.signal });
        if (response.status === 503) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          if (body?.error === "snapshot_loading") {
            if (active) setConnection("loading");
            delay = LOADING_POLL_MS;
            return;
          }
          throw new Error("Codex data could not be loaded. See the terminal running npm start for details.");
        }
        if (!response.ok) throw new Error(`The server responded with error ${response.status}.`);
        const next = (await response.json()) as MonitorSnapshot;
        if (!active) return;
        setSnapshot(next);
        setConnection("online");
        setLastError(null);
      } catch (error) {
        if (!active) return;
        setConnection("offline");
        setLastError(describeFetchError(error));
      } finally {
        window.clearTimeout(timeout);
        if (active) timer = window.setTimeout(poll, delay);
      }
    };

    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const projects = useMemo(() => {
    if (!snapshot) return [];
    return [...snapshot.projects]
      .sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""))
      .filter((project) => projectMatches(project, normalizedQuery));
  }, [snapshot, normalizedQuery]);
  const allThreads = useMemo(() => (snapshot ? flattenThreads(snapshot) : []), [snapshot]);
  const selected = selectedId ? allThreads.find((thread) => thread.id === selectedId) ?? null : null;
  const generatedAge = snapshot ? Math.max(0, clock - Date.parse(snapshot.generatedAt)) : null;

  const toggleProject = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(projectId) ? next.delete(projectId) : next.add(projectId);
      return next;
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <div>
            <h1>TokenBeacon</h1>
            <p>Usage &amp; Context Dashboard for Codex</p>
          </div>
        </div>

        <div className="limits-grid">
          <LimitCard label="5-hour limit" metric={snapshot?.limits.fiveHour ?? null} />
          <LimitCard label="Weekly limit" metric={snapshot?.limits.weekly ?? null} />
        </div>

        <div className="status-stack">
          <div className={`connection connection--${connection}`} role="status">
            <span className="connection-dot" />
            {connection === "online"
              ? "Connected"
              : connection === "loading"
                ? "Loading data…"
                : connection === "connecting"
                  ? "Connecting…"
                  : snapshot
                    ? "Offline – showing last data"
                    : "Offline"}
          </div>
          <div className="freshness">
            {generatedAge === null ? "Waiting for data" : `Updated ${formatAge(generatedAge)}`}
          </div>
        </div>
      </header>

      <main>
        <section className="toolbar" aria-label="Filter projects">
          <div className="search-wrap">
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects and threads…"
              aria-label="Search projects and threads"
            />
            {query && (
              <button className="clear-search" onClick={() => setQuery("")} aria-label="Clear search">
                ×
              </button>
            )}
          </div>
          <div className="summary-line">
            <strong>{snapshot?.diagnostics.visibleThreadCount ?? "—"}</strong> threads
            <span />
            <strong>{snapshot?.projects.length ?? "—"}</strong> projects
          </div>
        </section>

        {connection === "offline" && !snapshot && (
          <div className="empty-state error-state">
            <OfflineIcon />
            <h2>Can’t reach the TokenBeacon server</h2>
            <p>{lastError ?? "Start it with npm start; this page reconnects automatically."}</p>
          </div>
        )}

        {!snapshot && connection === "loading" && (
          <div className="loading-note" role="status">
            Loading your local Codex data… The first start can take a few seconds.
          </div>
        )}

        {!snapshot && connection !== "offline" && <TableSkeleton />}

        {snapshot && connection === "offline" && (
          <div className="source-notice" role="status">
            <strong>The server is not responding. Showing the last data received.</strong>
            {lastError}
          </div>
        )}

        {snapshot && <SourceNotice snapshot={snapshot} />}

        {snapshot && (
          <section className="project-panel">
            <div className="table-scroll">
              <table className="projects-table">
                <thead>
                  <tr>
                    <th scope="col">Project / thread</th>
                    <th scope="col">Model</th>
                    <th scope="col">Context used</th>
                    <th scope="col" title="All tokens this thread has used across every turn, not the current context">Total tokens</th>
                    <th scope="col">Compactions</th>
                    <th scope="col">Last activity</th>
                    <th scope="col"><span className="sr-only">Open in Codex</span></th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => {
                    const allProjectThreads = project.latestThread
                      ? [project.latestThread, ...project.otherThreads]
                      : [];
                    const queryMatchesChild =
                      normalizedQuery.length > 0 &&
                      project.otherThreads.some((thread) => thread.title.toLocaleLowerCase().includes(normalizedQuery));
                    const isExpanded = expanded.has(project.id) || queryMatchesChild;
                    return (
                      <ProjectRows
                        key={project.id}
                        project={project}
                        threadCount={allProjectThreads.length}
                        expanded={isExpanded}
                        onToggle={() => toggleProject(project.id)}
                        onSelect={setSelectedId}
                        query={normalizedQuery}
                      />
                    );
                  })}

                  {snapshot.unassignedThreads.length > 0 &&
                    unassignedMatches(snapshot.unassignedThreads, normalizedQuery) && (
                      <UnassignedRows
                        threads={snapshot.unassignedThreads}
                        expanded={expanded.has("__unassigned__") || normalizedQuery.length > 0}
                        onToggle={() => toggleProject("__unassigned__")}
                        onSelect={setSelectedId}
                        query={normalizedQuery}
                      />
                    )}
                </tbody>
              </table>
            </div>

            {projects.length === 0 && !unassignedMatches(snapshot.unassignedThreads, normalizedQuery) && (
              <div className="empty-filter">
                {normalizedQuery ? (
                  <>No projects or threads match “{query.trim()}”.</>
                ) : (
                  <>
                    <strong>No Codex threads yet</strong>
                    <span>Threads you create in Codex appear here automatically.</span>
                  </>
                )}
              </div>
            )}

            <footer className="panel-footer">
              <span>
                Local data, read-only
                <span className="footer-separator">·</span>
                read in {formatDuration(snapshot.diagnostics.refreshDurationMs)}
              </span>
              <span className="footer-state" aria-label="Legend">
                <span className="state-dot state-dot--current" /> Current
                <span className="state-dot state-dot--last-known" /> Last known
                <span className="state-dot state-dot--unavailable" /> Unavailable (N/A)
              </span>
            </footer>
          </section>
        )}

        {snapshot && <HelpPanel />}
      </main>

      {selected && <ThreadDetail thread={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function LimitCard({ label, metric }: { label: string; metric: MetricValue<LimitWindow> | null }) {
  // metric === null: the snapshot has not arrived yet (loading), which is
  // different from a known-unavailable limit ("N/A").
  const pending = metric === null;
  const value = metric?.value ?? null;
  // An expired window has ended and Codex hasn't recorded the new one yet; the
  // previous window's percentage is deliberately not shown.
  const expired = value?.status === "expired";
  const used = !expired ? value?.usedPercent ?? null : null;
  const left = used === null ? null : Math.max(0, Math.min(100, 100 - used));
  const recordedAt = metric?.observedAt ? formatClock(metric.observedAt) : null;
  const endedAt = value?.resetsAt ? formatClock(value.resetsAt) : null;

  const description = pending
    ? `${label}: loading`
    : expired
      ? `${label}: awaiting fresh data. Previous window ended at ${endedAt ?? "an unknown time"}. Last recorded at ${recordedAt ?? "an unknown time"}.`
      : used === null
        ? `${label}: unavailable`
        : `${label}: ${used}% used, ${left}% left${recordedAt ? `, recorded at ${recordedAt}` : ""}`;

  return (
    <article className={expired ? "limit-card limit-card--expired" : "limit-card"} aria-busy={pending} aria-label={description}>
      <div className="limit-card__top">
        <span>{label}</span>
        {expired ? (
          <span className="state-badge state-badge--unavailable state-badge--compact">Window ended</span>
        ) : metric ? (
          <MetricStateBadge state={metric.state} compact />
        ) : null}
      </div>
      <div className={expired ? "limit-value limit-value--waiting" : "limit-value"} aria-hidden="true">
        {pending ? "—" : expired ? "Awaiting fresh data" : used === null ? "N/A" : <>{used}% <small>used</small></>}
      </div>
      <div className="limit-track" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.max(0, used ?? 0))}%` }} />
      </div>
      <div className="limit-reset" aria-hidden="true">
        {pending
          ? "Loading…"
          : expired
            ? `Previous window ended at ${endedAt ?? "unknown"}`
            : used === null
              ? "No usage reported yet"
              : `${left}% left${value?.resetsAt ? ` · resets ${formatReset(value.resetsAt)}` : ""}`}
      </div>
      {!pending && recordedAt && (
        <div className="limit-recorded" aria-hidden="true">Last recorded at {recordedAt}</div>
      )}
    </article>
  );
}

function ProjectRows({
  project,
  threadCount,
  expanded,
  onToggle,
  onSelect,
  query,
}: {
  project: ProjectView;
  threadCount: number;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  query: string;
}) {
  return (
    <>
      <ThreadRow
        thread={project.latestThread}
        projectName={project.name}
        threadCount={threadCount}
        expandable={project.otherThreads.length > 0}
        expanded={expanded}
        onToggle={onToggle}
        onSelect={onSelect}
        isProject
      />
      {expanded &&
        project.otherThreads
          .filter((thread) => !query || project.name.toLocaleLowerCase().includes(query) || thread.title.toLocaleLowerCase().includes(query))
          .map((thread) => (
            <ThreadRow key={thread.id} thread={thread} onSelect={onSelect} nested />
          ))}
    </>
  );
}

function UnassignedRows({
  threads,
  expanded,
  onToggle,
  onSelect,
  query,
}: {
  threads: ThreadView[];
  expanded: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  query: string;
}) {
  const visible = query
    ? threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query))
    : threads;
  return (
    <>
      <tr className="unassigned-heading">
        <td colSpan={7}>
          <button className="project-toggle" onClick={onToggle} aria-expanded={expanded}>
            <ChevronIcon expanded={expanded} />
            <span className="project-icon project-icon--muted" aria-hidden="true">—</span>
            <span>No project</span>
            <span className="thread-count" aria-label={`${threads.length} threads`}>{threads.length}</span>
          </button>
        </td>
      </tr>
      {expanded && visible.map((thread) => <ThreadRow key={thread.id} thread={thread} onSelect={onSelect} nested />)}
    </>
  );
}

function ThreadRow({
  thread,
  projectName,
  threadCount,
  expandable = false,
  expanded = false,
  onToggle,
  onSelect,
  isProject = false,
  nested = false,
}: {
  thread: ThreadView | null;
  projectName?: string;
  threadCount?: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: (id: string) => void;
  isProject?: boolean;
  nested?: boolean;
}) {
  const activate = () => thread && onSelect(thread.id);
  return (
    <tr
      className={`${isProject ? "project-row" : "thread-row"} ${nested ? "thread-row--nested" : ""}`}
      onClick={activate}
      tabIndex={thread ? 0 : undefined}
      aria-label={thread ? `${isProject ? `${projectName}: ` : ""}${thread.title}. Press Enter for details.` : undefined}
      onKeyDown={(event) => {
        // Only the row itself: Enter on the chevron or the Codex link must not also open details.
        if (event.target !== event.currentTarget || !thread) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      <td className="name-cell">
        <div className="name-layout">
          {isProject && (
            <button
              className="chevron-button"
              onClick={(event) => {
                event.stopPropagation();
                onToggle?.();
              }}
              disabled={!expandable}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${projectName ?? "project"}`}
              aria-expanded={expandable ? expanded : undefined}
            >
              <ChevronIcon expanded={expanded} />
            </button>
          )}
          {nested && <span className="nest-line" />}
          {isProject && <span className="project-icon" aria-hidden="true">{initials(projectName ?? "")}</span>}
          <div className="name-copy">
            {isProject && (
              <div className="project-name">
                {projectName}
                <span className="thread-count" aria-label={`${threadCount} threads`}>{threadCount}</span>
              </div>
            )}
            <div className={isProject ? "thread-title thread-title--secondary" : "thread-title"}>
              {thread?.title ?? "No threads"}
            </div>
          </div>
        </div>
      </td>
      <td className="model-cell">
        {thread ? <MetricText metric={thread.model} mono /> : <NA />}
      </td>
      <td className="context-cell">
        {thread ? <ContextBar metric={thread.contextUsedPercent} /> : <NA />}
      </td>
      <td className="tokens-cell">
        {thread ? <MetricText
            metric={thread.totalTokens}
            formatter={formatCompactTokens}
            exactFormatter={(value) => `${formatExactTokens(value)} tokens used by the whole thread`}
          /> : <NA />}
      </td>
      <td className="compactions-cell">
        {thread ? <MetricText metric={thread.compactionCount} /> : <NA />}
      </td>
      <td className="activity-cell">
        {thread ? <MetricText metric={thread.lastActivityAt} formatter={formatRelativeDate} /> : <NA />}
      </td>
      <td className="action-cell">
        {thread && safeOpenTarget(thread) ? (
          <a
            className="open-link"
            href={safeOpenTarget(thread)!}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Open “${thread.title}” in Codex`}
            title="Open in Codex"
          >
            <ExternalIcon />
          </a>
        ) : (
          <span className="open-link open-link--disabled" title="This thread can’t be opened in Codex" aria-hidden="true"><ExternalIcon /></span>
        )}
      </td>
    </tr>
  );
}

interface SourceProblem {
  key: string;
  text: string;
  /** Raw status code, kept only as a tooltip for troubleshooting. */
  code: string | null;
}

/** Turns path-free source status codes into sentences for people. */
function describeSourceProblems(snapshot: MonitorSnapshot): { blocking: boolean; problems: SourceProblem[] } {
  const health = new Map(snapshot.sourceHealth.map((source) => [source.source, source]));
  const home = health.get("codexHome");
  if (home && home.state !== "ok") {
    return {
      blocking: true,
      problems: [
        {
          key: "codexHome",
          code: home.detail,
          text:
            home.detail === "codex_home_missing"
              ? "No Codex data folder was found. Open Codex at least once, or start the monitor with CODEX_HOME pointing to your Codex data folder."
              : "The Codex data location is not a readable folder. Check the CODEX_HOME setting.",
        },
      ],
    };
  }

  const problems: SourceProblem[] = [];
  let blocking = false;
  const state = health.get("stateDb");
  if (state && state.state === "unavailable") {
    blocking = true;
    problems.push({
      key: "stateDb",
      code: state.detail,
      text:
        state.detail === "missing"
          ? "Codex hasn’t created its thread database yet. Start a thread in Codex and this page will update."
          : "The Codex thread database can’t be read. This Codex version may store data in a format the monitor doesn’t support yet.",
    });
  } else if (state && state.state === "degraded") {
    problems.push({
      key: "stateDb",
      code: state.detail,
      text: "This Codex version doesn’t record some thread details. Those values show as N/A.",
    });
  }

  const history = health.get("historyDb");
  if (history && history.state !== "ok" && !blocking) {
    problems.push({
      key: "historyDb",
      code: history.detail,
      text:
        history.state === "unavailable"
          ? "Compaction history isn’t available, so compaction counts show as N/A."
          : "This Codex version doesn’t record compaction times.",
    });
  }

  const catalog = health.get("desktopCatalog");
  if (catalog && catalog.state !== "ok" && !blocking) {
    problems.push({
      key: "desktopCatalog",
      code: catalog.detail,
      text: "The Codex app’s thread list isn’t available. Internal threads are hidden using an estimate, so the list may differ slightly from Codex.",
    });
  }

  const rollouts = health.get("rollouts");
  if (rollouts && rollouts.state === "degraded" && rollouts.detail) {
    const counts = Object.fromEntries(
      rollouts.detail.split(",").map((part) => {
        const [reason, count] = part.split(":");
        return [reason, Number(count) || 0];
      }),
    ) as Record<string, number>;
    if (counts.zstdMissing) {
      problems.push({
        key: "zstd",
        code: rollouts.detail,
        text: `${plural(counts.zstdMissing, "archived thread")} can’t be read because zstd is not installed. Install it with: brew install zstd`,
      });
    }
    const other = (counts.missing ?? 0) + (counts.noPath ?? 0) + (counts.failed ?? 0) +
      (counts.outsideStorage ?? 0) + (counts.invalidName ?? 0);
    if (other > 0) {
      problems.push({
        key: "rollouts",
        code: rollouts.detail,
        text: `Token and context details are missing for ${plural(other, "thread")}, because Codex has no readable session log for them.`,
      });
    }
  }
  return { blocking, problems };
}

/** Explains missing or partially readable Codex data instead of an unexplained empty table. */
function SourceNotice({ snapshot }: { snapshot: MonitorSnapshot }) {
  const { blocking, problems } = describeSourceProblems(snapshot);
  if (problems.length === 0) return null;
  return (
    <div className={blocking ? "source-notice source-notice--blocking" : "source-notice"} role="status">
      <strong>{blocking ? "Codex data not found" : "Some Codex data is incomplete"}</strong>
      {problems.length === 1 ? (
        <p title={problems[0].code ?? undefined}>{problems[0].text}</p>
      ) : (
        <ul>
          {problems.map((problem) => (
            <li key={problem.key} title={problem.code ?? undefined}>{problem.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ASSIGNMENT_LABELS: Record<ThreadView["assignmentSource"], { label: string; hint: string }> = {
  "state-db": { label: "Linked in Codex", hint: "Codex stores this thread in the project." },
  "desktop-catalog": { label: "Linked in Codex", hint: "The Codex app lists this thread under the project." },
  "path-fallback": {
    label: "Matched by folder (estimate)",
    hint: "Codex has no project link for this thread; its working folder is inside this project’s folder.",
  },
  unassigned: { label: "No project", hint: "The thread’s working folder doesn’t belong to any project." },
};

const DEEP_LINK_PATTERN =
  /^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only exact Codex thread deep links may become an href (never javascript:, http:, ...). */
function safeOpenTarget(thread: ThreadView): string | null {
  const value = thread.openTarget.value;
  return typeof value === "string" && DEEP_LINK_PATTERN.test(value) ? value : null;
}

function ThreadDetail({ thread, onClose }: { thread: ThreadView; onClose: () => void }) {
  const context = thread.contextUsedPercent.value;
  const contextLeft = context === null ? null : Math.max(0, 100 - context);
  const assignment = ASSIGNMENT_LABELS[thread.assignmentSource];
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Modal dialog behaviour: focus moves in, Tab stays inside, focus returns on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="detail-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        ref={panelRef}
      >
        <div className="detail-header">
          <div>
            <div className="eyebrow">Thread details</div>
            <h2 id="detail-title">{thread.title}</h2>
            <div className="thread-id"><span className="sr-only">Thread ID: </span>{thread.id}</div>
          </div>
          <button className="close-button" onClick={onClose} aria-label="Close details" ref={closeRef}>×</button>
        </div>

        <section className="context-hero" aria-label="Context window">
          <div
            className="context-ring"
            style={{ "--context": `${context ?? 0}%` } as React.CSSProperties}
            aria-hidden="true"
          >
            <div>
              <strong>{context === null ? "N/A" : `${context}%`}</strong>
              <span>used</span>
            </div>
          </div>
          <div className="context-copy">
            <span>Context window</span>
            <strong>
              {context === null ? "Unavailable" : `${context}% used · ${contextLeft}% left`}
            </strong>
            <span className="context-tokens">
              {formatMetricValue(thread.contextTokens, formatExactTokens)} of{" "}
              {formatMetricValue(thread.contextWindowTokens, formatExactTokens)} tokens
            </span>
            <MetricStateBadge state={thread.contextUsedPercent.state} />
          </div>
        </section>

        <section className="detail-section">
          <h3>Token usage</h3>
          <div className="metric-grid">
            <DetailMetric label="Input" metric={thread.inputTokens} formatter={formatExactTokens} />
            <DetailMetric label="Cached input" metric={thread.cachedInputTokens} formatter={formatExactTokens} />
            <DetailMetric label="Output" metric={thread.outputTokens} formatter={formatExactTokens} />
            <DetailMetric label="Reasoning" metric={thread.reasoningOutputTokens} formatter={formatExactTokens} />
            <DetailMetric label="Total (whole thread)" metric={thread.totalTokens} formatter={formatExactTokens} wide />
          </div>
          <p className="detail-hint detail-hint--block">
            Input and output from every turn added up. Codex sends the conversation again on each turn, so cached
            input is counted every time. That’s why the total can be far larger than the context window.
          </p>
        </section>

        <section className="detail-section">
          <h3>Thread</h3>
          <div className="detail-list">
            <DetailRow label="Model" metric={thread.model} mono />
            <DetailRow label="Reasoning effort" metric={thread.reasoningEffort} />
            <DetailRow label="Compactions" metric={thread.compactionCount} />
            <DetailRow label="Last compaction" metric={thread.lastCompactionAt} formatter={formatAbsoluteDate} />
            <DetailRow label="Last activity" metric={thread.lastActivityAt} formatter={formatAbsoluteDate} />
            <div className="detail-row detail-row--stacked">
              <span>Project link</span>
              <div className="detail-row__value">
                <strong>{assignment.label}</strong>
              </div>
              <p className="detail-hint">{assignment.hint}</p>
            </div>
          </div>
        </section>

        {safeOpenTarget(thread) ? (
          <a className="primary-button" href={safeOpenTarget(thread)!}>
            Open in Codex <ExternalIcon />
          </a>
        ) : (
          <button className="primary-button" disabled>Can’t open this thread in Codex</button>
        )}
      </aside>
    </div>
  );
}

function DetailMetric<T>({
  label,
  metric,
  formatter,
  wide,
}: {
  label: string;
  metric: MetricValue<T>;
  formatter?: (value: T) => string;
  wide?: boolean;
}) {
  return (
    <div className={`detail-metric ${wide ? "detail-metric--wide" : ""}`}>
      <span>{label}</span>
      <strong>{formatMetricValue(metric, formatter)}</strong>
      <MetricStateBadge state={metric.state} compact />
    </div>
  );
}

function DetailRow<T>({
  label,
  metric,
  formatter,
  mono,
}: {
  label: string;
  metric: MetricValue<T>;
  formatter?: (value: T) => string;
  mono?: boolean;
}) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <div className="detail-row__value">
        <strong className={mono ? "mono" : ""}>{formatMetricValue(metric, formatter)}</strong>
        <MetricStateBadge state={metric.state} compact />
      </div>
    </div>
  );
}

function MetricText<T>({
  metric,
  formatter,
  exactFormatter,
  mono,
}: {
  metric: MetricValue<T>;
  formatter?: (value: T) => string;
  /** Full-precision text for a shortened value: shown on hover and read by screen readers. */
  exactFormatter?: (value: T) => string;
  mono?: boolean;
}) {
  const exact = exactFormatter && metric.value !== null ? exactFormatter(metric.value) : null;
  const title = exact ? `${exact} · ${describeMetric(metric)}` : describeMetric(metric);
  return (
    <div className={`metric-text metric-text--${metric.state}`} title={title}>
      <span className={`state-dot state-dot--${metric.state}`} />
      {exact ? (
        <>
          <span className={mono ? "mono" : ""} aria-hidden="true">{formatMetricValue(metric, formatter)}</span>
          <span className="sr-only">{exact}</span>
        </>
      ) : (
        <span className={mono ? "mono" : ""}>{formatMetricValue(metric, formatter)}</span>
      )}
    </div>
  );
}

function ContextBar({ metric }: { metric: MetricValue<number> }) {
  const value = metric.value;
  return (
    <div className="context-bar-wrap" title={describeMetric(metric)}>
      <span className={`context-number context-number--${metric.state}`}>{value === null ? "N/A" : `${value}%`}</span>
      <span className="context-track">
        <span className={contextClass(value, metric.state)} style={{ width: `${value ?? 0}%` }} />
      </span>
    </div>
  );
}

function MetricStateBadge({ state, compact = false }: { state: MetricValue<unknown>["state"]; compact?: boolean }) {
  const label = state === "current" ? "Current" : state === "last-known" ? "Last known" : "Unavailable";
  return <span className={`state-badge state-badge--${state} ${compact ? "state-badge--compact" : ""}`}>{label}</span>;
}

function NA() {
  return <span className="na" title="Unavailable">N/A</span>;
}

function describeMetric(metric: MetricValue<unknown>): string {
  if (metric.state === "unavailable") return "Unavailable: Codex didn’t record this value, or it couldn’t be read.";
  const when = metric.observedAt ? `, recorded ${formatAbsoluteDate(metric.observedAt)}` : "";
  return metric.state === "current"
    ? `Current${when}`
    : `Last known value${when}. It may have changed since.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function HelpPanel() {
  return (
    <details className="help-panel">
      <summary>How to read these numbers</summary>
      <div className="help-grid">
        <section>
          <h3>Current, last known, unavailable</h3>
          <p>
            <span className="state-dot state-dot--current" /> <strong>Current</strong> values were just read from
            an active Codex session or Codex’s local database.
          </p>
          <p>
            <span className="state-dot state-dot--last-known" /> <strong>Last known</strong> values are the latest
            ones Codex recorded, for example in an archived thread. They may be out of date.
          </p>
          <p>
            <span className="state-dot state-dot--unavailable" /> <strong>Unavailable (N/A)</strong> means Codex didn’t
            record the value or it couldn’t be read. The monitor never estimates missing numbers.
          </p>
        </section>
        <section>
          <h3>Context used and context left</h3>
          <p>
            <strong>Context used</strong> is how full a thread’s context window is. Context left is the rest:
            58% used means 42% left. It’s calculated the same way Codex calculates “context left”.
          </p>
          <p>
            The bar turns amber at 60% and red at 80%. When the context fills up, Codex compacts the conversation;
            the <strong>Compactions</strong> column counts how often that happened.
          </p>
        </section>
        <section>
          <h3>Total tokens</h3>
          <p>
            <strong>Total tokens</strong> is everything a thread has used so far: input plus output from every turn,
            as Codex reports it. It only grows, even after a compaction.
          </p>
          <p>
            Input includes <strong>cached input</strong>: Codex sends the conversation again on each turn, so the
            same text is counted every time. That’s why the total is often many times larger than the context window.
            How full the context is right now is shown in <strong>Context used</strong>.
          </p>
        </section>
        <section>
          <h3>Account limits</h3>
          <p>
            The <strong>5-hour</strong> and <strong>weekly</strong> cards show how much of your plan’s usage limit is
            used. Remaining is 100% minus used.
          </p>
          <p>
            Codex reports limits only while you use it, so they’re always <strong>last known</strong>. Each card
            shows when they were last recorded.
          </p>
          <p>
            When a window has ended and Codex hasn’t reported the new one yet, the card shows{" "}
            <strong>Awaiting fresh data</strong> instead of the old percentage. It updates after your next Codex
            request.
          </p>
        </section>
        <section>
          <h3>How threads are assigned to projects</h3>
          <p>
            Most threads are linked to a project by Codex itself. If a thread has no link, the monitor checks whether
            its working folder is inside a project’s folder and picks the most specific match.
          </p>
          <p>
            These matches are estimates and appear as “Matched by folder” in the thread details. Threads that match
            nothing are listed under <strong>No project</strong>.
          </p>
        </section>
      </div>
    </details>
  );
}

function describeFetchError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The server didn’t respond in time. Retrying…";
  }
  if (error instanceof TypeError) {
    return "The local server isn’t running. Start it with npm start; this page reconnects automatically.";
  }
  return error instanceof Error ? error.message : "The local server isn’t reachable.";
}

function TableSkeleton() {
  return (
    <div className="project-panel skeleton-panel" aria-label="Loading data" aria-busy="true">
      <div className="skeleton-line skeleton-line--header" />
      {Array.from({ length: 7 }, (_, index) => <div className="skeleton-line" key={index} />)}
    </div>
  );
}

function flattenThreads(snapshot: MonitorSnapshot): ThreadView[] {
  return [
    ...snapshot.projects.flatMap((project) => project.latestThread ? [project.latestThread, ...project.otherThreads] : []),
    ...snapshot.unassignedThreads,
  ];
}

function projectMatches(project: ProjectView, query: string): boolean {
  if (!query) return true;
  if (project.name.toLocaleLowerCase().includes(query)) return true;
  return [project.latestThread, ...project.otherThreads]
    .filter((thread): thread is ThreadView => thread !== null)
    .some((thread) => thread.title.toLocaleLowerCase().includes(query));
}

function unassignedMatches(threads: ThreadView[], query: string): boolean {
  if (threads.length === 0) return false;
  return !query || threads.some((thread) => thread.title.toLocaleLowerCase().includes(query));
}

function formatMetricValue<T>(metric: MetricValue<T>, formatter?: (value: T) => string): string {
  if (metric.value === null) return "N/A";
  return formatter ? formatter(metric.value) : String(metric.value);
}

// One English locale for all formatting, so dates don't mix with the browser's
// language. en-GB gives 24-hour times and unambiguous "16 Nov 2026" dates.
const DATE_LOCALE = "en-GB";

function formatRelativeDate(value: string): string {
  const difference = Date.now() - Date.parse(value);
  if (difference < 60_000) return "just now";
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} min ago`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} h ago`;
  if (difference < 604_800_000) return `${Math.floor(difference / 86_400_000)} d ago`;
  return new Intl.DateTimeFormat(DATE_LOCALE, { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function formatAbsoluteDate(value: string): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function formatReset(value: string): string {
  return new Intl.DateTimeFormat(DATE_LOCALE, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

/** "HH:mm" today, "Mon 17:34" within a week, otherwise "9 Nov 17:34". */
function formatClock(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const time = new Intl.DateTimeFormat(DATE_LOCALE, { hour: "2-digit", minute: "2-digit" }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  if (Math.abs(now.getTime() - date.getTime()) < 6 * 86_400_000) {
    return `${new Intl.DateTimeFormat(DATE_LOCALE, { weekday: "short" }).format(date)} ${time}`;
  }
  return `${new Intl.DateTimeFormat(DATE_LOCALE, { day: "numeric", month: "short" }).format(date)} ${time}`;
}

function formatAge(milliseconds: number): string {
  if (milliseconds < 1_500) return "just now";
  return `${Math.floor(milliseconds / 1_000)} s ago`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function initials(value: string): string {
  const parts = value.trim().split(/[\s-_]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : value.slice(0, 2)).toUpperCase();
}

function contextClass(value: number | null, state: MetricValue<unknown>["state"]): string {
  if (state === "unavailable") return "context-fill context-fill--unavailable";
  if ((value ?? 0) >= 80) return "context-fill context-fill--danger";
  if ((value ?? 0) >= 60) return "context-fill context-fill--warning";
  return `context-fill context-fill--${state}`;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return <svg className={expanded ? "chevron chevron--expanded" : "chevron"} viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>;
}

function ExternalIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M10 3h5v5M15 3l-7 7" /><path d="M14 10.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" /></svg>;
}

function OfflineIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.9 4.9 19.1 19.1M8.5 8.6A6 6 0 0 1 19 12M5 12a7 7 0 0 1 .7-3M8.5 15.5a5 5 0 0 1 7 0M12 19h.01" /></svg>;
}
