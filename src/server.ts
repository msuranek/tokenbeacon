import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePort } from "./http-server.ts";
import { startCommandLines } from "./platform-hints.ts";
import { startMonitor, StartupError } from "./start.ts";

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

let port: number;
try {
  port = parsePort(process.env.TOKENBEACON_PORT);
} catch (error) {
  console.error(
    [`${error instanceof Error ? error.message : String(error)}, e.g.`, ...startCommandLines("TOKENBEACON_PORT", "4310").map((line) => `  ${line}`)].join("\n"),
  );
  process.exit(1);
}

let monitor: Awaited<ReturnType<typeof startMonitor>>;
try {
  monitor = await startMonitor({ port, distRoot });
} catch (error) {
  console.error(error instanceof StartupError ? error.message : `Could not start TokenBeacon: ${String(error)}`);
  process.exit(1);
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) process.exit(0); // A second Ctrl+C exits immediately.
  stopping = true;
  await monitor.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
