// Founder cards for the strategy tests: three podcast-clip SaaS stories (two recent, one from 2020), a habit app and an
// advice video, with prices, claimed revenue, first-customer tactics and failures, each at a timestamp.
import type { Card } from "../src/library-card";

/** A founder card with sensible defaults; each fixture overrides what it's about. */
export function card(o: Partial<Card> & { id: string }): Card {
  return {
    source: "starterstory", title: `Video ${o.id}`, url: `https://www.youtube.com/watch?v=${o.id.padEnd(11, "x").slice(0, 11)}`, kind: "founder_story",
    business: null, founder: null, sells: null, btype: "other", customer: null, first: [], growth: [], stack: [], failed: [], lessons: [],
    model: "test", at: 0, checks: { dropped: [], moved: 0 }, v: 4, ...o,
  };
}
const claim = (text: string, t = 60) => ({ text, quote: text, t, src: "transcript" as const });
export const CARDS: Card[] = [
  card({ id: "podclip0001", business: "ClipPod", sells: "AI podcast clips for podcasters", btype: "saas", customer: "podcasters", date: "2025-11-02", duration: 1080,
    price: claim("$29 a month"), revenue: { ...claim("$12K a month"), perMonth: 12000 }, ttfr: claim("3 weeks"),
    first: [{ text: "Posted before/after clips in r/podcasting", t: 300, channel: "reddit" }], growth: [{ text: "Partnered with podcast hosts on YouTube", t: 400, channel: "youtube" }],
    failed: [{ text: "Stalled for months on churn after the first free month", t: 500 }] }),
  card({ id: "podclip0002", business: "Snippy", sells: "podcast clip editor for video podcasts", btype: "saas", customer: "video podcasters", date: "2025-06-10",
    price: claim("$19 a month"), revenue: { ...claim("$4K a month"), perMonth: 4000 },
    first: [{ text: "Launched on Reddit in r/NewTubers with a demo", t: 200, channel: "reddit" }, { text: "Cold emailed 50 podcasters", t: 260, channel: "cold_email" }] }),
  card({ id: "podclip0003", business: "CastCut", sells: "podcast clips and transcripts", btype: "saas", customer: "podcasters and agencies", date: "2020-03-01",
    price: claim("$39 a month"), first: [{ text: "Posted in r/podcasting weekly threads", t: 100, channel: "reddit" }] }),
  card({ id: "habitapp001", business: "Streaky", sells: "habit tracker app", btype: "mobile_app", customer: "students", date: "2024-02-01", price: claim("$4.99 a week"),
    first: [{ text: "Paid TikTok creators to post", t: 90, channel: "influencers" }] }),
  card({ id: "advice00001", kind: "advice", title: "10 tips for founders", sells: null }),
];

