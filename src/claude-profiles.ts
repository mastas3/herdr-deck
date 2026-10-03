// Claude profiles contain separate accounts, plugin settings and transcript stores. Never read their credentials.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type ClaudeProfile = { id: string; label: string; dir: string };
export function claudeProfiles(home = homedir(), env = process.env): ClaudeProfile[] {
  const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, home));
  const paths = [env.CLAUDE_CONFIG_DIR || join(home, ".claude"), join(home, ".claude")];
  try {
    for (const n of readdirSync(home).sort()) {
      if (!/^\.claude-[\w-]+$/.test(n) || /(?:backup|old|bak|update|switch)(?:-|$)/i.test(n)) continue;
      if (existsSync(join(home, n, "projects")) || existsSync(join(home, n, "plugins/installed_plugins.json"))) paths.push(join(home, n));
    }
  } catch {}
  paths.push(...(env.DECK_CLAUDE_CONFIG_DIRS ?? "").split(":").filter(Boolean));
  const seen = new Set<string>(), out: ClaudeProfile[] = [];
  for (const p of paths.slice(0, 64)) {
    const dir = expand(p);
    try {
      if (!statSync(dir).isDirectory() || !["settings.json", "projects", "plugins"].some(n => existsSync(join(dir, n)))) continue;
      const real = realpathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ id: dir, dir, label: basename(dir) === ".claude" ? "Default (.claude)" : basename(dir) });
    } catch {}
  }
  return out;
}

/** The transcript's profile, checked against the profiles we know; no arbitrary path from an API request. */
export function claudeProfileForFile(file: string, profiles = claudeProfiles()): string | undefined {
  return profiles.find(p => file.startsWith(join(p.dir, "projects") + "/"))?.dir;
}
export function claudeProfileEnv(id: unknown, profiles = claudeProfiles()): { CLAUDE_CONFIG_DIR: string } | undefined {
  if (id === undefined || id === null || id === "") return;
  const p = profiles.find(p => p.id === id);
  if (!p) throw new Error("Claude profile is no longer available on this machine. Refresh and choose again.");
  return { CLAUDE_CONFIG_DIR: p.dir };
}

/** Profiles may share their projects directory. Walk each real store only once. */
export function claudeProjectDirs(profiles = claudeProfiles()): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const p of profiles) {
    const dir = join(p.dir, "projects");
    try { const real = realpathSync(dir); if (!seen.has(real)) { seen.add(real); out.push(dir); } } catch {}
  }
  return out;
}
export const claudeShellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
