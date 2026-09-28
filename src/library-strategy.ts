// Founder Library → strategy. Given a product plan (buyer, offer, price, channel, business type), find the founder
// cards most like it and say what those founders actually did: what they sold and for how much, the revenue they
// claim, how long the first revenue took, where the first customers came from, what failed, when the video came out,
// each with a link to the moment it was said. Then count across them ("5 of 7 got first customers via Reddit") and
// flag a plan whose price or channel is far from theirs.
//
// Only what the cards say: no number here is computed from a guess. Revenue is always "claimed". Matching is plain
// word and field overlap (no model), so it is instant and can run on every gallery card, kit, quest board and plan.
import { fmtPublished, fmtT, inferChannel, linkAt, oldLabel, recencyWeight, type Card, type Channel } from "./library-card";

export type Target = { name?: string; hook?: string; buyer?: string; offer?: string; price?: string; channel?: string; btype?: string; text?: string };
export type Moment = { text: string; at: string; link: string };
export type Comparable = {
  id: string; name: string; title: string; url: string; date?: string; published: string; old: string; btype: string;
  sells: string | null; customer: string | null; price?: Moment; revenue?: Moment & { perMonth?: number }; ttfr?: Moment;
  first: (Moment & { channel: Channel })[]; growth: (Moment & { channel: Channel })[]; failed: Moment[]; score: number; match: string[];
  /** Sells something close (two subject words, or subject and buyer), not only the same business shape. */
  close: boolean;
};
export type Price = { value: number; period: "week" | "month" | "year" | "once"; currency: string };
export type Signals = { n: number; channels: { channel: Channel; label: string; n: number }[]; withChannel: number; topUsing: number; price?: { period: Price["period"]; currency: string; median: number; min: number; max: number; n: number }; revenue?: { min: number; max: number; n: number }; ttfr: { name: string; text: string; link: string }[] };
export type Comparables = { target: { btype?: string; audience: "b2b" | "b2c"; channels: Channel[]; price?: Price }; comparables: Comparable[]; signals: Signals; summary: string[]; checks: string[] };

export const CH_LABEL: Record<string, string> = {
  reddit: "Reddit", x_twitter: "X", tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram", linkedin: "LinkedIn", facebook_groups: "Facebook groups", product_hunt: "Product Hunt",
  hacker_news: "Hacker News", seo: "SEO", content_blog: "a blog", newsletter: "a newsletter", cold_email: "cold email", cold_calls: "cold calls", door_to_door: "door to door", in_person: "in person",
  friends_network: "their network", existing_audience: "their own audience", communities: "online communities", paid_ads: "paid ads", partnerships: "partnerships", affiliates: "affiliates",
  app_store: "the app store", marketplace: "a marketplace", word_of_mouth: "word of mouth", press: "press", influencers: "influencers", cold_dms: "cold DMs", other: "other",
};

// ── words ───────────────────────────────────────────────────────────────────────────
const STOP = new Set(("the a an and or of to in on for with from by as at is are be it its this that their them they you your our who what how per via into than then also " +
  "app apps tool tools platform business businesses product products service services online small simple people users user customers customer buyers buyer based help helps make makes " +
  "get gets new best first free one two three month monthly year yearly week weekly price paid pay plan plans use using used want need like more most any all each every " +
  "audience real quick actionable wait second day days today hour hours minute minutes time link turn making life thing things way start can page").split(" "));
/** A light stem so "repurposing" meets "repurposes" and "clips" meets "clip". */
const stem = (w: string) => w.replace(/(?<=.{4})(ing|ed|es|s)$/, "");
export function terms(s: unknown): string[] {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}
const nul = (s: string | null | undefined) => (s && !/^\[?null\]?$/i.test(s.trim()) ? s : null);

// ── what a plan is ──────────────────────────────────────────────────────────────────
const BTYPE_RULES: [RegExp, string][] = [
  [/\b(ios|android|mobile app|app store|iphone app|play store)\b/i, "mobile_app"], [/\bnewsletter\b/i, "newsletter"],
  [/\b(course|cohort|e-?book|templates?|guide|workshop|masterclass|notion template)\b/i, "info_product"],
  [/\b(agency|done[- ]for[- ]you|consult\w*|we (do|write|edit|build) (it|them) for)\b/i, "service_agency"],
  [/\bmarketplace\b/i, "marketplace"], [/\b(community|membership club|discord server)\b/i, "community"],
  [/\b(shop|e-?commerce|etsy|merch|physical product|printed)\b/i, "ecommerce"],
  [/\b(saas|dashboard|api|bot|extension|web ?app|software|alerts?|automation|studio|generator|tracker|scout|monitor|subscription)\b/i, "saas"],
];
export const inferBtype = (t: Target) => t.btype ?? BTYPE_RULES.find(([re]) => re.test(`${t.name ?? ""} ${t.offer ?? ""} ${t.hook ?? ""} ${t.text ?? ""}`))?.[1];
const B2B = /\b(owners?|compan(y|ies)|business(es)?|agenc(y|ies)|freelancers?|teams?|b2b|clinics?|firms?|startups?|brands?|shops|stores|contractors?|founders?|developers?|admins?|studios?|creators?|coaches|podcasters?|marketers?|recruiters?|sellers|landlords|realtors?|restaurants?|schools?)\b/i;
export const audienceOf = (buyer?: string | null) => (B2B.test(buyer ?? "") ? "b2b" : "b2c");
/** Every channel a plan's channel text names ("Facebook groups + 10 DMs on WhatsApp" → facebook_groups, cold_dms). */
export function channelsOf(text?: string): Channel[] {
  const out = new Set<Channel>();
  for (const part of String(text ?? "").split(/\s*(?:[+;,]|(?<!\br)\/|—| - |\band\b|\bthen\b)\s*/i)) {
    if (part.trim().length < 3) continue;
    const ch = inferChannel(undefined, part);
    if (ch !== "other") out.add(ch);
    else if (/whatsapp|telegram/i.test(part)) out.add(/\bdms?\b|direct|message|outreach/i.test(part) ? "cold_dms" : "communities");
  }
  return [...out];
}
/** The first price a text states: "$9.99 a month" → {9.99, month, $}. Weekly, yearly and one-time are kept apart (never converted). */
export function parsePrice(text?: string | null): Price | undefined {
  const s = String(text ?? "");
  const m = s.match(/([$€£₪]|\bUSD\b|\bNIS\b|\bILS\b)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k\b)?\s?(₪|NIS\b|ILS\b|USD\b|dollars?|shekels?|euros?)?/i);
  if (!m || (!m[1] && !m[4])) return undefined;
  const value = Number(m[2].replace(/,/g, "")) * (m[3] ? 1000 : 1);
  if (!(value > 0)) return undefined;
  const cur = `${m[1] ?? ""}${m[4] ?? ""}`.toLowerCase();
  const currency = /₪|nis|ils|shekel/.test(cur) ? "₪" : /€|euro/.test(cur) ? "€" : /£/.test(cur) ? "£" : "$";
  const after = s.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 24).toLowerCase();
  const period = /^\s*(\/\s?(wk|week)|a week|per week|weekly)/.test(after) ? "week" : /^\s*(\/\s?(mo|month)|a month|per month|monthly|\/m\b|for the month)/.test(after) ? "month"
    : /^\s*(\/\s?(yr|year)|a year|per year|yearly|annual)/.test(after) ? "year" : "once";
  return { value, period, currency };
}
const PER: Record<Price["period"], string> = { week: " a week", month: " a month", year: " a year", once: "" };
export const fmtPrice = (p: { value: number; currency: string; period: Price["period"] }) => `${p.currency}${p.value % 1 ? p.value.toFixed(2) : p.value.toLocaleString("en-US")}${PER[p.period]}`;
const money = (n: number) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`);
const RELATED: string[][] = [["saas", "mobile_app"], ["info_product", "content_media", "newsletter", "community"], ["service_agency", "local_business"], ["ecommerce", "marketplace"]];

// ── matching ────────────────────────────────────────────────────────────────────────
type Doc = { card: Card; topic: Set<string>; buyer: Set<string> };
function idfOf(docs: Doc[]) {
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set([...d.topic, ...d.buyer])) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  // A word on more than one card in eight says nothing about what a business is ("video" on a video channel).
  const idf = (w: string) => (n >= 16 && (df.get(w) ?? 0) > n / 8 ? 0 : Math.log(1 + n / (1 + (df.get(w) ?? 0))));
  // Two words each on about one card in two (or rarer) make a full match, whatever the library's size.
  return Object.assign(idf, { full: 2 * Math.log(1 + n / 2) });
}
/**
 * How strongly a card shares the plan's words: the rarity of each shared word, summed, where two rare words make a
 * full match (so a long offer text isn't diluted by its own length). 0..1, plus the words it shared.
 */
function overlap(want: string[], have: Set<string>, idf: ((w: string) => number) & { full: number }) {
  const hit = [...new Set(want)].filter((w) => have.has(w) && idf(w) > 0).sort((a, b) => idf(b) - idf(a));
  return { v: Math.min(1, hit.reduce((n, w) => n + idf(w), 0) / Math.max(1, idf.full)), hit };
}
const moment = (c: Card, text: string, t: number | null | undefined): Moment => ({ text, at: t ? fmtT(t) : "", link: linkAt(c.url, t) });

/** The founder cards most like a plan, best first, with what they did. Pure: pass the cards in. */
export function findComparables(cards: Card[], target: Target, o: { k?: number; now?: number; min?: number } = {}): Comparables {
  const now = o.now ?? Date.now();
  const btype = inferBtype(target), audience = audienceOf(target.buyer), channels = channelsOf(target.channel), price = parsePrice(target.price);
  const docs: Doc[] = cards.filter((c) => c.kind === "founder_story" || nul(c.business)).map((c) => ({
    card: c, topic: new Set(terms(`${c.business ?? ""} ${c.sells ?? ""} ${c.title} ${c.stack.slice(0, 6).join(" ")}`)), buyer: new Set(terms(`${nul(c.customer) ?? ""} ${c.sells ?? ""}`)),
  }));
  const idf = idfOf(docs);
  // The subject is what is sold (name and offer); a hook's selling words would match anything.
  const topicWords = terms(`${target.name ?? ""} ${target.offer ?? ""} ${target.text ?? ""}`), buyerWords = terms(target.buyer);
  const scored = docs.map(({ card: c, topic, buyer }) => {
    const t = overlap(topicWords, topic, idf), b = overlap(buyerWords, buyer, idf);
    const sameType = !!btype && c.btype === btype, near = !!btype && !sameType && RELATED.some((g) => g.includes(btype) && g.includes(c.btype));
    const theirCh = new Set([...c.first, ...c.growth].map((x) => x.channel).filter(Boolean) as Channel[]);
    const chHit = channels.filter((x) => theirCh.has(x));
    const cp = parsePrice(c.price ? `${c.price.text} ${c.price.quote ?? ""}` : "");
    const band = !!price && !!cp && cp.period === price.period && cp.currency === price.currency && cp.value <= price.value * 3 && cp.value >= price.value / 3;
    const aud = audienceOf(nul(c.customer)) === audience;
    const subs = !!price && !!cp && price.period !== "once" && cp.period !== "once";
    // Subject words weigh most (one rare shared word like "podcast" already counts), then the buyer, then the shape
    // of the business: type, audience, subscription, channel and price band.
    const subj = t.v, who = b.v;
    const shape = [sameType || near, aud && subs, chHit.length > 0, band].filter(Boolean).length;
    const raw = 0.42 * subj + 0.18 * who + (sameType ? 0.14 : near ? 0.06 : 0) + (aud ? 0.05 : 0) + (subs ? 0.05 : 0) + (chHit.length ? 0.08 : 0) + (band ? 0.06 : 0);
    const match = [
      ...(t.hit.length ? [`about ${t.hit.slice(0, 3).join(", ")}`] : []), ...(b.hit.length ? [`buyers: ${b.hit.slice(0, 2).join(", ")}`] : []),
      ...(sameType ? [`same type (${c.btype.replace(/_/g, " ")})`] : []), ...(aud && subs ? [`${audience === "b2b" ? "business" : "consumer"} subscription`] : []),
      ...(chHit.length ? [`same channel (${chHit.map((x) => CH_LABEL[x]).join(", ")})`] : []), ...(band ? ["similar price"] : []),
    ];
    // A comparable shares the plan's subject (two words, or one and the buyer), two buyer words, or two traits of its
    // shape. One shared word alone is too often a coincidence ("generator" is also a Human Design type).
    const close = t.hit.length >= 1 && new Set([...t.hit, ...b.hit]).size >= 2;
    const related = close || b.hit.length >= 2 || shape >= 2;
    return { c, score: related ? raw * recencyWeight(c.date, now) : 0, match, close };
  }).filter((x) => x.score >= (o.min ?? 0.14)).sort((a, b) => b.score - a.score).slice(0, o.k ?? 6);
  const comparables: Comparable[] = scored.map(({ c, score, match, close }) => ({
    id: c.id, name: nul(c.business) ?? c.title, title: c.title, url: c.url, date: c.date, published: fmtPublished(c.date), old: oldLabel(c.date, now), btype: c.btype,
    sells: nul(c.sells), customer: nul(c.customer),
    price: c.price ? moment(c, c.price.quote ?? c.price.text, c.price.t) : undefined,
    revenue: c.revenue ? { ...moment(c, c.revenue.quote ?? c.revenue.text, c.revenue.t), perMonth: c.revenue.perMonth } : undefined,
    ttfr: c.ttfr ? moment(c, c.ttfr.text, c.ttfr.t) : undefined,
    // Named channels first: an "other" line is sometimes a milestone rather than a tactic.
    first: [...c.first].sort((a, b) => Number(a.channel === "other") - Number(b.channel === "other")).slice(0, 3).map((x) => ({ ...moment(c, x.text, x.t), channel: x.channel ?? "other" })),
    growth: c.growth.filter((x) => x.channel !== "other").slice(0, 2).map((x) => ({ ...moment(c, x.text, x.t), channel: x.channel ?? "other" })),
    failed: c.failed.slice(0, 2).map((x) => moment(c, x.text, x.t)),
    score: Math.round(score * 100) / 100, match, close,
  }));
  const signals = signalsOf(scored.map((x) => x.c), price);
  const out: Comparables = { target: { btype, audience, channels, price }, comparables, signals, summary: [], checks: [] };
  out.summary = summaryLines(out);
  out.checks = strategyChecks(out);
  return out;
}

// ── across the comparables ──────────────────────────────────────────────────────────
const TIMEISH = /\b(day|days|week|weeks|month|months|year|years|hours?|minutes?|launch|immediately|first|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\b/i;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function signalsOf(cs: Card[], want?: Price): Signals {
  const tally = new Map<Channel, number>();
  const withCh = cs.filter((c) => c.first.some((x) => x.channel && x.channel !== "other"));
  for (const c of withCh) for (const ch of new Set(c.first.map((x) => x.channel).filter((x) => x && x !== "other") as Channel[])) tally.set(ch, (tally.get(ch) ?? 0) + 1);
  const channels = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([channel, n]) => ({ channel, label: CH_LABEL[channel] ?? channel, n }));
  const top = new Set(channels.slice(0, 2).map((c) => c.channel));
  const topUsing = withCh.filter((c) => c.first.some((x) => x.channel && top.has(x.channel))).length;
  const prices = cs.map((c) => parsePrice(c.price ? `${c.price.text} ${c.price.quote ?? ""}` : "")).filter((p): p is Price => !!p);
  // The period to compare in: the plan's own when comparables use it, else the most common one.
  const groups = new Map<string, Price[]>();
  for (const p of prices) { const k = `${p.currency}|${p.period}`; groups.set(k, [...(groups.get(k) ?? []), p]); }
  const wantKey = want && [...groups.keys()].find((k) => k.endsWith(`|${want.period}`) && k.startsWith(want.currency)) || want && [...groups.keys()].find((k) => k.endsWith(`|${want.period}`));
  const best = (wantKey && groups.get(wantKey)) || [...groups.values()].sort((a, b) => b.length - a.length)[0];
  const revs = cs.map((c) => c.revenue?.perMonth).filter((x): x is number => !!x && x > 0);
  return {
    n: cs.length, channels, withChannel: withCh.length, topUsing,
    price: best?.length ? { period: best[0].period, currency: best[0].currency, median: median(best.map((p) => p.value)), min: Math.min(...best.map((p) => p.value)), max: Math.max(...best.map((p) => p.value)), n: best.length } : undefined,
    revenue: revs.length ? { min: Math.min(...revs), max: Math.max(...revs), n: revs.length } : undefined,
    // Only answers that read as a time ("3 weeks", "day one"); some cards hold an amount there instead.
    ttfr: cs.filter((c) => c.ttfr && TIMEISH.test(c.ttfr.text)).map((c) => ({ name: nul(c.business) ?? c.title, text: c.ttfr!.text, link: linkAt(c.url, c.ttfr!.t) })),
  };
}
/** The counts, in plain sentences (no sentence without a count behind it). */
export function summaryLines(r: Comparables): string[] {
  const s = r.signals, out: string[] = [];
  if (!s.n) return out;
  if (!r.comparables.some((c) => c.close)) out.push("No founder in the library sells something close to this; these share its shape (type, buyer, price or channel), so treat them as loose guides.");
  if (s.channels.length && s.withChannel) {
    const top = s.channels.slice(0, 2);
    out.push(`${s.topUsing} of ${s.withChannel} comparable founders who say where their first customers came from got them via ${top.map((t) => t.label).join(" or ")}.`);
  }
  if (s.price) out.push(`${s.price.n === 1 ? "One comparable states" : `${s.price.n} comparables state`} a price${s.price.period === "once" ? "" : PER[s.price.period]}: ${s.price.n > 2 ? `median ${fmtPrice({ ...s.price, value: s.price.median })}, range ${fmtPrice({ ...s.price, value: s.price.min })}–${fmtPrice({ ...s.price, value: s.price.max })}` : s.price.n === 2 ? (s.price.min === s.price.max ? `both ${fmtPrice({ ...s.price, value: s.price.min })}` : `${fmtPrice({ ...s.price, value: s.price.min })} and ${fmtPrice({ ...s.price, value: s.price.max })}`) : fmtPrice({ ...s.price, value: s.price.median })}.`);
  if (s.revenue) out.push(`Claimed revenue (their words, unverified): ${s.revenue.n > 1 ? `${money(s.revenue.min)}–${money(s.revenue.max)} a month across ${s.revenue.n}` : `${money(s.revenue.max)} a month (one founder)`}.`);
  if (s.ttfr.length) out.push(`Time to first revenue, as told: ${s.ttfr.slice(0, 3).map((x) => `${x.name} "${x.text}"`).join("; ")}.`);
  const old = r.comparables.filter((c) => c.old).length;
  if (old) out.push(`${old} of ${s.n} are older stories (over three years): check their channels still work.`);
  return out;
}
/** A short note when the plan's price or channel is far from what comparables did. Never a number they didn't state. */
export function strategyChecks(r: Comparables): string[] {
  const out: string[] = [], s = r.signals, p = r.target.price;
  if (p && s.price && s.price.n >= 2 && s.price.period === p.period) {
    const range = s.price.min === s.price.max ? fmtPrice({ ...s.price, value: s.price.min }) : `${fmtPrice({ ...s.price, value: s.price.min })}–${fmtPrice({ ...s.price, value: s.price.max })}`;
    if (s.price.currency !== p.currency) out.push(`Comparables in this category charged ${range} (in ${s.price.currency}); this plan charges ${fmtPrice(p)}. Different currencies: compare them yourself.`);
    else if (p.value > s.price.max * 2) out.push(`Comparables in this category charged ${range}; this plan charges ${fmtPrice(p)}, over twice the highest.`);
    else if (p.value < s.price.min / 2) out.push(`Comparables in this category charged ${range}; this plan charges ${fmtPrice(p)}, under half the lowest.`);
  }
  const want = r.target.channels;
  if (want.length && s.withChannel >= 3 && s.channels[0]?.n >= 2) {
    const used = s.channels.filter((c) => want.includes(c.channel));
    if (!used.length) out.push(`None of the ${s.withChannel} comparables who say how they got first customers used ${want.map((c) => CH_LABEL[c]).join(" or ")}; the most common was ${s.channels[0].label} (${s.channels[0].n} of ${s.withChannel}).`);
  }
  return out;
}

// ── as text for prompts, and a one-liner for cards ──────────────────────────────────
export function comparablesText(r: Comparables | undefined, max = 5): string {
  if (!r?.comparables.length) return "";
  const lines = ["Comparable founders (Founder Library: real businesses most like this one, matched by type, buyer, channel and price; revenue and prices are their own on-camera claims, unverified; cite the links, never invent figures beyond these):"];
  r.comparables.slice(0, max).forEach((c, i) => {
    const when = c.published ? ` [${c.published}${c.old ? `, ${c.old}` : ""}]` : "";
    const bits = [`${i + 1}. ${c.name}${when}${c.sells ? ` — ${c.sells}` : ""}${c.customer ? ` for ${c.customer}` : ""}`];
    if (c.price) bits.push(`price "${c.price.text}" (${c.price.link})`);
    if (c.revenue) bits.push(`claimed revenue "${c.revenue.text}" (${c.revenue.link})`);
    if (c.ttfr) bits.push(`first revenue "${c.ttfr.text}"`);
    for (const f of c.first.slice(0, 2)) bits.push(`first customers via ${CH_LABEL[f.channel] ?? f.channel}: ${f.text} (${f.link})`);
    if (c.failed[0]) bits.push(`what failed: ${c.failed[0].text} (${c.failed[0].link})`);
    lines.push(bits.join("; "));
  });
  if (r.summary.length) lines.push(`Across them: ${r.summary.join(" ")}`);
  if (r.checks.length) lines.push(`Strategy check: ${r.checks.join(" ")}`);
  return lines.join("\n");
}
/** "Comparables: Acme (claimed $10K/mo, Reddit, Mar 2024) · Foo (…)". Empty when there are none. */
export function comparablesLine(r: Comparables | undefined, max = 3): string {
  if (!r?.comparables.length) return "";
  return `Comparables: ${r.comparables.slice(0, max).map((c) => { const ch = c.first.find((x) => x.channel !== "other"); return `${c.name} (${[c.revenue?.perMonth ? `claimed ${money(c.revenue.perMonth)}/mo` : "", ch ? CH_LABEL[ch.channel] : "", c.published].filter(Boolean).join(", ")})`; }).join(" · ")}`;
}
/** The milestone a plan is working toward → which of the founders' lists to quote. */
export function milestoneKind(title: string): "first" | "growth" | "launch" {
  return /\b(10|ten|\$\s?1k|\$\s?1,?000|mrr|\/mo|a month|grow|scale|100)\b/i.test(title) ? "growth" : /\b(launch|live|deploy|ship|landing|offer page|waitlist)\b/i.test(title) && !/customer|paying|sale|dollar|\$/i.test(title) ? "launch" : "first";
}

/**
 * The tactics comparables used for a milestone, as prompt lines: first customers for "first paying customer", growth
 * for "10 paying" or "$1k a month", first customers plus time to first revenue for a launch.
 */
export function tacticsText(r: Comparables | undefined, milestone: string, max = 5): string {
  if (!r?.comparables.length) return "";
  const kind = milestoneKind(milestone);
  const rows = r.comparables.flatMap((c) => (kind === "growth" && c.growth.length ? c.growth : c.first).filter((x) => x.channel !== "other").slice(0, 1)
    .map((x) => `- ${CH_LABEL[x.channel] ?? x.channel}: ${x.text} — ${c.name}${c.published ? ` (${c.published}${c.old ? `, ${c.old}` : ""})` : ""}${kind === "launch" && c.ttfr ? `; first revenue "${c.ttfr.text}"` : ""} ${x.link}`)).slice(0, max);
  if (!rows.length) return "";
  const what = kind === "growth" ? "how comparable founders grew past their first customers" : "how comparable founders got their first customers";
  return [`What worked for founders most like this (${what}; Founder Library, their own words, with links):`, ...rows, ...(r.checks.length ? [`Strategy check: ${r.checks.join(" ")}`] : [])].join("\n");
}

// ── the deck's library, shared ─────────────────────────────────────────────────────
// The server hands its one Library to the gallery (src/gallery-server.ts), which shares it here; the quest board,
// research, project pages and the Studio read comparables through it. Tests pass cards to findComparables directly.
type CardSource = { cards: () => { all: () => Card[] } };
let shared: CardSource | undefined;
let memo: { at: number; cards: Card[] } | undefined;
export function shareLibrary(lib: CardSource | undefined) { shared = lib; memo = undefined; }
export function libraryCards(): Card[] {
  if (!shared) return [];
  if (!memo || Date.now() - memo.at > 60_000) { try { memo = { at: Date.now(), cards: shared.cards().all() }; } catch { memo = { at: Date.now(), cards: [] }; } }
  return memo.cards;
}
/** Comparables for a plan from the deck's library, or undefined when there is no library or no card fits. */
export function comparablesFor(t: Target, o: { k?: number; cards?: Card[] } = {}): Comparables | undefined {
  const cards = o.cards ?? libraryCards();
  if (!cards.length) return undefined;
  const r = findComparables(cards, t, { k: o.k });
  return r.comparables.length ? r : undefined;
}
