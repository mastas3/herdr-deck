// Founder Library: one answer list out of three searches. Transcript passages come from Chroma (meaning), founder
// cards and web pages from SQLite full-text (words). Results are grouped per video and ranked by reciprocal rank
// fusion, so a video that both a passage and its card match rises to the top, and either one alone still counts.
import { cleanCaption, fmtPublished, fmtT, linkAt, oldLabel, recencyWeight, type Card, type MetaMap } from "./library-card";

export type Passage = {
  id: string; score: number | null; text: string; video_id: string; video_title: string; video_url: string;
  start_time_s: number; channel_id?: string; chunk_type?: string; source_url_with_timestamp?: string;
};
export type Clip = { t: number; at: string; link: string; text: string; score: number | null };
export type Answer = { kind: "video" | "web"; id: string; title: string; url: string; source?: string; card?: Card; clips: Clip[]; score: number; why: ("passage" | "card" | "page")[]; date?: string; duration?: number };
export type WebHit = { url: string; title: string; snippet: string; rank: number };

/** What the features that read the Founder Library need from the `library` service (plugins-builtin/library):
 *  Discover's gallery, the Studio and the ideas feed, the quest board, research and project pages. */
export type LibraryReader = {
  evidence(q: string, k?: number, use?: "studio" | "ideas" | "research"): Promise<{ text: string; answers: Answer[] }>;
  cards(): { all(): Card[] };
};

/** The ideas feed's rows as a library question (what founders did for that kind of business). */
const FEED_Q: Record<string, string> = { money: "first paying customers small business pricing", saas: "saas first customers pricing", automations: "automation agency first clients",
  content: "content creator audience monetization", projects: "side project first revenue", gem: "open source project monetization", weekend: "simple app built in a weekend first revenue", wild: "unusual niche business first customers" };
export const feedQuery = (rows: string[]) => rows.map((r) => FEED_Q[r] ?? r).join(" ");

const K = 60; // the usual RRF constant: rank 1 and rank 5 differ, rank 40 and 45 hardly do
const MIN_PASSAGE_SCORE = 0.45; // cosine similarity under this is noise with nomic-embed-text

export function mergeResults(passages: Passage[], cards: Card[], pages: WebHit[], k = 8, extraCards: Card[] = []): Answer[] {
  const by = new Map<string, Answer>();
  const cardOf = new Map([...cards, ...extraCards].map((c) => [c.id, c]));
  const get = (id: string, init: () => Answer) => { let a = by.get(id); if (!a) { a = init(); by.set(id, a); } return a; };
  passages.filter((p) => (p.score == null || p.score >= MIN_PASSAGE_SCORE) && !isPlug(p.text)).forEach((p, i) => {
    const web = p.chunk_type === "web";
    const a = get(p.video_id, () => ({ kind: web ? "web" : "video", id: p.video_id, title: p.video_title, url: p.video_url, source: p.channel_id, card: cardOf.get(p.video_id), clips: [], score: 0, why: [] }));
    a.score += 1 / (K + i);
    if (!a.why.includes("passage")) a.why.push("passage");
    if (a.clips.length < 3) {
      const t = Number(p.start_time_s) || 0;
      a.clips.push({ t, at: web ? "" : fmtT(t), link: web ? p.video_url : linkAt(p.video_url, t), text: clip(cleanCaption(p.text), 420), score: p.score });
    }
  });
  cards.forEach((c, i) => {
    const a = get(c.id, () => ({ kind: "video", id: c.id, title: c.title, url: c.url, source: c.source, card: c, clips: [], score: 0, why: [] }));
    a.card ??= c;
    // Cards weigh a little more than one passage: they are the distilled, checked version of the whole video.
    a.score += 1.2 / (K + i);
    a.why.push("card");
  });
  pages.forEach((p, i) => {
    const a = get(p.url, () => ({ kind: "web", id: p.url, title: p.title, url: p.url, clips: [], score: 0, why: [] }));
    a.score += 1 / (K + i);
    if (!a.why.includes("page")) a.why.push("page");
    if (!a.clips.length && p.snippet) a.clips.push({ t: 0, at: "", link: p.url, text: clip(p.snippet, 420), score: null });
  });
  return [...by.values()].sort((x, y) => y.score - x.score).slice(0, k);
}

/** Each video answer's publish date and length, from its card or else the date backfill (web pages have none). */
export function withDates(answers: Answer[], meta: MetaMap = {}): Answer[] {
  return answers.map((a) => (a.kind === "web" ? a : { ...a, date: a.card?.date ?? meta[a.id]?.date, duration: a.card?.duration ?? meta[a.id]?.duration }));
}
/** Evidence leans on recent stories: each answer's score is scaled by its recency weight, then re-sorted. */
export function byRecency(answers: Answer[], now = Date.now()): Answer[] {
  return answers.map((a) => ({ ...a, score: a.score * (a.kind === "web" ? 0.85 : recencyWeight(a.date, now)) })).sort((x, y) => y.score - x.score);
}
/** " [Mar 2024]" or " [Jun 2020, older (2020)]" after a card's name in prompts: the model sees how fresh a tactic is. */
export function whenTag(date: string | undefined, now = Date.now()): string {
  if (!date) return "";
  const old = oldLabel(date, now);
  return ` [${fmtPublished(date)}${old ? `, ${old}: check it still works` : ""}]`;
}

/** The channel's own ads and sponsor reads ("link in the description", "use code…") are never an answer. */
export const isPlug = (s: string) => /link in the description|links? (is |are )?(down )?below|use (my |the )?code\b|this (video|episode) is (brought to you|sponsored)|today's sponsor|sign up (for free )?at /i.test(s);
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

/** A card as a few prompt lines: what it is, the claimed revenue and how the first customers came, each with its link. */
export function cardLines(c: Card, now = Date.now()): string {
  const at = (t: number | null) => (t != null ? ` (${linkAt(c.url, t)})` : "");
  const head = `${c.business ?? c.title}${whenTag(c.date, now)}${c.sells ? ` — ${c.sells}` : ""}${c.customer ? `; customers: ${c.customer}` : ""}`;
  const lines = [head];
  if (c.revenue) lines.push(`claimed revenue: "${c.revenue.quote ?? c.revenue.text}"${c.revenue.src === "title" ? " (video title)" : ""}${at(c.revenue.t)}`);
  if (c.price) lines.push(`price: "${c.price.quote ?? c.price.text}"${at(c.price.t)}`);
  for (const x of c.first.slice(0, 2)) lines.push(`first customers (${(x.channel ?? "other").replace(/_/g, " ")}): ${x.text}${at(x.t)}`);
  for (const x of c.lessons.slice(0, 1)) lines.push(`lesson: ${x.text}${at(x.t)}`);
  return lines.join("\n   ");
}

/** The evidence block other prompts get: numbered cards, then the best quotes. Empty when the library has nothing. */
export function evidenceText(answers: Answer[], maxCards = 5, maxQuotes = 4, now = Date.now()): string {
  const withCard = answers.filter((a) => a.card).slice(0, maxCards);
  const quotes = answers.flatMap((a) => a.clips.slice(0, 1).map((c) => ({ a, c }))).slice(0, maxQuotes);
  if (!withCard.length && !quotes.length) return "";
  const out = ["Founder Library: what real builders said on camera (YouTube interviews and talks), with when each video came out. Numbers are their own claims, unverified; cite the link when you use one, and never invent figures beyond these. Prefer recent stories; a tactic marked older may no longer work."];
  withCard.forEach((a, i) => out.push(`${i + 1}. ${cardLines({ ...a.card!, date: a.card!.date ?? a.date }, now)}`));
  if (quotes.length) {
    out.push("Quotes:");
    for (const { a, c } of quotes) out.push(`- "${clip(c.text, 280)}" — ${a.title}${whenTag(a.date, now)}${c.at ? ` at ${c.at}` : ""} (${c.link})`);
  }
  return out.join("\n");
}
