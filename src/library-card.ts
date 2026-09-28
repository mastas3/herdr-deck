// A Founder Library card, and how the deck prints one: its shape (the library plugin writes cards; Discover, the Studio,
// the quest board, research and project pages read them as comparables and evidence, src/library-strategy.ts and
// src/library-search.ts), timestamps and links to the moment something was said, the channel a tactic belongs to, and
// when a video came out. Pure: no I/O, no model.

export const CHANNELS = ["reddit", "x_twitter", "tiktok", "youtube", "instagram", "linkedin", "facebook_groups", "product_hunt", "hacker_news", "seo", "content_blog", "newsletter", "cold_email", "cold_calls", "door_to_door", "in_person", "friends_network", "existing_audience", "communities", "paid_ads", "partnerships", "affiliates", "app_store", "marketplace", "word_of_mouth", "press", "influencers", "cold_dms", "other"] as const;
export const BTYPES = ["saas", "mobile_app", "ecommerce", "service_agency", "info_product", "marketplace", "content_media", "local_business", "newsletter", "community", "hardware", "other"] as const;
export type Channel = (typeof CHANNELS)[number];
export type Claim = { text: string; quote?: string; t: number | null; src: "transcript" | "title"; moved?: boolean };
export type Item = { text: string; t: number | null; channel?: Channel; moved?: boolean };
export type Card = {
  id: string; source: string; channelTitle?: string; title: string; url: string; views?: number; date?: string; duration?: number;
  kind: "founder_story" | "advice" | "other";
  business: string | null; founder: string | null; sells: string | null; btype: (typeof BTYPES)[number]; customer: string | null;
  price?: Claim; revenue?: Claim & { perMonth?: number; currency?: string }; ttfr?: Claim; team?: Claim;
  first: Item[]; growth: Item[]; stack: string[]; failed: Item[]; lessons: Item[];
  model: string; at: number; checks: { dropped: string[]; moved: number }; v?: number;
};

const ENT: Record<string, string> = { "&gt;": ">", "&lt;": "<", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
export const cleanCaption = (s: string) => String(s ?? "").replace(/&(gt|lt|amp|quot|#39|nbsp);/g, (m) => ENT[m] ?? m).replace(/>>\s*/g, "— ").replace(/\[(music|applause|laughter|__)\]/gi, "").replace(/\s+/g, " ").trim();
export const fmtT = (t: number) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60); return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; };
export const linkAt = (url: string, t: number | null | undefined) => (t ? `${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(t)}s` : url);

// ── channels ───────────────────────────────────────────────────────────────────
// Small models often name a channel outside the list ("influencer marketing", "Twitter DMs"). The tactic's own words
// usually say which one it is; the first rule that matches wins, most specific first.
const CHANNEL_RULES: [RegExp, Channel][] = [
  [/influencer|ugc|creators? (to|who) post|streamers?|content creators?/i, "influencers"], [/product ?hunt/i, "product_hunt"], [/hacker ?news|show hn/i, "hacker_news"],
  [/reddit|subreddit|\br\/\w/i, "reddit"], [/tiktok/i, "tiktok"], [/youtube/i, "youtube"], [/instagram|\breels?\b/i, "instagram"], [/linkedin/i, "linkedin"],
  [/facebook group/i, "facebook_groups"], [/twitter|\btweet|\bx\.com|on x\b/i, "x_twitter"], [/cold email|email outreach|emailed (people|businesses|leads)/i, "cold_email"],
  [/cold call|called (businesses|them|people)|phone/i, "cold_calls"], [/door[- ]to[- ]door|walk(ed|ing)? into|knock/i, "door_to_door"],
  [/\bdms?\b|direct messag|messag(ed|ing) (people|them)/i, "cold_dms"], [/app store|\baso\b/i, "app_store"],
  [/etsy|amazon|fiverr|upwork|gumroad|shopify app store|marketplace|chrome web store/i, "marketplace"], [/\bseo\b|google search|rank(ed|ing)? on google|keywords?/i, "seo"],
  [/newsletter/i, "newsletter"], [/blog|article|content marketing|wrote posts/i, "content_blog"], [/\bads?\b|paid (ads|acquisition)|facebook ads|google ads|meta ads/i, "paid_ads"],
  [/affiliate|referral program/i, "affiliates"], [/partner/i, "partnerships"], [/press|journalist|techcrunch|featured in/i, "press"],
  [/discord|slack (group|community)|forum|community|communities|facebook|whatsapp group/i, "communities"], [/audience|followers|my (channel|list)|existing customers/i, "existing_audience"],
  [/friend|family|network|former (colleague|employer|boss)/i, "friends_network"], [/conference|meetup|event|trade show|in person|in-person/i, "in_person"],
  [/word of mouth|referrals?\b|told (their|his|her) friends/i, "word_of_mouth"],
];
export function inferChannel(named: unknown, text: string): Channel {
  const n = String(named ?? "").toLowerCase().trim().replace(/[\s/-]+/g, "_");
  if ((CHANNELS as readonly string[]).includes(n) && n !== "other") return n as Channel;
  for (const [re, ch] of CHANNEL_RULES) if (re.test(`${named ?? ""} ${text}`)) return ch;
  return "other";
}

// ── when a video came out (dates from yt-dlp, kept by the library plugin) ────────────────────────────────
export type VideoMeta = { date?: string; ts?: number; duration?: number; views?: number; at: number; err?: string };
export type MetaMap = Record<string, VideoMeta>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR = 365.25 * 86_400_000;
/** Stories older than this are labelled "older (year)" when quoted. */
export const OLD_YEARS = 3;

// ── formats ─────────────────────────────────────────────────────────────────────────
/** "20240315" (yt-dlp's upload_date) or a Unix time → "2024-03-15". Undefined for anything else. */
export function isoDate(x: unknown): string | undefined {
  const s = String(x ?? "").trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (/^\d{9,11}(\.\d+)?$/.test(s) && Number.isFinite(n)) return new Date(n * 1000).toISOString().slice(0, 10);
  return undefined;
}
/** "2024-03-15" → "Mar 2024". */
export function fmtPublished(date?: string): string {
  const m = String(date ?? "").match(/^(\d{4})-(\d\d)/);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`.trim() : "";
}
/** Seconds → "18 min", "1 h 05 min", "45 s". */
export function fmtDuration(s?: number): string {
  if (!s || s <= 0) return "";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
/** "Published Mar 2024 · 18 min" (either half may be missing). */
export const fmtMeta = (date?: string, duration?: number) => [fmtPublished(date) && `Published ${fmtPublished(date)}`, fmtDuration(duration)].filter(Boolean).join(" · ");

// ── recency ─────────────────────────────────────────────────────────────────────────
export const ageYears = (date: string | undefined, now = Date.now()) => { const t = date ? Date.parse(date) : NaN; return Number.isFinite(t) ? Math.max(0, (now - t) / YEAR) : undefined; };
/**
 * How much a story counts next to a fresh one: full weight in its first year, then a tenth less per year, never under
 * half (an old story is still a real story). An unknown date sits in between.
 */
export function recencyWeight(date?: string, now = Date.now()): number {
  const y = ageYears(date, now);
  if (y == null) return 0.85;
  return Math.max(0.5, 1 - 0.1 * Math.max(0, y - 1));
}
/** "older (2021)" for a story more than three years old; "" otherwise (or when the date is unknown). */
export function oldLabel(date?: string, now = Date.now()): string {
  const y = ageYears(date, now);
  return y != null && y > OLD_YEARS ? `older (${date!.slice(0, 4)})` : "";
}
