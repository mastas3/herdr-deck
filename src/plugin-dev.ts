// Plugin dev mode (DECK_DEV=1 and DECK_PLUGIN_DEV=1, e.g. `bun run dev:plugins`): editing a built-in or dev plugin's
// files reloads it without restarting the deck. A server-side change (plugin.json, its server code) stops the plugin,
// drops its modules and starts it again from disk; a page-file change needs nothing on the server. Either way the page
// is told, and reloads. Installed plugins are never watched: their files are pinned by hash (a change turns them off).
import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import type { PluginHost } from "./plugin-host";

export type DevReload = { id: string; server: boolean; state: string; error?: string; where?: string[] };
/** Files that never change what runs: tests, editor droppings, dotfiles. */
const SKIP = /(^|\/)(test|node_modules|\.git)\/|(^|\/)\.|~$|\.sw[px]$|\.tmp$/;

export function watchPlugins(o: { host: PluginHost; dirs: string[]; onReload: (r: DevReload) => void; log?: (s: string) => void }) {
  const log = o.log ?? ((s: string) => console.warn(s));
  const pending = new Map<string, { server: boolean; t: ReturnType<typeof setTimeout> }>();
  let chain: Promise<unknown> = Promise.resolve(); // one reload at a time: each one reconciles every plugin
  const watchers: FSWatcher[] = [];
  function changed(name: string) {
    const [id, ...rest] = name.split(sep);
    const file = rest.join("/");
    if (!id || !file || SKIP.test(file)) return;
    const e = o.host.entries().find((x) => x.id === id);
    if (e && !e.builtin) return;
    const page = !!e?.manifest && (e.manifest.client.includes(file) || e.manifest.styles.includes(file));
    const p = pending.get(id);
    if (p) clearTimeout(p.t);
    const server = !!p?.server || !page;
    // Editors write a file in a few steps: wait for them to settle.
    pending.set(id, { server, t: setTimeout(() => { pending.delete(id); chain = chain.then(() => fire(id, server)); }, 150) });
  }
  async function fire(id: string, server: boolean) {
    try {
      if (server) {
        // A new folder isn't an entry yet: a reconcile finds it (and starts it if it can).
        if (!o.host.entries().some((x) => x.id === id)) await o.host.reconcile();
        else await o.host.reload(id);
      }
      const e = o.host.entries().find((x) => x.id === id);
      if (!e) return;
      if (e.state === "failed" || e.state === "invalid") log(`plugin ${id} reloaded: ${e.state}: ${e.error ?? e.problems}${e.fault?.where[0] ? ` (${e.fault.where[0]})` : ""}`);
      else log(`plugin ${id} reloaded (${server ? "server and page" : "page"})`);
      o.onReload({ id, server, state: e.state, error: e.error ?? e.problems, where: e.fault?.where });
    } catch (err: any) { log(`plugin ${id}: reload: ${err?.message ?? err}`); }
  }
  for (const dir of o.dirs) {
    try { watchers.push(watch(dir, { recursive: true }, (_ev, name) => name && changed(String(name)))); log(`plugin dev: watching ${dir}`); }
    catch (err: any) { log(`plugin dev: can't watch ${dir}: ${err?.message ?? err}`); }
  }
  return () => { for (const w of watchers) w.close(); for (const p of pending.values()) clearTimeout(p.t); };
}
