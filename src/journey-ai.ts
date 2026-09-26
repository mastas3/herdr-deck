// Project pages, part 2: the AI read of a journey. One headless Claude Code call per project (a fast model, low
// effort, no tools, no MCP, no settings or plugins, nothing saved) turns a compact digest of the evidence into
// direction changes, side-quest names, a milestone ladder that fits the project, where it's heading and a short
// story. The answer is validated and repaired; anything unusable falls back to deterministic rules, so a project
// page never waits on a model and never shows an achievement the evidence doesn't back.
//
// Only titles, dates, commit subjects, TLDRs and counts go into the digest: never transcripts, file contents or
// anything key-like.
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { clip, hash, type JEvent, type Metric } from "./journey-collect";

const HOME = homedir();

// ── milestone vocabulary ──────────────────────────────────────────────────────────
export type Nature = "consumer-app" | "tool" | "creative" | "internal" | "content";
export type LadderItem = { id: string; title: string; metric: string; unit: string; target: number; source: string; why?: string; tier: number };

/** Metric sources a milestone can be measured by. `manual.<name>` is anything you log yourself. */
export const SOURCES: Record<string, string> = {
  "git.commits": "commits", "git.active_days": "days with commits", "git.contributors": "contributors", "git.tags": "tags/releases in git", "git.side_quests": "side quests",
  "deploy.setups": "deploy setups", "deploy.live": "live deploys found",
  "sessions.count": "agent sessions", "sessions.agent_hours": "agent hours", "sessions.prompts": "prompts sent",
  "github.stars": "GitHub stars", "github.external_stars": "stars from others", "github.forks": "forks", "github.external_issues": "issues from others", "github.releases": "GitHub releases",
  "gumroad.sales": "Gumroad sales", "gumroad.revenue": "Gumroad revenue",
  "wiki.updates": "wiki updates",
};
/** Units each measured source really counts. A milestone whose unit isn't one of them is measuring something else. */
const UNITS: Record<string, string[]> = {
  "git.commits": ["commit", "commits"], "git.active_days": ["day", "days", "active days"], "git.contributors": ["contributor", "contributors", "people", "authors", "author"],
  "git.tags": ["tag", "tags", "release", "releases", "version", "versions"], "git.side_quests": ["quest", "quests", "side quests", "branch", "branches"],
  "deploy.setups": ["setup", "setups", "deploy setup", "deploy setups", "config", "configs"], "deploy.live": ["deploy", "deploys", "deployment", "deployments", "live", "launch", "launches"],
  "sessions.count": ["session", "sessions"], "sessions.agent_hours": ["h", "hr", "hrs", "hour", "hours"], "sessions.prompts": ["prompt", "prompts"],
  "github.stars": ["star", "stars"], "github.external_stars": ["star", "stars"], "github.forks": ["fork", "forks"], "github.external_issues": ["issue", "issues"], "github.releases": ["release", "releases"],
  "gumroad.sales": ["sale", "sales", "orders", "customers", "customer"], "gumroad.revenue": ["$", "usd", "dollars"], "wiki.updates": ["update", "updates", "entries", "notes"],
};
/**
 * A measured milestone must be about what its source counts: "Hebrew support" measured by side quests would unlock
 * from branches, which proves nothing about Hebrew. Anything whose unit doesn't fit becomes a manual metric.
 */
/** "API-first native endpoints live" → "api_first_native_endpoints": whole words, at most 30 characters. */
export function metricName(title: string) {
  let out = "";
  for (const w of slug(title, 80).split("-")) { if ((out ? out.length + 1 : 0) + w.length > 30) break; out = out ? `${out}_${w}` : w; }
  return (out || "metric").replace(/^(\d)/, "m$1");
}
export function guardLadder(items: LadderItem[]): LadderItem[] {
  return items.map((m) => {
    const ok = UNITS[m.source];
    if (!ok) return m;
    const u = String(m.unit ?? "").trim().toLowerCase();
    // The title has to be about a count ("100 commits", "First release", "Six deploys"), not a feature it can't see.
    const counted = /^\s*(the\s+)?first\b/i.test(m.title) || /(^|[\s$(~])\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand)\b/i.test(m.title) || ok.some((w) => w.length > 2 && new RegExp(`\\b${w.replace(/[$]/g, "\\$")}`, "i").test(m.title));
    if ((!u || ok.includes(u)) && counted) return { ...m, unit: m.unit || ok[ok.length > 1 ? 1 : 0] };
    // A count of something else ("5 services"): you log that count. A feature or event: you mark it done.
    if (u && !ok.includes(u) && /^[a-z][a-z /-]{1,24}$/.test(u) && counted) return { ...m, source: `manual.${metricName(u)}`, metric: u.replace(/\b\w/, (c) => c.toUpperCase()) };
    return { ...m, source: `manual.${metricName(m.title)}`, metric: "Done", unit: "", target: 1 };
  });
}
export const isSource = (s: string) => s in SOURCES || /^manual\.[a-z][a-z0-9_]{1,30}$/.test(s);
export const slug = (s: string, n = 40) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "m";

const TAGSETS: [Nature, RegExp][] = [
  ["creative", /\b(film|short-film|procedural-film|animation|animated|story|storytelling|music|art|comic|trailer|movie|screenplay)\b/],
  ["content", /\b(seo|blog|newsletter|channel|content|course|book|writing|social-media)\b/],
  ["tool", /\b(library|sdk|cli|mcp|skill|plugin|package|npm|framework|api-client|open-source|devtool|extension)\b/],
  ["consumer-app", /\b(saas|app|pwa|mobile|game|funnel|ecommerce|payments|marketing|launch|consumer|web-app|startup|product|stripe|gumroad|chat|monorepo|sveltekit|nextjs|human-design)\b/],
  ["internal", /\b(dashboard|internal|ops|automation|agent-orchestration|pipeline|research|infra|tooling|scraper|osint|rag|knowledge-base|transcription|local-first)\b/],
];
/** What kind of project this is, from its wiki tags (and pitch when tags say nothing). The AI can overrule it. */
export function guessNature(tags: string[], text = ""): Nature {
  const score = new Map<Nature, number>();
  for (const t of tags.map((x) => x.toLowerCase())) for (const [n, re] of TAGSETS) if (re.test(t)) score.set(n, (score.get(n) ?? 0) + 1);
  if (!score.size) for (const [n, re] of TAGSETS) if (re.test(text.toLowerCase())) score.set(n, (score.get(n) ?? 0) + 0.5);
  let best: Nature = "internal", bs = 0;
  for (const [n, re] of TAGSETS) { const s = score.get(n) ?? 0; if (s > bs) { best = n; bs = s; } void re; }
  return best;
}

const L = (title: string, source: string, target: number, unit: string, metric: string, tier: number, why?: string): LadderItem => ({ id: slug(title), title, source, target, unit, metric, tier, why });
/** The deterministic ladder for a kind of project: used when no model is available, and as the AI's example. */
export function templateLadder(nature: Nature): LadderItem[] {
  const start = [L("First commit", "git.commits", 1, "commits", "Commits", 0), L("50 agent hours", "sessions.agent_hours", 50, "h", "Agent hours", 1)];
  const by: Record<Nature, LadderItem[]> = {
    "consumer-app": [
      L("First deploy", "deploy.setups", 1, "setups", "Deploy setups", 1), L("First user", "manual.users", 1, "users", "Users", 2), L("10 users", "manual.users", 10, "users", "Users", 2),
      L("First paying customer", "manual.paying_customers", 1, "customers", "Paying customers", 3), L("100 users", "manual.users", 100, "users", "Users", 3),
      L("$100 MRR", "manual.mrr", 100, "$", "Monthly revenue", 4), L("100 daily actives", "manual.dau", 100, "users/day", "Daily active users", 4),
      L("$1k MRR", "manual.mrr", 1000, "$", "Monthly revenue", 5), L("1,000 users", "manual.users", 1000, "users", "Users", 5), L("$10k MRR", "manual.mrr", 10000, "$", "Monthly revenue", 6),
    ],
    tool: [
      L("First release", "git.tags", 1, "releases", "Releases", 1), L("First star from someone else", "github.external_stars", 1, "stars", "Stars from others", 2),
      L("First outside issue", "github.external_issues", 1, "issues", "Issues from others", 2), L("10 stars", "github.stars", 10, "stars", "GitHub stars", 3),
      L("1,000 downloads a month", "manual.downloads_month", 1000, "downloads", "Downloads a month", 4), L("100 stars", "github.stars", 100, "stars", "GitHub stars", 5),
    ],
    creative: [
      L("First cut", "manual.cuts", 1, "cuts", "Cuts", 1), L("Final render", "manual.final_renders", 1, "renders", "Final renders", 2), L("First public screening", "manual.screenings", 1, "screenings", "Screenings", 3),
      L("1,000 views", "manual.views", 1000, "views", "Views", 4), L("10,000 views", "manual.views", 10000, "views", "Views", 5),
    ],
    content: [
      L("First piece published", "manual.published", 1, "pieces", "Published", 1), L("100 readers", "manual.views", 100, "views", "Views", 2), L("100 subscribers", "manual.subscribers", 100, "subscribers", "Subscribers", 3),
      L("10,000 views", "manual.views", 10000, "views", "Views", 4), L("First sponsor or sale", "manual.paying_customers", 1, "customers", "Paying customers", 5),
    ],
    internal: [
      L("Runs as a service", "deploy.setups", 1, "setups", "Deploy setups", 1), L("Used 7 days", "git.active_days", 7, "days", "Active days", 2), L("100 agent sessions", "sessions.count", 100, "sessions", "Agent sessions", 3),
      L("Daily driver: used 30 days", "manual.days_used", 30, "days", "Days used", 3), L("Replaced the old way", "manual.replaced", 1, "tools", "Tools replaced", 4), L("First other person uses it", "manual.users", 2, "users", "Users", 5),
    ],
  };
  return [...start, ...by[nature]];
}

// ── the digest ───────────────────────────────────────────────────────────────────
export type DigestInput = {
  project: string; tldr?: string; status?: string; tags: string[]; origin?: string; early?: string[]; next?: string[];
  events: JEvent[]; quests: { id: string; label: string; status: string; commits: number; sessions: number; from: number; to: number; subjects: string[] }[];
  metrics: Metric[]; nature: Nature;
};
const d10 = (t: number) => new Date(t).toISOString().slice(0, 10);
/** At most `max` events, spread over time: the heaviest per stretch first, always in date order. */
export function pickEvents(events: JEvent[], max = 110): JEvent[] {
  if (events.length <= max) return events.slice().sort((a, b) => a.t - b.t);
  const sorted = events.slice().sort((a, b) => a.t - b.t);
  const buckets = Math.ceil(max / 3);
  const t0 = sorted[0].t, span = Math.max(1, sorted.at(-1)!.t - t0);
  const by: JEvent[][] = Array.from({ length: buckets }, () => []);
  for (const e of sorted) by[Math.min(buckets - 1, Math.floor(((e.t - t0) / span) * buckets))].push(e);
  const keep = new Set<JEvent>();
  for (const b of by) b.slice().sort((a, x) => x.weight - a.weight).slice(0, 1).forEach((e) => keep.add(e));
  for (const e of sorted.slice().sort((a, b) => b.weight - a.weight)) { if (keep.size >= max) break; keep.add(e); }
  return sorted.filter((e) => keep.has(e));
}
const KIND_WORD: Record<string, string> = { commits: "commits", merge: "merge", session: "session", wiki: "wiki", log: "log", tag: "tag", release: "release", deploy: "deploy", idea: "plan", lead: "leads", manual: "you" };
export function digest(inp: DigestInput): string {
  const ev = pickEvents(inp.events).map((e) => `${e.id} ${d10(e.t)} ${KIND_WORD[e.kind] ?? e.kind}${e.n && e.kind === "commits" ? `(${e.n})` : ""}: ${clip(e.title, 90)}${e.kind === "commits" && e.items?.length ? ` | ${e.items.filter((x) => x !== e.title).slice(0, 3).map((x) => clip(x, 60)).join("; ")}` : ""}`);
  const qs = inp.quests.slice(0, 24).map((q) => `${q.id} ${d10(q.from)}→${d10(q.to)} ${q.status} "${clip(q.label, 40)}" ${q.commits}c/${q.sessions}s: ${q.subjects.slice(0, 3).map((x) => clip(x, 60)).join("; ")}`);
  const ms = inp.metrics.map((m) => `${m.key}=${Math.round(m.value * 10) / 10}`).join(", ");
  return [
    `PROJECT: ${inp.project}`,
    inp.tldr ? `PITCH (wiki): ${clip(inp.tldr, 300)}` : "",
    `STATUS: ${inp.status ?? "unknown"} · TAGS: ${inp.tags.slice(0, 12).join(", ") || "none"} · GUESSED KIND: ${inp.nature}`,
    inp.origin ? `ORIGINAL IDEA (first prompt or first note): ${clip(inp.origin, 300)}` : "",
    inp.early?.filter((x) => x.length > 20).length ? `EARLIEST PROMPTS: ${inp.early.filter((x) => x.length > 20).map((x) => `“${clip(x, 140)}”`).join(" / ")}` : "",
    inp.next?.length ? `WIKI "NEXT": ${inp.next.slice(0, 4).map((x) => clip(x, 120)).join(" / ")}` : "",
    `MEASURED NOW: ${ms || "nothing"}`,
    `EVENTS (id date kind: title):`, ...ev,
    qs.length ? `SIDE QUESTS (id dates status "name" commits/sessions: sample commits):` : "", ...qs,
  ].filter(Boolean).join("\n");
}

export const SYSTEM = "You chart the journey of one software project from a compact log of local evidence. You reply with exactly one JSON object and nothing else: no prose, no code fences.";
export function prompt(dig: string, nature: Nature): string {
  const ex = templateLadder(nature).slice(0, 4).map((m) => ({ id: m.id, title: m.title, metric: m.metric, unit: m.unit, target: m.target, source: m.source }));
  return `${dig}

Return JSON with these keys:
{"nature": one of "consumer-app"|"tool"|"creative"|"internal"|"content",
 "pitch": one line (max 110 chars) saying what it is and for whom,
 "idea": the original idea in one sentence (max 160 chars), from the ORIGINAL IDEA, the pitch and the earliest events,
 "story": one paragraph (3-5 sentences, max 700 chars) on how it got here, grounded ONLY in the events above,
 "turns": 3-7 moments the project changed direction: [{"event": an EVENT id from the list, "label": 2-6 words like "pivot to Android PWA" or "added payments", "why": max 120 chars}],
 "sidequests": names for the side quests above and sessions that went off the main line: [{"id": a SIDE QUEST id, "label": 2-5 words}] plus optionally [{"sessions": [session EVENT ids], "label": 2-5 words}] for off-topic session clusters,
 "ladder": 8-12 milestones from first steps to ambitious, ordered, fitting THIS kind of project: [{"id": kebab-case, "title": short, "metric": human label, "unit": short unit, "target": number, "source": one of ${Object.keys(SOURCES).join(", ")} or "manual.<snake_name>" for things only the owner can measure (users, mrr, dau, paying_customers, views, downloads_month, avg_session_min, invocations_day, screenings ...), "why": max 90 chars}],
 "heading": {"direction": the most likely next direction in one sentence (max 160 chars), "next": ids of the next 3 ladder milestones to go for}}
Rules: use only event ids and side quest ids that appear above. A milestone's title must say exactly what its source and target measure ("100 commits", "First GitHub release", "10 paying customers"): never name a feature, launch or event after a measured source that doesn't count it; a qualitative achievement ("Hebrew support", "public launch") uses a manual.<name> source with target 1. Most of the ladder should be AHEAD of where the project is now. Consumer apps get user and revenue milestones (first user, 10/100/1k users, first paying customer, $100/$1k/$10k MRR, daily actives, usage time, invocations per day); tools get releases, outside stars/issues, downloads; creative work gets cuts, screenings, views; internal tools get daily use and "replaced X". Prefer measurable sources over manual ones when they fit. Example ladder items: ${JSON.stringify(ex)}`;
}

// ── parsing and repair ─────────────────────────────────────────────────────────────
/** Closes whatever a truncated reply left open (strings, arrays, objects), so the complete part still parses. */
export function closeJson(t: string): string {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (const c of t) {
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if ((c === "}" || c === "]") && stack.length) stack.pop();
  }
  let out = t;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "").replace(/,\s*"[^"]*"\s*:?\s*$/, "").replace(/:\s*$/, ": null");
  return out + stack.reverse().join("");
}
const loose = (t: string) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1");
export function parseJsonLoose(text: string): any {
  const t = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("{");
  if (a < 0) return undefined;
  const b = t.lastIndexOf("}");
  for (const cand of [b > a ? t.slice(a, b + 1) : "", t.slice(a)]) {
    if (!cand) continue;
    for (const f of [(x: string) => x, loose, (x: string) => closeJson(loose(x))]) { try { const j = JSON.parse(f(cand)); if (j && typeof j === "object") return j; } catch {} }
  }
  return undefined;
}

export type AiResult = {
  nature: Nature; pitch: string; story: string; idea?: string;
  turns: { event: string; label: string; why?: string }[];
  questLabels: Record<string, string>;
  sessionQuests: { label: string; sessions: string[] }[];
  ladder: LadderItem[];
  heading: { direction: string; next: string[] };
  source: "claude" | "ollama" | "rules"; model?: string; at: number; ms?: number; note?: string;
};
const num = (v: unknown) => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, "").replace(/k$/i, "000")); return Number.isFinite(n) ? n : NaN; };

/** Keeps only what checks out: known event and quest ids, real sources, positive targets, unique milestone ids. */
export function normalizeAi(raw: any, ctx: { events: Set<string>; quests: Set<string>; nature: Nature }, source: AiResult["source"] = "claude"): AiResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const nature: Nature = ["consumer-app", "tool", "creative", "internal", "content"].includes(raw.nature) ? raw.nature : ctx.nature;
  const turns = (Array.isArray(raw.turns) ? raw.turns : []).filter((x: any) => x && ctx.events.has(String(x.event)) && x.label)
    .map((x: any) => ({ event: String(x.event), label: clip(x.label, 48), why: x.why ? clip(x.why, 140) : undefined }))
    .filter((x: any, i: number, a: any[]) => a.findIndex((y) => y.event === x.event) === i).slice(0, 8);
  const questLabels: Record<string, string> = {};
  const sessionQuests: AiResult["sessionQuests"] = [];
  for (const q of Array.isArray(raw.sidequests) ? raw.sidequests : []) {
    if (!q?.label) continue;
    if (q.id && ctx.quests.has(String(q.id))) questLabels[String(q.id)] = clip(q.label, 40);
    else if (Array.isArray(q.sessions)) { const ss = q.sessions.map(String).filter((s: string) => ctx.events.has(s) && s.startsWith("s")); if (ss.length) sessionQuests.push({ label: clip(q.label, 40), sessions: ss.slice(0, 30) }); }
  }
  const seen = new Set<string>();
  const ladder: LadderItem[] = [];
  for (const m of Array.isArray(raw.ladder) ? raw.ladder : []) {
    if (!m?.title) continue;
    let src = String(m.source ?? "").trim().toLowerCase();
    if (!isSource(src)) src = `manual.${slug(m.metric || m.title, 30).replace(/-/g, "_")}`.replace(/^manual\.(\d)/, "manual.m$1");
    if (!isSource(src)) continue;
    const target = num(m.target);
    if (!(target > 0)) continue;
    let id = slug(m.id || m.title);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    ladder.push({ id, title: clip(m.title, 48), metric: clip(m.metric || SOURCES[src] || src.slice(7).replace(/_/g, " "), 40), unit: clip(m.unit ?? "", 16), target, source: src, why: m.why ? clip(m.why, 110) : undefined, tier: ladder.length });
  }
  const pitch = clip(raw.pitch, 140), story = clip(raw.story, 900);
  if (!ladder.length && !turns.length && !story) return undefined;
  const next = (Array.isArray(raw.heading?.next) ? raw.heading.next : []).map((x: unknown) => slug(String(x))).filter((x: string) => seen.has(x)).slice(0, 3);
  return { nature, pitch, story, idea: raw.idea ? clip(raw.idea, 200) : undefined, turns, questLabels, sessionQuests, ladder: ladder.length >= 3 ? guardLadder(ladder) : templateLadder(nature), heading: { direction: clip(raw.heading?.direction, 200), next }, source, at: Date.now() };
}

/** The no-model read: turns from the wiki's dated sections, revivals after long pauses and big merges. */
export function ruleBased(inp: DigestInput): AiResult {
  const ev = inp.events.slice().sort((a, b) => a.t - b.t);
  const cands: { e: JEvent; label: string; score: number }[] = [];
  for (const e of ev) if (e.kind === "wiki") cands.push({ e, label: clip(e.title, 44), score: 5 + e.weight });
  for (const e of ev) if ((e.kind === "merge" || e.kind === "release" || e.kind === "tag" || e.kind === "deploy") && e.weight >= 4) cands.push({ e, label: clip(e.title, 44), score: e.weight + 2 });
  for (let i = 1; i < ev.length; i++) if (ev[i].t - ev[i - 1].t > 21 * 86_400_000) cands.push({ e: ev[i], label: "picked back up", score: 6 });
  const turns = cands.sort((a, b) => b.score - a.score).filter((c, i, a) => a.findIndex((x) => x.e.id === c.e.id) === i).slice(0, 6).sort((a, b) => a.e.t - b.e.t).map((c) => ({ event: c.e.id, label: c.label }));
  const ladder = templateLadder(inp.nature);
  const first = ev[0], last = ev.at(-1);
  const days = first && last ? Math.max(1, Math.round((last.t - first.t) / 86_400_000)) : 0;
  const commits = inp.metrics.find((m) => m.key === "git.commits")?.value ?? 0, sessions = inp.metrics.find((m) => m.key === "sessions.count")?.value ?? 0;
  const story = first ? `${inp.project} started ${d10(first.t)}${inp.origin ? ` with “${clip(inp.origin, 120)}”` : ""}. Over ${days} day${days === 1 ? "" : "s"} it gathered ${commits} commit${commits === 1 ? "" : "s"} and ${sessions} agent session${sessions === 1 ? "" : "s"}${turns.length ? `, turning at ${turns.slice(0, 3).map((t) => `“${t.label}”`).join(", ")}` : ""}. The latest step was “${clip(last!.title, 90)}” (${d10(last!.t)}).` : "";
  return { nature: inp.nature, pitch: clip(inp.tldr ?? "", 140), story, turns, questLabels: {}, sessionQuests: [], ladder, heading: { direction: inp.next?.[0] ? clip(inp.next[0], 200) : "", next: [] }, source: "rules", at: Date.now() };
}

// ── engines ───────────────────────────────────────────────────────────────────────
const BIN_DIRS = [`${HOME}/.local/bin`, `${HOME}/.claude/local`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH ?? "").split(":")];
const CLAUDE = process.env.DECK_CLAUDE_BIN || BIN_DIRS.map((d) => `${d}/claude`).find((p) => existsSync(p));
export const claudeAvailable = () => !!CLAUDE;
export type Runner = (system: string, user: string, timeoutMs: number) => Promise<{ text: string; model: string }>;

/** Headless Claude Code: print mode, a small fast model, low effort, no tools/MCP/settings/plugins, nothing saved. */
export const runClaude: Runner = async (system, user, timeoutMs) => {
  if (!CLAUDE) throw new Error("Claude Code (claude) isn't installed here");
  const model = process.env.DECK_JOURNEY_MODEL || "haiku";
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", MAX_THINKING_TOKENS: "0", NO_COLOR: "1" };
  delete env.CLAUDECODE;
  const p = Bun.spawn([CLAUDE, "-p", "--safe-mode", "--model", model, "--effort", "low", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "",
    "--output-format", "json", "--system-prompt", system], { cwd: tmpdir(), stdin: new Blob([user]), stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => { try { p.kill(9); } catch {} }, timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
    await p.exited;
    if (p.signalCode) throw new Error("Claude took too long");
    let j: any; try { j = JSON.parse(out); } catch { throw new Error(clip(err.split("\n").filter(Boolean).pop() || "Claude returned nothing readable", 160)); }
    if (j.is_error) throw new Error(clip(j.result || "Claude reported an error", 160));
    return { text: String(j.result ?? ""), model };
  } finally { clearTimeout(timer); }
};
const OLLAMA_URL = process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "http://127.0.0.1:11434";
/** A local Ollama model (DECK_JOURNEY_ENGINE=ollama): nothing leaves the machine. */
export const runOllama: Runner = async (system, user, timeoutMs) => {
  const model = process.env.DECK_JOURNEY_OLLAMA_MODEL || process.env.DECK_BRIEF_MODEL || "gemma4:e4b";
  const r = await fetch(`${OLLAMA_URL}/api/chat`, { method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, format: "json", keep_alive: "10m", options: { temperature: 0.4, num_predict: 3500 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  if (!r.ok) throw new Error(`Ollama said ${r.status}`);
  const j: any = await r.json();
  return { text: String(j.message?.content ?? ""), model };
};

/** One AI pass for a project: the model's read when it is usable, otherwise the rule-based one (with a note). */
export async function analyze(inp: DigestInput, opts: { runner?: Runner; engine?: "claude" | "ollama"; timeoutMs?: number; onCall?: () => void } = {}): Promise<AiResult> {
  const engine = opts.engine ?? (process.env.DECK_JOURNEY_ENGINE === "ollama" ? "ollama" : "claude");
  const runner = opts.runner ?? (engine === "ollama" ? runOllama : CLAUDE ? runClaude : undefined);
  const fallback = ruleBased(inp);
  if (!runner) return { ...fallback, note: "No model is available here, so this read comes from simple rules." };
  const t0 = Date.now();
  const ctx = { events: new Set(inp.events.map((e) => e.id)), quests: new Set(inp.quests.map((q) => q.id)), nature: inp.nature };
  try {
    opts.onCall?.();
    const r = await runner(SYSTEM, prompt(digest(inp), inp.nature), opts.timeoutMs ?? 150_000);
    const got = normalizeAi(parseJsonLoose(r.text), ctx, engine);
    if (!got) return { ...fallback, note: "The model's answer couldn't be used, so this read comes from simple rules.", ms: Date.now() - t0 };
    // Fill what the model skipped from the rules, so every part of the page has something grounded.
    return { ...got, turns: got.turns.length ? got.turns : fallback.turns, story: got.story || fallback.story, pitch: got.pitch || fallback.pitch, heading: { direction: got.heading.direction || fallback.heading.direction, next: got.heading.next }, model: r.model, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ...fallback, note: `${clip(e?.message ?? "The model failed", 120)}. This read comes from simple rules.`, ms: Date.now() - t0 };
  }
}
export const aiSig = (inp: DigestInput) => hash(digest(inp));
