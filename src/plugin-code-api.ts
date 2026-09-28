// /api/plugins/code/*: the Plugins view's side of code plugins. Listing and switching them on and off, and installing
// one from a local folder or a git repo pinned to a commit. An install is staged first: the trust screen shows the
// staged files and what the manifest asks for, and "install" moves exactly those bytes (checked by hash) into
// <data>/plugins/<id>/. The approved sha256 of every file is kept, so any later change turns the plugin off.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseCodeManifest } from "./plugin-code-format";
import { hashOf, hashTree, type CodeFrom } from "./plugin-code-store";
import type { PluginHost } from "./plugin-host";

const STAGED = /^code-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const GIT_URL = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/\/|\/)[^\s]+$/;
export const TRUST_LINE = "This plugin runs code on this machine with your full permissions.";

async function run(cmd: string[], cwd?: string, ms = 90_000): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), ms);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(err.trim().split("\n").pop() || `${cmd[0]} failed`);
  return out.trim();
}

export function createCodePluginApi(o: { host: PluginHost; root: string; broadcast: (event: string, data: unknown) => void; dataPluginIds: () => string[] }) {
  const pluginsDir = join(o.root, "plugins"), stageDir = join(pluginsDir, ".staging");
  const changed = () => o.broadcast("plugins", { active: o.host.active() });

  function list() {
    return {
      trust: TRUST_LINE,
      plugins: o.host.entries().map((e) => {
        const m = e.manifest, rec = o.host.installed().find((x) => x.id === e.id);
        return {
          id: e.id, name: m?.name ?? e.id, version: m?.version ?? "", description: m?.description ?? "", builtin: e.builtin, state: e.state, error: e.error ?? e.problems,
          fault: e.fault, dev: e.dev ? e.dir : undefined,
          machine: m?.machine ?? "hub", requires: m?.requires ?? [], uses: m?.uses ?? [], timers: o.host.timers(e.id), from: rec?.from,
          offers: m ? { routes: m.routes, pages: m.pages, provides: m.provides, extends: m.extends, client: m.client, styles: m.styles, server: !!m.server } : null,
          settings: m ? Object.entries(m.settings).map(([key, s]) => ({ key, ...s, value: o.host.setting(e.id, key) })) : [],
        };
      }),
    };
  }

  /** Copy (or clone) a candidate into staging and describe it for the trust screen. */
  async function stage(from: CodeFrom, fill: (dir: string) => Promise<void>) {
    mkdirSync(stageDir, { recursive: true });
    // Reviews nobody installed within the hour go.
    for (const f of readdirSync(stageDir)) if (f.startsWith("code-")) try { if (Date.now() - lstatSync(join(stageDir, f)).mtimeMs > 3600_000) rmSync(join(stageDir, f), { recursive: true, force: true }); } catch {}
    const staged = `code-${randomUUID()}`, dir = join(stageDir, staged);
    try {
      await fill(dir);
      writeFileSync(`${dir}.from.json`, JSON.stringify(from));
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      const r = parseCodeManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")));
      if (!r.ok) return { ok: false as const, problems: r.problems };
      const m = r.manifest;
      const files = hashTree(dir);
      const missing = [m.server, ...m.client, ...m.styles].filter((f) => f && !files[f]);
      if (missing.length) return { ok: false as const, problems: missing.map((f) => ({ path: "", message: `${f} isn't in the plugin's folder` })) };
      const builtin = o.host.entries().find((e) => e.id === m.id && e.builtin);
      if (builtin) return { ok: false as const, problems: [{ path: "id", message: `${m.id} is a built-in plugin` }] };
      if (o.dataPluginIds().includes(m.id)) return { ok: false as const, problems: [{ path: "id", message: `A data plugin called ${m.id} is installed` }] };
      const old = o.host.installed().find((x) => x.id === m.id);
      const known = new Set(o.host.entries().map((e) => e.id));
      return {
        ok: true as const, staged, hash: hashOf(files), from, trust: TRUST_LINE,
        manifest: m, files: Object.keys(files).map((path) => ({ path, bytes: statSync(join(dir, path)).size })),
        update: old ? { fromVersion: old.version } : null, missing: m.requires.filter((d) => !known.has(d)),
      };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}.from.json`, { force: true });
      throw e;
    }
  }
  function fromFolder(folder: string) {
    if (!isAbsolute(folder) || !existsSync(join(folder, "plugin.json"))) throw new Error("Give the full path of a folder with a plugin.json in it.");
    return stage({ folder }, async (dir) => { cpSync(folder, dir, { recursive: true, filter: (src) => !src.split("/").includes(".git") }); });
  }
  function fromGit(url: string, commit: string) {
    if (!GIT_URL.test(url)) throw new Error("Use an https://, ssh:// or git@ address (or a local path) for the repo.");
    if (!COMMIT.test(commit)) throw new Error("Pin it to a full 40-character commit, so what you review is what runs.");
    return stage({ git: url, commit }, async (dir) => {
      await run(["git", "clone", "--quiet", "--no-checkout", "--", url, dir]);
      await run(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", commit], dir);
      if ((await run(["git", "rev-parse", "HEAD"], dir)) !== commit) throw new Error("That commit isn't in the repo.");
    });
  }
  function review(id: string) {
    const rec = o.host.installed().find((x) => x.id === id);
    if (!rec) throw new Error("That plugin isn't installed.");
    return stage(rec.from, async (dir) => { cpSync(join(pluginsDir, id), dir, { recursive: true }); });
  }

  async function install(body: any) {
    const staged = String(body?.staged ?? "");
    if (!STAGED.test(staged) || !existsSync(join(stageDir, staged))) throw new Error("That review expired. Open the plugin again.");
    const dir = join(stageDir, staged);
    const files = hashTree(dir);
    if (hashOf(files) !== body?.approve) throw new Error("The plugin changed since you reviewed it. Review it again.");
    const r = parseCodeManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")));
    if (!r.ok) throw new Error("That plugin no longer passes the checks.");
    const m = r.manifest, dest = join(pluginsDir, m.id);
    if (o.host.entries().some((e) => e.id === m.id && e.builtin) || o.dataPluginIds().includes(m.id)) throw new Error(`The name ${m.id} is taken.`);
    let from: CodeFrom = {};
    try { from = JSON.parse(readFileSync(`${dir}.from.json`, "utf8")); } catch {}
    await o.host.record({ remove: m.id });
    rmSync(dest, { recursive: true, force: true });
    renameSync(dir, dest);
    rmSync(`${dir}.from.json`, { force: true });
    await o.host.record({ id: m.id, name: m.name, version: m.version, from, files, hash: hashOf(files), approvedAt: Date.now() });
    changed();
  }
  async function remove(id: string) {
    if (!o.host.installed().some((x) => x.id === id)) throw new Error("Only installed plugins can be removed; built-ins can be turned off.");
    await o.host.record({ remove: id });
    rmSync(join(pluginsDir, id), { recursive: true, force: true });
    changed();
  }

  async function handle(path: string, body: any): Promise<unknown> {
    switch (path) {
      case "/api/plugins/code": return list();
      case "/api/plugins/code/enable": await o.host.setEnabled(String(body?.id ?? ""), body?.on === true); changed(); return list();
      case "/api/plugins/code/setting": await o.host.setSetting(String(body?.id ?? ""), String(body?.key ?? ""), body?.value); return list();
      case "/api/plugins/code/inspect":
        if (body?.review) return review(String(body.review));
        if (body?.git) return fromGit(String(body.git).trim(), String(body.commit ?? "").trim());
        return fromFolder(String(body?.folder ?? "").trim());
      case "/api/plugins/code/install": await install(body); return list();
      case "/api/plugins/code/remove": await remove(String(body?.id ?? "")); return list();
    }
    return undefined;
  }
  return { handle, list };
}
