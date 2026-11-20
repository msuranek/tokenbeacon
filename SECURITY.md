# Security Policy

## Supported versions

TokenBeacon is in early development. Security fixes are made on the `main`
branch and included in the next release.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
(GitHub private vulnerability reporting).

Please include:

- a description of the problem and its impact,
- steps to reproduce,
- the TokenBeacon version or commit, Node.js version and operating system.

**Do not include your own Codex data** (conversation titles, project names,
database files, session logs or `auth.json`). Synthetic examples are enough.
The output of `/api/health` contains only status codes and is safe to share.

We aim to acknowledge reports within a week.

## Security model

TokenBeacon is a single-user tool that runs on your own machine.

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
  `archived_sessions/` folders after resolving symlinks. On Windows the
  comparison ignores letter case, the `\\?\` prefix is normalized and device
  paths (`\\.\…`, `\\?\GLOBALROOT…`) are refused.
- Compressed session logs are decompressed in-process with a 1 GiB output
  limit per file; lines over 64 MiB are skipped.
- The API never returns file paths, and errors are reported as stable codes.
- No telemetry and no outbound network connections.
- The optional USB display (`TOKENBEACON_DEVICE`, off by default) uses only
  the local USB serial port. TokenBeacon opens a port only if it identifies as
  a TokenBeacon display (Espressif USB vendor ID and the product name
  “TokenBeacon Display”) or the user named it, and keeps it only after a
  handshake with a random nonce. It sends only limit and context percentages
  with their freshness – no names, IDs, paths or token counts – and treats
  everything the device sends as untrusted, bounded input. To find the port it
  runs fixed system tools without a shell: `ioreg` and `stty` on macOS, the
  built-in Windows PowerShell with a fixed script on Windows. The device never
  changes the dashboard or the overall `/api/health` status.
- The optional Bluetooth display (`TOKENBEACON_DEVICE=ble`, macOS only, off by
  default) sends the same data to the TokenBeacon Display Android app. The Mac
  only connects out to a phone advertising the TokenBeacon service; it does not
  advertise or accept Bluetooth connections. The phone requires an encrypted,
  authenticated link (system pairing with number comparison). The phone holds
  an ECDSA P-256 key in the Android Keystore; on every connection, including
  automatic reconnects, it must sign a fresh random challenge. TokenBeacon
  never trusts a phone on its own, because macOS does not tell it whether a
  Bluetooth link is encrypted: a phone is paired only with `npm run ble:pair`,
  where the user types the full 16-digit display ID (a fingerprint of the
  phone's key) shown on the phone. Only that key is accepted afterwards, and
  only its public key is stored (`~/Library/Application Support/TokenBeacon`,
  owner-only file). Without a pairing, no Bluetooth code runs.
  `TOKENBEACON_DEVICE_ID` only selects a phone and grants no trust. Bluetooth
  runs in a small helper app built locally from source with fixed tool
  arguments (`xcrun swiftc`, ad-hoc `codesign`) into
  `~/Library/Caches/TokenBeacon`, rebuilt only when its sources change, and
  started with `/usr/bin/open`, so macOS grants Bluetooth to the helper alone.
  It talks to TokenBeacon over a private Unix socket (owner-only directory,
  one-time token, closed after the helper connects). The Android app has no
  internet, location or storage permission.
