// The Files plugin's questions, all about one live session on this machine (the page names it by key; the folder is
// always the session's own, never one the page sends): its folder tree, the files the agent touched, what changed.
// Each answer is cached for a few seconds per folder, and nothing runs unless the page asks (the tab is open).
import { readFileSync, statSync } from "node:fs";
import type { Row } from "../../src/deck";
import type { Who } from "../../src/insight";
import { detailFor } from "../../src/insight";
import { ttlCache } from "./cache";
import { addedDiff, parseDiff, parseNameStatus, parseNumstat, type DiffLine } from "../../src/git-diff";
import { commitAt, EMPTY_TREE, git, headOf, listFiles, repoRoot, status, type Badge, type StatusEntry } from "./git";
import { inside, safeRoot, viewable } from "./safe";
import { sessionEdits, touchedList, touchedPaths } from "./touched";
import { buildIndex, changedDirs, diskDir, find, repoDir, walk, type Index } from "./tree";

export class FilesError extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }
export const DIFF_PAGE = 400;
const UNTRACKED_READ = 256 * 1024, UNTRACKED_BUDGET = 4 << 20;

type Where = { root: string; repo: boolean; roots: string[]; cwd?: string };
type Git = { list: StatusEntry[]; st: Map<string, Badge>; dirs: Map<string, number>; truncated: boolean; branch?: string };

export function createFiles(o: { rows: () => Row[] }) {
  const roots = ttlCache<Where>(30_000);
  const stats = ttlCache<Git>(3000);
  const indexes = ttlCache<{ idx: Index; truncated: boolean }>(5000, 40);
  const walks = ttlCache<{ files: string[]; truncated: boolean }>(10_000, 20);
  const diffs = ttlCache<DiffLine[]>(10_000, 100);
  const edits = ttlCache<[string, number][]>(2000, 100);

  function rowOf(key: unknown): Row {
    const row = typeof key === "string" && key ? o.rows().find((r) => r.key === key) : undefined;
    if (!row) throw new FilesError("That session isn’t open any more.", 404);
    return row;
  }
  const who = (row: Row): Who => ({ agent: row.agent, sessionId: row.sessionId, cwd: row.cwd, file: (row as any).hist });

  function where(row: Row): Promise<Where> {
    return roots(row.cwd, async () => {
      const top = row.cwd ? await repoRoot(row.cwd) : undefined;
      const root = safeRoot(top ?? row.cwd);
      if (!root) throw new FilesError("The deck won’t show this folder: it’s outside your home folder, or it’s gone.");
      const all = [...new Set([root, top, row.cwd].filter(Boolean) as string[])];
      // The session's own folder inside the root (a mention is written relative to it).
      const cwd = all.map((r) => (row.cwd.startsWith(r + "/") ? row.cwd.slice(r.length + 1) : "")).find(Boolean) || undefined;
      return { root, repo: !!top, roots: all, cwd };
    });
  }
  function gitState(w: Where): Promise<Git> {
    return stats(w.root, async () => {
      if (!w.repo) return { list: [], st: new Map(), dirs: new Map(), truncated: false };
      const s = await status(w.root);
      const st = new Map(s.list.map((e) => [e.path, e.st] as const));
      return { list: s.list, st, dirs: changedDirs(st.keys()), truncated: s.truncated, branch: s.branch };
    });
  }
  const indexOf = (w: Where) => indexes(w.root, async () => { const l = await listFiles(w.root); return { idx: buildIndex(l.files), truncated: l.truncated }; });
  const allFiles = async (w: Where) => (w.repo ? (await indexOf(w)).idx.files : (await walks(w.root, async () => walk(w.root))).files);

  async function listDir(w: Where, g: Git, rel: string) {
    if (!w.repo) return diskDir(w.root, rel);
    return repoDir(w.root, (await indexOf(w)).idx, rel, g.st, g.dirs);
  }

  async function summary(row: Row) {
    const w = await where(row);
    const g = await gitState(w);
    const raw = await edits(row.key, () => sessionEdits(who(row)));
    const touched = touchedList(touchedPaths(raw, row.cwd), w.roots, g.st);
    const top = await listDir(w, g, "");
    return {
      root: w.root, repo: w.repo, branch: g.branch, cwd: w.cwd, changed: g.list.length, statusTruncated: g.truncated || undefined,
      touched, entries: top.entries, more: top.more,
    };
  }

  async function tree(row: Row, dir: unknown) {
    const w = await where(row);
    if (!inside(w.root, dir ?? "")) throw new FilesError("That folder isn’t one the deck will show.");
    const g = await gitState(w);
    const rel = String(dir ?? "").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    return { dir: rel, ...(await listDir(w, g, rel)) };
  }

  async function findFiles(row: Row, q: unknown) {
    const w = await where(row);
    const g = await gitState(w);
    const text = String(q ?? "").slice(0, 200);
    const files = (await allFiles(w)).filter((p) => viewable(`${w.root}/${p}`));
    const r = find(files, text);
    return { q: text, total: r.total, paths: r.paths.map((p) => ({ p, st: g.st.get(p) })) };
  }

  /** The base a diff compares against: HEAD, or the commit HEAD was at when the session started. */
  async function baseFor(row: Row, w: Where, since: unknown) {
    const head = await headOf(w.root);
    if (since !== "start") return { base: head ?? EMPTY_TREE, label: head ? "Uncommitted changes" : "Everything (no commits yet)", head };
    const d = await detailFor(who(row)).catch(() => undefined);
    const t0 = d?.startedAt ?? row.createdAt ?? row.startedAt;
    if (!t0 || !head) return { base: head ?? EMPTY_TREE, label: "Uncommitted changes", head, unknown: true };
    const c = await commitAt(w.root, t0);
    return { base: c?.sha ?? EMPTY_TREE, label: c ? "Since this session started" : "Since this session started (the repo had no commits then)", head, from: c };
  }

  async function changes(row: Row, since: unknown) {
    const w = await where(row);
    if (!w.repo) return { repo: false, files: [] };
    const [g, b] = await Promise.all([gitState(w), baseFor(row, w, since)]);
    const [ns, nu] = await Promise.all([
      git(w.root, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", b.base, "--"], { cap: 4 << 20 }),
      git(w.root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", b.base, "--"], { cap: 4 << 20 }),
    ]);
    const nums = parseNumstat(nu.out);
    const files: any[] = parseNameStatus(ns.out).map((f) => ({ ...f, ...nums.get(f.path) }));
    // New files have no numstat: count their lines, within a read budget (a folder of new files mustn't stall the deck).
    let budget = UNTRACKED_BUDGET;
    for (const e of g.list) if (e.st === "?") {
      const f: any = { path: e.path, st: "?" };
      const abs = `${w.root}/${e.path}`;
      if (budget > 0 && viewable(abs)) {
        try {
          const size = statSync(abs).size;
          if (size <= UNTRACKED_READ && size <= budget) {
            budget -= size;
            const buf = readFileSync(abs);
            if (buf.subarray(0, 8000).includes(0)) f.bin = true;
            else { const s = buf.toString("utf8"); f.add = s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0; f.del = 0; }
          } else f.big = true;
        } catch {}
      }
      files.push(f);
    }
    for (const f of files) if (!viewable(`${w.root}/${f.path}`)) { f.secret = true; delete f.add; delete f.del; }
    files.sort((a, b2) => a.path.localeCompare(b2.path));
    const add = files.reduce((n, f) => n + (f.add ?? 0), 0), del = files.reduce((n, f) => n + (f.del ?? 0), 0);
    return {
      repo: true, root: w.root, cwd: w.cwd, branch: g.branch, base: b.base, label: b.label, head: b.head, from: b.from, unknown: b.unknown,
      files: files.slice(0, 2000), more: Math.max(0, files.length - 2000), add, del, truncated: ns.truncated || g.truncated || undefined,
    };
  }

  async function diff(row: Row, body: any) {
    const w = await where(row);
    if (!w.repo) throw new FilesError("This folder isn’t a git repo.");
    const abs = inside(w.root, body.path);
    if (!abs) throw new FilesError("That file isn’t one the deck will show (a secret, or outside this folder).");
    const path = abs.slice(w.root.length + 1);
    const old = body.old && inside(w.root, body.old) ? String(body.old) : undefined;
    const base = body.base && /^[0-9a-f]{40}$/.test(body.base) ? body.base : (await headOf(w.root)) ?? EMPTY_TREE;
    const lines = await diffs(`${w.root}\0${base}\0${path}\0${old ?? ""}\0${body.untracked ? 1 : 0}`, async () => {
      if (body.untracked) {
        let size: number;
        try { size = statSync(abs).size; } catch { throw new FilesError("That file is gone.", 404); }
        if (size > 4 << 20) return [["!", `A new file, too big to show (${Math.round(size / 1024)} KB)`]] as DiffLine[];
        const buf = readFileSync(abs);
        if (buf.subarray(0, 8000).includes(0)) return [["!", "A new binary file"]] as DiffLine[];
        return addedDiff(buf.toString("utf8"));
      }
      const r = await git(w.root, ["diff", "--no-ext-diff", "--no-textconv", "-M", "-U3", base, "--", ...(old ? [old] : []), path], { cap: 8 << 20 });
      const l = parseDiff(r.out);
      if (r.truncated) l.push(["!", "The rest of this diff is too big to show here."]);
      return l;
    });
    const from = Math.max(0, Number(body.from) || 0);
    return { path, from, total: lines.length, lines: lines.slice(from, from + DIFF_PAGE) };
  }

  async function handle(body: any) {
    const row = rowOf(body?.key);
    switch (body?.op) {
      case "summary": return summary(row);
      case "tree": return tree(row, body.dir);
      case "find": return findFiles(row, body.q);
      case "changes": return changes(row, body.since);
      case "diff": return diff(row, body);
      default: throw new FilesError("Unknown request");
    }
  }
  return { handle, clear: () => { roots.clear(); stats.clear(); indexes.clear(); walks.clear(); diffs.clear(); edits.clear(); } };
}
