// The idea-generation experiment: generate ideas with each strategy, judge them all with the same scorecard, compare.
//   bun scripts/idea-experiment.ts gen --round 1 [--only B-pain,C-audience] [--n 12] [--version v1]
//   bun scripts/idea-experiment.ts judge --round 1          (evidence + Jev batches + Claude rubric)
//   bun scripts/idea-experiment.ts calibrate                (Jev: batched vs one-idea-per-call)
//   bun scripts/idea-experiment.ts tournament [--top 24] [--rounds 4]
//   bun scripts/idea-experiment.ts analyze                  (tables → docs/idea-lab/results.json + report.md auto section)
//   bun scripts/idea-experiment.ts gallery | kits
// Budgets: ≤40 Claude calls for generation+rubric (+10 for kits), ≤300 Jev calls. Replies are cached by prompt hash.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { _configure } from "../src/jev";
import type { Gem, Profile } from "../src/discover";
import { budgetedClaude, budgetedJev, createBudget, jevUsageFor } from "../src/ideagen/llm";
import { briefsFor, painClusters, seedOf } from "../src/ideagen/sampler";
import { baselineMixerPrompt, baselineTemplate, ideaPrompt, parseIdeas, parseMixerReply, STRATEGY_LABEL } from "../src/ideagen/strategies";
import { bootMedianDiff, elo, indexPosts, jevBatch, jevGenericBatch, jevPairs, matchEvidence, mean, median, quantile, rubricBatch, scoreIdea, spearman, superiority, swissPairs, type Match } from "../src/ideagen/judge";
import type { Brief, Idea, Inventory, PainCorpus, Rubric, Scores, StrategyId } from "../src/ideagen/types";

const HOME = homedir();
const LAB = `${import.meta.dir}/../docs/idea-lab`;
const DATA = `${LAB}/data`;
mkdirSync(`${LAB}/.cache`, { recursive: true });
_configure({ dir: `${LAB}/.jev` }); // the experiment's Jev counter/cache, apart from the live deck's
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k: string, d?: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const readJson = (p: string, d?: any) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p: string, v: any) => writeFileSync(p, JSON.stringify(v, null, 1));

const CLAUDE_MAX_EXPERIMENT = 40, CLAUDE_MAX_KITS = 10, JEV_MAX = 300;
const budget = createBudget({ file: `${LAB}/ledger.json`, claudeMax: CLAUDE_MAX_EXPERIMENT + CLAUDE_MAX_KITS, jevMax: JEV_MAX, cacheDir: `${LAB}/.cache` });
const nonKitCalls = () => budget.ledger.entries.filter((e) => e.kind === "claude" && !e.cached && !e.tag.startsWith("kit")).length;
const claudeRaw = budgetedClaude(budget);
const claude: typeof claudeRaw = async (o) => {
  if (!o.tag.startsWith("kit") && nonKitCalls() >= CLAUDE_MAX_EXPERIMENT) throw new Error(`experiment Claude budget used (${nonKitCalls()}/${CLAUDE_MAX_EXPERIMENT})`);
  if (o.tag.startsWith("kit") && budget.ledger.entries.filter((e) => e.kind === "claude" && !e.cached && e.tag.startsWith("kit")).length >= CLAUDE_MAX_KITS) throw new Error("kit Claude budget used");
  return claudeRaw(o);
};
const jev = budgetedJev(budget);

const inv: Inventory = readJson(`${DATA}/inventory.json`);
const corpus: PainCorpus = readJson(`${DATA}/pains.json`);
if (!inv || !corpus) throw new Error("Run bun scripts/idea-prep.ts first");
const clusters = painClusters(corpus, inv);
const trends = readJson(`${DATA}/trends.json`);
const postsById = new Map(corpus.posts.map((p) => [p.id, p]));
const ix = indexPosts(corpus.posts);

type Store = { ideas: Idea[]; briefs: Record<string, Brief>; runs: { round: number; strategy: StrategyId; version: string; calls: number; ms: number; costUsd: number; inTok: number; outTok: number; n: number; cached: boolean }[] };
type Judged = Record<string, { rubric?: Rubric; rubric2?: Rubric; jevP10?: number; jevShip?: number; jevSingleP10?: number; jevGeneric?: number; rubricRun?: string; rubric2Run?: string; jevRun?: string }>;
const STORE = `${LAB}/ideas.json`, JUDGED = `${LAB}/judgements.json`, MATCHES = `${LAB}/tournament.json`;
const store: Store = readJson(STORE, { ideas: [], briefs: {}, runs: [] });
const judged: Judged = readJson(JUDGED, {});
/** Ideas without the model's raw reply, briefs as ids and labels: small enough to commit, enough to reproduce. */
const compactBrief = (b: any) => ({ id: b.id, strategy: b.strategy, audience: b.audience?.id ?? b.audience, pain: b.pain?.id ?? b.pain, painQuotes: b.pain?.quotes?.map((q: any) => q.id) ?? b.painQuotes, engine: b.engine?.id ?? b.engine, gem: b.gem?.id ?? b.gem, model: b.model?.id ?? b.model, trend: b.trend?.id ?? b.trend, angle: b.angle, compat: b.compat, demand: b.demand });
const saveStore = () => writeJson(STORE, { ...store, ideas: store.ideas.map(({ raw, ...x }) => x), briefs: Object.fromEntries(Object.entries(store.briefs).map(([k, b]) => [k, compactBrief(b)])) });
const saveJudged = () => writeJson(JUDGED, judged);

function baselineInput() {
  const disc = readJson(`${HOME}/.config/herdr-deck/discover-cache.json`, {});
  const profile: Profile = disc.profile;
  const gems: Gem[] = [];
  for (const it of profile.interests ?? []) {
    const items = [...(disc.gems?.[it.id]?.items ?? [])].sort((a: any, b: any) => b.stars - a.stars).slice(0, 4);
    for (const r of items) if (!gems.some((g) => g.full === r.full)) gems.push({ ...r, score: r.stars, spm: 0, why: [{ id: it.id, label: it.label, projects: it.projects }] });
  }
  const items = (readJson(`${DATA}/connections.json`, []) as any[]).flatMap((s) => s.items ?? []);
  return { profile, gems, items };
}
async function pool<T, R>(xs: T[], k: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, xs.length) }, async () => { while (i < xs.length) { const j = i++; out[j] = await f(xs[j], j); } }));
  return out;
}

// ── gen ──────────────────────────────────────────────────────────────────────────────────
async function gen() {
  const round = Number(opt("round", "1"));
  const n = Number(opt("n", "12"));
  const version = (opt("version", "v1") as "v1" | "v2" | "v3" | "v4");
  const all: StrategyId[] = ["A0-template", "A1-mixer", "A2-random-schema", "B-pain", "C-audience", "D-asset", "E-remix", "F-gem", "G-constraint", "H-boring"];
  const only = opt("only")?.split(",") as StrategyId[] | undefined;
  const todo = (only ?? all).filter((s) => !store.runs.some((r) => r.round === round && r.strategy === s));
  const seed = seedOf(`round-${round}`) + Number(opt("seed", "0"));
  console.log(`round ${round} (${version}): ${todo.join(", ")}`);
  // --combine A,B: one Claude call for several strategies' briefs (each idea keeps its brief's strategy).
  const combine = opt("combine")?.split(",") as StrategyId[] | undefined;
  if (combine) {
    const t0 = Date.now();
    const briefs = combine.flatMap((st) => briefsFor(st, n, { inv, corpus, seed, clusters, trends }));
    for (const b of briefs) store.briefs[`r${round}:${b.id}`] = b;
    const p = ideaPrompt(briefs, inv, { version });
    const r = await claude({ system: p.system, user: p.user, model: "haiku", tag: `gen:r${round}:${combine.join("+")}` });
    const ideas = parseIdeas(r.text, briefs, combine[0], version, round, inv).map((x) => { const st = briefs.find((b) => b.id === x.briefId)?.strategy ?? x.strategy; return { ...x, strategy: st, id: x.id.replace(combine[0], st) }; });
    for (const st of combine) {
      const mine = ideas.filter((x) => x.strategy === st);
      store.ideas = [...store.ideas.filter((x) => !(x.round === round && x.strategy === st)), ...mine];
      store.runs.push({ round, strategy: st, version, n: mine.length, calls: r.cached ? 0 : 1 / combine.length, ms: r.ms / combine.length, costUsd: r.costUsd / combine.length, inTok: r.inTok / combine.length, outTok: r.outTok / combine.length, cached: r.cached });
    }
    saveStore();
    console.log(`  ${combine.join("+")}: ${ideas.length} ideas in ${((Date.now() - t0) / 1000).toFixed(1)}s ($${r.costUsd.toFixed(4)}); claude ${nonKitCalls()}/${CLAUDE_MAX_EXPERIMENT}`);
    return;
  }
  await pool(todo, 4, async (s) => {
    const t0 = Date.now();
    let ideas: Idea[] = [];
    let run = { calls: 0, ms: 0, costUsd: 0, inTok: 0, outTok: 0, cached: false };
    try {
      if (s === "A0-template") ideas = baselineTemplate(baselineInput(), inv, seed, n).map((x) => ({ ...x, round, id: x.id.replace(":1:", `:${round}:`) }));
      else if (s === "A1-mixer") {
        const bi = baselineInput();
        const p = baselineMixerPrompt(bi, seed, n);
        const r = await claude({ system: p.system, user: p.user, model: "haiku", tag: `gen:r${round}:${s}` });
        run = { calls: r.cached ? 0 : 1, ms: r.ms, costUsd: r.costUsd, inTok: r.inTok, outTok: r.outTok, cached: r.cached };
        ideas = parseMixerReply(r.text, p.ings, round, inv);
      } else {
        const briefs = briefsFor(s, n, { inv, corpus, seed, clusters, trends });
        for (const b of briefs) store.briefs[`r${round}:${b.id}`] = b;
        const p = ideaPrompt(briefs, inv, { version });
        const r = await claude({ system: p.system, user: p.user, model: "haiku", tag: `gen:r${round}:${s}` });
        run = { calls: r.cached ? 0 : 1, ms: r.ms, costUsd: r.costUsd, inTok: r.inTok, outTok: r.outTok, cached: r.cached };
        ideas = parseIdeas(r.text, briefs, s, version, round, inv);
        if (ideas.length < briefs.length * 0.6) writeFileSync(`${LAB}/.cache/bad-${s}-r${round}.txt`, r.text);
      }
    } catch (e: any) { console.log(`  ${s}: FAILED ${e?.message ?? e}`); return; }
    store.ideas = [...store.ideas.filter((x) => !(x.round === round && x.strategy === s)), ...ideas];
    store.runs.push({ round, strategy: s, version: s.startsWith("A0") ? "template" : s.startsWith("A1") ? "mixer" : version, n: ideas.length, ...run, ms: run.ms || Date.now() - t0 });
    saveStore();
    console.log(`  ${s}: ${ideas.length} ideas in ${((Date.now() - t0) / 1000).toFixed(1)}s ($${run.costUsd.toFixed(4)}, ${run.inTok}/${run.outTok} tok)`);
  });
  console.log(`claude calls so far: ${nonKitCalls()}/${CLAUDE_MAX_EXPERIMENT}, jev ${budget.ledger.jev.calls}/${JEV_MAX}`);
}

// ── judge ────────────────────────────────────────────────────────────────────────────────
function shuffle<T>(xs: T[], seed: number) { const a = [...xs]; let s = seed || 1; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function judge() {
  const round = Number(opt("round", "1"));
  const ideas = store.ideas.filter((x) => x.round === round);
  const needJev = ideas.filter((x) => judged[x.id]?.jevP10 == null);
  const needRub = args.includes("--no-rubric") ? [] : ideas.filter((x) => !judged[x.id]?.rubric);
  const jevSize = Number(opt("jev-batch", "4")), rubSize = Number(opt("rubric-batch", "15"));
  const jb = chunks(shuffle(needJev, round * 31), jevSize);
  const rb = chunks(shuffle(needRub, round * 17), rubSize);
  console.log(`round ${round}: ${ideas.length} ideas; Jev batches ${jb.length}, rubric batches ${rb.length}`);
  await Promise.all([
    pool(jb, 3, async (b, i) => {
      try {
        const r = await jevBatch(b, inv, jev, `jev:r${round}:${i}`);
        for (const [id, v] of r) { judged[id] = { ...judged[id], jevP10: v.p10, jevShip: v.ship, jevRun: `r${round}:${i}` }; }
        saveJudged();
      } catch (e: any) { console.log(`  jev batch ${i} failed: ${e?.message ?? e}`); }
    }),
    pool(rb, 3, async (b, i) => {
      try {
        const r = await rubricBatch(b, inv, claude, `rubric:r${round}:${i}`);
        for (const [id, v] of r.scores) judged[id] = { ...judged[id], rubric: v, rubricRun: `r${round}:${i}` };
        saveJudged();
        console.log(`  rubric ${i}: ${r.scores.size}/${b.length} scored ($${r.run.costUsd.toFixed(4)}, ${(r.run.ms / 1000).toFixed(1)}s)`);
      } catch (e: any) { console.log(`  rubric batch ${i} failed: ${e?.message ?? e}`); }
    }),
  ]);
  const missing = ideas.filter((x) => judged[x.id]?.jevP10 == null || (!judged[x.id]?.rubric && !args.includes("--no-rubric"))).length;
  console.log(`done; ${missing} ideas still missing a judge. claude ${nonKitCalls()}/${CLAUDE_MAX_EXPERIMENT}, jev ${budget.ledger.jev.calls}/${JEV_MAX}`);
}
const chunks = <T>(xs: T[], k: number) => Array.from({ length: Math.ceil(xs.length / k) }, (_, i) => xs.slice(i * k, i * k + k));

/** Jev's slop check ("would a sharp indie founder dismiss this as generic?") on every idea, 6 per call. */
async function slopjev() {
  const need = store.ideas.filter((x) => judged[x.id]?.jevGeneric == null);
  const bs = chunks(shuffle(need, 5), Number(opt("batch", "6")));
  console.log(`slop check: ${need.length} ideas in ${bs.length} Jev calls`);
  await pool(bs, 3, async (b, i) => {
    try { const r = await jevGenericBatch(b, inv, jev, `generic:${i}`); for (const [id, v] of r) judged[id] = { ...judged[id], jevGeneric: v }; saveJudged(); }
    catch (e: any) { console.log(`  batch ${i} failed: ${e?.message ?? e}`); }
  });
  console.log(`jev ${budget.ledger.jev.calls}/${JEV_MAX}`);
}
/**
 * The controlled comparison: rubric r2 (independent scoring + "generic") over a stratified sample of every earlier
 * strategy×round cell plus all ideas of the newest round, shuffled into mixed batches so no cell is judged in its own context.
 */
async function rejudge() {
  const per = Number(opt("per-cell", "3")), newest = Math.max(...store.ideas.map((x) => x.round));
  const cells = new Map<string, Idea[]>();
  for (const x of store.ideas) cells.set(`${x.round}|${x.strategy}`, [...(cells.get(`${x.round}|${x.strategy}`) ?? []), x]);
  const pick: Idea[] = [];
  for (const [k, xs] of cells) pick.push(...(Number(k.split("|")[0]) === newest ? xs : shuffle(xs, seedOf(k)).slice(0, per)));
  const need = pick.filter((x) => !judged[x.id]?.rubric2);
  const bs = chunks(shuffle(need, 23), Number(opt("rubric-batch", "15")));
  console.log(`rejudge (r2): ${pick.length} ideas (${need.length} new) in ${bs.length} Claude calls`);
  await pool(bs, 3, async (b, i) => {
    try {
      const r = await rubricBatch(b, inv, claude, `rubric2:${i}`, "sonnet", "r2");
      for (const [id, v] of r.scores) judged[id] = { ...judged[id], rubric2: v, rubric2Run: String(i) };
      saveJudged();
      console.log(`  batch ${i}: ${r.scores.size}/${b.length} ($${r.run.costUsd.toFixed(4)})`);
    } catch (e: any) { console.log(`  batch ${i} failed: ${e?.message ?? e}`); }
  });
  console.log(`claude ${nonKitCalls()}/${CLAUDE_MAX_EXPERIMENT}`);
}

/** Re-read cached rubric replies with the current parser (the original batches are rebuilt deterministically). */
async function reparse() {
  const round = Number(opt("round", "1"));
  const ideas = store.ideas.filter((x) => x.round === round);
  const { rubricPrompt, parseRubric } = await import("../src/ideagen/judge");
  const { hashOf } = await import("../src/ideagen/llm");
  let fixed = 0;
  for (const b of chunks(shuffle(ideas, round * 17), Number(opt("rubric-batch", "15")))) {
    const p = rubricPrompt(b, inv);
    const hit = budget.cacheGet(`claude-${hashOf(`sonnet\n${p.system}\n${p.user}`)}`);
    if (!hit) continue;
    for (const [id, v] of parseRubric(hit.text, b)) if (!judged[id]?.rubric) { judged[id] = { ...judged[id], rubric: v }; fixed++; }
  }
  saveJudged();
  console.log(`re-parsed: ${fixed} rubric scores recovered`);
}

/** Jev on single ideas vs the same ideas in batches of 4: does batching change the answer? */
async function calibrate() {
  const n = Number(opt("n", "16"));
  const pick = shuffle(store.ideas.filter((x) => x.round === 1 && judged[x.id]?.jevP10 != null && x.strategy !== "A0-template"), 99).slice(0, n);
  await pool(pick, 3, async (x) => {
    if (judged[x.id]?.jevSingleP10 != null) return;
    const r = await jevBatch([x], inv, jev, `jev-single:${x.id}`);
    judged[x.id] = { ...judged[x.id], jevSingleP10: r.get(x.id)?.p10 };
    saveJudged();
  });
  const xs = pick.filter((x) => judged[x.id]?.jevSingleP10 != null);
  const a = xs.map((x) => judged[x.id].jevP10!), b = xs.map((x) => judged[x.id].jevSingleP10!);
  console.log(`batched vs single on ${xs.length}: spearman ${spearman(a, b).toFixed(2)}, mean |Δ| ${mean(a.map((v, i) => Math.abs(v - b[i]))).toFixed(3)}, mean batched ${mean(a).toFixed(3)} vs single ${mean(b).toFixed(3)}`);
}

// ── scoring everything ────────────────────────────────────────────────────────────────────────
/** Every idea with its scores. `controlled` = rubric r2 only (ideas without an r2 score are left out). */
function scored(controlled = false): (Idea & { s: Scores & { jevSingleP10?: number } })[] {
  return store.ideas.filter((x) => !controlled || judged[x.id]?.rubric2).map((x) => {
    const j = judged[x.id] ?? {};
    const matches = matchEvidence(x, ix);
    const rubric = controlled ? j.rubric2 : j.rubric ?? j.rubric2;
    return { ...x, s: { ...scoreIdea(x, { rubric, jevP10: j.jevP10, jevShip: j.jevShip, jevGeneric: j.jevGeneric, matches, posts: postsById, inv }), jevSingleP10: j.jevSingleP10 } };
  });
}

// ── tournament ───────────────────────────────────────────────────────────────────────────────
async function tournament() {
  const top = Number(opt("top", "24")), rounds = Number(opt("rounds", "4")), perCall = Number(opt("per-call", "6"));
  const S = scored().filter((x) => x.s.rubric && x.s.jevP10 != null && x.s.slop?.pass);
  const field = S.sort((a, b) => b.s.quality - a.s.quality).slice(0, top);
  const byId = new Map(field.map((x) => [x.id, x]));
  const saved: { field: string[]; matches: Match[] } = readJson(MATCHES, { field: [], matches: [] });
  const matches: Match[] = saved.field.join() === field.map((x) => x.id).join() ? saved.matches : [];
  const met = new Set(matches.map((m) => [m.a, m.b].sort().join("|")));
  for (let t = matches.length ? Math.round(matches.length / (top / 2)) : 0; t < rounds; t++) {
    const rating = elo(matches, field.map((x) => x.id));
    const pairs = swissPairs(field.map((x) => x.id), rating, met);
    const calls = chunks(pairs, perCall);
    const got = await pool(calls, 2, (ps, i) => jevPairs(ps.map(([a, b]) => [byId.get(a)!, byId.get(b)!]), inv, jev, `pairs:t${t}:${i}`, seedOf(`t${t}:${i}`)).catch((e) => { console.log(`pair call failed: ${e?.message ?? e}`); return [] as Match[]; }));
    for (const m of got.flat()) { matches.push(m); met.add([m.a, m.b].sort().join("|")); }
    writeJson(MATCHES, { field: field.map((x) => x.id), matches });
    console.log(`swiss round ${t + 1}: ${got.flat().length} matches; jev ${budget.ledger.jev.calls}/${JEV_MAX}`);
  }
  const rating = elo(matches, field.map((x) => x.id));
  for (const x of [...field].sort((a, b) => rating.get(b.id)! - rating.get(a.id)!)) console.log(`${Math.round(rating.get(x.id)!)}  q${x.s.quality}  ${x.strategy}  ${x.name}`);
}

// ── analysis ─────────────────────────────────────────────────────────────────────────────────
type Row = Idea & { s: Scores & { jevSingleP10?: number } };
function tableFor(S: Row[], base: Row[]) {
  const rows: any[] = [];
  const baseQ = (st: StrategyId) => base.filter((x) => x.strategy === st).map((x) => x.s.quality);
  for (const r of [...new Set(S.map((x) => x.round))].sort()) for (const st of [...new Set(S.filter((x) => x.round === r).map((x) => x.strategy))]) {
    const xs = S.filter((x) => x.round === r && x.strategy === st);
    const q = xs.map((x) => x.s.quality);
    const run = store.runs.find((x) => x.round === r && x.strategy === st);
    rows.push({
      round: r, strategy: st, label: STRATEGY_LABEL[st], version: run?.version, n: xs.length,
      qMedian: median(q), qP25: quantile(q, 0.25), qP75: quantile(q, 0.75), qTop3: mean([...q].sort((a, b) => b - a).slice(0, 3)),
      rawMedian: median(xs.map((x) => x.s.qualityRaw)), qNoEvMedian: median(xs.map((x) => x.s.qualityNoEvidence)),
      pass: xs.filter((x) => x.s.slop?.pass).length / Math.max(1, xs.length),
      rubric: mean(xs.filter((x) => x.s.rubricNorm != null).map((x) => x.s.rubricNorm!)),
      rubricP10: mean(xs.filter((x) => x.s.rubric).map((x) => x.s.rubric!.p10)),
      jevP10: median(xs.filter((x) => x.s.jevP10 != null).map((x) => x.s.jevP10!)),
      evidence: mean(xs.map((x) => x.s.evidence)),
      dims: Object.fromEntries(["spec", "feasible", "buyer", "distribution", "novelty", "fun", "generic"].map((k) => [k, mean(xs.filter((x) => (x.s.rubric as any)?.[k] != null).map((x) => (x.s.rubric as any)[k]))])),
      vsA1: superiority(q, baseQ("A1-mixer")), ciVsA1: bootMedianDiff(q, baseQ("A1-mixer")),
      genCostUsd: run?.costUsd ?? 0, genMs: run?.ms ?? 0,
    });
  }
  return rows;
}
function analyze() {
  const asRun = scored().filter((x) => x.round <= 2 && judged[x.id]?.rubric);
  const controlled = scored(true);
  const all = scored();
  const t: { field: string[]; matches: Match[] } = readJson(MATCHES, { field: [], matches: [] });
  const rating = elo(t.matches, t.field);
  const tA = tableFor(asRun, asRun.filter((x) => x.round === 1));
  const tB = tableFor(controlled, controlled);
  const both = asRun.filter((x) => x.s.rubric && x.s.jevP10 != null);
  const llm = both.filter((x) => !x.strategy.startsWith("A0") && !x.strategy.startsWith("A1"));
  const cB = controlled.filter((x) => x.s.jevP10 != null);
  const cBllm = cB.filter((x) => !x.strategy.startsWith("A0") && !x.strategy.startsWith("A1"));
  const byId = new Map(all.map((x) => [x.id, x]));
  const ms = t.matches.filter((m) => byId.get(m.a)?.s.rubricNorm != null && byId.get(m.b)?.s.rubricNorm != null);
  const agree = {
    asRun: { n: both.length, rho: spearman(both.map((x) => x.s.rubricNorm!), both.map((x) => x.s.jevP10!)), llmN: llm.length, llmRho: spearman(llm.map((x) => x.s.rubricNorm!), llm.map((x) => x.s.jevP10!)), llmP10Rho: spearman(llm.map((x) => x.s.rubric!.p10), llm.map((x) => x.s.jevP10!)) },
    controlled: { n: cB.length, rho: spearman(cB.map((x) => x.s.rubricNorm!), cB.map((x) => x.s.jevP10!)), llmN: cBllm.length, llmRho: spearman(cBllm.map((x) => x.s.rubricNorm!), cBllm.map((x) => x.s.jevP10!)) },
    generic: (() => { const xs = controlled.filter((x) => x.s.rubric?.generic != null && x.s.jevGeneric != null); return { n: xs.length, rho: spearman(xs.map((x) => x.s.rubric!.generic!), xs.map((x) => x.s.jevGeneric!)) }; })(),
    r1VsR2: (() => { const xs = all.filter((x) => judged[x.id]?.rubric && judged[x.id]?.rubric2); const { rubricNorm } = require("../src/ideagen/judge"); return { n: xs.length, rho: spearman(xs.map((x) => rubricNorm(judged[x.id].rubric!)), xs.map((x) => rubricNorm(judged[x.id].rubric2!))), meanDiff: mean(xs.map((x) => rubricNorm(judged[x.id].rubric2!) - rubricNorm(judged[x.id].rubric!))) }; })(),
    evidenceVsRubric: spearman(both.map((x) => x.s.evidence), both.map((x) => x.s.rubricNorm!)),
    batchVsSingle: (() => { const xs = all.filter((x) => x.s.jevSingleP10 != null && x.s.jevP10 != null); return { n: xs.length, spearman: spearman(xs.map((x) => x.s.jevP10!), xs.map((x) => x.s.jevSingleP10!)), meanAbsDiff: mean(xs.map((x) => Math.abs(x.s.jevP10! - x.s.jevSingleP10!))), meanBatched: mean(xs.map((x) => x.s.jevP10!)), meanSingle: mean(xs.map((x) => x.s.jevSingleP10!)) }; })(),
    tournament: { matches: ms.length, winnerHasHigherRubric: ms.length ? ms.filter((m) => byId.get(m.winner)!.s.rubricNorm! >= byId.get(m.winner === m.a ? m.b : m.a)!.s.rubricNorm!).length / ms.length : NaN, firstPositionWins: ms.length ? ms.filter((m) => (m.swapped ? m.winner === m.b : m.winner === m.a)).length / ms.length : NaN, eloVsQuality: spearman(t.field.map((id) => rating.get(id) ?? 1500), t.field.map((id) => byId.get(id)?.s.quality ?? 0)) },
  };
  // The slop gate over every idea (r2 rubric where it exists, else r1).
  const slopBy = new Map<string, { n: number; pass: number }>();
  const reasonCount = new Map<string, number>();
  for (const x of all) {
    const k = x.strategy;
    const e = slopBy.get(k) ?? { n: 0, pass: 0 };
    e.n++; if (x.s.slop?.pass) e.pass++;
    slopBy.set(k, e);
    for (const r of x.s.slop?.reasons ?? []) { const key = r.replace(/ ".*"| \(.*\)/g, ""); reasonCount.set(key, (reasonCount.get(key) ?? 0) + 1); }
  }
  const rejectedGood = all.filter((x) => !x.s.slop?.pass && x.s.qualityRaw >= 55).sort((a, b) => b.s.qualityRaw - a.s.qualityRaw);
  const led = budget.ledger;
  const byTag = (k: string) => { const es = led.entries.filter((e) => e.kind === "claude" && !e.cached && e.ok && e.tag.startsWith(k)); return { calls: es.length, costUsd: es.reduce((a, e) => a + (e.costUsd ?? 0), 0), inTok: es.reduce((a, e) => a + (e.inTok ?? 0), 0), outTok: es.reduce((a, e) => a + (e.outTok ?? 0), 0), ms: es.reduce((a, e) => a + e.ms, 0) }; };
  const cost = {
    claude: { calls: nonKitCalls(), kitCalls: led.entries.filter((e) => e.kind === "claude" && !e.cached && e.tag.startsWith("kit")).length, costUsd: led.claude.costUsd, inTok: led.claude.inTok, outTok: led.claude.outTok, ms: led.claude.ms, byTag: { gen: byTag("gen"), rubric: byTag("rubric:"), rubric2: byTag("rubric2"), kit: byTag("kit") } },
    jev: { calls: led.jev.calls, ...jevUsageFor(led.jev.ids), byKind: Object.fromEntries(["jev:", "jev-single", "generic", "pairs"].map((k) => [k, led.entries.filter((e) => e.kind === "jev" && !e.cached && e.tag.startsWith(k)).length])) },
    ideas: all.length, llmIdeas: all.filter((x) => x.source === "claude").length,
  };
  const ranked = all.filter((x) => x.s.slop?.pass && x.s.rubric && x.s.jevP10 != null).sort((a, b) => b.s.quality - a.s.quality);
  const slim = (x: Row) => ({ id: x.id, name: x.name, strategy: x.strategy, round: x.round, quality: x.s.quality, raw: x.s.qualityRaw, jevP10: x.s.jevP10, jevGeneric: x.s.jevGeneric, rubric: x.s.rubric, evidence: x.s.evidence, elo: rating.get(x.id), slop: x.s.slop });
  writeJson(`${LAB}/results.json`, { at: Date.now(), asRun: tA, controlled: tB, agree, cost, slop: { by: Object.fromEntries(slopBy), reasons: Object.fromEntries(reasonCount), rejectedGood: rejectedGood.slice(0, 10).map(slim) }, top: ranked.slice(0, 30).map(slim) });
  writeJson(`${LAB}/scored.json`, all.map(({ raw, ...x }) => x));
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
  const tbl = (rows: any[]) => [
    "| round | strategy | prompt | n | median Q | IQR | top-3 Q | median raw Q | slop pass | rubric | Jev p10 | evidence | P(> A1) | Δmedian vs A1 (95% CI) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.round} | ${r.strategy} | ${r.version ?? ""} | ${r.n} | **${f(r.qMedian)}** | ${f(r.qP25)}–${f(r.qP75)} | ${f(r.qTop3)} | ${f(r.rawMedian)} | ${f(r.pass * 100, 0)}% | ${f(r.rubric, 2)} | ${f(r.jevP10, 3)} | ${f(r.evidence, 2)} | ${f(r.vsA1, 2)} | ${f(r.ciVsA1[0])} … ${f(r.ciVsA1[1])} |`),
  ];
  const dims = (rows: any[]) => ["| round | strategy | spec | feasible | buyer | distribution | novelty | fun | generic | Claude p10 |", "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.round} | ${r.strategy} | ${f(r.dims.spec)} | ${f(r.dims.feasible)} | ${f(r.dims.buyer)} | ${f(r.dims.distribution)} | ${f(r.dims.novelty)} | ${f(r.dims.fun)} | ${f(r.dims.generic)} | ${f(r.rubricP10 * 100, 0)}% |`)];
  const lines = [
    "### Table A — as run (rubric r1, rounds 1–2; Q = quality 0–100 after the slop gate)", "", ...tbl(tA), "", ...dims(tA), "",
    "### Table B — controlled re-judge (rubric r2, mixed batches: 3 random ideas from every earlier cell + all of round 3)", "", ...tbl(tB), "", ...dims(tB), "",
    "### Slop gate", "",
    `Rejected ${all.filter((x) => !x.s.slop?.pass).length} of ${all.length} ideas (${f((all.filter((x) => !x.s.slop?.pass).length / all.length) * 100, 0)}%).`, "",
    "| strategy | ideas | pass | rejected |", "|---|---|---|---|",
    ...[...slopBy].map(([k, v]) => `| ${k} | ${v.n} | ${v.pass} | ${f((1 - v.pass / v.n) * 100, 0)}% |`), "",
    "Reasons (an idea can have several): " + [...reasonCount].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join("; "), "",
    "### Judge agreement (Spearman ρ)", "",
    `- As run: rubric vs Jev p10 ρ=**${f(agree.asRun.rho, 2)}** (n=${agree.asRun.n}); new-schema ideas only ρ=**${f(agree.asRun.llmRho, 2)}** (n=${agree.asRun.llmN}); Claude's own p10 vs Jev p10 (new-schema) ρ=${f(agree.asRun.llmP10Rho, 2)}`,
    `- Controlled (r2): rubric vs Jev ρ=${f(agree.controlled.rho, 2)} (n=${agree.controlled.n}); new-schema only ρ=${f(agree.controlled.llmRho, 2)} (n=${agree.controlled.llmN})`,
    `- Slop: rubric "generic" vs Jev "would dismiss as generic" ρ=${f(agree.generic.rho, 2)} (n=${agree.generic.n})`,
    `- Same ideas under rubric r1 vs r2: ρ=${f(agree.r1VsR2.rho, 2)}, mean shift ${f(agree.r1VsR2.meanDiff, 3)} (n=${agree.r1VsR2.n})`,
    `- Evidence vs rubric: ρ=${f(agree.evidenceVsRubric, 2)}`,
    `- Jev batched (4 per call) vs one idea per call: ρ=${f(agree.batchVsSingle.spearman, 2)}, mean |Δp|=${f(agree.batchVsSingle.meanAbsDiff, 3)}, mean p ${f(agree.batchVsSingle.meanBatched, 3)} vs ${f(agree.batchVsSingle.meanSingle, 3)} (n=${agree.batchVsSingle.n})`,
    `- Tournament: ${agree.tournament.matches} Jev pairwise matches; winner had the higher rubric score in ${f(agree.tournament.winnerHasHigherRubric * 100, 0)}%; first-listed idea won ${f(agree.tournament.firstPositionWins * 100, 0)}%; Elo vs quality ρ=${f(agree.tournament.eloVsQuality, 2)}`,
    "", "### Cost", "",
    `- Claude: ${cost.claude.calls} experiment calls + ${cost.claude.kitCalls} kit calls, $${f(cost.claude.costUsd, 3)} total, ${cost.claude.inTok} input / ${cost.claude.outTok} output tokens`,
    ...Object.entries(cost.claude.byTag).map(([k, v]: any) => `  - ${k}: ${v.calls} calls, $${f(v.costUsd, 3)}, ${v.inTok}/${v.outTok} tokens, ${f(v.ms / 1000 / Math.max(1, v.calls), 0)} s per call`),
    `- Jev: ${cost.jev.calls} calls (${Object.entries(cost.jev.byKind).map(([k, v]) => `${k.replace(/:$/, "")} ${v}`).join(", ")}), ${cost.jev.inTok} input tokens ≈ $${f(cost.jev.usd, 4)}, mean latency ${f(cost.jev.latencyMs / Math.max(1, cost.jev.n), 0)} ms`,
    `- Ideas: ${cost.ideas} (${cost.llmIdeas} from Claude)`,
  ];
  const REPORT = `${LAB}/report.md`;
  const cur = existsSync(REPORT) ? readFileSync(REPORT, "utf8") : "# Idea lab\n\n<!-- auto:tables -->\n<!-- /auto:tables -->\n";
  const block = `<!-- auto:tables -->\n${lines.join("\n")}\n<!-- /auto:tables -->`;
  writeFileSync(REPORT, cur.includes("<!-- auto:tables -->") ? cur.replace(/<!-- auto:tables -->[\s\S]*<!-- \/auto:tables -->/, block) : `${cur}\n${block}\n`);
  console.log(lines.join("\n"));
  console.log("\nTOP 20 (passing the gate)");
  for (const x of ranked.slice(0, 20)) console.log(`q${x.s.quality} jev ${x.s.jevP10?.toFixed(2)} rub ${x.s.rubricNorm} ev ${x.s.evidence} gen ${x.s.jevGeneric?.toFixed(2)} [${x.strategy} r${x.round}] ${x.name} — ${x.hook} | ${x.price} | ${x.channel.slice(0, 80)}`);
  console.log("\nREJECTED, high raw quality");
  for (const x of rejectedGood.slice(0, 8)) console.log(`raw ${x.s.qualityRaw} [${x.strategy} r${x.round}] ${x.name} — ${x.s.slop?.reasons.join("; ")}`);
}

const cmds: Record<string, () => Promise<void> | void> = { gen, judge, reparse, calibrate, slopjev, rejudge, tournament, analyze };
if (cmds[cmd]) await cmds[cmd]();
else if (cmd === "gallery" || cmd === "kits") await (await import("./idea-experiment-out")).run(cmd, { store, judged, scored, inv, corpus, claude, jev, budget, LAB, args });
else console.log("commands: gen | judge | calibrate | tournament | analyze | gallery | kits");
