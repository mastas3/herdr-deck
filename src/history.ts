// Every past Claude Code and Codex conversation on this machine: search, browse, open, resume.
// The indexer runs as a separate process (history-worker.ts); this side only reads.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HISTORY_DB, SCHEMA } from "./history-schema";

export type HistSession = {
  key: string; // "h:<agent>:<id>"
  id: string;
  agent: "claude" | "codex";
  file: string;
  cwd: string;
  project: string;
  root?: string;
  title: string;
  first: string;
  started?: number;
  last?: number;
  asks: number;
  model?: string;
  hits?: number;
  hit?: { i: number; role: string; at?: number; snippet: string };
};

export type IndexState = { done: number; total: number; sessions: number; building: boolean; at?: number; lastMs?: number; errors: number };
export const indexState: IndexState = { done: 0, total: 0, sessions: 0, building: true, errors: 0 };

mkdirSync(dirname(HISTORY_DB), { recursive: true });
const boot = new Database(HISTORY_DB, { create: true });
boot.exec("pragma journal_mode = wal;");
boot.exec(SCHEMA);
boot.close();
const db = new Database(HISTORY_DB, { readonly: true });
db.exec("pragma busy_timeout = 3000;");

let onChange: (() => void) | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
const WORKER = new URL("./history-worker.ts", import.meta.url).pathname;

/** One indexing pass in a child process; progress arrives as JSON lines on its stdout. */
async function pass() {
  if (child) return;
  const p = (child = Bun.spawn([process.execPath, WORKER], { stdout: "pipe", stderr: "ignore", env: { ...process.env, DECK_HISTORY_DB: HISTORY_DB } }));
  let buf = "", again = false;
  const dec = new TextDecoder();
  try {
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "progress") {
          Object.assign(indexState, { done: m.done, total: m.total, sessions: m.sessions, building: m.total > 0 && m.done < m.total });
          if (m.done && m.done % 100 === 0) onChange?.();
        } else if (m.type === "idle") { Object.assign(indexState, { building: false, at: Date.now(), lastMs: m.ms, sessions: m.sessions }); if (m.indexed) onChange?.(); }
        else if (m.type === "error") indexState.errors++;
        else if (m.type === "more") again = true;
      }
    }
    await p.exited;
    // A crashed pass loses nothing (each session commits as it goes): count it and carry on.
    if (p.exitCode !== 0) { indexState.errors++; again = crashes++ < 5; }
    else crashes = 0;
  } finally { child = undefined; }
  if (again) setTimeout(pass, 300);
  else indexState.building = false;
}
let crashes = 0;

/** Starts indexing and rescans every `everyMs` (new sessions, grown transcripts). */
export function startHistory(opts: { everyMs?: number; changed?: () => void } = {}) {
  if (process.env.DECK_NO_HISTORY) { indexState.building = false; return; }
  onChange = opts.changed;
  pass();
  setInterval(() => pass(), opts.everyMs ?? 60_000);
}
export const rescanHistory = () => pass();
export const stopHistory = () => { try { child?.kill(); } catch {} };

const toSession = (r: any): HistSession => ({
  key: `h:${r.agent}:${r.id}`, id: r.id, agent: r.agent, file: r.file, cwd: r.cwd ?? "", project: r.project ?? "", root: r.root ?? undefined,
  title: r.title ?? "", first: r.first ?? "", started: r.started ?? undefined, last: r.last ?? undefined, asks: r.asks ?? 0, model: r.model ?? undefined,
});

/** "herdr deck" → "herdr"* AND "deck"*: every word, as a prefix, anywhere in one message. */
export function ftsQuery(q: string): string | undefined {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*/gu) ?? [];
  const toks = words.map((w) => w.replace(/[.\-/]+$/g, "")).filter((w) => w.length > 1).slice(0, 8);
  if (!toks.length) return;
  return toks.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" AND ");
}

const SEP_A = "\u0002", SEP_B = "\u0003";

export type HistQuery = { q?: string; project?: string; agent?: string; before?: number; limit?: number; exclude?: Set<string> };

export function searchHistory(o: HistQuery): { sessions: HistSession[]; total: number } {
  const limit = Math.min(Math.max(Number(o.limit) || 60, 1), 200);
  const filters: string[] = ["s.empty = 0"];
  const args: any[] = [];
  if (o.project) { filters.push("s.project = ?"); args.push(o.project); }
  if (o.agent) { filters.push("s.agent = ?"); args.push(o.agent); }
  const fts = o.q ? ftsQuery(o.q) : undefined;
  if (!fts) {
    if (o.before) { filters.push("s.last < ?"); args.push(o.before); }
    const rows = db.query(`select * from sess s where ${filters.join(" and ")} order by s.last desc limit ${limit + (o.exclude?.size ?? 0)}`).all(...args) as any[];
    const total = (db.query(`select count(*) n from sess s where ${filters.join(" and ")}`).get(...args) as any).n;
    return { sessions: rows.map(toSession).filter((s) => !o.exclude?.has(s.id)).slice(0, limit), total };
  }
  // The best-ranked matching messages, grouped by session: its best message is the snippet.
  let hits: any[];
  try {
    hits = db.query(`select m.file, m.i, m.role, m.at, snippet(msg, 0, '${SEP_A}', '${SEP_B}', '…', 18) snip
      from msg m join sess s on s.file = m.file where msg match ? and ${filters.join(" and ")} order by rank limit 3000`).all(fts, ...args) as any[];
  } catch { return { sessions: [], total: 0 }; }
  const by = new Map<string, { n: number; first: any }>();
  for (const h of hits) {
    const g = by.get(h.file);
    if (g) g.n++; else by.set(h.file, { n: 1, first: h });
  }
  const files = [...by.keys()];
  if (!files.length) return { sessions: [], total: 0 };
  const sess = new Map<string, any>();
  for (let i = 0; i < files.length; i += 400) {
    const chunk = files.slice(i, i + 400);
    for (const r of db.query(`select * from sess where file in (${chunk.map(() => "?").join(",")})`).all(...chunk) as any[]) sess.set(r.file, r);
  }
  const now = Date.now();
  const out = files.map((f) => {
    const s = toSession(sess.get(f));
    const g = by.get(f)!;
    s.hits = g.n;
    s.hit = { i: Number(g.first.i), role: g.first.role, at: g.first.at ? Number(g.first.at) : undefined, snippet: String(g.first.snip ?? "").replace(/\s+/g, " ").trim() };
    return s;
  }).filter((s) => s.id && !o.exclude?.has(s.id));
  // Relevance first (FTS order), nudged by how often it came up and how recent it is.
  const pos = new Map(files.map((f, i) => [f, i]));
  const score = (s: HistSession) => pos.get(s.file)! - Math.log2(1 + (s.hits ?? 1)) * 3 + Math.min(40, (now - (s.last ?? 0)) / (7 * 86400_000));
  out.sort((a, b) => score(a) - score(b));
  return { sessions: out.slice(0, limit), total: out.length };
}

export function historySession(key: string): HistSession | undefined {
  const m = key.match(/^h:(claude|codex):(.+)$/);
  if (!m) return;
  const r = db.query("select * from sess where agent = ? and id = ? order by last desc limit 1").get(m[1], m[2]);
  return r ? toSession(r) : undefined;
}

export function historyProjects(): { project: string; n: number; last: number }[] {
  return db.query("select project, count(*) n, max(last) last from sess where empty = 0 and project != '' group by project order by last desc limit 300").all() as any[];
}

export const historyStats = () => ({ ...indexState, indexed: (db.query("select count(*) n from sess where empty = 0").get() as any).n as number });
