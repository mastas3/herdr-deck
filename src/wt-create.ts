// Making a worktree for a new session: what the New session dialog shows before you start (the plan), and the steps
// themselves, undone in full when any of them fails (no branch or folder left behind).
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { branches, branchExists, branchProblem, changes, ensureExcluded, envFiles, git, gitError, installCommand, pickPrefix, repoOf, slugBranch, worktreeList, worktreePath, type Repo } from "./wt-git";
import { putWorktree } from "./wt-store";

export type Listening = { port: number; cmd: string; cwd?: string };

/** The live sessions (on this machine) working in the same repo as `common`, its worktrees included. */
export async function sameRepo<T extends { cwd?: string }>(rows: T[], common: string, commonOf: (cwd: string) => Promise<string | undefined>): Promise<T[]> {
  const out: T[] = [];
  for (const r of rows) if (r.cwd && (await commonOf(r.cwd)) === common) out.push(r);
  return out;
}

/** Servers listening from the main checkout (not from a worktree): an agent starting the same one would clash. */
export function mainPorts(main: string, listening: Listening[]) {
  const wt = `${main}/.claude/worktrees/`;
  const seen = new Set<number>();
  return listening.filter((l) => l.cwd && (l.cwd === main || l.cwd.startsWith(main + "/")) && !l.cwd.startsWith(wt) && !seen.has(l.port) && seen.add(l.port)).map((l) => ({ port: l.port, cmd: l.cmd }));
}

export type PlanInput = { cwd: string; prompt?: string; branch?: string; base?: string };
/** Everything the dialog shows about a worktree for this folder; `branch`/`base` (as typed) are checked too. */
export async function planWorktree(o: PlanInput, ctx: { others: (repo: Repo) => Promise<{ key: string; title: string }[]>; listening: Listening[] }) {
  const repo = await repoOf(o.cwd);
  if (!repo) return { repo: false as const };
  if (!repo.head) return { repo: false as const, reason: "This repo has no commits yet, so there's nothing to branch from." };
  const [names, user, others, env, excl] = await Promise.all([branches(repo.main), git(repo.main, ["config", "user.name"], 5000), ctx.others(repo), envFiles(repo.main), ensureExcluded(repo, true)]);
  const prefix = pickPrefix(names, user.out.trim());
  const suggest = slugBranch(o.prompt ?? "", prefix);
  const branch = (o.branch ?? "").trim() || suggest;
  const base = (o.base ?? "").trim() || repo.branch || repo.head.slice(0, 12);
  const path = worktreePath(repo.main, branch);
  const [branchErr, baseOk, where] = await Promise.all([branchProblem(repo.main, branch), git(repo.main, ["rev-parse", "-q", "--verify", `${base}^{commit}`], 5000), worktreeList(repo.main)]);
  const baseCo = where.find((w) => w.branch === base)?.path;
  const baseDirty = baseCo ? (await changes(baseCo, true)).length : 0;
  return {
    repo: true as const, main: repo.main, top: repo.top, sub: relative(repo.top, o.cwd).replace(/^\.$/, ""), current: repo.branch,
    branches: names.slice(0, 60), prefix, suggest, branch, base, path,
    problems: {
      branch: branchErr,
      base: baseOk.ok ? undefined : `There's no branch or commit named ${base}`,
      path: existsSync(path) ? `${path} already exists` : undefined,
    },
    // Uncommitted work in the base's checkout stays there: the worktree starts from its last commit.
    baseDirty: baseDirty ? { checkout: baseCo, files: baseDirty } : undefined,
    others, defaultOn: others.length > 0,
    env, install: installCommand(repo.top), exclude: excl, ports: mainPorts(repo.main, ctx.listening),
  };
}

const madeDirs = new Set<string>();
export type Made = { main: string; path: string; cwd: string; branch: string; base: string; links: string[] };
export type WorktreeAsk = { branch: string; base?: string; env?: string[] };

/** `git worktree add -b <branch> <path> <base>` from the folder's repo, then the .env links you picked. */
export async function makeWorktree(cwd: string, ask: WorktreeAsk): Promise<Made> {
  const repo = await repoOf(cwd);
  if (!repo?.head) throw new Error("That folder isn't in a git repo with commits");
  const branch = String(ask.branch ?? "").trim(), base = String(ask.base ?? "").trim() || repo.branch || repo.head;
  const bad = await branchProblem(repo.main, branch);
  if (bad) throw new Error(bad);
  if (!(await git(repo.main, ["rev-parse", "-q", "--verify", `${base}^{commit}`], 5000)).ok) throw new Error(`There's no branch or commit named ${base}`);
  const path = worktreePath(repo.main, branch);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  await ensureExcluded(repo);
  const made: Made = { main: repo.main, path, cwd: join(path, relative(repo.top, cwd)), branch, base, links: [] };
  if (!existsSync(dirname(path))) { mkdirSync(dirname(path), { recursive: true }); madeDirs.add(path); }
  const add = await git(repo.main, ["worktree", "add", "-b", branch, path, base], 120_000);
  if (!add.ok) { await discardWorktree(made); throw new Error(`git worktree add failed: ${gitError(add)}`); }
  try {
    // Only files the plan listed (untracked .env files in the main checkout), linked, never copied.
    const allowed = new Set(await envFiles(repo.main));
    for (const rel of ask.env ?? []) {
      if (!allowed.has(rel)) continue;
      const to = join(path, rel);
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(join(repo.main, rel), to);
      made.links.push(rel);
    }
    if (!existsSync(made.cwd)) made.cwd = path;
  } catch (e: any) { await discardWorktree(made); throw new Error(`Couldn't link the .env files: ${e?.message ?? e}`); }
  madeDirs.delete(path);
  putWorktree({ path, main: repo.main, branch, base, createdAt: Date.now(), links: made.links });
  return made;
}

/** Undoes makeWorktree: the folder (and its links) and the branch, which has nothing on it yet. */
export async function discardWorktree(m: Pick<Made, "main" | "path" | "branch">) {
  for (const rel of (m as Made).links ?? []) try { if (lstatSync(join(m.path, rel)).isSymbolicLink()) rmSync(join(m.path, rel)); } catch {}
  if (existsSync(m.path)) {
    const r = await git(m.main, ["worktree", "remove", "--force", m.path], 30_000);
    if (!r.ok) rmSync(m.path, { recursive: true, force: true });
  }
  await git(m.main, ["worktree", "prune"], 10_000);
  // .claude/worktrees/ itself, when this attempt made it and it's still empty.
  if (madeDirs.delete(m.path)) try { rmdirSync(dirname(m.path)); } catch {}
  if (await branchExists(m.main, m.branch)) await git(m.main, ["branch", "-D", m.branch], 10_000);
}
