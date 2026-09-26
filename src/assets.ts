// Client assets served under a content hash: public/app.js plus every file public/assets.json names (scripts, in
// order, loaded as classic scripts right after app.js so they share its globals; styles, linked in <head>). Each is
// served at /<path>?v=<hash> with immutable caching (the service worker keeps them the same way); the page names the
// hashes, so a new deploy is picked up by the next page load and never mixes new JS with an old page.
// Loaded once at startup like the HTML; DECK_DEV re-reads a file (and the manifest) when it changes on disk.
import { existsSync, readFileSync, statSync } from "node:fs";

export type AssetManifest = { scripts?: string[]; styles?: string[] };
type Asset = { path: string; type: string; mtime: number; body: Uint8Array; gz: Uint8Array; hash: string };
/** Only plain names under js/ and css/ (no "..", no subfolders): the manifest can't point anywhere else. */
const ALLOWED = /^(?:js\/[\w.-]+\.js|css\/[\w.-]+\.css)$/;
const TYPE = (p: string) => (p.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
const IMMUTABLE = "public, max-age=31536000, immutable";

export function createAssets(publicDir: string, o: { dev?: boolean; log?: (s: string) => void } = {}) {
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
  /** One asset by its path ("app.js", "js/x.js"): read once (DEV: again when the file changes). */
  function get(path: string): Asset | undefined {
    const m = manifest();
    if (path !== "app.js" && !m.scripts.includes(path) && !m.styles.includes(path)) return undefined;
    const f = `${dir}/${path}`;
    const hit = cache.get(path);
    if (hit && !o.dev) return hit;
    let mtime: number;
    try { mtime = statSync(f).mtimeMs; } catch { return undefined; }
    if (hit && hit.mtime === mtime) return hit;
    const body = new Uint8Array(readFileSync(f));
    const a: Asset = { path, type: TYPE(path), mtime, body, gz: Bun.gzipSync(body), hash: Bun.hash(body).toString(36) };
    cache.set(path, a);
    return a;
  }
  const url = (path: string) => { const a = get(path); return a ? `/${path}?v=${a.hash}` : `/${path}`; };
  /** Every hashed asset in load order: app.js, the manifest's scripts, then its styles. */
  function list() {
    const m = manifest();
    return ["app.js", ...m.scripts, ...m.styles].map((p) => ({ path: p, hash: get(p)?.hash ?? "", url: url(p) }));
  }
  /** The page with hashed URLs: styles before </head>, app.js then the manifest's scripts where app.js was. */
  function inject(html: string): string {
    const m = manifest();
    const links = m.styles.map((p) => `<link rel="stylesheet" href="${url(p)}">`).join("\n");
    const scripts = ["app.js", ...m.scripts].map((p) => `<script src="${url(p)}"></script>`).join("\n");
    let out = html.replace('<script src="/app.js"></script>', scripts);
    if (links) out = out.replace("</head>", `${links}\n</head>`);
    return out;
  }
  /** GET /app.js, /js/*, /css/*: undefined when it isn't one of ours. A request for an old hash gets the current file, uncached. */
  function serve(req: Request, u: URL): Response | undefined {
    const path = u.pathname.slice(1);
    if (path !== "app.js" && !ALLOWED.test(path)) return undefined;
    const a = get(path);
    if (!a) return new Response("not found", { status: 404 });
    const gz = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
    const cache = u.searchParams.get("v") === a.hash ? IMMUTABLE : "no-cache";
    return new Response(gz ? a.gz : a.body, { headers: { "content-type": a.type, "cache-control": cache, vary: "accept-encoding", ...(gz ? { "content-encoding": "gzip" } : {}) } });
  }
  return { inject, serve, list, get, url, manifest };
}
export type Assets = ReturnType<typeof createAssets>;
