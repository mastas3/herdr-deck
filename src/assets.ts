// Client assets served under a content hash: every file public/assets.json names (scripts, in order, loaded as classic
// scripts where the page's SCRIPTS hook is, so they share one set of globals; styles, linked in <head>). Each is
// served at /<path>?v=<hash> with immutable caching (the service worker keeps them the same way); the page names the
// hashes, so a new deploy is picked up by the next page load and never mixes new JS with an old page.
// Loaded once at startup like the HTML; DECK_DEV re-reads a file (and the manifest) when it changes on disk.
// Running code plugins add their own scripts and styles after the deck's, served at /plugins/<id>/<file> the same way;
// a plugin that is off has no files in the page and none served.
import { existsSync, readFileSync, statSync } from "node:fs";

export type AssetManifest = { scripts?: string[]; styles?: string[] };
/** A running plugin's page files, relative to its folder, in load order. */
export type PluginAssets = { id: string; dir: string; scripts: string[]; styles: string[] };
type Asset = { path: string; type: string; mtime: number; body: Uint8Array; gz: Uint8Array; hash: string };
/** Only plain names under js/ and css/ (no "..", no subfolders): the manifest can't point anywhere else. */
const ALLOWED = /^(?:js\/[\w.-]+\.js|css\/[\w.-]+\.css)$/;
/** plugins/<id>/<file>: plain segments only, so a path can't climb out of the plugin's folder. */
const PLUGIN = /^plugins\/([a-z0-9][a-z0-9-]{1,39})\/((?:[A-Za-z0-9_][\w.-]*\/){0,3}[A-Za-z0-9_][\w.-]*\.(?:js|css))$/;
const TYPE = (p: string) => (p.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Where public/index.html wants the scripts. */
export const SCRIPTS = "<!-- scripts: public/assets.json -->";

export function createAssets(publicDir: string, o: { dev?: boolean; log?: (s: string) => void; plugins?: () => PluginAssets[] } = {}) {
  const dir = publicDir.replace(/\/+$/, "");
  const cache = new Map<string, Asset>();
  let man: { scripts: string[]; styles: string[]; mtime: number } | undefined;

  function manifest() {
    const f = `${dir}/assets.json`;
    const m = existsSync(f) ? statSync(f).mtimeMs : 0;
    if (man && (!o.dev || man.mtime === m)) return man;
    let j: AssetManifest = {};
    try { if (m) j = JSON.parse(readFileSync(f, "utf8")); } catch (e: any) { o.log?.(`assets.json: ${e?.message ?? e}`); }
    const keep = (xs: unknown, ext: string) => (Array.isArray(xs) ? xs.map(String) : []).filter((p, i, a) => {
      const ok = ALLOWED.test(p) && p.endsWith(ext) && a.indexOf(p) === i && existsSync(`${dir}/${p}`);
      if (!ok) o.log?.(`assets.json: skipping ${p}`);
      return ok;
    });
    man = { scripts: keep(j.scripts, ".js"), styles: keep(j.styles, ".css"), mtime: m };
    return man;
  }
  /** The running plugins' files as page paths ("plugins/covers/covers.js"), in load order. */
  function pluginPaths() {
    const out = { scripts: [] as string[], styles: [] as string[], files: new Map<string, string>() };
    for (const p of o.plugins?.() ?? []) for (const [kind, list] of [["scripts", p.scripts], ["styles", p.styles]] as const) for (const rel of list) {
      const path = `plugins/${p.id}/${rel}`;
      if (!PLUGIN.test(path) || out.files.has(path)) continue;
      out[kind].push(path); out.files.set(path, `${p.dir}/${rel}`);
    }
    return out;
  }
  /** One asset by its path ("js/x.js", "plugins/covers/covers.js"): read once (DEV: again when the file changes). */
  function get(path: string): Asset | undefined {
    const m = manifest();
    const f = m.scripts.includes(path) || m.styles.includes(path) ? `${dir}/${path}` : PLUGIN.test(path) ? pluginPaths().files.get(path) : undefined;
    if (!f) return undefined;
    const hit = cache.get(path);
    // A plugin's files can be re-approved in place, so they're always checked against the disk.
    if (hit && !o.dev && !path.startsWith("plugins/")) return hit;
    let mtime: number;
    try { mtime = statSync(f).mtimeMs; } catch { return undefined; }
    if (hit && hit.mtime === mtime) return hit;
    const body = new Uint8Array(readFileSync(f));
    const a: Asset = { path, type: TYPE(path), mtime, body, gz: Bun.gzipSync(body), hash: Bun.hash(body).toString(36) };
    cache.set(path, a);
    return a;
  }
  const url = (path: string) => { const a = get(path); return a ? `/${path}?v=${a.hash}` : `/${path}`; };
  /** Every script, then every style, in load order: the deck's own (public/assets.json), then running plugins'. */
  function order() {
    const m = manifest(), p = pluginPaths();
    return { scripts: [...m.scripts, ...p.scripts], styles: [...m.styles, ...p.styles] };
  }
  /** Every hashed asset in load order: scripts, then styles. */
  function list() {
    const x = order();
    return [...x.scripts, ...x.styles].map((p) => ({ path: p, hash: get(p)?.hash ?? "", url: url(p) }));
  }
  /** The page with hashed URLs: styles before </head>, the scripts at the SCRIPTS hook. */
  function inject(html: string): string {
    const m = order();
    const links = m.styles.map((p) => `<link rel="stylesheet" href="${url(p)}">`).join("\n");
    const scripts = m.scripts.map((p) => `<script src="${url(p)}"></script>`).join("\n");
    let out = html.replace(SCRIPTS, () => scripts);
    if (links) out = out.replace("</head>", `${links}\n</head>`);
    return out;
  }
  /** GET /js/*, /css/*, /plugins/<id>/*: undefined when it isn't one of ours. An old hash gets the current file, uncached. */
  function serve(req: Request, u: URL): Response | undefined {
    const path = u.pathname.slice(1);
    if (!ALLOWED.test(path) && !path.startsWith("plugins/")) return undefined;
    const a = get(path);
    if (!a) return new Response("not found", { status: 404 });
    const gz = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
    const cache = u.searchParams.get("v") === a.hash ? IMMUTABLE : "no-cache";
    return new Response(gz ? a.gz : a.body, { headers: { "content-type": a.type, "cache-control": cache, vary: "accept-encoding", ...(gz ? { "content-encoding": "gzip" } : {}) } });
  }
  return { inject, serve, list, get, url, manifest };
}
export type Assets = ReturnType<typeof createAssets>;
