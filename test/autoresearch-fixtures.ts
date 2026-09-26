// Shared fixtures for the autoresearch tests: a campaign, a run and a research report that passes every filter.
import type { Campaign, Run } from "../src/autoresearch-core";

export const T0 = new Date(2026, 8, 26, 12, 0, 0).getTime(); // local noon: outside any night quiet window
export const MIN = 60_000;

export function camp(o: Partial<Campaign> = {}): Campaign {
  return { id: "c1", slug: "c1", goal: "best niches for AI video tools", seeds: [], budget: 5, dailyCap: 5, machine: "mac", agent: "claude", quiet: { on: false, from: "23:00", to: "07:00" }, runMinutes: 45,
    status: "running", createdAt: T0, startedAt: T0, runs: [], board: [], openQuestions: [], failStreak: 0, notified: [], ...o };
}
export function run(o: Partial<Run> = {}): Run {
  return { id: "r1", n: 1, question: "Trend scan: AI video tools", type: "trend", planner: "template", slug: "s", reportPath: "/x/01-s.md", label: "research: AI video tools", cwd: "/w/c1", machine: "mac", state: "kept", createdAt: T0, startedAt: T0, ...o };
}
export const REPORT = (o: { verdict?: string; scores?: string; json?: string; question?: string } = {}) => `---
question: ${o.question ?? "What is rising in AI video?"}
type: trend
date: 2026-09-26
verdict: ${o.verdict ?? "pursue — demand and paying signals"}
${o.scores ?? `scores:
  demand: 8
  willingness_to_pay: 7/10
  competition: 4
  fit_with_user_assets: 9
  timing: high
  confidence: 6`}
---
# Podcast clips are hot

## In one paragraph
Podcasters want clips: "I spend 3 hours a week cutting clips" (https://www.reddit.com/r/podcasting/comments/abc/). Opus Clip charges $19/mo (https://www.opus.pro/pricing);
reviews complain about bad crops (https://www.trustpilot.com/review/opus.pro). A Show HN clip tool got 120 points (https://news.ycombinator.com/item?id=2).

## Findings (machine-readable)
\`\`\`json
${o.json ?? JSON.stringify({ niches: [
  { name: "AI clip studio for podcasters", summary: "clips", why_now: "rising", audience: "podcasters", where: [{ name: "r/podcasting", url: "https://www.reddit.com/r/podcasting/" }], pains: [{ quote: "I hate clipping by hand", url: "https://www.reddit.com/r/podcasting/comments/abc/" }], competitors: [{ name: "Opus Clip", url: "https://opus.pro", price: "$19/mo" }], price_points: ["$19/mo"], evidence: ["https://news.ycombinator.com/item?id=1"], scores: { demand: 8, willingness_to_pay: 7, competition: 5, fit_with_user_assets: 9, timing: 8, confidence: 6 } },
  { name: "Faceless explainers for course creators", summary: "explainers", scores: { demand: 5, willingness_to_pay: 4, competition: 7, fit_with_user_assets: 6, timing: 5, confidence: 4 } },
], open_questions: ["Would they pay yearly?"], opportunities: ["Clip bot"] })}
\`\`\`
`;

// ── planner ─────────────────────────────────────────────────────────────────────────
