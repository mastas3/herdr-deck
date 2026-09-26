// Every idea Discover ever generates (feed batches, Studio builds), kept for good in SQLite.
// The feed and Studio are views over today; this is the memory the gallery and research read from.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ArchivedIdea = { id: string; title: string; source: string; row?: string; score?: number; dropped?: boolean; createdAt: number; data: any };

export function openIdeaArchive(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, row TEXT, score REAL,
      dropped INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ideas_created ON ideas(created_at);`);
  const upsertQ = db.prepare(`INSERT INTO ideas (id, title, source, row, score, dropped, created_at, updated_at, data)
    VALUES ($id, $title, $source, $row, $score, 0, $now, $now, $data)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, row = COALESCE(excluded.row, row), data = excluded.data, updated_at = excluded.updated_at`);
  const scoreQ = db.prepare(`UPDATE ideas SET score = $score, dropped = $dropped, updated_at = $now WHERE id = $id`);
  const listQ = db.prepare(`SELECT id, title, source, row, score, dropped, created_at, data FROM ideas
    WHERE ($all = 1 OR dropped = 0) ORDER BY created_at DESC LIMIT $limit OFFSET $offset`);
  const countQ = db.prepare(`SELECT COUNT(*) AS n, SUM(dropped) AS dropped FROM ideas`);

  return {
    /** Adds or refreshes an idea; its first-seen time and any score stay. */
    put(idea: { id: string; title?: string; source?: string; row?: string }, now = Date.now()) {
      if (!idea?.id) return;
      upsertQ.run({ $id: idea.id, $title: String(idea.title ?? "Untitled"), $source: String(idea.source ?? "unknown"), $row: idea.row ?? null, $score: null, $now: now, $data: JSON.stringify(idea) });
    },
    score(id: string, score: number, dropped: boolean, now = Date.now()) { scoreQ.run({ $id: id, $score: score, $dropped: dropped ? 1 : 0, $now: now }); },
    list(opts: { limit?: number; offset?: number; all?: boolean } = {}): ArchivedIdea[] {
      const rows = listQ.all({ $all: opts.all ? 1 : 0, $limit: Math.min(opts.limit ?? 100, 500), $offset: opts.offset ?? 0 }) as any[];
      return rows.map((r) => ({ id: r.id, title: r.title, source: r.source, row: r.row ?? undefined, score: r.score ?? undefined, dropped: !!r.dropped, createdAt: r.created_at, data: JSON.parse(r.data) }));
    },
    count(): { total: number; dropped: number } { const r = countQ.get() as any; return { total: r.n ?? 0, dropped: r.dropped ?? 0 }; },
    close() { db.close(); },
  };
}
export type IdeaArchive = ReturnType<typeof openIdeaArchive>;
