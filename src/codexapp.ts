// Threads from the Codex desktop app (it lives inside ChatGPT.app). They are not herdr panes, but they
// write the same rollout files as the Codex CLI, and the app keeps a catalog of them (titles, folders,
// branches) in its own SQLite. A turn is in progress when its last `task_started` has no matching
// `task_complete` / `turn_aborted` yet.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { findCodexFile } from "./agents";
import { codexHome, codexStore, type CodexThread } from "./codex-store";
import { turnState } from "./codex-turn";
export { turnState } from "./codex-turn";

const DB_PATH = `${codexHome()}/sqlite/codex-dev.db`;
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

export const codexAppInstalled = () => existsSync(DB_PATH) || codexStore.hasAppThreads();

let db: Database | null | undefined;
function open() {
  if (db) return db;
  try { db = existsSync(DB_PATH) ? new Database(DB_PATH, { readonly: true }) : null; } catch { db = null; }
  return db;
}

const pgrepService = async () => {
  const p = Bun.spawn(["pgrep", "-f", "Codex \\(Service\\)"], { stdout: "pipe", stderr: "ignore" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return code === 0 && out.trim().length > 0;
};
let probe: () => Promise<boolean> = pgrepService;
let running = { at: 0, value: false, busy: false };
/** The app's backend runs as "Codex (Service)"; without it nothing in the app can be working.
 *  Read on every patch, so it answers from cache and rechecks in the background: a sync pgrep on a
 *  loaded machine froze the whole deck for seconds. */
export function codexAppRunning(): boolean {
  if (!running.busy && Date.now() - running.at >= 5_000) {
    running.busy = true;
    probe()
      .then((up) => { running.value = up; })
      .catch(() => {})
      .finally(() => { running.at = Date.now(); running.busy = false; });
  }
  return running.value;
}
/** Test seam: swap the process check and forget the cached answer. */
export function _setRunningProbe(fn: () => Promise<boolean>) { probe = fn; running = { at: 0, value: false, busy: false }; }

/** Recent local threads from the app, newest first, plus any older one that is working right now. */
export async function listAppThreads(hidden: Set<string>, options: {
  catalog?: Database | null; store?: typeof codexStore; running?: boolean; now?: number;
  findFile?: (id: string) => string | undefined;
} = {}): Promise<AppThread[]> {
  const d = options.catalog === undefined ? open() : options.catalog;
  const store = options.store ?? codexStore, now = options.now ?? Date.now();
  const since = now / 1000 - RECENT_DAYS * 86400;
  type CatalogRow = { thread_id: string; display_title: string | null; cwd: string | null; git_branch: string | null; source_created_at: number | null; source_updated_at: number | null };
  let rows: CatalogRow[] = [];
  try {
    // Inspect older entries too: their catalog timestamp can lag a currently running rollout.
    rows = d?.query(`select thread_id, display_title, cwd, git_branch, source_created_at, source_updated_at from local_thread_catalog
      where host_id = 'local' and source_kind = 'vscode' order by source_updated_at desc limit 300`).all() as CatalogRow[] ?? [];
  } catch {}
  const indexed = new Map<string, CodexThread>(store.recentApp(since).map((r) => [r.id, r]));
  const known = new Set(rows.map((r) => r.thread_id));
  for (const r of indexed.values()) if (!known.has(r.id)) rows.push({ thread_id: r.id, display_title: r.title ?? null,
    cwd: r.cwd ?? null, git_branch: r.git_branch ?? null, source_created_at: r.created_at ?? null, source_updated_at: r.updated_at ?? null });
  const appUp = options.running ?? codexAppRunning();
  const out: AppThread[] = [];
  for (const r of rows) {
    if (hidden.has(r.thread_id)) continue;
    const core = store.get(r.thread_id) ?? indexed.get(r.thread_id);
    if (core?.archived) continue;
    const file = options.findFile ? options.findFile(r.thread_id) : findCodexFile(r.thread_id);
    let status: AppThread["status"] = "idle", turnStartedAt: number | undefined, lastWriteAt: number | undefined;
    try { if (file) lastWriteAt = statSync(file).mtimeMs; } catch {}
    const updatedAt = Math.max((core?.updated_at ?? 0) * 1000, (r.source_updated_at ?? 0) * 1000, lastWriteAt ?? 0);
    // An old file cannot have a fresh active turn. Avoid scanning months of old rollouts at startup.
    if (updatedAt < since * 1000 && (!lastWriteAt || now - lastWriteAt >= STALL_MS)) continue;
    if (file) {
      try {
        const t = await turnState(file);
        lastWriteAt = t.mtime; turnStartedAt = t.startedAt;
        if (t.open && appUp && now - t.mtime < STALL_MS) status = "working";
        else if (!t.open && !t.interrupted && t.endedAt && now - t.endedAt < DONE_FRESH_MS) status = "done";
      } catch {}
    }
    if (updatedAt < since * 1000 && status !== "working") continue;
    out.push({
      id: r.thread_id, title: core?.name?.trim() || r.display_title?.trim() || core?.title?.trim() || "Codex thread",
      cwd: core?.cwd || r.cwd || homedir(), branch: core?.git_branch ?? r.git_branch ?? undefined,
      createdAt: (core?.created_at ?? r.source_created_at ?? 0) * 1000 || undefined,
      updatedAt: updatedAt || undefined, file, status, turnStartedAt, lastWriteAt,
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
