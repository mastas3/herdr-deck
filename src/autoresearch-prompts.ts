// Autoresearch: the words it sends. Goal presets, the prompt a research session runs, the "Plan the app" prompt,
// and the fixture reports the fake runner writes.
import { QTYPE_LABEL, clip, type Campaign, type Niche, type QType, type Run } from "./autoresearch-core";

/** Goal presets for a new campaign, from the user's own portfolio (wiki: HD tech, YouTube/RAG, agents, video, local automation). */
export const PRESETS = [
  { id: "assets", label: "Best niches for my assets", goal: "The best niches I can build in right now with my assets (Human Design engine, YouTube clip + RAG pipeline, agent orchestration, procedural video, SvelteKit apps): where is demand + willingness to pay + a gap?" },
  { id: "hd", label: "Human Design products", goal: "Human Design audience products people pay for right now: readings, apps, courses, tools for HD coaches. Where is the unmet demand?" },
  { id: "video", label: "AI-video businesses", goal: "Hot AI-video businesses right now: faceless explainers, podcast clips, procedural shorts, AI UGC. Which niches have paying buyers and weak competition?" },
  { id: "agents", label: "Tools for agent-heavy devs", goal: "Tools people running many AI coding agents would pay for: dashboards, orchestration, review, cost control. What is rising and what is missing?" },
  { id: "local", label: "Local business automation", goal: "Automation products local businesses pay for right now: lead gen, GEO/SEO audits, AI receptionists, tender monitoring. Which niche is easiest to win?" },
  { id: "creators", label: "Creator knowledge bases", goal: "Paid products built on a creator's content: RAG over YouTube channels, voice clones that answer questions, course assistants. Who pays and how much?" },
  { id: "hebrew", label: "Hebrew-first AI tools", goal: "Hebrew-first AI tools Israeli small businesses and creators would pay for right now. Where do global tools fall short in Hebrew?" },
  { id: "games", label: "Mobile web games that earn", goal: "Mobile web games a solo developer can ship in a week that make money right now (ads, IAP, sponsorships). Which genres and channels work?" },
];

const STEP: Record<QType, string> = {
  trend: "Map what is rising: topics, products, complaints and money moving in the last 30 days. Name 3–5 concrete niches that are heating up, each with the evidence (links) that it's rising and that people pay.",
  deep_dive: "Go deep on this one niche: the pains in the buyers' own words (quotes with links), exactly who they are, what they pay for today and how much, the competitors, and the gap nobody fills.",
  sizing: "Size the market: how many potential buyers (communities, search volume, app downloads, subscriber counts — whatever public numbers exist), what they spend now, and a realistic first-year revenue range for a solo builder. Show the arithmetic.",
  combo: "Test the combination: find evidence that people want exactly this asset + channel + audience together (requests, searches, paid workarounds), and evidence against it. Say plainly whether the combo has demand.",
  teardown: "Tear down the competitors: a table of who sells what (name, link, price, audience, traction signals) and what their users complain about (1–3★ reviews, forum threads). End with the opening a solo builder could take.",
  channel: "Find where these buyers gather: subreddits, Discord servers, YouTube channels, newsletters, forums, hashtags, marketplaces — each with a link, size or activity, and how welcome a new tool is there (rules on self-promotion). Rank them by reach for a solo builder who never spams.",
};

/** The research session's first (and only) message. It never contacts anyone and writes one report with front matter + a JSON block. */
export function researchPrompt(run: Pick<Run, "n" | "question" | "type" | "why" | "focus" | "reportPath">, c: Pick<Campaign, "goal" | "seeds" | "budget" | "board" | "openQuestions" | "runMinutes">, assets: string[] = [], opts: { home?: string } = {}) {
  const file = opts.home ? run.reportPath.replace(opts.home, "~") : run.reportPath;
  const topic = clip(run.focus || run.question.replace(/^[^:]{0,40}:\s*/, ""), 70).replace(/[“”"]/g, "");
  const found = c.board.slice(0, 6).map((n) => `- ${n.name} (score ${n.score}/100${n.whyNow ? `; why now: ${clip(n.whyNow, 90)}` : ""})`);
  const date = new Date().toISOString().slice(0, 10);
  return [
    `Autoresearch run #${run.n} of ${c.budget}: ${QTYPE_LABEL[run.type]}. Work on your own until the report is written. Don't ask me anything (no questions, no AskUserQuestion, no setup wizards); when something is ambiguous, pick the sensible option and note it in the report. Aim for about ${Math.max(10, Math.min(c.runMinutes - 10, 30))} minutes.`,
    "",
    `The campaign's goal: "${clip(c.goal, 300)}"`,
    `This run's question: ${run.question}`,
    run.why ? `Why this question now: ${run.why}` : "",
    c.seeds.length ? `Seeds from me: ${c.seeds.map((s) => clip(s, 80)).join("; ")}` : "",
    assets.length ? `Who it's for: a solo developer who builds with coding agents. My assets: ${assets.slice(0, 20).map((a) => clip(a, 70)).join("; ")}.` : "Who it's for: a solo developer who builds with coding agents.",
    found.length ? `Earlier runs already found (build on these, don't repeat them):\n${found.join("\n")}` : "",
    c.openQuestions.length ? `Open questions from earlier runs: ${c.openQuestions.slice(-4).map((q) => clip(q, 120)).join(" · ")}` : "",
    "",
    "Rules (strict): research only. Read public pages and posts. Never contact, message, email, follow, reply to, post, comment, sign up, log in, subscribe to, buy or download anything paid. Never collect private data: public handles and links only, no emails, phone numbers or real names.",
    "",
    "Evidence (strict): primary sources only, each linked: the post, review, repo, pricing page or filing itself, not an article about it. Quotes are verbatim and short (one or two sentences). No invented numbers: every figure has a link, and every estimate shows its arithmetic and the linked numbers it's built from. \"No evidence found\" is a good, honest answer; say it instead of filling the gap. No filler (\"rapidly evolving landscape\", \"game-changer\") and no buzzword niches (\"AI platform for creators\"): name the buyer, the job and the product. A niche only counts with a named buyer, a linked place where they gather, a price seen in the market (linked) and at least one linked pain in their own words; leave the others out of the JSON.",
    "",
    `1. Run the last30days skill: \`/last30days ${topic}\` (Reddit, X, YouTube, TikTok, Hacker News, Polymarket, GitHub, the web). Skip any setup or onboarding it offers and use what's already configured. If the skill isn't available, say so in the report and use web search instead.`,
    `2. Search the web for deeper and older evidence (reviews, forums, Product Hunt, pricing pages, public communities). ${STEP[run.type]}`,
    "3. Score what you found, 0–10 each: demand (people actively asking or complaining), willingness_to_pay (evidence of money spent: prices paid, paid workarounds, \"I'd pay\"), competition (10 = crowded with strong incumbents), fit_with_user_assets (how much my assets above give me an edge), timing (10 = rising right now), confidence (how strong and fresh the evidence is).",
    `4. Write the report to ${file} (create the folder if needed) as Markdown with exactly this front matter:`,
    "---",
    `question: ${run.question.replace(/\n+/g, " ")}`,
    `type: ${run.type}`,
    `date: ${date}`,
    "verdict: <pursue | investigate | drop> — <one line why>",
    "scores:",
    "  demand: <0-10>",
    "  willingness_to_pay: <0-10>",
    "  competition: <0-10>",
    "  fit_with_user_assets: <0-10>",
    "  timing: <0-10>",
    "  confidence: <0-10>",
    "---",
    "# <a short title>",
    "## In one paragraph",
    "## What the evidence says (with a link for every claim)",
    "## Niches and opportunities (ranked)",
    "## Open questions",
    "## Sources",
    "## Findings (machine-readable)",
    "A fenced ```json block with exactly this shape (one entry per niche, best first; scores 0–10 per niche; real links only):",
    '{"niches":[{"name":"short niche name","summary":"one line","why_now":"one line","audience":"who pays","where":[{"name":"r/example","url":"https://…"}],"pains":[{"quote":"their words","url":"https://…"}],"competitors":[{"name":"…","url":"https://…","price":"$19/mo","gap":"what they miss"}],"price_points":["$19/mo for …"],"opportunities":["a product idea in one line"],"evidence":["https://…"],"scores":{"demand":7,"willingness_to_pay":6,"competition":4,"fit_with_user_assets":8,"timing":7,"confidence":6}}],"open_questions":["…"],"opportunities":["…"]}',
    "5. When the file is written, reply with its path and a five-line summary, then stop.",
  ].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
}

/** "Plan the app" for a leaderboard niche: everything the research found, as a planning session's first message. */
export function planAppPrompt(n: Niche, file: string, reportsDir: string) {
  const ev = [...n.pains.filter((p) => p.url).map((p) => `- "${clip(p.quote, 200)}" ${p.url}`), ...n.evidence.slice(0, 6).map((u) => `- ${u}`)].slice(0, 10);
  return [
    `Plan an app for this niche, then write the plan to ${file} (create the folder if needed).`,
    "",
    `The niche: ${n.name}${n.summary ? ` — ${n.summary}` : ""}`,
    n.audience ? `Who pays: ${n.audience}` : "",
    n.whyNow ? `Why now: ${n.whyNow}` : "",
    `Research scores (0–10): demand ${n.scores.demand ?? "?"}, willingness to pay ${n.scores.willingness_to_pay ?? "?"}, competition ${n.scores.competition ?? "?"}, fit ${n.scores.fit_with_user_assets ?? "?"}, timing ${n.scores.timing ?? "?"}. Overall ${n.score}/100${n.jev != null ? `; Jev puts ≥10 paying customers in 60 days at ${Math.round(n.jev * 100)}%` : ""}.`,
    n.competitors.length ? `Competitors: ${n.competitors.slice(0, 6).map((x) => `${x.name}${x.price ? ` (${x.price})` : ""}${x.url ? ` ${x.url}` : ""}`).join("; ")}` : "",
    n.where.length ? `Where they gather: ${n.where.slice(0, 6).map((w) => `${w.name}${w.url ? ` ${w.url}` : ""}`).join("; ")}` : "",
    ev.length ? `Evidence (open and read these first):\n${ev.join("\n")}` : "",
    `The research reports behind it are in ${reportsDir}/ (runs ${n.runs.join(", ")}).`,
    "",
    "This is planning only: don't build anything yet, and don't contact, message, sign up for, buy or publish anything.",
    "Write the plan as Markdown with front matter (idea: <one line>, created: <today>, status: plan) and sections: In one paragraph · The evidence (with links) · Who it's for first · What exists and why it falls short · The product (core flow) · 1-week MVP (day by day) · How it reaches them (no spam) · Pricing · Costs and risks · First 3 tasks. Then reply with its path and a five-line summary.",
  ].filter(Boolean).join("\n");
}

// ── the fake runner's reports ─────────────────────────────────────────────────────────
function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
const hash = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const ARCHETYPES = [
  ["AI clip studio for podcasters", "podcasters who publish weekly", "r/podcasting"],
  ["Human Design chart readings as voice notes", "HD readers and coaches", "r/humandesign"],
  ["Faceless explainer videos for course creators", "course creators", "r/coursecreators"],
  ["Agent dashboards for indie developers", "developers running many coding agents", "r/ClaudeAI"],
  ["GEO audits for local businesses", "local business owners", "r/smallbusiness"],
  ["Procedural short films for brands", "small DTC brands", "r/marketing"],
  ["Creator knowledge bases (RAG over a YouTube channel)", "YouTube educators", "r/NewTubers"],
  ["Hebrew-first AI assistants for Israeli SMBs", "Israeli small businesses", "r/Israel"],
];
/** A plausible, deterministic report for the fake runner (tests and UI work without spending agent time). */
export function fixtureReport(run: Pick<Run, "n" | "question" | "type" | "focus">, c: Pick<Campaign, "goal" | "id">, seed = 0) {
  const r = rng(hash(`${c.id}|${run.n}|${seed}`));
  const pick = () => ARCHETYPES[Math.floor(r() * ARCHETYPES.length)];
  const s = () => Math.round((4 + r() * 5.5) * 10) / 10;
  const picks = run.focus ? [[run.focus, "the people in that niche", "r/SideProject"], pick()] : [pick(), pick(), pick()];
  const niches = picks.filter((x, i, a) => a.findIndex((y) => y[0] === x[0]) === i).map(([name, who, where], i) => ({
    name, summary: `${name}: a small, paid tool ${who} keep asking for.`, why_now: "Posts about it doubled in the last 30 days.", audience: who,
    where: [{ name: where, url: `https://www.reddit.com/${where}/` }],
    pains: [{ quote: `Is there a tool that does ${name.toLowerCase()} without the busywork?`, url: `https://www.reddit.com/${where}/comments/fake${run.n}${i}/` }],
    competitors: [{ name: `${name.split(" ")[0]}ly`, url: "https://example.com/competitor", price: `$${9 + Math.floor(r() * 40)}/mo`, gap: "No mobile flow, slow support" }],
    price_points: [`$${5 + Math.floor(r() * 30)}/mo`],
    opportunities: [`A weekend MVP of ${name.toLowerCase()}`],
    evidence: [`https://news.ycombinator.com/item?id=${40000000 + run.n * 10 + i}`, `https://www.producthunt.com/posts/fake-${run.n}-${i}`, `https://github.com/search?q=fake-${run.n}-${i}`],
    scores: { demand: s(), willingness_to_pay: s(), competition: s(), fit_with_user_assets: s(), timing: s(), confidence: s() },
  }));
  // One niche the slop filters must drop: a buzzword name, no buyer, no links, no price.
  const slop = { name: "AI platform for creators", summary: "An all-in-one AI platform for everyone.", scores: { demand: 9, willingness_to_pay: 8, competition: 3, fit_with_user_assets: 8, timing: 9, confidence: 7 } };
  const top = niches[0].scores;
  const verdict = top.demand + top.willingness_to_pay > 12 ? "pursue — demand and paying signals both show up" : "investigate — some demand, thin paying signals";
  return [
    "---",
    `question: ${run.question.replace(/\n+/g, " ")}`,
    `type: ${run.type}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `verdict: ${verdict}`,
    "scores:",
    ...Object.entries(top).map(([k, v]) => `  ${k}: ${v}`),
    "---",
    `# ${niches[0].name} (simulated run #${run.n})`,
    "## In one paragraph",
    `This is a fake-runner report for "${clip(c.goal, 80)}". It exercises the loop without spending agent time: the niches, links and numbers below are made up.`,
    "## Niches and opportunities (ranked)",
    ...niches.map((n) => `- **${n.name}** — ${n.summary}`),
    "## Open questions",
    `- Would ${niches[0].audience} pay yearly?`,
    "## Findings (machine-readable)",
    "```json",
    JSON.stringify({ niches: [...niches, slop], open_questions: [`Would ${niches[0].audience} pay yearly?`], opportunities: niches.map((n) => n.opportunities[0]) }, null, 1),
    "```",
    "",
  ].join("\n");
}
