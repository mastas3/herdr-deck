// Getting a worktree's work back: where it stands against its base, its diff, a fast-forward merge (and its undo),
// a pull request, and removing it with a way back (the branch stays; uncommitted work goes in a named stash).
// Anything that isn't a clean fast-forward is handed to the agent instead of being done here.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDiff, parseNameStatus, parseNumstat, type DiffLine } from "./git-diff";
import { branchExists, changes, envFiles, git, gitError, isDeckPath, repoOf, worktreeList } from "./wt-git";
import { patchWorktree, wtRecord } from "./wt-store";

export class WtError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
const sha = async (dir: string, ref: string) => (await git(dir, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], 5000)).out.trim() || undefined;
const isAncestor = async (dir: string, a: string, b: string) => (await git(dir, ["merge-base", "--is-ancestor", a, b], 10_000)).ok;

/** A status line of a file the deck linked there is not work to lose. */
const notLinks = (lines: string[], links: string[]) => lines.filter((l) => !links.includes(l.slice(3)));

export async function worktreeStatus(dir: string) {
  const repo = await repoOf(dir);
  if (!repo?.worktree) throw new WtError("This session isn't working in a linked git worktree");
  if (!repo.branch) throw new WtError("The worktree isn't on a branch (detached HEAD)");
  const rec = wtRecord(repo.top);
  const list = await worktreeList(repo.main);
  const base = rec?.base ?? list.find((w) => w.path === repo.main)?.branch ?? "main";
  const branch = repo.branch;
  const [baseSha, tip] = await Promise.all([sha(repo.main, base), sha(repo.main, branch)]);
  if (!baseSha || !tip) throw new WtError(`Can't find ${baseSha ? branch : base} in this repo`);
  const baseCo = list.find((w) => w.branch === base)?.path;
  const [counts, ff, merged, dirty, baseDirty, log, up] = await Promise.all([
    git(repo.main, ["rev-list", "--left-right", "--count", `${base}...${branch}`], 10_000),
    isAncestor(repo.main, base, branch), isAncestor(repo.main, branch, base),
    changes(repo.top), baseCo ? changes(baseCo, true) : Promise.resolve([]),
    git(repo.main, ["log", "--format=%h%x09%ct%x09%s", "-n", "30", `${base}..${branch}`], 10_000),
    git(repo.top, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], 5000),
  ]);
  const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
  const upstream = up.ok ? up.out.trim() : undefined;
  const unpushed = upstream ? Number((await git(repo.top, ["rev-list", "--count", `${upstream}..${branch}`], 5000)).out.trim()) || 0 : ahead;
  // Would a real merge conflict? Only asked when a fast-forward can't do it.
  let conflicts: string[] | undefined;
  if (!ff && !merged) {
    const mt = await git(repo.main, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, branch], 20_000);
    conflicts = mt.code === 1 ? mt.out.split("\n").slice(1).filter(Boolean) : [];
  }
  return {
    path: repo.top, main: repo.main, branch, base, baseSha, tip, baseCheckout: baseCo, ahead: ahead || 0, behind: behind || 0, ff, merged,
    conflicts, dirty: notLinks(dirty, rec?.links ?? []), baseDirty, upstream, unpushed,
    commits: log.out.split("\n").filter(Boolean).map((l) => { const [h, t, ...s] = l.split("\t"); return { sha: h, at: Number(t) * 1000, subject: s.join("\t") }; }),
    links: rec?.links ?? [], kept: rec?.keptAt,
  };
}
export type WtStatus = Awaited<ReturnType<typeof worktreeStatus>>;

/** What the branch changed since it left its base (`base...branch`): per file, with line counts. */
export async function worktreeDiff(s: Pick<WtStatus, "main" | "base" | "branch">) {
  const range = `${s.base}...${s.branch}`;
  const [ns, nu] = await Promise.all([
    git(s.main, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", range, "--"], 20_000),
    git(s.main, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", range, "--"], 20_000),
  ]);
  const nums = parseNumstat(nu.out);
  const files = parseNameStatus(ns.out).map((f) => ({ ...f, ...nums.get(f.path) }));
  return { files: files.slice(0, 500), more: Math.max(0, files.length - 500), add: files.reduce((n, f) => n + (f.add ?? 0), 0), del: files.reduce((n, f) => n + (f.del ?? 0), 0) };
}
export async function worktreeFileDiff(s: Pick<WtStatus, "main" | "base" | "branch">, path: string, old?: string): Promise<DiffLine[]> {
  if (!path || path.startsWith("-") || old?.startsWith("-")) throw new WtError("Which file?");
  const r = await git(s.main, ["diff", "--no-ext-diff", "--no-textconv", "-M", "-U3", `${s.base}...${s.branch}`, "--", ...(old ? [old] : []), path], 20_000);
  const lines = parseDiff(r.out);
  return lines.length > 3000 ? [...lines.slice(0, 3000), ["!", `${lines.length - 3000} more lines not shown`]] : lines;
}

/** What to send the agent when the deck won't merge itself: the exact message the dialog shows. */
export function handoffMessage(s: Pick<WtStatus, "branch" | "base">, conflicts?: string[]) {
  return `Rebase this branch (${s.branch}) onto ${s.base}${conflicts?.length ? ` and resolve the conflicts (${conflicts.slice(0, 8).join(", ")}${conflicts.length > 8 ? ", …" : ""})` : ""}, so ${s.base} can fast-forward to it. Run the checks, commit, and don't push. Then reply with one line: "Ready to merge".`;
}

/** Fast-forward the base to the branch, and only that: never with uncommitted changes where the base is checked out. */
export async function mergeWorktree(dir: string) {
  const s = await worktreeStatus(dir);
  if (s.merged) throw new WtError(`${s.branch} is already in ${s.base}: nothing to merge`);
  if (s.baseDirty.length) throw new WtError(`${s.base} has uncommitted changes in ${s.baseCheckout} (${s.baseDirty.length} file${s.baseDirty.length === 1 ? "" : "s"}). Commit or stash them there first.`, 409);
  if (!s.ff) return { ok: false as const, handoff: true, conflicts: s.conflicts ?? [], message: handoffMessage(s, s.conflicts) };
  const r = s.baseCheckout ? await git(s.baseCheckout, ["merge", "--ff-only", s.tip], 60_000) : await git(s.main, ["update-ref", `refs/heads/${s.base}`, s.tip, s.baseSha], 10_000);
  if (!r.ok) throw new WtError(`The fast-forward didn't happen: ${gitError(r)}`, 409);
  return { ok: true as const, main: s.main, base: s.base, from: s.baseSha, to: s.tip, commits: s.ahead };
}
/** Undo a fast-forward: move the base back, only while it's still where the merge left it. */
export async function unmergeWorktree(u: { main: string; base: string; from: string; to: string }) {
  if (!/^[0-9a-f]{40}$/.test(u.from) || !/^[0-9a-f]{40}$/.test(u.to)) throw new WtError("Not an undo the deck made");
  if ((await sha(u.main, u.base)) !== u.to) throw new WtError(`${u.base} has moved on since the merge, so it can't be undone here`, 409);
  const co = (await worktreeList(u.main)).find((w) => w.branch === u.base)?.path;
  const r = co ? await git(co, ["reset", "--keep", u.from], 30_000) : await git(u.main, ["update-ref", `refs/heads/${u.base}`, u.from, u.to], 10_000);
  if (!r.ok) throw new WtError(`Couldn't undo the merge: ${gitError(r)}`, 409);
  return { ok: true };
}

/** Remove the folder, keep the branch. Uncommitted work (after you confirmed) goes in a named stash first. */
export async function removeWorktree(dir: string, force = false) {
  const s = await worktreeStatus(dir);
  if (!isDeckPath(s.main, s.path)) throw new WtError(`Only worktrees under ${s.main}/.claude/worktrees/ are removed from here`);
  const unmerged = !s.merged && s.unpushed > 0 ? s.commits : [];
  if (!force && (s.dirty.length || unmerged.length)) return { ok: false as const, confirm: true, dirty: s.dirty, commits: unmerged, branch: s.branch, base: s.base };
  for (const rel of s.links) try { if (lstatSync(join(s.path, rel)).isSymbolicLink()) rmSync(join(s.path, rel)); } catch {}
  let stash: string | undefined;
  if (s.dirty.length) {
    const st = await git(s.path, ["stash", "push", "--include-untracked", "-m", `herdr deck: ${s.branch}, saved when its worktree was removed`], 60_000);
    stash = st.ok ? (await sha(s.path, "refs/stash")) : undefined;
    if (!stash) throw new WtError(`Couldn't save the uncommitted changes, so nothing was removed: ${gitError(st)}`, 409);
  }
  const r = await git(s.main, ["worktree", "remove", s.path], 60_000);
  if (!r.ok) throw new WtError(`git worktree remove failed: ${gitError(r)}`, 409);
  return { ok: true as const, undo: { main: s.main, path: s.path, branch: s.branch, stash, links: s.links } };
}

/** Undo for a removal: the worktree again from its kept branch, its .env links, and the stashed changes. */
export async function restoreWorktree(u: { main: string; path: string; branch: string; stash?: string; links?: string[] }) {
  const repo = await repoOf(u.main);
  if (!repo || repo.worktree || repo.main !== u.main || !isDeckPath(u.main, u.path)) throw new WtError("Not a worktree the deck removed");
  if (existsSync(u.path)) throw new WtError(`${u.path} exists again, so the worktree wasn't re-added`, 409);
  if (!(await branchExists(u.main, u.branch))) throw new WtError(`The branch ${u.branch} is gone, so the worktree can't come back`, 409);
  const add = await git(u.main, ["worktree", "add", u.path, u.branch], 120_000);
  if (!add.ok) throw new WtError(`git worktree add failed: ${gitError(add)}`, 409);
  const allowed = new Set(await envFiles(u.main));
  for (const rel of u.links ?? []) {
    if (!allowed.has(rel) || existsSync(join(u.path, rel))) continue;
    try { mkdirSync(dirname(join(u.path, rel)), { recursive: true }); symlinkSync(join(u.main, rel), join(u.path, rel)); } catch {}
  }
  let note = "";
  if (u.stash && /^[0-9a-f]{40}$/.test(u.stash)) {
    const ap = await git(u.path, ["stash", "apply", u.stash], 60_000);
    const i = (await git(u.main, ["stash", "list", "--format=%H"], 5000)).out.split("\n").indexOf(u.stash);
    if (ap.ok && i >= 0) await git(u.main, ["stash", "drop", `stash@{${i}}`], 10_000);
    if (!ap.ok) note = `Its uncommitted changes are still in git stash (${u.stash.slice(0, 7)}): ${gitError(ap)}`;
  }
  patchWorktree(u.path, { keptAt: undefined });
  return { ok: true, path: u.path, note };
}
