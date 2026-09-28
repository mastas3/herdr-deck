// Cover images for Discover ideas, painted a few a day in the background (hub only). The best ideas go first:
// saved ones, then the critic's favourites (score >= 7), then the top idea of each feed row. One at a time, spaced
// out, under a daily cap (covers.json), never while someone else's Codex is busy, stopping after repeated failures.
// Covers live in <data>/covers/<ideaId>.webp (+ _thumb.webp) and are served at /covers/<id>.webp; idea objects in
// Discover replies get `coverUrl` (and `coverCat`, the palette the card's placeholder uses). Art: cover-art.ts beside it.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { codexBusy, codexPaint, coverPrompt, categoryOf, imageTool, makeCovers, PALETTES, readJson, readPs, type CoverIdea } from "./cover-art";

/** The local calendar day of a time ("2026-09-28"): the daily cap starts over at midnight. */
const dayOf = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export type CoverConf = { auto: boolean; dailyCap: number; spacingMin: number; busyCpu: number; maxFailures: number; minScore: number };
export const DEFAULTS: CoverConf = { auto: true, dailyCap: 12, spacingMin: 20, busyCpu: 20, maxFailures: 3, minScore: 7 };
type Job = { id: string; force?: boolean; idea?: CoverIdea };
export type CoverState = {
  day: string; today: number; lastAt: number; fails: number; retryAt: number; stopped?: string; paused?: boolean;
  failed: Record<string, number>; queue: Job[];
  last?: { id: string; title: string; ok: boolean; ms: number; error?: string; at: number; bytes?: number };
};
export const freshState = (now: number): CoverState => ({ day: dayOf(now), today: 0, lastAt: 0, fails: 0, retryAt: 0, failed: {}, queue: [] });
const ID = /^[\w-]{1,64}$/;
const MIN = 60_000;

// ── which idea next ──
type Scored = CoverIdea & { score?: number; source?: string; savedAt?: number; dropped?: boolean };
/** Saved first (newest save first), then kept ideas the critic scored >= minScore (best first), then the top of each feed row. */
export function selectCandidates(src: { saved: Scored[]; archive: Scored[]; feed: Scored[] }, has: (id: string) => boolean, failed: Record<string, number> = {}, minScore = DEFAULTS.minScore): Scored[] {
  const byRow = new Map<string, Scored>();
  for (const x of src.feed) {
    const cur = x.row && byRow.get(x.row);
    if (x.row && (!cur || (x.score ?? 6.5) > (cur.score ?? 6.5))) byRow.set(x.row, x);
  }
  const ordered = [
    ...[...src.saved].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)),
    ...src.archive.filter((x) => !x.dropped && (x.score ?? 0) >= minScore).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    ...byRow.values(),
  ];
  const seen = new Set<string>();
  return ordered.filter((x) => {
    if (!x?.id || !ID.test(x.id) || seen.has(x.id)) return false;
    seen.add(x.id);
    return x.source !== "template" && !has(x.id) && (failed[x.id] ?? 0) < 2;
  });
}

// ── when: a small state machine (pure, so it is tested without timers or Codex) ──
export function rollDay(st: CoverState, now: number): CoverState {
  const day = dayOf(now);
  if (st.day === day) return st;
  // A new day: the count starts over and a stop gets one fresh try.
  return { ...st, day, today: 0, stopped: undefined, fails: 0, retryAt: 0 };
}
export type Decision = { run: Job & { manual: boolean } } | { wait: "painting" | "off" | "paused" | "stopped" | "cap" | "retry" | "spacing" | "busy" | "none"; at?: number };
export function decide(st: CoverState, cfg: CoverConf, now: number, env: { running: boolean; busy: () => boolean; next: () => Scored | undefined }): Decision {
  if (env.running) return { wait: "painting" };
  // Asked for by hand ("Generate cover" / "Regenerate"): no cap, no spacing, no waiting for Codex to be free.
  if (st.queue.length) return { run: { ...st.queue[0], manual: true } };
  if (!cfg.auto) return { wait: "off" };
  if (st.paused) return { wait: "paused" };
  if (st.stopped) return { wait: "stopped" };
  if (st.today >= cfg.dailyCap) { const d = new Date(now); d.setHours(24, 0, 0, 0); return { wait: "cap", at: d.getTime() }; }
  if (now < st.retryAt) return { wait: "retry", at: st.retryAt };
  if (now < st.lastAt + cfg.spacingMin * MIN) return { wait: "spacing", at: st.lastAt + cfg.spacingMin * MIN };
  if (env.busy()) return { wait: "busy", at: now + MIN };
  const x = env.next();
  return x ? { run: { id: x.id, idea: x, manual: false } } : { wait: "none" };
}
/** After a run: success resets the failure streak; each failure backs off (10, 20, 40 min…) and enough in a row stop the job. */
export function afterRun(st: CoverState, cfg: CoverConf, now: number, r: { id: string; ok: boolean; manual: boolean; error?: string }): CoverState {
  const s: CoverState = { ...st, failed: { ...st.failed }, lastAt: now, queue: st.queue.filter((j) => j.id !== r.id) };
  if (r.ok) { s.today++; s.fails = 0; s.retryAt = 0; delete s.failed[r.id]; return s; }
  s.fails++;
  s.failed[r.id] = (s.failed[r.id] ?? 0) + 1;
  s.retryAt = now + 10 * MIN * 2 ** (s.fails - 1);
  if (s.fails >= cfg.maxFailures) s.stopped = `Stopped after ${s.fails} failures in a row${r.error ? `: ${r.error}` : ""}`;
  return s;
}

// ── the job ──
export type CoverDeps = {
  dir: string; confFile: string; dataDir: string;
  enabled: () => boolean;
  now?: () => number;
  paint?: (prompt: string, outPng: string, signal: AbortSignal) => Promise<void>;
  busy?: (cpu: number) => boolean;
  tool?: "ffmpeg" | "cwebp";
};
export function createCovers(deps: CoverDeps) {
  const now = deps.now ?? Date.now;
  const paint = deps.paint ?? codexPaint;
  const busy = deps.busy ?? ((cpu: number) => codexBusy(readPs(), process.pid, cpu));
  const STATE = `${deps.dir}/state.json`, WORK = `${deps.dir}/work`;
  mkdirSync(WORK, { recursive: true });
  if (!existsSync(deps.confFile)) try { writeFileSync(deps.confFile, JSON.stringify(DEFAULTS, null, 1)); } catch {}
  const conf = (): CoverConf => ({ ...DEFAULTS, ...(readJson(deps.confFile) ?? {}) });
  let st: CoverState = { ...freshState(now()), ...(readJson(STATE) ?? {}) };
  const save = () => { try { writeFileSync(`${STATE}.tmp`, JSON.stringify(st)); renameSync(`${STATE}.tmp`, STATE); } catch {} };
  /** id → version (file time): what exists on disk is the truth, so a deleted file is simply painted again later. */
  const have = new Map<string, number>();
  for (const f of readdirSync(deps.dir)) { const m = f.match(/^([\w-]+)\.webp$/); if (m && existsSync(`${deps.dir}/${m[1]}_thumb.webp`)) have.set(m[1], Math.round(statSync(`${deps.dir}/${f}`).mtimeMs)); }
  let running: { id: string; title: string; started: number; abort: AbortController } | undefined;
  let waiting: { why: string; at?: number } = { why: "starting" };
  let tool = deps.tool;

  // What there is to paint: saved builds (discover.json), the archive (ideas.db, read-only), today's feed (feed.json).
  let db: Database | undefined;
  function archiveRows(minScore: number): Scored[] {
    try {
      db ??= new Database(`${deps.dataDir}/ideas.db`, { readonly: true });
      return (db.query(`SELECT id, title, row, score, dropped, data FROM ideas WHERE dropped = 0 AND score >= ? ORDER BY score DESC, created_at DESC LIMIT 200`).all(minScore) as any[])
        .map((r) => ({ ...JSON.parse(r.data), id: r.id, title: r.title, row: r.row ?? undefined, score: r.score, dropped: !!r.dropped }));
    } catch { return []; }
  }
  function sources(minScore: number) {
    return { saved: (readJson(`${deps.dataDir}/discover.json`)?.mixes ?? []) as Scored[], archive: archiveRows(minScore), feed: (readJson(`${deps.dataDir}/feed.json`)?.ideas ?? []) as Scored[] };
  }
  function findIdea(id: string): Scored | undefined {
    const s = sources(0);
    return [...s.saved, ...s.feed].find((x) => x.id === id) ?? (() => {
      try { db ??= new Database(`${deps.dataDir}/ideas.db`, { readonly: true }); const r = db.query(`SELECT id, title, row, data FROM ideas WHERE id = ?`).get(id) as any; return r ? { ...JSON.parse(r.data), id: r.id, title: r.title, row: r.row ?? undefined } : undefined; } catch { return undefined; }
    })();
  }

  async function run(job: Job & { manual: boolean }) {
    const idea = findIdea(job.id) ?? job.idea;
    if (!idea?.title) { st = { ...st, queue: st.queue.filter((j) => j.id !== job.id) }; save(); return; }
    running = { id: job.id, title: idea.title, started: now(), abort: new AbortController() };
    const png = `${WORK}/${job.id}.png`;
    let error: string | undefined, bytes = 0;
    try {
      rmSync(png, { force: true });
      await paint(coverPrompt(idea, png).prompt, png, running.abort.signal);
      tool ??= imageTool();
      const sizes = await makeCovers(png, `${WORK}/${job.id}`, tool);
      // Both files replace the old ones only once both exist, so a card never shows half a regeneration.
      renameSync(`${WORK}/${job.id}.webp`, `${deps.dir}/${job.id}.webp`);
      renameSync(`${WORK}/${job.id}_thumb.webp`, `${deps.dir}/${job.id}_thumb.webp`);
      have.set(job.id, now());
      bytes = sizes.main + sizes.thumb;
    } catch (e: any) { error = e?.message ?? String(e); }
    finally { rmSync(png, { force: true }); }
    const ms = now() - running.started;
    console.log(`covers: ${error ? "failed" : "painted"} ${job.id} “${idea.title}” in ${(ms / 1000).toFixed(0)}s${error ? `: ${error}` : ` (${Math.round(bytes / 1024)} KB)`}`);
    st = afterRun(st, conf(), now(), { id: job.id, ok: !error, manual: job.manual, error });
    st.last = { id: job.id, title: idea.title, ok: !error, ms, error, at: now(), bytes: bytes || undefined };
    running = undefined;
    save();
    // Someone asked for a cover while this one was painting: theirs goes next, not at the next minute.
    if (st.queue.length) setTimeout(() => tick(), 0);
  }
  let stopped = false;
  /** One look at the clock: start the next cover if it's time. Returns the run's promise when one started. */
  function tick(): Promise<void> | undefined {
    if (stopped) return;
    if (!deps.enabled()) { waiting = { why: "hub-only" }; return; }
    const cfg = conf();
    const rolled = rollDay(st, now());
    if (rolled !== st) { st = rolled; save(); }
    const d = decide(st, cfg, now(), { running: !!running, busy: () => busy(cfg.busyCpu), next: () => selectCandidates(sources(cfg.minScore), (id) => have.has(id), st.failed, cfg.minScore)[0] });
    if ("wait" in d) { waiting = { why: d.wait, at: d.at }; return; }
    waiting = { why: "painting" };
    return run(d.run).catch(() => { running = undefined; });
  }
  function status() {
    const cfg = conf();
    return {
      today: st.today, cap: cfg.dailyCap, auto: cfg.auto, paused: !!st.paused, stopped: st.stopped, enabled: deps.enabled(),
      running: running ? { id: running.id, title: running.title, elapsed: now() - running.started } : undefined,
      next: waiting, queue: st.queue.map((j) => j.id), last: st.last, count: have.size,
      have: Object.fromEntries(have), palettes: Object.fromEntries(Object.entries(PALETTES).map(([k, p]) => [k, [...p.inks, p.paper]])),
    };
  }
  const coverUrl = (id: string) => (have.has(id) ? `/covers/${id}.webp?v=${have.get(id)}` : undefined);
  /** JSON with covers: every idea-shaped object (id, title and a pitch or data) gets coverUrl/thumbUrl when painted (looked up by its coverId when it has one), and coverCat. Nothing is mutated. */
  function respond(data: unknown): Response {
    const body = JSON.stringify(data, (_k, v) => {
      if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.id !== "string" || typeof v.title !== "string") return v;
      const inner = typeof v.pitch === "string" ? v : v.data && typeof v.data === "object" ? v.data : undefined;
      if (!inner) return v;
      const url = coverUrl(typeof v.coverId === "string" ? v.coverId : v.id);
      return { ...v, coverCat: categoryOf({ ...inner, row: v.row ?? inner.row, title: v.title }), ...(url ? { coverUrl: url, thumbUrl: url.replace(".webp?", "_thumb.webp?") } : {}) };
    });
    return new Response(body, { headers: { "content-type": "application/json;charset=utf-8" } });
  }
  async function handle(body: any): Promise<unknown> {
    const op = String(body?.op ?? "status");
    if (op === "generate") {
      const id = String(body.id ?? "");
      if (!ID.test(id)) throw new Error("Which idea?");
      if (!deps.enabled()) throw new Error("Covers are painted on the hub");
      if (have.has(id) && !body.force) return { ...status(), note: "It already has a cover" };
      const idea = body.idea && typeof body.idea === "object" ? { ...body.idea, id } as CoverIdea : undefined;
      if (!findIdea(id) && !idea?.title) throw new Error("That idea isn't in the archive");
      if (running?.id !== id && !st.queue.some((j) => j.id === id)) st = { ...st, queue: [...st.queue, { id, force: !!body.force, idea }].slice(-20) };
      save();
      tick();
    } else if (op === "pause" || op === "resume") {
      st = { ...st, paused: op === "pause", ...(op === "resume" ? { stopped: undefined, fails: 0, retryAt: 0, lastAt: 0 } : {}) };
      save();
      if (op === "resume") tick();
    } else if (op !== "status") throw new Error("unknown op");
    return status();
  }
  return {
    /** /covers/<id>.webp and /covers/<id>_thumb.webp (GET, like the icons), /api/covers (POST, token checked). Undefined: not ours. */
    async route(req: Request, url: URL, tokenOk: boolean): Promise<Response | undefined> {
      if (req.method === "GET" && url.pathname.startsWith("/covers/")) {
        const m = url.pathname.match(/^\/covers\/([\w-]{1,64}(?:_thumb)?)\.webp$/);
        const f = m && Bun.file(`${deps.dir}/${m[1]}.webp`);
        if (!f || !(await f.exists())) return new Response("no cover", { status: 404 });
        return new Response(f, { headers: { "content-type": "image/webp", "cache-control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=3600" } });
      }
      if (req.method !== "POST" || url.pathname !== "/api/covers") return;
      if (!tokenOk) return new Response("forbidden", { status: 403 });
      try { return Response.json(await handle(await req.json().catch(() => ({})))); } catch (e: any) { return Response.json({ error: e?.message ?? String(e) }, { status: 400 }); }
    },
    respond, status, tick, handle, has: (id: string) => have.has(id), coverUrl,
    /** The job's clock is its owner's (the plugin host's timers); stop() makes any later tick a no-op and aborts a painting. */
    stop() { stopped = true; running?.abort.abort(); db?.close(); db = undefined; },
    _state: () => st,
  };
}
export type Covers = ReturnType<typeof createCovers>;
