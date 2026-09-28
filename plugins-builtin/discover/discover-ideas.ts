// Discover's pure parts: GitHub results ranked into gems and trending repos, an idea's keywords and building-block
// roles, the plans in the ideas folder, the prompts its buttons send, and "what if" sparks from the profile.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { frontmatter, hasTerm, slugify } from "../../src/text";
import { escRe, ls, readText, STACK, type DiscoverConf, type Gem, type Interest, type Profile, type Repo, type Why } from "./discover-profile";

const HOME = homedir();
const DAY = 86_400_000;

// ── GitHub results → gems ─────────────────────────────────────────────────────────
export function toRepo(x: any): Repo {
  return {
    full: x.full_name, url: x.html_url, desc: String(x.description ?? "").slice(0, 300), stars: x.stargazers_count ?? 0, lang: x.language ?? undefined,
    pushed: x.pushed_at, created: x.created_at, license: x.license?.spdx_id && x.license.spdx_id !== "NOASSERTION" ? x.license.spdx_id : x.license ? "Other" : undefined,
    topics: (x.topics ?? []).slice(0, 12), owner: x.owner?.login ?? String(x.full_name).split("/")[0], name: x.name ?? String(x.full_name).split("/")[1],
    ...(x.archived ? { archived: true } : {}), ...(x.fork ? { fork: true } : {}),
  } as Repo;
}
/** How strongly a repo is about an interest: word-prefix hits in its name, description and topics. */
export function relevance(r: Repo, it: Pick<Interest, "terms" | "tags">) {
  const text = `${r.name} ${r.desc} ${r.topics.join(" ")}`.toLowerCase().replace(/[-_]/g, " ");
  const raw = `${r.name} ${r.topics.join(" ")}`.toLowerCase();
  let rel = 0;
  for (const t of it.terms) if (hasTerm(text, t.replace(/[-_]/g, " ")) || hasTerm(raw, t)) rel += t.length > 4 ? 1 : 0.7;
  if (r.topics.some((t) => it.tags?.includes(t))) rel += 1.5;
  if (it.terms.some((t) => hasTerm(r.name.toLowerCase().replace(/[-_]/g, " "), t.replace(/[-_]/g, " ")))) rel += 0.5;
  return rel;
}
export type RankCtx = { now: number; dismissed: Set<string>; exclude: Set<string>; names?: Set<string>; own?: string; languages: Set<string>; min?: number; max?: number; days?: number };
/** Is this a gem at all: moderately starred, alive, licensed, not archived, a fork, yours or dismissed. */
export function isGem(r: Repo & { archived?: boolean; fork?: boolean }, ctx: RankCtx) {
  const pushedAgo = (ctx.now - Date.parse(r.pushed)) / DAY;
  return r.stars >= (ctx.min ?? 30) && r.stars <= (ctx.max ?? 5000) && pushedAgo <= (ctx.days ?? 183) && !!r.license && !r.archived && !r.fork
    && !ctx.dismissed.has(r.full.toLowerCase()) && !ctx.exclude.has(r.full.toLowerCase()) && !ctx.names?.has(r.name.toLowerCase()) && (!ctx.own || r.owner.toLowerCase() !== ctx.own.toLowerCase());
}
/** Stars per month of life: cheap momentum without a stars-history API. */
export const starsPerMonth = (r: Repo, now: number) => r.stars / Math.max(1, (now - Date.parse(r.created)) / (30 * DAY));
/** Lists, guides and tutorials are good reading but nothing to fork and build on. */
const LISTY = /(^|[-_.])(awesome|tutorials?|cheat-?sheets?|guides?|bible|roadmaps?|resources|interviews?|examples|course)([-_.]|$)/i;
export function gemScore(r: Repo, rel: number, weight: number, ctx: RankCtx) {
  const spm = starsPerMonth(r, ctx.now);
  const pushedAgo = (ctx.now - Date.parse(r.pushed)) / DAY;
  // Momentum matters, but a niche repo squarely in your main interest should beat a hot one on the side.
  const momentum = 0.7 + 0.5 * Math.log10(1 + spm);
  const fresh = pushedAgo < 14 ? 1.15 : pushedAgo < 60 ? 1 : 0.85;
  const sweet = r.stars < 60 ? 0.85 : r.stars > 3000 ? 0.9 : 1;
  const lang = r.lang && ctx.languages.has(r.lang) ? 1.1 : 1;
  const listy = LISTY.test(r.name) || /\b(awesome list|curated list|a list of)\b/i.test(r.desc) ? 0.45 : 1;
  const relF = 0.5 + Math.min(rel, 4) / 4;
  return relF * momentum * fresh * sweet * lang * listy * (0.35 + 0.65 * weight);
}
/**
 * Filter and rank per-interest search results into one list: dedupe (a repo found for several interests
 * lists them all in "why"), drop near-duplicate mirrors, and keep any one interest from taking over the list.
 */
export function rankGems(byInterest: Record<string, Repo[]>, interests: Interest[], ctx: RankCtx, limit = 48): Gem[] {
  const top = Math.max(1, ...interests.map((i) => (i.source === "you" ? 0 : i.score)));
  const found = new Map<string, Gem & { best: number; primary: string }>();
  for (const it of interests) {
    const w = it.source === "you" ? 1 : Math.min(1, it.score / top);
    for (const r of byInterest[it.id] ?? []) {
      if (!isGem(r, ctx)) continue;
      const rel = relevance(r, it);
      if (rel <= 0) continue;
      const s = gemScore(r, rel, w, ctx);
      const k = r.full.toLowerCase();
      const why: Why = { id: it.id, label: it.label, projects: it.projects.slice(0, 3) };
      const g = found.get(k);
      if (!g) found.set(k, { ...r, score: s, spm: Math.round(starsPerMonth(r, ctx.now) * 10) / 10, why: [why], best: s, primary: it.id });
      else if (!g.why.some((x) => x.id === it.id)) {
        g.why.push(why);
        if (s > g.best) { g.best = s; g.primary = it.id; g.why.unshift(g.why.pop()!); }
        g.score = g.best * (1 + 0.15 * (g.why.length - 1));
      }
    }
  }
  // Mirrors and platform twins: the same name and description under different owners, or one owner's
  // "x-mac" / "x-windows" pair → keep the most starred.
  const kept: (Gem & { best: number; primary: string })[] = [];
  for (const g of [...found.values()].sort((a, b) => b.stars - a.stars)) {
    const twin = kept.some((o) => (o.name.toLowerCase() === g.name.toLowerCase() && o.desc.slice(0, 60).toLowerCase() === g.desc.slice(0, 60).toLowerCase())
      || (o.owner === g.owner && commonPrefix(o.name.toLowerCase(), g.name.toLowerCase()) >= Math.min(20, Math.min(o.name.length, g.name.length) - 1)));
    if (!twin) kept.push(g);
  }
  const sorted = kept.sort((a, b) => b.score - a.score);
  const per = new Map<string, number>();
  for (const g of sorted) { const n = per.get(g.primary) ?? 0; per.set(g.primary, n + 1); g.score *= 0.85 ** n; }
  sorted.sort((a, b) => b.score - a.score);
  // Every interest you have gets its best two in, even when another area is louder.
  const pick = new Set<typeof sorted[number]>();
  for (const it of interests) for (const g of sorted.filter((x) => x.primary === it.id).slice(0, 2)) pick.add(g);
  for (const g of sorted) { if (pick.size >= Math.max(limit, 0)) break; pick.add(g); }
  return [...pick].sort((a, b) => b.score - a.score).slice(0, Math.max(limit, interests.length * 2)).map(({ best, primary, ...g }) => ({ ...g, score: Math.round(g.score * 1000) / 1000 }));
}
const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
/** New repos climbing fast in your areas: created recently, ranked by stars per day. */
export function rankTrending(byInterest: Record<string, Repo[]>, interests: Interest[], ctx: RankCtx, limit = 14): Gem[] {
  const out = new Map<string, Gem>();
  for (const it of interests) for (const r of byInterest[it.id] ?? []) {
    if (!isGem(r, { ...ctx, min: 15, max: 20_000, days: 60 })) continue;
    const rel = relevance(r, it);
    if (rel <= 0) continue;
    const perDay = r.stars / Math.max(7, (ctx.now - Date.parse(r.created)) / DAY);
    const k = r.full.toLowerCase();
    const why: Why = { id: it.id, label: it.label, projects: it.projects.slice(0, 3) };
    const g = out.get(k);
    if (g) { if (!g.why.some((x) => x.id === it.id)) g.why.push(why); continue; }
    out.set(k, { ...r, score: Math.round(perDay * 100) / 100, spm: Math.round(starsPerMonth(r, ctx.now) * 10) / 10, why: [why] });
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── ideas: keywords, roles, files ───────────────────────────────────────────────────
const PHRASES = ["human design", "text to speech", "speech to text", "machine learning", "computer vision", "knowledge graph", "vector database", "real time", "augmented reality", "virtual reality", "large language model", "prediction market", "home assistant", "gaussian splatting", "3d printing", "smart contract", "social network", "voice assistant", "voice agent", "music generation", "image generation", "video generation", "satellite imagery", "point cloud", "face recognition", "object detection", "web scraping", "browser extension", "chrome extension", "mobile app", "time series", "natural language", "multi agent", "i ching", "birth chart", "natal chart", "digital twin", "game engine", "generative art", "open data", "street view", "language model", "smart glasses", "brain computer interface", "event sourcing", "local first", "self hosted", "end to end", "peer to peer", "drone footage", "air quality", "weather data", "stock market", "sign language", "lip sync", "motion capture", "pose estimation", "semantic search", "screen reader"];
const SYN: Record<string, string> = { tts: "text to speech", stt: "speech to text", ar: "augmented reality", vr: "virtual reality", ml: "machine learning", llms: "llm", p2p: "peer to peer", "e2e": "end to end", "iching": "i ching", "polymarket": "prediction market" };
const SHORT_OK = new Set(["ai", "3d", "llm", "gps", "iot", "api", "mcp", "rag", "nft", "gpt", "ocr", "vr", "ar", "ml", "sql", "p2p", "cli", "sdk", "osm", "tts", "stt", "hd"]);
const TECH = new Set("llm rag mcp api sdk ocr gps iot osm 3d webgl webgpu threejs whisper ollama telegram whatsapp discord slack spotify youtube tiktok instagram twitter reddit github notion obsidian calendar gmail email sms voice speech audio music video camera webcam drone satellite map maps geospatial lidar sensor bluetooth arduino raspberry wearable watch glasses browser extension scraper crawler embeddings vector database postgres sqlite graph blockchain crypto ethereum solana wallet payments stripe shopify ffmpeg transcription translation subtitles chatbot agent agents bot bots dashboard game multiplayer vr ar simulation physics astrology ephemeris tarot chart bodygraph osint forecasting markets trading stocks weather climate health fitness sleep nutrition medical dna genome robot robotics home automation smart plugin compiler interpreter terminal pwa ios android".split(" "));
const STOP = new Set(("a an the and or but nor for to of in on at by with without from into onto over under about above below after before between through during is are was were be been being am it its it's this that these those there here what which who whom whose when where why how i me my mine we us our ours you your yours he she they them their theirs one two three first also just only even ever never always really very super so too then than as if else can could would should will shall may might must do does did done doing have has had having get gets got make makes made making build builds building built create creates creating want wants wanted need needs like likes let lets allow allows allowing help helps use uses using used based via per etc app apps application applications platform platforms tool tools system systems thing things stuff way ways people person user users everyone anyone someone somebody everybody world new better best good great cool amazing awesome huge massive giant tiny little big small idea ideas something anything everything nothing automatically automatic instantly instant simply easy easily fully full whole entire every each all any some many much more most less least lot lots kind sort type types able possible basically literally actually imagine imagining ambitious optimistic crazy wild dream dreams day days time times year years week today tomorrow now then soon later know see show shows give gives turn turns take takes put keep keeps go goes going come comes find finds found look looks feel feels think thinks tell tells say says ask asks work works working not no yes out up down off again still own same other another such while whilst until because since though although whether either neither both around across along among within upon onto toward towards entirely own completely machine machines favourite favorite favourites favorites stuff").split(" "));
/** Words that describe rather than name a thing: searched last. */
const WEAK = new Set("live daily explore overhead personal custom simple smart online global instant nightly weekly morning evening cloned powered driven based fast quick".split(" "));
const singular = (w: string) => (w.length >= 4 && /[^s]s$/.test(w) && !/(ss|us|is|ous|news|ics|ios|as|ies)$/.test(w) ? w.slice(0, -1) : w);

/** The words of an idea worth searching for: known phrases first, then tech words, then other content words. */
export function extractKeywords(text: string, max = 6): string[] {
  let t = ` ${String(text).toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+#.\s-]/g, " ").replace(/\s+/g, " ")} `;
  const out = new Map<string, number>();
  const add = (k: string, s: number) => out.set(k, (out.get(k) ?? 0) + s);
  for (const p of PHRASES) {
    const re = new RegExp(`\\b${escRe(p).replace(/ /g, "[\\s-]")}\\b`, "g");
    if (re.test(t)) { add(p, 3); t = t.replace(re, " "); }
  }
  const words = t.split(/[\s]+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter(Boolean);
  for (let w of words) {
    if (SYN[w]) { add(SYN[w], 3); continue; }
    if (STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length < 4 && !SHORT_OK.has(w) && !TECH.has(w)) continue;
    w = singular(w);
    if (STOP.has(w)) continue;
    add(w, TECH.has(w) ? 2 : WEAK.has(w) ? 0.5 : w.length >= 7 ? 1.5 : 1);
  }
  const order = [...out.keys()];
  return [...out].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0])).slice(0, max).map(([k]) => k);
}
export const ROLES: [string, RegExp][] = [
  ["AI & models", /\b(llm|gpt|model|agent|agents|rag|embedding|transformer|inference|machine learning|neural|diffusion|langchain|ollama|openai|anthropic|claude|prompt)/],
  ["Media: audio, video, images", /\b(video|audio|speech|tts|voice|music|ffmpeg|image|camera|whisper|podcast|subtitle|photo|render)/],
  ["Data & ingestion", /\b(scrap|crawl|etl|pipeline|dataset|ingest|feed|parser|extract|collector|api client|wrapper|sdk)/],
  ["Maps & places", /\b(geo|map|maps|gis|location|osm|openstreetmap|satellite|gps|spatial)/],
  ["Interface & visualization", /\b(ui|dashboard|visuali|chart|3d|three|webgl|canvas|frontend|react|svelte|game|editor|component|design)/],
  ["Integrations & bots", /\b(bot|telegram|discord|slack|whatsapp|webhook|integration|mcp|plugin|extension|notion|calendar|email)/],
  ["Backend & infrastructure", /\b(server|backend|database|queue|deploy|docker|kubernetes|serverless|auth|storage|sync|self hosted|postgres|sqlite|framework)/],
];
export function roleOf(r: Repo) {
  const text = `${r.name} ${r.desc} ${r.topics.join(" ")}`.toLowerCase().replace(/[-_]/g, " ");
  let best = "Building blocks", n = 0;
  for (const [role, re] of ROLES) { const hits = (text.match(new RegExp(re.source, "g")) ?? []).length; if (hits > n) { n = hits; best = role; } }
  return best;
}
/** Rank idea-search hits: every keyword a repo mentions counts, popular and alive helps, archived is out. */
export function rankIdeaRepos(items: (Repo & { archived?: boolean })[], keywords: string[], now: number, limit = 24, strict = keywords.length >= 3): (Repo & { score: number; role: string; hits: string[] })[] {
  const seen = new Set<string>();
  const out: (Repo & { score: number; role: string; hits: string[] })[] = [];
  for (const r of items) {
    const k = r.full.toLowerCase();
    if (seen.has(k) || r.archived) continue;
    seen.add(k);
    const text = `${r.name} ${r.desc} ${r.topics.join(" ")}`.toLowerCase().replace(/[-_]/g, " ");
    const hits = keywords.filter((kw) => hasTerm(text, kw));
    if (!hits.length) continue;
    const pushedAgo = (now - Date.parse(r.pushed)) / DAY;
    // Earlier keywords are the stronger ones (phrases and tech words sort first).
    const weight = hits.reduce((a, kw) => a + Math.max(0.4, 1 - keywords.indexOf(kw) * 0.12), 0);
    if (strict && hits.length < 2) continue; // one generic word in common isn't a building block
    const score = weight ** 1.5 * Math.log10(r.stars + 10) * (pushedAgo < 90 ? 1.1 : pushedAgo < 365 ? 1 : pushedAgo < 730 ? 0.7 : 0.45) * (r.stars < 5 ? 0.35 : 1);
    out.push({ ...r, score: Math.round(score * 100) / 100, role: roleOf(r), hits });
  }
  if (strict && out.length < 6) return rankIdeaRepos(items, keywords, now, limit, false);
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
export function groupByRole<T extends { role: string }>(items: T[]) {
  const g = new Map<string, T[]>();
  for (const r of items) g.set(r.role, [...(g.get(r.role) ?? []), r]);
  const order = [...ROLES.map(([r]) => r), "Building blocks"];
  return [...g].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([role, repos]) => ({ role, repos }));
}

export type IdeaFile = { slug: string; title: string; idea: string; status: string; created?: string; mtime: number; size: number; summary: string; pending?: boolean; session?: { key: string; title: string; status: string } };
export type RowLite = { key: string; title: string; status: string; firstPrompt?: string };
/** Plans agents wrote to the ideas folder, plus ideas sent for research that have no plan yet. */
export function listIdeas(dir: string, rows: RowLite[] = [], pending: DiscoverConf["ideas"] = []): IdeaFile[] {
  const out: IdeaFile[] = [];
  const sessionFor = (slug: string) => { const r = rows.find((x) => x.firstPrompt?.includes(`ideas/${slug}.md`)); return r ? { key: r.key, title: r.title, status: r.status } : undefined; };
  for (const f of ls(dir).filter((f) => f.endsWith(".md"))) {
    const p = `${dir}/${f}`;
    let st; try { st = statSync(p); } catch { continue; }
    const text = readText(p).slice(0, 200_000);
    const { data, body } = frontmatter(text);
    const slug = f.slice(0, -3);
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? String(data.idea ?? slug);
    const para = body.replace(/^#.*$/gm, "").split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !/^(\||```|---|- |\* |\d+\. )/.test(x)) ?? "";
    out.push({ slug, title: title.slice(0, 120), idea: String(data.idea ?? "").slice(0, 400), status: String(data.status ?? "plan"), created: data.created, mtime: st.mtimeMs, size: st.size, summary: para.replace(/[*_`]/g, "").slice(0, 280), session: sessionFor(slug) });
  }
  for (const p of pending) {
    if (out.some((x) => x.slug === p.slug)) continue;
    if (Date.now() - p.at > 14 * DAY) continue;
    out.push({ slug: p.slug, title: p.text.slice(0, 120), idea: p.text, status: "researching", mtime: p.at, size: 0, summary: "", pending: true, session: sessionFor(p.slug) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ── prompts: what "Fork & explore", "Research & plan it" and "Start building" send ─────────────
export type PromptCtx = { ideasDir: string; connectionsFile: string; projectsDir: string };
const tilde = (p: string) => p.replace(HOME, "~");
export function forkPrompt(g: Repo & { why?: Why[] }, ctx: PromptCtx) {
  const projs = [...new Set((g.why ?? []).flatMap((w) => w.projects))].slice(0, 3);
  const areas = (g.why ?? []).map((w) => w.label).join(", ");
  const dest = `${tilde(ctx.projectsDir)}/${g.name}`;
  return [
    `Explore ${g.full} (${g.url}) as something to build on.`,
    `Why herdr deck suggested it: it fits my interest in ${areas || "this area"}${projs.length ? ` and my projects ${projs.join(", ")}` : ""}. Its description: "${g.desc}" (${g.stars} stars, ${g.lang ?? "unknown language"}, license ${g.license ?? "unknown"}, last push ${g.pushed.slice(0, 10)}).`,
    "",
    `1. Clone it, don't fork it on GitHub (ask me first): \`gh repo clone ${g.full} ${dest}\` (if that folder exists, use ${dest}-gh).`,
    "2. Read its README, structure, how it runs, tests, open issues and recent commits. Run it locally if that's quick and safe.",
    `3. Evaluate how I could build on it${projs.length ? ` for ${projs.map((p) => `${p} (context: ~/wiki/projects/${p}.md)`).join(", ")}` : ""}: what it gives me, integration points, what I'd extend or replace, license implications, maintenance health and risks.`,
    "4. Suggest one small first experiment (under an hour) and wait for me before doing it. Don't push, publish or open issues/PRs.",
  ].join("\n");
}
/** Research agents are told about the Founder Library (plugins-builtin/library), which they reach through the deck's MCP tool. */
export const LIBRARY_STEP = "Also ask the Founder Library, if the herdr-deck MCP tool `deck_library` is available: how real founders priced, launched and got the first customers for something similar. Quote what fits in Costs and risks and Build order with its YouTube timestamp link, and treat their numbers as claims.";
export function researchPrompt(idea: string, slug: string, ctx: PromptCtx & { repos?: Repo[]; projects?: string[]; keywords?: string[] }) {
  const file = `${tilde(ctx.ideasDir)}/${slug}.md`;
  return [
    `Research and plan this idea, then write the plan to ${file} (create the folder if needed).`,
    "",
    `The idea: "${idea.trim()}"`,
    "",
    "This is research and planning only: don't build anything, and don't sign up for, buy or publish anything.",
    "",
    "1. Search the web and GitHub for what already exists: open-source repos, APIs, hosted services, datasets and papers that implement any part of this. Prefer maintained, permissively licensed projects, and note stars, last activity and license for every repo you cite. Use web search, `gh search repos` and `gh api`.",
    ctx.repos?.length ? `2. Starting points herdr deck found by keyword search${ctx.keywords?.length ? ` (${ctx.keywords.join(", ")})` : ""}. Verify them, don't trust them: ${ctx.repos.slice(0, 10).map((r) => `${r.full} (${r.stars}★)`).join(", ")}.` : "2. Search broadly; nothing was pre-selected.",
    `3. Check which of my existing connections can be used: read ${tilde(ctx.connectionsFile)} (services, CLIs, MCP servers, API key names; never print key values). Say exactly which ones the idea uses and what's missing.`,
    ctx.projects?.length ? `4. My related projects (context in ~/wiki/projects/<name>.md): ${ctx.projects.join(", ")}. Reuse what I already have.` : "4. Check ~/wiki/index.md for my own projects that could be reused.",
    "5. Think beyond the obvious: propose at least two novel ways to connect these pieces, or outside-world data sources, that would make this better than anything that exists.",
    LIBRARY_STEP,
    "6. Write the plan as Markdown with this front matter and these sections:",
    "---",
    `idea: <the idea in one line>`,
    "created: <today's date>",
    "status: plan",
    "---",
    "# <a short name for it>",
    "## In one paragraph",
    "## What already exists (table: name, link, what it gives us, license, stars, last activity)",
    "## Novel connections",
    "## Architecture (components and how data flows; a small ASCII diagram is welcome)",
    "## Components (for each: the exact repo, service or API to use, or what we write ourselves)",
    "## Using my connections",
    "## Build order (milestones, each one shippable)",
    "## Costs and risks (money, rate limits, licenses, legal and privacy, what could kill it)",
    "## First 3 tasks (concrete enough for an agent to start today)",
    "7. When the file is written, reply with its path and a five-line summary.",
  ].join("\n");
}
export function buildPrompt(slug: string, title: string, ctx: PromptCtx) {
  const dir = `${tilde(ctx.projectsDir)}/${slug}`;
  return [
    `Start building "${title}", planned in ${tilde(ctx.ideasDir)}/${slug}.md.`,
    "",
    "1. Read the whole plan first.",
    `2. Create the project folder ${dir} (git init) with a short README taken from the plan. If it already exists, continue there.`,
    '3. Do task 1 of "First 3 tasks": build it, run it or test it, and show me the result. Then stop and wait for me before task 2.',
    `4. Use my connections from ${tilde(ctx.connectionsFile)} where the plan says. Ask before anything paid, public or destructive.`,
  ].join("\n");
}

// ── sparks: "what if…" ideas generated from the profile, deterministically ───────────────────
export type Spark = { id: string; title: string; pitch: string; idea: string; uses: string[] };
const SUBJECT: Record<string, string> = {
  "human-design": "your Human Design chart", astro: "the daily sky of transits", esoteric: "a daily I Ching or tarot oracle", osint: "an OSINT feed about one place",
  forecasting: "a live prediction-market board", trading: "your trading journal", games: "a tiny browser game", geo: "what's happening around you", automation: "a small business's busywork",
  matching: "the compatibility between two people", education: "a skill you're learning", hebrew: "Hebrew-speaking audiences",
};
const DOES: Record<string, [string, string]> = { // [after "what if X …", after "X that …"]
  video: ["cut itself into short vertical videos every day", "cuts itself into short vertical videos every day"],
  speech: ["talked back in a natural voice you can call", "talks back in a natural voice you can call"],
  "3d": ["became a living 3D scene you can walk through", "becomes a living 3D scene you can walk through"],
  rag: ["remembered everything and answered with sources", "remembers everything and answers with sources"],
  agents: ["was run overnight by a small crew of agents", "is run overnight by a small crew of agents"],
  mcp: ["was an MCP server any agent could use", "is an MCP server any agent can use"],
  genmedia: ["generated its own images and soundtrack", "generates its own images and soundtrack"],
  scraping: ["was fed by scrapers watching the web for changes", "is fed by scrapers watching the web for changes"],
  evals: ["scored its own answers and got better every week", "scores its own answers and gets better every week"],
  "local-first": ["ran entirely on your own machines", "runs entirely on my own machines"],
  pwa: ["lived on your phone's home screen", "lives on my phone's home screen"],
  telegram: ["arrived as a Telegram conversation", "arrives as a Telegram conversation"],
  viz: ["turned into an explorable visual map", "turns into an explorable visual map"],
  "claude-code": ["was built and kept up by Claude Code sessions from the deck", "is built and kept up by Claude Code sessions from herdr deck"],
};
const CONN_DOES: [RegExp, string][] = [
  [/telegram/i, "delivered through your Telegram bot"], [/elevenlabs/i, "narrated with ElevenLabs voices"], [/gumroad/i, "sold as a product on Gumroad"],
  [/ollama/i, "private, on local Ollama models"], [/vercel/i, "shipped on Vercel"], [/netlify/i, "shipped on Netlify"], [/cloudflare/i, "running on Cloudflare Workers for pennies"],
  [/supabase/i, "with accounts and realtime sync on Supabase"], [/gmail/i, "arriving as a morning email"], [/google drive/i, "saved to Google Drive"],
  [/tailscale/i, "reachable from your phone over Tailscale"], [/^jev$/i, "with Jev judging what's worth your attention"], [/github/i, "published as an open-source repo"],
];
/** Which of your connections an idea could use, by what the idea talks about. */
export const CONN_FITS: [RegExp, RegExp][] = [
  [/telegram/i, /telegram|\bbots?\b|messag|\bchat/], [/elevenlabs/i, /voice|speech|tts|audio|narrat|podcast|\bcall/], [/ollama/i, /\bllm|private|local model|offline|on[- ]device/],
  [/gmail/i, /e-?mail|inbox|newsletter/], [/google calendar/i, /calendar|schedul|meeting|appointment/], [/google drive/i, /document|\bdocs?\b|drive|spreadsheet/],
  [/supabase|firebase/i, /account|login|auth|realtime|sync|users/], [/gumroad/i, /sell|shop|paid|subscri|monetiz|product/], [/vercel|netlify|cloudflare/i, /website|web app|landing|deploy|public page|dashboard/],
  [/tailscale/i, /phone|mobile|remote|anywhere/], [/hugging ?face/i, /model|dataset|fine-?tun|embedding/], [/yt-dlp|ffmpeg/i, /video|youtube|clip|audio|podcast/],
  [/blender/i, /\b3d\b|render|scene/], [/godot/i, /\bgames?\b/], [/^github$/i, /open source|repo|github/], [/^jev$/i, /decid|judg|rank|priorit/],
];
/** Outside-world feeds, and the interests whose projects they'd feed. */
const SOURCES: [string, string[]][] = [
  ["live prediction-market odds", ["forecasting", "trading", "osint"]], ["satellite and weather data", ["geo", "osint", "3d", "viz"]],
  ["public Telegram channels", ["osint", "telegram", "rag", "hebrew"]], ["GitHub trending", ["agents", "claude-code", "mcp", "evals"]],
  ["the YouTube channels you follow", ["video", "rag", "speech", "education"]], ["the day's planetary transits", ["human-design", "astro", "esoteric"]],
  ["local events and news", ["geo", "matching", "automation", "hebrew"]], ["earthquake and space-weather feeds", ["astro", "osint", "viz", "3d"]],
  ["new papers on arXiv", ["rag", "evals", "agents", "education"]], ["public company filings and tenders", ["automation", "osint", "trading"]],
];
/** A small seeded PRNG so the same day (and shuffle) gives the same sparks. */
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
export function sparks(p: Profile, gems: Gem[], seed: number, n = 6): Spark[] {
  const r = rng(seed * 2654435761 + 97);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  /** Stronger interests come up more often, weaker ones still get a turn. */
  const pickW = (xs: Interest[]) => { const w = xs.map((x) => Math.sqrt(Math.max(1, x.score))); let t = r() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { t -= w[i]; if (t <= 0) return xs[i]; } return xs[xs.length - 1]; };
  const short = (x: string, n = 140) => (x.length > n ? `${x.slice(0, n).replace(/\s+\S*$/, "")}…` : x);
  const domains = p.interests.filter((i) => i.kind === "domain");
  const techs = p.interests.filter((i) => i.kind === "tech" && DOES[i.id]);
  const conns = p.connections.map((c) => [c, CONN_DOES.find(([re]) => re.test(c))?.[1]] as const).filter((x): x is readonly [string, string] => !!x[1]);
  const active = p.projects.filter((x) => ["active", "launched"].includes(x.status) && !x.tags.includes("external"));
  const projOf = (it?: Interest) => it?.projects.find((x) => active.some((a) => a.name === x)) ?? it?.projects[0];
  const out: Spark[] = [];
  const push = (s: Omit<Spark, "id">) => { if (!out.some((x) => x.title === s.title)) out.push({ ...s, id: slugify(s.title, 40) }); };
  const subject = (d: Interest) => SUBJECT[d.id] ?? d.label.toLowerCase();
  const cap = (x: string) => x[0].toUpperCase() + x.slice(1);
  /** "Browser games" reads as "browser games" mid-sentence; "Human Design", "OSINT" and "Hebrew" keep their capitals. */
  const lower = (x: string) => (/^(Human|OSINT|MCP|Hebrew|Claude|PWA|LLM|RAG|3D)\b/.test(x) ? x : x[0].toLowerCase() + x.slice(1));
  const used = new Map<number, number>();
  for (let tries = 0; out.length < n && tries < 40; tries++) {
    const kind = tries < 6 ? tries : Math.floor(r() * 6);
    if ((used.get(kind) ?? 0) >= (kind === 5 || kind === 1 ? 1 : 2)) continue;
    const before = out.length;
    if ((kind === 0 || kind === 3) && domains.length && techs.length) {
      const d = pickW(domains), t = pickW(techs), c = conns.length ? pick(conns) : undefined, proj = projOf(d);
      push({ title: `What if ${subject(d)} ${DOES[t.id][0]}?`, pitch: `${d.label} × ${t.label}${c ? `, ${c[1]}` : ""}.${proj ? ` Grows out of ${proj}.` : ""}`, idea: `${cap(subject(d).replace(/^your /, "my "))} that ${DOES[t.id][1]}${c ? `, ${c[1]}` : ""}.${proj ? ` Build on my project ${proj}.` : ""}`, uses: [d.label, t.label, ...(c ? [c[0]] : []), ...(proj ? [proj] : [])] });
    } else if (kind === 1 && gems.length) {
      const g = pick(gems.slice(0, 12)), proj = g.why.flatMap((w) => w.projects)[0];
      if (!proj) continue;
      push({ title: `What if ${g.name} became the engine of ${proj}?`, pitch: `${g.desc || g.full} Fork it and wire it into ${proj} instead of building that part yourself.`, idea: `Use ${g.full} (${g.desc}) as the core of a new version of my project ${proj}: what it replaces, what it adds, and what new product the combination makes possible.`, uses: [g.full, proj, ...g.why.map((w) => w.label).slice(0, 1)] });
    } else if (kind === 2 && domains.length && techs.length) {
      const d = pickW(domains), t = pickW(techs);
      const a = active.find((x) => x.name === pick(d.projects)), b = active.find((x) => x.name === pick(t.projects));
      if (!a || !b || a.name === b.name || b.tags.some((x) => a.tags.includes(x) && !STACK.has(x))) continue;
      push({ title: `What if ${a.name} and ${b.name} were one product?`, pitch: `${short(a.tldr, 90)} Meets: ${short(b.tldr, 90)}`, idea: `Combine my projects ${a.name} and ${b.name} into one product. ${a.name}: ${short(a.tldr)} ${b.name}: ${short(b.tldr)} Find the product only this combination makes possible.`, uses: [a.name, b.name, d.label, t.label] });
    } else if (kind === 4 && active.length) {
      const fits = SOURCES.flatMap(([src, ids]) => p.interests.filter((i) => ids.includes(i.id)).map((i) => [src, i] as const));
      if (!fits.length) continue;
      const [src, it] = pick(fits), name = projOf(it), proj = active.find((a) => a.name === name);
      if (!proj) continue;
      const c = conns.length ? pick(conns) : undefined;
      push({ title: `What if ${src} flowed into ${proj.name} on their own?`, pitch: `A daily agent pulls ${src}, keeps what matters to ${proj.name}${c ? `, ${c[1]}` : ""}.`, idea: `An always-on pipeline that pulls ${src} into my project ${proj.name} (${short(proj.tldr)}) and turns it into something useful every day${c ? `, ${c[1]}` : ""}.`, uses: [src, proj.name, it.label, ...(c ? [c[0]] : [])] });
    } else if (kind === 5 && domains.length) {
      const d = pickW(domains), c = conns.length ? pick(conns) : undefined;
      push({ title: `What if a crew of agents ran your ${lower(d.label)} research while you sleep?`, pitch: `herdr deck starts them at night, each takes one question, and the morning brings one briefing${c ? `, ${c[1]}` : ""}.`, idea: `A nightly crew of coding and research agents (started and watched from herdr deck) that investigates open questions in ${lower(d.label)}${d.projects.length ? ` for my projects ${d.projects.slice(0, 3).join(", ")}` : ""} and hands me one briefing each morning${c ? `, ${c[1]}` : ""}.`, uses: [d.label, "herdr deck", ...(c ? [c[0]] : [])] });
    }
    if (out.length > before) used.set(kind, (used.get(kind) ?? 0) + 1);
  }
  return out.slice(0, n);
}
