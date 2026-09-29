// An installed code plugin's server side runs from a copy of exactly the files you approved:
// <data>/plugins/.approved/<id>/<hash>/. The module cache is keyed by path, so an approved update is a new folder and
// every module it imports loads fresh (not just the entry file), and nothing written to the install folder later can
// change what gets imported. The copy is checked against the approved hashes before every start; the periodic check
// (plugin-host checkInstalled) re-checks both folders cheaply, hashing again only when a file's size or mtime moved.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashOf, treeChanged } from "./plugin-code-store";

export const approvedBase = (root: string, id: string) => join(root, "plugins", ".approved", id);

/** The verified copy to run from (made from the install folder the first time); undefined when either doesn't match. */
export function approvedCopy(root: string, id: string, installDir: string, files: Record<string, string>): string | undefined {
  // Named by the hash of the approved file list itself, never by anything read back from code-plugins.json.
  const base = approvedBase(root, id), hash = hashOf(files), dir = join(base, hash);
  try {
    if (!existsSync(dir)) {
      if (treeChanged(installDir, files)) return undefined;
      const tmp = `${dir}.${process.pid}.tmp`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(base, { recursive: true });
      cpSync(installDir, tmp, { recursive: true, verbatimSymlinks: true, filter: (src) => !src.split("/").includes(".git") });
      renameSync(tmp, dir);
    }
    // Older approvals' copies go: their modules are no longer running.
    for (const old of readdirSync(base)) if (old !== hash) rmSync(join(base, old), { recursive: true, force: true });
    return treeChanged(dir, files) ? undefined : dir;
  } catch { return undefined; }
}
/** Forget a plugin's copies (a new approval makes a fresh one; a removed plugin has none). */
export const forgetCopies = (root: string, id: string) => rmSync(approvedBase(root, id), { recursive: true, force: true });

/** Every file's path, kind, size and mtime: when this is the same as at the last good check, the bytes are too. */
function stamp(dir: string): string {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (name === ".git") continue;
      const r = rel ? `${rel}/${name}` : name, st = lstatSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else out.push(`${r}:${st.isSymbolicLink() ? "link" : st.size}:${st.mtimeMs}`);
    }
  };
  walk("");
  return out.join("\n");
}
const good = new Map<string, string>();
/** treeChanged, hashing only when something about the folder's files moved since it last matched. */
export function treeChangedCached(dir: string, files: Record<string, string>): boolean {
  const key = `${dir}\0${hashOf(files)}`;
  let s: string;
  try { s = stamp(dir); } catch { return true; }
  if (good.get(key) === s) return false;
  if (treeChanged(dir, files)) { good.delete(key); return true; }
  good.set(key, s);
  return false;
}
