import { describe, expect, test } from "bun:test";
import type { Card } from "../src/library-card";
import { byRecency, evidenceText, withDates, type Answer } from "../src/library-search";
import { CARDS } from "./strategy-fixtures";
import { channelsOf, comparablesFor, comparablesLine, comparablesText, findComparables, inferBtype, milestoneKind, parsePrice, tacticsText } from "../src/library-strategy";

const NOW = Date.parse("2026-09-26T12:00:00Z");

describe("recency-aware evidence", () => {
  const ans = (c: Card, score: number): Answer => ({ kind: "video", id: c.id, title: c.title, url: c.url, card: c, clips: [], score, why: ["card"] });
  test("dates come from the card or the backfill; recent stories move up; old ones are labelled in the prompt", () => {
    const old = { ...CARDS[2], date: undefined };
    const got = withDates([ans(old, 0.02), ans(CARDS[0], 0.018)], { podclip0003: { date: "2020-03-01", at: 0 } });
    expect(got[0].date).toBe("2020-03-01");
    const ranked = byRecency(got, NOW);
    expect(ranked[0].id).toBe("podclip0001"); // 0.018 × 1 beats 0.02 × 0.5
    const text = evidenceText(ranked, 5, 4, NOW);
    expect(text).toContain("ClipPod [Nov 2025]");
    expect(text).toContain("CastCut [Mar 2020, older (2020): check it still works]");
  });
});

describe("comparables: matching, counting, checking", () => {
  const plan = { name: "Podcast Clip Studio", offer: "5 clips and a transcript from each podcast episode", buyer: "podcasters who publish weekly", price: "$29/month", channel: "r/podcasting and r/NewTubers — post a before/after" };
  test("plans: prices, channels, business type, milestone kinds", () => {
    expect(parsePrice("$29/month for 4 credits")).toEqual({ value: 29, period: "month", currency: "$" });
    expect(parsePrice("₪149/month")).toEqual({ value: 149, period: "month", currency: "₪" });
    expect(parsePrice("$49.99 a year or $9.99 a week")).toEqual({ value: 49.99, period: "year", currency: "$" });
    expect(parsePrice("$79")).toEqual({ value: 79, period: "once", currency: "$" });
    expect(parsePrice("monthly subscription")).toBeUndefined();
    expect(channelsOf("r/podcasting and r/NewTubers—post a demo")).toEqual(["reddit"]);
    expect(channelsOf("Facebook groups + DMs on WhatsApp")).toEqual(["facebook_groups", "cold_dms"]);
    expect(inferBtype({ offer: "a Telegram bot that sends alerts" })).toBe("saas");
    expect(milestoneKind("First paying customer")).toBe("first");
    expect(milestoneKind("10 paying customers")).toBe("growth");
    expect(milestoneKind("Offer page live")).toBe("launch");
  });
  test("the closest founders come first, with why; advice videos and unrelated apps stay out", () => {
    const r = findComparables(CARDS, plan, { now: NOW });
    expect(r.comparables.map((c) => c.id)).toEqual(["podclip0001", "podclip0002", "podclip0003"]);
    const top = r.comparables[0];
    expect(top.close).toBe(true);
    expect(top.match.join(" ")).toContain("podcast");
    expect(top.published).toBe("Nov 2025");
    expect(top.revenue?.text).toBe("$12K a month");
    expect(top.first[0].link).toBe(`${CARDS[0].url}&t=300s`);
    expect(r.comparables[2].old).toBe("older (2020)");
  });
  test("counts across them, only from what the cards say (revenue as claimed)", () => {
    const r = findComparables(CARDS, plan, { now: NOW });
    expect(r.signals.withChannel).toBe(3);
    expect(r.signals.channels[0]).toMatchObject({ channel: "reddit", n: 3 });
    expect(r.signals.price).toMatchObject({ period: "month", currency: "$", median: 29, min: 19, max: 39, n: 3 });
    expect(r.summary[0]).toBe("3 of 3 comparable founders who say where their first customers came from got them via Reddit or cold email.");
    expect(r.summary.join(" ")).toContain("median $29 a month, range $19 a month–$39 a month");
    expect(r.summary.join(" ")).toContain("Claimed revenue (their words, unverified): $4K–$12K a month across 2.");
    expect(r.summary.join(" ")).toContain('ClipPod "3 weeks"');
    expect(r.summary.join(" ")).toContain("1 of 3 are older stories");
    expect(r.checks).toEqual([]); // $29/mo on Reddit is what they did
    // Every dollar figure in the summary is one a card stated.
    const said = new Set(["29", "19", "39", "4", "12"]);
    for (const m of r.summary.join(" ").matchAll(/\$(\d+)/g)) expect(said.has(m[1])).toBe(true);
  });
  test("the strategy check: a price far off, another currency, a channel none of them used", () => {
    const pricey = findComparables(CARDS, { ...plan, price: "$149/month" }, { now: NOW });
    expect(pricey.checks[0]).toBe("Comparables in this category charged $19 a month–$39 a month; this plan charges $149 a month, over twice the highest.");
    const cheap = findComparables(CARDS, { ...plan, price: "$5/month" }, { now: NOW });
    expect(cheap.checks[0]).toContain("under half the lowest");
    const shekels = findComparables(CARDS, { ...plan, price: "₪99/month" }, { now: NOW });
    expect(shekels.checks[0]).toContain("Different currencies: compare them yourself.");
    const fb = findComparables(CARDS, { ...plan, channel: "Facebook groups" }, { now: NOW });
    expect(fb.checks.at(-1)).toBe("None of the 3 comparables who say how they got first customers used Facebook groups; the most common was Reddit (3 of 3).");
  });
  test("nothing close: none returned, or loose ones said to be loose", () => {
    expect(findComparables(CARDS, { name: "Tender alerts", offer: "Israeli government tender alerts", buyer: "construction firms" }, { now: NOW }).comparables).toEqual([]);
    expect(comparablesFor({ name: "x" }, { cards: [] })).toBeUndefined();
    const loose = findComparables(CARDS, { name: "Mood diary", offer: "a journaling app", buyer: "students", price: "$3.99 a week", channel: "TikTok creators" }, { now: NOW });
    expect(loose.comparables[0].id).toBe("habitapp001");
    expect(loose.summary[0]).toContain("No founder in the library sells something close to this");
  });
  test("as prompt text, a one-liner and milestone tactics, each with links", () => {
    const r = findComparables(CARDS, plan, { now: NOW });
    const t = comparablesText(r);
    expect(t).toContain("revenue and prices are their own on-camera claims");
    expect(t).toContain('1. ClipPod [Nov 2025] — AI podcast clips for podcasters for podcasters; price "$29 a month"');
    expect(t).toContain(`claimed revenue "$12K a month" (${CARDS[0].url}&t=60s)`);
    expect(t).toContain("what failed: Stalled for months on churn");
    expect(comparablesLine(r)).toBe("Comparables: ClipPod (claimed $12K/mo, Reddit, Nov 2025) · Snippy (claimed $4K/mo, Reddit, Jun 2025) · CastCut (Reddit, Mar 2020)");
    const first = tacticsText(r, "First paying customer");
    expect(first).toContain("- Reddit: Posted before/after clips in r/podcasting — ClipPod (Nov 2025)");
    expect(tacticsText(r, "10 paying customers")).toContain("- YouTube: Partnered with podcast hosts on YouTube — ClipPod");
    expect(tacticsText(undefined, "x")).toBe("");
  });
});
