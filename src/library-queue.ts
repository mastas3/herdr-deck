// Founder Library: the ingestion queue. One small JSON file per source lists its videos in the order they will
// be ingested and where each one stands. Pure functions do the deciding (ranking, the next video, what a result
// means, recovery after a crash) so they can be tested; the runner only moves videos through them.
//
//   queued → ingesting → ingested
//                      ↘ no_captions   (waits for Whisper, which is off by default)
//                      ↘ failed        (retried twice more after a backoff, then left for you)
//   skipped: shorts, too short or long, filtered by title, or beyond the source's limit (raising it re-queues them)
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import type { LibSource } from "./library-config";

export type VStatus = "queued" | "ingesting" | "ingested" | "no_captions" | "failed" | "skipped";
export type QVideo = {
  id: string; title: string; url: string;
  duration?: number; views?: number; date?: string; order: number; short?: boolean;
  status: VStatus; why?: string; attempts: number; retryAt?: number; error?: string;
  chunks?: number; at?: number;
};
export type Queue = { source: string; channelId?: string; title?: string; enumeratedAt?: number; error?: string; videos: QVideo[] };
export type Enumerated = { channel_id?: string; channel_title?: string; videos: { video_id: string; url?: string; title?: string; duration_s?: number | null; view_count?: number | null; upload_date?: string | null; is_short?: boolean; order?: number }[] };

export const MAX_ATTEMPTS = 3;
export const MIN_SECONDS = 150; // shorter is a trailer or a short; no founder story fits
export const MAX_SECONDS = 4 * 3600;
const RETRY_MS = [0, 10 * 60_000, 60 * 60_000];

/** Why a video is left out, or undefined when it should be ingested. `limit` is applied afterwards, by rank. */
export function skipReason(v: Pick<QVideo, "title" | "duration" | "short">, s: Pick<LibSource, "shorts" | "include" | "exclude">): string | undefined {
  if (v.short && !s.shorts) return "short";
  if (v.duration != null && v.duration < MIN_SECONDS && !s.shorts) return "too short";
  if (v.duration != null && v.duration > MAX_SECONDS) return "over 4 hours";
  if (s.include && !new RegExp(s.include, "i").test(v.title)) return "title filter";
  if (s.exclude && new RegExp(s.exclude, "i").test(v.title)) return "title filter";
  return undefined;
}

/**
 * Best first: half most viewed, half most recent. Channel tabs list newest first, so `order` is recency; view
 * counts are ranked rather than used raw so one viral video doesn't swamp the rest. Without view counts, recency.
 */
export function rankVideos<T extends Pick<QVideo, "views" | "order">>(vs: T[]): T[] {
  const n = vs.length;
  if (!n) return [];
  const haveViews = vs.some((v) => (v.views ?? 0) > 0);
  const byViews = [...vs].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const vRank = new Map(byViews.map((v, i) => [v, i]));
  const score = (v: T) => (haveViews ? 0.5 * (vRank.get(v)! / n) + 0.5 * (v.order / n) : v.order / n);
  return [...vs].sort((a, b) => score(a) - score(b) || a.order - b.order);
}

/**
 * Fold a fresh enumeration into the queue: known videos keep their status, new ones join, then everything not yet
 * done is re-ranked and the source's filters and limit decide queued vs skipped.
 */
export function mergeEnumeration(q: Queue, e: Enumerated, s: LibSource, now = Date.now()): Queue {
  const old = new Map(q.videos.map((v) => [v.id, v]));
  const fresh: QVideo[] = e.videos.map((x, i) => {
    const prev = old.get(x.video_id);
    const base = { id: x.video_id, title: x.title ?? prev?.title ?? "(untitled)", url: x.url ?? `https://www.youtube.com/watch?v=${x.video_id}`, duration: x.duration_s ?? prev?.duration, views: x.view_count ?? prev?.views, date: x.upload_date ?? prev?.date, order: x.order ?? i, short: x.is_short || undefined };
    return prev ? { ...prev, ...base } : { ...base, status: "queued" as VStatus, attempts: 0 };
  });
  // Videos that vanished from the listing (made private, deleted) keep their record if they were ingested.
  const gone = q.videos.filter((v) => !fresh.some((f) => f.id === v.id) && v.status === "ingested");
  const all = [...fresh, ...gone];
  return { ...q, channelId: e.channel_id ?? q.channelId, title: e.channel_title ?? q.title, enumeratedAt: now, error: undefined, videos: applyRules(all, s) };
}

/** Re-decide queued/skipped for everything not finished, in rank order (after a limit or filter change too). */
export function applyRules(vs: QVideo[], s: LibSource): QVideo[] {
  const settled = (v: QVideo) => v.status === "ingested" || v.status === "ingesting" || v.status === "failed" || v.status === "no_captions";
  const ranked = rankVideos(vs);
  let taken = ranked.filter((v) => v.status === "ingested" || v.status === "ingesting").length;
  const limit = s.limit ?? Infinity;
  return ranked.map((v) => {
    if (settled(v)) return v;
    const why = skipReason(v, s);
    if (why) return { ...v, status: "skipped", why };
    if (taken >= limit) return { ...v, status: "skipped", why: "beyond limit" };
    taken++;
    return { ...v, status: "queued", why: undefined };
  });
}

/** The next video to ingest: sources in their listed order, videos in rank order, failed ones once their backoff is over. */
export function nextVideo(queues: Queue[], order: string[], now = Date.now(), whisper = false): { q: Queue; v: QVideo } | undefined {
  const by = new Map(queues.map((q) => [q.source, q]));
  for (const id of order) {
    const q = by.get(id);
    if (!q) continue;
    const v = q.videos.find((x) => x.status === "queued" && (!x.retryAt || x.retryAt <= now))
      ?? (whisper ? q.videos.find((x) => x.status === "no_captions") : undefined);
    if (v) return { q, v };
  }
  return undefined;
}

export type IngestResult = { status: "ingested" | "no_captions" | "failed"; chunks?: number; error?: string };
/** A video's record after an ingest attempt. A failure is retried later, up to three attempts in all. */
export function applyResult(v: QVideo, r: IngestResult, now = Date.now()): QVideo {
  const attempts = v.attempts + 1;
  if (r.status === "ingested") return { ...v, status: "ingested", attempts, chunks: r.chunks, at: now, error: undefined, retryAt: undefined };
  if (r.status === "no_captions") return { ...v, status: "no_captions", attempts, at: now, error: undefined };
  const err = String(r.error ?? "failed").slice(0, 300);
  // YouTube's bot check doesn't go away by retrying soon: those wait an hour.
  const wait = /confirm you.re not a bot|429|too many requests/i.test(err) ? RETRY_MS[2] : RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)];
  return attempts >= MAX_ATTEMPTS ? { ...v, status: "failed", attempts, error: err, at: now, retryAt: undefined } : { ...v, status: "queued", attempts, error: err, at: now, retryAt: now + wait };
}
export const beginVideo = (v: QVideo, now = Date.now()): QVideo => ({ ...v, status: "ingesting", at: now });
/** After a crash or restart nothing is really ingesting: those go back to the front of the queue. */
export const recover = (q: Queue): Queue => ({ ...q, videos: q.videos.map((v) => (v.status === "ingesting" ? { ...v, status: "queued" } : v)) });

export type Counts = { total: number; queued: number; ingested: number; failed: number; no_captions: number; skipped: number; ingesting: number; chunks: number };
export function countQueue(q: Queue | undefined): Counts {
  const c: Counts = { total: 0, queued: 0, ingested: 0, failed: 0, no_captions: 0, skipped: 0, ingesting: 0, chunks: 0 };
  for (const v of q?.videos ?? []) { c.total++; c[v.status]++; c.chunks += v.chunks ?? 0; }
  return c;
}

// ── files ────────────────────────────────────────────────────────────────────
export function queueStore(dir: string) {
  const file = (id: string) => `${dir}/${id}.json`;
  return {
    read(id: string): Queue {
      try { const q = JSON.parse(readFileSync(file(id), "utf8")); if (q && Array.isArray(q.videos)) return q; } catch {}
      return { source: id, videos: [] };
    },
    write(q: Queue) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file(q.source)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(q));
      renameSync(tmp, file(q.source));
    },
    ids(): string[] { try { return readdirSync(dir).filter((f) => /^[\w.-]+\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch { return []; } },
  };
}
