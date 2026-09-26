// Discover: repos worth forking ("hidden gems" matched to what you build), an idea lab that searches GitHub
// for building blocks and hands a research brief to an agent, the plans those agents write, and "what if"
// sparks generated from your own profile.
//
// Privacy: the profile is built locally from the wiki, your repos and the connections scan. Only interest
// keywords (and the words of an idea you type) ever leave the machine, as GitHub search queries through `gh`.
// Network work never blocks a request for long: cached data is returned at once and refreshed in the background.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const DAY = 86_400_000;

// ── types ────────────────────────────────────────────────────────────────────
export type Interest = {
  id: string; label: string; kind: "domain" | "tech";
  q: string; // GitHub search text (OR-joined phrases)
  terms: string[]; // lowercase words/phrases a matching repo mentions (word-prefix match)
  tags?: string[]; // wiki tags / GitHub topics that belong to it
  score: number; projects: string[]; source: "wiki" | "repos" | "you";
};
export type WikiProject = { name: string; status: string; tags: string[]; tldr: string; updated?: string; weight: number };
export type Profile = {
  at: number; interests: Interest[]; removed: Interest[];
  languages: { name: string; n: number }[];
  projects: WikiProject[]; recent: string[]; connections: string[];
  local: string[]; // owner/name of repos already cloned under ~/Documents/Projects
  names: string[]; // folder names there and wiki project names: a repo with one of these names is one you already have
  counts: { wiki: number; concepts: number; repos: number; log: number };
};
export type Repo = {
  full: string; url: string; desc: string; stars: number; lang?: string; pushed: string; created: string;
  license?: string; topics: string[]; owner: string; name: string;
};
export type Why = { id: string; label: string; projects: string[] };
export type Gem = Repo & { score: number; spm: number; why: Why[] };
export type DiscoverConf = {
  added: { label: string; q?: string }[]; removed: string[];
  saved: (Repo & { why?: Why[]; savedAt: number })[]; dismissed: string[];
  ideas: { slug: string; text: string; at: number }[];
};

// ── interests: wiki tags → searchable interests ────────────────────────────────
type Def = { id: string; label: string; kind: "domain" | "tech"; tags: string[]; q: string; terms: string[] };
export const INTERESTS: Def[] = [
  { id: "human-design", label: "Human Design", kind: "domain", tags: ["human-design", "human-design-tech", "bodygraph", "hd"], q: '"human design" OR bodygraph', terms: ["human design", "human-design", "humandesign", "bodygraph"] },
  { id: "astro", label: "Astrology & ephemeris", kind: "domain", tags: ["ephemeris", "astronomy", "swisseph", "astronomy-engine", "calc-engine", "astrology"], q: 'ephemeris OR astrology OR "swiss ephemeris"', terms: ["ephemeris", "astrology", "astrological", "swisseph", "horoscope", "natal chart", "astronomy"] },
  { id: "esoteric", label: "Esoteric & divination", kind: "domain", tags: ["esoteric", "esoteric-computing", "chaos-magick", "sigil", "divination", "i-ching", "tarot"], q: 'tarot OR "i ching" OR divination OR esoteric', terms: ["tarot", "i ching", "i-ching", "iching", "divination", "esoteric", "occult", "sigil", "oracle"] },
  { id: "agents", label: "Agent orchestration", kind: "tech", tags: ["agent-orchestration", "ai-agent-orchestration", "multi-agent", "orchestration", "ai-agents", "ai-agent", "coding-agents", "ai-software-factory", "ai-software-factories", "company-os", "intent-portability"], q: '"multi-agent" OR "agent orchestration" OR "coding agents"', terms: ["multi-agent", "multi agent", "agent orchestration", "orchestrat", "coding agent", "agentic", "agents", "agent"] },
  { id: "claude-code", label: "Claude Code tooling", kind: "tech", tags: ["claude-code", "claude", "codex"], q: '"claude code" OR "claude-code"', terms: ["claude code", "claude-code", "claude", "codex"] },
  { id: "mcp", label: "MCP servers", kind: "tech", tags: ["mcp", "code-tools", "cline"], q: '"mcp server" OR "model context protocol"', terms: ["mcp", "model context protocol", "model-context-protocol"] },
  { id: "rag", label: "RAG & knowledge bases", kind: "tech", tags: ["rag", "knowledge-base", "ai-memory", "knowledge-graph", "pgvector", "chromadb", "qdrant", "knowledge-extraction"], q: 'rag OR "knowledge graph" OR "retrieval augmented"', terms: ["rag", "retrieval", "knowledge graph", "knowledge base", "knowledge-graph", "vector", "embedding", "graphrag"] },
  { id: "osint", label: "OSINT", kind: "domain", tags: ["osint", "community-intelligence"], q: "osint", terms: ["osint", "open source intelligence", "open-source intelligence", "reconnaissance"] },
  { id: "forecasting", label: "Forecasting & prediction markets", kind: "domain", tags: ["forecasting", "prediction-markets"], q: '"prediction market" OR forecasting OR polymarket', terms: ["forecast", "prediction market", "prediction-market", "polymarket", "metaculus", "superforecast"] },
  { id: "trading", label: "Trading bots", kind: "domain", tags: ["trading", "trading-bot", "day-trading", "crypto", "wallet", "pine-script"], q: '"trading bot" OR backtesting', terms: ["trading", "backtest", "quant", "crypto"] },
  { id: "video", label: "AI video & clips", kind: "tech", tags: ["video", "youtube", "ai-video", "hyperframes", "remotion", "ffmpeg", "film"], q: '"video generation" OR "short video" OR "video editing" OR remotion', terms: ["video", "clips", "shorts", "remotion", "ffmpeg", "youtube"] },
  { id: "speech", label: "Speech & voice agents", kind: "tech", tags: ["whisper", "voice", "voice-agent", "voice-control", "speech"], q: '"voice agent" OR "speech to text" OR whisper', terms: ["voice", "speech", "whisper", "tts", "stt", "transcri"] },
  { id: "3d", label: "3D & WebGL", kind: "tech", tags: ["threejs", "3d-reconstruction", "gaussian-splatting", "blender", "webgl", "first-person"], q: 'threejs OR "gaussian splatting" OR webgl', terms: ["three.js", "threejs", "webgl", "webgpu", "3d", "gaussian splat", "splat"] },
  { id: "games", label: "Browser games", kind: "domain", tags: ["game", "browser-game", "game-development", "phaser", "godot", "gdscript", "multiplayer", "gamification"], q: 'phaser OR "browser game" OR godot', terms: ["game", "phaser", "godot", "gamedev"] },
  { id: "genmedia", label: "Generative images & music", kind: "tech", tags: ["image-gen", "stable-diffusion", "ai-art", "music-generation", "image-generation", "diffusion", "image-processing"], q: '"image generation" OR "music generation" OR comfyui', terms: ["image generation", "diffusion", "comfyui", "music generation", "text-to-image", "generative"] },
  { id: "scraping", label: "Scraping & data pipelines", kind: "tech", tags: ["scraping", "data-pipeline", "ocr", "text-extraction"], q: 'scraper OR crawler OR "data pipeline"', terms: ["scrap", "crawl", "pipeline", "extract", "ocr"] },
  { id: "automation", label: "Business automation", kind: "domain", tags: ["business-automation", "lead-gen", "n8n", "automation", "workflow", "integrations", "seo", "geo", "shopify", "content-automation"], q: '"workflow automation" OR "lead generation" OR n8n', terms: ["automation", "automate", "workflow", "lead", "n8n", "seo"] },
  { id: "evals", label: "LLM evals", kind: "tech", tags: ["ai-evaluation", "evaluation", "context-windows"], q: '"llm evaluation" OR "llm eval" OR evals', terms: ["eval", "benchmark", "llm-as-judge", "evaluation"] },
  { id: "local-first", label: "Local-first & privacy", kind: "tech", tags: ["local-first", "privacy", "self-hosted", "security", "local-ai", "webauthn"], q: '"local-first" OR "self-hosted" OR privacy', terms: ["local-first", "self-hosted", "privacy", "offline", "e2ee", "local"] },
  { id: "pwa", label: "PWA & mobile web", kind: "tech", tags: ["pwa", "mobile-web", "mobile"], q: 'pwa OR "progressive web app"', terms: ["pwa", "progressive web app", "mobile", "offline"] },
  { id: "telegram", label: "Telegram bots", kind: "tech", tags: ["telegram", "telethon"], q: '"telegram bot" OR telethon', terms: ["telegram"] },
  { id: "geo", label: "Maps & geospatial", kind: "domain", tags: ["geospatial", "postgis", "location-intelligence", "local-discovery"], q: 'geospatial OR maplibre OR "satellite imagery"', terms: ["geo", "map", "gis", "satellite", "location"] },
  { id: "viz", label: "Visualization & experimental UI", kind: "tech", tags: ["visualization", "experimental-ui", "svg", "design-tool", "editor", "dashboard", "canvas"], q: '"data visualization" OR "infinite canvas" OR "generative ui"', terms: ["visuali", "canvas", "svg", "chart", "diagram", "dashboard"] },
  { id: "matching", label: "Matching & social", kind: "domain", tags: ["ai-matching", "intimacy", "matching", "realtime"], q: 'matchmaking OR "dating app"', terms: ["match", "dating", "compatib", "social"] },
  { id: "education", label: "Learning & education", kind: "domain", tags: ["education", "lms", "science-communication"], q: '"learning platform" OR "spaced repetition"', terms: ["learn", "education", "course", "tutor"] },
  { id: "hebrew", label: "Hebrew & i18n", kind: "domain", tags: ["hebrew", "i18n"], q: 'hebrew OR "right-to-left"', terms: ["hebrew", "rtl", "i18n", "translation"] },
];
/** Tags that describe a stack rather than an interest: they shape language fit, not searches. */
const STACK = new Set("typescript javascript python react vite sveltekit svelte nextjs fastify fastapi nodejs node bun prisma postgresql sqlite docker turborepo monorepo tailwind electron tauri vanilla-js express nestjs redux astro mdx gradio pytorch flask go rust shell markdown yaml click textual litellm openrouter ollama langchain vitest pnpm cloudflare supabase netlify firebase netlify-functions web-audio i-18n".split(" "));
/** Tags that say nothing about what you like. */
const GENERIC = new Set("external legacy backup docs-only framework library toolkit scaffold full-stack-web cli tooling dev-tooling desktop web-ui gui macos linux blog portfolio showcase vertical-slice prototype domain ai llm research-tools research creative note stale active archived misc tools app web platform herdr apartment petah-tikva burning-man transformation interaction film ai data-pipeline".split(" "));
const STATUS_W: Record<string, number> = { active: 3, launched: 2.5, prototype: 2, note: 1.2, "no-git": 1, stale: 0.8, legacy: 0.4, archived: 0.2, dead: 0 };
const DEP_TAGS: Record<string, string> = {
  three: "threejs", phaser: "phaser", "@modelcontextprotocol/sdk": "mcp", telegraf: "telegram", grammy: "telegram", "node-telegram-bot-api": "telegram",
  remotion: "remotion", "@remotion/cli": "remotion", hyperframes: "hyperframes", "maplibre-gl": "geospatial", leaflet: "geospatial", "@anthropic-ai/claude-agent-sdk": "ai-agent",
  "@anthropic-ai/sdk": "ai-agent", "@xenova/transformers": "rag", chromadb: "rag", "@qdrant/js-client-rest": "rag", pgvector: "rag", "astronomy-engine": "astronomy-engine", swisseph: "swisseph", "sweph": "swisseph",
  whisper: "whisper", "openai-whisper": "whisper", "faster-whisper": "whisper", telethon: "telethon", "yt-dlp": "youtube", "python-telegram-bot": "telegram", playwright: "scraping", crawlee: "scraping", "tone": "web-audio",
};

// ── small helpers ─────────────────────────────────────────────────────────────
export const slugify = (s: string, n = 48) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, " ").replace(/[_\s-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "");
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = new Map<string, RegExp>();
/** A term matches at the start of a word ("orchestrat" hits "orchestration", "rag" doesn't hit "storage"). */
export function hasTerm(text: string, term: string) {
  let re = termRe.get(term);
  if (!re) { re = new RegExp(`(^|[^a-z0-9])${escRe(term)}`); termRe.set(term, re); }
  return re.test(text);
}

/** YAML front matter: flat `key: value` and `key: [a, b]` only, which is all the wiki and idea files use. */
export function frontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    data[kv[1]] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : v.replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(m[0].length) };
}
const firstLine = (body: string) => (body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "").replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1").replace(/[*_`]/g, "");

// ── the profile ─────────────────────────────────────────────────────────────────
export type ProfileInput = { wikiDir: string; projectsDir: string; connections?: string[]; conf?: Partial<DiscoverConf>; now?: number };

/** Everything the deck can infer about what you build and like, from local files only. */
export async function buildProfile(inp: ProfileInput): Promise<Profile> {
  const now = inp.now ?? Date.now();
  const conf = { added: [], removed: [], ...inp.conf } as DiscoverConf;
  const byTag = new Map<string, Def>();
  for (const d of INTERESTS) for (const t of [d.id, ...d.tags]) byTag.set(t, d);

  // Recent activity: which pages the log mentions in the last 30 days.
  const log = readText(`${inp.wikiDir}/log.md`);
  const recentCount = new Map<string, number>();
  let logN = 0;
  for (const m of log.matchAll(/^## \[(\d{4}-\d\d-\d\d)\][^|\n]*\|\s*(.+)$/gm)) {
    if (now - Date.parse(m[1]) > 30 * DAY) continue;
    logN++;
    const words = new Set(m[2].toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []);
    for (const w of words) recentCount.set(w, (recentCount.get(w) ?? 0) + 1);
  }

  const score = new Map<string, { s: number; projects: Map<string, number>; source: Interest["source"] }>();
  const other = new Map<string, { s: number; projects: Map<string, number>; n: number }>();
  const bump = (tag: string, w: number, project?: string, source: Interest["source"] = "wiki") => {
    tag = tag.toLowerCase().trim();
    if (!tag || STACK.has(tag) || GENERIC.has(tag)) return;
    const d = byTag.get(tag);
    if (d) {
      const e = score.get(d.id) ?? { s: 0, projects: new Map(), source };
      if (project) { if (e.projects.has(project)) return; e.projects.set(project, w); }
      e.s += w;
      if (source === "wiki") e.source = "wiki";
      score.set(d.id, e);
    } else if (/^[a-z][a-z0-9-]{2,30}$/.test(tag)) {
      const e = other.get(tag) ?? { s: 0, projects: new Map(), n: 0 };
      if (project && e.projects.has(project)) return;
      if (project) e.projects.set(project, w);
      e.s += w; e.n++;
      other.set(tag, e);
    }
  };

  const projects: WikiProject[] = [];
  for (const f of ls(`${inp.wikiDir}/projects`).filter((f) => f.endsWith(".md"))) {
    const { data, body } = frontmatter(readText(`${inp.wikiDir}/projects/${f}`));
    const name = f.slice(0, -3);
    const status = String(data.status ?? "active");
    const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
    const upd = Date.parse(String(data.date_updated ?? ""));
    const age = Number.isFinite(upd) ? (now - upd) / DAY : 365;
    const rec = age <= 30 ? 1.5 : age <= 90 ? 1.2 : age <= 365 ? 1 : 0.7;
    const hits = recentCount.get(name) ?? 0;
    const ext = tags.includes("external") ? 0.5 : 1;
    const weight = (STATUS_W[status] ?? 1) * rec * ext * (1 + Math.min(hits, 10) * 0.1);
    projects.push({ name, status, tags, tldr: firstLine(body).slice(0, 180), updated: data.date_updated, weight });
    for (const t of tags) bump(t, weight, name);
  }
  let concepts = 0;
  for (const f of ls(`${inp.wikiDir}/concepts`).filter((f) => f.endsWith(".md"))) {
    concepts++;
    const { data } = frontmatter(readText(`${inp.wikiDir}/concepts/${f}`));
    bump(f.slice(0, -3), 2);
    for (const t of Array.isArray(data.tags) ? data.tags : []) bump(t, 1);
  }

  // Your repos: languages, package keywords and telling dependencies. Also which GitHub repos you already have.
  const langs = new Map<string, number>();
  const local = new Set<string>();
  const names = new Set<string>(projects.map((x) => x.name.toLowerCase()));
  let repos = 0;
  for (const d of ls(inp.projectsDir)) {
    if (d.startsWith(".")) continue;
    const dir = `${inp.projectsDir}/${d}`;
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    repos++;
    names.add(d.toLowerCase());
    const age = (now - st.mtimeMs) / DAY;
    const w = age <= 30 ? 1 : age <= 180 ? 0.6 : 0.3;
    const addLang = (l: string) => langs.set(l, (langs.get(l) ?? 0) + w);
    const pkgText = readText(`${dir}/package.json`);
    if (pkgText) {
      let pkg: any = {}; try { pkg = JSON.parse(pkgText); } catch {}
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      addLang(existsSync(`${dir}/tsconfig.json`) || deps.typescript ? "TypeScript" : "JavaScript");
      for (const k of Array.isArray(pkg.keywords) ? pkg.keywords : []) bump(String(k), 0.5 * w, d, "repos");
      for (const dep of Object.keys(deps)) if (DEP_TAGS[dep]) bump(DEP_TAGS[dep], 0.6 * w, d, "repos");
    }
    const py = readText(`${dir}/requirements.txt`) + readText(`${dir}/pyproject.toml`);
    if (py || existsSync(`${dir}/setup.py`)) {
      addLang("Python");
      for (const m of py.toLowerCase().matchAll(/^\s*["']?([a-z0-9_.-]+)/gm)) if (DEP_TAGS[m[1]]) bump(DEP_TAGS[m[1]], 0.6 * w, d, "repos");
    }
    if (existsSync(`${dir}/Cargo.toml`)) addLang("Rust");
    if (existsSync(`${dir}/go.mod`)) addLang("Go");
    if (existsSync(`${dir}/project.godot`)) addLang("GDScript");
    if (existsSync(`${dir}/Package.swift`)) addLang("Swift");
    const git = readText(`${dir}/.git/config`);
    for (const m of git.matchAll(/url\s*=\s*\S*github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/gm)) local.add(m[1].toLowerCase());
  }

  const removed = new Set(conf.removed);
  const all: Interest[] = [];
  for (const [id, e] of score) {
    const d = INTERESTS.find((x) => x.id === id)!;
    const projs = [...e.projects].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    all.push({ id, label: d.label, kind: d.kind, q: d.q, terms: d.terms, tags: d.tags, score: Math.round(e.s * 10) / 10, projects: projs.slice(0, 6), source: e.source });
  }
  // Tags outside the dictionary become interests when enough of your work shares them.
  for (const [tag, e] of other) {
    if (e.projects.size < 2 && e.s < 5) continue;
    const words = tag.replace(/-/g, " ");
    all.push({ id: tag, label: words.replace(/\b\w/g, (c) => c.toUpperCase()), kind: "domain", q: words.includes(" ") ? `"${words}"` : words, terms: [words, tag], tags: [tag], score: Math.round(e.s * 10) / 10, projects: [...e.projects].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 6), source: "wiki" });
  }
  all.sort((a, b) => b.score - a.score);
  const yours: Interest[] = conf.added.map((a) => {
    const label = String(a.label).trim().slice(0, 60);
    const words = label.toLowerCase();
    return { id: `you:${slugify(label, 40)}`, label, kind: "domain" as const, q: a.q || (/\s/.test(words) ? `"${words}"` : words), terms: [words, ...words.split(/\s+/).filter((w) => w.length > 3)], score: 99, projects: [], source: "you" as const };
  }).filter((x) => x.label && !removed.has(x.id));
  const kept = all.filter((x) => !removed.has(x.id) && !yours.some((y) => y.id === x.id));
  const interests = [...yours, ...kept.slice(0, Math.max(0, 14 - yours.length))];
  const recent = [...recentCount].filter(([w]) => projects.some((p) => p.name === w)).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 8);
  return {
    at: now, interests, removed: all.filter((x) => removed.has(x.id)),
    languages: [...langs].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n: Math.round(n * 10) / 10 })).slice(0, 6),
    projects: projects.sort((a, b) => b.weight - a.weight), recent, connections: inp.connections ?? [], local: [...local], names: [...names],
    counts: { wiki: projects.length, concepts, repos, log: logN },
  };
}

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
type RowLite = { key: string; title: string; status: string; firstPrompt?: string };
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
const CONN_FITS: [RegExp, RegExp][] = [
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

// ── gh: async, with timeouts and a gentle rate limit ─────────────────────────────────
const BIN_DIRS = [`${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":")];
const GH = BIN_DIRS.map((d) => `${d}/gh`).find((p) => existsSync(p));
export const ghAvailable = () => !!GH;
export type GhRes = { ok: boolean; status: number; data?: any; error?: string; remaining?: number; reset?: number };
async function gh(args: string[], timeoutMs = 15_000): Promise<GhRes> {
  if (!GH) return { ok: false, status: 0, error: "The GitHub CLI (gh) isn't installed" };
  let p: ReturnType<typeof Bun.spawn> | undefined;
  try {
    p = Bun.spawn([GH, "api", "-i", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
    const read = (async () => [await new Response(p!.stdout as ReadableStream).text(), await new Response(p!.stderr as ReadableStream).text()] as const)();
    const got = await Promise.race([read, Bun.sleep(timeoutMs).then(() => null)]);
    if (!got) return { ok: false, status: 0, error: "GitHub didn't answer in time" };
    const [out, err] = got;
    const cut = out.search(/\r?\n\r?\n/);
    const head = cut >= 0 ? out.slice(0, cut) : "";
    const body = cut >= 0 ? out.slice(cut).trim() : out.trim();
    const status = Number(head.match(/^HTTP\/[\d.]+\s+(\d+)/)?.[1] ?? 0);
    const hdr = (k: string) => head.match(new RegExp(`^${k}:\\s*(\\S+)`, "im"))?.[1];
    let data: any; try { data = JSON.parse(body); } catch {}
    const remaining = hdr("x-ratelimit-remaining") != null ? Number(hdr("x-ratelimit-remaining")) : undefined;
    const reset = hdr("x-ratelimit-reset") != null ? Number(hdr("x-ratelimit-reset")) * 1000 : undefined;
    const ok = status >= 200 && status < 300 && !!data;
    return { ok, status, data, remaining, reset, error: ok ? undefined : data?.message ?? (err.trim().split("\n").pop() || `GitHub said ${status || "nothing"}`) };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  } finally {
    try { p?.kill(9); } catch {}
  }
}

// ── state: config, cache, background refresh ────────────────────────────────────────
export type DiscoverPaths = { dataDir: string; wikiDir: string; projectsDir: string };
type Cache = {
  profile?: Profile;
  gems: Record<string, { at: number; q: string; items: Repo[]; error?: string }>;
  trend: Record<string, { at: number; q: string; items: Repo[]; error?: string }>;
  ideas: Record<string, { at: number; keywords: string[]; items: Repo[]; topics: { name: string; desc: string }[] }>;
  login?: string;
};
const TTL = 6 * 3600_000;
const TREND_TTL = 12 * 3600_000;
const SEARCH_GAP = 1500;

export function createDiscover(paths: DiscoverPaths, deps: { connections?: () => Promise<string[]>; rows?: () => RowLite[]; gh?: (args: string[], timeoutMs?: number) => Promise<GhRes>; gap?: number } = {}) {
  const run = deps.gh ?? gh;
  const GAP = deps.gap ?? SEARCH_GAP;
  const CONF = `${paths.dataDir}/discover.json`;
  const CACHE = `${paths.dataDir}/discover-cache.json`;
  const IDEAS = `${paths.dataDir}/ideas`;
  const CONN_FILE = `${paths.dataDir}/CONNECTIONS.md`;
  const pctx: PromptCtx = { ideasDir: IDEAS, connectionsFile: CONN_FILE, projectsDir: paths.projectsDir };
  const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
  const writeJson = (p: string, v: unknown) => { mkdirSync(paths.dataDir, { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, p); };
  let conf: DiscoverConf = { added: [], removed: [], saved: [], dismissed: [], ideas: [], ...readJson(CONF) };
  let cache: Cache = { gems: {}, trend: {}, ideas: {}, ...readJson(CACHE) };
  const saveConf = () => writeJson(CONF, conf);
  let cacheTimer: ReturnType<typeof setTimeout> | undefined;
  const saveCache = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => { try { writeJson(CACHE, cache); } catch {} }, 400); };

  let connNames: string[] = cache.profile?.connections ?? [];
  let profileBuilding: Promise<Profile> | undefined;
  async function profile(force = false): Promise<Profile> {
    if (cache.profile && !force && Date.now() - cache.profile.at < 10 * 60_000) return cache.profile;
    if (profileBuilding) return cache.profile && !force ? cache.profile : profileBuilding;
    profileBuilding = (async () => {
      if (deps.connections) {
        const c = await Promise.race([deps.connections().catch(() => undefined), Bun.sleep(1500).then(() => undefined)]);
        if (c) connNames = c;
        else deps.connections().then((x) => { connNames = x; if (cache.profile) cache.profile.connections = x; }).catch(() => {});
      }
      const p = await buildProfile({ wikiDir: paths.wikiDir, projectsDir: paths.projectsDir, connections: connNames, conf });
      cache.profile = p;
      saveCache();
      return p;
    })().finally(() => { profileBuilding = undefined; });
    return cache.profile && !force ? cache.profile : profileBuilding;
  }

  // Search budget: GitHub allows 30 searches a minute. Background refresh keeps a reserve for the idea lab.
  let remaining = 30, resetAt = 0, lastSearch = 0;
  let refreshing: Promise<void> | undefined;
  let lastError = "";
  async function search(kind: "repositories" | "topics", q: string, extra: string[] = [], reserve = 0): Promise<GhRes> {
    if (Date.now() > resetAt) remaining = Math.max(remaining, 30);
    if (remaining <= reserve) {
      const wait = resetAt - Date.now();
      if (wait > 65_000 || wait < 0) remaining = 30; // stale bookkeeping
      else await Bun.sleep(wait + 500);
    }
    if (reserve) { const gap = lastSearch + GAP - Date.now(); if (gap > 0) await Bun.sleep(gap); }
    lastSearch = Date.now();
    const r = await run(["-X", "GET", `search/${kind}`, "-f", `q=${q}`, ...extra.flatMap((x) => ["-f", x])]);
    if (r.remaining != null) { remaining = r.remaining; resetAt = r.reset ?? Date.now() + 60_000; }
    if (!r.ok && (r.status === 403 || r.status === 429)) { remaining = 0; resetAt = r.reset ?? Date.now() + 60_000; }
    return r;
  }
  const since = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const gemQuery = (it: Interest) => `${it.q} stars:30..5000 pushed:>${since(180)} archived:false fork:false`;
  const trendQuery = (it: Interest) => `${it.q} created:>${since(120)} stars:>=15 archived:false fork:false`;

  function refresh(force = false) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const p = await profile();
      lastError = "";
      if (!cache.login) { const u = await run(["user"], 8000); if (u.ok) cache.login = u.data.login; }
      const now = Date.now();
      const jobs: { it: Interest; kind: "gems" | "trend" }[] = [];
      const due = (c: Cache["gems"][string] | undefined, it: Interest, ttl: number) => force || !c || c.q !== it.q || now - c.at > ttl || (!!c.error && now - c.at > 5 * 60_000);
      for (const it of p.interests) if (due(cache.gems[it.id], it, TTL)) jobs.push({ it, kind: "gems" });
      for (const it of p.interests.slice(0, 5)) if (due(cache.trend[it.id], it, TREND_TTL)) jobs.push({ it, kind: "trend" });
      for (const { it, kind } of jobs) {
        const q = kind === "gems" ? gemQuery(it) : trendQuery(it);
        const r = await search("repositories", q, kind === "gems" ? ["per_page=40"] : ["sort=stars", "order=desc", "per_page=20"], 8);
        const entry = { at: Date.now(), q: it.q, items: r.ok ? (r.data.items ?? []).map(toRepo) : (kind === "gems" ? cache.gems : cache.trend)[it.id]?.items ?? [], ...(r.ok ? {} : { error: r.error }) };
        (kind === "gems" ? cache.gems : cache.trend)[it.id] = entry;
        if (!r.ok) { lastError = r.error ?? "GitHub search failed"; if (r.status === 0 && /install|auth|login/i.test(lastError)) break; }
        saveCache();
      }
    })().catch((e) => { lastError = e?.message ?? String(e); }).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  function ctxFor(p: Profile): RankCtx {
    return { now: Date.now(), dismissed: new Set(conf.dismissed.map((x) => x.toLowerCase())), exclude: new Set(p.local), names: new Set(p.names ?? []), own: cache.login, languages: new Set(p.languages.slice(0, 3).map((l) => l.name)) };
  }
  function ranked(p: Profile) {
    const ctx = ctxFor(p);
    const gems = rankGems(Object.fromEntries(Object.entries(cache.gems).map(([k, v]) => [k, v.items])), p.interests, ctx);
    const gemSet = new Set(gems.slice(0, 24).map((g) => g.full));
    const trending = rankTrending(Object.fromEntries(Object.entries(cache.trend).map(([k, v]) => [k, v.items])), p.interests.slice(0, 5), ctx).filter((g) => !gemSet.has(g.full));
    return { gems, trending };
  }

  async function state(body: { refresh?: boolean; shuffle?: number } = {}) {
    const p = await profile(!!body.refresh);
    const ats = p.interests.map((i) => cache.gems[i.id]?.at ?? 0);
    const fetchedAt = ats.length ? Math.min(...ats) : 0;
    const missing = p.interests.filter((i) => !cache.gems[i.id]).length;
    const stale = !fetchedAt || Date.now() - fetchedAt > TTL;
    const retry = p.interests.some((i) => cache.gems[i.id]?.error && Date.now() - cache.gems[i.id].at > 5 * 60_000);
    if (body.refresh || stale || missing || retry) refresh(!!body.refresh);
    const { gems, trending } = ranked(p);
    const day = Math.floor(Date.now() / DAY);
    return {
      profile: { interests: p.interests, removed: p.removed.map(({ id, label }) => ({ id, label })), languages: p.languages, connections: p.connections, recent: p.recent, counts: p.counts, projects: p.projects.slice(0, 40).map(({ name, status }) => ({ name, status })) },
      gems, trending, sparks: sparks(p, gems, day + (Number(body.shuffle) || 0)),
      saved: conf.saved, dismissed: conf.dismissed.length, ideas: listIdeas(IDEAS, deps.rows?.() ?? [], conf.ideas),
      fetchedAt, stale, refreshing: !!refreshing, error: lastError || undefined, gh: !!deps.gh || ghAvailable(), login: cache.login,
      perInterest: Object.fromEntries(p.interests.map((i) => [i.id, { at: cache.gems[i.id]?.at, n: cache.gems[i.id]?.items.length ?? 0, error: cache.gems[i.id]?.error }])),
    };
  }

  async function ideaSearch(text: string) {
    const keywords = extractKeywords(text);
    if (!keywords.length) throw new Error("Say a little more about the idea: what it does, for whom, with what.");
    const key = keywords.join("|");
    const p = await profile();
    let c = cache.ideas[key];
    if (!c || Date.now() - c.at > TTL) {
      const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
      // The top three together, then pairs (focused), then the strongest word alone.
      const [a, b, c2] = keywords.map(q);
      const queries = [
        `${[a, b, c2].filter(Boolean).join(" ")} stars:>=3`,
        b && `${a} ${b} stars:>=5`, c2 && `${a} ${c2} stars:>=5`, c2 && `${b} ${c2} stars:>=5`,
        `${a} stars:>=20`,
      ].filter((x): x is string => !!x).filter((x, i, arr) => arr.indexOf(x) === i).slice(0, 5);
      const results = await Promise.all([
        ...queries.map((x) => search("repositories", `${x} archived:false fork:false`, ["per_page=15"])),
        ...keywords.slice(0, 2).map((k) => search("topics", k, ["per_page=6"])),
      ]);
      const repoRes = results.slice(0, queries.length), topicRes = results.slice(queries.length);
      if (repoRes.every((r) => !r.ok)) throw new Error(repoRes[0]?.error ?? "GitHub search failed");
      const items = repoRes.flatMap((r) => (r.ok ? r.data.items ?? [] : [])).map(toRepo);
      const topics = topicRes.flatMap((r) => (r.ok ? r.data.items ?? [] : [])).map((t: any) => ({ name: t.name, desc: String(t.short_description ?? t.description ?? "").slice(0, 140) }))
        .filter((t: any, i: number, a: any[]) => a.findIndex((x) => x.name === t.name) === i).slice(0, 8);
      c = cache.ideas[key] = { at: Date.now(), keywords, items, topics };
      const keys = Object.keys(cache.ideas);
      if (keys.length > 40) for (const k of keys.sort((a, b) => cache.ideas[a].at - cache.ideas[b].at).slice(0, keys.length - 40)) delete cache.ideas[k];
      saveCache();
    }
    const repos = rankIdeaRepos(c.items as any, keywords, Date.now());
    // Your own projects and connections that could play a part. Matched locally; nothing here is sent anywhere.
    const related = p.projects.filter((x) => !x.tags.includes("external") && x.weight > 0.5)
      .map((x) => { const head = `${x.name.replace(/-/g, " ")} ${x.tags.join(" ").replace(/-/g, " ")}`.toLowerCase(), tl = x.tldr.toLowerCase(); return { x, hits: keywords.reduce((a, k) => a + (hasTerm(head, k) ? 2 : hasTerm(tl, k) ? 1 : 0), 0) }; })
      .filter((e) => e.hits >= 2).sort((a, b) => b.hits - a.hits || b.x.weight - a.x.weight).slice(0, 6).map((e) => e.x.name);
    const lower = `${text} ${keywords.join(" ")}`.toLowerCase();
    const conns = p.connections.filter((cn) => { const re = CONN_FITS.find(([n]) => n.test(cn))?.[1]; return re ? re.test(lower) : lower.includes(cn.toLowerCase()); });
    let slug = slugify(keywords.slice(0, 5).join(" ") || text, 48) || `idea-${Date.now().toString(36)}`;
    if (existsSync(`${IDEAS}/${slug}.md`) || conf.ideas.some((x) => x.slug === slug && x.text !== text.trim())) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    return { keywords, groups: groupByRole(repos), topics: c.topics, related, connections: conns.slice(0, 8), slug, cachedAt: c.at, prompt: researchPrompt(text, slug, { ...pctx, repos, projects: related, keywords }), cwd: paths.projectsDir };
  }

  async function handle(path: string, body: any): Promise<any> {
    switch (path) {
      case "/api/discover": return state(body);
      case "/api/discover/interest": {
        const label = String(body.label ?? "").trim().slice(0, 60);
        const id = String(body.id ?? "");
        if (body.op === "add") { if (!label) throw new Error("Name the interest"); const nid = `you:${slugify(label, 40)}`; conf.added = [...conf.added.filter((a) => `you:${slugify(a.label, 40)}` !== nid), { label }]; conf.removed = conf.removed.filter((x) => x !== nid); }
        else if (body.op === "remove") { if (id.startsWith("you:")) conf.added = conf.added.filter((a) => `you:${slugify(a.label, 40)}` !== id); else conf.removed = [...new Set([...conf.removed, id])]; }
        else if (body.op === "restore") conf.removed = id ? conf.removed.filter((x) => x !== id) : [];
        else throw new Error("unknown op");
        saveConf();
        await profile(true);
        return state({});
      }
      case "/api/discover/repo": {
        const r = body.repo ?? {};
        const full = String(r.full ?? body.full ?? "");
        if (!/^[\w.-]+\/[\w.-]+$/.test(full) && !(body.op === "undismiss" && full === "*/*")) throw new Error("Which repo?");
        if (body.op === "save") { const keep = { full, url: `https://github.com/${full}`, desc: String(r.desc ?? "").slice(0, 300), stars: Number(r.stars) || 0, lang: r.lang, pushed: String(r.pushed ?? ""), created: String(r.created ?? ""), license: r.license, topics: (r.topics ?? []).slice(0, 12).map(String), owner: full.split("/")[0], name: full.split("/")[1], why: (r.why ?? []).slice(0, 4), savedAt: Date.now() }; conf.saved = [keep, ...conf.saved.filter((x) => x.full !== full)].slice(0, 300); }
        else if (body.op === "unsave") conf.saved = conf.saved.filter((x) => x.full !== full);
        else if (body.op === "dismiss") conf.dismissed = [...new Set([...conf.dismissed, full])].slice(-2000);
        else if (body.op === "undismiss") conf.dismissed = full === "*/*" ? [] : conf.dismissed.filter((x) => x !== full);
        else throw new Error("unknown op");
        saveConf();
        return { ok: true, saved: conf.saved, dismissed: conf.dismissed.length };
      }
      case "/api/discover/idea": {
        const text = String(body.text ?? "").trim().slice(0, 2000);
        if (text.length < 4) throw new Error("Describe the idea first");
        return ideaSearch(text);
      }
      case "/api/discover/idea-started": {
        const slug = slugify(String(body.slug ?? ""), 60);
        if (!slug) throw new Error("Which idea?");
        conf.ideas = [{ slug, text: String(body.text ?? "").slice(0, 2000), at: Date.now() }, ...conf.ideas.filter((x) => x.slug !== slug)].slice(0, 100);
        saveConf();
        return { ideas: listIdeas(IDEAS, deps.rows?.() ?? [], conf.ideas) };
      }
      case "/api/discover/ideas": return { ideas: listIdeas(IDEAS, deps.rows?.() ?? [], conf.ideas) };
      case "/api/discover/idea-file": {
        const slug = String(body.slug ?? "");
        if (!/^[\w.-]+$/.test(slug)) throw new Error("Which idea?");
        const text = readText(`${IDEAS}/${slug}.md`);
        if (!text) throw new Error("That plan isn't written yet");
        const { data, body: md } = frontmatter(text);
        return { slug, text: md, meta: data, path: `${IDEAS}/${slug}.md` };
      }
      case "/api/discover/idea-forget": {
        const slug = String(body.slug ?? "");
        conf.ideas = conf.ideas.filter((x) => x.slug !== slug);
        saveConf();
        return { ideas: listIdeas(IDEAS, deps.rows?.() ?? [], conf.ideas) };
      }
      case "/api/discover/prompt": {
        if (body.kind === "fork") return { prompt: forkPrompt(body.repo, pctx), cwd: paths.projectsDir, label: `Explore ${String(body.repo?.name ?? "").slice(0, 30)}` };
        if (body.kind === "build") {
          const slug = String(body.slug ?? "");
          if (!/^[\w.-]+$/.test(slug)) throw new Error("Which idea?");
          const title = String(body.title ?? slug);
          return { prompt: buildPrompt(slug, title, pctx), cwd: paths.projectsDir, label: `Build ${title.slice(0, 30)}` };
        }
        if (body.kind === "research") {
          const text = String(body.text ?? "").trim();
          const slug = slugify(String(body.slug ?? "") || text, 60);
          return { prompt: researchPrompt(text, slug, { ...pctx, repos: body.repos ?? [], projects: body.projects ?? [], keywords: extractKeywords(text) }), cwd: paths.projectsDir, label: `Plan: ${text.slice(0, 30)}`, slug };
        }
        throw new Error("unknown prompt");
      }
    }
    return undefined;
  }
  return { handle, refresh, profile, state, flush: () => { clearTimeout(cacheTimer); writeJson(CACHE, cache); }, paths: { conf: CONF, cache: CACHE, ideas: IDEAS } };
}
