// Plain JavaScript: runs from main.mjs before any TypeScript module is loaded.
//
// Makes `npm install && npm start` work from a clean checkout: the dashboard
// is built when dist/ is missing or older than its sources, so a stale build
// is never served after an update.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Files and directories whose changes require a new dashboard build. */
const BUILD_INPUTS = ["index.html", "vite.config.ts", "package-lock.json", "src/client", "src/types.ts"];

function newestMtime(target) {
  if (!existsSync(target)) return 0;
  const info = statSync(target);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
  }
  return newest;
}

/**
 * @param {string} root project root
 * @returns {"fresh" | "stale" | "missing"}
 */
export function frontendBuildState(root) {
  const index = path.join(root, "dist", "index.html");
  if (!existsSync(index)) return "missing";
  const builtAt = statSync(index).mtimeMs;
  const sourcesAt = Math.max(...BUILD_INPUTS.map((input) => newestMtime(path.join(root, input))));
  return sourcesAt > builtAt ? "stale" : "fresh";
}

/**
 * Builds the dashboard if needed.
 * @param {string} root project root
 * @param {{ log?: (line: string) => void, warn?: (line: string) => void }} [io]
 */
export function ensureFrontendBuild(root, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const warn = io.warn ?? ((line) => console.warn(line));
  const state = frontendBuildState(root);
  if (state === "fresh") return state;

  const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    if (state === "stale") {
      warn("Dashboard sources changed but build tools are not installed; serving the existing build.");
      return state;
    }
    throw new Error(
      "The dashboard has not been built and the build tools are not installed.\n" +
        "Run `npm install`, then `npm start` again.",
    );
  }

  log(state === "missing" ? "Building the dashboard (first start)…" : "Dashboard sources changed; rebuilding…");
  const result = spawnSync(process.execPath, [viteBin, "build", "--logLevel", "warn"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("Building the dashboard failed (see the output above). Try `npm install` and start again.");
  }
  return state;
}
