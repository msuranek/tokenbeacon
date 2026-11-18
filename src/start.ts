import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMonitorServer, listenLoopback } from "./http-server.ts";
import { redactHome } from "./sanitize.ts";
import { SnapshotService } from "./snapshot-service.ts";
import type { MonitorSnapshot } from "./types.ts";
import { currentPlatform, type PathPlatform } from "./paths.ts";
import { exampleCodexHome, startCommandLines } from "./platform-hints.ts";

export interface StartOptions {
  port: number;
  distRoot: string;
  service?: SnapshotService;
  refreshMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface RunningMonitor {
  server: Server;
  service: SnapshotService;
  address: AddressInfo;
  /** Resolves when the first data refresh has finished (or failed). */
  firstRefresh: Promise<void>;
  stop(): Promise<void>;
}

/** A listen failure with a message meant for the terminal, not a stack trace. */
export class StartupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "StartupError";
  }
}

/**
 * Starts listening immediately and loads Codex data in the background. Until
 * the first refresh completes, the API answers 503 "snapshot_loading" and the
 * dashboard shows its loading state; a cold start can take several seconds.
 */
export async function startMonitor(options: StartOptions): Promise<RunningMonitor> {
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const service = options.service ?? new SnapshotService();

  // The bind address is fixed to 127.0.0.1 and is intentionally not configurable:
  // the API has no authentication and must never be reachable from the network.
  const server = createMonitorServer({
    getSnapshot: () => service.current,
    getError: () => service.error,
    isLoading: () => service.loading,
    distRoot: options.distRoot,
  });

  let address: AddressInfo;
  try {
    address = await listenLoopback(server, options.port);
  } catch (error) {
    throw describeListenError(error, options.port);
  }
  log(`TokenBeacon is running at http://${address.address}:${address.port}  (read-only, local only)`);
  log(`Reading Codex data from ${redactHome(service.localData.codexHome)}`);

  const started = Date.now();
  const firstRefresh = service.refresh().then(
    (snapshot) => {
      log(`Loaded ${snapshot.diagnostics.visibleThreadCount} threads in ${Date.now() - started} ms.`);
      for (const line of describeDataProblems(snapshot)) warn(line);
    },
    () => warn("Loading Codex data failed; retrying every 5 seconds."),
  );
  service.start(options.refreshMs ?? 5_000);

  return {
    server,
    service,
    address,
    firstRefresh,
    stop: () =>
      new Promise<void>((resolve) => {
        service.stop();
        server.close(() => resolve());
        // Polling browsers keep idle keep-alive connections open.
        server.closeAllConnections();
      }),
  };
}

export function describeListenError(
  error: unknown,
  port: number,
  platform: PathPlatform = currentPlatform(),
): StartupError {
  const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
  if (code === "EADDRINUSE") {
    return new StartupError(
      code,
      `Port ${port} is already in use.\n` +
        `TokenBeacon may already be running: open http://127.0.0.1:${port}\n` +
        "Otherwise stop the other program or choose another port, e.g.\n" +
        indent(startCommandLines("TOKENBEACON_PORT", String(port === 65_535 ? port - 1 : port + 1), platform)),
    );
  }
  if (code === "EACCES") {
    return new StartupError(
      code,
      `Not allowed to listen on port ${port}. Choose a port above 1024, e.g.\n` +
        indent(startCommandLines("TOKENBEACON_PORT", "4310", platform)),
    );
  }
  if (code === "EADDRNOTAVAIL") {
    return new StartupError(code, "The loopback address 127.0.0.1 is not available on this system.");
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new StartupError(code, `Could not start the server on port ${port}: ${redactHome(reason)}`);
}

/** Terminal hints for missing or partial data. Codes only, no private values. */
export function describeDataProblems(
  snapshot: MonitorSnapshot,
  platform: PathPlatform = currentPlatform(),
): string[] {
  const health = new Map(snapshot.sourceHealth.map((source) => [source.source, source]));
  const home = health.get("codexHome");
  if (home && home.state !== "ok") {
    return [
      `No Codex data directory found (${home.detail}).`,
      "Install and open Codex at least once, or point CODEX_HOME to your Codex data directory, e.g.",
      ...startCommandLines("CODEX_HOME", exampleCodexHome(platform), platform).map((line) => `  ${line}`),
    ];
  }
  const state = health.get("stateDb");
  if (state && state.state === "unavailable") {
    return [
      `The Codex thread database is not readable (${state.detail}).`,
      "If Codex has never been used on this machine, start a thread in Codex first.",
    ];
  }
  const lines: string[] = [];
  for (const source of snapshot.sourceHealth) {
    if (source.source === "appServer" || source.state === "ok") continue;
    lines.push(`Note: ${source.source} is ${source.state}${source.detail ? ` (${source.detail})` : ""}.`);
  }
  return lines;
}

function indent(lines: string[]): string {
  return lines.map((line) => `  ${line}`).join("\n");
}
