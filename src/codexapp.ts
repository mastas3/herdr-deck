// Threads from the Codex desktop app (it lives inside ChatGPT.app). They are not herdr panes, but they
// write the same rollout files as the Codex CLI, and the app keeps a catalog of them (titles, folders,
// branches) in its own SQLite. A turn is in progress when its last `task_started` has no matching
// `task_complete` / `turn_aborted` yet.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { findCodexFile } from "./agents";

const DB_PATH = `${homedir()}/.codex/sqlite/codex-dev.db`;
const RECENT_DAYS = Number(process.env.DECK_CODEX_APP_DAYS ?? 3);
const DONE_FRESH_MS = 30 * 60_000; // a turn that finished this recently still "needs you"
const STALL_MS = 20 * 60_000; // an open turn with no writes this long is not really running

export type AppThread = {
  id: string;
  title: string;
  cwd: string;
  branch?: string;
  createdAt?: number;
  updatedAt?: number;
  file?: string;
  status: "working" | "done" | "idle";
  turnStartedAt?: number;
  lastWriteAt?: number;
};

export const codexAppInstalled = () => existsSync(DB_PATH);

let db: Database | null | undefined;
function open() {
  if (db !== undefined) return db;
  try { db = codexAppInstalled() ? new Database(DB_PATH, { readonly: true }) : null; } catch { db = null; }
  return db;
}

let running = { at: 0, value: false };
/** The app's backend runs as "Codex (Service)"; without it nothing in the app can be working. */
export function codexAppRunning(): boolean {
  if (Date.now() - running.at < 5_000) return running.value;
  const p = Bun.spawnSync(["pgrep", "-f", "Codex \\(Service\\)"], { stdout: "pipe", stderr: "ignore" });
  running = { at: Date.now(), value: p.exitCode === 0 && p.stdout.toString().trim().length > 0 };
  return running.value;
}

const turnCache = new Map<string, { size: number; mtime: number; open: boolean; startedAt?: number; endedAt?: number }>();
/** Reads only the tail of the rollout to see whether the latest turn is still open. */
export async function turnState(file: string) {
  const st = statSync(file);
  const hit = turnCache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return { ...hit, mtime: st.mtimeMs };
  const tail = await Bun.file(file).slice(Math.max(0, st.size - 256 * 1024), st.size).text();
  let open = false, startedAt: number | undefined, endedAt: number | undefined;
  for (const line of tail.split("\n")) {
    if (!line.includes('"event_msg"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const t = o.payload?.type;
    const at = o.timestamp ? Date.parse(o.timestamp) : undefined;
    if (t === "task_started") { open = true; startedAt = at; }
    else if (t === "task_complete" || t === "turn_aborted") { open = false; endedAt = at; }
  }
  const v = { size: st.size, mtime: st.mtimeMs, open, startedAt, endedAt };
  turnCache.set(file, v);
  return v;
}

/** Recent local threads from the app, newest first, plus any older one that is working right now. */
export async function listAppThreads(hidden: Set<string>): Promise<AppThread[]> {
  const d = open();
  if (!d) return [];
  const since = Date.now() / 1000 - RECENT_DAYS * 86400;
  let rows: { thread_id: string; display_title: string | null; cwd: string | null; git_branch: string | null; source_created_at: number | null; source_updated_at: number | null }[] = [];
  try {
    rows = d
      .query(`select thread_id, display_title, cwd, git_branch, source_created_at, source_updated_at from local_thread_catalog
              where host_id = 'local' and source_kind = 'vscode' and source_updated_at > ? order by source_updated_at desc limit 60`)
      .all(since) as any;
  } catch {
    return [];
  }
  const appUp = codexAppRunning();
  const now = Date.now();
  const out: AppThread[] = [];
  for (const r of rows) {
    if (hidden.has(r.thread_id)) continue;
    const file = findCodexFile(r.thread_id);
    let status: AppThread["status"] = "idle", turnStartedAt: number | undefined, lastWriteAt: number | undefined;
    if (file) {
      try {
        const t = await turnState(file);
        lastWriteAt = t.mtime;
        turnStartedAt = t.startedAt;
        if (t.open && appUp && now - t.mtime < STALL_MS) status = "working";
        else if (!t.open && t.endedAt && now - t.endedAt < DONE_FRESH_MS) status = "done";
      } catch {}
    }
    out.push({
      id: r.thread_id,
      title: r.display_title?.trim() || "Codex thread",
      cwd: r.cwd || homedir(),
      branch: r.git_branch ?? undefined,
      createdAt: r.source_created_at ? r.source_created_at * 1000 : undefined,
      updatedAt: Math.max(r.source_updated_at ? r.source_updated_at * 1000 : 0, lastWriteAt ?? 0) || undefined,
      file,
      status,
      turnStartedAt,
      lastWriteAt,
    });
  }
  return out;
}
