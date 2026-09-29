// The weekly look at worktrees left behind: in the repos the deck knows, the ones under .claude/worktrees/ that no
// session works in and whose branch is merged into its base or hasn't been touched for 14 days. Cleaning up removes
// the folders and keeps the branches, so each one can be added back (Undo).
import { statSync } from "node:fs";
import { git, isDeckPath, repoOf, worktreeList } from "./wt-git";
import { removeWorktree } from "./wt-ops";
import { wtRecord, wtRecords } from "./wt-store";

const DAY = 86400_000;
export const STALE_DAYS = 14;
export type Stale = { path: string; main: string; repo: string; branch: string; base: string; why: "merged" | "untouched"; days: number; dirty: number };

/** Last touched: the later of the branch's last commit and the worktree's index (any add, commit or checkout). */
async function touchedAt(path: string) {
  const [c, idx] = await Promise.all([git(path, ["log", "-1", "--format=%ct"], 5000), git(path, ["rev-parse", "--path-format=absolute", "--git-path", "index"], 5000)]);
  let t = Number(c.out.trim()) * 1000 || 0;
  try { t = Math.max(t, statSync(idx.out.trim()).mtimeMs); } catch {}
  return t;
}

/** `dirs`: folders of this machine's sessions (and the deck's own records) to find repos from; `busy`: folders sessions work in now. */
export async function staleWorktrees(dirs: string[], busy: string[], now = Date.now()): Promise<Stale[]> {
  const mains = new Set<string>(wtRecords().map((r) => r.main));
  for (const d of new Set(dirs)) { const r = await repoOf(d).catch(() => undefined); if (r) mains.add(r.main); }
  const out: Stale[] = [];
  for (const main of mains) {
    const list = await worktreeList(main).catch(() => []);
    const mainBranch = list.find((w) => w.path === main)?.branch;
    for (const w of list) {
      if (!w.branch || !isDeckPath(main, w.path) || busy.some((b) => b === w.path || b.startsWith(w.path + "/"))) continue;
      const rec = wtRecord(w.path);
      if (rec?.keptAt && now - rec.keptAt < STALE_DAYS * DAY) continue;
      const base = rec?.base ?? mainBranch;
      if (!base || base === w.branch) continue;
      const merged = (await git(main, ["merge-base", "--is-ancestor", w.branch, base], 10_000)).ok;
      const days = Math.floor((now - (await touchedAt(w.path))) / DAY);
      if (!merged && days < STALE_DAYS) continue;
      const dirty = (await git(w.path, ["status", "--porcelain"], 8000)).out.split("\n").filter((l) => l.length > 3 && !(rec?.links ?? []).includes(l.slice(3))).length;
      out.push({ path: w.path, main, repo: main.split("/").pop()!, branch: w.branch, base, why: merged ? "merged" : "untouched", days, dirty });
    }
  }
  return out.sort((a, b) => b.days - a.days);
}

/** The digest's line: how many, and the first few by repo and branch. */
export function staleLine(list: Stale[]) {
  if (!list.length) return "";
  const each = list.slice(0, 4).map((s) => `${s.repo} ⎇ ${s.branch} (${s.why === "merged" ? `merged into ${s.base}` : `untouched ${s.days} days`})`);
  return `${list.length} worktree${list.length === 1 ? "" : "s"} look${list.length === 1 ? "s" : ""} finished: ${each.join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}`;
}

/** Clean up: each one removed with its branch kept; one with uncommitted changes is left alone and said so. */
export async function cleanStale(paths: string[], busy: string[]) {
  const results: { path: string; ok: boolean; error?: string; undo?: unknown }[] = [];
  for (const path of paths.slice(0, 50)) {
    if (busy.some((b) => b === path || b.startsWith(path + "/"))) { results.push({ path, ok: false, error: "A session is working in it" }); continue; }
    try {
      // Commits are safe on the kept branch; uncommitted changes are not, so those worktrees stay.
      let r = await removeWorktree(path, false);
      if (!r.ok && !r.dirty.length) r = await removeWorktree(path, true);
      results.push(r.ok ? { path, ok: true, undo: r.undo } : { path, ok: false, error: `${r.dirty.length} uncommitted file${r.dirty.length === 1 ? "" : "s"}, left alone` });
    } catch (e: any) { results.push({ path, ok: false, error: e?.message ?? String(e) }); }
  }
  return results;
}
