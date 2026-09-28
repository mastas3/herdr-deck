// Which checkout a folder is in: the repo's main checkout, or one of its linked worktrees (`git worktree add`).
import { basename, dirname, resolve } from "node:path";
import { projectRoot } from "./projects";

export type Checkout = { root: string; main: string; worktree: boolean };

/**
 * Reads `git -C <cwd> rev-parse --show-toplevel --git-dir --git-common-dir` (one line each; the last two may be
 * relative to cwd). A linked worktree has its own git dir (.git/worktrees/<name>) but shares the repo's common one;
 * the main checkout and a submodule have the two equal, so neither counts as a worktree.
 */
export function parseCheckout(cwd: string, out: string): Checkout | undefined {
  const [top, gitDir, common] = out.split("\n").map((l) => l.trim());
  if (!top || !gitDir || !common) return;
  const root = resolve(cwd, top), g = resolve(cwd, gitDir), c = resolve(cwd, common);
  if (g === c) return { root, main: root, worktree: false };
  // The main checkout holds the common dir (repo/.git, or repo/.bare in the bare-plus-worktrees layout); a plain
  // bare repo (repo.git) has no checkout of its own, so its name stands in for one.
  const main = basename(c).startsWith(".") ? dirname(c) : c.replace(/\.git$/, "");
  return { root, main, worktree: root !== main };
}

/**
 * A session working in a linked worktree belongs to its repo's project (so it is listed under it), while its own
 * folder stays its projectRoot: checks and new tabs from it run in the worktree, not in the main checkout.
 * `g` is what the deck knows about the session's folder: its checkout `root`, and `main` only for a worktree.
 */
export function inWorktree(g: { root?: string; main?: string } | undefined, projRoot: string, rootOf = projectRoot) {
  if (!g?.main || !g.root || (projRoot !== g.root && !projRoot.startsWith(g.root + "/"))) return;
  return { gitRoot: rootOf(g.main) ?? g.main, worktree: basename(g.root) };
}
