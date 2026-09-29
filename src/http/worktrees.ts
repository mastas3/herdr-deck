// The worktree API. POST /api/worktrees { op, machine } is about a repo on a machine (the New session plan, the weekly
// stale list, Undo of a removal); POST /api/worktree { op, key } is about one session's worktree (its status and diff,
// merge, pull request, keep, remove). Both run on the machine the repo is on: forward.ts routes the first by machine
// and the second by key, like the rest of the API.
import { homedir } from "node:os";
import type { Hub } from "./hub";
import type { Row } from "../deck";
import { json } from "./page";
import { git } from "../wt-git";
import { planWorktree, sameRepo } from "../wt-create";
import { handoffMessage, mergeWorktree, removeWorktree, restoreWorktree, unmergeWorktree, worktreeDiff, worktreeFileDiff, worktreeStatus, WtError } from "../wt-ops";
import { openPr, prPlan } from "../wt-pr";
import { cleanStale, staleWorktrees } from "../wt-stale";
import { patchWorktree } from "../wt-store";

const commons = new Map<string, { at: number; common?: string }>();
/** The repo a folder belongs to (its shared .git dir), cached for a minute: the plan asks it of every live session. */
async function commonOf(cwd: string) {
  const hit = commons.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.common;
  const g = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5000);
  const common = g.ok ? g.out.trim() : undefined;
  commons.set(cwd, { at: Date.now(), common });
  return common;
}
const live = (hub: Hub) => [...hub.deck.rows.values()].filter((r) => !r.hist && !r.empty);
/** Every open pane, an empty shell too: removing its folder would pull the floor from under it. */
const panes = (hub: Hub) => [...hub.deck.rows.values()].filter((r) => !r.hist);
const inside = (dir: string, path: string) => dir === path || dir.startsWith(path + "/");

export async function worktreesApi(hub: Hub, path: string, body: any): Promise<Response | undefined> {
  if (path !== "/api/worktrees" && path !== "/api/worktree") return;
  try {
    return json(path === "/api/worktrees" ? await repoOp(hub, body) : await sessionOp(hub, body));
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, e instanceof WtError ? e.status : 500);
  }
}

async function repoOp(hub: Hub, body: any) {
  const busy = () => panes(hub).map((r) => r.cwd).filter(Boolean) as string[];
  switch (body.op) {
    case "plan": {
      const cwd = String(body.cwd ?? "").replace(/^~(?=\/|$)/, homedir());
      return planWorktree({ cwd, prompt: body.prompt, branch: body.branch, base: body.base }, {
        listening: hub.deck.listening,
        others: async (repo) => (await sameRepo(live(hub), repo.common, commonOf)).slice(0, 8).map((r) => ({ key: r.key, title: r.title || r.agent })),
      });
    }
    case "stale": return { stale: await staleWorktrees([...hub.deck.rows.values()].map((r) => r.gitRoot ?? r.projectRoot).filter(Boolean) as string[], busy()) };
    case "clean": return { results: await cleanStale((body.paths ?? []).map(String), busy()) };
    case "restore": return restoreWorktree(body.undo ?? {});
  }
  throw new WtError(`unknown op ${body.op}`);
}

async function sessionOp(hub: Hub, body: any) {
  const row: Row | undefined = hub.hosts.localRow(String(body.key ?? ""));
  if (!row?.cwd || row.hist) throw new WtError("That session is gone", 404);
  const dir = row.cwd;
  switch (body.op) {
    case "status": return worktreeStatus(dir);
    case "diff": {
      const s = await worktreeStatus(dir);
      // What Merge would send the agent instead, shown before you confirm.
      return { status: s, ...(await worktreeDiff(s)), handoff: !s.ff && !s.merged ? handoffMessage(s, s.conflicts) : undefined };
    }
    case "file": return { lines: await worktreeFileDiff(await worktreeStatus(dir), String(body.path ?? ""), body.old ? String(body.old) : undefined) };
    case "merge": return mergeWorktree(dir);
    case "unmerge": return unmergeWorktree(body.undo ?? {});
    case "pr-plan": return prPlan(await worktreeStatus(dir));
    case "pr": return openPr(await worktreeStatus(dir));
    case "keep": { const s = await worktreeStatus(dir); patchWorktree(s.path, { keptAt: Date.now() }); return { ok: true }; }
    case "remove": {
      const s = await worktreeStatus(dir);
      const others = panes(hub).filter((r) => r.key !== row.key && r.cwd && inside(r.cwd, s.path));
      if (others.length) throw new WtError(`${others.length === 1 ? "Another session works" : `${others.length} other sessions work`} in this worktree (${others.map((r) => r.title || r.agent).slice(0, 3).join(", ")}). Close ${others.length === 1 ? "it" : "them"} first.`, 409);
      const r = await removeWorktree(dir, !!body.force);
      if (!r.ok || !body.close) return r;
      // Its session goes too (its folder is gone); Undo reopens it once the worktree is back.
      const closed = hub.deck.rows.has(row.key) ? await hub.sessions.closeLocal([row.key], false) : [];
      return { ...r, graves: closed.flatMap((c: any) => c.graves ?? []) };
    }
  }
  throw new WtError(`unknown op ${body.op}`);
}
