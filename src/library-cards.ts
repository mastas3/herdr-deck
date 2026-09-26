// Founder Library: the card store (<library>/cards.db). One row per video with the checked card as JSON, a few
// columns to filter and sort on, and full-text indexes over cards and over web pages you added. Extraction state
// (done, failed, not a founder video) lives here too, so a restart never extracts a video twice.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { Card } from "./library-extract";

export type CardFilter = { q?: string; source?: string; btype?: string; channel?: string; kind?: string; minRevenue?: number; sort?: "revenue" | "views" | "recent"; limit?: number; offset?: number };
export type Page = { url: string; title: string; site: string; text: string; fetchedAt: number };

/** Words of a question as an FTS5 query: stop words out, each word quoted (so FTS syntax in the input is inert), OR-joined. */
const STOP = new Set("a an the and or of to in on for with how did do does what who why when where is are was were i you we they people get got make made my your their it that this from by as at be can should would could about any some".split(" "));
export function ftsQuery(q: string): string {
  const ws = [...new Set(String(q ?? "").toLowerCase().replace(/[^\p{L}\p{N}$]+/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, 12);
  return ws.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}
const tacticText = (c: Card) => [...c.first, ...c.growth].map((x) => `${x.channel?.replace(/_/g, " ") ?? ""} ${x.text}`).join(" · ");

export function openCards(file: string) {
  mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, source TEXT, kind TEXT, btype TEXT, rev REAL, views INT, date TEXT, channels TEXT, at INT, json TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(id UNINDEXED, title, business, sells, customer, tactics, lessons, stack, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS raws(id TEXT PRIMARY KEY, json TEXT);
    CREATE TABLE IF NOT EXISTS extract_state(id TEXT PRIMARY KEY, status TEXT, error TEXT, model TEXT, ms INT, at INT);
    CREATE TABLE IF NOT EXISTS pages(url TEXT PRIMARY KEY, title TEXT, site TEXT, text TEXT, fetched_at INT);
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(url UNINDEXED, title, text, tokenize='porter unicode61');`);

  const q = {
    put: db.prepare("INSERT OR REPLACE INTO cards(id, source, kind, btype, rev, views, date, channels, at, json) VALUES (?,?,?,?,?,?,?,?,?,?)"),
    ftsDel: db.prepare("DELETE FROM cards_fts WHERE id = ?"),
    ftsPut: db.prepare("INSERT INTO cards_fts(id, title, business, sells, customer, tactics, lessons, stack) VALUES (?,?,?,?,?,?,?,?)"),
    state: db.prepare("INSERT OR REPLACE INTO extract_state(id, status, error, model, ms, at) VALUES (?,?,?,?,?,?)"),
    get: db.prepare("SELECT json FROM cards WHERE id = ?"),
    done: db.prepare("SELECT id FROM extract_state"),
  };

  function put(c: Card, ms = 0, raws?: unknown[]) {
    const channels = [...new Set([...c.first, ...c.growth].map((x) => x.channel).filter(Boolean))].join(" ");
    db.transaction(() => {
      q.put.run(c.id, c.source, c.kind, c.btype, c.revenue?.perMonth ?? null, c.views ?? null, c.date ?? null, channels, c.at, JSON.stringify(c));
      q.ftsDel.run(c.id);
      q.ftsPut.run(c.id, c.title, c.business ?? "", c.sells ?? "", c.customer ?? "", tacticText(c), [...c.lessons, ...c.failed].map((x) => x.text).join(" · "), c.stack.join(" "));
      q.state.run(c.id, "done", null, c.model, ms, c.at);
      if (raws) db.prepare("INSERT OR REPLACE INTO raws(id, json) VALUES (?, ?)").run(c.id, JSON.stringify(raws));
    })();
  }
  const row = (r: any): Card => JSON.parse(r.json);

  /** Cards matching the filters, full-text ranked when there is a query (bm25 with titles and tactics weighted up). */
  function list(f: CardFilter = {}): { cards: (Card & { rank?: number })[]; total: number } {
    const where: string[] = [], args: any[] = [];
    if (f.source) { where.push("c.source = ?"); args.push(f.source); }
    if (f.btype) { where.push("c.btype = ?"); args.push(f.btype); }
    if (f.kind) { where.push("c.kind = ?"); args.push(f.kind); }
    if (f.channel) { where.push("(' ' || c.channels || ' ') LIKE ?"); args.push(`% ${f.channel} %`); }
    if (f.minRevenue) { where.push("c.rev >= ?"); args.push(f.minRevenue); }
    const fts = f.q ? ftsQuery(f.q) : "";
    const limit = Math.max(1, Math.min(200, f.limit ?? 30)), offset = Math.max(0, f.offset ?? 0);
    const order = f.sort === "views" ? "c.views DESC" : f.sort === "recent" ? "c.at DESC" : f.sort === "revenue" ? "c.rev IS NULL, c.rev DESC" : "c.rev IS NULL, c.rev DESC";
    const w = where.length ? ` AND ${where.join(" AND ")}` : "";
    if (fts) {
      const sql = `SELECT c.json, bm25(cards_fts, 0, 3.0, 2.0, 2.0, 1.5, 3.0, 1.0, 0.5) AS r FROM cards_fts JOIN cards c ON c.id = cards_fts.id WHERE cards_fts MATCH ?${w} ORDER BY r LIMIT ? OFFSET ?`;
      const rows = db.prepare(sql).all(fts, ...args, limit, offset) as any[];
      const total = (db.prepare(`SELECT count(*) n FROM cards_fts JOIN cards c ON c.id = cards_fts.id WHERE cards_fts MATCH ?${w}`).get(fts, ...args) as any).n;
      return { cards: rows.map((r) => ({ ...row(r), rank: r.r })), total };
    }
    const rows = db.prepare(`SELECT c.json FROM cards c WHERE 1=1${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
    const total = (db.prepare(`SELECT count(*) n FROM cards c WHERE 1=1${w}`).get(...args) as any).n;
    return { cards: rows.map(row), total };
  }

  return {
    db, put,
    get(id: string): Card | undefined { const r = q.get.get(id) as any; return r ? row(r) : undefined; },
    many(ids: string[]): Card[] { if (!ids.length) return []; return (db.prepare(`SELECT json FROM cards WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[]).map(row); },
    list,
    all(): Card[] { return (db.prepare("SELECT json FROM cards").all() as any[]).map(row); },
    mark(id: string, status: "failed" | "empty" | "skipped", error: string | null, model: string, ms = 0) { q.state.run(id, status, error?.slice(0, 300) ?? null, model, ms, Date.now()); },
    /** Video ids that have been through extraction (done, failed or empty). */
    handled(): Set<string> { return new Set((q.done.all() as any[]).map((r) => r.id)); },
    /** The model's own answers for a card, kept so new claim checks can be re-applied without asking the model again. */
    raws(id: string): unknown[] | undefined { const r = db.prepare("SELECT json FROM raws WHERE id = ?").get(id) as any; return r ? JSON.parse(r.json) : undefined; },
    retryFailed() { db.run("DELETE FROM extract_state WHERE status = 'failed'"); },
    /** Cards written by an older prompt or older checks (re-extracted once nothing new is waiting). */
    outdated(v: number, limit = 1): string[] { return (db.prepare("SELECT id FROM cards WHERE coalesce(json_extract(json, '$.v'), 1) < ? ORDER BY views DESC LIMIT ?").all(v, limit) as any[]).map((r) => r.id); },
    stats() {
      const n = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).n as number;
      const by = (col: string) => Object.fromEntries((db.prepare(`SELECT ${col} k, count(*) n FROM cards GROUP BY ${col}`).all() as any[]).map((r) => [r.k ?? "", r.n]));
      return {
        cards: n("SELECT count(*) n FROM cards"), founders: n("SELECT count(*) n FROM cards WHERE kind = 'founder_story'"), withRevenue: n("SELECT count(*) n FROM cards WHERE rev IS NOT NULL"),
        failed: n("SELECT count(*) n FROM extract_state WHERE status = 'failed'"), pages: n("SELECT count(*) n FROM pages"),
        bySource: by("source"), byType: by("btype"), byKind: by("kind"),
      };
    },
    putPage(p: Page) {
      db.transaction(() => {
        db.prepare("INSERT OR REPLACE INTO pages(url, title, site, text, fetched_at) VALUES (?,?,?,?,?)").run(p.url, p.title, p.site, p.text, p.fetchedAt);
        db.prepare("DELETE FROM pages_fts WHERE url = ?").run(p.url);
        db.prepare("INSERT INTO pages_fts(url, title, text) VALUES (?,?,?)").run(p.url, p.title, p.text);
      })();
    },
    pages(): Omit<Page, "text">[] { return db.prepare("SELECT url, title, site, fetched_at AS fetchedAt FROM pages ORDER BY fetched_at DESC").all() as any[]; },
    removePage(url: string) { db.run("DELETE FROM pages WHERE url = ?", [url]); db.run("DELETE FROM pages_fts WHERE url = ?", [url]); },
    /** Web pages matching a question, with the best-matching snippet. */
    searchPages(qs: string, k = 5): { url: string; title: string; snippet: string; rank: number }[] {
      const fts = ftsQuery(qs);
      if (!fts) return [];
      return db.prepare("SELECT url, title, snippet(pages_fts, 2, '', '', '…', 40) AS snippet, bm25(pages_fts, 0, 2.0, 1.0) AS rank FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?").all(fts, k) as any[];
    },
    close() { db.close(); },
  };
}
export type Cards = ReturnType<typeof openCards>;
