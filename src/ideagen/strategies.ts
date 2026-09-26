// Generation strategies: the baselines (today's template sparks and Mixer), and briefs → one shared idea contract.
// Every LLM strategy uses the same output schema and the same builder context, so the judges compare like with like;
// the strategies differ only in what the sampler puts in each brief and one line of intent.
import { collectIngredients, forYouIngredients, mixPrompt, parseMixes, templateMixes, type Mix } from "../mix";
import { sparks, type Gem, type Profile } from "../discover";
import type { Brief, Difficulty, Idea, Inventory, StackItem, StrategyId } from "./types";
import { CAP, CAPS, capsOf, inventoryDigest, topicsOf } from "./inventory";
import { extractRecords, list, num, str } from "./json";
import { seedOf } from "./sampler";

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  "A0-template": "Baseline: today's template sparks & mixes", "A1-mixer": "Baseline: today's Claude Mixer (random ingredients)", "A2-random-schema": "Control: random ingredients + new idea schema",
  "B-pain": "Pain-first", "C-audience": "Audience-first", "D-asset": "Asset leverage", "E-remix": "Market-proven remix", "F-gem": "Gem-grounded",
  "G-constraint": "Constraint ($1k in 30 days, ≤3 ingredients)", "H-boring": "Boring-business automation", "W-hybrid": "Hybrid: pain-first × proven model", "T-hot": "Trend: hot right now", "T-early": "Trend: just starting",
};
/** What each strategy asks of the writer, per brief. */
const INTENT: Record<StrategyId, string> = {
  "A0-template": "", "A1-mixer": "",
  "A2-random-schema": "Combine these ingredients into one product people would pay for.",
  "B-pain": "Solve exactly this pain, for exactly these people, quoting their words. The engine is a suggestion; use it only if it really fits.",
  "C-audience": "Pick the job-to-be-done these people would pay for fastest and design the offer around it.",
  "D-asset": "Who would pay for what this asset already produces? Productize its output (a service, report, API or app) for the named audience.",
  "E-remix": "Apply this proven business model to this audience with the builder's engine; keep the model's price anchor unless there's a reason not to.",
  "F-gem": "Wrap this open-source repo into a product that answers the pain; say what the builder adds on top so it isn't just the repo.",
  "G-constraint": "Obey the constraint literally: at most 3 ingredients the builder owns, no new infrastructure, $1,000 within 30 days. Prefer selling before building.",
  "H-boring": "Automate this boring, recurring job for this kind of business; they already pay people or tools to do it.",
  "W-hybrid": "Solve exactly this pain for these people, shaped as the given proven model (its buyer, format and price anchor). Quote their words.",
  "T-hot": "Ride this trend while it's hot: a product people will pay for now because of it (or the picks-and-shovels next to it). Name the trend, cite its signal ids, say why now.",
  "T-early": "This is just starting to trend: build the thing early adopters will need before incumbents notice. Name the trend, cite its signal ids, say why now.",
};
const TREND_SOURCE: Record<string, string> = { hn: "HN front page", showhn: "Show HN", github: "new GitHub repo", producthunt: "Product Hunt", reddit: "Reddit top of week", polymarket: "Polymarket", report: "research report" };
const SOURCE_NAME: Record<string, string> = { hn: "Hacker News", reddit: "Reddit", github: "GitHub issue", se: "Stack Exchange", appstore: "App Store review (US)" };

// ── the shared prompt ───────────────────────────────────────────────────────────────────────
type PromptOpts = { version?: "v1" | "v2" | "v3" | "v4"; extraRules?: string[] };
const BUILDER = "A solo developer in Israel (speaks Hebrew, Russian and English) who ships fast with coding agents (Claude Code, Codex) and already runs the projects and accounts below.";
const CAP_LIST = CAPS.map((c) => c.id).join(", ");
function briefText(b: Brief, i: number): string {
  const L: string[] = [`[${b.id}] ${INTENT[b.strategy]}`];
  if (b.audience) L.push(`  Audience: ${b.audience.who} — reachable via ${b.audience.places.slice(0, 3).join("; ")}`);
  if (b.angle) L.push(`  Angle: ${b.angle}`);
  if (b.pain?.quotes.length) { L.push(`  Pain, in their words (real public posts; cite by id):`); for (const q of b.pain.quotes.slice(0, 3)) L.push(`    (${q.id}) [${SOURCE_NAME[q.source] ?? q.source}${q.where ? `, ${q.where}` : ""}] "${str(`${q.title}: ${q.snippet}`, 240)}"`); }
  if (b.engine) L.push(`  Engine you own: ${b.engine.name} — ${str(b.engine.desc, 160)}`);
  if (b.support?.length) L.push(`  Also available: ${b.support.map((s) => `${s.name} (${str(s.desc, 70)})`).join("; ")}`);
  if (b.gem) L.push(`  Open-source repo: ${b.gem.name} (${b.gem.stars ?? "?"}★) — ${str(b.gem.desc, 140)}`);
  if (b.model) L.push(`  Proven model: ${b.model.name} — ${b.model.pattern}. e.g. ${b.model.examples}. Typical price ${b.model.price}.`);
  if (b.channel) L.push(`  A channel the builder has: ${b.channel.name}`);
  if (b.trend) {
    L.push(`  Trend: "${b.trend.label}" (heat ${b.trend.heat.toFixed(1)}, earliness ${b.trend.earliness.toFixed(2)}). Signals (cite by id in trend_ids):`);
    for (const x of b.trend.signals) L.push(`    (${x.id}) [${TREND_SOURCE[x.source] ?? x.source}${x.metric > 1 ? `, ${Math.round(x.metric)} ${x.source === "github" ? "stars" : x.source === "polymarket" ? "24h volume" : "points"}` : ""}, ${Math.max(0, Math.round((Date.now() - x.at) / 86_400_000))} days ago] ${str(x.title, 160)}`);
  }
  if (b.constraint) L.push(`  Constraint: ${b.constraint}`);
  return L.join("\n");
}
export function ideaPrompt(briefs: Brief[], inv: Inventory, o: PromptOpts = {}) {
  const v = o.version ?? "v1";
  const system = "You are a pragmatic indie-business strategist. You turn one builder's real assets into products that specific people pay for. You answer with strict JSON only: no prose, no Markdown, no code fences.";
  const rules = [
    "Write exactly one idea per brief, in the same order, and put the brief id in \"brief\".",
    "buyer: a specific kind of person or business AND where they are (a community, platform or place), not \"users\" or \"people interested in X\".",
    "pain: the problem in the buyer's own words. If the brief quotes posts, use them and list their ids in evidence_ids; never invent ids.",
    "offer + price: what exactly they get and a concrete price with its unit (e.g. \"$19 one-time\", \"$12/month\", \"₪250 per report\").",
    "channel: where the first 10 paying customers come from, preferring channels the builder already has; name the place.",
    "mvp: the smallest sellable version, in one or two sentences, buildable by one person with agents.",
    "stack: 2 to 5 ingredients with what each does, using the builder's own projects/services by their exact names when they fit.",
    `needs: the capabilities the product requires, as ids from: ${CAP_LIST}.`,
    "days_to_first_dollar: realistic days from starting to the first payment. difficulty: weekend, week or month.",
    "quests: the first 3 steps of playing this idea, each with a verifiable outcome (e.g. \"landing page live with a checkout\", \"10 conversations with buyers\", \"first paying customer\").",
    "Be concrete and honest. A boring idea that sells beats a clever one nobody pays for. No buzzwords.",
    ...(v !== "v1" ? [
      "Before writing an idea, check: would this buyer pay this price within a week of seeing it? If not, change the offer, not the wording.",
      "Prefer selling a result (a report, a done-for-you job, a finished file) over selling software access, unless the software is the result.",
      "The hook is what the buyer would click in the place you named: plain words, their outcome, no product jargon.",
      "edge: one line on why THIS builder wins — name the owned project, corpus, community access or skill nobody else has. If there is none, pick a different offer.",
      "Never write the same product twice: if two briefs lead to the same thing, make the second a different offer (a done-for-you service, a one-off report, a B2B license) or a different buyer.",
      "Quotes are from the named sources (e.g. US App Store reviews, Hacker News); don't claim they come from a different country or community than stated.",
    ] : []),
    ...(briefs.some((b) => b.trend) ? [
      "For trend briefs: add \"trend\" (the trend in a few words), \"trend_ids\" (the signal ids you rely on, from the brief only) and \"why_now\" (what changed in the last weeks that makes this sellable now).",
    ] : []),
    // v3 asked for "a number" in the channel and gave "r/humandesign (200k members)" as the example; the model then invented
    // member counts. v4 asks for an action count the builder controls instead, and forbids unsourced statistics.
    ...(v === "v3" ? ["Name a real, reachable first channel with a number (e.g. \"post in r/humandesign (200k members)\" or \"DM 30 coaches from the HD Facebook groups\"); if the builder already has the channel, say so."] : []),
    ...(v === "v4" ? [
      "channel: a named place plus an action the builder controls, with a count (e.g. \"DM 30 coaches from the HD Facebook groups\", \"one Show HN post + reply to every comment\"). If the builder already has the channel, say so.",
      "stack must include the project the brief says you own, by its exact name, doing real work (its data, engine or audience is the moat).",
      "No statistics, market sizes or member counts unless they appear in the brief. No hype words (revolutionize, seamless, AI-powered, all-in-one, synergy, unlock, supercharge). Plain, specific product names; no emoji.",
    ] : []),
    ...(o.extraRules ?? []),
  ];
  const aud = inv.audiences.filter((a) => a.reach.length).map((a) => `- ${a.label}: ${a.who} (via ${a.reach.slice(0, 3).map((id) => inv.assets.find((x) => x.id === id)?.name ?? id).join(", ")})`).join("\n");
  const user = [
    "THE BUILDER", BUILDER, inventoryDigest(inv, 36), "", "Audiences the builder can reach:", aud, "",
    "BRIEFS", ...briefs.map(briefText), "",
    "RULES", ...rules.map((r) => `- ${r}`), "",
    'Reply with exactly this JSON shape: {"ideas":[{"brief":"id","name":"short product name","hook":"one line","buyer":"...","pain":"...","evidence_ids":[],"offer":"...","price":"...","channel":"...","mvp":"...","stack":[{"name":"...","role":"..."}],"needs":["payments"],"days_to_first_dollar":14,"difficulty":"week","quests":["...","...","..."]' + (v !== "v1" ? ',"edge":"..."' : "") + (briefs.some((b) => b.trend) ? ',"trend":"...","trend_ids":[],"why_now":"..."' : "") + '}]}',
  ].join("\n");
  return { system, user, version: `${v}` };
}

// ── normalizing a model's idea ───────────────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
function matchAsset(name: string, inv: Inventory) {
  const n = norm(name);
  if (n.length < 2) return undefined;
  const cands = inv.assets.filter((a) => a.kind !== "key");
  return cands.find((a) => norm(a.name) === n) ?? cands.find((a) => a.kind === "repo" && norm(a.name.split("/")[1] ?? "") === n)
    ?? (n.length >= 4 ? cands.filter((a) => a.owned).find((a) => { const an = norm(a.name); return an.length >= 4 && (n.includes(an) || an.includes(n)); }) : undefined);
}
function difficultyOf(v: unknown): Difficulty { const s = String(v ?? "").toLowerCase(); return /weekend|day|hour/.test(s) ? "weekend" : /month|quarter/.test(s) ? "month" : "week"; }
export function normalizeIdea(raw: any, brief: Brief | undefined, strategy: StrategyId, promptVersion: string, round: number, inv: Inventory): Idea | undefined {
  const name = str(raw?.name ?? raw?.title, 80);
  if (!name) return undefined;
  const stack: StackItem[] = (Array.isArray(raw?.stack) ? raw.stack : []).slice(0, 6).map((x: any) => {
    const nm = str(typeof x === "string" ? x.split(/[:—–-]\s/)[0] : x?.name ?? x?.ingredient, 80);
    const a = matchAsset(nm, inv);
    return { name: a?.name ?? nm, role: str(typeof x === "string" ? x.split(/[:—–-]\s/).slice(1).join(" ") : x?.role ?? x?.does, 160), assetId: a?.id, owned: !!a?.owned };
  }).filter((x: StackItem) => x.name);
  const text = [raw?.hook, raw?.offer, raw?.mvp, raw?.channel, raw?.pain].map((x) => str(x, 400)).join(" ");
  const declared = list(raw?.needs, 12, 40).map((x) => x.toLowerCase().trim()).filter((x) => CAP[x]);
  const inferred = capsOf(`${text} ${stack.map((s) => s.name).join(" ")}`).filter((c) => ["payments", "hosting", "db-auth", "email", "llm", "rag", "transcription", "tts", "video", "image-gen", "telegram-bot", "whatsapp", "pdf-report", "scraping"].includes(c));
  const price = str(raw?.price, 80);
  const needs = [...new Set([...declared, ...inferred, ...(price && !/free/i.test(price) ? ["payments"] : [])])];
  const allowed = new Set((brief?.pain?.quotes ?? []).map((q) => q.id));
  const evidenceIds = list(raw?.evidence_ids ?? raw?.evidence, 6, 120).filter((id) => allowed.has(id));
  const idea: Idea = {
    id: `${strategy}:${round}:${norm(name).slice(0, 24)}:${(seedOf(`${name}|${raw?.hook}`) % 46656).toString(36)}`,
    strategy, promptVersion, round, briefId: brief?.id,
    name, hook: str(raw?.hook ?? raw?.pitch, 200), buyer: str(raw?.buyer, 220), pain: str(raw?.pain, 300), offer: str(raw?.offer, 300), price, channel: str(raw?.channel, 240),
    mvp: str(raw?.mvp, 320), stack, needs, timeToFirstDollarDays: num(raw?.days_to_first_dollar ?? raw?.daysToFirstDollar, 1, 365, 30), difficulty: difficultyOf(raw?.difficulty),
    evidenceIds, firstQuests: list(raw?.quests ?? raw?.first_quests, 3, 160), topics: [], source: "claude", raw, edge: str(raw?.edge, 200) || undefined,
  };
  if (brief?.trend) {
    const ids = new Set(list(raw?.trend_ids, 6, 160));
    const sigs = brief.trend.signals.filter((x) => ids.has(x.id));
    const used = sigs.length ? sigs : brief.trend.signals.slice(0, 2);
    const now = Date.now();
    const heat = used.reduce((a, x) => a + 0.3 + x.rank, 0) * (1 + 0.6 * (new Set(used.map((x) => x.source)).size - 1)) * Math.max(0.25, 0.5 ** ((now - Math.max(...used.map((x) => x.at))) / 86_400_000 / 10));
    idea.trend = { label: str(raw?.trend, 80) || brief.trend.label, whyNow: str(raw?.why_now ?? raw?.whyNow, 240), signals: used.map((x) => ({ id: x.id, source: x.source, title: x.title, url: x.url })), heat: Math.round(heat * 100) / 100, earliness: brief.trend.earliness };
  }
  idea.topics = [...new Set([...topicsOf(`${idea.name} ${idea.buyer} ${idea.pain} ${idea.offer}`, needs), ...(brief?.audience?.topics ?? [])])];
  return idea;
}
/** A model's reply → ideas, matched to their briefs by id (or by order when the ids went missing). */
export function parseIdeas(text: string, briefs: Brief[], strategy: StrategyId, version: string, round: number, inv: Inventory): Idea[] {
  const recs = extractRecords(text, ["ideas"], ["name", "hook", "buyer"]);
  const out: Idea[] = [];
  recs.forEach((r, i) => {
    const b = briefs.find((x) => x.id === String(r?.brief ?? "")) ?? briefs[i];
    const idea = normalizeIdea(r, b, strategy, version, round, inv);
    if (idea && !out.some((x) => x.name.toLowerCase() === idea.name.toLowerCase())) out.push(idea);
  });
  return out;
}

// ── baselines: what the deck does today ─────────────────────────────────────────────────────────
function fromMix(m: Mix, strategy: StrategyId, round: number, inv: Inventory): Idea {
  const stack = m.how.map((h) => { const a = matchAsset(h.name, inv); return { name: h.name, role: h.role, assetId: a?.id, owned: !!a?.owned }; });
  const text = `${m.title} ${m.pitch} ${m.first_steps.join(" ")}`;
  return {
    id: `${strategy}:${round}:${norm(m.title).slice(0, 24)}:${(seedOf(m.id) % 46656).toString(36)}`, strategy, promptVersion: m.source === "template" ? "template" : "mixer", round,
    name: m.title, hook: m.pitch, buyer: "", pain: "", offer: m.pitch, price: "", channel: "", mvp: m.first_steps.join(" → "), stack, needs: capsOf(text),
    timeToFirstDollarDays: -1, difficulty: m.difficulty, evidenceIds: [], firstQuests: m.first_steps, topics: topicsOf(text), source: m.source === "template" ? "template" : "claude",
  };
}
type BaselineInput = { profile: Profile; gems: Gem[]; items: { id: string; name: string; cat?: string; state?: string; detail?: string; kind?: string }[] };
/** A0: today's deterministic sparks and template mixes, as ideas. */
export function baselineTemplate(inp: BaselineInput, inv: Inventory, seed: number, n = 12): Idea[] {
  const ings = collectIngredients({ profile: inp.profile, gems: inp.gems, items: inp.items });
  const mixes = templateMixes(forYouIngredients(ings, seed), "", seed, Math.ceil(n / 2)).map((m) => fromMix(m, "A0-template", 1, inv));
  const sp = sparks(inp.profile, inp.gems, seed, Math.floor(n / 2)).map((s): Idea => ({
    id: `A0-template:1:${norm(s.title).slice(0, 24)}:${(seedOf(s.id) % 46656).toString(36)}`, strategy: "A0-template", promptVersion: "spark", round: 1,
    name: s.title, hook: s.pitch, buyer: "", pain: "", offer: s.idea, price: "", channel: "", mvp: "", stack: s.uses.map((u) => { const a = matchAsset(u, inv); return { name: u, role: "", assetId: a?.id, owned: !!a?.owned }; }),
    needs: capsOf(s.idea), timeToFirstDollarDays: -1, difficulty: "week", evidenceIds: [], firstQuests: [], topics: topicsOf(s.idea), source: "template",
  }));
  return [...sp, ...mixes].slice(0, n);
}
/** A1: today's Claude Mixer prompt over the daily "for you" ingredients. Returns the prompt; parse with parseMixerReply. */
export function baselineMixerPrompt(inp: BaselineInput, seed: number, n = 12) {
  const ings = collectIngredients({ profile: inp.profile, gems: inp.gems, items: inp.items });
  const chosen = forYouIngredients(ings, seed);
  return { ...mixPrompt(chosen, "", n), ings: chosen };
}
export function parseMixerReply(text: string, ings: ReturnType<typeof collectIngredients>, round: number, inv: Inventory): Idea[] {
  return parseMixes(text, ings, "claude").map((m) => fromMix(m, "A1-mixer", round, inv));
}
