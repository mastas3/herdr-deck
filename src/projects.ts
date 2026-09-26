// Which project a session is really about. Agents are often started from a hub folder (a notes vault,
// a wiki) and then work somewhere else, so the launch folder alone is misleading. The work itself says
// more: every folder the agent edited, ran commands in or read is credited, and the project that got
// most of the work wins.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";

const HOME = homedir();
// Folders whose direct children are projects even without a git repo.
const CONTAINERS = (process.env.DECK_PROJECT_DIRS ?? ["Documents/Projects", "Projects", "Obsidian/Projects", "projects", "code", "dev", "src", "repos", "work"].map((d) => `${HOME}/${d}`).join(":"))
  .split(":")
  .filter(Boolean);

const rootCache = new Map<string, { at: number; root: string | undefined }>();

/** A folder's project: its git repo, else the child of a projects folder it sits in. Cached per folder. */
export function projectRoot(dir: string): string | undefined {
  const hit = rootCache.get(dir);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.root;
  let root: string | undefined;
  for (let d = dir; d.length > HOME.length && d.startsWith(HOME + "/"); d = dirname(d)) {
    if (existsSync(`${d}/.git`)) { root = d; break; }
  }
  // A worktree of a repo is still that project; show the worktree's own name only if it has one.
  for (const c of CONTAINERS) {
    if (dir.startsWith(c + "/")) {
      const child = `${c}/${dir.slice(c.length + 1).split("/")[0]}`;
      // A repo inside a container is the project; a git root *above* the container (a whole vault) is not.
      if (!root || root.length < child.length) root = child;
      break;
    }
  }
  if (root === HOME) root = undefined;
  rootCache.set(dir, { at: Date.now(), root });
  return root;
}

export type Project = { root: string; name: string; share: number };

/**
 * Picks the project that got most of the work. The launch folder gets a small head start so a session
 * that barely touched files still reads as its launch project. Returns undefined when nothing stands out.
 */
export function inferProject(touch: Map<string, number>, cwd: string): Project | undefined {
  const byRoot = new Map<string, number>();
  let total = 0;
  for (const [dir, w] of touch) {
    const root = projectRoot(dir);
    if (!root) continue;
    byRoot.set(root, (byRoot.get(root) ?? 0) + w);
    total += w;
  }
  const home = projectRoot(cwd);
  if (home) { byRoot.set(home, (byRoot.get(home) ?? 0) + 3); total += 3; }
  let best: [string, number] | undefined;
  for (const e of byRoot) if (!best || e[1] > best[1]) best = e;
  if (!best || total === 0) return;
  return { root: best[0], name: displayName(best[0]), share: best[1] / total };
}

export const displayName = (root: string) => basename(root);
