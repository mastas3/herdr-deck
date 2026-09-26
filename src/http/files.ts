// Files the agents mention (the page's file viewer) and files you upload into a session.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

const DENY = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud|Library\/Keychains)(\/|$)|(^|\/)\.env(\.|$)|\.(pem|key|p12|keychain)$|api\.token$|id_(rsa|ed25519)/;
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
export async function readFileFor(cwd: string | undefined, raw: string) {
  const p = resolveSafe(cwd, raw);
  if (!p) return { error: "That path isn’t one the deck will show (outside your home folder, or a secret)." };
  let st;
  try { st = statSync(p); } catch { return { error: `Not found: ${p.replace(homedir(), "~")}` }; }
  const line = Number(raw.match(/:(\d+)(?::\d+)?$/)?.[1]) || undefined;
  if (st.isDirectory()) {
    const entries = readdirSync(p, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).slice(0, 300).map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    return { path: p, kind: "dir", entries, mtime: st.mtimeMs };
  }
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (/^(png|jpe?g|gif|webp|svg|avif)$/.test(ext)) return { path: p, kind: "image", size: st.size, mtime: st.mtimeMs };
  if (st.size > 1_500_000) return { path: p, kind: "binary", size: st.size, mtime: st.mtimeMs };
  const buf = new Uint8Array(await Bun.file(p).arrayBuffer());
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
