import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import { ensureFrontendBuild, frontendBuildState } from "../src/frontend-build.mjs";
import { SnapshotService } from "../src/snapshot-service.ts";
import { LocalDataSource } from "../src/sources/local-data.ts";
import { describeDataProblems, describeListenError, startMonitor, StartupError } from "../src/start.ts";
import { startCommandLines } from "../src/platform-hints.ts";
import type { MonitorSnapshot } from "../src/types.ts";
import { createFixtureCodexHome, createTempRoot } from "./helpers/fixture-codex-home.ts";

const quiet = { log: () => undefined, warn: () => undefined };

function get(
  port: number,
  pathName: string,
  agent?: Agent,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: pathName, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A service whose first refresh only finishes when the test says so. */
function controllableService(snapshot: () => Promise<MonitorSnapshot>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const service = {
    current: null as MonitorSnapshot | null,
    error: null as Error | null,
    get loading() {
      return this.current === null && this.error === null;
    },
    localData: { codexHome: "/fixture/codex" },
    async refresh() {
      await gate;
      this.current = await snapshot();
      return this.current;
    },
    start() {},
    stop() {},
  };
  return { service: service as unknown as SnapshotService, release };
}

describe("startup", () => {
  test("listens before the first refresh finishes and reports loading", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const real = new SnapshotService(new LocalDataSource(fixture.codexHome));
    const { service, release } = controllableService(() => real.refresh());

    const monitor = await startMonitor({ port: 0, distRoot: path.join(fixture.root, "no-dist"), service, ...quiet });
    t.after(() => monitor.stop());
    const port = monitor.address.port;

    const loading = await get(port, "/api/snapshot");
    assert.equal(loading.status, 503);
    assert.deepEqual(JSON.parse(loading.body), { error: "snapshot_loading" });
    assert.equal(loading.headers["retry-after"], "1");
    const health = JSON.parse((await get(port, "/api/health")).body);
    assert.equal(health.status, "loading");

    release();
    await monitor.firstRefresh;
    const ready = await get(port, "/api/snapshot");
    assert.equal(ready.status, 200);
    assert.equal(JSON.parse(ready.body).projects.length, 2);
  });

  test("a failed first refresh is reported as unavailable, not loading", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const failing = {
      current: null,
      error: new Error("boom /private/path"),
      loading: false,
      localData: { codexHome: root },
      refresh: () => Promise.reject(new Error("boom")),
      start() {},
      stop() {},
    } as unknown as SnapshotService;
    const monitor = await startMonitor({ port: 0, distRoot: root, service: failing, ...quiet });
    t.after(() => monitor.stop());
    await monitor.firstRefresh;
    const response = await get(monitor.address.port, "/api/snapshot");
    assert.deepEqual(JSON.parse(response.body), { error: "snapshot_unavailable" });
    assert.ok(!response.body.includes("/private/path"));
  });

  test("real service on fixture data becomes ready", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const lines: string[] = [];
    const monitor = await startMonitor({
      port: 0,
      distRoot: path.join(fixture.root, "no-dist"),
      service: new SnapshotService(new LocalDataSource(fixture.codexHome)),
      log: (line) => lines.push(line),
      warn: (line) => lines.push(line),
    });
    t.after(() => monitor.stop());
    await monitor.firstRefresh;
    assert.equal((await get(monitor.address.port, "/api/snapshot")).status, 200);
    assert.ok(lines.some((line) => line.includes(`http://127.0.0.1:${monitor.address.port}`)));
    assert.ok(lines.some((line) => /Loaded 5 threads/.test(line)));
  });

  test("occupied port produces a readable StartupError", async (t) => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    t.after(() => blocker.close());
    const port = (blocker.address() as { port: number }).port;
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);

    await assert.rejects(
      startMonitor({
        port,
        distRoot: root,
        service: new SnapshotService(new LocalDataSource(path.join(root, "missing"))),
        ...quiet,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StartupError);
        assert.equal(error.code, "EADDRINUSE");
        assert.match(error.message, new RegExp(`Port ${port} is already in use`));
        assert.match(error.message, /TOKENBEACON_PORT=/);
        assert.ok(!/\n\s+at /.test(error.message), "no stack trace in message");
        return true;
      },
    );
  });

  test("stop() closes idle keep-alive connections promptly", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const monitor = await startMonitor({
      port: 0,
      distRoot: root,
      service: new SnapshotService(new LocalDataSource(path.join(root, "missing"))),
      ...quiet,
    });
    await monitor.firstRefresh;
    const agent = new Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    await get(monitor.address.port, "/api/health", agent);
    const started = Date.now();
    await monitor.stop();
    assert.ok(Date.now() - started < 1_000, "server.close waited for keep-alive sockets");
  });
});

describe("optional USB display", () => {
  test("is off by default: no bridge, no device entry in /api/health", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const service = new SnapshotService(new LocalDataSource(fixture.codexHome));
    for (const env of [{}, { TOKENBEACON_DEVICE: "off" }]) {
      const monitor = await startMonitor({ port: 0, distRoot: path.join(fixture.root, "no-dist"), service, env, ...quiet });
      await monitor.firstRefresh;
      assert.equal(monitor.device, null);
      const health = JSON.parse((await get(monitor.address.port, "/api/health")).body);
      assert.ok(!("device" in health));
      await monitor.stop();
    }
  });

  test("an invalid setting is reported once and the dashboard still starts", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const warnings: string[] = [];
    const monitor = await startMonitor({
      port: 0,
      distRoot: path.join(fixture.root, "no-dist"),
      service: new SnapshotService(new LocalDataSource(fixture.codexHome)),
      env: { TOKENBEACON_DEVICE: "/etc/passwd" },
      log: () => undefined,
      warn: (line) => warnings.push(line),
    });
    t.after(() => monitor.stop());
    await monitor.firstRefresh;
    assert.equal(monitor.device, null);
    assert.ok(warnings.some((line) => line.includes("TOKENBEACON_DEVICE") && line.includes("stays off")));
    assert.ok(!warnings.join("\n").includes("/etc/passwd"), "the rejected value is not echoed");
    assert.equal((await get(monitor.address.port, "/api/snapshot")).status, 200);
  });

  test(
    "auto mode searches with the real system tools and only adds a device entry to /api/health",
    { skip: process.platform !== "darwin" && process.platform !== "win32" && "USB display supports macOS and Windows" },
    async (t) => {
      const fixture = createFixtureCodexHome();
      t.after(fixture.cleanup);
      const service = new SnapshotService(new LocalDataSource(fixture.codexHome));
      const baseline = await startMonitor({ port: 0, distRoot: path.join(fixture.root, "no-dist"), service, env: {}, ...quiet });
      await baseline.firstRefresh;
      const before = JSON.parse((await get(baseline.address.port, "/api/health")).body);
      await baseline.stop();

      const monitor = await startMonitor({
        port: 0,
        distRoot: path.join(fixture.root, "no-dist"),
        service,
        // A serial number no display has: discovery runs with the real system
        // tools, but a board that happens to be plugged in is never opened, so
        // the test cannot disturb a running TokenBeacon that is using it.
        env: { TOKENBEACON_DEVICE: "auto", TOKENBEACON_DEVICE_SERIAL: "TBTEST0NOSUCHDISPLAY" },
        ...quiet,
      });
      t.after(() => monitor.stop());
      await monitor.firstRefresh;
      assert.ok(monitor.device);
      // macOS runs ioreg; Windows starts the PowerShell helper (can take a few seconds).
      let health: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 120; attempt += 1) {
        health = JSON.parse((await get(monitor.address.port, "/api/health")).body);
        const device = health.device as { detail: string | null } | undefined;
        if (device && device.detail !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.deepEqual(health.device, { state: "searching", detail: "no_display" });
      assert.equal(health.status, before.status, "the optional display never changes the overall status");
      assert.deepEqual(health.sources, before.sources);
      assert.ok(!/COM\d|\/dev\//.test(JSON.stringify(health)), "no port names");
    },
  );
});

describe("data problem hints", () => {
  test("missing Codex home explains CODEX_HOME", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const snapshot = await new SnapshotService(new LocalDataSource(path.join(root, "nope"))).refresh();
    const lines = describeDataProblems(snapshot);
    assert.match(lines.join("\n"), /CODEX_HOME/);
    assert.ok(!lines.join("\n").includes(root));
  });

  test("CODEX_HOME hint is written for the user's shell", async (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    const snapshot = await new SnapshotService(new LocalDataSource(path.join(root, "nope"))).refresh();
    const mac = describeDataProblems(snapshot, "posix").join("\n");
    assert.match(mac, /CODEX_HOME=\/path\/to\/\.codex npm start/);
    assert.ok(!/\$env:|set "/.test(mac));
    const windows = describeDataProblems(snapshot, "win32").join("\n");
    assert.match(windows, /PowerShell: \$env:CODEX_HOME = "D:\\path\\to\\\.codex"; npm start/);
    assert.match(windows, /cmd: +set "CODEX_HOME=D:\\path\\to\\\.codex" && npm start/);
    assert.ok(!windows.includes("CODEX_HOME=/path"));
    for (const text of [mac, windows]) assert.ok(!text.includes(root));
  });

  test("healthy fixture produces no blocking hint", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const snapshot = await new SnapshotService(new LocalDataSource(fixture.codexHome)).refresh();
    const lines = describeDataProblems(snapshot);
    assert.ok(!lines.some((line) => /No Codex data|not readable/.test(line)));
  });
});

describe("snapshot service refresh", () => {
  test("concurrent refreshes share one read", async (t) => {
    const fixture = createFixtureCodexHome();
    t.after(fixture.cleanup);
    const local = new LocalDataSource(fixture.codexHome);
    let reads = 0;
    const original = local.read.bind(local);
    local.read = () => {
      reads += 1;
      return original();
    };
    const service = new SnapshotService(local);
    assert.equal(service.loading, true);
    const [a, b, c] = await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
    assert.equal(reads, 1);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(service.loading, false);
    await service.refresh();
    assert.equal(reads, 2);
  });
});

describe("dashboard build detection", () => {
  test("missing, stale and fresh states", (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    mkdirSync(path.join(root, "src", "client"), { recursive: true });
    writeFileSync(path.join(root, "index.html"), "<html></html>");
    writeFileSync(path.join(root, "src", "client", "App.tsx"), "export {}");
    assert.equal(frontendBuildState(root), "missing");

    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "index.html"), "built");
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(root, "dist", "index.html"), past, past);
    assert.equal(frontendBuildState(root), "stale");

    utimesSync(path.join(root, "dist", "index.html"), future, future);
    assert.equal(frontendBuildState(root), "fresh");
  });

  test("missing build without build tools gives an actionable error", (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    writeFileSync(path.join(root, "index.html"), "<html></html>");
    assert.throws(() => ensureFrontendBuild(root, quiet), /Run `npm install`/);
  });

  test("stale build without build tools keeps serving the existing build", (t) => {
    const { root, cleanup } = createTempRoot();
    t.after(cleanup);
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "index.html"), "built");
    const past = new Date(Date.now() - 60_000);
    utimesSync(path.join(root, "dist", "index.html"), past, past);
    writeFileSync(path.join(root, "index.html"), "<html>new</html>");
    const warnings: string[] = [];
    assert.equal(ensureFrontendBuild(root, { log: () => undefined, warn: (line) => warnings.push(line) }), "stale");
    assert.equal(warnings.length, 1);
  });
});

describe("start command hints", () => {
  test("one POSIX line, or PowerShell and cmd lines on Windows", () => {
    assert.deepEqual(startCommandLines("TOKENBEACON_PORT", "4311", "posix"), ["TOKENBEACON_PORT=4311 npm start"]);
    assert.deepEqual(startCommandLines("TOKENBEACON_PORT", "4311", "win32"), [
      'PowerShell: $env:TOKENBEACON_PORT = "4311"; npm start',
      'cmd:        set "TOKENBEACON_PORT=4311" && npm start',
    ]);
  });

  test("port errors suggest the next port in the user's shell", () => {
    const inUse = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    assert.match(describeListenError(inUse, 4310, "posix").message, /TOKENBEACON_PORT=4311 npm start/);
    const windows = describeListenError(inUse, 4310, "win32").message;
    assert.match(windows, /\$env:TOKENBEACON_PORT = "4311"; npm start/);
    assert.match(windows, /set "TOKENBEACON_PORT=4311" && npm start/);
    assert.ok(!windows.includes("TOKENBEACON_PORT=4311 npm start"));
    const denied = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    assert.match(describeListenError(denied, 80, "win32").message, /above 1024[\s\S]*\$env:TOKENBEACON_PORT = "4310"/);
  });
});
