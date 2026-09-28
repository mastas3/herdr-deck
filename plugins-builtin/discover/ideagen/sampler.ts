// The coherent sampler: instead of gluing random ingredients, each strategy builds candidate "briefs" whose parts
// fit together (an audience, a real pain, an engine that can solve it, a channel that reaches them), scores them for
// compatibility × demand × strength, then picks a diverse set (no engine, audience or pain used over and over).
import type { Asset, Audience, Brief, Inventory, PainCorpus, PainPost, PainTheme, ProvenModel, StrategyId } from "./types";
import { terms } from "./evidence";
import { topicsOf } from "./inventory";
import type { Trend, TrendSet } from "./trends";

// ── seeded randomness ─────────────────────────────────────────────────────────────────────
export function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
export function seedOf(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

// ── compatibility ─────────────────────────────────────────────────────────────────────────
const GENERIC_TOPICS = new Set(["community", "business", "rag"]);
/** Languages say who can read it, not what it does: sharing one is a weak signal. */
const LANGUAGE_TOPICS = new Set(["hebrew", "russian"]);
const topicW = (t: string) => (LANGUAGE_TOPICS.has(t) ? 0.25 : GENERIC_TOPICS.has(t) ? 0.5 : 1);
/** Topic overlap between two parts, 0..1. Generic topics count half, languages a quarter. */
function topicFit(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  let hit = 0, tot = 0;
  for (const t of new Set(a)) { const w = topicW(t); tot += w; if (B.has(t)) hit += w; }
  return tot ? hit / tot : 0;
}
/** Does the engine do what these people need? Share of its capabilities they need, plus any domain overlap. */
/** Capabilities almost every project has: sharing one says little about fit. */
const GENERIC_CAPS = new Set(["llm", "mobile", "hosting", "db-auth", "analytics", "landing", "social-post", "community", "hebrew", "russian"]);
export function engineFit(e: Asset, need: { caps: string[]; topics: string[] }): number {
  const want = new Set(need.caps);
  const capHit = e.caps.filter((c) => want.has(c)).reduce((a, c) => a + (GENERIC_CAPS.has(c) ? 0.3 : 1), 0);
  if (!capHit) return 0;
  const capFit = Math.min(1, capHit / Math.min(3, Math.max(1, need.caps.filter((c) => !GENERIC_CAPS.has(c)).length || 1)));
  const domain = need.topics.filter((t) => !LANGUAGE_TOPICS.has(t) && !GENERIC_TOPICS.has(t));
  const topical = domain.length ? topicFit(domain, e.topics) : 0.5;
  // An engine that shares no subject with the audience (an OSINT lab for a Human Design crowd) barely fits.
  return Math.round((0.6 * capFit + 0.4 * topical) * (domain.length && topical === 0 ? 0.3 : 1) * 1000) / 1000;
}
/**
 * How well a brief's parts fit together, 0..1: the engine has to be about what the audience/pain is about and play
 * an engine/data role; the channel has to reach them; everything owned and ready counts extra.
 */
export function coherence(p: { audience?: Audience; pain?: PainTheme; engine?: Asset; channel?: Asset; gem?: Asset; model?: ProvenModel }): number {
  const need = [...(p.audience?.topics ?? []), ...(p.pain?.topics ?? [])];
  const parts: number[] = [];
  if (p.engine) {
    const topical = p.audience ? engineFit(p.engine, { caps: p.audience.caps, topics: need }) : need.length ? topicFit(need, p.engine.topics) : 0.5;
    const role = p.engine.roles.some((r) => r === "engine" || r === "data") ? 1 : 0.4;
    parts.push(0.75 * topical + 0.25 * role);
  }
  if (p.gem) parts.push(need.length ? Math.max(topicFit(need, p.gem.topics), p.engine ? topicFit(p.gem.topics, p.engine.topics) * 0.7 : 0) : 0.5);
  if (p.channel && p.audience) parts.push(p.audience.reach.includes(p.channel.id) ? 1 : 0.3);
  if (p.pain && p.audience) parts.push(p.pain.audience === p.audience.id ? 1 : topicFit(p.pain.topics, p.audience.topics));
  if (p.model && need.length) parts.push(p.model.fits.some((f) => need.includes(f)) ? 1 : 0.35);
  if (!parts.length) return 0;
  const ready = [p.engine, p.channel].filter(Boolean).every((a) => a!.owned && a!.ready) ? 1 : 0.85;
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * ready * 1000) / 1000;
}
/** 0..1: how much demand backs the brief (pain theme heat and volume; the audience's post volume and access). */
function demandOf(p: { pain?: PainTheme; audience?: Audience }, corpus?: PainCorpus): number {
  let d = 0.2;
  if (p.pain) d = Math.min(1, 0.35 + Math.log10(1 + p.pain.score) / 3 + p.pain.heat / 20 + Math.min(0.15, p.pain.n / 40));
  else if (p.audience && corpus) { const n = corpus.posts.filter((x) => x.audience === p.audience!.id).length; d = Math.min(1, 0.2 + Math.log10(1 + n) / 3); }
  if (p.audience) d = d * (0.6 + 0.4 * p.audience.access);
  return Math.round(d * 1000) / 1000;
}

// ── pain clusters: one real post as the anchor, plus the posts that say the same thing ──────────────────────
/** Share of the audience query's words a post contains (its title, text and where it was posted). */
export function postRelevance(p: PainPost, query: string) {
  const q = terms(query);
  if (!q.length) return 1;
  const t = new Set(terms(`${p.title} ${p.snippet} ${p.where ?? ""}`));
  // At least two of the query's words (or its only word) must appear: one shared word is usually a coincidence.
  const hit = q.filter((w) => t.has(w)).length;
  return hit >= Math.min(2, q.length) ? hit / q.length : Math.min(0.49, hit / q.length);
}
/**
 * Pain clusters per audience: the strongest on-topic posts (pain × engagement), each with up to two related posts
 * from the same audience. Keyword themes from Leads are kept too when they have real quotes.
 */
export function painClusters(corpus: PainCorpus, inv: Inventory, perAudience = 6): PainTheme[] {
  const out: PainTheme[] = [];
  for (const au of inv.audiences) {
    const queries = [au.query, ...corpus.queries.filter((q) => q.audience === au.id).map((q) => q.text)];
    const posts = corpus.posts.filter((p) => p.audience === au.id && p.pain >= 2 && p.snippet.length >= 60 && Math.max(...queries.map((q) => postRelevance(p, q))) >= 0.5)
      .sort((a, b) => b.pain * (1 + b.score) - a.pain * (1 + a.score));
    const used = new Set<string>();
    for (const anchor of posts) {
      if (out.filter((t) => t.audience === au.id).length >= perAudience) break;
      if (used.has(anchor.id)) continue;
      const at = new Set(terms(`${anchor.title} ${anchor.snippet}`));
      const related = posts.filter((p) => p.id !== anchor.id && !used.has(p.id)).map((p) => ({ p, o: terms(`${p.title} ${p.snippet}`).filter((w) => at.has(w)).length })).filter((x) => x.o >= 3).sort((a, b) => b.o - a.o).slice(0, 2).map((x) => x.p);
      for (const p of [anchor, ...related]) used.add(p.id);
      const quotes = [anchor, ...related];
      out.push({ id: `post:${anchor.id}`, audience: au.id, title: anchor.title, label: anchor.signals.join(", ") || "pain", idea: "", n: quotes.length, heat: Math.max(...quotes.map((q) => q.pain)), score: quotes.reduce((a, q) => a + q.score, 0), terms: [], quotes, topics: [...new Set([...au.topics, ...topicsOf(`${anchor.title} ${anchor.snippet}`)])] });
    }
  }
  for (const t of corpus.themes) {
    const au = inv.audiences.find((a) => a.id === t.audience);
    const good = t.quotes.filter((q) => au && postRelevance(q, au.query) >= 0.5);
    if (good.length >= 2 && !out.some((x) => x.quotes.some((q) => good.some((y) => y.id === q.id)))) out.push({ ...t, quotes: good });
  }
  return out;
}

// ── diverse picking (maximal marginal relevance over parts) ─────────────────────────────────────
type Cand = Omit<Brief, "id" | "strategy"> & { score: number };
export function pickDiverse(cands: Cand[], n: number, seed = 1): Cand[] {
  const r = rng(seed);
  const pool = cands.map((c) => ({ c, j: 0.85 + 0.3 * r() }));
  const used = new Map<string, number>();
  const keys = (c: Cand) => [c.engine && `e:${c.engine.id}`, c.audience && `a:${c.audience.id}`, c.pain && `p:${c.pain.id}`, c.gem && `g:${c.gem.id}`, c.model && `m:${c.model.id}`, c.channel && `c:${c.channel.id}`].filter(Boolean) as string[];
  const PEN: Record<string, number> = { e: 0.45, a: 0.7, p: 0.25, g: 0.3, m: 0.5, c: 0.85 };
  const out: Cand[] = [];
  while (out.length < n && pool.length) {
    let bi = -1, bs = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const { c, j } = pool[i];
      let s = c.score * j;
      for (const k of keys(c)) s *= PEN[k[0]] ** (used.get(k) ?? 0);
      if (s > bs) { bs = s; bi = i; }
    }
    const { c } = pool.splice(bi, 1)[0];
    out.push(c);
    for (const k of keys(c)) used.set(k, (used.get(k) ?? 0) + 1);
  }
  return out;
}

// ── proven models and boring niches (for E and H) ───────────────────────────────────────────────
const PROVEN: ProvenModel[] = [
  { id: "pdf-report", name: "Personalized report sold per unit", pattern: "Customer enters data → gets a beautiful personalized PDF/web report instantly; one-time price", examples: "astrology report shops on Etsy, Gumroad chart readings", price: "$15–49 one-time", fits: ["hd", "astro", "esoteric", "matching"] },
  { id: "daily-app", name: "Daily personalized content subscription", pattern: "A short personalized daily message/push based on the user's data; freemium with a monthly plan", examples: "Co–Star, The Pattern", price: "$5–10/month", fits: ["hd", "astro", "esoteric", "matching"] },
  { id: "clip-service", name: "AI repurposing tool for creators", pattern: "Upload long content → get clips, captions, posts; credits per month", examples: "Opus Clip, Descript", price: "$19–49/month", fits: ["video", "creators", "voice"] },
  { id: "pro-whitelabel", name: "White-label tool for practitioners", pattern: "Professionals use your engine to serve their own clients under their brand (B2B2C)", examples: "tools sold to coaches/therapists, white-label chart software", price: "$29–99/month per practitioner", fits: ["hd", "astro", "esoteric", "business"] },
  { id: "alerts", name: "Paid alerts on a niche data feed", pattern: "Watch a public data source and alert paying subscribers when something relevant appears", examples: "tender/grant alert services, job alert boards", price: "$20–100/month", fits: ["business", "osint", "hebrew", "forecasting"] },
  { id: "done-for-you", name: "Productized done-for-you service", pattern: "Fixed scope, fixed price, delivered mostly by your own automation", examples: "productized design/content agencies", price: "$200–1,000 per delivery", fits: ["business", "video", "community", "creators"] },
  { id: "chat-archive", name: "Chat with an expert's archive", pattern: "A paid chatbot that answers from one creator's/community's content with citations; revenue share with the creator", examples: "Delphi-style creator clones, course Q&A bots", price: "$9–29/month or creator license", fits: ["rag", "video", "creators", "hd", "community"] },
  { id: "bot-sub", name: "Telegram/WhatsApp bot subscription", pattern: "A bot in the chat app people already use; paid tier unlocks more", examples: "paid Telegram bots, WhatsApp assistants", price: "$3–15/month", fits: ["russian", "hebrew", "community", "hd"] },
  { id: "template-pack", name: "Template / asset pack", pattern: "Downloadable pack (templates, prompts, graphics) for a niche; sold once, updated", examples: "Notion templates, Canva packs, prompt packs", price: "$19–79 one-time", fits: ["business", "hd", "creators", "esoteric"] },
  { id: "cohort", name: "Paid workshop / cohort", pattern: "Live group session teaching a practical skill, with a tool as the take-home", examples: "Maven cohorts, live workshops", price: "$49–299 per seat", fits: ["hd", "agents", "business", "creators"] },
  { id: "directory", name: "Niche directory with paid listings", pattern: "Curated directory of providers; providers pay to be featured", examples: "niche job boards, practitioner directories", price: "$20–50/month per listing", fits: ["hd", "esoteric", "community", "business"] },
  { id: "devtool-oss", name: "Open-source core + paid hosted/pro", pattern: "Free OSS tool builds trust; pro features or hosting are paid", examples: "Plausible, Cal.com, many dev tools", price: "$10–30/month", fits: ["agents", "devtools", "osint"] },
  { id: "game-iap", name: "Casual web game with sponsors/IAP", pattern: "Free viral browser game; revenue from portal rev-share, sponsors or cosmetic purchases", examples: "CrazyGames/Poki titles, branded advergames", price: "sponsorship $500+ or rev-share", fits: ["games", "hebrew", "russian"] },
  { id: "compat-quiz", name: "Viral compatibility quiz with paid deep-dive", pattern: "Free shareable quiz for two people; paid detailed report", examples: "couples quizzes, 16Personalities premium", price: "$9–29 per report", fits: ["matching", "hd", "astro"] },
];
const BORING: { id: string; who: string; job: string; topics: string[]; caps?: string[] }[] = [
  { id: "tenders", who: "small Israeli companies bidding on government tenders", job: "find relevant tenders and prepare bid documents without reading hundreds of PDFs", topics: ["business", "hebrew"], caps: ["tenders", "llm", "pdf-report"] },
  { id: "realestate", who: "real-estate agents who post listings in Facebook groups", job: "post listings and answer the same questions again and again", topics: ["business", "community", "hebrew"], caps: ["fb-archive", "social-post", "llm"] },
  { id: "clinics", who: "private clinics and therapists", job: "cut no-shows with reminders and rebooking on WhatsApp", topics: ["business", "hebrew"], caps: ["whatsapp", "llm", "booking"] },
  { id: "accountants", who: "small accounting offices", job: "chase clients for monthly documents and receipts", topics: ["business", "hebrew"], caps: ["email", "llm", "whatsapp"] },
  { id: "restaurants", who: "small restaurants and food stands", job: "keep menus, photos and reviews up to date across apps", topics: ["business", "hebrew"], caps: ["llm", "image-gen", "scraping"] },
  { id: "zimmers", who: "B&B (zimmer) owners in Israel", job: "fill empty weekdays and answer booking questions", topics: ["business", "hebrew", "geo"], caps: ["whatsapp", "llm", "maps-geo"] },
  { id: "contractors", who: "home renovation contractors", job: "turn a WhatsApp photo + voice note into a clean quote", topics: ["business", "hebrew", "voice"], caps: ["transcription", "llm", "pdf-report"] },
  { id: "podcast-ops", who: "small podcast production studios", job: "deliver show notes, clips and subtitles for every episode on deadline", topics: ["business", "video", "creators"], caps: ["transcription", "video", "rag"] },
  { id: "community-ops", who: "paid community owners (Facebook/Telegram)", job: "moderate, answer repeat questions and surface the best posts", topics: ["community", "business"], caps: ["fb-archive", "rag", "telegram-bot"] },
  { id: "course-sellers", who: "Hebrew-speaking course creators", job: "subtitle, clip and market their course videos", topics: ["video", "hebrew", "creators"], caps: ["transcription", "video", "tts"] },
];

// ── building briefs per strategy ───────────────────────────────────────────────────────────────
type SampleCtx = { inv: Inventory; corpus: PainCorpus; seed: number; clusters?: PainTheme[]; trends?: TrendSet };
const ownedEngines = (inv: Inventory) => inv.assets.filter((a) => a.owned && a.ready && a.kind === "project" && a.roles.some((r) => r === "engine" || r === "data") && a.strength >= 0.4);
const gems = (inv: Inventory) => inv.assets.filter((a) => a.kind === "repo" && a.caps.length > 0);
const channelsFor = (inv: Inventory, au: Audience) => inv.assets.filter((a) => au.reach.includes(a.id) && a.kind !== "project");
const bestBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce<T | undefined>((b, x) => (b === undefined || f(x) > f(b) ? x : b), undefined);
const supportFor = (inv: Inventory, engine: Asset | undefined, topics: string[]) =>
  inv.assets.filter((a) => a.owned && a.ready && a.kind === "project" && a.id !== engine?.id && topicFit(topics, a.topics) > 0.3).sort((a, b) => b.strength - a.strength).slice(0, 2);
const audienceOf = (inv: Inventory, id: string) => inv.audiences.find((a) => a.id === id);

function finish(strategy: StrategyId, picked: Cand[]): Brief[] {
  return picked.map((c, i) => { const { score, ...rest } = c; return { id: `${strategy}-${i + 1}`, strategy, ...rest }; });
}

export function briefsFor(strategy: StrategyId, n: number, ctx: SampleCtx): Brief[] {
  const { inv, corpus } = ctx;
  const r = rng(ctx.seed + seedOf(strategy));
  const engines = ownedEngines(inv);
  const cands: Cand[] = [];
  const clusters = ctx.clusters ?? painClusters(corpus, inv);
  const engineFor = (topics: string[], caps: string[] = []) => {
    const fits = engines.map((e) => ({ e, f: caps.length ? engineFit(e, { caps, topics }) : topicFit(topics, e.topics) })).filter((x) => x.f > 0);
    return bestBy(fits, (x) => x.f * 0.7 + x.e.strength * 0.3)?.e;
  };
  switch (strategy) {
    case "A2-random-schema": {
      // The control: random ingredients, no fit, no demand — only the new idea schema.
      const pool = inv.assets.filter((a) => (a.owned && a.ready && ["project", "service", "account", "mcp"].includes(a.kind)) || a.kind === "repo");
      for (let i = 0; i < n; i++) {
        const pick = () => pool[Math.floor(r() * pool.length)];
        const e = pick(), s = [pick(), pick()];
        cands.push({ engine: e, support: s, compat: coherence({ engine: e }), demand: 0.2, score: 1 });
      }
      return finish(strategy, cands);
    }
    case "B-pain":
    case "W-hybrid": {
      for (const t of clusters) {
        const au = audienceOf(inv, t.audience);
        const topics = [...t.topics, ...(au?.topics ?? [])];
        for (const e of engines.filter((x) => (au ? engineFit(x, { caps: au.caps, topics }) : topicFit(topics, x.topics)) > 0).slice(0, 40)) {
          const ch = au ? bestBy(channelsFor(inv, au), (c) => c.strength) : undefined;
          const compat = coherence({ audience: au, pain: t, engine: e, channel: ch });
          const demand = demandOf({ pain: t, audience: au }, corpus);
          cands.push({ audience: au, pain: t, engine: e, channel: ch, support: supportFor(inv, e, topics), compat, demand, score: compat ** 1.2 * demand * (0.5 + e.strength / 2) });
        }
        // A pain nobody's engine fits yet is still worth one "build new" brief.
        if (!engines.some((x) => (au ? engineFit(x, { caps: au.caps, topics }) : topicFit(topics, x.topics)) > 0)) cands.push({ audience: au, pain: t, compat: 0.3, demand: demandOf({ pain: t, audience: au }, corpus), score: 0.3 * demandOf({ pain: t, audience: au }, corpus) * 0.5 });
      }
      if (strategy === "W-hybrid") {
        // Hybrid: pain-first skeleton, plus a proven model that fits the audience, so buyer + price come pre-shaped.
        for (const c of cands) { const need = [...(c.pain?.topics ?? []), ...(c.audience?.topics ?? [])]; c.model = bestBy(PROVEN, (m) => topicFit(need, m.fits) + r() * 0.2); }
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
    case "C-audience": {
      for (const au of inv.audiences) for (const job of au.jobs) {
        const e = engineFor([...au.topics, ...topicsOfJob(job)], au.caps);
        const ch = bestBy(channelsFor(inv, au), (c) => c.strength + r() * 0.1);
        const pain = clusters.filter((t) => t.audience === au.id)[au.jobs.indexOf(job) % Math.max(1, clusters.filter((t) => t.audience === au.id).length)];
        const compat = coherence({ audience: au, engine: e, channel: ch });
        const demand = demandOf({ audience: au }, corpus);
        cands.push({ audience: au, engine: e, channel: ch, pain, angle: job, support: supportFor(inv, e, au.topics), compat, demand, score: compat * (0.3 + au.access) * (0.5 + demand) });
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
    case "D-asset": {
      const strong = engines.filter((e) => e.strength >= 0.55);
      for (const e of strong) for (const au of inv.audiences) {
        const fit = engineFit(e, { caps: au.caps, topics: au.topics });
        if (fit <= 0) continue;
        const compat = coherence({ audience: au, engine: e });
        cands.push({ engine: e, audience: au, compat, demand: demandOf({ audience: au }, corpus), score: e.strength ** 1.5 * compat * (0.4 + au.access) });
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
    case "E-remix": {
      for (const m of PROVEN) for (const au of inv.audiences) {
        const fit = topicFit(m.fits, au.topics);
        if (fit <= 0) continue;
        const e = engineFor([...au.topics, ...m.fits], au.caps);
        const compat = coherence({ audience: au, engine: e, model: m });
        cands.push({ model: m, audience: au, engine: e, pain: clusters.find((t) => t.audience === au.id), compat, demand: demandOf({ audience: au }, corpus), score: compat * (0.4 + au.access) * (0.6 + fit / 2) });
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
    case "F-gem": {
      const gs = gems(inv).sort((a, b) => b.strength - a.strength).slice(0, 120);
      for (const t of clusters) for (const g of gs) {
        const fit = topicFit(t.topics, g.topics);
        if (fit <= 0) continue;
        const au = audienceOf(inv, t.audience);
        const e = engineFor([...t.topics, ...g.topics], au?.caps ?? []);
        const compat = coherence({ audience: au, pain: t, gem: g, engine: e });
        const demand = demandOf({ pain: t, audience: au }, corpus);
        cands.push({ gem: g, pain: t, audience: au, engine: e, compat, demand, score: compat * demand * (0.4 + g.strength) });
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
    case "G-constraint": {
      const constraint = "Reach $1,000 in revenue within 30 days, using at most 3 ingredients the user already owns, no new infrastructure.";
      for (const au of inv.audiences) {
        const chs = channelsFor(inv, au);
        for (const e of engines.filter((x) => engineFit(x, { caps: au.caps, topics: au.topics }) > 0)) {
          const ch = bestBy(chs, (c) => c.strength + r() * 0.1);
          const compat = coherence({ audience: au, engine: e, channel: ch });
          cands.push({ audience: au, engine: e, channel: ch, pain: clusters.find((t) => t.audience === au.id), constraint, compat, demand: demandOf({ audience: au }, corpus), score: compat * au.access * (0.5 + e.strength) });
        }
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
    case "T-hot":
    case "T-early": {
      // Trends: the hottest (or earliest) trends that aren't pure noise (price bets, a single repo with no topic).
      const ts = (ctx.trends?.trends ?? []).filter((t) => !t.sources.every((x) => x === "polymarket") && t.signals.length && !/price|bitcoin/.test(t.label));
      const mine = [...new Set(inv.assets.filter((a) => a.owned && a.kind === "project").flatMap((a) => a.topics))];
      const fit = (t: Trend) => 0.3 + (t.topics.length ? t.topics.filter((x) => mine.includes(x)).length / t.topics.length : 0);
      const ranked = strategy === "T-hot" ? [...ts].sort((a, b) => b.heat * fit(b) - a.heat * fit(a)) : [...ts].filter((t) => t.heat >= 0.5).sort((a, b) => b.earliness * fit(b) - a.earliness * fit(a));
      const pick = ranked.slice(0, n * 2);
      for (const t of pick) {
        const topics = t.topics;
        const au = bestBy(inv.audiences.filter((a) => topicFit(topics, a.topics) > 0), (a) => topicFit(topics, a.topics) + a.access * 0.5);
        const e = engineFor([...topics, ...(au?.topics ?? [])], au?.caps ?? []);
        const score = (strategy === "T-hot" ? t.heat : t.earliness * 10) * (0.5 + (au ? 0.5 : 0));
        cands.push({ trend: trendBrief(t), audience: au, engine: e, compat: coherence({ audience: au, engine: e }), demand: Math.min(1, t.heat / 10), score });
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
    case "H-boring": {
      const caps = new Set(inv.assets.filter((a) => a.owned && a.ready).flatMap((a) => a.caps));
      for (const b of BORING) {
        const e = engineFor(b.topics, b.caps ?? []);
        const au = b.topics.includes("hebrew") ? inv.audiences.find((a) => a.id === "il-smb") : undefined;
        // Only a pain that is about this job counts as its evidence.
        const pain = clusters.find((t) => t.quotes.some((q) => terms(b.job).filter((w) => terms(`${q.title} ${q.snippet}`).includes(w)).length >= 2));
        const capFit = ["llm", "whatsapp", "scraping", "telegram-bot", "transcription"].filter((c) => caps.has(c)).length / 5;
        const compat = coherence({ audience: au, engine: e });
        cands.push({ angle: `${b.who}: ${b.job}`, engine: e, audience: au, pain, compat, demand: demandOf({ audience: au }, corpus), score: (0.4 + compat) * (0.5 + capFit) * (0.7 + r() * 0.3) });
      }
      return finish(strategy, pickDiverse(cands, n, ctx.seed));
    }
  }
  return [];
}
function trendBrief(t: Trend): NonNullable<Brief["trend"]> {
  return { id: t.id, label: t.label, heat: t.heat, earliness: t.earliness, signals: t.signals.slice(0, 4).map((x) => ({ id: x.id, source: x.source, title: x.title, url: x.url, at: x.at, metric: x.metric, rank: x.rank })) };
}
const topicsOfJob = (job: string) => (/voice|call/.test(job) ? ["voice"] : /video|shorts|clip|subtitle/.test(job) ? ["video"] : /search|archive|answer|past posts/.test(job) ? ["rag"] : /compat|partner/.test(job) ? ["matching"] : []);
