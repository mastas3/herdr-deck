// Project pages, the service: each project's journey cached in <data>/journeys/, rebuilt in the background when its
// inputs move, the AI read queued (at most daily, or on Regenerate), manual entries, the index of every project, and
// the /api/journey* answers. The model itself is journey.ts; the evidence comes from journey-collect.ts (git) and
// journey-sources.ts (the rest).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { journeyComparables } from "./journey-comparables";
import { aiSig, analyze, guardLadder, slug, type AiResult, type DigestInput, type LadderItem, type Runner } from "./journey-ai";
import { clip, collectGit, gitSig, type GitData } from "./journey-collect";
import { collectGitHub, collectGumroad, collectNotes, collectWiki, type GhData, type GumroadData, type SessRec, type WikiData } from "./journey-sources";
import { V, assemble, type Evidence, type Journey, type ManualData } from "./journey";

const HOME = homedir();
const DAY = 86_400_000;

// ── the service: cache, rebuilds, AI jobs, manual entries, the index ────────────────────────
export type JourneyDeps = {
  /** Past sessions for a project on every machine (history index), plus sessions that name it. */
  sessions: (project: string) => Promise<SessRec[]>;
  /** Live sessions now (rows), for every project. */
  live: () => SessRec[];
  /** Projects the history index knows, with counts. */
  historyProjects?: () => { project: string; n: number; last: number }[];
  /** This machine's history index, read-only: sessions under a folder (worktrees) and by project name (spin-offs). */
  local?: { underRoot: (root: string) => SessRec[]; byProject: (name: string) => SessRec[]; weeks: (since: number) => { project: string; week: number; n: number }[] };
  runner?: Runner;
  gh?: (args: string[]) => Promise<{ ok: boolean; out: string; err: string }>;
  fetch?: typeof fetch;
  now?: () => number;
};
export type JourneyPaths = { dataDir: string; wikiDir: string; projectsDir: string; cacheDir?: string };
type CacheFile = {
  v: number; project: string; journey?: Journey; root?: string;
  git?: { sig: string; data: GitData }; wiki?: { sig: string; data: WikiData };
  gh?: GhData; gum?: GumroadData; ai?: AiResult & { sig: string };
};
const safeName = (p: string) => String(p ?? "").replace(/[^\w.@-]+/g, "_").slice(0, 80);
const REBUILD_AFTER = 45_000;
const AI_EVERY = DAY;

export function createJourneys(paths: JourneyPaths, deps: JourneyDeps) {
  const dir = paths.cacheDir ?? `${paths.dataDir}/journeys`;
  mkdirSync(dir, { recursive: true });
  const now = () => deps.now?.() ?? Date.now();
  const mem = new Map<string, CacheFile>();
  const building = new Map<string, Promise<Journey>>();
  const aiRunning = new Map<string, Promise<void>>();
  let aiQueue: Promise<void> = Promise.resolve();
  const stats = { aiCalls: 0, builds: 0 };
  const aiOff = () => process.env.DECK_JOURNEY_AI === "0";

  const fileOf = (p: string) => `${dir}/${safeName(p)}.json`;
  function load(p: string): CacheFile {
    const hit = mem.get(p);
    if (hit) return hit;
    let c: CacheFile = { v: V, project: p };
    try { const j = JSON.parse(readFileSync(fileOf(p), "utf8")); if (j?.v === V) c = j; } catch {}
    mem.set(p, c);
    return c;
  }
  function save(c: CacheFile) {
    try { const f = fileOf(c.project), tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(c)); renameSync(tmp, f); } catch {}
  }
  // Manual entries: one small file for every project.
  const manualFile = `${dir}/manual.json`;
  let manualAll: Record<string, ManualData> = {};
  try { manualAll = JSON.parse(readFileSync(manualFile, "utf8")); } catch {}
  const manualOf = (p: string): ManualData => ({ metrics: [], unlocks: [], ...manualAll[p] });
  const saveManual = () => { try { const tmp = `${manualFile}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(manualAll, null, 1)); renameSync(tmp, manualFile); } catch {} };

  /** The project's folder on this machine: a live session's root, the history's, or <projects>/<name>. */
  function rootOf(p: string, ss: SessRec[] = []): string | undefined {
    const cands = [...deps.live().filter((s) => s.project === p && !s.machine?.includes("|")).map((s) => s.root), ...ss.filter((s) => !s.mention && s.root).map((s) => s.root), `${paths.projectsDir}/${p}`];
    return cands.find((r): r is string => !!r && r.startsWith(HOME) && existsSync(r) && r.split("/").pop() === p) ?? cands.find((r): r is string => !!r && existsSync(r));
  }

  async function build(p: string, opts: { quick?: boolean } = {}): Promise<Journey> {
    const t0 = Date.now();
    const c = load(p);
    const found = await deps.sessions(p).catch(() => [] as SessRec[]);
    const liveAll = deps.live();
    const live = liveAll.filter((s) => s.project === p);
    const root = rootOf(p, found);
    // Worktree sessions are filed under the worktree's name; they belong here, on their branch's lane.
    const have = new Set([...found, ...live].map((s) => s.id));
    const under = root ? (deps.local?.underRoot(root) ?? []).filter((s) => !have.has(s.id) && s.project !== p && !live.some((l) => l.id === s.id)) : [];
    under.forEach((s) => have.add(s.id));
    // Sibling projects named after this one ("herdr-deck-video") are spin-offs: their sessions ride their own lane.
    const sibs = siblingsOf(p);
    const sibSessions: SessRec[] = [];
    for (const sib of sibs) for (const s of [...liveAll.filter((x) => x.project === sib), ...(deps.local?.byProject(sib) ?? [])]) if (!have.has(s.id)) { have.add(s.id); sibSessions.push({ ...s, project: sib }); }
    const sessions = [...found, ...under];
    // Each source is re-read only when its fingerprint moved (git refs, wiki mtimes) or its time ran out (GitHub, Gumroad).
    const [git, wiki] = await Promise.all([
      (async () => {
        if (!root || !existsSync(`${root}/.git`)) return undefined;
        const sig = await gitSig(root);
        if (c.git && c.git.sig === sig && c.git.data.root === root && sig) {
          // Refs are the same: only the working tree may have changed.
          return c.git.data;
        }
        const data = await collectGit(root, { now: now() });
        if (data) c.git = { sig, data };
        return data;
      })(),
      (async () => { const w = await collectWiki(paths.wikiDir, p); c.wiki = { sig: w.sig, data: w }; return w; })(),
    ]);
    const notes = collectNotes(paths.dataDir, p);
    // GitHub and Gumroad are slow and change slowly: refreshed after this build, in the background, on their own clocks.
    if (!opts.quick && ((git?.github && (!c.gh || now() - c.gh.at > 12 * 3600_000)) || !c.gum || now() - c.gum.at > 6 * 3600_000)) setTimeout(() => refreshExternal(p, git?.github), 0);
    const ev: Evidence = { git, wiki, sessions, gh: c.gh, gum: c.gum, manual: manualOf(p), notes };
    const running = aiRunning.has(p);
    const { journey, digest } = assemble(p, ev, c.ai, { root, live, now: now(), t0, aiState: running ? "running" : undefined, siblings: sibs.map((name) => ({ name, sessions: sibSessions.filter((s) => s.project === name) })) });
    if (c.ai) journey.ai.stale = c.ai.sig !== aiSig(digest);
    c.journey = journey; c.root = root;
    stats.builds++;
    save(c);
    lastDigest.set(p, digest);
    return journey;
  }
  const lastDigest = new Map<string, DigestInput>();
  const external = new Set<string>();
  async function refreshExternal(p: string, github?: string) {
    if (external.has(p)) return;
    external.add(p);
    try {
      const c = load(p);
      if (github && (!c.gh || now() - c.gh.at > 12 * 3600_000)) c.gh = await collectGitHub(github, deps.gh);
      if (!c.gum || now() - c.gum.at > 6 * 3600_000) {
        const pageText = await Bun.file(`${paths.wikiDir}/projects/${p}.md`).text().catch(() => "");
        c.gum = (await collectGumroad(p, pageText, deps.fetch)) ?? { at: now(), ok: false, error: "not configured", products: [], sales: 0, revenue: 0, currency: "usd", series: [], salesSeries: [] };
      }
      save(c);
      await rebuild(p, { quick: true });
    } catch {} finally { external.delete(p); }
  }
  /** Projects whose name starts with this one's ("herdr-deck-video" for "herdr-deck"): folders, live sessions, history. */
  function siblingsOf(p: string): string[] {
    const pre = `${p}-`;
    const names = new Set<string>();
    try { for (const d of readdirSync(paths.projectsDir)) if (d.startsWith(pre)) names.add(d); } catch {}
    for (const s of deps.live()) if (s.project?.startsWith(pre)) names.add(s.project);
    for (const h of deps.historyProjects?.() ?? []) if (h.project.startsWith(pre)) names.add(h.project);
    return [...names].slice(0, 12);
  }

  function rebuild(p: string, opts: { quick?: boolean } = {}): Promise<Journey> {
    const cur = building.get(p);
    if (cur) return cur;
    const job = build(p, opts).finally(() => building.delete(p));
    building.set(p, job);
    return job;
  }

  /** Runs the AI read for a project (one at a time across projects), then rebuilds with it. */
  function startAi(p: string, force = false) {
    if (aiRunning.has(p)) return;
    const job = (aiQueue = aiQueue.then(async () => {
      try {
        const c = load(p);
        let dig = lastDigest.get(p);
        if (!dig) { await rebuild(p); dig = lastDigest.get(p); }
        if (!dig) return;
        const sig = aiSig(dig);
        if (!force && c.ai && c.ai.sig === sig) return;
        if (aiOff() && c.ai && c.ai.source !== "rules") return; // never replace a model's read with rules just because AI is off now
        const res = aiOff() ? await analyze(dig, { runner: async () => { throw new Error("AI is turned off (DECK_JOURNEY_AI=0)"); } }) : await analyze(dig, { runner: deps.runner, onCall: () => { stats.aiCalls++; } });
        c.ai = { ...res, sig };
        save(c);
      } catch {}
    }).finally(() => { aiRunning.delete(p); return rebuild(p, { quick: true }).catch(() => {}); }));
    aiRunning.set(p, job);
  }

  /** The page's data: from cache at once when there is one (rebuilding in the background when it's old). */
  async function get(p: string, opts: { refresh?: boolean; noAi?: boolean } = {}): Promise<Journey & { pending: boolean }> {
    const c = load(p);
    let j = c.journey;
    if (!j || opts.refresh) j = await rebuild(p);
    else if (now() - j.builtAt > REBUILD_AFTER) rebuild(p).catch(() => {});
    if (!opts.noAi) {
      const dig = lastDigest.get(p);
      const aged = c.ai && now() - c.ai.at > AI_EVERY && dig && c.ai.sig !== aiSig(dig);
      if (!c.ai || aged) startAi(p);
    }
    const running = aiRunning.has(p);
    return { ...j, ai: { ...j.ai, state: running ? "running" : j.ai.state === "running" ? (c.ai ? "done" : "none") : j.ai.state }, pending: running || building.has(p) };
  }

  function logMetric(p: string, body: { metric: string; value: number; at?: number; note?: string }) {
    const metric = slug(String(body.metric ?? ""), 30).replace(/-/g, "_");
    const value = Number(body.value);
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(metric) || !Number.isFinite(value)) throw new Error("A metric needs a name and a number");
    const at = Number(body.at) || now();
    const m = (manualAll[p] = manualOf(p));
    m.metrics.push({ metric, value, at, note: body.note ? clip(body.note, 200) : undefined });
    saveManual();
  }
  /** A milestone ladder seeded from an idea (a game run): it wins over the AI's and the template until cleared. */
  function seedLadder(p: string, items: LadderItem[]) {
    const m = (manualAll[p] = manualOf(p));
    m.ladder = guardLadder(items.map((x, i) => ({ ...x, id: slug(x.id || x.title), tier: x.tier ?? i })));
    saveManual();
    const c = load(p);
    c.journey = undefined; // the next open rebuilds with it
  }
  function markUnlocked(p: string, body: { id: string; note?: string; at?: number; undo?: boolean }) {
    const id = slug(String(body.id ?? ""));
    const m = (manualAll[p] = manualOf(p));
    if (body.undo) m.unlocks = m.unlocks.filter((u) => u.id !== id);
    else {
      const note = clip(body.note ?? "", 240);
      if (!note) throw new Error("Say what happened: a note is the evidence");
      m.unlocks = [...m.unlocks.filter((u) => u.id !== id), { id, at: Number(body.at) || now(), note }];
    }
    saveManual();
  }

  // ── the index: every project with a mini activity line ──────────────────────────
  const indexFile = `${dir}/index.json`;
  let gitWeeks: Record<string, { at: number; weeks: number[]; last?: number; commits?: number }> = {};
  try { gitWeeks = JSON.parse(readFileSync(indexFile, "utf8")); } catch {}
  let weeksJob: Promise<void> | undefined;
  const WEEKS = 26;
  function refreshGitWeeks(roots: [string, string][]) {
    if (weeksJob) return weeksJob;
    weeksJob = (async () => {
      const since = now() - WEEKS * 7 * DAY;
      const todo = roots.filter(([p]) => !gitWeeks[p] || now() - gitWeeks[p].at > 3600_000);
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(async ([p, root]) => {
          const { run } = await import("./journey-collect");
          const r = await run(["git", "log", "--all", `--since=${Math.floor(since / 1000)}`, "--format=%at"], { cwd: root, timeoutMs: 6000 });
          const l = await run(["git", "log", "-1", "--all", "--format=%at"], { cwd: root, timeoutMs: 4000 });
          const weeks = new Array(WEEKS).fill(0);
          for (const s of r.out.split("\n")) { const t = Number(s) * 1000; if (!t) continue; const w = Math.floor((now() - t) / (7 * DAY)); if (w >= 0 && w < WEEKS) weeks[WEEKS - 1 - w]++; }
          gitWeeks[p] = { at: now(), weeks, last: Number(l.out.trim()) * 1000 || undefined };
        }));
      }
      try { writeFileSync(indexFile, JSON.stringify(gitWeeks)); } catch {}
    })().finally(() => { weeksJob = undefined; });
    return weeksJob;
  }

  async function index(opts: { wait?: number } = {}) {
    const { readdirSync } = await import("node:fs");
    const { frontmatter } = await import("./journey-sources");
    const out = new Map<string, any>();
    const ensure = (p: string) => { let x = out.get(p); if (!x) { x = { project: p, sessions: 0, live: 0, working: 0, weeks: new Array(WEEKS).fill(0) }; out.set(p, x); } return x; };
    let files: string[] = [];
    try { files = readdirSync(`${paths.wikiDir}/projects`).filter((f) => f.endsWith(".md")); } catch {}
    await Promise.all(files.map(async (f) => {
      const p = f.slice(0, -3);
      const text = await Bun.file(`${paths.wikiDir}/projects/${f}`).text().catch(() => "");
      const { data, body } = frontmatter(text);
      const x = ensure(p);
      x.status = data.status; x.tags = Array.isArray(data.tags) ? data.tags.slice(0, 6) : []; x.updated = Date.parse(String(data.date_updated ?? "")) || undefined;
      x.tldr = clip((body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "").replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1").replace(/[*_`]/g, ""), 160);
      x.wiki = true;
    }));
    for (const h of deps.historyProjects?.() ?? []) { if (h.n < 2 && !out.has(h.project)) continue; const x = ensure(h.project); x.sessions = h.n; x.last = Math.max(x.last ?? 0, h.last ?? 0); }
    const since = now() - WEEKS * 7 * DAY;
    for (const w of deps.local?.weeks(since) ?? []) { const x = out.get(w.project); if (x && w.week >= 0 && w.week < WEEKS) x.weeks[WEEKS - 1 - w.week] += w.n; }
    for (const s of deps.live()) { if (!s.project) continue; const x = ensure(s.project); x.live++; if (s.status === "working") x.working++; x.last = Math.max(x.last ?? 0, s.last ?? 0); }
    let dirs: string[] = [];
    try { dirs = readdirSync(paths.projectsDir).filter((d) => !d.startsWith(".") && existsSync(`${paths.projectsDir}/${d}/.git`)); } catch {}
    for (const d of dirs) ensure(d).root = `${paths.projectsDir}/${d}`;
    const job = refreshGitWeeks([...out.values()].filter((x) => x.root).map((x) => [x.project, x.root]));
    if (opts.wait) await Promise.race([job, Bun.sleep(opts.wait)]);
    for (const x of out.values()) {
      const g = gitWeeks[x.project];
      if (g) { x.commitWeeks = g.weeks; x.last = Math.max(x.last ?? 0, g.last ?? 0); }
      x.last = Math.max(x.last ?? 0, x.updated ?? 0) || undefined;
      const c = mem.get(x.project) ?? (existsSync(fileOf(x.project)) ? load(x.project) : undefined);
      const j = c?.journey;
      if (j) {
        const next = j.milestones.find((m) => m.id === j.next[0]) ?? j.milestones.find((m) => m.state !== "unlocked");
        x.stage = j.stage?.title; x.next = next ? { title: next.title, pct: next.pct ?? 0 } : undefined; x.unlocked = j.counts.unlocked; x.milestones = j.counts.milestones; x.pitch = j.pitch;
        x.turns = j.turns.length; x.quests = j.quests.length;
      }
    }
    const list = [...out.values()].sort((a, b) => (b.working - a.working) || (b.live - a.live) || (b.last ?? 0) - (a.last ?? 0));
    return { projects: list, weeks: WEEKS, building: !!weeksJob };
  }

  async function handle(path: string, body: any): Promise<any> {
    const p = String(body?.project ?? "").trim();
    switch (path) {
      case "/api/journeys": return index({ wait: body?.wait ? 2500 : 0 });
      case "/api/journey": if (!p) throw new Error("Which project?"); return get(p, { refresh: !!body.refresh });
      case "/api/journey/regenerate": if (!p) throw new Error("Which project?"); await rebuild(p); startAi(p, true); return get(p, { noAi: true });
      case "/api/journey/metric": logMetric(p, body); return rebuild(p, { quick: true }).then(() => get(p, { noAi: true }));
      case "/api/journey/unlock": markUnlocked(p, body); return rebuild(p, { quick: true }).then(() => get(p, { noAi: true }));
      case "/api/journey/comparables": if (!p) throw new Error("Which project?"); return journeyComparables(load(p).journey ?? (await get(p, { noAi: true })));
    }
    return undefined;
  }

  return { get, rebuild, handle, index, logMetric, markUnlocked, seedLadder, startAi, stats, whenAiIdle: () => aiQueue, _cache: (p: string) => load(p) };
}
