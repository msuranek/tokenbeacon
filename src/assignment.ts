import { comparablePath, currentPlatform, type PathPlatform } from "./paths.ts";

export interface AssignmentProject {
  id: string;
  rootPaths: string[];
}

/**
 * Picks the project whose root folder contains `cwd`, preferring the most
 * specific (longest) root. Matching respects directory boundaries
 * (`C:\app` does not contain `C:\app-old`). On Windows it ignores letter case,
 * `/` versus `\`, trailing separators and the `\\?\` prefix; on macOS it stays
 * case-sensitive.
 */
export function assignByLongestRoot(
  cwd: string,
  projects: AssignmentProject[],
  platform: PathPlatform = currentPlatform(),
): string | null {
  if (!cwd) return null;
  const normalizedCwd = comparablePath(cwd, platform);
  if (normalizedCwd === null) return null;
  const separator = platform === "win32" ? "\\" : "/";
  let best: { projectId: string; length: number } | null = null;

  for (const project of projects) {
    for (const root of project.rootPaths) {
      if (!root) continue;
      const normalizedRoot = comparablePath(root, platform);
      if (normalizedRoot === null) continue;
      // Only a Windows drive root (`c:\`) already ends with a separator; on
      // POSIX the root "/" keeps matching only itself, as before.
      const prefix =
        platform === "win32" && normalizedRoot.endsWith(separator) ? normalizedRoot : `${normalizedRoot}${separator}`;
      const matches = normalizedCwd === normalizedRoot || normalizedCwd.startsWith(prefix);
      if (matches && (!best || normalizedRoot.length > best.length)) {
        best = { projectId: project.id, length: normalizedRoot.length };
      }
    }
  }
  return best?.projectId ?? null;
}
