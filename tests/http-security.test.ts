import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  CONTENT_SECURITY_POLICY,
  createMonitorServer,
  isAllowedHost,
  isAllowedOrigin,
  listenLoopback,
  parsePort,
} from "../src/http-server.ts";
import { sanitizeDisplayText, threadDeepLink } from "../src/sanitize.ts";
import { SnapshotService } from "../src/snapshot-service.ts";
import type { LocalDataSource, LocalSnapshotRows } from "../src/sources/local-data.ts";
import type { RolloutCache } from "../src/sources/rollouts.ts";
import type { MonitorSnapshot, RolloutTelemetry } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Synthetic, test-only fixtures. No real Codex data is read in this file.
// ---------------------------------------------------------------------------

const HOME = homedir();
const THREAD_UUID = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OTHER_UUID = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const PROJECT_UUID = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
const SECRET_ROOT = path.join(HOME, "secret-work", "client-acme");
const SECRET_CWD = path.join(SECRET_ROOT, "packages", "api");
const SECRET_ROLLOUT = path.join(HOME, ".codex", "sessions", "2026", "rollout-secret.jsonl");

function fixtureRows(): LocalSnapshotRows {
  const now = Date.now();
  return {
    projects: [
      {
        id: PROJECT_UUID,
        name: "Acme‮gnp.exe\u0007 project",
        updatedAtMs: now,
        rootPaths: [SECRET_ROOT],
      },
    ],
    threads: [
      {
        id: THREAD_UUID,
        title: `Fix bug in ${SECRET_CWD}/index.ts\nsecond line\u0000⁦`,
        rolloutPath: SECRET_ROLLOUT,
        createdAtMs: now,
        updatedAtMs: now,
        recencyAtMs: now,
        cwd: SECRET_CWD,
        model: "gpt-test",
        reasoningEffort: "high",
        tokensUsed: 100,
        projectId: null,
        archived: false,
        catalogProjectId: null,
        catalogRecencyAtMs: now,
      },
      {
        id: "javascript:alert(1)//",
        title: "x".repeat(5_000),
        rolloutPath: `${SECRET_ROLLOUT}.zst`,
        createdAtMs: now,
        updatedAtMs: now,
        recencyAtMs: now - 1_000,
        cwd: "/elsewhere",
        model: null,
        reasoningEffort: null,
        tokensUsed: 0,
        projectId: null,
        archived: false,
        catalogProjectId: null,
        catalogRecencyAtMs: now - 1_000,
      },
      {
        id: OTHER_UUID,
        title: "",
        rolloutPath: SECRET_ROLLOUT,
        createdAtMs: now,
        updatedAtMs: now,
        recencyAtMs: now - 2_000,
        cwd: SECRET_ROOT,
        model: null,
        reasoningEffort: null,
        tokensUsed: 0,
        projectId: PROJECT_UUID,
        archived: false,
        catalogProjectId: null,
        catalogRecencyAtMs: now - 2_000,
      },
    ],
    compactions: new Map(),
    visibility: "catalog",
    sources: {
      codexHome: { state: "ok", detail: null },
      stateDb: { state: "ok", detail: null },
      historyDb: { state: "ok", detail: null },
      desktopCatalog: { state: "ok", detail: null },
    },
    watermarks: { stateDb: "2026-11-16T00:00:00.000Z", historyDb: "2026-11-16T00:00:00.000Z", desktopDb: "2026-11-16T00:00:00.000Z" },
  };
}

const fakeLocal = {
  codexHome: path.join(HOME, ".codex"),
  read: () => fixtureRows(),
} as unknown as LocalDataSource;

const fakeRollouts = {
  async readMany(paths: string[]) {
    return new Map<string, RolloutTelemetry | null>(paths.map((p) => [p, null]));
  },
  stats: () => ({ entries: 0, hits: 0, misses: 0, decompressions: 0 }),
  lastIssues: () => ({ missing: 0, outsideStorage: 0, invalidName: 0, zstdMissing: 0, failed: 0 }),
} as unknown as RolloutCache;

async function fixtureSnapshot(): Promise<MonitorSnapshot> {
  return new SnapshotService(fakeLocal, fakeRollouts).refresh();
}

// ---------------------------------------------------------------------------
// HTTP helpers. node:http is used directly because fetch() cannot set Host.
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path ?? "/api/snapshot",
        method: options.method ?? "GET",
        headers: { Host: `127.0.0.1:${port}`, ...options.headers },
        setHost: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Raw socket request for cases node:http refuses to produce (no/duplicate Host). */
function sendRaw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write(payload);
  });
}

function statusOf(raw: string): number {
  return Number(raw.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
}

// ---------------------------------------------------------------------------

describe("local HTTP API security", () => {
  let server: Server;
  let port: number;
  let snapshot: MonitorSnapshot;
  let refreshError: Error | null = null;
  let workDir: string;

  before(async () => {
    snapshot = await fixtureSnapshot();
    workDir = mkdtempSync(path.join(tmpdir(), "tokenbeacon-test-"));
    const distRoot = path.join(workDir, "dist");
    mkdirSync(path.join(distRoot, "assets"), { recursive: true });
    writeFileSync(path.join(distRoot, "index.html"), "<!doctype html><title>INDEX</title>");
    writeFileSync(path.join(distRoot, "assets", "app.js"), "console.log('app')");
    writeFileSync(path.join(workDir, "outside-secret.txt"), "TOP-SECRET-OUTSIDE-DIST");
    symlinkSync(path.join(workDir, "outside-secret.txt"), path.join(distRoot, "assets", "link.txt"));
    server = createMonitorServer({
      getSnapshot: () => snapshot,
      getError: () => refreshError,
      distRoot,
    });
    port = (await listenLoopback(server, 0)).port;
  });

  after(() => {
    server.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  describe("loopback binding", () => {
    test("listens on 127.0.0.1 only", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      assert.equal(address.address, "127.0.0.1");
      assert.equal(address.family, "IPv4");
    });

    test("port parsing rejects garbage instead of falling back silently", () => {
      assert.equal(parsePort(undefined), 4310);
      assert.equal(parsePort("8080"), 8080);
      for (const bad of ["0", "65536", "-1", "80abc", "1e3", " 80", "0x50"]) {
        assert.throws(() => parsePort(bad), /TOKENBEACON_PORT/);
      }
    });
  });

  describe("localhost access keeps working", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST"]) {
      test(`Host ${host}:<port> receives the snapshot`, async () => {
        const res = await send(port, { headers: { Host: `${host}:${port}` } });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body) as MonitorSnapshot;
        assert.ok(Array.isArray(body.projects));
        assert.ok(Array.isArray(body.unassignedThreads));
      });
    }

    test("same-origin dashboard fetch (Origin + Sec-Fetch-Site) is allowed", async () => {
      for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
        const res = await send(port, {
          headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
        });
        assert.equal(res.status, 200, origin);
      }
    });

    test("direct navigation (Sec-Fetch-Site: none) is allowed", async () => {
      const res = await send(port, { headers: { "Sec-Fetch-Site": "none" } });
      assert.equal(res.status, 200);
    });

    test("health endpoint reports ok", async () => {
      const res = await send(port, { path: "/api/health" });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(["ok", "degraded"].includes(body.status));
      assert.equal(body.error, null);
      assert.ok(Array.isArray(body.sources));
    });

    test("dashboard HTML and assets are served", async () => {
      const index = await send(port, { path: "/" });
      assert.equal(index.status, 200);
      assert.match(index.body, /INDEX/);
      const asset = await send(port, { path: "/assets/app.js" });
      assert.equal(asset.status, 200);
      assert.match(String(asset.headers["content-type"]), /javascript/);
      const spa = await send(port, { path: "/some/client/route" });
      assert.equal(spa.status, 200);
      assert.match(spa.body, /INDEX/);
    });

    test("unknown API routes return 404", async () => {
      const res = await send(port, { path: "/api/nope" });
      assert.equal(res.status, 404);
    });
  });

  describe("DNS rebinding and Host validation", () => {
    const badHosts = (p: number) => [
      `attacker.example:${p}`, // classic DNS rebinding: attacker name resolving to 127.0.0.1
      `127.0.0.1.nip.io:${p}`,
      `localhost.:${p}`,
      `sub.localhost:${p}`,
      `127.0.0.1:${p + 1}`, // wrong port
      `localhost:${p}0`,
      "127.0.0.1", // missing port
      "localhost",
      `0.0.0.0:${p}`,
      `[::1]:${p}`,
      `127.1:${p}`,
      `2130706433:${p}`,
      `127.0.0.1:${p}@attacker.example`,
      `127.0.0.1:${p}/x`,
      `127.0.0.1:${p},attacker.example`,
      "",
    ];

    test("every non-allowlisted Host is rejected before routing", async () => {
      for (const host of badHosts(port)) {
        for (const pathName of ["/api/snapshot", "/api/health", "/", "/assets/app.js"]) {
          const res = await send(port, { path: pathName, headers: { Host: host } });
          assert.equal(res.status, 421, `Host ${JSON.stringify(host)} ${pathName}`);
          assert.deepEqual(JSON.parse(res.body), { error: "invalid_host" });
        }
      }
    });

    test("rebinding attempt with same-origin browser headers is still rejected", async () => {
      // After a rebind, the attacker page is "same-origin" with itself.
      const res = await send(port, {
        headers: {
          Host: `rebind.attacker.example:${port}`,
          Origin: `http://rebind.attacker.example:${port}`,
          "Sec-Fetch-Site": "same-origin",
        },
      });
      assert.equal(res.status, 421);
      assert.ok(!res.body.includes(THREAD_UUID));
    });

    test("request without Host header is rejected", async () => {
      const raw = await sendRaw(port, "GET /api/snapshot HTTP/1.0\r\n\r\n");
      assert.equal(statusOf(raw), 421);
      assert.ok(!raw.includes(THREAD_UUID));
    });

    test("duplicate Host headers are rejected", async () => {
      const raw = await sendRaw(
        port,
        `GET /api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: attacker.example:${port}\r\nConnection: close\r\n\r\n`,
      );
      assert.ok([400, 421].includes(statusOf(raw)), raw.slice(0, 40));
      assert.ok(!raw.includes(THREAD_UUID));
    });

    test("absolute-form (proxy style) request targets are rejected", async () => {
      const raw = await sendRaw(
        port,
        `GET http://attacker.example/api/snapshot HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      assert.equal(statusOf(raw), 400);
      assert.ok(!raw.includes(THREAD_UUID));
    });

    test("host predicate unit cases", () => {
      assert.equal(isAllowedHost(`127.0.0.1:${port}`, port), true);
      assert.equal(isAllowedHost(`localhost:${port}`, port), true);
      assert.equal(isAllowedHost(undefined, port), false);
      assert.equal(isAllowedHost("localhost", 80), true);
      assert.equal(isAllowedHost("x".repeat(100), port), false);
    });
  });

  describe("cross-origin requests and CORS", () => {
    const foreignOrigins = (p: number) => [
      "https://attacker.example",
      "http://attacker.example",
      `http://127.0.0.1:${p + 1}`, // other local web app
      `http://localhost:${p + 1}`,
      `https://127.0.0.1:${p}`, // scheme mismatch
      `http://[::1]:${p}`,
      "null", // sandboxed iframe / file:// / data: origin
      `http://127.0.0.1:${p}.attacker.example`,
    ];

    test("foreign Origin is rejected on API and static routes", async () => {
      for (const origin of foreignOrigins(port)) {
        for (const pathName of ["/api/snapshot", "/api/health", "/"]) {
          const res = await send(port, { path: pathName, headers: { Origin: origin } });
          assert.equal(res.status, 403, `${origin} ${pathName}`);
          assert.ok(!res.body.includes(THREAD_UUID));
          assert.equal(res.headers["access-control-allow-origin"], undefined);
        }
      }
    });

    test("cross-site and same-site fetch metadata are rejected for the API", async () => {
      for (const site of ["cross-site", "same-site", "bogus"]) {
        const res = await send(port, { headers: { "Sec-Fetch-Site": site } });
        assert.equal(res.status, 403, site);
        assert.deepEqual(JSON.parse(res.body), { error: "forbidden_cross_site" });
      }
    });

    test("no-cors embedding (<script src>) is blocked by fetch metadata", async () => {
      const res = await send(port, {
        headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "script" },
      });
      assert.equal(res.status, 403);
    });

    test("CORS preflight is refused and never grants access", async () => {
      const res = await send(port, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-anything",
        },
      });
      assert.ok(res.status >= 400);
      for (const name of Object.keys(res.headers)) {
        assert.ok(!name.startsWith("access-control-"), `unexpected ${name}`);
      }
    });

    test("no response ever carries CORS headers", async () => {
      const cases = [
        await send(port),
        await send(port, { path: "/api/health" }),
        await send(port, { path: "/" }),
        await send(port, { method: "OPTIONS" }),
        await send(port, { headers: { Origin: `http://localhost:${port}` } }),
      ];
      for (const res of cases) {
        for (const name of Object.keys(res.headers)) {
          assert.ok(!name.startsWith("access-control-"), `unexpected ${name}`);
        }
      }
    });

    test("origin predicate unit cases", () => {
      assert.equal(isAllowedOrigin(undefined, port), true);
      assert.equal(isAllowedOrigin(`http://127.0.0.1:${port}`, port), true);
      assert.equal(isAllowedOrigin(`http://127.0.0.1:${port}/`, port), false);
      assert.equal(isAllowedOrigin("null", port), false);
    });
  });

  describe("methods and static file boundaries", () => {
    test("non-GET methods receive 405 and no data", async () => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
        const res = await send(port, { method });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.allow, "GET");
        assert.ok(!res.body.includes(THREAD_UUID));
      }
    });

    test("path traversal cannot read files outside dist", async () => {
      for (const attempt of [
        "/../outside-secret.txt",
        "/%2e%2e/outside-secret.txt",
        "/assets/%2e%2e%2f%2e%2e%2foutside-secret.txt",
        "/..%5coutside-secret.txt",
        "/assets/link.txt", // symlink pointing outside dist
      ]) {
        const res = await send(port, { path: attempt });
        assert.ok(!res.body.includes("TOP-SECRET-OUTSIDE-DIST"), attempt);
      }
    });

    test("NUL bytes and malformed escapes are rejected", async () => {
      assert.equal((await send(port, { path: "/%00" })).status, 400);
      assert.equal((await send(port, { path: "/%E0%A4%A" })).status, 400);
    });
  });

  describe("security headers", () => {
    test("present on API, static, and error responses", async () => {
      const cases = [
        await send(port),
        await send(port, { path: "/" }),
        await send(port, { headers: { Host: "attacker.example" } }),
        await send(port, { method: "POST" }),
      ];
      for (const res of cases) {
        assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
        assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
        assert.equal(res.headers["x-content-type-options"], "nosniff");
        assert.equal(res.headers["x-frame-options"], "DENY");
        assert.equal(res.headers["referrer-policy"], "no-referrer");
        assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
        assert.equal(res.headers["cache-control"], "no-store");
      }
    });

    test("CSP allows no remote, inline, or eval sources", () => {
      assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(CONTENT_SECURITY_POLICY));
    });
  });

  describe("sensitive metadata minimization", () => {
    test("snapshot JSON contains no paths, home directory, or rollout locations", async () => {
      const res = await send(port);
      assert.equal(res.status, 200);
      for (const forbidden of [HOME, SECRET_ROOT, SECRET_CWD, SECRET_ROLLOUT, "rollout-secret", ".codex"]) {
        assert.ok(!res.body.includes(forbidden), `leaked ${forbidden}`);
      }
      for (const key of ["rootPaths", "cwd", "rolloutPath", "rollout_path", "catalogProjectId"]) {
        assert.ok(!res.body.includes(`"${key}"`), `leaked key ${key}`);
      }
    });

    test("project and thread names are sanitized", () => {
      const project = snapshot.projects[0];
      assert.equal(project.name, "Acme gnp.exe project");
      const threads = [
        ...snapshot.projects.flatMap((p) => (p.latestThread ? [p.latestThread, ...p.otherThreads] : [])),
        ...snapshot.unassignedThreads,
      ];
      const byId = new Map(threads.map((thread) => [thread.id, thread]));
      const pathTitle = byId.get(THREAD_UUID)!.title;
      assert.equal(pathTitle, "Fix bug in ~/secret-work/client-acme/packages/api/index.ts second line");
      const longTitle = byId.get("javascript:alert(1)//")!.title;
      assert.ok(Array.from(longTitle).length <= 300);
      assert.ok(longTitle.endsWith("…"));
      assert.equal(byId.get(OTHER_UUID)!.title, "Untitled");
      for (const thread of threads) {
        assert.ok(!/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(thread.title));
      }
    });

    test("deep links are only produced for UUID thread IDs", async () => {
      const body = JSON.parse((await send(port)).body) as MonitorSnapshot;
      const threads = [
        ...body.projects.flatMap((p) => (p.latestThread ? [p.latestThread, ...p.otherThreads] : [])),
        ...body.unassignedThreads,
      ];
      const byId = new Map(threads.map((thread) => [thread.id, thread]));
      assert.equal(byId.get(THREAD_UUID)!.openTarget.value, `codex://threads/${THREAD_UUID}`);
      const unsafe = byId.get("javascript:alert(1)//")!;
      assert.equal(unsafe.openTarget.value, null);
      assert.equal(unsafe.openTarget.state, "unavailable");
      assert.equal(threadDeepLink("../../etc/passwd"), null);
    });

    test("health never exposes raw error messages", async () => {
      refreshError = new Error(`ENOENT: no such file or directory, open '${HOME}/.codex/state_5.sqlite'`);
      try {
        const res = await send(port, { path: "/api/health" });
        const body = JSON.parse(res.body);
        assert.equal(body.status, "degraded");
        assert.equal(body.error, "refresh_failed");
        assert.ok(!res.body.includes(HOME));
        assert.ok(!res.body.includes("state_5"));
      } finally {
        refreshError = null;
      }
    });

    test("rejection bodies never contain snapshot data", async () => {
      const rejected = [
        await send(port, { headers: { Host: `evil.example:${port}` } }),
        await send(port, { headers: { Origin: "https://evil.example" } }),
        await send(port, { headers: { "Sec-Fetch-Site": "cross-site" } }),
      ];
      for (const res of rejected) {
        assert.ok(res.body.length < 64, res.body);
        assert.ok(!res.body.includes(THREAD_UUID));
        assert.ok(!res.body.includes("Acme"));
      }
    });
  });
});

describe("display text sanitizer", () => {
  test("removes controls and bidi overrides, redacts home, bounds length", () => {
    assert.equal(sanitizeDisplayText("a‮b\u0000c", 50, "-", "/Users/someone"), "a b c");
    assert.equal(sanitizeDisplayText("/Users/someone/x and /Users/someone", 50, "-", "/Users/someone"), "~/x and ~");
    assert.equal(sanitizeDisplayText(42, 50, "fallback"), "fallback");
    assert.equal(sanitizeDisplayText("   \n\t ", 50, "fallback"), "fallback");
    assert.equal(sanitizeDisplayText("abcdef", 4, "-"), "abc…");
    assert.equal(sanitizeDisplayText("👨‍👩‍👧 rodina", 50, "-"), "👨‍👩‍👧 rodina");
    assert.equal(sanitizeDisplayText("<img src=x onerror=alert(1)>", 50, "-"), "<img src=x onerror=alert(1)>");
  });
});
