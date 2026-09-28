// Discover's profile: what you build and like, inferred from local files only (the wiki's projects, concepts and log,
// the repos under your projects folder, and the connections scan). Nothing here touches the network.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { frontmatter, slugify } from "../../src/text";
import type { Mix } from "./mix";

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
  mixes?: (Mix & { savedAt: number; direction?: string })[];
  leads?: any[]; // Leads the user saved (the leads plugin owns their shape)
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
export const STACK = new Set("typescript javascript python react vite sveltekit svelte nextjs fastify fastapi nodejs node bun prisma postgresql sqlite docker turborepo monorepo tailwind electron tauri vanilla-js express nestjs redux astro mdx gradio pytorch flask go rust shell markdown yaml click textual litellm openrouter ollama langchain vitest pnpm cloudflare supabase netlify firebase netlify-functions web-audio i-18n".split(" "));
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
export const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
export const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
export const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
