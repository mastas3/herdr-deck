// The gallery: Netflix-style lanes of idea cards. generateGallery runs the winning recipe once a day (audience-first
// and pain-first briefs from the coherent sampler, plus trend and constraint lanes; one Claude call per strategy;
// Jev + rubric judging; the slop gate) and caches the result; moreInLane refills one lane on demand.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Brief, Gallery, Idea, IdeaCard, Inventory, Lane, PainCorpus, Scores, StrategyId } from "./types";
import type { TrendSet } from "./trends";
import type { ClaudeRunner, JevRunner } from "./llm";
import { briefsFor, painClusters, seedOf } from "./sampler";
import { ideaPrompt, parseIdeas } from "./strategies";
import { indexPosts, jevBatch, jevGenericBatch, matchEvidence, rubricBatch, scoreIdea } from "./judge";
import { mapConnectors, ownedRatio } from "./connectors";
import { terms } from "./evidence";

export const GALLERY_VERSION = "g1";
/** The recipe that won the experiment (docs/idea-lab/report.md): strategy → ideas per day. */
export const RECIPE: [StrategyId, number][] = [["C-audience", 12], ["B-pain", 10], ["G-constraint", 8], ["T-hot", 6], ["T-early", 6], ["H-boring", 6], ["F-gem", 6]];
const dayOf = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ── cards ─────────────────────────────────────────────────────────────────────────────
/** The first three quests of playing an idea, each with how it's verified. */
export function playBrief(i: Idea) {
  const channel = i.channel.split(/[;.]/)[0].trim() || "the channel above";
  return {
    quests: [
      { title: `Landing page live with a ${i.price || "priced"} checkout`, verify: "the page returns 200 and a test purchase (or a published Gumroad product) goes through" },
      { title: `10 conversations with buyers via ${channel}`, verify: "10 replies logged in QUESTS.md with each person's words about the pain" },
      { title: "First paying customer", verify: "a real payment in Gumroad/Stripe from someone you don't know" },
    ],
  };
}
export function toCard(i: Idea, s: Scores, connectors: IdeaCard["connectors"]): IdeaCard {
  return {
    id: i.id, name: i.name, hook: i.hook, buyer: i.buyer, pain: i.pain,
    evidence: s.evidenceMatches.filter((m) => m.cited || m.overlap >= 0.15).slice(0, 3).map((m) => ({ url: m.url, snippet: m.snippet, source: m.source })),
    offer: i.offer, price: i.price, channel: i.channel, mvp: i.mvp, stack: i.stack, connectors, missing: connectors.filter((c) => c.missing),
    timeToFirstDollarDays: i.timeToFirstDollarDays, difficulty: i.difficulty, quality: s.quality, jevP10: s.jevP10, rubric: s.rubric, evidenceScore: s.evidence,
    strategy: i.strategy, topics: i.topics, play: playBrief(i), trend: i.trend, ownedRatio: Math.round(ownedRatio(i) * 100) / 100,
  };
}

// ── lanes ─────────────────────────────────────────────────────────────────────────────
type LaneDef = { id: string; title: string; subtitle: string; pick: (c: IdeaCard) => boolean; sort: (a: IdeaCard, b: IdeaCard) => number; refill: StrategyId };
const byQ = (a: IdeaCard, b: IdeaCard) => b.quality - a.quality;
const realTrend = (c: IdeaCard) => !!c.trend && c.trend.signals.length > 0 && !/^no\b|no (?:major |real )?trend/i.test(c.trend.whyNow);
export const LANES: LaneDef[] = [
  { id: "top", title: "Top picks for you", subtitle: "Highest quality after judging", pick: () => true, sort: byQ, refill: "C-audience" },
  { id: "hot", title: "Hot right now", subtitle: "Riding what's trending this week, with the signals", pick: (c) => realTrend(c) && c.trend!.heat >= 1.5, sort: (a, b) => b.trend!.heat * b.quality - a.trend!.heat * a.quality, refill: "T-hot" },
  { id: "early", title: "Just starting to trend", subtitle: "Early signals: fast growth from a small base", pick: (c) => realTrend(c) && c.trend!.earliness >= 0.3, sort: (a, b) => b.trend!.earliness * b.quality - a.trend!.earliness * a.quality, refill: "T-early" },
  { id: "fastest", title: "Fastest to first $", subtitle: "First payment in two weeks or less", pick: (c) => c.timeToFirstDollarDays > 0 && c.timeToFirstDollarDays <= 14, sort: (a, b) => a.timeToFirstDollarDays - b.timeToFirstDollarDays || byQ(a, b), refill: "G-constraint" },
  { id: "asking", title: "Your audience is asking for this", subtitle: "Backed by real posts from people you can reach", pick: (c) => c.evidenceScore >= 0.6 && c.evidence.length > 0, sort: (a, b) => b.evidenceScore * b.quality - a.evidenceScore * a.quality, refill: "B-pain" },
  { id: "owned", title: "Built on what you already own", subtitle: "Mostly your projects and accounts; little to add", pick: (c) => c.ownedRatio >= 0.6 && c.missing.length <= 1, sort: byQ, refill: "C-audience" },
  { id: "hd", title: "Because you like Human Design", subtitle: "For the HD crowds you can reach", pick: (c) => c.topics.includes("hd"), sort: byQ, refill: "C-audience" },
  { id: "weekend", title: "Weekend-sized", subtitle: "Small enough to ship by Monday", pick: (c) => c.difficulty === "weekend", sort: byQ, refill: "G-constraint" },
  { id: "trending-tech", title: "Trending tech, real demand", subtitle: "A rising open-source engine pointed at a real pain", pick: (c) => c.strategy === "F-gem" && c.evidenceScore >= 0.5, sort: byQ, refill: "F-gem" },
  { id: "boring", title: "Boring businesses that pay", subtitle: "Unglamorous jobs people already pay for", pick: (c) => c.strategy === "H-boring" || /\b(owners?|offices?|clinics?|agents?|contractors?|studios?|companies)\b/i.test(c.buyer), sort: byQ, refill: "H-boring" },
  { id: "moonshots", title: "Moonshots", subtitle: "Bigger bets with a real edge", pick: (c) => c.difficulty === "month" || (c.rubric?.novelty ?? 0) >= 4, sort: (a, b) => (b.rubric?.novelty ?? 0) * b.quality - (a.rubric?.novelty ?? 0) * a.quality, refill: "D-asset" },
  { id: "jev", title: "Wildcards Jev loves", subtitle: "Jev rates them higher than the rubric does", pick: (c) => (c.jevP10 ?? 0) >= 0.45, sort: (a, b) => ((b.jevP10 ?? 0) - (b.rubric ? b.quality / 100 : 0)) - ((a.jevP10 ?? 0) - (a.rubric ? a.quality / 100 : 0)), refill: "C-audience" },
];
const similar = (a: IdeaCard, b: IdeaCard) => {
  const x = new Set(terms(`${a.name} ${a.offer}`)), y = new Set(terms(`${b.name} ${b.offer}`));
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.max(1, Math.min(x.size, y.size)) >= 0.5;
};
/** Lanes from cards: gated cards only, near-duplicates collapsed to the best one, up to `per` per lane. */
export function laneize(cards: IdeaCard[], per = 12): Lane[] {
  const pool = cards.filter((c) => c.quality > 0).sort(byQ);
  const unique: IdeaCard[] = [];
  for (const c of pool) if (!unique.some((u) => similar(u, c))) unique.push(c);
  const lanes: Lane[] = [];
  for (const l of LANES) {
    // "Just starting" shows what "Hot right now" doesn't: the two trend lanes never repeat each other.
    const skip = l.id === "early" ? new Set(lanes.find((x) => x.id === "hot")?.ideas ?? []) : new Set<string>();
    const ids = unique.filter((c) => l.pick(c) && !skip.has(c.id)).sort(l.sort).map((c) => c.id);
    if (ids.length) lanes.push({ id: l.id, title: l.title, subtitle: l.subtitle, ideas: ids.slice(0, per), more: true });
  }
  return lanes;
}

// ── the pipeline ────────────────────────────────────────────────────────────────────────
export type GalleryDeps = {
  cacheDir: string; inv: Inventory; corpus: PainCorpus; trends?: TrendSet;
  claude: ClaudeRunner; jev: JevRunner; findRepos?: (cap: string) => Promise<any[]>;
  now?: () => number; rubric?: boolean; recipe?: [StrategyId, number][]; promptVersion?: "v4";
};
type Judged = { idea: Idea; s: Scores };
/** Generate one strategy's ideas (one Claude call). */
export async function generateIdeas(strategy: StrategyId, n: number, d: GalleryDeps, seed: number, exclude: Brief[] = []): Promise<Idea[]> {
  const clusters = painClusters(d.corpus, d.inv);
  const briefs = briefsFor(strategy, n + exclude.length, { inv: d.inv, corpus: d.corpus, seed, clusters, trends: d.trends })
    .filter((b) => !exclude.some((x) => x.id === b.id && x.strategy === b.strategy)).slice(0, n);
  if (!briefs.length) return [];
  const p = ideaPrompt(briefs, d.inv, { version: d.promptVersion ?? "v4" });
  const r = await d.claude({ system: p.system, user: p.user, model: "haiku", tag: `gallery:${strategy}` });
  return parseIdeas(r.text, briefs, strategy, p.version, 0, d.inv);
}
/** Judge ideas: Jev p10 + ship (4 per call), Jev slop check (6 per call), the rubric (15 per call) when enabled. */
export async function judgeIdeas(ideas: Idea[], d: GalleryDeps): Promise<Judged[]> {
  const chunk = <T>(xs: T[], k: number) => Array.from({ length: Math.ceil(xs.length / k) }, (_, i) => xs.slice(i * k, i * k + k));
  const p10 = new Map<string, { p10?: number; ship?: number }>(), gen = new Map<string, number | undefined>(), rub = new Map<string, any>();
  await Promise.all([
    ...chunk(ideas, 4).map(async (b, i) => { for (const [k, v] of await jevBatch(b, d.inv, d.jev, `gallery-p10:${i}`).catch(() => new Map())) p10.set(k, v); }),
    ...chunk(ideas, 6).map(async (b, i) => { for (const [k, v] of await jevGenericBatch(b, d.inv, d.jev, `gallery-generic:${i}`).catch(() => new Map())) gen.set(k, v); }),
    ...(d.rubric === false ? [] : chunk(ideas, 15).map(async (b, i) => { try { for (const [k, v] of (await rubricBatch(b, d.inv, d.claude, `gallery-rubric:${i}`, "sonnet", "r2")).scores) rub.set(k, v); } catch {} })),
  ]);
  const ix = indexPosts(d.corpus.posts);
  const posts = new Map(d.corpus.posts.map((p) => [p.id, p]));
  return ideas.map((idea) => ({ idea, s: scoreIdea(idea, { rubric: rub.get(idea.id), jevP10: p10.get(idea.id)?.p10, jevShip: p10.get(idea.id)?.ship, jevGeneric: gen.get(idea.id), matches: matchEvidence(idea, ix), posts, inv: d.inv }) }));
}
/** Cards + lanes from judged ideas (no model calls). */
export async function buildGallery(judged: Judged[], inv: Inventory, o: { day: string; at: number; findRepos?: GalleryDeps["findRepos"]; stats?: Partial<Gallery["stats"]> }): Promise<Gallery> {
  const ideas: Record<string, IdeaCard> = {};
  for (const { idea, s } of judged) if (s.slop?.pass) ideas[idea.id] = toCard(idea, s, await mapConnectors(idea, inv, o.findRepos));
  return { day: o.day, at: o.at, version: GALLERY_VERSION, lanes: laneize(Object.values(ideas)), ideas, stats: { ideas: Object.keys(ideas).length, claudeCalls: 0, jevCalls: 0, ms: 0, ...o.stats } };
}
const fileFor = (dir: string, day: string) => `${dir}/gallery-${day}.json`;
function save(dir: string, g: Gallery) { mkdirSync(dir, { recursive: true }); const f = fileFor(dir, g.day); writeFileSync(`${f}.tmp`, JSON.stringify(g)); renameSync(`${f}.tmp`, f); }
export function cachedGallery(dir: string, day: string): Gallery | undefined { try { return JSON.parse(readFileSync(fileFor(dir, day), "utf8")); } catch { return undefined; } }

/** Today's gallery: from the cache, or generated once (about 7 Claude calls + ~25 Jev calls with the default recipe). */
export async function generateGallery(d: GalleryDeps, o: { force?: boolean } = {}): Promise<Gallery> {
  const now = d.now?.() ?? Date.now();
  const day = dayOf(now);
  const hit = !o.force && existsSync(fileFor(d.cacheDir, day)) ? cachedGallery(d.cacheDir, day) : undefined;
  if (hit) return hit;
  const t0 = Date.now();
  const seed = seedOf(day);
  const made = await Promise.all((d.recipe ?? RECIPE).map(([s, n]) => generateIdeas(s, n, d, seed).catch(() => [] as Idea[])));
  const judged = await judgeIdeas(made.flat(), d);
  const g = await buildGallery(judged, d.inv, { day, at: now, findRepos: d.findRepos, stats: { ms: Date.now() - t0, claudeCalls: (d.recipe ?? RECIPE).length } });
  save(d.cacheDir, g);
  return g;
}
/** "More in this lane": generate a few more with the lane's strategy, judge, and append what passes. */
export async function moreInLane(laneId: string, d: GalleryDeps, n = 6): Promise<Gallery> {
  const g = await generateGallery(d);
  const def = LANES.find((l) => l.id === laneId);
  if (!def) throw new Error(`No lane "${laneId}"`);
  const round = (g.stats.note?.match(/more:(\d+)/)?.[1] ?? "0");
  const ideas = await generateIdeas(def.refill, n, d, seedOf(`${g.day}:${laneId}:${round}`));
  const judged = await judgeIdeas(ideas, d);
  for (const { idea, s } of judged) if (s.slop?.pass && !g.ideas[idea.id]) g.ideas[idea.id] = toCard(idea, s, await mapConnectors(idea, d.inv, d.findRepos));
  const lanes = laneize(Object.values(g.ideas));
  const next: Gallery = { ...g, lanes: g.lanes.map((l) => lanes.find((x) => x.id === l.id) ?? l).concat(lanes.filter((x) => !g.lanes.some((l) => l.id === x.id))), stats: { ...g.stats, ideas: Object.keys(g.ideas).length, note: `more:${Number(round) + 1}` } };
  save(d.cacheDir, next);
  return next;
}
