// The folder tree, one folder at a time (the page asks for a folder when you open it). In a git repo the tree is what
// git sees (tracked files plus new ones that aren't ignored), so node_modules, build output and anything in .gitignore
// never show; elsewhere it's the disk, minus the usual heavy folders. Either way a folder lists at most DIR_CAP entries.
import { lstatSync, readdirSync, statSync } from "node:fs";
import type { Badge } from "./git";
import { realInside, viewable } from "./safe";

export type Entry = {
  name: string;
  dir?: boolean;
  st?: Badge; // this file's git status
  n?: number; // a folder: how many changed files are inside it
  link?: boolean; // a symlink
  blocked?: boolean; // a secret, or a link out of the folder: listed, never opened
  gone?: boolean; // deleted on disk (git still has it)
};
export const DIR_CAP = 500;
export const SKIP = new Set(["node_modules", ".git", ".DS_Store", ".hg", ".svn", "__pycache__", ".venv", ".next", ".cache", ".turbo"]);

/** A repo's file list as folder → { name → is a folder }. */
export type Index = { files: string[]; children: Map<string, Map<string, boolean>> };
export function buildIndex(files: string[]): Index {
  const children = new Map<string, Map<string, boolean>>();
  for (const f of files) {
    let dir = "";
    const parts = f.split("/");
    for (let i = 0; i < parts.length; i++) {
      const isDir = i < parts.length - 1;
      let m = children.get(dir);
      if (!m) children.set(dir, (m = new Map()));
      if (!m.get(parts[i])) m.set(parts[i], isDir);
      if (isDir) dir = dir ? `${dir}/${parts[i]}` : parts[i];
    }
  }
  return { files, children };
}

/** Changed files per folder (every ancestor counts), for the dot on a closed folder. */
export function changedDirs(paths: Iterable<string>): Map<string, number> {
  const n = new Map<string, number>();
  for (const p of paths) {
    let i = p.indexOf("/");
    while (i > 0) { const d = p.slice(0, i); n.set(d, (n.get(d) ?? 0) + 1); i = p.indexOf("/", i + 1); }
  }
  return n;
}

const byName = (a: Entry, b: Entry) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1);
const join = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);

/** Marks what can't be opened: secrets, and symlinks that point out of the root. */
function check(root: string, rel: string, e: Entry): Entry {
  const abs = `${root}/${join(rel, e.name)}`;
  if (!viewable(abs)) return { ...e, blocked: true };
  let l;
  try { l = lstatSync(abs); } catch { return { ...e, gone: true }; }
  if (l.isSymbolicLink()) {
    e.link = true;
    if (!realInside(root, abs)) e.blocked = true;
  }
  return e;
}

/** One folder of a repo, from git's list. Falls back to the disk for a folder git has nothing under (a submodule). */
export function repoDir(root: string, idx: Index, rel: string, st: Map<string, Badge>, dirs: Map<string, number>): { entries: Entry[]; more: number } {
  const kids = idx.children.get(rel);
  if (!kids) return diskDir(root, rel, st, dirs);
  const all = [...kids].map(([name, dir]) => {
    const p = join(rel, name);
    return dir ? { name, dir: true, n: dirs.get(p) } : { name, st: st.get(p) };
  }).sort(byName);
  return { entries: all.slice(0, DIR_CAP).map((e) => check(root, rel, e as Entry)), more: Math.max(0, all.length - DIR_CAP) };
}

/** One folder from the disk: no git here (or a folder git doesn't track). */
export function diskDir(root: string, rel: string, st = new Map<string, Badge>(), dirs = new Map<string, number>()): { entries: Entry[]; more: number } {
  let list;
  try { list = readdirSync(rel ? `${root}/${rel}` : root, { withFileTypes: true }); } catch { return { entries: [], more: 0 }; }
  const all: Entry[] = [];
  for (const e of list) {
    if (SKIP.has(e.name)) continue;
    let dir = e.isDirectory();
    if (e.isSymbolicLink()) { try { dir = statSync(`${root}/${join(rel, e.name)}`).isDirectory(); } catch {} }
    const p = join(rel, e.name);
    all.push(dir ? { name: e.name, dir: true, n: dirs.get(p) } : { name: e.name, st: st.get(p) });
  }
  all.sort(byName);
  return { entries: all.slice(0, DIR_CAP).map((e) => check(root, rel, e)), more: Math.max(0, all.length - DIR_CAP) };
}

/** Every file path under the root, from the disk (no git), breadth first and bounded. */
export function walk(root: string, cap = 20_000, depth = 12): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let queue: string[] = [""], level = 0;
  while (queue.length && level <= depth) {
    const next: string[] = [];
    for (const rel of queue) {
      let list;
      try { list = readdirSync(rel ? `${root}/${rel}` : root, { withFileTypes: true }); } catch { continue; }
      for (const e of list) {
        if (SKIP.has(e.name)) continue;
        const p = join(rel, e.name);
        if (e.isDirectory()) next.push(p); // symlinked folders aren't followed
        else files.push(p);
        if (files.length >= cap) return { files, truncated: true };
      }
    }
    queue = next;
    level++;
  }
  return { files, truncated: queue.length > 0 };
}

/** The filter box: every word must appear in the path; names that match rank first, then shorter paths. */
export function find(files: string[], q: string, limit = 200): { paths: string[]; total: number } {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { paths: [], total: 0 };
  const hits: { p: string; s: number }[] = [];
  for (const p of files) {
    const low = p.toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    const base = low.slice(low.lastIndexOf("/") + 1);
    hits.push({ p, s: (words.every((w) => base.includes(w)) ? 0 : 1000) + (base.startsWith(words[0]) ? 0 : 500) + p.length });
  }
  hits.sort((a, b) => a.s - b.s || a.p.localeCompare(b.p));
  return { paths: hits.slice(0, limit).map((h) => h.p), total: hits.length };
}
