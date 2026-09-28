// Founder Library: turning one video transcript into a founder card. A local model reads the transcript with [m:ss]
// markers and fills a fixed JSON shape; then every claim is checked against the transcript before it is kept:
//  - a number (revenue, price, "30 posts") must be said in the transcript near the cited time. If it is said
//    elsewhere, the timestamp moves there; if only the video title says it, it links to the video's start and is
//    marked as from the title; if it is said nowhere, the claim is dropped.
//  - a timestamp must fall inside the video, and moves to the line that best matches the claim's words when the
//    cited line doesn't.
// So a card can be thin, but what it says was said, and each line links to the moment it was said.

import { BTYPES, CHANNELS, cleanCaption, fmtT, inferChannel, linkAt, type Card, type Channel, type Claim, type Item } from "../../src/library-card";

// The card's shape and the helpers other features print cards with live in the core (src/library-card.ts).
export { BTYPES, CHANNELS, cleanCaption, fmtT, inferChannel, linkAt, type Card, type Channel, type Claim, type Item };

/** Bumped when the prompt or the checks change: older cards are re-extracted in the background. */
export const EXTRACT_VERSION = 4;
export type Segment = { start: number; end?: number; text: string };
export type Line = { t: number; text: string };

// ── transcript → prompt lines ──────────────────────────────────────────────────────
/** Segments grouped into ~20-second lines, each starting at its first segment's time. */
export function toLines(segs: Segment[], every = 20): Line[] {
  const out: Line[] = [];
  let cur: Line | undefined, bucket = -1;
  for (const s of segs) {
    const text = cleanCaption(s.text);
    if (!text) continue;
    const b = Math.floor((s.start ?? 0) / every);
    if (!cur || b !== bucket) { if (cur) out.push(cur); cur = { t: Math.floor(s.start ?? 0), text }; bucket = b; }
    else cur.text += " " + text;
  }
  if (cur) out.push(cur);
  return out;
}
export function parseT(x: unknown): number | null {
  const m = String(x ?? "").trim().replace(/^\[|\]$/g, "").replace(/^t\s*[:=]\s*/i, "").match(/^(?:(\d+):)?(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}
/** Prompt-sized parts of the transcript (a long podcast is read in pieces and the cards merged). */
export function transcriptParts(lines: Line[], maxChars = 36_000): string[] {
  const parts: string[] = [];
  let buf = "";
  for (const l of lines) {
    const s = `[${fmtT(l.t)}] ${l.text}\n`;
    if (buf && buf.length + s.length > maxChars) { parts.push(buf); buf = ""; }
    buf += s;
  }
  if (buf) parts.push(buf);
  return parts;
}

// ── the prompt ───────────────────────────────────────────────────────────────────
export const EXTRACT_SYSTEM = `You read one YouTube video transcript about building a business and fill in a founder card as JSON. Lines start with [m:ss] timestamps.

Rules:
- Only what is said in the transcript. Never guess, never compute, never convert currencies. If something isn't said, use null or [].
- Every item gets "t": the [m:ss] timestamp of the line where it is said, copied exactly.
- Numbers (revenue, price, users, time) are copied as spoken, with a short exact "quote" of the words that contain them.
- Revenue is the business's own current revenue as the founder or host states it (not a goal, not someone else's).
- Short, concrete text: a named place, a number, an action. No hype words, no emoji.

JSON shape:
{"kind":"founder_story|advice|other",
 "business":"name or null","founder":"name(s) or null","sells":"what they sell, one line",
 "business_type":"${BTYPES.join("|")}",
 "customer":"who pays, concretely",
 "price":{"text":"e.g. $29/month","quote":"exact words","t":"m:ss"} or null,
 "revenue":{"text":"e.g. $50K/month","quote":"exact words","t":"m:ss"} or null,
 "time_to_first_revenue":{"text":"...","quote":"exact words","t":"m:ss"} or null,
 "team":{"text":"e.g. solo, 2 brothers, 12 staff","quote":"exact words","t":"m:ss"} or null,
 "first_customers":[{"channel":"${CHANNELS.join("|")}","tactic":"one self-contained sentence: what they did, where, and how","t":"m:ss"}],
 "growth":[{"channel":"same list","tactic":"one self-contained sentence: what grew it after the first customers","t":"m:ss"}],
 "stack":["tools and tech they name"],
 "failed_before":[{"text":"a business, product or approach of theirs that didn't work, or something they regret, and why","t":"m:ss"}],
 "lessons":[{"text":"one lesson or tip as a complete sentence that makes sense on its own","t":"m:ss"}]}
Write tactics and lessons in your own plain words so they read on their own, e.g. "Paid micro-streamers about $120 per video to post a screenshot-reply format on TikTok", "Sold a private lifetime deal in Reddit and Facebook groups before launching on AppSumo". Never "reaching out" or "posting content" alone: say to whom and where.
Not first_customers: where the idea came from, the date of the first sale, calls to action for viewers, sponsors, or the host's own offers. Not failed_before: book titles or tips.
kind: founder_story when a founder tells how their own business was built; advice for tips or talks without one business; other otherwise.
Give up to 4 first_customers, 4 growth, 5 failed_before and 6 lessons. Answer with the JSON only.`;
export const extractUser = (title: string, channel: string, part: string, i = 0, n = 1) =>
  `Video title: ${title}\nChannel: ${channel}${n > 1 ? `\nThis is part ${i + 1} of ${n} of the transcript: fill in only what this part says.` : ""}\n\nTranscript:\n${part}`;

/** Asked when an answer stopped before the lists (it happens with small models): the same transcript, lists only. */
export const LISTS_USER = "Your card stopped before the lists. For the same transcript, answer with JSON containing only these keys, filled as the rules say: first_customers, growth, stack, failed_before, lessons.";
export const needsLists = (raw: any) => !!raw && ["first_customers", "growth", "failed_before", "lessons"].every((k) => !Array.isArray(raw[k]));

// ── JSON repair ─────────────────────────────────────────────────────────────────
/** The model's JSON, tolerating code fences, chatter around it, trailing commas and a cut-off end. */
export function parseCardJson(text: string): any | undefined {
  let s = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const a = s.indexOf("{");
  if (a < 0) return undefined;
  s = s.slice(a);
  const tryParse = (x: string) => { try { return JSON.parse(x); } catch { return undefined; } };
  const b = s.lastIndexOf("}");
  const whole = b > 0 ? tryParse(s.slice(0, b + 1)) ?? tryParse(s.slice(0, b + 1).replace(/,\s*([}\]])/g, "$1")) : undefined;
  if (whole) return whole;
  // Cut off mid-way: drop the unfinished tail, then close what is still open.
  let t = s.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"{}\[\],]*$/, "").replace(/,\s*$/, "");
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
  }
  if (inStr) t += '"';
  t = t.replace(/,\s*$/, "") + stack.reverse().join("");
  return tryParse(t) ?? tryParse(t.replace(/,\s*([}\]])/g, "$1"));
}

// ── numbers ──────────────────────────────────────────────────────────────────────
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, grand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
/** Every amount in a text as a value: "$85,000" → 85000, "50K" → 50000, "1.2 million" → 1200000. Years like 2024 are left out. */
export function amounts(text: string): number[] {
  const out: number[] = [];
  const re = /(\$|€|£)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|mm|m|b|thousand|grand|million|billion)?\b/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const n = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mult = m[3] ? MULT[m[3].toLowerCase()] ?? 1 : 1;
    if (!m[1] && !m[3] && n >= 1900 && n <= 2100 && Number.isInteger(n)) continue; // a year
    out.push(n * mult);
  }
  return out;
}
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.01);
const lineHas = (l: Line, xs: number[]) => { const got = amounts(l.text); return xs.every((x) => got.some((g) => same(g, x))); };
/** The monthly figure a revenue claim states ("$1.2M a year" → 100000). Only for sorting and filtering; the card shows the words. */
export function perMonth(text: string): number | undefined {
  const v = amounts(text).filter((x) => x >= 100).sort((a, b) => b - a)[0];
  if (v == null) return undefined;
  const s = text.toLowerCase();
  if (/\b(a|per|\/)\s?(day|daily)\b|\/day/.test(s)) return v * 30;
  if (/year|annual|\/yr|\barr\b|a yr/.test(s)) return Math.round(v / 12);
  if (/month|\/mo\b|\bmrr?\b|monthly/.test(s)) return v;
  return undefined; // a total ("made $500K") has no monthly rate
}

// ── claim checking ──────────────────────────────────────────────────────────────
const STOP = new Set("the a an and or but of to in on for with at by from that this it is was were be been are as we i you he she they our my your their his her its just like so really very what when then than there here into out about up how".split(" "));
const words = (s: string) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
function overlap(claim: Set<string>, text: string) {
  if (!claim.size) return 0;
  const w = words(text);
  let n = 0;
  for (const x of claim) if (w.has(x)) n++;
  return n / claim.size;
}
const near = (lines: Line[], t: number, span: number) => lines.filter((l) => l.t >= t - span && l.t <= t + span);
function bestLine(lines: Line[], claim: Set<string>): { line?: Line; score: number } {
  let best: Line | undefined, score = 0;
  for (const l of lines) { const s = overlap(claim, l.text); if (s > score) { score = s; best = l; } }
  return { line: best, score };
}

/** A number claim, kept only if the transcript (or else the title) says the number. Undefined means drop it. */
export function checkClaim(raw: any, lines: Line[], title: string, dur?: number): Claim | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const text = str(raw.text), quote = str(raw.quote);
  if (!text) return undefined;
  let t = parseT(raw.t);
  if (t != null && dur && t > dur + 5) t = null;
  const nums = [...new Set(amounts(text).concat(quote ? amounts(quote) : []))];
  const claimWords = words(`${quote ?? ""} ${text}`);
  if (nums.length) {
    const key = [nums[0]];
    if (t != null && near(lines, t, 60).some((l) => lineHas(l, key))) {
      const exact = near(lines, t, 60).filter((l) => lineHas(l, key)).sort((a, b) => Math.abs(a.t - t!) - Math.abs(b.t - t!))[0];
      return { text, quote, t: exact.t, src: "transcript", moved: exact.t !== t || undefined };
    }
    const hits = lines.filter((l) => lineHas(l, key));
    if (hits.length) {
      const pick = hits.map((l) => ({ l, s: overlap(claimWords, l.text) })).sort((a, b) => b.s - a.s || a.l.t - b.l.t)[0].l;
      return { text, quote, t: pick.t, src: "transcript", moved: true };
    }
    if (amounts(title).some((x) => same(x, key[0]))) return { text, quote: title, t: 0, src: "title" };
    return undefined;
  }
  // No number (e.g. "six figures", "solo"): the words must be there near the time, or somewhere.
  if (t != null && near(lines, t, 45).some((l) => overlap(claimWords, l.text) >= 0.5)) return { text, quote, t, src: "transcript" };
  const b = bestLine(lines, claimWords);
  return b.line && b.score >= 0.5 ? { text, quote, t: b.line.t, src: "transcript", moved: true } : undefined;
}

/** A tactic, lesson or failure: kept with its time (moved to the best-matching line if the cited one doesn't match). */
export function checkItem(text: string | null, rawT: unknown, lines: Line[], dur?: number): { text: string; t: number | null; moved?: boolean } | undefined {
  if (!text) return undefined;
  const nums = amounts(text);
  // A number nobody said makes the whole line invented.
  if (nums.some((x) => !lines.some((l) => amounts(l.text).some((g) => same(g, x))))) return undefined;
  let t = parseT(rawT);
  if (t != null && dur && t > dur + 5) t = null;
  const w = words(text);
  const here = t != null ? Math.max(0, ...near(lines, t, 40).map((l) => overlap(w, l.text))) : 0;
  const b = bestLine(lines, w);
  if (t != null && (here >= 0.25 || here >= b.score * 0.6)) return { text, t };
  if (b.line && b.score >= 0.25) return { text, t: b.line.t, moved: true };
  return t != null ? { text, t } : undefined;
}

const NOT_TACTIC = /^(the |their |his |her )?first (sale|customer|user|dollar|payment)s? (came|was|were|arrived)|\b(scaled|grew|got) to (about |around |over )?\$?\d|\b(generated|made|earned|hit|reached|did) (over |about |around |nearly |almost )?\$\d|\bspent the next .* (trying|figuring)/i;
// ── normalizing ───────────────────────────────────────────────────────────────────
const NULLISH = /^[\[(<"']*(null|none|n\/a|na|unknown|not (mentioned|stated|specified|said|given)|-|)[\])>"']*$/i;
function str(x: unknown, max = 240): string | null {
  if (x == null || typeof x === "object") return null;
  const s = String(x).replace(/\s+/g, " ").trim();
  // "[No specific failed business mentioned, …]": the model saying there's nothing, in brackets.
  return NULLISH.test(s) || /^\[(no |not |none)/i.test(s) ? null : s.slice(0, max);
}
const oneOf = <T extends readonly string[]>(xs: T, v: unknown, d: T[number]): T[number] => { const s = String(v ?? "").toLowerCase().trim().replace(/[\s/-]+/g, "_"); return (xs as readonly string[]).includes(s) ? (s as T[number]) : d; };
const dedupe = <T extends { text: string }>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => y.text.toLowerCase() === x.text.toLowerCase()) === i);

/** A currency other than dollars, when the words say so (the card shows it; nothing is converted). */
export const currencyOf = (s: string) => (/australian dollars|\baud\b|a\$/i.test(s) ? "AUD" : /canadian dollars|\bcad\b/i.test(s) ? "CAD" : /€|\beuros?\b/i.test(s) ? "EUR" : /£|\bpounds?\b|\bgbp\b/i.test(s) ? "GBP" : undefined);

export type VideoMeta = { id: string; source: string; channelTitle?: string; title: string; url: string; views?: number; date?: string; duration?: number };
/** One or more raw model answers (one per transcript part) → a checked card. */
export function buildCard(raws: any[], lines: Line[], v: VideoMeta, model: string, now = Date.now()): Card {
  const dropped: string[] = [];
  let moved = 0;
  const firstOf = (k: string) => raws.map((r) => r?.[k]).find((x) => x != null && str(x) !== null);
  const claimOf = (k: string) => {
    for (const r of raws) {
      if (!r?.[k]) continue;
      const c = checkClaim(r[k], lines, v.title, v.duration);
      if (c) { if (c.moved) moved++; return c; }
      dropped.push(`${k}: ${str(r[k]?.text) ?? "?"}`);
    }
    return undefined;
  };
  const items = (k: string, textKey: string, max: number, withChannel = false): Item[] => dedupe(raws.flatMap((r) => (Array.isArray(r?.[k]) ? r[k] : [])).flatMap((x: any) => {
    // Small models sometimes give "text" or ["text", "t:1:23"] instead of {text, t}: both are read; a missing time is looked up.
    if (Array.isArray(x)) x = { [textKey]: x[0], t: x[1] };
    const c = typeof x === "string" ? checkItem(str(x), null, lines, v.duration) : checkItem(str(x?.[textKey] ?? x?.text ?? x?.lesson), x?.t, lines, v.duration);
    if (!c) { if (x) dropped.push(`${k}: ${str(typeof x === "string" ? x : x?.[textKey] ?? x?.text) ?? "?"}`); return []; }
    if (c.moved) moved++;
    const channel = withChannel ? inferChannel(x?.channel, c.text) : undefined;
    // A milestone is not a tactic ("the first sale came in January", "scaled to $60K a month").
    if (channel === "other" && NOT_TACTIC.test(c.text)) { dropped.push(`${k}: not a tactic: ${c.text}`); return []; }
    return [{ ...c, ...(withChannel ? { channel } : {}) } as Item];
  })).slice(0, max);
  const kinds = raws.map((r) => r?.kind);
  const kind = kinds.includes("founder_story") ? "founder_story" : kinds.includes("advice") ? "advice" : "other";
  const revenue = claimOf("revenue");
  const card: Card = {
    ...v, kind,
    business: str(firstOf("business"), 80), founder: str(firstOf("founder"), 80), sells: str(firstOf("sells")),
    btype: oneOf(BTYPES, firstOf("business_type"), "other"), customer: str(firstOf("customer")),
    price: claimOf("price"), ttfr: claimOf("time_to_first_revenue"), team: claimOf("team"),
    revenue: revenue ? { ...revenue, perMonth: perMonth(revenue.text) ?? perMonth(`${revenue.text} ${revenue.quote ?? ""}`), currency: currencyOf(`${revenue.text} ${revenue.quote ?? ""} ${lines.find((l) => l.t === revenue.t)?.text ?? ""}`) } : undefined,
    first: items("first_customers", "tactic", 4, true), growth: items("growth", "tactic", 4, true),
    stack: [...new Set(raws.flatMap((r) => (Array.isArray(r?.stack) ? r.stack : [])).map((x: unknown) => str(x, 40)).filter((x): x is string => !!x))].slice(0, 15),
    failed: items("failed_before", "text", 5), lessons: items("lessons", "text", 6),
    model, at: now, checks: { dropped, moved }, v: EXTRACT_VERSION,
  };
  for (const k of ["price", "ttfr", "team", "revenue"] as const) if (!card[k]) delete card[k];
  return card;
}
