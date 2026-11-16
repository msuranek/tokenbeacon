export declare function frontendBuildState(root: string): "fresh" | "stale" | "missing";
export declare function ensureFrontendBuild(
  root: string,
  io?: { log?: (line: string) => void; warn?: (line: string) => void },
): "fresh" | "stale" | "missing";
