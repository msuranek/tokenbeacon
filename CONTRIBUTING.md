# Contributing to TokenBeacon

Thank you for your interest in improving TokenBeacon. This guide explains
how to set up the project and what we expect from changes.

## Principles

Every change must keep these properties:

- **Read-only.** Never write to, migrate or lock anything in the Codex data
  folder. SQLite connections stay read-only with `query_only` enforced.
- **Local and private.** No telemetry, no outbound network requests, no cloud
  services. The server binds to `127.0.0.1` only.
- **No credentials.** Never read `auth.json` or other credential files.
- **No estimates.** If a value is not recorded by Codex, show it as
  unavailable instead of guessing.
- **Minimal data.** Do not send file paths or other data the dashboard does
  not need to the browser.

## Development setup

Requirements: macOS and Node.js 22.18 or newer.

```sh
npm install
npm start          # dashboard and API on http://127.0.0.1:4310
npm run dev        # optional: Vite dev server on http://127.0.0.1:5173
```

## Tests

```sh
npm test           # required: functional and security tests (synthetic data only)
npm run check      # required before a pull request: typecheck + tests + build
npm run test:live  # optional: smoke test against your own Codex data
npm run bench      # optional: refresh benchmark against your own Codex data
```

- Tests must not depend on a real Codex installation. Use the synthetic
  fixtures in `tests/helpers/fixture-codex-home.ts`.
- For screenshots and manual testing, use fictional data from
  `node scripts/create-demo-data.ts <empty-directory>`.
- CI runs typecheck, tests, build and a start-up smoke test on macOS and
  Windows with Node.js 24.
- Add a test for every bug fix and for every new data source or field.
- Security-relevant code (HTTP validation, path handling, sanitizing) needs
  tests for the rejected cases too.

## Never commit personal data

Do not commit real Codex data or anything derived from it:

- databases (`*.sqlite`, `*.db`), session logs (`rollout-*.jsonl*`),
  `auth.json`, `.env` files,
- real project names, thread titles, thread IDs or file paths,
- screenshots, logs or API output from your own installation.

Use synthetic names such as `Alpha`, `Beta` or `Example thread` in tests,
issues and screenshots. The `.gitignore` blocks the most common cases, but
please check `git status` before every commit.

## Code style

- TypeScript with `strict` mode; only erasable TypeScript syntax (the server
  runs `.ts` files directly through Node.js type stripping).
- Keep the server free of runtime npm dependencies. Discuss new dependencies
  in an issue first.
- Prefer small, focused changes over large refactors.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>: <short subject in English, max ~72 characters>

<optional body explaining what changed and why>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
`chore`, `security`.

Before opening a pull request:

1. `npm run check` passes.
2. New behaviour is covered by tests.
3. User-facing changes are reflected in `README.md`.
4. No personal data is included (see above).

## Reporting bugs

Open an issue with the **Bug report** template. It asks for the steps to
reproduce, your operating system, Node.js and Codex versions, and the output of
`http://127.0.0.1:4310/api/health`. That output contains only status codes.
Please do not attach your Codex data. Ideas go into a **Feature request**.

For security problems, follow [SECURITY.md](SECURITY.md) instead.
