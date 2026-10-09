// Directory names only. File contents still go through the file viewer's stricter policy.
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, join, dirname } from "node:path";

const privateDir = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|Keychains)(\/|$)|(^|\/)\.config\/gcloud(\/|$)/;
export async function browseFolders(raw: unknown, hidden = false, home = homedir()) {
  if (raw != null && typeof raw !== "string") throw new Error("Enter a folder path.");
  const text = String(raw || "~");
  if (/[\x00-\x1f]/.test(text) || text.length > 4096) throw new Error("Invalid folder path.");
  const path = text === "~" ? home : text.startsWith("~/") ? resolve(home, text.slice(2)) : isAbsolute(text) ? resolve(text) : null;
  if (!path) throw new Error("Use an absolute path or a path starting with ~/.");
  if (privateDir.test(path)) throw new Error("This is a private credentials folder.");
  let real: string;
  try { real = await realpath(path); } catch { throw new Error("That folder no longer exists."); }
  if (privateDir.test(real)) throw new Error("This link leads to a private credentials folder.");
  let entries;
  try { entries = await readdir(real, { withFileTypes: true }); }
  catch { throw new Error("This folder cannot be read. Check its permissions."); }
  const candidates = entries.filter(e => (hidden || !e.name.startsWith(".")) && !privateDir.test(join(path, e.name)) && (e.isDirectory() || e.isSymbolicLink()));
  candidates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const folders: { name: string; path: string; link: boolean }[] = [];
  // Bound symlink resolution and return a page of names, never recurse.
  const offsetLimit = 500;
  for (let i = 0; i < candidates.length && folders.length <= offsetLimit; i += 32) {
    const batch = await Promise.all(candidates.slice(i, i + 32).map(async e => {
      const p = join(path, e.name);
      if (e.isSymbolicLink()) {
        try { const r = await realpath(p); if (privateDir.test(r) || !(await stat(r)).isDirectory()) return null; }
        catch { return null; }
      }
      return { name: e.name, path: p, link: e.isSymbolicLink() };
    }));
    folders.push(...batch.filter((e): e is NonNullable<typeof e> => e !== null));
  }
  return { path, home, parent: path === dirname(path) ? null : dirname(path), folders: folders.slice(0, offsetLimit), truncated: folders.length > offsetLimit };
}
