// Founder Library: when each video came out, and how long it is. Channel listings don't carry upload dates, so a
// small backfill asks yt-dlp for each ingested video's publish date, duration and views (a batch at a time, politely,
// resumable) and keeps them in <library>/video-meta.json. Cards and search results read their dates from there; the
// Chroma store is never touched, so this can run beside the bridge.
//
// Dates matter for strategy: a Reddit tactic from 2019 may not work today. Evidence is weighted toward recent stories
// and anything older than about three years is labelled "older (2021)" wherever it is quoted.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type VideoMeta = { date?: string; ts?: number; duration?: number; views?: number; at: number; err?: string };
export type MetaMap = Record<string, VideoMeta>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR = 365.25 * 86_400_000;
/** Stories older than this are labelled "older (year)" when quoted. */
export const OLD_YEARS = 3;

// ── formats ─────────────────────────────────────────────────────────────────────────
/** "20240315" (yt-dlp's upload_date) or a Unix time → "2024-03-15". Undefined for anything else. */
export function isoDate(x: unknown): string | undefined {
  const s = String(x ?? "").trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (/^\d{9,11}(\.\d+)?$/.test(s) && Number.isFinite(n)) return new Date(n * 1000).toISOString().slice(0, 10);
  return undefined;
}
/** "2024-03-15" → "Mar 2024". */
export function fmtPublished(date?: string): string {
  const m = String(date ?? "").match(/^(\d{4})-(\d\d)/);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`.trim() : "";
}
/** Seconds → "18 min", "1 h 05 min", "45 s". */
export function fmtDuration(s?: number): string {
  if (!s || s <= 0) return "";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
/** "Published Mar 2024 · 18 min" (either half may be missing). */
export const fmtMeta = (date?: string, duration?: number) => [fmtPublished(date) && `Published ${fmtPublished(date)}`, fmtDuration(duration)].filter(Boolean).join(" · ");

// ── recency ─────────────────────────────────────────────────────────────────────────
export const ageYears = (date: string | undefined, now = Date.now()) => { const t = date ? Date.parse(date) : NaN; return Number.isFinite(t) ? Math.max(0, (now - t) / YEAR) : undefined; };
/**
 * How much a story counts next to a fresh one: full weight in its first year, then a tenth less per year, never under
 * half (an old story is still a real story). An unknown date sits in between.
 */
export function recencyWeight(date?: string, now = Date.now()): number {
  const y = ageYears(date, now);
  if (y == null) return 0.85;
  return Math.max(0.5, 1 - 0.1 * Math.max(0, y - 1));
}
/** "older (2021)" for a story more than three years old; "" otherwise (or when the date is unknown). */
export function oldLabel(date?: string, now = Date.now()): string {
  const y = ageYears(date, now);
  return y != null && y > OLD_YEARS ? `older (${date!.slice(0, 4)})` : "";
}

// ── yt-dlp output ───────────────────────────────────────────────────────────────────
/** The --print template the backfill asks yt-dlp for, one tab-separated line per video. */
export const PRINT = "%(id)s\t%(upload_date)s\t%(release_timestamp)s\t%(timestamp)s\t%(duration)s\t%(view_count)s";
const num = (s: string | undefined) => { const n = Number(s); return s && s !== "NA" && Number.isFinite(n) && n > 0 ? n : undefined; };
/** One printed line → the video's meta. A premiere's release time wins over its upload time. */
export function parsePrintLine(line: string, now = Date.now()): [string, VideoMeta] | undefined {
  const [id, up, rel, ts, dur, views] = line.trim().split("\t");
  if (!/^[\w-]{11}$/.test(id ?? "")) return undefined;
  const t = num(rel) ?? num(ts);
  const date = isoDate(up !== "NA" ? up : undefined) ?? (t ? isoDate(t) : undefined);
  if (!date) return undefined;
  return [id, { date, ts: t, duration: num(dur), views: num(views), at: now }];
}

// ── the store ───────────────────────────────────────────────────────────────────────
export function metaStore(file: string) {
  let memo: { at: number; m: MetaMap } | undefined;
  const read = (): MetaMap => {
    if (memo && Date.now() - memo.at < 5000) return memo.m;
    let m: MetaMap = {};
    try { if (existsSync(file)) m = JSON.parse(readFileSync(file, "utf8")) ?? {}; } catch {}
    memo = { at: Date.now(), m };
    return m;
  };
  return {
    read,
    get: (id: string) => read()[id],
    /** Merge new entries in (a date already known is never replaced by a failure). */
    merge(add: MetaMap) {
      const m = { ...read() };
      for (const [id, v] of Object.entries(add)) m[id] = v.date || !m[id]?.date ? { ...m[id], ...v } : m[id];
      mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(m));
      renameSync(tmp, file);
      memo = { at: Date.now(), m };
    },
  };
}
export type MetaStore = ReturnType<typeof metaStore>;

/** Videos still without a date: never asked, or failed more than a week ago (a private video stays failed a while). */
export function pendingIds(ids: string[], m: MetaMap, now = Date.now()): string[] {
  return [...new Set(ids)].filter((id) => { const x = m[id]; return !x?.date && (!x?.err || now - x.at > 7 * 86_400_000); });
}

export type Fetcher = (ids: string[]) => Promise<string>;
/** yt-dlp from the library's own newer copy (pydeps) with yt-transcriber's Python: one process per batch, with pauses. */
export function ytdlpFetcher(o: { python: string; pydeps?: string; sleep?: number }): Fetcher {
  return async (ids) => {
    const env = { ...process.env, ...(o.pydeps && existsSync(o.pydeps) ? { PYTHONPATH: o.pydeps } : {}) };
    const p = Bun.spawn([o.python, "-m", "yt_dlp", "--skip-download", "--no-warnings", "--ignore-errors", "--no-playlist", "--sleep-requests", String(o.sleep ?? 1), "--print", PRINT, ...ids.map((id) => `https://www.youtube.com/watch?v=${id}`)], { stdout: "pipe", stderr: "pipe", env });
    const out = await new Response(p.stdout).text();
    await p.exited; // a non-zero exit only means some video failed; the lines that came back still count
    return out;
  };
}

/**
 * Fill in dates for `ids`, `batch` at a time, saving after every batch (so a stop loses at most one batch). Videos a
 * batch didn't print are marked failed with the time, and asked again a week later.
 */
export async function backfillDates(ids: string[], store: MetaStore, fetch: Fetcher, o: { batch?: number; parallel?: number; now?: () => number; log?: (s: string) => void; stop?: () => boolean } = {}) {
  const now = o.now ?? Date.now;
  const todo = pendingIds(ids, store.read(), now());
  const size = Math.max(1, o.batch ?? 20);
  const batches = Array.from({ length: Math.ceil(todo.length / size) }, (_, i) => todo.slice(i * size, i * size + size));
  let found = 0, failed = 0, next = 0;
  async function worker() {
    while (next < batches.length && !o.stop?.()) {
      const b = batches[next++];
      let text = "";
      try { text = await fetch(b); } catch (e: any) { o.log?.(`batch failed: ${e?.message ?? e}`); }
      const got: MetaMap = {};
      for (const line of text.split("\n")) { const r = parsePrintLine(line, now()); if (r && b.includes(r[0])) got[r[0]] = r[1]; }
      for (const id of b) if (!got[id]) got[id] = { at: now(), err: "no date from yt-dlp" };
      store.merge(got);
      const n = b.filter((id) => got[id].date).length;
      found += n; failed += b.length - n;
      o.log?.(`${found + failed}/${todo.length} (${found} dated, ${failed} without)`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(3, o.parallel ?? 1)) }, worker));
  return { asked: todo.length, found, failed };
}
