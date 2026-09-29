// The page and its files: index.html with the live state inlined, the hashed client assets, fonts, icons and the
// service worker; plus the reply helpers every route uses.
import { readFileSync } from "node:fs";
import { createAssets, type PluginAssets } from "../assets";

const PUBLIC = new URL("../../public", import.meta.url).pathname;
const HTML_PATH = `${PUBLIC}/index.html`;

/** The page, read at startup (DEV: on every load). */
export function createPage(o: { dev: boolean; fullState: () => unknown; plugins: () => PluginAssets[]; distrust?: (id: string, file: string) => void }) {
  // The files public/assets.json names, then running plugins' files, are served under content hashes (src/assets.ts).
  const assets = createAssets(PUBLIC, { dev: o.dev, log: (s) => console.warn(s), plugins: o.plugins, distrust: o.distrust });
  let htmlTemplate = readFileSync(HTML_PATH, "utf8");
  function page() {
    if (o.dev) htmlTemplate = readFileSync(HTML_PATH, "utf8");
    const boot = JSON.stringify(o.fullState()).replace(/</g, "\\u003c");
    return assets.inject(htmlTemplate.replace("/*__BOOT__*/", `window.__BOOT__=${boot};`));
  }
  return { assets, page };
}

/** gzip for anything text-like and big enough to matter (the tailnet path is the slow one). */
export function send(req: Request, body: string | Uint8Array, type: string, cache = "no-store", status = 200) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers: Record<string, string> = { "content-type": type, "cache-control": cache, vary: "accept-encoding" };
  if (bytes.length > 1400 && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
    headers["content-encoding"] = "gzip";
    return new Response(Bun.gzipSync(bytes, { level: 4 }), { status, headers });
  }
  return new Response(bytes, { status, headers });
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });

/** JSON replies (detail, chat, terminal reads) compress well; streams and binaries pass through. */
export async function gzipJson(req: Request, res: Response): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json") || res.headers.get("content-encoding")) return res;
  if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 1400) return new Response(bytes, { status: res.status, headers: res.headers });
  const headers = new Headers(res.headers);
  headers.set("content-encoding", "gzip");
  headers.set("vary", "accept-encoding");
  return new Response(Bun.gzipSync(bytes, { level: 4 }), { status: res.status, headers });
}

const DAY = "public, max-age=86400";
const STATIC: Record<string, [string, string]> = {
  "/manifest.webmanifest": ["application/manifest+json", DAY],
  "/icon.svg": ["image/svg+xml", DAY],
  "/icon-180.png": ["image/png", DAY],
  "/icon-192.png": ["image/png", DAY],
  "/icon-512.png": ["image/png", DAY],
  "/icon-maskable-512.png": ["image/png", DAY],
  "/offline.html": ["text/html; charset=utf-8", "no-cache"],
  "/sw.js": ["text/javascript; charset=utf-8", "no-cache"],
};

/** GET a font or one of the fixed files above; undefined when it isn't one (or the font isn't there). */
export async function staticFile(url: URL): Promise<Response | undefined> {
  if (url.pathname.startsWith("/fonts/") && /^\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) {
    const f = Bun.file(`${PUBLIC}${url.pathname}`);
    if (await f.exists()) return new Response(f, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
  }
  const asset = STATIC[url.pathname];
  if (asset) {
    return new Response(Bun.file(`${PUBLIC}${url.pathname}`), {
      headers: { "content-type": asset[0], "cache-control": asset[1], ...(url.pathname === "/sw.js" ? { "service-worker-allowed": "/" } : {}) },
    });
  }
}
