// Plain JavaScript on purpose: this file must run, and explain the problem,
// on Node.js versions that cannot execute TypeScript or lack node:sqlite.

/** Lowest Node.js release with both unflagged node:sqlite and default type stripping. */
export const MIN_NODE_VERSION = "22.18.0";

/**
 * @param {string} version e.g. "v24.11.1"
 * @param {{ typescript?: unknown }} features process.features
 * @returns {string[]} human-readable problems; empty when supported
 */
export function runtimeProblems(version, features) {
  const problems = [];
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!match) return [`Unrecognised Node.js version "${version}".`];
  const current = match.slice(1, 4).map(Number);
  const minimum = MIN_NODE_VERSION.split(".").map(Number);
  if (compare(current, minimum) < 0) {
    problems.push(`Node.js ${MIN_NODE_VERSION} or newer is required; this is ${version}.`);
  } else if (current[0] === 23 && compare(current, [23, 6, 0]) < 0) {
    problems.push(`Node.js 23 needs 23.6.0 or newer for TypeScript support; this is ${version}.`);
  }
  if (features && "typescript" in features && !features.typescript) {
    problems.push("TypeScript type stripping is disabled (for example by --no-strip-types, --no-experimental-strip-types or NODE_OPTIONS).");
  }
  return problems;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Throws with an actionable message when the runtime cannot run the monitor. */
export async function assertSupportedRuntime() {
  const problems = runtimeProblems(process.version, process.features ?? {});
  if (problems.length === 0) {
    try {
      const sqlite = await import("node:sqlite");
      if (typeof (sqlite.Database ?? sqlite.DatabaseSync) !== "function") {
        problems.push("node:sqlite does not provide a database class.");
      }
    } catch {
      problems.push("The built-in node:sqlite module is not available.");
    }
  }
  if (problems.length > 0) {
    const error = new Error(
      [
        "TokenBeacon cannot run on this Node.js runtime:",
        ...problems.map((problem) => `  - ${problem}`),
        `Install Node.js ${MIN_NODE_VERSION}+ (an LTS release is recommended) and try again.`,
      ].join("\n"),
    );
    error.name = "UnsupportedRuntimeError";
    throw error;
  }
}
