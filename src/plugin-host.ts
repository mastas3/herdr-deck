// The code plugin host: finds plugins (built in: plugins-builtin/<id>/, installed: <data>/plugins/<id>/ with an approved
// hash of every file), starts the enabled ones in dependency order and lends each exactly the Host in src/plugin-api.ts.
// Everything a plugin registers (routes, timers, services, contributions) is tracked per plugin, so turning one off
// undoes all of it, and a plugin that fails (a missing dependency, a throwing activate) is marked failed on its own.
// Disabled plugins are never imported. The HTTP side (/api/plugins/code/*) is src/plugin-code-api.ts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCodeManifest, type CodeManifest } from "./plugin-code-format";
import { loadCodeState, saveCodeState, treeChanged, type CodeState } from "./plugin-code-store";
import type { Activate, Contribution, Deactivate, Host, PointName, RouteHandler } from "./plugin-api";

export type PluginStatus = "on" | "off" | "failed" | "hub-only" | "changed" | "invalid";
/** The core as the composition root lends it: everything on Host that isn't per-plugin. */
export type CoreCaps = Pick<Host, "rows" | "sessions" | "push" | "automations" | "decisions" | "broadcast" | "notice" | "machines" | "isNode">;
type Runtime = {
  deactivate?: Deactivate; stops: (() => unknown)[]; timers: Set<ReturnType<typeof setTimeout>>;
  routes: string[]; services: string[]; contribs: { point: string; c: unknown }[];
};
export type Entry = { id: string; dir: string; builtin: boolean; manifest?: CodeManifest; problems?: string; state: PluginStatus; error?: string; run?: Runtime; mod?: { activate?: Activate } };

/** SSE events the page already uses: a plugin can't send these. */
const CORE_EVENTS = new Set(["full", "patch", "queue", "graveyard", "history", "usage", "jev", "radar", "decisions", "auto", "audit", "notice", "plugins", "game"]);

export function createPluginHost(o: { builtinDir: string; root: string; dataDir: string; core: CoreCaps; reservedState?: string[]; log?: (s: string) => void }) {
  const log = o.log ?? ((s: string) => console.warn(s));
  const entries = new Map<string, Entry>();
  let order: string[] = [];
  let st: CodeState = loadCodeState(o.root);
  const apiRoutes = new Map<string, { id: string; handler: RouteHandler }>();
  const getRoutes = new Map<string, { id: string; handler: RouteHandler }>();
  const services = new Map<string, { id: string; api: object }>();
  /** Services the core still owns (e.g. `opportunities` until its plugin exists), lent to plugins under the same name. */
  const coreServices = new Map<string, object>();
  const contribs = new Map<string, { id: string; c: unknown }[]>();

  // ── finding plugins ──
  function readEntry(id: string, dir: string, builtin: boolean): Entry {
    const e: Entry = { id, dir, builtin, state: "off" };
    try {
      const r = parseCodeManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")));
      if (!r.ok) { e.state = "invalid"; e.problems = r.problems.map((p) => `${p.path} ${p.message}`.trim()).join("; "); }
      else if (r.manifest.id !== id) { e.state = "invalid"; e.problems = `its id is ${r.manifest.id}, but its folder is ${id}`; }
      else e.manifest = r.manifest;
    } catch (err: any) { e.state = "invalid"; e.problems = `plugin.json: ${err?.message ?? err}`; }
    return e;
  }
  function scan() {
    const found = new Map<string, Entry>();
    let dirs: string[] = [];
    try { dirs = readdirSync(o.builtinDir).filter((d) => existsSync(join(o.builtinDir, d, "plugin.json"))).sort(); } catch {}
    for (const d of dirs) found.set(d, readEntry(d, join(o.builtinDir, d), true));
    for (const rec of st.installed) if (!found.has(rec.id)) found.set(rec.id, readEntry(rec.id, join(o.root, "plugins", rec.id), false));
    // Keep what's running: a rescan never drops a live runtime.
    for (const [id, e] of found) { const cur = entries.get(id); if (cur?.run) { cur.manifest = e.manifest ?? cur.manifest; found.set(id, cur); } }
    for (const [id, e] of entries) if (e.run && !found.has(id)) found.set(id, e);
    entries.clear();
    for (const [id, e] of found) entries.set(id, e);
    order = sortByDeps([...entries.values()]);
  }
  /** Dependencies first; otherwise built-ins before installed, then by id. Members of a cycle go last, and never run. */
  let cyclic = new Set<string>();
  function sortByDeps(list: Entry[]): string[] {
    const deps = (e: Entry) => [...(e.manifest?.requires ?? []), ...(e.manifest?.uses ?? [])].filter((d) => entries.has(d));
    const left = new Map(list.map((e) => [e.id, e]));
    const out: string[] = [];
    while (left.size) {
      const ready = [...left.values()].filter((e) => deps(e).every((d) => !left.has(d)))
        .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.id.localeCompare(b.id));
      if (!ready.length) break;
      out.push(ready[0].id);
      left.delete(ready[0].id);
    }
    cyclic = new Set(left.keys());
    return [...out, ...[...left.keys()].sort()];
  }

  // ── what should run ──
  const enabled = (e: Entry) => st.enabled[e.id] ?? true;
  /** Why a plugin can't run now, given which plugins before it in the order are running; undefined when it can. */
  function blocker(e: Entry, running: Set<string>): { state: PluginStatus; error?: string } | undefined {
    if (!e.manifest) return { state: "invalid", error: e.problems };
    if (!enabled(e)) return { state: "off" };
    if (cyclic.has(e.id)) return { state: "failed", error: "Its dependencies need each other (a cycle)" };
    if (!e.builtin) {
      const rec = st.installed.find((x) => x.id === e.id);
      if (!rec || treeChanged(e.dir, rec.files)) return { state: "changed", error: "Its files changed since you approved them" };
    }
    if (e.manifest.machine !== "any" && o.core.isNode()) return { state: "hub-only" };
    const missing = e.manifest.requires.filter((d) => !running.has(d));
    if (missing.length) return { state: "failed", error: `Needs ${missing.map((d) => { const x = entries.get(d); return `${x?.manifest?.name ?? d} (${x ? x.state : "not installed"})`; }).join(", ")}` };
  }
  /** One pass over the plugins: stop what may no longer run (dependents first), then start what should, in order. */
  async function reconcile() {
    scan();
    const plan = new Set<string>();
    for (const id of order) if (!blocker(entries.get(id)!, plan)) plan.add(id);
    for (const id of [...order].reverse()) { const e = entries.get(id)!; if (e.run && !plan.has(id)) await deactivate(e); }
    const running = new Set<string>();
    for (const id of order) {
      const e = entries.get(id)!;
      const b = blocker(e, running);
      if (b) { if (e.run) await deactivate(e); e.state = b.state; e.error = b.error; continue; }
      if (!e.run) await activate(e);
      if (e.state === "on") running.add(id);
    }
  }

  // ── one plugin's lifetime ──
  async function activate(e: Entry) {
    const m = e.manifest!;
    const r: Runtime = { stops: [], timers: new Set(), routes: [], services: [], contribs: [] };
    e.run = r; e.error = undefined;
    try {
      if (m.server) {
        // An installed plugin's approved files are imported under their hash, so a re-approved change loads fresh.
        const rev = e.builtin ? "" : `?v=${st.installed.find((x) => x.id === e.id)?.hash ?? ""}`;
        e.mod ??= await import(join(e.dir, m.server) + rev);
        if (typeof e.mod?.activate !== "function") throw new Error(`${m.server} doesn't export activate(host)`);
        r.deactivate = (await e.mod.activate(hostFor(e, r))) ?? undefined;
      }
      e.state = "on";
    } catch (err: any) {
      await teardown(e, r);
      e.run = undefined; e.state = "failed"; e.error = err?.message ?? String(err);
      log(`plugin ${e.id} failed to start: ${e.error}`);
    }
  }
  async function deactivate(e: Entry) {
    const r = e.run;
    if (!r) return;
    e.run = undefined;
    await teardown(e, r);
    e.state = "off";
  }
  async function teardown(e: Entry, r: Runtime) {
    for (const f of [r.deactivate, ...r.stops.reverse()]) { try { await f?.(); } catch (err: any) { log(`plugin ${e.id}: stopping: ${err?.message ?? err}`); } }
    for (const t of r.timers) { clearTimeout(t); clearInterval(t); }
    r.timers.clear();
    for (const p of r.routes) { apiRoutes.delete(p); getRoutes.delete(p); }
    for (const s of r.services) services.delete(s);
    for (const { point, c } of r.contribs) contribs.set(point, (contribs.get(point) ?? []).filter((x) => x.c !== c));
  }

  function hostFor(e: Entry, r: Runtime): Host {
    const m = e.manifest!, id = e.id;
    const live = () => { if (e.run !== r) throw new Error(`${id} is turned off`); };
    const safe = (what: string, fn: () => unknown) => { if (e.run !== r) return; try { Promise.resolve(fn()).catch((err) => log(`plugin ${id}: ${what}: ${err?.message ?? err}`)); } catch (err: any) { log(`plugin ${id}: ${what}: ${err?.message ?? err}`); } };
    const providerOf = (name: string) => [...entries.values()].find((x) => x.manifest?.provides.includes(name));
    return {
      id, dir: e.dir, dataDir: o.dataDir,
      env: (name) => process.env[name],
      log: (msg) => log(`${id}: ${msg}`),
      routes(prefix, handler) {
        live();
        if (!m.routes.includes(prefix)) throw new Error(`${id}: route ${prefix} isn't listed in plugin.json "routes"`);
        const table = prefix.startsWith("/") ? getRoutes : apiRoutes;
        const owner = table.get(prefix);
        if (owner) throw new Error(`${id}: ${prefix} is already served by ${owner.id}`);
        table.set(prefix, { id, handler });
        r.routes.push(prefix);
      },
      every(ms, fn) {
        live();
        const t = setInterval(() => safe("timer", fn), Math.max(1000, ms));
        (t as any).unref?.(); r.timers.add(t);
        return () => { clearInterval(t); r.timers.delete(t); };
      },
      after(ms, fn) {
        live();
        const t = setTimeout(() => { r.timers.delete(t); safe("timer", fn); }, Math.max(0, ms));
        (t as any).unref?.(); r.timers.add(t);
        return () => { clearTimeout(t); r.timers.delete(t); };
      },
      onStop(fn) { live(); r.stops.push(fn); },
      provide(name, api) {
        live();
        if (!m.provides.includes(name)) throw new Error(`${id}: service ${name} isn't listed in plugin.json "provides"`);
        if (services.has(name)) throw new Error(`${id}: service ${name} is already provided by ${services.get(name)!.id}`);
        services.set(name, { id, api }); r.services.push(name);
      },
      use<T>(name: string) {
        const p = providerOf(name);
        if (!p) return coreServices.get(name) as T | undefined;
        if (p.id !== id && !m.requires.includes(p.id) && !m.uses.includes(p.id)) throw new Error(`${id}: the ${name} service comes from ${p.id}; list it in plugin.json "requires" or "uses"`);
        return services.get(name)?.api as T | undefined;
      },
      extend(point, c) {
        live();
        if (!m.extends.includes(point)) throw new Error(`${id}: extension point ${point} isn't listed in plugin.json "extends"`);
        checkContribution(id, point, c);
        contribs.set(point, [...(contribs.get(point) ?? []), { id, c }]);
        r.contribs.push({ point, c });
      },
      contributions: (point) => contributions(point),
      setting: <T>(key: string) => (st.settings[id]?.[key] ?? m.settings[key]?.default) as T,
      rows: () => o.core.rows(), sessions: o.core.sessions, push: o.core.push, automations: () => o.core.automations(), decisions: () => o.core.decisions(),
      broadcast(event, data) { if (CORE_EVENTS.has(event)) throw new Error(`${id}: "${event}" is one of the deck's own events`); o.core.broadcast(event, data); },
      notice: (n) => o.core.notice(n), machines: () => o.core.machines(), isNode: () => o.core.isNode(),
    };
  }
  function checkContribution(id: string, point: string, c: any) {
    const bad = (why: string) => { throw new Error(`${id}: ${point}: ${why}`); };
    if (point === "fullState") {
      if (typeof c?.key !== "string" || typeof c.get !== "function") bad("needs { key, get }");
      if (o.reservedState?.includes(c.key) || contributions("fullState").some((x) => x.key === c.key)) bad(`the key ${c.key} is taken`);
    }
    if (point === "digest.lines" && (typeof c?.title !== "string" || typeof c.lines !== "function")) bad("needs { title, lines }");
    if (point === "mcp.tools") {
      if (typeof c?.name !== "string" || typeof c.call !== "function" || !c.inputSchema) bad("needs { name, description, inputSchema, call }");
      if (contributions("mcp.tools").some((x) => x.name === c.name)) bad(`the tool ${c.name} is taken`);
    }
    if (point === "tools.entries" && (typeof c?.id !== "string" || typeof c.label !== "string")) bad("needs a tool with an id and a label");
  }
  function contributions<P extends PointName>(point: P): Contribution<P>[] {
    const rank = (x: string) => order.indexOf(x);
    return [...(contribs.get(point) ?? [])].sort((a, b) => rank(a.id) - rank(b.id)).map((x) => x.c as Contribution<P>);
  }

  // ── requests ──
  async function call(id: string, handler: RouteHandler, req: Request, url: URL, body: any): Promise<Response | undefined> {
    try {
      const out = await handler({ method: req.method, path: url.pathname, url, body, req });
      if (out === undefined) return undefined;
      return out instanceof Response ? out : Response.json(out);
    } catch (err: any) {
      log(`plugin ${id}: ${url.pathname}: ${err?.message ?? err}`);
      return Response.json({ error: err?.message ?? String(err), plugin: id }, { status: 500 });
    }
  }
  /** POST /api/<prefix>[/…] a running plugin serves (the caller has checked the action token). */
  async function api(req: Request, url: URL, body: any) {
    const seg = url.pathname.split("/")[2] ?? "";
    const r = apiRoutes.get(seg);
    return r ? call(r.id, r.handler, req, url, body) : undefined;
  }
  /** GET under a path prefix a running plugin serves. */
  async function get(req: Request, url: URL) {
    const seg = `/${url.pathname.split("/")[1] ?? ""}/`;
    const r = getRoutes.get(seg);
    return r ? call(r.id, r.handler, req, url, {}) : undefined;
  }
  const isPage = (path: string) => active().some((e) => e.manifest!.pages.some((p) => path === p || path.startsWith(`${p}/`)));
  const active = () => order.map((id) => entries.get(id)!).filter((e) => e.state === "on");

  async function setEnabled(id: string, on: boolean) {
    if (!entries.has(id)) throw new Error("There's no plugin by that name.");
    st = { ...st, enabled: { ...st.enabled, [id]: on } };
    saveCodeState(o.root, st);
    await reconcile();
  }
  async function setSetting(id: string, key: string, value: unknown) {
    const def = entries.get(id)?.manifest?.settings[key];
    if (!def) throw new Error("That plugin has no such setting.");
    if (typeof value !== def.type) throw new Error(`${def.label} takes a ${def.type}.`);
    st = { ...st, settings: { ...st.settings, [id]: { ...st.settings[id], [key]: value as any } } };
    saveCodeState(o.root, st);
  }

  return {
    start: reconcile, reconcile, setEnabled, setSetting, api, get, isPage, contributions,
    setting: (id: string, key: string) => st.settings[id]?.[key] ?? entries.get(id)?.manifest?.settings[key]?.default,
    /** Lend plugins a service the core still owns, under its fixed name; a plugin that provides the name takes over.
     *  Idempotent: providing it again replaces it. */
    provideCore(name: string, api: object) { coreServices.set(name, api); },
    /** Core's own access to a service (no dependency check): undefined while its plugin is off. */
    service: <T = any>(name: string) => services.get(name)?.api as T | undefined,
    /** Running plugins' page files, in load order (src/assets.ts appends them after the deck's own). */
    assets: () => active().map((e) => ({ id: e.id, dir: e.dir, scripts: e.manifest!.client, styles: e.manifest!.styles })),
    /** fullState slices from running plugins. */
    state: () => Object.fromEntries(contributions("fullState").map((c) => { try { return [c.key, c.get()]; } catch { return [c.key, null]; } })),
    active: () => active().map((e) => e.id),
    entries: () => order.map((id) => entries.get(id)!),
    timers: (id: string) => entries.get(id)?.run?.timers.size ?? 0,
    /** The installer's side: remember an approved plugin (its file hashes) or forget one, then start or stop it. */
    async record(rec: CodeState["installed"][number] | { remove: string }) {
      const id = "remove" in rec ? rec.remove : rec.id;
      const e = entries.get(id);
      if (e?.run) await deactivate(e);
      if (e) e.mod = undefined;
      const installed = st.installed.filter((x) => x.id !== id);
      st = { ...st, installed: "remove" in rec ? installed : [...installed, rec], enabled: { ...st.enabled, [id]: !("remove" in rec) } };
      saveCodeState(o.root, st);
      await reconcile();
    },
    installed: () => st.installed,
    stop: async () => { for (const id of [...order].reverse()) { const e = entries.get(id)!; if (e.run) await deactivate(e); } },
  };
}
export type PluginHost = ReturnType<typeof createPluginHost>;
