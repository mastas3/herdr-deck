// The folder window's listing: one folder of a project, read-only. Everything stays inside the project's root (real
// paths, so a symlink can't lead out of it) and inside what the file viewer may show (resolveSafe: your home, no secrets).
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { resolveSafe } from "./files";

export type DirEntry = { name: string; kind: "dir" | "file" | "link"; size?: number; mtime?: number; hidden: boolean; to?: "dir" | "file"; out?: boolean };
export type DirListing = { root: string; path: string; abs: string; entries: DirEntry[]; total: number; truncated: boolean } | { error: string };

export const MAX_ENTRIES = 2000;
/** resolveSafe for a real path: when the home folder itself sits behind a symlink (/var → /private/var), its real
 *  path is still "in your home". */
const realHomes = new Map<string, string>();
async function safeReal(p: string) {
  if (resolveSafe(undefined, p)) return true;
  const h = homedir();
  if (!realHomes.has(h)) realHomes.set(h, await realpath(h).catch(() => h));
  const real = realHomes.get(h)!;
  return real !== h && p.startsWith(real + sep) && !!resolveSafe(undefined, h + p.slice(real.length));
}
const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Runs `fn` over `xs` with at most `n` in flight, so a folder of thousands never opens thousands of stats at once. */
async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  const worker = async () => { while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}

/** `rootRaw` is the project's folder (absolute or ~/…), `rel` a folder inside it ("" for the root itself). */
export async function listDir(rootRaw: string, rel: string, max = MAX_ENTRIES): Promise<DirListing> {
  const safeRoot = rootRaw.startsWith("/") || rootRaw.startsWith("~/") ? resolveSafe(undefined, rootRaw)?.replace(/(.)\/+$/, "$1") : undefined;
  if (!safeRoot) return { error: "That folder isn’t one the deck will show (outside your home folder, or a secret)." };
  let root: string;
  try { root = await realpath(safeRoot); } catch { return { error: "That project folder no longer exists." }; }
  if (!(await safeReal(root))) return { error: "That folder isn’t one the deck will show." };
  const want = resolve(root, "./" + String(rel ?? "").replace(/^\/+/, ""));
  if (!inside(root, want)) return { error: "That folder is outside the project." };
  let abs: string;
  try { abs = await realpath(want); } catch { return { error: "That folder no longer exists." }; }
  // Checked again on the real path: a link inside the project may point anywhere.
  if (!inside(root, abs)) return { error: "That folder is outside the project." };
  if (abs !== root && !(await safeReal(abs))) return { error: "That folder isn’t one the deck will show." };
  try { if (!(await stat(abs)).isDirectory()) return { error: "That isn’t a folder." }; } catch { return { error: "That folder no longer exists." }; }
  let dirents;
  try { dirents = await readdir(abs, { withFileTypes: true }); } catch (e: any) { return { error: e?.code === "EACCES" ? "The deck isn’t allowed to read that folder." : "That folder can’t be read." }; }
  // Folders first, then by name, and cut to the cap before anything is stat'ed: a huge folder costs only one readdir.
  dirents.sort((a, b) => Number(!a.isDirectory()) - Number(!b.isDirectory()) || byName.compare(a.name, b.name));
  const total = dirents.length;
  const names = dirents.slice(0, max).map((d) => d.name);
  const entries = await mapLimit(names, 48, async (name): Promise<DirEntry | undefined> => {
    const p = `${abs}${sep}${name}`;
    let st;
    try { st = await lstat(p); } catch { return; } // gone since readdir
    const hidden = name.startsWith(".");
    if (!st.isSymbolicLink()) return { name, kind: st.isDirectory() ? "dir" : "file", size: st.isDirectory() ? undefined : st.size, mtime: st.mtimeMs, hidden };
    // A link is shown as a link; what it points to (and whether that stays in the project) decides if it opens.
    let to: "dir" | "file" | undefined, out = true;
    try { const real = await realpath(p); out = !inside(root, real); to = (await stat(real)).isDirectory() ? "dir" : "file"; } catch {}
    return { name, kind: "link", mtime: st.mtimeMs, hidden, to, out };
  });
  const found = entries.filter((e): e is DirEntry => !!e);
  // Links to folders sort with the folders now that their targets are known.
  found.sort((a, b) => Number(!isDir(a)) - Number(!isDir(b)) || byName.compare(a.name, b.name));
  // `abs` is the folder as the file viewer takes it: under the root as you gave it, not its real path.
  const path = relative(root, abs);
  return { root: safeRoot, path, abs: path ? `${safeRoot}${sep}${path}` : safeRoot, entries: found, total, truncated: total > max };
}
const isDir = (e: DirEntry) => e.kind === "dir" || (e.kind === "link" && e.to === "dir");
