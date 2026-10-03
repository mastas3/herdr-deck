import { homedir } from "node:os";
import type { Host } from "../../src/plugin-api";
import type { RemoteHost } from "../../src/federation";
import { inventory, commandsFor } from "./inventory";

type Remotes = { get(id: string): RemoteHost | undefined; all(): RemoteHost[] };
const BUILTINS = ["/plugin", "/reload-plugins", "/help"];
export function activate(host: Host) {
  const home = host.env("DECK_CLAUDE_HOME") || homedir();
  const profiles = () => inventory(home, { CLAUDE_CONFIG_DIR: host.env("CLAUDE_CONFIG_DIR"), DECK_CLAUDE_CONFIG_DIRS: host.env("DECK_CLAUDE_CONFIG_DIRS"), CLAUDE_CODE_PLUGIN_DIRS: host.env("CLAUDE_CODE_PLUGIN_DIRS") });
  host.extend("slash.commands", { get: row => row.agent === "claude" ? commandsFor(profiles().find(p => p.id === row.claudeProfile), row.cwd).map(cmd => ({ cmd, src: "plugin" as const, desc: "Claude Mod · opens in the terminal" })) : [] });
  const self = () => host.machines().find(m => m.local && m.kind !== "app");
  const remotes = () => host.use<Remotes>("remotes");
  async function remote(id: string, body: any) {
    const r = remotes()?.get(id);
    if (!r) throw new Error("Unknown machine");
    const res = await r.post("/api/claude-mods", body);
    if (res.status === 404) throw new Error("Update this machine’s deck and enable Claude Mods in Plugins → Built in.");
    if (res.status >= 400) throw new Error(res.data?.error || "Claude Mods request failed");
    return res.data;
  }
  host.routes("claude-mods", async ({ body: b }) => {
    try {
      if (b.op === "machines") {
        const me = { id: self()?.id ?? "local", label: self()?.label ?? "This machine", profiles: profiles() };
        const others = await Promise.all((remotes()?.all() ?? []).map(async r => {
          const base = { id: r.conf.id, label: r.conf.label };
          try { return { ...base, ...await remote(r.conf.id, { op: "inventory" }) }; }
          catch (e: any) { return { ...base, profiles: [], error: e.message }; }
        }));
        return { machines: [me, ...others] };
      }
      if (b.machine && b.machine !== self()?.id) {
        const key = typeof b.key === "string" && b.key.startsWith(b.machine + "|") ? b.key.slice(b.machine.length + 1) : b.key;
        return await remote(b.machine, { ...b, machine: undefined, key });
      }
      if (b.op === "inventory") return { profiles: profiles() };
      const row = host.rows().find(r => r.key === b.key);
      if (!row || (row.machine && row.machine !== self()?.id) || row.agent !== "claude" || row.app || row.hist) throw new Error("Choose a live Claude Code session on this machine.");
      const ps = profiles(), profile = ps.find(p => p.id === row.claudeProfile);
      const commands = [...BUILTINS, ...commandsFor(profile, row.cwd)];
      if (b.op === "session") return { profile: profile?.id, profiles: ps, commands, signals: row.signals ?? {} };
      if (b.op === "keys") {
        if (b.sessionId !== row.sessionId) throw new Error("The session changed. Open its Mods panel again.");
        const keys = b.keys;
        if (!Array.isArray(keys) || !keys.length || keys.length > 4 || !keys.every(k => typeof k === "string" && /^(?:[a-z0-9]|enter|esc|tab|shift\+tab|backspace|up|down|left|right|ctrl\+x)$/.test(k))) throw new Error("Unsupported mod control key");
        await host.sessions.keys(row.key, keys);
        return { ok: true };
      }
      if (b.op === "command") {
        if (typeof b.command !== "string" || !commands.includes(b.command)) throw new Error("This command is not declared by this profile. Use the terminal for dynamic commands.");
        if (row.status === "working" || row.status === "blocked") throw new Error("Wait for Claude to be ready, or use the terminal controls for its current prompt.");
        if (b.sessionId !== row.sessionId) throw new Error("The session changed. Open its Mods panel again.");
        await host.sessions.send(row.key, b.command);
        return { ok: true };
      }
      return Response.json({ error: "Unknown Claude Mods action" }, { status: 400 });
    } catch (e: any) { return Response.json({ error: e.message }, { status: 400 }); }
  });
}
