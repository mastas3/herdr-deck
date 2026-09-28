// Files the agents mention (the page's file viewer) and files you upload into a session.
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";

// .env files hold secrets; their checked-in templates (.env.example, .env.sample, .env.template) don't.
const DENY = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud|Library\/Keychains)(\/|$)|(^|\/)\.env(?!\.(?:example|sample|template)$)(\.|$)|\.(pem|key|p12|keychain)$|api\.token$|id_(rsa|ed25519)/;
/** Paths an agent mentioned, resolved against its folder; only files in your home, and never keys or secrets. */
export function resolveSafe(cwd: string | undefined, raw: string): string | undefined {
  let p = raw.trim().replace(/^file:\/\//, "").replace(/:\d+(:\d+)?$/, "");
  if (!p) return;
  // [[wiki-page]]: the LLM wiki's page folders, first match wins
  const wiki = p.match(/^wiki:([\w.-]+)$/);
  if (wiki) {
    const base = process.env.DECK_WIKI_DIR ?? `${homedir()}/wiki`;
    p = ["projects", "concepts", "entities", "synthesis", "sources", ""].map((d) => `${base}/${d ? d + "/" : ""}${wiki[1]}.md`).find((f) => existsSync(f)) ?? `${base}/${wiki[1]}.md`;
  }
  if (p.startsWith("~/")) p = homedir() + p.slice(1);
  else if (!p.startsWith("/")) { if (!cwd) return; p = `${cwd}/${p}`; }
  p = new URL("file://" + p).pathname; // normalises ../
  p = decodeURIComponent(p);
  if (!p.startsWith(homedir() + "/") && !p.startsWith("/tmp/") && !p.startsWith("/private/tmp/")) return;
  if (DENY.test(p)) return;
  return p;
}
let realHome: string | undefined;
/**
 * A path resolveSafe allowed, followed through symlinks: its real location must pass the same rules, so a link in a
 * session's folder can't lead to ~/.ssh, a .env elsewhere or out of your home. Returns the real path, or undefined when
 * it is refused or doesn't exist. A home folder behind a symlink (/var → /private/var) is still your home.
 */
export function realSafe(p: string): string | undefined {
  let real: string;
  try { real = realpathSync(p); } catch { return; }
  if (resolveSafe(undefined, real) === real) return real;
  const h = homedir();
  realHome ??= (() => { try { return realpathSync(h); } catch { return h; } })();
  if (realHome === h || !real.startsWith(realHome + "/")) return;
  const asHome = h + real.slice(realHome.length);
  return resolveSafe(undefined, asHome) === asHome ? real : undefined;
}
/** resolveSafe, then realSafe: what the file viewer, its raw files and "open on the Mac" may touch. */
export function resolveReal(cwd: string | undefined, raw: string): string | undefined {
  const p = resolveSafe(cwd, raw);
  return p && realSafe(p);
}
export async function readFileFor(cwd: string | undefined, raw: string) {
  const p = resolveSafe(cwd, raw);
  if (!p) return { error: "That path isn’t one the deck will show (outside your home folder, or a secret)." };
  if (!existsSync(p)) return { error: `Not found: ${p.replace(homedir(), "~")}` };
  const real = realSafe(p);
  if (!real) return { error: "That path isn’t one the deck will show (it links outside your home folder, or to a secret)." };
  let st;
  try { st = statSync(real); } catch { return { error: `Not found: ${p.replace(homedir(), "~")}` }; }
  const line = Number(raw.match(/:(\d+)(?::\d+)?$/)?.[1]) || undefined;
  if (st.isDirectory()) {
    const entries = readdirSync(real, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).slice(0, 300).map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    return { path: p, kind: "dir", entries, mtime: st.mtimeMs };
  }
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (/^(png|jpe?g|gif|webp|svg|avif)$/.test(ext)) return { path: p, kind: "image", size: st.size, mtime: st.mtimeMs };
  if (st.size > 1_500_000) return { path: p, kind: "binary", size: st.size, mtime: st.mtimeMs };
  const buf = new Uint8Array(await Bun.file(real).arrayBuffer());
  if (buf.subarray(0, 8000).includes(0)) return { path: p, kind: "binary", size: st.size, mtime: st.mtimeMs };
  return { path: p, kind: /^(md|markdown|mdx)$/.test(ext) ? "markdown" : "text", ext, size: st.size, mtime: st.mtimeMs, line, content: new TextDecoder().decode(buf) };
}

const UPLOAD_DIR = `${homedir()}/.cache/herdr-deck/uploads`;
export async function saveUpload(req: Request, name: string) {
  const safe = name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(-120) || "file";
  const d = new Date();
  const dir = `${UPLOAD_DIR}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${Date.now().toString(36)}-${safe}`;
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > 100 * 1024 * 1024) throw new Error("Files up to 100 MB");
  await Bun.write(path, buf);
  return { path, size: buf.length, name: safe };
}
