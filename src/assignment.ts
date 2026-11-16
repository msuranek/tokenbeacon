import path from "node:path";

export interface AssignmentProject {
  id: string;
  rootPaths: string[];
}

export function assignByLongestRoot(
  cwd: string,
  projects: AssignmentProject[],
): string | null {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const normalizedCwd = path.resolve(cwd);
  let best: { projectId: string; length: number } | null = null;

  for (const project of projects) {
    for (const root of project.rootPaths) {
      if (!root || !path.isAbsolute(root)) continue;
      const normalizedRoot = path.resolve(root);
      const matches =
        normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}${path.sep}`);
      if (matches && (!best || normalizedRoot.length > best.length)) {
        best = { projectId: project.id, length: normalizedRoot.length };
      }
    }
  }
  return best?.projectId ?? null;
}
