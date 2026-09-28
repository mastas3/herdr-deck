// Codex owns this database. Read its index instead of guessing where a moved rollout lives.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
export type CodexThread = {
  id: string; rollout_path?: string; title?: string; name?: string; cwd?: string;
  created_at?: number; updated_at?: number; source?: string; archived?: number;
  git_branch?: string; model?: string; agent_nickname?: string; agent_role?: string;
};

export function createCodexStore(home: () => string = codexHome) {
  let db: Database | undefined, path = "", stamp = "", checked = -Infinity, selectFields = "";
  let hasApp: boolean | undefined;
  const cached = new Map<string, CodexThread | undefined>();
  const children = new Map<string, CodexThread[]>();
  function open() {
    if (Date.now() - checked < 2000) return db;
    checked = Date.now();
    hasApp = undefined;
    try {
      const root = home();
      const name = readdirSync(root).filter((n) => /^state_\d+\.sqlite$/.test(n))
        .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
      const next = name ? join(root, name) : "";
      const st = next ? statSync(next) : undefined;
      const key = st ? `${next}:${st.ino}` : "";
      if (key !== stamp) { db?.close(); db = undefined; path = next; stamp = key; }
      if (!db && path) {
        db = new Database(path, { readonly: true });
        const cols = new Set((db.query("pragma table_info(threads)").all() as any[]).map((r) => r.name));
        selectFields = fields + ["name", "model", "agent_nickname", "agent_role"].filter((n) => cols.has(n)).map((n) => `, ${n}`).join("");
      }
      cached.clear(); children.clear();
    } catch { db?.close(); db = undefined; stamp = ""; cached.clear(); children.clear(); }
    return db;
  }
  const fields = "id, rollout_path, title, cwd, created_at, updated_at, source, archived, git_branch";
  function get(id: string): CodexThread | undefined {
    const d = open();
    if (!d) return;
    if (!cached.has(id)) {
      try {
        // New columns are optional: older CLI stores still supply paths and archive state.
        cached.set(id, d.query(`select ${selectFields} from threads where id = ?`).get(id) as CodexThread ?? undefined);
      } catch { cached.set(id, undefined); }
    }
    return cached.get(id);
  }
  function recentApp(since: number): CodexThread[] {
    const d = open();
    if (!d) return [];
    try {
      return d.query(`select ${fields} from threads where source = 'vscode' and archived = 0 and updated_at > ? order by updated_at desc limit 200`).all(since) as CodexThread[];
    } catch { return []; }
  }
  function subagents(id: string): CodexThread[] {
    const d = open();
    if (!d) return [];
    if (!children.has(id)) {
      try {
        const ids = d.query("select child_thread_id from thread_spawn_edges where parent_thread_id = ?").all(id) as { child_thread_id: string }[];
        children.set(id, ids.map((r) => get(r.child_thread_id)).filter((r): r is CodexThread => !!r));
      } catch { children.set(id, []); }
    }
    return children.get(id)!;
  }
  function file(id: string) {
    const p = get(id)?.rollout_path;
    return p && existsSync(p) ? p : undefined;
  }
  function hasAppThreads() {
    const d = open();
    if (!d) return false;
    try { return hasApp ??= !!d.query("select 1 from threads where source = 'vscode' and archived = 0 limit 1").get(); }
    catch { return false; }
  }
  return { get, file, recentApp, subagents, hasAppThreads, close: () => { db?.close(); db = undefined; checked = -Infinity; cached.clear(); children.clear(); } };
}

export const codexStore = createCodexStore();
