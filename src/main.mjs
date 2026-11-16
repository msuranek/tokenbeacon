// Entry point (`npm start`): verify the runtime and the dashboard build before
// loading any TypeScript module, so every failure has a readable message.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFrontendBuild } from "./frontend-build.mjs";
import { assertSupportedRuntime } from "./runtime-check.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  await assertSupportedRuntime();
  ensureFrontendBuild(projectRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

await import("./server.ts");
