# Codex Monitor

A local, read-only dashboard for your Codex projects and threads. It shows
context usage, token usage, compactions and your account limits at a glance,
using only the data Codex already stores on your machine.

> **Unofficial project.** Codex Monitor is an independent community project. It
> is not affiliated with, endorsed by, or sponsored by OpenAI. "Codex" and
> "ChatGPT" are trademarks of OpenAI.

**Status:** early and experimental (preparing v0.1.0). Tested on macOS.

## Features

- **Projects and threads** – every project with its most recent thread; expand
  a project to see the others. Threads without a project are listed separately.
- **Context window** – how full each thread's context is (used and left),
  calculated the same way Codex calculates “context left”.
- **Token usage** – input, cached input, output, reasoning and total tokens.
- **Compactions** – how often Codex compacted each conversation, and when.
- **Account limits** – the 5-hour and weekly limits: percentage used and left,
  when the window resets and when Codex last recorded the values.
- **Open in Codex** – jump straight to a thread in the Codex app.
- **Honest data labels** – every value is marked *Current*, *Last known* or
  *Unavailable*. Missing values are never estimated.
- **Search** across projects and thread titles.
- **Clear diagnostics** when Codex data is missing, incomplete or in an
  unsupported format.

## Privacy and security

Codex Monitor is built to be privacy-first and strictly read-only.

- **Local only.** The server listens on `127.0.0.1` and cannot be reached from
  your network. It makes no outbound connections: no telemetry, no analytics,
  no accounts, no cloud services.
- **Read-only.** Codex databases are opened read-only with SQLite's
  `query_only` mode enforced and verified. Nothing is ever written to the Codex
  data folder; caches live in memory only.
- **No credentials.** `auth.json` and other credential files are never read.
- **No inference.** The monitor never sends requests to OpenAI, never starts a
  Codex App Server and never runs a model to obtain numbers.
- **Minimal data in the browser.** The dashboard receives project names,
  thread titles, thread IDs and metrics. File paths and working directories are
  never sent to the browser.
- **Protected local API.** Requests with a foreign `Host` or `Origin` are
  rejected (DNS rebinding protection), no CORS access is granted, and every
  response carries a strict Content Security Policy.

### What it reads

From your Codex data folder (`CODEX_HOME`, default `~/.codex`):

| File | Used for |
| --- | --- |
| `state_5.sqlite` | projects, project folders, threads |
| `thread_history_1.sqlite` | context compaction history |
| `sqlite/codex.db` | the Codex app's thread list (which threads are visible) |
| `sessions/**/rollout-*.jsonl[.zst]`, `archived_sessions/**/…` | model, token, context and limit data |

Session logs are only read if their real location (after resolving symlinks)
is inside `sessions/` or `archived_sessions/`.

## Requirements

- **macOS.** This is the tested platform. Linux may work but has not been
  verified with real Codex data yet. Windows is not supported.
- **Node.js 22.18 or newer** (an LTS release is recommended). The app uses the
  built-in `node:sqlite` module and runs TypeScript directly.
- **Codex** installed and used at least once on this machine.
- **zstd** to read archived threads: `brew install zstd`. Without it, archived
  threads show token and context values as unavailable.

## Installation

```sh
git clone https://github.com/msuranek/codex-monitor.git
cd codex-monitor
npm install
npm start
```

Then open <http://127.0.0.1:4310>.

- The first `npm start` builds the dashboard automatically.
- The server is available immediately; reading your Codex data can take a few
  seconds on the first start, while the dashboard shows a loading state.
- Stop the server with `Ctrl+C`.

To update, run `git pull`, then `npm install` and `npm start`. The dashboard is
rebuilt automatically when its sources change.

`npm ci` installs exactly the versions in `package-lock.json`. All npm
packages are build tools; the server itself uses only Node.js built-ins.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Location of your Codex data folder. Use the same value Codex uses. |
| `CODEX_MONITOR_PORT` | `4310` | Local port for the dashboard. |

```sh
CODEX_HOME=/path/to/codex-data npm start
CODEX_MONITOR_PORT=4311 npm start
```

The server always binds to `127.0.0.1`. This is intentional and not
configurable: the dashboard has no login, so it must not be exposed to a
network.

## Reading the dashboard

- **Current** values were just read from an active session or the local
  database. **Last known** values are the latest ones Codex recorded and may be
  out of date. **Unavailable (N/A)** means Codex didn't record the value or it
  couldn't be read.
- **Context used** is how full a thread's context window is; context left is
  the rest (58% used = 42% left). The bar turns amber at 60% and red at 80%.
- **Account limits** show how much of each usage window is used. Codex records
  limits only while you use it, so they are always *last known*. When a window
  has ended and no newer data exists, the card shows **Awaiting fresh data**
  instead of the old percentage. It updates after your next Codex request.
- **Project assignment.** Most threads are linked to a project by Codex. If a
  thread has no link, the monitor matches its working folder to a project
  folder; such matches are shown as *Matched by folder (estimate)* in the
  thread details.

The dashboard includes a short “How to read these numbers” section below the
table.

## Known limitations

- **Unofficial data formats.** Codex Monitor reads Codex's internal local
  storage, which is not a public API and can change with any Codex update. The
  monitor detects the schema and degrades gracefully (missing values become
  *Unavailable*), but new Codex versions may need updates.
- **Limits are only as fresh as the last local Codex request.** Usage from
  other devices, the web or cloud tasks is not visible until Codex on this Mac
  records new limit data.
- **Project assignment by folder is an estimate** and can be wrong for nested
  or moved folders.
- **Thread visibility** follows the Codex app's thread list. If that list is
  unavailable, an estimate is used and the dashboard says so.
- **Open in Codex** has been verified with the Codex desktop app on macOS only.
- **Large histories:** the first start can take several seconds while archived
  threads are decompressed. The dashboard refreshes every 5 seconds.
- **Single user, local machine.** There is no authentication. Do not put the
  monitor behind a reverse proxy or expose it to a network.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| “Codex data not found” | Open Codex once, or set `CODEX_HOME` to your Codex data folder. |
| “Port 4310 is already in use” | Codex Monitor may already be running: open <http://127.0.0.1:4310>. Otherwise start with `CODEX_MONITOR_PORT=4311 npm start`. |
| “Codex Monitor cannot run on this Node.js runtime” | Install Node.js 22.18 or newer (LTS recommended). |
| Archived threads show N/A | Install zstd: `brew install zstd`. |
| Many values show N/A | Your Codex version may store data differently. The notice above the table explains which data is missing. |
| A limit shows “Awaiting fresh data” | The usage window has ended. Make any request in Codex; the card updates automatically. |
| “The local server isn't running” | Start it with `npm start`; the page reconnects automatically. |

For a technical overview of each data source, open
<http://127.0.0.1:4310/api/health>. It lists every source with a short status
code and never contains file paths or conversation content, so it is safe to
include in a bug report.

## Development

```sh
npm run dev        # Vite dev server on http://127.0.0.1:5173 (run npm start as the API backend)
npm test           # functional and security tests with synthetic data only
npm run check      # typecheck + tests + production build
npm run test:live  # optional smoke test against your own Codex data (read-only)
npm run bench      # optional refresh benchmark against your own Codex data
```

`npm test` never reads your real Codex data: it builds temporary Codex folders
with synthetic data. See [CONTRIBUTING.md](CONTRIBUTING.md).

Project layout:

```text
src/main.mjs            entry point: runtime check, dashboard build, start
src/start.ts            starts the HTTP server and background refresh
src/http-server.ts      local API and static files, request validation
src/snapshot-service.ts builds the normalized snapshot
src/limits.ts           account limit selection and window expiry
src/sources/            read-only SQLite and rollout readers
src/client/             React dashboard
tests/                  automated tests (synthetic fixtures)
```

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
