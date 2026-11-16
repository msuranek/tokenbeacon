# Security Policy

## Supported versions

Codex Monitor is in early development. Security fixes are made on the `main`
branch and included in the next release.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
(GitHub private vulnerability reporting).

Please include:

- a description of the problem and its impact,
- steps to reproduce,
- the Codex Monitor version or commit, Node.js version and operating system.

**Do not include your own Codex data** (conversation titles, project names,
database files, session logs or `auth.json`). Synthetic examples are enough.
The output of `/api/health` contains only status codes and is safe to share.

We aim to acknowledge reports within a week.

## Security model

Codex Monitor is a single-user tool that runs on your own machine.

In scope:

- reading local Codex data through the dashboard or API from another website,
  another origin or via DNS rebinding,
- access from other machines on the network,
- writing to, modifying or deleting anything in the Codex data folder,
- reading files outside the documented Codex data files (for example through
  path traversal or symlinks),
- exposure of credentials, file paths or other data that the dashboard does not
  need,
- injection of active content through project names or thread titles.

Out of scope:

- other programs running as the same user on the same machine (they can read
  the Codex data folder directly),
- exposing the monitor to a network on purpose, for example through a reverse
  proxy or port forwarding; this is not supported,
- vulnerabilities in Codex itself; please report those to OpenAI.

## Design safeguards

- The server binds to `127.0.0.1` only; this is not configurable.
- Requests are rejected unless the `Host` header is `127.0.0.1:<port>` or
  `localhost:<port>`, and any `Origin` header matches the dashboard's own
  origin. Cross-site fetch metadata is rejected for the API.
- No CORS access is granted. Responses carry a strict Content Security Policy,
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`.
- SQLite databases are opened read-only with `query_only` enforced.
- Session logs are read only from inside the Codex `sessions/` and
  `archived_sessions/` folders after resolving symlinks.
- The API never returns file paths, and errors are reported as stable codes.
- No telemetry and no outbound network connections.
