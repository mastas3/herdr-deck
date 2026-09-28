// Discover keeps a small set of problem leads and a shared evidence notebook.
// Opening is passive; only an explicit search collects public posts and asks Claude for suggestions.
// Legacy generation remains available to the idea lab. Saved and reviewed cards retain their snapshots.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createIdeasRoutes, type IdeasDeps } from "./ideagen/routes";
import { cachedProblems, PROBLEM_VERSION } from "./ideagen/problem-gallery";
import { createDiscoverEvidence, discoverProof, evidenceLanes } from "./discover-evidence";
import type { createOpportunities } from "./opportunities";
import { cachedGallery, targetOf } from "./ideagen/gallery";
import type { LibrarySearch } from "./ideagen/library";
import { comparablesFor, shareLibrary, type Comparables, type Target } from "./library-strategy";
import { cardLines } from "./library-search";
import type { Library } from "./library";
import { buildInventory } from "./ideagen/inventory";
import { gatherPains } from "./ideagen/evidence";
import { gatherTrends, type TrendSet } from "./ideagen/trends";
import { budgetedClaude, budgetedJev, createBudget, type ClaudeRunner, type JevRunner } from "./ideagen/llm";
import type { Gallery, IdeaCard, Inventory, PainCorpus, StrategyId } from "./ideagen/types";
import type { IdeaArchive } from "./idea-archive";
import type { GhRes } from "./discover";
import { coverIdOf } from "./covers";

const DAY = 86_400_000;
export type Job = {
  day: string; status: "running" | "done" | "error"; startedAt: number; finishedAt?: number; attempts: number;
  phase: "inputs" | "evidence" | "trends" | "writing" | "judging" | "premortem" | "cards" | "done";
  step?: string; done: number; total: number; error?: string; ideas?: number; calls: { claude: number; jev: number };
};
export type GalleryServerDeps = {
  dir: string; projectsDir: string; labFile?: string;
  /** The idea lab's finished kits (docs/idea-lab/kits/<slug>/kit.json): the lab's cards open with them already built. */
  labKits?: string;
  archive?: Pick<IdeaArchive, "put" | "score">;
  /** Inventory inputs: the connections scan's sections, wiki projects, Discover's gem repos, the Leads cache entries. */
  sections: () => Promise<any[]>; projects: () => Promise<any[]>; gems: () => any[]; recs?: () => any[];
  leadsCache?: () => Record<string, any>;
  gh: (args: string[], t?: number) => Promise<GhRes>;
  claudeMax?: number; jevMax?: number; recipe?: [StrategyId, number][]; premortems?: number; rubric?: boolean;
  /** The deck's Founder Library: evidence for pre-mortems, and comparable founders for pre-mortems, kits and the idea panel. */
  library?: Pick<Library, "evidence" | "cards">;
  /** Tests: comparables without a library. */
  comparables?: (t: Target) => Comparables | undefined;
  /** Tests: the raw model calls (still budgeted and cached by prompt), inputs and the clock. */
  claudeRaw?: Parameters<typeof budgetedClaude>[1]; jevRaw?: Parameters<typeof budgetedJev>[1]; corpus?: () => Promise<PainCorpus>; trends?: () => Promise<TrendSet | undefined>;
  evidenceFirst?: boolean; evidenceStore?: ReturnType<typeof createOpportunities>;
  now?: () => number; log?: (s: string) => void;
};
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
function writeJson(f: string, v: unknown) { const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, f); }
export const dayOf = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** What a lane card needs (the full card comes with /api/ideas/card): small enough to send 150 of them at once. */
export function liteCard(c: IdeaCard) {
  return {
    id: c.id, coverId: coverIdOf(c.id), title: c.name, pitch: c.hook, name: c.name, hook: c.hook, buyer: c.buyer, price: c.price,
    timeToFirstDollarDays: c.timeToFirstDollarDays, difficulty: c.difficulty, quality: c.quality, jevP10: c.jevP10, evidenceScore: c.evidenceScore,
    strategy: c.strategy, topics: c.topics, ownedRatio: c.ownedRatio, patterns: c.patterns,
    owned: c.stack.filter((s) => s.owned).map((s) => s.name).slice(0, 4), missing: c.missing.map((m) => m.label).slice(0, 3),
    trend: c.trend ? { label: c.trend.label, heat: c.trend.heat } : undefined, pivoted: !!c.premortem?.pivotedFrom,
  };
}
export const fullCard = (c: IdeaCard) => ({ ...c, coverId: coverIdOf(c.id), title: c.name, pitch: c.hook });
/** What the idea panel's "What similar founders did" shows. */
export const comparablesView = (r: Comparables | undefined) => (r ? { items: r.comparables, summary: r.summary, checks: r.checks } : undefined);

export function createGalleryServer(d: GalleryServerDeps) {
  const now = d.now ?? Date.now;
  const evidenceFirst = d.evidenceFirst !== false;
  const notebook = d.evidenceStore && createDiscoverEvidence(d.evidenceStore, now);
  const currentGallery = () => evidenceFirst ? cachedProblems(d.dir, today()) : cachedGallery(d.dir, today());
  const today = () => dayOf(now());
  const log = d.log ?? ((s: string) => console.log(`gallery: ${s}`));
  mkdirSync(d.dir, { recursive: true });
  const JOB = `${d.dir}/job.json`, SAVED = `${d.dir}/saved.json`, PLAYING = `${d.dir}/playing.json`, TRACKED = `${d.dir}/tracked.json`;
  let job: Job | undefined = readJson(JOB);
  if (d.labKits && existsSync(d.labKits)) {
    mkdirSync(`${d.dir}/kits`, { recursive: true });
    for (const slug of readdirSync(d.labKits)) {
      const k = readJson(`${d.labKits}/${slug}/kit.json`);
      const f = k?.ideaId && `${d.dir}/kits/${String(k.ideaId).replace(/[^\w.-]+/g, "_")}.json`;
      if (f && !existsSync(f)) writeFileSync(f, JSON.stringify(k));
    }
  }
  let active: Promise<void> | undefined;
  const saveJob = () => { if (job) writeJson(JOB, job); };

  // ── model runners: budgeted per day, counted for the progress line ──
  let bud: { day: string; claude: ClaudeRunner; jev: JevRunner } | undefined;
  function runners() {
    if (bud?.day === today()) return bud;
    const b = createBudget({ file: `${d.dir}/ledger-${today()}.json`, claudeMax: d.claudeMax ?? 30, jevMax: d.jevMax ?? 150, cacheDir: `${d.dir}/replies` });
    return (bud = { day: today(), claude: budgetedClaude(b, d.claudeRaw), jev: budgetedJev(b, d.jevRaw) });
  }
  const PHASE: [RegExp, Job["phase"]][] = [[/^gallery:/, "writing"], [/^gallery-(?:p10|generic|rubric|patterns)/, "judging"], [/^gallery-premortem/, "premortem"]];
  function track(kind: "claude" | "jev", tag: string, end: boolean) {
    if (!job || job.status !== "running") return;
    const ph = PHASE.find(([re]) => re.test(tag))?.[1];
    if (!ph) return;
    if (!end && ph !== job.phase && ["writing", "judging", "premortem"].indexOf(ph) > ["writing", "judging", "premortem"].indexOf(job.phase)) { job.phase = ph; job.done = 0; job.total = 0; }
    if (end) { job.calls[kind]++; if (ph === job.phase) job.done++; } else if (ph === job.phase && ph !== "writing") job.total++;
    saveJob();
  }
  const claude: ClaudeRunner = async (o) => { track("claude", o.tag, false); try { return await runners().claude(o); } finally { track("claude", o.tag, true); } };
  const jev: JevRunner = async (s, q, k, tag) => { track("jev", tag, false); try { return await runners().jev(s, q, k, tag); } finally { track("jev", tag, true); } };

  // ── today's inputs, snapshotted so a resumed run asks the same questions ──
  let inv: { day: string; v: Inventory } | undefined;
  async function inventory(): Promise<Inventory> {
    if (inv?.day === today()) return inv.v;
    const f = `${d.dir}/inventory-${today()}.json`;
    let v: Inventory | undefined = readJson(f);
    if (!v) {
      const [sections, projects] = await Promise.all([d.sections().catch(() => []), d.projects().catch(() => [])]);
      v = buildInventory({ sections, projects, gems: d.gems(), recs: d.recs?.() ?? [] });
      writeJson(f, v);
    }
    return (inv = { day: today(), v }).v;
  }
  /** Public posts where each reachable audience says what hurts: kept a week, gathered one audience at a time (resumable). */
  async function corpus(): Promise<PainCorpus> {
    if (d.corpus) return d.corpus();
    const f = `${d.dir}/pains.json`, part = `${d.dir}/pains-partial.json`;
    const c: PainCorpus | undefined = readJson(f);
    if (c?.posts?.length && now() - c.at < 7 * DAY) return c;
    const auds = (await inventory()).audiences;
    const acc: PainCorpus = readJson(part) ?? { at: now(), posts: [], themes: [], queries: [] };
    for (const [i, au] of auds.entries()) {
      if (acc.queries.some((q) => q.audience === au.id)) continue;
      if (job?.status === "running") { job.step = au.label; job.done = i; job.total = auds.length; saveJob(); }
      const got = await gatherPains([au], { cached: d.leadsCache?.() ?? {}, log: (s) => log(`pains ${s}`) }).catch(() => undefined);
      if (!got) continue;
      for (const p of got.posts) if (!acc.posts.some((x) => x.id === p.id)) acc.posts.push(p);
      acc.themes.push(...got.themes); acc.queries.push(...got.queries);
      writeJson(part, acc);
    }
    const out = { ...acc, at: now() };
    // An empty corpus (offline) isn't kept: the next run tries again; a stale one beats none.
    if (out.posts.length) { writeJson(f, out); rmSync(part, { force: true }); return out; }
    return c ?? out;
  }
  async function trends(): Promise<TrendSet | undefined> {
    if (d.trends) return d.trends();
    const f = `${d.dir}/trends-${today()}.json`;
    const hit = readJson(f);
    if (hit) return hit;
    const t = await gatherTrends({ log: (s) => log(`trends ${s}`) }).catch(() => undefined);
    if (t?.signals.length) writeJson(f, t);
    return t;
  }

  // ── the archive: what's shown is kept, under the id covers.ts paints it by ──
  const archive = d.archive && {
    put: (x: any) => d.archive!.put({ ...x, id: coverIdOf(x.id), ideaId: x.id, title: x.title ?? x.name, pitch: x.pitch ?? x.hook }),
    score: (id: string, s: number, dropped: boolean) => d.archive!.score(coverIdOf(id), s, dropped),
  };
  const archived = new Set<string>();
  function archiveCards(g: Gallery) {
    const key = `${g.day}:${g.at}:${Object.keys(g.ideas).length}`;
    if (!archive || archived.has(key)) return;
    archived.add(key);
    for (const c of Object.values(g.ideas)) if (c.quality > 0) { archive.put({ ...c, source: "gallery", row: c.strategy }); archive.score(c.id, c.quality, false); }
  }

  // ── the Founder Library: founder cards as pre-mortem evidence, and comparables ──
  const comparables = d.comparables ?? (d.library ? (t: Target) => comparablesFor(t) : undefined);
  const library: LibrarySearch | undefined = d.library && (async (q, k) => (await d.library!.evidence(q, k, "ideas")).answers.filter((a) => a.card).slice(0, k)
    .map((a) => ({ text: cardLines({ ...a.card!, date: a.card!.date ?? a.date }), source: "founder library", url: a.url, title: a.title })));

  const ideas = createIdeasRoutes({
    cacheDir: d.dir, projectsDir: d.projectsDir, inventory, corpus, trends, claude, jev, gh: d.gh, archive, library, comparables,
    recipe: d.recipe, premortems: d.premortems, rubric: d.rubric, evidenceFirst, now, card: (id) => cardAnywhere(id),
  } satisfies IdeasDeps);

  // ── what the page shows: today's gallery, else the latest earlier one, else the lab's seed ──
  let lab: { mtime: number; g?: Gallery } | undefined;
  function labGallery(): Gallery | undefined {
    if (!d.labFile || !existsSync(d.labFile)) return undefined;
    const m = statSync(d.labFile).mtimeMs;
    if (lab?.mtime !== m) lab = { mtime: m, g: readJson(d.labFile) };
    return lab.g;
  }
  const galleryFiles = () => readdirSync(d.dir).filter((f) => /^gallery-(?:evidence-)?\d{4}-\d\d-\d\d\.json$/.test(f)).sort().reverse();
  function shown(): { g: Gallery; source: "today" | "earlier" | "lab" } | undefined {
    const t = currentGallery();
    if (t) return { g: t, source: "today" };
    const f = galleryFiles().filter(f => evidenceFirst || !f.includes("-evidence-"))[0];
    const e = f && readJson(`${d.dir}/${f}`);
    if (e) return { g: e, source: "earlier" };
    const l = labGallery();
    return l ? { g: l, source: "lab" } : undefined;
  }
  const saved = (): { card: IdeaCard; at: number }[] => readJson(SAVED) ?? [];
  const tracked = (): Record<string, IdeaCard> => readJson(TRACKED) ?? {};
  const playing = (): Record<string, { dir: string; slug: string; name: string; at: number }> => readJson(PLAYING) ?? {};
  function cardAnywhere(id: string): IdeaCard | undefined {
    return shown()?.g.ideas[id] ?? saved().find((s) => s.card.id === id)?.card
      ?? tracked()[id] ?? galleryFiles().slice(0, 7).map((f) => readJson(`${d.dir}/${f}`)?.ideas?.[id]).find(Boolean) ?? labGallery()?.ideas[id];
  }

  // ── the daily run ──
  function run(force = false): Promise<void> {
    if (active) return active;
    const day = today();
    job = { day, status: "running", startedAt: now(), attempts: job?.day === day ? job.attempts + 1 : 1, phase: "inputs", done: 0, total: 0, calls: { claude: 0, jev: 0 } };
    saveJob();
    active = (async () => {
      try {
        await inventory();
        job!.phase = "evidence"; saveJob();
        await corpus();
        if (!evidenceFirst) { job!.phase = "trends"; job!.step = undefined; saveJob(); await trends(); }
        job!.phase = "writing"; job!.done = 0; job!.total = evidenceFirst ? 1 : (d.recipe?.length ?? 7); saveJob();
        const g = await ideas.generate(force);
        // Nothing passed (no model answered, or everything was gated): don't let an empty day hide the earlier cards.
        if (!evidenceFirst && !Object.keys(g.ideas).length) { rmSync(`${d.dir}/gallery-${day}.json`, { force: true }); throw new Error(job!.calls.claude ? "no idea passed the quality gate today; check that Claude Code answers (claude -p)" : "no idea was written today"); }
        archiveCards(g);
        Object.assign(job!, { status: "done", phase: "done", finishedAt: now(), ideas: Object.keys(g.ideas).length, error: undefined });
        log(`${g.stats.ideas} ideas in ${g.lanes.length} lanes (${Math.round((now() - job!.startedAt) / 1000)} s, ${job!.calls.claude} Claude + ${job!.calls.jev} Jev calls)`);
      } catch (e: any) {
        Object.assign(job!, { status: "error", finishedAt: now(), error: String(e?.message ?? e).slice(0, 240) });
        log(`failed: ${job!.error}`);
      } finally { saveJob(); active = undefined; pruneOld(); }
    })();
    return active;
  }
  /** Discover opened: today's run starts if it hasn't (a failed one gets one more try after ten minutes). */
  function ensure() {
    if (evidenceFirst || active || currentGallery()) return;
    if (job?.day === today() && job.status === "error" && (job.attempts >= 2 || now() - (job.finishedAt ?? 0) < 10 * 60_000)) return;
    run();
  }
  /** Old days' files go after two weeks (galleries after a month, so a saved card's lane context stays a while). */
  function pruneOld() {
    try {
      for (const f of readdirSync(d.dir)) {
        const m = f.match(/-(\d{4}-\d\d-\d\d)\.json$/);
        if (m && now() - Date.parse(m[1]) > (f.startsWith("gallery-") ? 31 : 14) * DAY) rmSync(`${d.dir}/${f}`, { force: true });
      }
      if (existsSync(`${d.dir}/replies`)) for (const f of readdirSync(`${d.dir}/replies`)) if (now() - statSync(`${d.dir}/replies/${f}`).mtimeMs > 14 * DAY) rmSync(`${d.dir}/replies/${f}`, { force: true });
    } catch {}
  }

  function proof(c: IdeaCard) { return notebook?.proof(c) ?? discoverProof(undefined, now()); }
  function view(c: IdeaCard, full = false) {
    const out: any = full ? fullCard(c) : liteCard(c);
    if (!evidenceFirst) return out;
    for (const key of ["quality", "jevP10", "evidenceScore", "rubric", "patterns", "timeToFirstDollarDays"]) delete out[key];
    const record = notebook?.lookup(c);
    if (record) Object.assign(out, { name: record.title, title: record.title, hook: record.summary, pitch: record.summary, buyer: record.buyer, pain: record.problem, offer: record.outcome, mvp: record.mechanism });
    return { ...out, origin: c.origin, proof: discoverProof(record, now()), sourceExcerpt: c.origin === "problem-first" ? c.evidence[0]?.snippet : undefined, unknowns: c.unknowns };
  }
  function state() {
    const s = shown();
    if (s && !evidenceFirst) archiveCards(s.g);
    const kits = existsSync(`${d.dir}/kits`) ? readdirSync(`${d.dir}/kits`).map((f) => f.replace(/\.json$/, "")) : [];
    const cards = Object.values(s?.g.ideas ?? {}).filter(c => evidenceFirst || c.quality > 0);
    // Keep earlier ideas accessible when a new, deliberately small set replaces today's old gallery.
    if (evidenceFirst && s?.g.version === PROBLEM_VERSION) {
      const earlier = galleryFiles().filter(f => !f.includes("-evidence-")).slice(0, 1).map(f => readJson(`${d.dir}/${f}`))[0] ?? labGallery();
      for (const c of Object.values<IdeaCard>(earlier?.ideas ?? {})) if (!cards.some(x => x.id === c.id)) cards.push(c);
    }
    for (const card of [...saved().map(x => x.card), ...Object.values(tracked())]) if (!cards.some(c => c.id === card.id)) cards.push(card);
    const lanes = evidenceFirst ? evidenceLanes(cards.map(c => ({ ...c, proof: proof(c) }))) : s?.g.lanes ?? [];
    return {
      day: today(), source: s?.source ?? "none", galleryDay: s?.g.day, at: s?.g.at, evidenceFirst,
      lanes, ideas: Object.fromEntries(cards.map(c => [c.id, view(c)])),
      saved: saved().map(x => view(x.card)), playing: playing(), kits,
      note: s?.g.version === PROBLEM_VERSION ? s.g.stats.note : undefined,
      coverage: evidenceFirst ? (readJson(`${d.dir}/pains.json`)?.queries ?? []).filter((q: any) => q.errors?.length).map((q: any) => ({ audience: q.text, errors: q.errors })) : [],
      job: job ? { ...job, running: !!active, ...(evidenceFirst && job.status === "running" && !active ? { status: "error", error: "Previous search was interrupted. Start a new search when ready." } : {}) } : undefined,
    };
  }
  async function handle(path: string, body: any): Promise<unknown> {
    switch (path) {
      case "/api/ideas/state": if (!evidenceFirst && body?.ensure) ensure(); return state();
      case "/api/ideas": {
        if (evidenceFirst && body?.consent !== true) throw new Error("Confirm searching public problem reports and sending excerpts to the configured model.");
        run(!!body?.force); return state();
      }
      case "/api/ideas/dossier": {
        const card = cardAnywhere(String(body?.id ?? ""));
        if (!card || !notebook) throw new Error("The evidence notebook is unavailable for this idea");
        const item = notebook.open(card);
        // A reviewed card must survive daily gallery replacement and cache pruning.
        const kept = tracked();
        if (!kept[card.id]) writeJson(TRACKED, { ...kept, [card.id]: card });
        return { id: item.id };
      }
      case "/api/ideas/card": {
        const c = cardAnywhere(String(body?.id ?? ""));
        if (!c) throw new Error("That idea isn't in the gallery any more");
        return { ...view(c, true), comparables: comparablesView(comparables?.(targetOf(c))) };
      }
      case "/api/ideas/save": {
        const c = cardAnywhere(String(body?.id ?? ""));
        const rest = saved().filter((x) => x.card.id !== body?.id);
        if (body?.op === "unsave") writeJson(SAVED, rest);
        else if (c) writeJson(SAVED, [{ card: c, at: now() }, ...rest].slice(0, 200));
        else throw new Error("That idea isn't in the gallery any more");
        return { saved: saved().map((x) => view(x.card)) };
      }
      case "/api/ideas/more": { const g = (await ideas.handle(path, body)) as Gallery; archiveCards(g); return state(); }
      case "/api/ideas/play": {
        const r: any = await ideas.handle(path, body);
        if (!r.preview) writeJson(PLAYING, { ...playing(), [r.id]: { dir: r.dir, slug: r.slug, name: r.name, at: now() } });
        return r;
      }
    }
    return path.startsWith("/api/ideas") ? ideas.handle(path, body) : undefined;
  }
  // A run the last process didn't finish (restart, crash) picks up where its cached replies left off.
  if (!evidenceFirst && job?.status === "running" && job.day === today() && !currentGallery()) { log("resuming today's run"); run(); }
  return { handle, ensure, run, state, cardAnywhere, whenIdle: () => active ?? Promise.resolve(), _job: () => job };
}
export type GalleryServer = ReturnType<typeof createGalleryServer>;

/** "C-audience:6,B-pain:6" → the recipe (DECK_GALLERY_RECIPE: a smaller day, e.g. to try it out cheaply). */
export function parseRecipe(s?: string): [StrategyId, number][] | undefined {
  const r = String(s ?? "").split(",").map((x) => x.trim().split(":")).filter(([k, n]) => /^[A-Z]\d?-[\w-]+$/.test(k ?? "") && Number(n) > 0).map(([k, n]) => [k as StrategyId, Math.min(20, Number(n))] as [StrategyId, number]);
  return r.length ? r : undefined;
}
/** The server's wiring: Discover's data folder, archive, profile and gems; the connections scan; settings from the env. */
export function galleryForServer(s: { dataDir: string; discover: { archive: any; profile: () => Promise<{ projects: any[] }>; paths: { cache: string } }; connections: () => Promise<{ sections: { id: string; items: any[] }[] }>; gh: GalleryServerDeps["gh"]; recs: () => any[]; library?: Library; evidenceStore?: ReturnType<typeof createOpportunities> }) {
  const env = process.env;
  // The quest board, research, project pages and the Studio read comparables from the same library (library-strategy.ts).
  shareLibrary(s.library);
  const num = (v?: string) => (v && Number(v) >= 0 ? Number(v) : undefined);
  return createGalleryServer({
    dir: env.DECK_GALLERY_DIR || `${s.dataDir}/gallery`,
    projectsDir: env.DECK_PROJECTS_DIR || `${homedir()}/Documents/Projects`,
    labFile: env.DECK_GALLERY_SEED ?? new URL("../docs/idea-lab/gallery.json", import.meta.url).pathname,
    labKits: new URL("../docs/idea-lab/kits", import.meta.url).pathname,
    archive: s.discover.archive, evidenceStore: s.evidenceStore,
    sections: async () => (await s.connections()).sections.map((x) => ({ id: x.id, items: x.items.map(({ id, name, state, cat, kind, detail, hidden }: any) => ({ id, name, state, cat, kind, detail, hidden })) })),
    projects: async () => (await s.discover.profile()).projects,
    gems: () => { const c = readJson(s.discover.paths.cache) ?? {}; const all = Object.values<any>({ ...c.gems, ...c.trend }).flatMap((g) => g?.items ?? []); return all.filter((g, i) => all.findIndex((x) => x.full === g.full) === i); },
    recs: () => s.recs().map((r) => ({ id: r.id, name: r.name, url: r.url, free: r.free, what: r.what, cat: r.cat })),
    leadsCache: () => readJson(`${s.dataDir}/leads-cache.json`)?.entries ?? {},
    gh: s.gh,
    claudeMax: num(env.DECK_GALLERY_CLAUDE_MAX), jevMax: num(env.DECK_GALLERY_JEV_MAX), recipe: parseRecipe(env.DECK_GALLERY_RECIPE),
    premortems: num(env.DECK_GALLERY_PREMORTEMS), rubric: env.DECK_GALLERY_RUBRIC !== "0", library: s.library,
  });
}
