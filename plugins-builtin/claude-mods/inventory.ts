// Reads declarative plugin files only. Never imports a mod, runs its code, or returns settings/credentials.
import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { claudeProfiles, type ClaudeProfile } from "../../src/claude-profiles";

export type ModInfo = {
  id: string; name: string; description: string; version?: string; source: "installed" | "directory";
  scope: string; projectPath?: string; enabled: boolean; mod: boolean; commands: string[]; missing?: boolean;
};
export type ProfileInfo = ClaudeProfile & { plugins: ModInfo[]; hooksDisabled: boolean; managedOnly: boolean; error?: string };
const short = (x: unknown, n = 300) => typeof x === "string" ? x.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, n) : "";
function read(path: string, limit = 2_000_000) {
  try { return statSync(path).size <= limit ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}
function json(path: string): any { try { return JSON.parse(read(path)); } catch { return undefined; } }
function inside(root: string, path: string): string | undefined {
  try {
    const r = realpathSync(root), f = realpathSync(path), rel = relative(r, f);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return f;
  } catch {}
}
const COMMAND = /^[a-z][a-z0-9:_-]{0,79}$/i;
/** Literal registrations are hints; computed/dynamically registered commands remain available through the terminal. */
export function declaredCommands(source: string): string[] {
  const constants = new Map([...source.matchAll(/\bconst\s+(\w+)\s*=\s*['"]([a-z][a-z0-9:_-]*)['"]/gi)].map(m => [m[1], m[2]]));
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:\.command\.register|\.registerCommand)\s*\(\s*\{\s*name\s*:\s*(?:['"]([^'"]+)['"]|(\w+))/g)) {
    const name = m[1] ?? constants.get(m[2]);
    if (name && COMMAND.test(name)) found.add("/" + name);
  }
  return [...found].slice(0, 50);
}
function describe(root: string, base: Omit<ModInfo, "name" | "description" | "mod" | "commands">): ModInfo {
  const manifest = json(join(root, ".claude-plugin/plugin.json"));
  const hooks = typeof manifest?.hooks === "object" ? manifest.hooks : json(join(root, typeof manifest?.hooks === "string" ? manifest.hooks : "hooks/hooks.json"));
  const modules = Array.isArray(hooks?.modules) ? hooks.modules.filter((x: unknown) => typeof x === "string").slice(0, 32) : [];
  const hooksDir = join(root, typeof manifest?.hooks === "string" ? manifest.hooks : "hooks/hooks.json", "..");
  const commands = new Set<string>();
  for (const m of modules) {
    const file = inside(root, resolve(hooksDir, m));
    if (file) for (const c of declaredCommands(read(file, 256_000))) commands.add(c);
  }
  return { ...base, name: short(manifest?.name, 100) || base.id.split("@")[0], description: short(manifest?.description),
    version: short(manifest?.version, 60) || base.version, mod: modules.length > 0, commands: [...commands], ...(!manifest ? { missing: true } : {}) };
}

export function inventory(home = homedir(), env = process.env): ProfileInfo[] {
  return claudeProfiles(home, env).map(p => {
    const file = join(p.dir, "settings.json"), text = read(file);
    let settings: any = {};
    try { settings = text ? JSON.parse(text) : {}; if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw 0; }
    catch { return { ...p, plugins: [], hooksDisabled: false, managedOnly: false, error: "Cannot read profile settings; configured plugins are unknown." }; }
    const plugins: ModInfo[] = [], registry = json(join(p.dir, "plugins/installed_plugins.json"));
    for (const [id, entries] of Object.entries<any>(registry?.plugins ?? {}).slice(0, 500)) {
      for (const inst of (Array.isArray(entries) ? entries : [entries]).slice(0, 30)) {
        if (typeof inst?.installPath !== "string") continue;
        plugins.push(describe(inst.installPath, { id: short(id, 160), version: short(inst.version, 60), source: "installed",
          scope: short(inst.scope, 30) || "user", projectPath: short(inst.projectPath, 1024) || undefined, enabled: settings.enabledPlugins?.[id] === true }));
      }
    }
    const dirs = [settings.env?.CLAUDE_CODE_PLUGIN_DIRS, p.dir === (env.CLAUDE_CONFIG_DIR || join(home, ".claude")) ? env.CLAUDE_CODE_PLUGIN_DIRS : undefined];
    const seen = new Set<string>();
    for (const raw of dirs.filter(x => typeof x === "string").flatMap(x => x.split(":")).filter(Boolean).slice(0, 64)) {
      const dir = resolve(raw.replace(/^~(?=\/|$)/, home));
      if (seen.has(dir)) continue; seen.add(dir);
      plugins.push(describe(dir, { id: dir, source: "directory", scope: "user", enabled: true }));
    }
    return { ...p, plugins, hooksDisabled: settings.disableAllHooks === true, managedOnly: settings.allowManagedModsOnly === true,
      ...(registry === undefined && read(join(p.dir, "plugins/installed_plugins.json")) ? { error: "Cannot read the installed plugin registry." } : {}) };
  });
}
export function commandsFor(profile: ProfileInfo | undefined, cwd: string): string[] {
  if (!profile || profile.hooksDisabled || profile.managedOnly) return [];
  return [...new Set(profile.plugins.filter(p => p.enabled && !p.missing && (!p.projectPath || cwd === p.projectPath || cwd.startsWith(p.projectPath + "/"))).flatMap(p => p.commands))];
}
