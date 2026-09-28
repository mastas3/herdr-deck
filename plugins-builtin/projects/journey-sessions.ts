// Project pages, the deck's side: live rows and history hits as session records, and this machine's history index
// read-only (the projects plugin's server.ts wires these into the journeys service).
import { nameRe } from "./journey-collect";
import type { SessRec } from "./journey-sources";

type HitLike = { key: string; id: string; agent: string; machine?: string; title: string; first?: string; started?: number; last?: number; asks?: number; cwd?: string; root?: string; project?: string };
type RowLike = { key: string; machine?: string; agent: string; status: string; title: string; firstPrompt?: string; startedAt?: number; createdAt?: number; lastActiveAt?: number; cwd: string; projectRoot?: string; project: string; sessionId?: string; branch?: string; empty?: boolean };
export const rowToSess = (r: RowLike): SessRec => ({ key: r.key, id: r.sessionId ?? r.key, agent: r.agent, machine: r.machine, title: r.title, first: r.firstPrompt, started: r.startedAt ?? r.createdAt, last: r.lastActiveAt, cwd: r.cwd, root: r.projectRoot, project: r.project, status: r.status, branch: r.branch, live: true });
/** Live agent sessions; `started` looks up when a session really began (a pane's own times say when the deck saw it). */
export function liveSessions(rows: RowLike[], lookup?: (ids: string[]) => Map<string, { started?: number; asks?: number }>): SessRec[] {
  const out = rows.filter((r) => !r.empty && ["claude", "codex", "opencode"].includes(r.agent)).map(rowToSess);
  const m = lookup?.(out.map((s) => s.id).filter((x) => !x.includes("/")));
  if (m) for (const s of out) { const x = m.get(s.id); if (x?.started) s.started = x.started; if (x?.asks) s.asks = x.asks; }
  return out;
}
/** A project's past sessions on every machine, plus sessions elsewhere whose title or first prompt names it. */
export async function projectSessions(p: string, search: (o: { q?: string; project?: string; limit?: number }) => Promise<HitLike[]>): Promise<SessRec[]> {
  const [own, named] = await Promise.all([search({ project: p, limit: 200 }).catch(() => []), search({ q: p, limit: 80 }).catch(() => [])]);
  const re = nameRe(p);
  const seen = new Set(own.map((h) => h.key));
  const mentions = named.filter((h) => !seen.has(h.key) && h.project !== p && (re.test(h.title ?? "") || re.test(h.first ?? "")));
  const toRec = (h: HitLike, mention: boolean): SessRec => ({ key: h.key, id: h.id, agent: h.agent, machine: h.machine, title: h.title, first: h.first, started: h.started, last: h.last, asks: h.asks, cwd: h.cwd, root: h.root, project: h.project, mention });
  return [...own.map((h) => toRec(h, false)), ...mentions.map((h) => toRec(h, true))];
}
/** This machine's history index, read-only: weekly counts, sessions under a folder, by project, and start times by id. */
export function localHistory(dbPath: string, machine: string) {
  let db: any;
  const q = (sql: string, ...args: any[]): any[] => {
    try {
      if (!db) { const { Database } = require("bun:sqlite"); db = new Database(dbPath, { readonly: true }); db.exec("pragma busy_timeout = 2000;"); }
      return db.query(sql).all(...args);
    } catch { return []; }
  };
  const rec = (r: any): SessRec => ({ key: `h:${r.agent}:${r.id}`, id: r.id, agent: r.agent, machine, title: r.title ?? "", first: r.first ?? "", started: r.started ?? undefined, last: r.last ?? undefined, asks: r.asks ?? 0, cwd: r.cwd ?? "", root: r.root ?? undefined, project: r.project ?? "" });
  return {
    weeks: (since: number) => q("select project, cast((? - started) / 604800000 as integer) week, count(*) n from sess where empty = 0 and project != '' and started > ? group by project, week", Date.now(), since) as { project: string; week: number; n: number }[],
    underRoot: (root: string) => q("select * from sess where empty = 0 and (root like ? or cwd like ?) order by started limit 400", `${root}/%`, `${root}/%`).map(rec),
    byProject: (name: string) => q("select * from sess where empty = 0 and project = ? order by started limit 200", name).map(rec),
    started: (ids: string[]) => { const m = new Map<string, { started?: number; asks?: number }>(); if (ids.length) for (const r of q(`select id, started, asks from sess where id in (${ids.map(() => "?").join(",")})`, ...ids)) m.set(r.id, { started: r.started ?? undefined, asks: r.asks ?? undefined }); return m; },
    close: () => { try { db?.close(); } catch {} db = undefined; },
  };
}
