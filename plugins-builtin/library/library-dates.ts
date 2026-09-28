// Founder Library: when each video came out, and how long it is. Channel listings don't carry upload dates, so a
// small backfill asks yt-dlp for each ingested video's publish date, duration and views (a batch at a time, politely,
// resumable) and keeps them in <library>/video-meta.json. Cards and search results read their dates from there; the
// Chroma store is never touched, so this can run beside the bridge.
//
// Dates matter for strategy: a Reddit tactic from 2019 may not work today. Evidence is weighted toward recent stories
// and anything older than about three years is labelled "older (2021)" wherever it is quoted.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ageYears, fmtDuration, fmtMeta, fmtPublished, isoDate, oldLabel, OLD_YEARS, recencyWeight, type MetaMap, type VideoMeta } from "../../src/library-card";

// How dates print and weigh live in the core (src/library-card.ts): Discover and the Studio print cards too.
export { ageYears, fmtDuration, fmtMeta, fmtPublished, isoDate, oldLabel, OLD_YEARS, recencyWeight, type MetaMap, type VideoMeta };

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
