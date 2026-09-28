// Autoresearch, the pure part: campaigns, runs and the niche leaderboard as plain data, the planner (what to
// research next) and the loop's decisions (when to start, wait, pause or stop; which session is its own) as
// functions of that data and a clock. No I/O here. Reports and scoring: autoresearch-eval.ts.
//
// The loop (Karpathy's "autoresearch" shape): plan → run → evaluate → keep/discard → plan the next question.
import { inQuiet } from "../../src/push";
import { repairJson } from "../../src/text";

export { repairJson };

// ── types ─────────────────────────────────────────────────────────────────────────
export const QTYPES = ["trend", "deep_dive", "sizing", "combo", "teardown", "channel"] as const;
export type QType = (typeof QTYPES)[number];
export const QTYPE_LABEL: Record<QType, string> = {
  trend: "Trend scan", deep_dive: "Niche deep-dive", sizing: "Market sizing", combo: "Combo test", teardown: "Competitor teardown", channel: "Channel test",
};
export const SCORE_KEYS = ["demand", "willingness_to_pay", "competition", "fit_with_user_assets", "timing", "confidence"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type Scores = Partial<Record<ScoreKey, number>>;
export type Quiet = { on: boolean; from: string; to: string };
export type Link = { name: string; url: string };

/** planning (in memory only) → starting → running → evaluating → kept | discarded; or failed / skipped. */
export type RunState = "starting" | "running" | "evaluating" | "kept" | "discarded" | "failed" | "skipped";
export const ACTIVE: RunState[] = ["starting", "running", "evaluating"];
export type Run = {
  id: string; n: number; question: string; type: QType; why?: string; focus?: string; planner: "claude" | "template";
  slug: string; reportPath: string; label: string; cwd: string; machine: string; prompt?: string;
  state: RunState; key?: string; createdAt: number; startedAt?: number; reportAt?: number; endedAt?: number;
  error?: string; interrupted?: boolean; closed?: "closed" | "left-open" | "gone"; redelivered?: boolean; trustAnswered?: boolean;
  verdict?: string; title?: string; summary?: string; scores?: Scores; niches?: string[]; best?: { id: string; name: string; score: number }; merged?: boolean;
  discardWhy?: string; rejected?: { name: string; why: string }[]; // why the report or some of its niches didn't make the board
};
export type Niche = {
  id: string; name: string; summary: string; whyNow: string; audience: string;
  where: Link[]; pains: { quote: string; url: string }[]; competitors: { name: string; url: string; price?: string; gap?: string }[];
  prices: string[]; opportunities: string[]; evidence: string[];
  scores: Scores; rubric: number; jev?: number; score: number;
  runs: number[]; seen: number; firstAt: number; updatedAt: number;
};
export type CampaignStatus = "running" | "paused" | "stopped" | "done";
export type Campaign = {
  id: string; slug: string; goal: string; seeds: string[]; budget: number; dailyCap: number; machine: string; agent: "claude";
  model?: string; quiet: Quiet; runMinutes: number;
  status: CampaignStatus; reason?: string; waiting?: string;
  createdAt: number; startedAt: number; finishedAt?: number; lastRunAt?: number;
  runs: Run[]; board: Niche[]; openQuestions: string[]; failStreak: number; notified: string[];
};
export type Store = { v: 1; halted: boolean; campaigns: Campaign[]; stats: { planner: number; plannerFallback: number; jev: number; day: string; dayPlanner: number; dayJev: number } };

export const emptyStore = (): Store => ({ v: 1, halted: false, campaigns: [], stats: { planner: 0, plannerFallback: 0, jev: 0, day: "", dayPlanner: 0, dayJev: 0 } });

// ── small helpers ─────────────────────────────────────────────────────────────────────
export const slugify = (s: string, n = 48) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, " ").replace(/[_\s-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "");
export const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
export const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const STOP = new Set("a an and are as at be by can do does for from has have how i in into is it its me my now of on or our right that the their them these they this to what when where which who why will with you your than then there about over most more any all new best top find using use via vs versus just".split(" "));
export function words(s: string): string[] {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}
/** Jaccard overlap of content words: 1 is the same set, 0 nothing shared. */
export function overlap(a: string, b: string) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}
/** A question is novel when it isn't (nearly) one already asked. */
export function isNovel(q: string, previous: string[], threshold = 0.6) {
  const k = words(q).join(" ");
  if (!k) return false;
  return previous.every((p) => words(p).join(" ") !== k && overlap(q, p) < threshold);
}

// ── the planner ─────────────────────────────────────────────────────────────────────────
export type Plan = { question: string; type: QType; why: string; focus?: string; planner: "claude" | "template" };
const TYPE_ALIASES: Record<string, QType> = {
  trend: "trend", trend_scan: "trend", trends: "trend", scan: "trend",
  deep_dive: "deep_dive", deepdive: "deep_dive", niche: "deep_dive", niche_deep_dive: "deep_dive", deep: "deep_dive",
  sizing: "sizing", market_sizing: "sizing", market: "sizing", size: "sizing",
  combo: "combo", combo_test: "combo", combination: "combo",
  teardown: "teardown", competitor: "teardown", competitor_teardown: "teardown", competitors: "teardown",
  channel: "channel", channel_test: "channel", channels: "channel", distribution: "channel",
};
export const typeOf = (x: unknown): QType | undefined => TYPE_ALIASES[String(x ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_")];

/** `comparables`: founders most like the goal or the top niche (src/library-strategy.ts), as prompt text; "" when none. */
export function plannerPrompt(c: Campaign, assets: string[], comparables = "") {
  const system = "You plan the next step of a market-research loop for a solo developer. You answer with strict JSON only: no prose, no Markdown, no code fences.";
  const asked = c.runs.map((r) => `- #${r.n} [${r.type}] ${r.question}${r.state === "failed" ? " (failed)" : r.verdict ? ` → ${clip(r.verdict, 80)}` : ""}`);
  const top = c.board.slice(0, 8).map((n) => `- ${n.name} (score ${n.score}; demand ${n.scores.demand ?? "?"}, pay ${n.scores.willingness_to_pay ?? "?"}, competition ${n.scores.competition ?? "?"}, fit ${n.scores.fit_with_user_assets ?? "?"}; researched in runs ${n.runs.join(", ")})`);
  const user = [
    `Campaign goal: "${clip(c.goal, 300)}"`,
    c.seeds.length ? `Seeds to consider: ${c.seeds.map((s) => clip(s, 80)).join("; ")}` : "",
    assets.length ? `The builder's assets (projects, skills, services): ${assets.slice(0, 24).map((a) => clip(a, 70)).join("; ")}` : "",
    `Runs so far (${c.runs.length} of ${c.budget}):`, asked.length ? asked.join("\n") : "- none yet",
    `Niche leaderboard:`, top.length ? top.join("\n") : "- empty",
    c.openQuestions.length ? `Open questions from the reports:\n${c.openQuestions.slice(-8).map((q) => `- ${clip(q, 160)}`).join("\n")}` : "",
    comparables ? `\n${comparables}\nUse them: what worked for founders like these (their first-customer channels, prices, what failed) is a hypothesis to test for this niche, e.g. a channel test where they found first customers, or a teardown at their price points. Don't research what they already answer.` : "",
    "",
    "Pick the single next research question that most improves the answer to the goal. Explore first (a trend scan when little is known), then exploit: deep-dive the best niches, tear down their competitors, test the channels where their buyers gather, test combos (one of the builder's assets + a channel + an audience), and size the market of the top one. Never repeat or rephrase a question already asked. One question, answerable in about 20 minutes of web research.",
    "Make it sharp: name the buyer, the product or job, and the evidence that would answer it (e.g. \"What do Etsy sellers of HD charts charge, and what do 1–3★ reviews of the top 5 complain about?\"). Never a vague one like \"research the AI market\".",
    `Types: ${QTYPES.join(", ")}.`,
    'Reply with exactly: {"question":"...","type":"trend|deep_dive|sizing|combo|teardown|channel","why":"one sentence","focus":"the niche it is about, or empty"}',
  ].filter(Boolean).join("\n");
  return { system, user };
}

/** "Research the AI market", "everything about creators": too broad to answer with evidence in one run. */
export const vague = (q: string) => words(q).length < 5 || /\b(the (ai|tech|software) (market|industry|space)|in general|everything about|all (the )?(trends|opportunities))\b/i.test(q);
/** A model's plan, or undefined when it's unreadable, off-type or not new. */
export function validatePlan(raw: unknown, previous: string[]): Plan | undefined {
  const j = typeof raw === "string" ? repairJson(raw) : raw;
  const o = j && typeof j === "object" ? ((j as any).plan ?? (j as any).next ?? j) : undefined;
  if (!o || typeof o !== "object") return undefined;
  const question = clip((o as any).question, 300);
  const type = typeOf((o as any).type);
  if (!type || question.length < 15 || vague(question) || !isNovel(question, previous)) return undefined;
  return { question, type, why: clip((o as any).why, 200), focus: clip((o as any).focus, 80) || undefined, planner: "claude" };
}

/** A goal's topic: its first clause ("Hot AI-video businesses right now: …" → "Hot AI-video businesses right now"). */
const topicOf = (goal: string) => clip(goal.split(/[:?.;]\s/)[0], 90);
const ANGLES = ["for creators and coaches", "for small businesses", "B2B tools a solo developer can sell", "consumer mobile apps", "Hebrew and Israeli market", "Discord and community tools", "AI agents as a service", "digital downloads and templates"];
const FOLLOW: QType[] = ["deep_dive", "teardown", "channel", "combo", "sizing"];
function templateQ(type: QType, niche: string, c: Campaign, assets: string[], k = 0): string {
  const asset = assets[k % Math.max(1, assets.length)] ?? "my existing projects";
  switch (type) {
    case "deep_dive": return `Niche deep-dive: "${niche}". What pains do these people describe in their own words, who exactly are they, what do they pay for today, and where is the gap?`;
    case "teardown": return `Competitor teardown for "${niche}": who sells what, at which prices, what their users complain about, and where the opening is for a solo builder.`;
    case "channel": return `Channel test for "${niche}": where do these buyers gather (subreddits, Discords, YouTube channels, newsletters, forums), how active are those places, and how could a solo builder reach them without spam?`;
    case "combo": return `Combo test: does "${asset}" + a community channel + the "${niche}" audience have demand? Look for evidence people want exactly that combination.`;
    case "sizing": return `Market sizing for "${niche}": how many potential buyers, what they spend now, and a realistic first-year revenue range for a solo builder.`;
    default: return `Trend scan: ${topicOf(c.goal)}${niche ? ` (${niche})` : ""}. Which 3–5 niches are rising in the last 30 days, who pays in each, and what do they pay?`;
  }
}
/** The deterministic planner: used when headless Claude is missing, slow or answers nonsense. Explore, then exploit the best niches. */
export function templatePlan(c: Campaign, assets: string[] = []): Plan {
  const prev = c.runs.map((r) => r.question);
  const ok = (q: string) => isNovel(q, prev);
  const done = new Set(c.runs.filter((r) => r.focus).map((r) => `${r.type}|${(r.focus ?? "").toLowerCase()}`));
  if (!c.runs.length) {
    const q = templateQ("trend", "", c, assets);
    return { question: q, type: "trend", why: "Nothing is known yet: start wide and see what's rising.", planner: "template" };
  }
  // Exploit: the best niches, each through the follow-up sequence.
  for (const n of c.board.slice(0, 5)) {
    for (const t of FOLLOW) {
      if (done.has(`${t}|${n.name.toLowerCase()}`)) continue;
      const q = templateQ(t, n.name, c, assets, c.runs.length);
      if (ok(q)) return { question: q, type: t, focus: n.name, why: `“${n.name}” scores ${n.score}; next: ${QTYPE_LABEL[t].toLowerCase()}.`, planner: "template" };
    }
  }
  // Explore: seeds, open questions, then new angles on the goal.
  for (const s of c.seeds) {
    const q = `Trend scan: ${clip(s, 100)}. What is rising in the last 30 days around it, and which niches in it have people paying?`;
    if (ok(q)) return { question: q, type: "trend", focus: s, why: `A seed you gave: ${clip(s, 60)}.`, planner: "template" };
  }
  for (const oq of c.openQuestions) {
    const q = `Open question from an earlier run: ${clip(oq, 200)}`;
    if (ok(q)) return { question: q, type: "deep_dive", why: "An earlier report left this open.", planner: "template" };
  }
  for (let i = 0; i < ANGLES.length; i++) {
    const q = `Trend scan: ${topicOf(c.goal)}, ${ANGLES[(i + c.runs.length) % ANGLES.length]}. What is rising right now, who pays for it and how much?`;
    if (ok(q)) return { question: q, type: "trend", why: `A new angle: ${ANGLES[(i + c.runs.length) % ANGLES.length]}.`, planner: "template" };
  }
  return { question: `Trend scan #${c.runs.length + 1}: ${topicOf(c.goal)}. What changed this week, with links?`, type: "trend", why: "Every other angle was covered.", planner: "template" };
}

// ── the loop's decisions ─────────────────────────────────────────────────────────────
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const quietNow = (now: number, q: Quiet | undefined) => inQuiet(new Date(now), q);
export const runsStartedOn = (c: Campaign, day: string) => c.runs.filter((r) => r.startedAt && localDay(r.startedAt) === day).length;
/** Attempts that count against the budget: every run that started (failed and skipped ones too). */
export const attempts = (c: Campaign) => c.runs.filter((r) => r.state !== "skipped" || r.startedAt).length;
export const activeRun = (c: Campaign) => c.runs.find((r) => ACTIVE.includes(r.state));
export type Next = { act: "done" | "pause" | "wait" | "plan" | "none"; why?: string };
/** What a campaign may do next when nothing is running. */
export function nextStep(c: Campaign, now: number, halted = false): Next {
  if (halted) return { act: "none", why: "Stopped by the kill switch" };
  if (c.status !== "running") return { act: "none" };
  if (activeRun(c)) return { act: "none", why: "A run is in progress" };
  if (attempts(c) >= c.budget) return { act: "done", why: `All ${c.budget} runs are done` };
  if (c.failStreak >= 2) return { act: "pause", why: "Two runs in a row failed" };
  if (quietNow(now, c.quiet)) return { act: "wait", why: `Quiet hours until ${c.quiet.to}` };
  if (runsStartedOn(c, localDay(now)) >= c.dailyCap) return { act: "wait", why: `Today's cap of ${c.dailyCap} run${c.dailyCap === 1 ? "" : "s"} is reached; more tomorrow` };
  return { act: "plan" };
}
/** Only the loop's own session may be closed: the same key, still labeled "research: …", in the run's own folder. */
export function canClose(row: { key: string; tab?: string; title?: string; cwd?: string } | undefined, run: Pick<Run, "key" | "label" | "cwd">) {
  if (!row || !run.key || row.key !== run.key) return false;
  const lab = (row.tab ?? "").trim() || (row.title ?? "").trim();
  if (!/^research:/i.test(lab)) return false;
  return !!row.cwd && (row.cwd === run.cwd || row.cwd.replace(/^\/private/, "") === run.cwd.replace(/^\/private/, ""));
}
export type RowLite = { key: string; tab?: string; title?: string; status: string; cwd?: string; firstPrompt?: string; machine?: string };
/** The row a run's session lives in: by key, else (after a restart mid-start) by its label and folder, or by the report path in its first message. */
export function findRow(rows: RowLite[], run: Pick<Run, "key" | "label" | "cwd" | "reportPath">) {
  return (run.key ? rows.find((r) => r.key === run.key) : undefined)
    ?? rows.find((r) => (r.tab ?? "") === run.label && r.cwd === run.cwd)
    ?? rows.find((r) => !!r.firstPrompt && r.firstPrompt.includes(run.reportPath));
}
const SHORT: [RegExp, string][] = [[/^trend scan\s*[:#\d]*\s*/i, ""], [/^niche deep-dive:\s*/i, "deep-dive "], [/^competitor teardown( for)?:?\s*/i, "teardown "], [/^channel test( for)?:?\s*/i, "channels "], [/^market sizing( for)?:?\s*/i, "sizing "], [/^combo test:?\s*/i, "combo "]];
/** The session's tab label: "research: teardown GEO audits for local…". Runs on the same niche stay tellable apart. */
export const labelFor = (question: string) => `research: ${clip(SHORT.reduce((q, [re, w]) => q.replace(re, w), question).replace(/["“”]/g, ""), 36)}`;
