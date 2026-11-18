import { homedir } from "node:os";
import { currentPlatform, pathApi, type PathPlatform } from "./paths.ts";

/**
 * Resolves the Codex data directory.
 *
 * Order: non-empty `CODEX_HOME` (the variable Codex itself honours), otherwise
 * the platform default `~/.codex`. A relative `CODEX_HOME` is resolved against
 * the current working directory, like Codex does. `~` is not expanded here
 * because shells already do it; a literal "~" would be resolved as a relative
 * directory name, which is never what the user meant, so it is expanded too.
 * On Windows `~\` is accepted as well as `~/`; the default is
 * `%USERPROFILE%\.codex`, where Codex (including the MSIX app) keeps its data.
 */
export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  cwd: string = process.cwd(),
  platform: PathPlatform = currentPlatform(),
): string {
  const api = pathApi(platform);
  const raw = env.CODEX_HOME?.trim();
  if (!raw) return api.join(home, ".codex");
  if (raw === "~") return home;
  if (raw.startsWith("~/") || (platform === "win32" && raw.startsWith("~\\"))) {
    return api.join(home, raw.slice(2));
  }
  return api.resolve(cwd, raw);
}
