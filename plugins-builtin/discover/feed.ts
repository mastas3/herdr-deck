// "Ideas for you" on Discover: an abundant, cached feed of ready-to-execute businesses, apps and services, made
// from your real inventory. Headless Claude writes them in batches (each call: two rows, ~12 ideas, seeded with
// different ingredient combinations so the set stays diverse); ideas stream in as each one completes, pass a quality
// gate (isExecutable: a specific customer, a real price, a buildable MVP on your inventory, a launch plan, a week of
// tasks, nothing generic), are de-duplicated by ingredient set and title, and are cached for the day. "More like
// this" asks for one row again; "More ideas" asks for the next batch. Templates only when no model answers at all.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dayOf, forYouIngredients, runClaude, templateMixes, type Ingredient } from "./mix";
import { buildCatalog, isExecutable, parseReply, planScore, type Build } from "./studio";
import { composeDice, FEED_BATCHES, FEED_ROWS, FEED_SYSTEM, feedPrompt, JUDGE_SYSTEM, judgePrompt, parseScores, rng } from "./studio-prompts";

const MAX_IDEAS = 300;
/** The critic scores 1 to 10; under this an idea leaves the feed (it is harsh: 5 means "maybe, with work"). */
const MIN_SCORE = 5;
const words = (s: string) => new Set(String(s ?? "").toLowerCase().replace(/human design/g, "hd").replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((w) => (w.length > 2 || w === "hd") && !STOP.has(w)).map((w) => w.replace(/(?<=..)s$/, "")));
const STOP = new Set(["the", "and", "for", "with", "your", "you", "from", "into", "that", "this", "app", "bot", "tool", "saas", "api", "service"]);
function jaccard(a: Set<string>, b: Set<string>) { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); }
/** Same ingredients (two or more, in any order), or a title that says nearly the same thing. */
export function isDuplicate(a: Build, b: Build): boolean {
  if (a.title.toLowerCase() === b.title.toLowerCase()) return true;
  const ka = [...a.ids].sort().join(","), kb = [...b.ids].sort().join(",");
  if (a.ids.length >= 2 && ka === kb) return true;
  const wa = words(a.title), wb = words(b.title);
  const t = jaccard(wa, wb), shared = [...wa].filter((w) => wb.has(w)).length;
  return t >= 0.6 || (shared >= 3 && t >= 0.45) || (t >= 0.34 && jaccard(words(`${a.title} ${a.pitch}`), words(`${b.title} ${b.pitch}`)) >= 0.6);
}
/** Starting combinations for a row: one per idea, different for every seed. */
export function seedCombos(all: Ingredient[], row: string, n: number, seed: number, seen = new Set<string>()): string[][] {
  const r = rng(seed * 7919 + row.length * 104729 + 1);
  const repos = all.filter((x) => x.kind === "repo" && x.ready).slice(0, 30);
  const out: string[][] = [];
  for (let i = 0; out.length < n && i < n * 6; i++) {
    const d = composeDice(all, Math.floor(r() * 1e9), row === "wild");
    if (!d) break;
    let names = d.parts.flatMap((p) => ("ing" in p ? [p.ing.name] : []));
    if (row === "gem" && !d.ids.some((id) => id.startsWith("r:")) && repos.length) names = [repos[Math.floor(r() * repos.length)].name, ...names.slice(0, 2)];
    const k = [...names].sort().join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(names);
  }
  return out;
}

export type FeedIdea = Build & { at: number; score?: number };
type Batch = { id: string; rows: string[]; perRow: number; started: number; finished?: number; status: "running" | "done" | "error"; kept: number; dropped: number; error?: string; abort: AbortController };
type Store = { day?: string; at?: number; ideas: FeedIdea[]; model?: string; cursor: number; dropped: number; generated?: boolean; judged?: number; settled?: string };
/** The ideas feed's rows as a library question (what founders did for that kind of business). */
const FEED_Q: Record<string, string> = { money: "first paying customers small business pricing", saas: "saas first customers pricing", automations: "automation agency first clients",
  content: "content creator audience monetization", projects: "side project first revenue", gem: "open source project monetization", weekend: "simple app built in a weekend first revenue", wild: "unusual niche business first customers" };
export const feedQuery = (rows: string[]) => rows.map((r) => FEED_Q[r] ?? r).join(" ");
export type FeedDeps = {
  file: string;
  ingredients: (wait?: number) => Promise<Ingredient[]>;
  runClaude?: typeof runClaude; claudeAvailable?: () => boolean;
  timeoutMs?: number; now?: () => number;
  /** Where every idea is kept for good (the feed itself only holds today). */
  archive?: { put: (idea: any) => void; score: (id: string, score: number, dropped: boolean) => void };
  /** Founder Library evidence for a batch (what real founders did), or "" (the library plugin, plugins-builtin/library). */
  evidence?: (rows: string[]) => Promise<string>;
};

export function createFeed(deps: FeedDeps) {
  const TEST = process.env.NODE_ENV === "test";
  const rc = deps.runClaude ?? (TEST ? async () => { throw new Error("no model in tests"); } : runClaude);
  const hasClaude = deps.claudeAvailable ?? (() => !TEST);
  const now = deps.now ?? Date.now;
  const TIMEOUT = deps.timeoutMs ?? 240_000;
  let store: Store = { ideas: [], cursor: 0, dropped: 0 };
  try { store = { ...store, ...JSON.parse(readFileSync(deps.file, "utf8")) }; } catch {}
  let saveT: ReturnType<typeof setTimeout> | undefined;
  const flush = () => { clearTimeout(saveT); try { mkdirSync(deps.file.replace(/\/[^/]+$/, ""), { recursive: true }); const tmp = `${deps.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(store)); renameSync(tmp, deps.file); } catch {} };
  const save = () => { clearTimeout(saveT); saveT = setTimeout(flush, 400); };
  const batches = new Map<string, Batch>();
  const running = () => [...batches.values()].filter((b) => b.status === "running");

  /** Ideas that pass the gate and aren't already in the feed join it (the row a model named, else the batch's emptiest row). */
  function admit(b: Batch, got: Build[], counted: Set<string>) {
    for (const x of got) {
      if (counted.has(x.id)) continue;
      counted.add(x.id);
      if (!isExecutable(x)) { b.dropped++; store.dropped++; continue; }
      if (store.ideas.some((y) => isDuplicate(x, y))) { b.dropped++; continue; }
      const count = (row: string) => store.ideas.filter((y) => y.row === row).length;
      const row = x.row && b.rows.includes(x.row) ? x.row : [...b.rows].sort((p, q) => count(p) - count(q))[0];
      store.ideas.push({ ...x, row, at: now() });
      deps.archive?.put({ ...x, row, source: x.source ?? "feed" });
      b.kept++;
    }
    if (store.ideas.length > MAX_IDEAS) store.ideas = store.ideas.slice(-MAX_IDEAS);
    save();
  }

  async function runBatch(rows: string[], perRow: number) {
    const all = await deps.ingredients(8000);
    const b: Batch = { id: crypto.randomUUID().slice(0, 8), rows, perRow, started: now(), status: "running", kept: 0, dropped: 0, abort: new AbortController() };
    batches.set(b.id, b);
    const seed = Math.floor(Math.random() * 1e9);
    const seen = new Set<string>();
    const combos = rows.flatMap((r, i) => seedCombos(all, r, perRow, seed + i, seen));
    const rowDefs = FEED_ROWS.filter((r) => rows.includes(r.id));
    const counted = new Set<string>();
    let last = 0;
    const timer = setTimeout(() => b.abort.abort(), TIMEOUT);
    try {
      const ev = deps.evidence ? await deps.evidence(rows).catch(() => "") : "";
      const r = await rc({
        system: `${FEED_SYSTEM}\n\n${buildCatalog(all)}${ev ? `\n\n${ev}\nLet this evidence shape prices and launch channels; don't copy these businesses.` : ""}`, user: feedPrompt(rowDefs, perRow, combos, store.ideas.map((x) => x.title)),
        timeoutMs: TIMEOUT, signal: b.abort.signal, model: "haiku",
        onText: (t) => { if (now() - last < 400) return; last = now(); admit(b, parseReply(t, all, { source: "claude" }).blocks.flatMap((x) => (x.t === "build" ? [x.b] : [])), counted); },
      });
      store.model = r.model;
      admit(b, parseReply(r.text, all, { final: true, source: "claude" }).blocks.flatMap((x) => (x.t === "build" ? [x.b] : [])), counted);
      b.status = "done";
      if (!b.kept && !b.dropped) { b.status = "error"; b.error = "The model's answer couldn't be read"; console.warn(`feed: batch ${rows.join("+")} parsed nothing; the answer began: ${r.text.slice(0, 400).replace(/\s+/g, " ")}`); }
    } catch (e: any) {
      b.status = b.kept ? "done" : "error";
      b.error = b.abort.signal.aborted ? "took too long" : e?.message ?? String(e);
    } finally { clearTimeout(timer); b.finished = now(); }
    store.at = now();
    store.generated = store.generated || b.kept > 0;
    // Last resort: nothing from any model at all, so quick template ideas stand in (clearly marked).
    if (!running().length && !store.ideas.length) fillTemplates(all);
    if (!running().length) { store.settled = dayOf(now()); judge().catch(() => {}); }
    save();
    for (const [k, x] of batches) if (x.status !== "running" && now() - (x.finished ?? x.started) > 30 * 60_000) batches.delete(k);
  }
  /** The second pass: one cheap call scores every idea not scored yet; the weak ones leave the feed, the rest are ranked by it. */
  let judging = false;
  async function judge() {
    const todo = store.ideas.filter((x) => x.score == null && x.source !== "template").slice(-60);
    if (judging || !todo.length) return;
    judging = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    try {
      const r = await rc({ system: JUDGE_SYSTEM, user: judgePrompt(todo), timeoutMs: 120_000, signal: abort.signal, model: "haiku", onText: () => {} });
      const scores = parseScores(r.text);
      if (!scores.size) return;
      todo.forEach((x, i) => { const s = scores.get(i + 1); if (s != null) x.score = s; });
      const weak = new Set(todo.filter((x) => (x.score ?? 10) < MIN_SCORE).map((x) => x.id));
      for (const x of todo) if (x.score != null) deps.archive?.score(x.id, x.score, weak.has(x.id));
      store.ideas = store.ideas.filter((x) => !weak.has(x.id));
      store.dropped += weak.size;
      store.judged = (store.judged ?? 0) + scores.size;
      save();
    } catch {} finally { clearTimeout(timer); judging = false; }
  }
  function fillTemplates(all: Ingredient[]) {
    const day = Math.floor(now() / 86_400_000);
    const mixes = templateMixes(forYouIngredients(all, day), "", day, 8);
    mixes.forEach((m, i) => store.ideas.push({ ...m, extra: [], row: FEED_ROWS[i % FEED_ROWS.length].id, at: now() }));
  }

  function start(rows: string[], perRow: number) {
    if (!hasClaude()) {
      if (!store.ideas.length) deps.ingredients(2500).then((all) => { fillTemplates(all); save(); }).catch(() => {});
      return;
    }
    runBatch(rows, perRow).catch(() => {});
  }

  return {
    /** The first view of the day: the six batches (about 72 ideas before the critic), in parallel. Only when Discover opens. */
    ensure() {
      const today = dayOf(now());
      if (running().length || (store.day === today && store.settled === today)) return;
      // A new day starts fresh; a run a restart cut short (same day, never settled) just goes again.
      if (store.day !== today) store = { day: today, at: now(), ideas: store.ideas.filter((x) => x.source !== "template").slice(-60), cursor: 0, dropped: 0, model: store.model };
      // Yesterday's best stay visible until today's arrive; new ones go first.
      for (const rows of FEED_BATCHES) start(rows, 6);
      store.cursor = FEED_BATCHES.length;
      save();
    },
    /** "More like this" (one row, 8 ideas) or "More ideas" (the next pair of rows, 6 each). At most three batches at a time. */
    more(row?: string) {
      if (running().length >= FEED_BATCHES.length + 1) return;
      if (row && FEED_ROWS.some((r) => r.id === row)) { start([row], 8); return; }
      const pair = FEED_BATCHES[store.cursor % FEED_BATCHES.length];
      store.cursor++;
      start(pair, 6);
    },
    refresh() { if (running().length) return; store.day = undefined; store.ideas = []; this.ensure(); },
    state() {
      const rows = FEED_ROWS.map((r) => ({
        ...r,
        ideas: store.ideas.filter((x) => x.row === r.id)
          .sort((a, b) => (b.score ?? 6.5) - (a.score ?? 6.5) || planScore(b) - planScore(a) || b.at - a.at),
        pending: running().filter((b) => b.rows.includes(r.id)).length,
      }));
      return {
        rows, total: store.ideas.length, day: store.day, at: store.at, model: store.model, generated: !!store.generated, dropped: store.dropped, judging, judged: store.judged ?? 0,
        running: running().map((b) => ({ rows: b.rows, kept: b.kept, elapsed: now() - b.started })),
        errors: [...batches.values()].filter((b) => b.status === "error").map((b) => b.error).slice(-3),
      };
    },
    flush, _store: () => store, _batches: batches,
  };
}
export type Feed = ReturnType<typeof createFeed>;
