import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves the Codex data directory.
 *
 * Order: non-empty `CODEX_HOME` (the variable Codex itself honours), otherwise
 * the platform default `~/.codex`. A relative `CODEX_HOME` is resolved against
 * the current working directory, like Codex does. `~` is not expanded here
 * because shells already do it; a literal "~" would be resolved as a relative
 * directory name, which is never what the user meant, so it is expanded too.
 */
export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  cwd: string = process.cwd(),
): string {
  const raw = env.CODEX_HOME?.trim();
  if (!raw) return path.join(home, ".codex");
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return path.resolve(cwd, raw);
}
