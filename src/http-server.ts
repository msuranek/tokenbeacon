import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { MonitorSnapshot } from "./types.ts";

/**
 * Local HTTP surface of TokenBeacon.
 *
 * Threat model: the API serves private metadata (project names, thread titles
 * and IDs) to the dashboard running on the same loopback origin. Any other web
 * page open in the user's browser must not be able to read it, including via
 * DNS rebinding (an attacker hostname that resolves to 127.0.0.1). Protection
 * layers, applied before routing:
 *
 * 1. the server binds to 127.0.0.1 only;
 * 2. the Host header must be an exact loopback name with the bound port;
 * 3. a present Origin header must be one of the allowed loopback origins;
 * 4. API requests with Sec-Fetch-Site other than same-origin/none are refused;
 * 5. no CORS headers are ever sent, preflights are refused;
 * 6. CSP, frame, nosniff, referrer and cross-origin isolation headers.
 */

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4310;

const ALLOWED_HOSTNAMES = ["127.0.0.1", "localhost"] as const;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export interface MonitorServerOptions {
  getSnapshot: () => MonitorSnapshot | null;
  getError: () => Error | null;
  /** True while the first refresh is still running. */
  isLoading?: () => boolean;
  distRoot: string;
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`Invalid TOKENBEACON_PORT: expected 1-65535`);
  const port = Number(raw);
  if (port < 1 || port > 65_535) throw new Error(`Invalid TOKENBEACON_PORT: expected 1-65535`);
  return port;
}

export function allowedHosts(port: number): Set<string> {
  const hosts = new Set<string>();
  for (const name of ALLOWED_HOSTNAMES) {
    hosts.add(`${name}:${port}`);
    if (port === 80) hosts.add(name);
  }
  return hosts;
}

export function allowedOrigins(port: number): Set<string> {
  const origins = new Set<string>();
  for (const name of ALLOWED_HOSTNAMES) {
    origins.add(port === 80 ? `http://${name}` : `http://${name}:${port}`);
  }
  return origins;
}

export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (typeof hostHeader !== "string" || hostHeader.length === 0 || hostHeader.length > 64) return false;
  return allowedHosts(port).has(hostHeader.toLowerCase());
}

export function isAllowedOrigin(originHeader: string | undefined, port: number): boolean {
  if (originHeader === undefined) return true; // Same-origin GETs usually omit Origin.
  return allowedOrigins(port).has(originHeader.toLowerCase());
}

export function isAllowedFetchSite(value: string | undefined): boolean {
  // Absent on older browsers and non-browser clients; Host/Origin checks still apply.
  if (value === undefined) return true;
  return value === "same-origin" || value === "none";
}

export function createMonitorServer(options: MonitorServerOptions): Server {
  const distRoot = path.resolve(options.distRoot);

  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);

    const port = boundPort(server);
    const rejection = checkRequest(request, port);
    if (rejection) {
      sendJson(response, rejection.status, { error: rejection.error });
      return;
    }

    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    const url = request.url!;
    if (url === "/api/snapshot") {
      const snapshot = options.getSnapshot();
      if (!snapshot) {
        // "snapshot_loading": first read still running (cold start can take
        // several seconds); "snapshot_unavailable": the first read failed.
        const loading = options.isLoading?.() ?? false;
        response.setHeader("Retry-After", "1");
        sendJson(response, 503, { error: loading ? "snapshot_loading" : "snapshot_unavailable" });
        return;
      }
      sendJson(response, 200, snapshot);
      return;
    }

    if (url === "/api/health") {
      const snapshot = options.getSnapshot();
      const error = options.getError();
      const sources = (snapshot?.sourceHealth ?? []).map(({ source, state, detail }) => ({
        source,
        state,
        detail,
      }));
      const sourcesDegraded = sources.some(
        (source) => source.source !== "appServer" && source.state !== "ok",
      );
      sendJson(response, snapshot ? 200 : 503, {
        status: !snapshot
          ? options.isLoading?.()
            ? "loading"
            : "unavailable"
          : error || sourcesDegraded
            ? "degraded"
            : "ok",
        generatedAt: snapshot?.generatedAt ?? null,
        refreshDurationMs: snapshot?.diagnostics.refreshDurationMs ?? null,
        // Raw error messages can contain local paths; only a stable code is exposed.
        error: error ? "refresh_failed" : null,
        // Stable codes only; source details never contain paths.
        sources,
      });
      return;
    }

    if (isApiPath(url)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    serveFrontend(distRoot, url, response);
  });

  return server;
}

/** Listen on loopback only and verify the bound address. */
export function listenLoopback(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
        server.close();
        reject(new Error("Server is not bound to the loopback interface"));
        return;
      }
      resolve(address);
    });
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  return address && typeof address !== "string" ? address.port : -1;
}

function checkRequest(
  request: IncomingMessage,
  port: number,
): { status: number; error: string } | null {
  // Exactly one Host header; reject duplicates rather than trusting the first.
  let hostCount = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "host") hostCount += 1;
  }
  if (hostCount !== 1 || !isAllowedHost(request.headers.host, port)) {
    return { status: 421, error: "invalid_host" };
  }

  // Only origin-form request targets ("/path"); absolute-form targets are proxy syntax.
  if (!request.url || !request.url.startsWith("/") || request.url.startsWith("//")) {
    return { status: 400, error: "bad_request" };
  }

  const origin = singleHeader(request.headers.origin);
  if (origin === null || !isAllowedOrigin(origin, port)) {
    return { status: 403, error: "forbidden_origin" };
  }

  const fetchSite = singleHeader(request.headers["sec-fetch-site"]);
  if (isApiPath(request.url) && (fetchSite === null || !isAllowedFetchSite(fetchSite))) {
    return { status: 403, error: "forbidden_cross_site" };
  }

  return null;
}

function isApiPath(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
}

/** Returns undefined when absent and null when the header is repeated. */
function singleHeader(value: string | string[] | undefined): string | undefined | null {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function serveFrontend(distRoot: string, url: string, response: ServerResponse): void {
  const indexPath = path.join(distRoot, "index.html");
  if (!existsSync(indexPath)) {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.writeHead(503);
    response.end("Frontend build is missing. Run npm run build.");
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  } catch {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (pathname.includes("\0")) {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolveInside(distRoot, requested) ?? indexPath;

  response.setHeader("Content-Type", contentType(filePath));
  response.writeHead(200);
  createReadStream(filePath).pipe(response);
}

function resolveInside(root: string, requested: string): string | null {
  const candidate = path.resolve(root, requested);
  if (!candidate.startsWith(`${root}${path.sep}`)) return null;
  if (!existsSync(candidate)) return null;
  try {
    // Follow symlinks and re-check, so a link inside dist cannot expose other files.
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    if (!realCandidate.startsWith(`${realRoot}${path.sep}`)) return null;
    return statSync(realCandidate).isFile() ? realCandidate : null;
  } catch {
    return null;
  }
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath);
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}
