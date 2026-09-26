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

type TurnState = { size: number; mtime: number; ino: number; open: boolean; startedAt?: number; endedAt?: number };
const turnCache = new Map<string, TurnState>();
const MARKER = /"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted)"/;

/** Applies every turn marker in `text` (whole lines only) to the state, in order. */
function applyMarkers(v: TurnState, text: string) {
  for (const line of text.split("\n")) {
    const m = line.match(MARKER);
    if (!m) continue;
    const at = Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1] ?? "") || undefined;
    if (m[1] === "task_started") { v.open = true; v.startedAt = at; }
    else { v.open = false; v.endedAt = at; }
  }
}

/**
 * Whether the thread's latest turn is still open. A busy turn can write tens of MB (screenshots, tool
 * output) after it starts, so a fixed tail window misses its start: search backwards chunk by chunk for
 * the last marker the first time, then only read what was appended since.
 */
export async function turnState(file: string) {
  const st = statSync(file);
  const hit = turnCache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.ino === st.ino) return hit;
  const f = Bun.file(file);
  let v: TurnState;
  if (hit && hit.ino === st.ino && st.size > hit.size) {
    v = { ...hit, size: st.size, mtime: st.mtimeMs };
    // Back up to the start of the line the previous read may have cut through.
    const from = Math.max(0, hit.size - 4096);
    const text = await f.slice(from, st.size).text();
    const lastNl = text.lastIndexOf("\n");
    applyMarkers(v, text.slice(text.indexOf("\n") + 1, lastNl + 1));
    v.size = from + Buffer.byteLength(text.slice(0, lastNl + 1)); // re-read an unfinished last line next time
  } else {
    v = { size: st.size, mtime: st.mtimeMs, ino: st.ino, open: false };
    const CHUNK = 4 << 20;
    for (let end = st.size; end > 0; end -= CHUNK) {
      const text = await f.slice(Math.max(0, end - CHUNK - 8192), end).text();
      const lines = text.split("\n");
      let found = false;
      for (let i = lines.length - 1; i > (end - CHUNK - 8192 > 0 ? 0 : -1); i--) {
        if (!MARKER.test(lines[i])) continue;
        applyMarkers(v, lines[i]);
        // For a closed turn, also find when it started (for the elapsed clock we don't need; keep it cheap).
        found = true;
        break;
      }
      if (found) break;
    }
  }
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
