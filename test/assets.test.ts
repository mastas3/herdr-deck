import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SCRIPTS, createAssets } from "../src/assets";

const root = mkdtempSync(`${tmpdir()}/deck-assets-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PUB = new URL("../public", import.meta.url).pathname;

function fixture() {
  const dir = mkdtempSync(`${root}/pub-`);
  mkdirSync(`${dir}/js`); mkdirSync(`${dir}/css`);
  writeFileSync(`${dir}/js/b.js`, "A += 2;".repeat(400));
  writeFileSync(`${dir}/js/a.js`, "A *= 3;");
  writeFileSync(`${dir}/js/unlisted.js`, "nope");
  writeFileSync(`${dir}/css/g.css`, ".g { color: red }");
  writeFileSync(`${dir}/assets.json`, JSON.stringify({ scripts: ["js/b.js", "js/a.js", "js/../app.js", "js/missing.js"], styles: ["css/g.css"] }));
  return dir;
}
const HTML = `<html><head><title>x</title></head><body><script>/*__BOOT__*/</script>\n${SCRIPTS}\n</body></html>`;
const get = (a: ReturnType<typeof createAssets>, path: string, gzip = false) => a.serve(new Request(`http://127.0.0.1${path}`, { headers: gzip ? { "accept-encoding": "gzip" } : {} }), new URL(`http://127.0.0.1${path}`));

describe("hashed client assets", () => {
  test("the page loads the manifest's scripts in their declared order, after the boot state, and links the styles in <head>", () => {
    const a = createAssets(fixture());
    const out = a.inject(HTML);
    const srcs = [...out.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    expect(srcs.map((s) => s.split("?")[0])).toEqual(["/js/b.js", "/js/a.js"]);
    for (const s of srcs) expect(s).toMatch(/\?v=[0-9a-z]+$/);
    expect(out).toMatch(/<link rel="stylesheet" href="\/css\/g\.css\?v=[0-9a-z]+">\n<\/head>/);
    expect(out.indexOf("__BOOT__")).toBeLessThan(out.indexOf("/js/b.js?v="));
    expect(out).not.toContain(SCRIPTS);
    // Entries that escape js/ or don't exist are skipped, never served.
    expect(a.list().map((x) => x.path)).toEqual(["js/b.js", "js/a.js", "css/g.css"]);
  });
  test("the current hash is immutable, an old one isn't cached, and unlisted files are 404", async () => {
    const a = createAssets(fixture());
    const b = a.list().find((x) => x.path === "js/b.js")!;
    const hit = get(a, `/js/b.js?v=${b.hash}`, true)!;
    expect(hit.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(hit.headers.get("content-encoding")).toBe("gzip");
    expect(hit.headers.get("content-type")).toContain("javascript");
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await hit.arrayBuffer())))).toStartWith("A += 2;");
    expect(get(a, "/js/b.js?v=old")!.headers.get("cache-control")).toBe("no-cache");
    expect(get(a, `/css/g.css?v=${a.list()[2].hash}`)!.headers.get("content-type")).toContain("text/css");
    expect(get(a, "/js/unlisted.js")!.status).toBe(404);
    expect(get(a, "/js/missing.js")!.status).toBe(404);
    expect(get(a, "/icon.svg")).toBeUndefined();
    expect(get(a, "/app.js")).toBeUndefined();
  });
  test("a changed file gets a new hash in dev (and keeps its first one otherwise)", () => {
    const dir = fixture();
    const dev = createAssets(dir, { dev: true }), prod = createAssets(dir);
    const h0 = dev.url("js/a.js"), p0 = prod.url("js/a.js");
    writeFileSync(`${dir}/js/a.js`, "A *= 4; // changed");
    const t = new Date(Date.now() + 5000);
    require("node:fs").utimesSync(`${dir}/js/a.js`, t, t);
    expect(dev.url("js/a.js")).not.toBe(h0);
    expect(prod.url("js/a.js")).toBe(p0);
  });
  test("the real manifest: files exist, stay under 400 lines, and the page has the hooks inject needs", () => {
    const a = createAssets(PUB);
    const m = a.manifest();
    expect(m.scripts.length).toBeGreaterThan(0);
    expect(m.styles).toContain("css/gallery.css");
    for (const p of [...m.scripts, ...m.styles]) expect(readFileSync(`${PUB}/${p}`, "utf8").split("\n").length).toBeLessThan(400);
    const html = readFileSync(`${PUB}/index.html`, "utf8");
    expect(html).toContain(SCRIPTS);
    const out = a.inject(html);
    for (const p of m.scripts) expect(out).toContain(`/${p}?v=`);
  });
});

/** Names a classic script declares at its top level (they all share one global scope): functions, classes, and each
 *  declarator of a const/let/var statement that starts a line (brackets and strings skipped, so only its own commas split). */
function topLevelNames(src: string): string[] {
  const out: string[] = [];
  for (const line of src.split("\n")) {
    const f = line.match(/^(?:async\s+)?(?:function\*?|class)\s+([\w$]+)/);
    if (f) { out.push(f[1]); continue; }
    const v = line.match(/^(?:const|let|var)\s+(.*)$/);
    if (!v) continue;
    let depth = 0, quote = "", part = "";
    const parts: string[] = [];
    for (const c of v[1]) {
      if (quote) { if (c === quote) quote = ""; part += c; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (depth === 0 && (c === "," || c === ";")) { parts.push(part); part = ""; if (c === ";") break; continue; }
      part += c;
    }
    parts.push(part);
    for (const p of parts) { const m = p.trim().match(/^([\w$]+)\s*(?:=|$)/); if (m) out.push(m[1]); }
  }
  return out;
}

describe("client files", () => {
  const raw = JSON.parse(readFileSync(`${PUB}/assets.json`, "utf8"));
  test("every script and style public/assets.json names exists", () => {
    for (const p of [...raw.scripts, ...raw.styles]) expect(existsSync(`${PUB}/${p}`) ? p : `missing: ${p}`).toBe(p);
  });
  test("no two client scripts declare the same top-level name (they share one global scope)", () => {
    const seen = new Map<string, string>(), dups: string[] = [];
    for (const p of raw.scripts) for (const n of topLevelNames(readFileSync(`${PUB}/${p}`, "utf8"))) {
      if (seen.has(n)) dups.push(`${n}: ${seen.get(n)} and ${p}`);
      else seen.set(n, p);
    }
    expect(dups).toEqual([]);
    expect(seen.get("S")).toBe("js/core.js"); // the scanner finds what it should
    expect(seen.get("renderList")).toBe("js/list.js");
    expect(seen.get("queued")).toBe("js/list.js"); // "let lastOrder = "", queued = false"
  });
  test("the scanner reads one statement's declarators, not its brackets", () => {
    expect(topLevelNames('const a = f(1, 2), b = { c: 3, d: [4, 5] };\nlet e, g = "x,y";\n  const inner = 1;\nasync function h() {}\nfunction* k() {}')).toEqual(["a", "b", "e", "g", "h", "k"]);
  });
});

describe("service worker", () => {
  // Runs public/sw.js against stub browser APIs and records what each fetch does.
  function sw() {
    const listeners: Record<string, Function> = {};
    const store = new Map<string, Response>();
    const cache = { put: async (r: { url: string }, res: Response) => { store.set(r.url, res); }, keys: async () => [...store.keys()].map((url) => ({ url })), delete: async (r: { url: string }) => store.delete(r.url), addAll: async () => {} };
    const caches = { match: async (r: { url: string }) => store.get(r.url), open: async () => cache, keys: async () => [], delete: async () => true };
    const self: any = { addEventListener: (k: string, f: Function) => { listeners[k] = f; }, registration: {}, clients: {} };
    const src = readFileSync(`${PUB}/sw.js`, "utf8");
    new Function("self", "caches", "fetch", "location", `${src}\n;self.__CACHE = CACHE;`)(self, caches, async (r: { url: string }) => new Response(`body of ${r.url}`), { origin: "http://deck" });
    const fetchOf = async (path: string) => {
      let responded: Promise<Response> | undefined;
      listeners.fetch({ request: { url: `http://deck${path}`, method: "GET", mode: "no-cors" }, respondWith: (p: Promise<Response>) => { responded = p; } });
      if (responded) await responded;
      return !!responded;
    };
    return { fetchOf, store, self };
  }
  test("hashed js/* and css/* are served cache-first; a new version replaces the old one", async () => {
    const w = sw();
    expect(w.self.__CACHE).not.toBe("deck-v7");
    for (const p of ["/js/core.js?v=1", "/js/gallery-core.js?v=1", "/css/gallery.css?v=1"]) expect(await w.fetchOf(p)).toBe(true);
    await Bun.sleep(20);
    expect(w.store.has("http://deck/js/gallery-core.js?v=1")).toBe(true);
    await w.fetchOf("/js/gallery-core.js?v=2");
    await Bun.sleep(20);
    expect(w.store.has("http://deck/js/gallery-core.js?v=1")).toBe(false);
    expect(w.store.has("http://deck/js/gallery-core.js?v=2")).toBe(true);
  });
  test("unhashed assets, the API and other paths go to the network", async () => {
    const w = sw();
    for (const p of ["/js/gallery-core.js", "/api/ideas/state", "/js/sub/x.js?v=1", "/events"]) expect(await w.fetchOf(p)).toBe(false);
  });
});
