/**
 * Refresh benchmark against CODEX_HOME (default ~/.codex). Not a test: run
 * with `npm run bench`. Prints only counts and timings, never names or paths.
 *
 * Optional budget: BENCH_WARM_BUDGET_MS (default 5000) makes the process exit
 * with status 1 if the median warm refresh exceeds it.
 */
import { performance } from "node:perf_hooks";
import { SnapshotService } from "../src/snapshot-service.ts";

const warmRuns = Number(process.env.BENCH_WARM_RUNS ?? 5);
const budgetMs = Number(process.env.BENCH_WARM_BUDGET_MS ?? 5_000);
const service = new SnapshotService();

const coldStart = performance.now();
const cold = await service.refresh();
const coldMs = performance.now() - coldStart;

const warm: number[] = [];
let last = cold;
for (let run = 0; run < warmRuns; run += 1) {
  const started = performance.now();
  last = await service.refresh();
  warm.push(performance.now() - started);
}
warm.sort((a, b) => a - b);
const median = warm[Math.floor(warm.length / 2)];
const bytes = Buffer.byteLength(JSON.stringify(last));
const memoryMb = process.memoryUsage().rss / 1024 / 1024;

console.log(
  JSON.stringify(
    {
      node: process.version,
      threads: last.diagnostics.visibleThreadCount,
      projects: last.projects.length,
      coldRefreshMs: Math.round(coldMs),
      warmRefreshMs: { median: Math.round(median), min: Math.round(warm[0]), max: Math.round(warm.at(-1)!) },
      decompressions: last.diagnostics.rolloutCache.decompressions,
      snapshotBytes: bytes,
      rssMb: Math.round(memoryMb),
      budgetMs,
    },
    null,
    2,
  ),
);
if (median > budgetMs) {
  console.error(`Median warm refresh ${Math.round(median)} ms exceeds budget ${budgetMs} ms.`);
  process.exit(1);
}
