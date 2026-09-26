// Founder Library: the background worker. Two loops, one per bottleneck: ingestion waits on YouTube (captions take
// seconds a video), card extraction waits on the local Ollama model. Only one process runs them at a time (the deck
// service or `bun src/library-cli.ts run`), guarded by <library>/runner.lock, and a restart resumes where it stopped.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Bridge } from "./library-bridge";
import type { LibConfig, LibSource } from "./library-config";
import { applyResult, applyRules, beginVideo, mergeEnumeration, nextVideo, recover, type Enumerated, type IngestResult, type Queue, type QVideo } from "./library-queue";

const REFRESH_MS = 24 * 3600_000; // look for new uploads once a day
type QStore = { read: (id: string) => Queue; write: (q: Queue) => void };
export type RunnerDeps = {
  dir: string; bridge: Bridge; queues: QStore;
  config: () => LibConfig;
  /** Extract the next pending card; false when there is nothing to do. */
  extractNext?: (cfg: LibConfig) => Promise<boolean>;
  /** A video's publish date and length, when an ingest reported them. */
  onMeta?: (id: string, meta: NonNullable<IngestResult["meta"]>) => void;
  now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (s: string) => void;
};
export type RunnerStatus = {
  running: boolean; owner?: number; startedAt?: number;
  current?: { source: string; video: string; title: string; since: number };
  enumerating?: string; extracting: boolean;
  run: { ingested: number; noCaptions: number; failed: number; cards: number; since?: number };
  lastError?: string;
};

export const sourceChannelId = (q: Queue, s: LibSource) => q.channelId ?? s.id;

export function createRunner(d: RunnerDeps) {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = d.log ?? ((s: string) => console.log(`library: ${s}`));
  const lockFile = `${d.dir}/runner.lock`;
  const st: RunnerStatus = { running: false, extracting: false, run: { ingested: 0, noCaptions: 0, failed: 0, cards: 0 } };
  let stopFlag = false;
  // The worker's status, in a file, so the deck can show it while the CLI (another process) runs the worker.
  const statusFile = `${d.dir}/runner.json`;
  let pubAt = 0;
  const publish = (force = false) => {
    if (!force && now() - pubAt < 1000) return;
    pubAt = now();
    try { writeFileSync(statusFile, JSON.stringify({ ...st, owner: process.pid, at: now() })); } catch {}
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  function lockOwner(): number | undefined {
    try { const pid = Number(JSON.parse(readFileSync(lockFile, "utf8")).pid); return pid && alive(pid) ? pid : undefined; } catch { return undefined; }
  }
  function takeLock(): boolean {
    const o = lockOwner();
    if (o && o !== process.pid) return false;
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: now() }));
    return true;
  }
  function dropLock() { if (lockOwner() === process.pid) try { unlinkSync(lockFile); } catch {} }

  /** Enumerate a source when it never was, or once a day for new uploads. */
  async function refresh(s: LibSource, force = false): Promise<Queue> {
    let q = d.queues.read(s.id);
    if (!force && q.enumeratedAt && now() - q.enumeratedAt < REFRESH_MS) {
      // Filters or the limit may have changed in channels.json since: re-apply them (cheap, no network).
      const again = { ...q, videos: applyRules(q.videos, s) };
      if (JSON.stringify(again.videos.map((v) => v.status)) !== JSON.stringify(q.videos.map((v) => v.status))) d.queues.write(again);
      return again;
    }
    st.enumerating = s.id;
    try {
      const body = s.kind === "videos" ? { kind: "videos", urls: (s.videos ?? []).map((id) => `https://www.youtube.com/watch?v=${id}`) } : { kind: s.kind, url: s.url };
      const e = await d.bridge.call<Enumerated>("/enumerate", body, 180_000);
      q = mergeEnumeration(q, e, s, now());
      if (s.kind !== "channel") q.title = s.title ?? q.title;
      log(`${s.id}: ${q.videos.length} videos listed`);
    } catch (e: any) {
      q = { ...q, error: String(e?.message ?? e).slice(0, 300), enumeratedAt: q.enumeratedAt };
      log(`${s.id}: listing failed: ${q.error}`);
    } finally { st.enumerating = undefined; }
    d.queues.write(q);
    return q;
  }

  async function ingestOne(): Promise<boolean> {
    const cfg = d.config();
    const sources = cfg.sources.filter((s) => s.enabled);
    // Sources are listed lazily, in order: the first one with work left is ingested before the next is even listed.
    let pick: ReturnType<typeof nextVideo>;
    for (const s of sources) {
      if (stopFlag) return false;
      pick = nextVideo([await refresh(s)], [s.id], now(), cfg.ingest.whisper);
      if (pick) break;
    }
    if (!pick) return false;
    const s = sources.find((x) => x.id === pick!.q.source)!;
    const q = d.queues.read(s.id);
    const idx = q.videos.findIndex((v) => v.id === pick!.v.id);
    if (idx < 0) return false;
    q.videos[idx] = beginVideo(q.videos[idx], now());
    d.queues.write(q);
    const v: QVideo = q.videos[idx];
    st.current = { source: s.id, video: v.id, title: v.title, since: now() };
    publish(true);
    let r: IngestResult;
    try {
      r = await d.bridge.call<IngestResult>("/ingest", { channel_id: sourceChannelId(q, s), video: { video_id: v.id, url: v.url, title: v.title }, whisper: cfg.ingest.whisper && v.status !== "queued" }, cfg.ingest.whisper ? 30 * 60_000 : 5 * 60_000);
    } catch (e: any) { r = { status: "failed", error: String(e?.message ?? e) }; }
    const after = d.queues.read(s.id);
    const j = after.videos.findIndex((x) => x.id === v.id);
    if (j >= 0) { after.videos[j] = applyResult(after.videos[j], r, now()); d.queues.write(after); }
    if (r.meta?.date) d.onMeta?.(v.id, r.meta);
    st.current = undefined;
    if (r.status === "ingested") st.run.ingested++;
    else if (r.status === "no_captions") st.run.noCaptions++;
    else { st.run.failed++; st.lastError = `${v.title}: ${r.error}`; log(`failed ${v.id}: ${r.error}`); }
    publish(true);
    return true;
  }

  async function ingestLoop() {
    while (!stopFlag && d.config().ingest.running) {
      let did = false;
      try { did = await ingestOne(); } catch (e: any) { st.lastError = String(e?.message ?? e); log(`ingest: ${st.lastError}`); await sleep(30_000); }
      await sleep(did ? d.config().ingest.pauseMs : 60_000);
    }
  }
  async function extractLoop() {
    if (!d.extractNext) return;
    while (!stopFlag && d.config().ingest.running) {
      const cfg = d.config();
      let did = false;
      if (cfg.extract.running) {
        st.extracting = true;
        publish();
        try { did = await d.extractNext(cfg); if (did) { st.run.cards++; publish(true); } } catch (e: any) { st.lastError = `cards: ${e?.message ?? e}`; log(st.lastError); await sleep(20_000); }
        st.extracting = false;
      }
      await sleep(did ? 500 : 30_000);
    }
  }

  return {
    status(): RunnerStatus {
      if (st.running) return { ...st, owner: process.pid };
      const owner = lockOwner();
      if (owner) { try { const f = JSON.parse(readFileSync(statusFile, "utf8")); if (f.owner === owner) return { ...f, running: false, owner }; } catch {} }
      return { ...st, owner };
    },
    /** Start both loops unless another process runs them. Resolves when they stop. */
    async run(): Promise<{ ok: boolean; owner?: number }> {
      if (st.running) return { ok: true };
      if (!takeLock()) return { ok: false, owner: lockOwner() };
      stopFlag = false;
      st.running = true; st.startedAt = now(); st.run = { ingested: 0, noCaptions: 0, failed: 0, cards: 0, since: now() };
      for (const s of d.config().sources) { const q = d.queues.read(s.id); if (q.videos.some((v) => v.status === "ingesting")) d.queues.write(recover(q)); }
      publish(true);
      try { await Promise.all([ingestLoop(), extractLoop()]); } finally { st.running = false; st.current = undefined; st.extracting = false; publish(true); dropLock(); }
      return { ok: true };
    },
    stop() { stopFlag = true; },
    refresh,
    lockOwner,
    hasLock: () => existsSync(lockFile) && lockOwner() === process.pid,
  };
}
export type Runner = ReturnType<typeof createRunner>;
