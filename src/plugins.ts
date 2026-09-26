// Installed plugins, on the hub. ~/.config/herdr-deck/plugins/<id>/ holds exactly the files that were approved, and
// plugins.json records where each came from and the hash of what was approved. A candidate waits in staging
// between "review" and "install", so the trust screen and the install are about the very same bytes.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Recipe } from "./recipes";
import { PLUGIN_ID, isFileRef, parseBundle, promptText, referencedFiles, type Bundle, type Problem } from "./plugin-format";
import { diffBundles, trustSummary, type Diff, type Trust } from "./plugin-trust";

export type From = { catalog?: string; file?: string; url?: string; ref?: string };
export type Installed = { id: string; name: string; version: string; from: From; enabled: boolean; hash: string; bash: boolean; installedAt: number; updatedAt: number };
export type Preview =
  | { ok: true; staged: string; hash: string; trust: Trust; from: From; update: { fromVersion: string; diff: Diff } | null; missing: string[] }
  | { ok: false; problems: Problem[] };
export type PluginState = "on" | "off" | "changed";

const MAX_JSON = 256 * 1024, MAX_FILE = 64 * 1024, MAX_TOTAL = 1024 * 1024;
export const MAX_UPLOAD = 5 * 1024 * 1024;
const STAGE_TTL = 3600_000;
const STAGED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Runtime state that lives beside a plugin's approved files and survives an update. */
const KEEP = ["cache", "work", "usage.json"];

export function hashFiles(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k].length}\0${files[k]}\0`);
  return h.digest("hex");
}

/** A plugin folder's plugin.json and the files it points to. Symlinks and oversized files are left out, so the
 *  validator reports them as missing instead of the deck reading something outside the folder. */
export function readFolder(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const read = (rel: string, max: number) => {
    try {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) if (lstatSync(join(dir, ...parts.slice(0, i))).isSymbolicLink()) return;
      const st = lstatSync(join(dir, rel));
      if (st.isFile() && st.size <= max) files[rel] = readFileSync(join(dir, rel), "utf8");
    } catch {}
  };
  read("plugin.json", MAX_JSON);
  let raw: unknown;
  try { raw = JSON.parse(files["plugin.json"] ?? ""); } catch { return files; }
  for (const f of referencedFiles(raw)) read(f, MAX_FILE);
  return files;
}

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: new Uint8Array(out) };
}
/** plugin.json and its files from a .zip, read entry by entry (nothing is extracted to disk). A GitHub
 *  "Download ZIP" puts everything under one folder, so the shallowest plugin.json marks the plugin's root. */
export async function readZip(path: string): Promise<Record<string, string>> {
  if (!Bun.which("unzip")) throw new Error("Adding a .zip needs the unzip command on this machine. Install unzip, or drop the plugin.json instead.");
  const listing = await run(["unzip", "-Z1", path]);
  if (listing.code !== 0) throw new Error("That .zip couldn't be read.");
  const entries = new TextDecoder().decode(listing.out).split("\n").map((s) => s.trim()).filter(Boolean);
  const roots = entries.filter((e) => e === "plugin.json" || e.endsWith("/plugin.json")).sort((a, b) => a.split("/").length - b.split("/").length);
  if (!roots.length) throw new Error("There's no plugin.json in that .zip.");
  const base = roots[0].slice(0, -"plugin.json".length);
  if (!/^([\w-][\w.-]*\/)?$/.test(base)) throw new Error("The plugin.json in that .zip is too deep. Put it at the top, or one folder down.");
  const files: Record<string, string> = {};
  let total = 0;
  const take = async (rel: string, max: number) => {
    if (!entries.includes(base + rel)) return;
    const r = await run(["unzip", "-p", path, base + rel]);
    if (r.code !== 0 || r.out.length > max) return;
    total += r.out.length;
    files[rel] = new TextDecoder().decode(r.out);
  };
  await take("plugin.json", MAX_JSON);
  let raw: unknown;
  try { raw = JSON.parse(files["plugin.json"] ?? ""); } catch { return files; }
  for (const f of referencedFiles(raw)) { if (total > MAX_TOTAL) break; await take(f, MAX_FILE); }
  return files;
}

export function createPlugins(o: { dataDir: string; catalogDir: string }) {
  const root = join(o.dataDir, "plugins"), stageDir = join(root, ".staging"), listFile = join(o.dataDir, "plugins.json");
  const dirOf = (id: string) => join(root, id);

  function load(): Installed[] {
    try { const v = JSON.parse(readFileSync(listFile, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function save(list: Installed[]) {
    mkdirSync(o.dataDir, { recursive: true });
    const tmp = `${listFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 1));
    renameSync(tmp, listFile);
  }
  /** An installed plugin's files as they are on disk now, and whether they're still what was approved. */
  function current(rec: Installed) {
    const files = readFolder(dirOf(rec.id));
    const r = parseBundle(files);
    const bundle = r.ok ? r.bundle : null;
    const state: PluginState = !bundle || hashFiles(files) !== rec.hash ? "changed" : rec.enabled ? "on" : "off";
    return { files, bundle, state };
  }
  const find = (id: string) => {
    const rec = load().find((x) => x.id === id);
    if (!rec) throw new Error("That plugin isn't installed.");
    return rec;
  };

  function sweep() {
    try {
      for (const f of readdirSync(stageDir)) {
        const p = join(stageDir, f);
        try { if (Date.now() - lstatSync(p).mtimeMs > STAGE_TTL) rmSync(p, { recursive: true, force: true }); } catch {}
      }
    } catch {}
  }
  function stage(files: Record<string, string>, from: From, compare = true): Preview {
    const r = parseBundle(files);
    if (!r.ok) return { ok: false, problems: r.problems };
    sweep();
    mkdirSync(stageDir, { recursive: true });
    const staged = randomUUID();
    writeFileSync(join(stageDir, `${staged}.json`), JSON.stringify({ files, from }));
    const m = r.bundle.manifest;
    const list = load();
    const rec = list.find((x) => x.id === m.id);
    const old = compare && rec ? current(rec).bundle : null;
    return {
      ok: true, staged, hash: hashFiles(files), trust: trustSummary(r.bundle), from,
      update: rec && old ? { fromVersion: rec.version, diff: diffBundles(old, r.bundle) } : null,
      missing: (m.requires?.plugins ?? []).filter((id) => !list.some((x) => x.id === id)),
    };
  }
  function stageCatalog(id: string): Preview {
    if (!PLUGIN_ID.test(id) || !existsSync(join(o.catalogDir, id, "plugin.json"))) throw new Error("There's no catalog plugin by that name.");
    return stage(readFolder(join(o.catalogDir, id)), { catalog: id });
  }
  async function stageUpload(name: string, bytes: Uint8Array): Promise<Preview> {
    if (bytes.length > MAX_UPLOAD) throw new Error("That file is over 5 MB. A plugin is a plugin.json and a few prompt files.");
    const file = String(name).replace(/[^\w. -]/g, "").slice(0, 80) || "plugin.json";
    if (/\.zip$/i.test(file)) {
      mkdirSync(stageDir, { recursive: true });
      const tmp = join(stageDir, `${randomUUID()}.zip`);
      writeFileSync(tmp, bytes);
      try { return stage(await readZip(tmp), { file }); } finally { rmSync(tmp, { force: true }); }
    }
    if (bytes.length > MAX_JSON) throw new Error("That plugin.json is over 256 KB.");
    const pv = stage({ "plugin.json": new TextDecoder().decode(bytes) }, { file });
    if (!pv.ok && pv.problems.some((x) => x.message.includes("which isn't in the plugin")))
      pv.problems.unshift({ path: "", message: "A plugin.json on its own can't bring its prompt files: drop the plugin's folder as a .zip instead." });
    return pv;
  }
  /** Stage an installed plugin's current files again, to re-approve it after they changed on disk. */
  function review(id: string): Preview {
    const rec = find(id);
    return stage(readFolder(dirOf(id)), rec.from, false);
  }

  function install(body: { staged?: unknown; approve?: unknown; bash?: unknown }): Installed {
    const staged = String(body.staged ?? "");
    if (!STAGED_ID.test(staged)) throw new Error("Review the plugin first.");
    const stagedFile = join(stageDir, `${staged}.json`);
    let saved: { files: Record<string, string>; from: From };
    try { saved = JSON.parse(readFileSync(stagedFile, "utf8")); } catch { throw new Error("That review expired. Open the plugin again."); }
    if (!Object.keys(saved.files).every((k) => k === "plugin.json" || isFileRef(k))) throw new Error("That review is damaged. Open the plugin again.");
    const r = parseBundle(saved.files);
    if (!r.ok) throw new Error("That plugin no longer passes the checks. Open it again to see why.");
    const hash = hashFiles(saved.files);
    if (hash !== body.approve) throw new Error("The plugin changed since you reviewed it. Review it again.");
    const m = r.bundle.manifest, trust = trustSummary(r.bundle);
    if (trust.needsTick && body.bash !== true) throw new Error('Tick "Let it run the commands listed above" to install it.');
    const list = load();
    const missing = (m.requires?.plugins ?? []).filter((id) => !list.some((x) => x.id === id));
    if (missing.length) throw new Error(`Install ${missing.join(", ")} first.`);
    // Write the new files beside the old folder, carry runtime state across, then swap.
    mkdirSync(root, { recursive: true });
    const dest = dirOf(m.id), tmp = join(root, `.new-${m.id}-${randomUUID().slice(0, 8)}`);
    for (const [rel, text] of Object.entries(saved.files)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), text);
    }
    for (const k of KEEP) if (existsSync(join(dest, k))) renameSync(join(dest, k), join(tmp, k));
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    const prev = list.find((x) => x.id === m.id), now = Date.now();
    const rec: Installed = { id: m.id, name: m.name, version: m.version, from: saved.from, enabled: true, hash, bash: trust.needsTick, installedAt: prev?.installedAt ?? now, updatedAt: now };
    save([...list.filter((x) => x.id !== m.id), rec]);
    rmSync(stagedFile, { force: true });
    return rec;
  }

  function remove(id: string) {
    const list = load();
    find(id);
    const needs = list.filter((x) => x.id !== id && (current(x).bundle?.manifest.requires?.plugins ?? []).includes(id));
    if (needs.length) throw new Error(`${needs.map((x) => x.name).join(", ")} ${needs.length === 1 ? "needs" : "need"} it. Remove ${needs.length === 1 ? "that" : "those"} first.`);
    rmSync(dirOf(id), { recursive: true, force: true });
    save(list.filter((x) => x.id !== id));
  }
  function setEnabled(id: string, on: boolean) {
    const list = load();
    const rec = list.find((x) => x.id === id);
    if (!rec) throw new Error("That plugin isn't installed.");
    if (on && current(rec).state === "changed") throw new Error("Its files changed on disk since you approved them. Review it again first.");
    rec.enabled = on;
    save(list);
  }

  function catalog() {
    let dirs: string[] = [];
    try { dirs = readdirSync(o.catalogDir).filter((d) => PLUGIN_ID.test(d)).sort(); } catch {}
    const have = new Map(load().map((x) => [x.id, x]));
    return dirs.flatMap((d) => {
      const r = parseBundle(readFolder(join(o.catalogDir, d)));
      if (!r.ok || r.bundle.manifest.id !== d) return [];
      const m = r.bundle.manifest;
      return [{ id: m.id, name: m.name, version: m.version, kind: m.kind, description: m.description ?? "", icon: m.icon ?? null, installed: have.get(m.id)?.version ?? null }];
    });
  }
  function list() {
    return {
      plugins: load().map((rec) => { const c = current(rec); return { ...rec, state: c.state, trust: c.bundle ? trustSummary(c.bundle) : null }; }),
      catalog: catalog(),
    };
  }
  /** Recipes from enabled plugins whose files are as approved, ids prefixed with the plugin's. */
  function recipes(): Recipe[] {
    return load().filter((x) => x.enabled).flatMap((rec) => {
      const c = current(rec);
      if (c.state !== "on" || !c.bundle) return [];
      return (c.bundle.manifest.recipes ?? []).map((r) => ({ ...r, id: `${rec.id}.${r.id}`, prompt: promptText(c.files, r.prompt), plugin: rec.name }));
    });
  }

  async function handle(path: string, body: any): Promise<any> {
    switch (path) {
      case "/api/plugins": return list();
      case "/api/plugins/inspect": return body?.review ? review(String(body.review)) : stageCatalog(String(body?.catalog ?? ""));
      case "/api/plugins/install": install(body ?? {}); return list();
      case "/api/plugins/remove": remove(String(body?.id ?? "")); return list();
      case "/api/plugins/enable": setEnabled(String(body?.id ?? ""), body?.on === true); return list();
    }
    return undefined;
  }

  return { list, stageCatalog, stageUpload, review, install, remove, setEnabled, recipes, handle };
}
