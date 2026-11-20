# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Preview: optional USB display support (`TOKENBEACON_DEVICE`, off by
  default). TokenBeacon finds a TokenBeacon display on macOS and Windows,
  verifies it with a handshake and sends only limit and context percentages
  with their freshness, following the documented `device-state/v1`
  protocol. The display firmware is not released yet.
- Preview: an Android phone as a wireless display over Bluetooth on macOS
  (`TOKENBEACON_DEVICE=ble`, off by default) with the TokenBeacon Display app
  in `android/` (build from source). Uses the same protocol as the USB
  display; the paired phone must prove its identity on every connection, and
  reconnects automatically. `npm run ble:unpair` forgets the paired phone.

## 0.2.0 - 2026-11-18

TokenBeacon now runs on Windows 11 as well as macOS. Tested on a real
Windows 11 computer with the Codex desktop app.

### Added

- Windows 11 support: Codex data is read from `%USERPROFILE%\.codex` (or
  `CODEX_HOME`), threads are matched to projects, “Open in Codex” opens the
  thread in the Codex app, and the home folder is hidden in titles.
- Windows installation and PowerShell/Command Prompt examples in the README.
- CI on Windows, including a PowerShell smoke test of `npm start`.

### Changed

- Compressed (archived) session logs are read with Node.js's built-in zstd
  support. The external `zstd` tool is no longer needed. Reading stops for a
  file that expands beyond 1 GiB, and single lines over 64 MiB are skipped, so
  a damaged or hostile file cannot exhaust memory.
- Terminal hints for the port and `CODEX_HOME` show PowerShell and Command
  Prompt commands on Windows instead of POSIX shell syntax. On Windows,
  `CODEX_HOME` also accepts `~\`.
- The notice for unreadable session logs no longer claims that Codex has no
  log; it says the logs are missing, damaged or outside the Codex data folder.
- CI runs on macOS and Windows with Node.js 24. Node.js 22.18 or newer stays
  supported.

### Fixed

- Session log paths that Codex writes with the Windows `\\?\` prefix are
  read instead of being refused; device paths such as `\\.\…` are still
  refused.
- Threads are matched to project folders regardless of letter case, slash
  style and the `\\?\` prefix on Windows.
- The home folder is hidden in titles in every common Windows spelling
  (`C:\Users\…`, `c:/users/…`, `\\?\C:\…`, Git Bash and WSL forms).
- Security tests run on Windows without symlink rights.

## 0.1.1 - 2026-11-17

### Added

- GitHub issue templates for bug reports and feature requests. Security
  problems are routed to private vulnerability reporting.

### Changed

- The threads table shows total tokens in a short form (for example `7.5M`).
  The exact count is in the tooltip, is read by screen readers, and stays in
  the thread details panel.
- Total tokens is now explained as cumulative usage for the whole thread
  (every turn, including cached input), not the current context: in the
  column tooltip, the thread details panel and “How to read these numbers”.
- The header shows “Data checked … ago” instead of “Updated … ago”, and limit
  cards say “Recorded by Codex at …”, so the time TokenBeacon read the data is
  no longer confused with the time Codex recorded the limits. Ages over a
  minute read as minutes or hours, and screen readers get the exact time.

## 0.1.0 - 2026-11-16

First release of TokenBeacon, the Usage & Context Dashboard for Codex.
Supports macOS only.

### Added

- Local web dashboard for Codex projects and threads: each project with its
  latest thread, expandable thread lists, threads without a project, and search.
- Per-thread metrics: model, reasoning effort, context used and left, token
  usage (input, cached input, output, reasoning, total), compactions and last
  activity.
- Account limits for the 5-hour and weekly windows: percentage used and left,
  reset time and the time Codex last recorded them.
- “Awaiting fresh data” state for limit windows that have ended, instead of
  showing the previous window's percentage.
- Freshness labels for every value: Current, Last known and Unavailable.
  Missing values are never estimated.
- “Open in Codex” deep links for threads with a valid thread ID.
- Thread details panel with context window, token breakdown and how the thread
  was assigned to its project.
- “How to read these numbers” help section.
- Plain-language notices when Codex data is missing, incomplete or in an
  unsupported format.
- Loading, offline and empty states; automatic reconnection.
- `CODEX_HOME` and `TOKENBEACON_PORT` configuration.
- `npm start` checks the Node.js version and builds the dashboard
  automatically when needed.
- `/api/health` with path-free status codes for troubleshooting.
- `scripts/create-demo-data.ts` to create a fictional Codex data folder for
  demos and screenshots.
- GitHub Actions CI on macOS with Node.js 22.18, 24 and 26.

### Security

- Server bound to `127.0.0.1` only; not configurable.
- DNS rebinding protection through strict `Host` validation, `Origin` and
  fetch metadata checks, no CORS, and a strict Content Security Policy with
  anti-framing and related headers.
- Read-only SQLite access with `query_only` enforced and verified; nothing is
  written to the Codex data folder.
- Session logs read only from inside the Codex `sessions/` and
  `archived_sessions/` folders after resolving symlinks.
- No file paths in API responses; project names and thread titles are
  sanitized; error details are reported as stable codes.
- No telemetry, no outbound network connections, no access to `auth.json`.
