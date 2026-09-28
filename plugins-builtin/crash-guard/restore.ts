// Reopening a snapshot's sessions: through the core's Reopen (host.sessions.reopen: a new tab in the right workspace
// and folder, wait for the shell's prompt, type the resume command), a few at a time because a shell takes seconds to
// start. A workspace that no longer exists is made by its first session, alone, before the rest go in parallel, so two
// sessions never both create it. Failures stay on the job for Retry.
import type { ReopenSession } from "../../src/plugin-api";
import { restoreCommand, restoreOrder, type SnapPane } from "./snapshot";

export type ItemState = "waiting" | "opening" | "done" | "failed";
export type Item = { key: string; title: string; project: string; agent: string; workspace: string; cwd: string; cmd?: string; state: ItemState; error?: string; newKey?: string; startedAt?: number; endedAt?: number };
export type Job = { id: string; machine: string; snapshotId: string; at: number; running: boolean; atOnce: number; items: Item[] };

type Deps = {
  machine: string;
  reopen: (o: ReopenSession) => Promise<{ key?: string; paneId?: string }>;
  /** Workspace ids and names that exist on this machine's herdr now. */
  workspaces: () => Set<string>;
  changed: (job: Job) => void;
  /** Pause between two sessions started by the same worker (and between workers' first starts). */
  gapMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
};

export function createRestorer(d: Deps) {
  const gap = d.gapMs ?? 1200;
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  let job: Job | undefined;
  let panes = new Map<string, SnapPane>();

  const specOf = (p: SnapPane): ReopenSession => ({ herdr: p.herdr, workspaceId: p.workspaceId, workspace: p.workspace, createWorkspace: true, cwd: p.cwd, tab: p.tab, project: p.project, resume: restoreCommand(p) });

  async function one(j: Job, it: Item) {
    const p = panes.get(it.key)!;
    it.state = "opening"; it.startedAt = Date.now(); it.error = undefined;
    d.changed(j);
    try {
      const r = await d.reopen(specOf(p));
      it.state = "done"; it.newKey = r.key;
    } catch (e: any) {
      it.state = "failed"; it.error = String(e?.message ?? e).slice(0, 200);
    }
    it.endedAt = Date.now();
    d.changed(j);
  }

  async function run(j: Job) {
    j.running = true;
    d.changed(j);
    try {
      const waiting = () => j.items.filter((x) => x.state === "waiting");
      // A workspace that's gone: its sessions one at a time until one of them has made it.
      const have = d.workspaces();
      const missing = new Map<string, Item[]>();
      for (const it of waiting()) {
        const p = panes.get(it.key)!;
        if (have.has(p.workspaceId) || have.has(p.workspace)) continue;
        missing.set(p.workspace, [...(missing.get(p.workspace) ?? []), it]);
      }
      for (const items of missing.values()) {
        for (const it of items) { await one(j, it); if (it.state === "done") break; await sleep(gap); }
      }
      // The rest, `atOnce` at a time, in order.
      const queue = waiting();
      let next = 0;
      const worker = async (w: number) => {
        await sleep(w * gap);
        while (next < queue.length) {
          const it = queue[next++];
          await one(j, it);
          if (next < queue.length) await sleep(gap);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(j.atOnce, queue.length || 1)) }, (_, w) => worker(w)));
    } finally {
      j.running = false;
      d.changed(j);
    }
  }

  return {
    job: () => job,
    /** Starts restoring these panes of a snapshot. Refused while another restore is running. */
    start(snapshotId: string, picked: SnapPane[], atOnce: number) {
      if (job?.running) throw new Error("A restore is already running");
      panes = new Map(picked.map((p) => [p.key, p]));
      const j: Job = {
        id: crypto.randomUUID(), machine: d.machine, snapshotId, at: Date.now(), running: false, atOnce: Math.max(1, Math.min(6, Math.round(atOnce) || 2)),
        items: restoreOrder(picked).map((p) => ({ key: p.key, title: p.title, project: p.project, agent: p.agent, workspace: p.workspace, cwd: p.cwd, cmd: restoreCommand(p), state: "waiting" })),
      };
      job = j;
      void run(j);
      return j;
    },
    /** Puts the failed ones back in the queue and runs them again. */
    retry(id: string) {
      if (!job || job.id !== id) throw new Error("That restore is gone");
      if (job.running) throw new Error("It's still running");
      const failed = job.items.filter((x) => x.state === "failed");
      if (!failed.length) return job;
      for (const it of failed) { it.state = "waiting"; it.error = undefined; }
      void run(job);
      return job;
    },
    clear() { if (!job?.running) job = undefined; },
  };
}
export type Restorer = ReturnType<typeof createRestorer>;
