// The user's inventory as idea ingredients: every project, connection, account, tool, key name, gem repo and
// recommended service becomes an Asset with capabilities (what it can do), roles (where it fits in a product) and
// topics (what it's about). Capabilities are the shared vocabulary between the sampler, the connector mapper and
// the starter kit, so "needs a payment rail" maps to "you have Gumroad" or "add Lemon Squeezy".
import type { Asset, AssetKind, Audience, Inventory, Role } from "./types";

// ── capabilities ─────────────────────────────────────────────────────────────────────────────
export type CapDef = {
  id: string; label: string; role: Role; re: RegExp;
  /** Env var names a project using this capability usually needs (names only, never values). */
  keys?: string[];
  /** Recommended-service ids (src/catalog.ts RECS) or built-in services that supply it. */
  recs?: string[];
  /** The canonical open-source library for it (owner/repo; checked with gh before it's suggested). */
  lib?: string;
  /** Otherwise a GitHub search for one. */
  gh?: string;
  topics?: string[];
};
export const CAPS: CapDef[] = [
  { id: "payments", label: "Take payments", role: "monetization", re: /gumroad|stripe|lemon ?squeezy|paddle|shopify|patreon|checkout|payments?\b|merchant|\bton\b/, keys: ["GUMROAD_ACCESS_TOKEN", "STRIPE_SECRET_KEY"], recs: ["stripe", "lemon-squeezy"], lib: "stripe/stripe-node" },
  { id: "hosting", label: "Host a web app", role: "distribution", re: /vercel|netlify|cloudflare|firebase|heroku|fly\.io|railway|render\.com|pages\b/, keys: ["NETLIFY_AUTH_TOKEN", "CLOUDFLARE_API_KEY"], recs: ["cloudflare", "railway"] },
  { id: "db-auth", label: "Accounts & database", role: "build", re: /supabase|postgres|\bneon\b|firebase|auth0|sqlite|redis|upstash|database/, keys: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "DATABASE_URL"], recs: ["supabase", "neon", "upstash"] },
  { id: "email", label: "Send email", role: "channel", re: /resend|gmail|sendgrid|mailchimp|\bemails?\b|\bmail\b/, keys: ["RESEND_API_KEY"], recs: ["resend"], lib: "resend/resend-node" },
  { id: "newsletter", label: "Newsletter", role: "channel", re: /beehiiv|buttondown|mailchimp|newsletter|substack/, recs: ["beehiiv", "buttondown"] },
  { id: "llm", label: "LLM calls", role: "engine", re: /\bclaude\b|openai|openrouter|anthropic|ollama|gemini|deepseek|\bllms?\b|\bgpt|nanogpt|hermes/, keys: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"], recs: ["groq"] },
  { id: "rag", label: "Search a corpus with sources", role: "engine", re: /\brag\b|chroma|vector|embedding|knowledge base|corpus|semantic (?:search|index)|pgvector|retrieval/, recs: ["turbopuffer", "pinecone"], topics: ["rag"], lib: "run-llama/llama_index" },
  { id: "transcription", label: "Transcribe audio/video", role: "engine", re: /transcri|whisper|deepgram|speech[- ]to[- ]text|subtitle|\bsrt\b/, keys: ["DEEPGRAM_API_KEY"], recs: ["deepgram", "modal"], topics: ["video"], lib: "SYSTRAN/faster-whisper" },
  { id: "tts", label: "Voice & narration", role: "engine", re: /elevenlabs|\bvoices?\b|\btts\b|text[- ]to[- ]speech|narrat|voiceover/, keys: ["ELEVENLABS_API_KEY"], recs: ["elevenlabs"], topics: ["voice"] },
  { id: "video", label: "Make/cut video", role: "engine", re: /\bvideos?\b|\bclips?\b|ffmpeg|hyperframes|remotion|shorts|\breels?\b|kling|runway|invideo|higgsfield|heygen|yt-dlp|9:16/, recs: ["fal", "runway", "heygen"], topics: ["video"], lib: "remotion-dev/remotion" },
  { id: "image-gen", label: "Generate images", role: "engine", re: /image gen|dall-?e|midjourney|codex-image|\bflux\b|replicate|\bfal\b|sprites?|illustrat|cloudinary/, keys: ["REPLICATE_API_KEY"], recs: ["fal", "replicate", "midjourney"] },
  { id: "music", label: "Generate music", role: "engine", re: /\bmusic\b|suno|udio|ace-step|soundtrack|songs?\b/, recs: ["suno", "udio"], topics: ["music"] },
  { id: "hd-calc", label: "Human Design chart math", role: "engine", re: /human design|bodygraph|hd-core|hd core|hdkit|\bhd\b.*(?:calc|chart)|incarnation cross/, gh: "human design bodygraph", topics: ["hd"] },
  { id: "astro-calc", label: "Ephemeris & astrology math", role: "engine", re: /ephemeris|swiss ?eph|astrolog|horoscope|natal|transits?\b|synastry/, topics: ["astro"], lib: "aloistr/swisseph" },
  { id: "divination", label: "Tarot / I Ching / esoteric content", role: "engine", re: /tarot|i[- ]ching|oracle|kabbal|numerolog|occult|esoteric|witchcraft|magick|gematria/, topics: ["esoteric"] },
  { id: "hd-content", label: "Human Design knowledge corpus", role: "data", re: /hd-atlas|hd-rag|atlas cards|human design (?:knowledge|corpus)|vikram|hd2027|2027 prophecy/, topics: ["hd", "rag"] },
  { id: "fb-archive", label: "Facebook group archive", role: "data", re: /facebook groups?|fb-group|humandesignisrael/, topics: ["community"] },
  { id: "telegram-intel", label: "Telegram community data", role: "data", re: /telegram community|tg-diaspora|public (?:telegram )?(?:groups|channels)/, topics: ["russian", "community"] },
  { id: "scraping", label: "Scrape/crawl the web", role: "data", re: /scrap|crawl|firecrawl|apify|playwright|puppeteer|crawl4ai|fetch-mcp|markdownify/, recs: ["apify", "firecrawl", "browserbase"], lib: "apify/crawlee" },
  { id: "osint", label: "OSINT & provenance", role: "engine", re: /osint|maigret|holehe|spiderfoot|ghunt|provenance|identity inventory/, topics: ["osint"] },
  { id: "search-api", label: "Web search API", role: "data", re: /brave search|serper|\bexa\b|perplexity|tavily|web search/, keys: ["BRAVE_SEARCH_API_KEY", "SERPER_API_KEY"], recs: ["exa", "perplexity"] },
  { id: "lead-data", label: "Lead & contact data", role: "data", re: /apollo|hunter|leads?\b|outbound|prospect/, keys: ["APOLLO_API_KEY", "HUNTER_API_KEY"], recs: ["apify"], topics: ["business"] },
  { id: "tenders", label: "Government tender data", role: "data", re: /tenders?\b|mr\.gov/, topics: ["business", "hebrew"] },
  { id: "telegram-bot", label: "Telegram bot", role: "channel", re: /telegram|bot token|stasclaw/, keys: ["TELEGRAM_BOT_TOKEN"], recs: ["telegram-bot"], lib: "grammyjs/grammY" },
  { id: "whatsapp", label: "WhatsApp messages", role: "channel", re: /whatsapp/, recs: ["twilio"] },
  { id: "discord", label: "Discord bot/community", role: "channel", re: /discord/, keys: ["DISCORD_BOT_TOKEN"] },
  { id: "social-post", label: "Post to social networks", role: "distribution", re: /\bx \(twitter\)|twitter|instagram|tiktok|linkedin|reddit|mastodon|youtube|pinterest|\bvk\b|threads|bluesky|typefully|buffer|hootsuite|tumblr|indie hackers/, recs: ["buffer", "typefully", "bluesky"] },
  { id: "analytics", label: "Analytics & funnels", role: "build", re: /posthog|plausible|analytics|funnel/, recs: ["posthog", "plausible"], lib: "PostHog/posthog-js" },
  { id: "booking", label: "Book calls", role: "monetization", re: /cal\.com|calendly|booking|google calendar/, recs: ["cal-com"] },
  { id: "maps-geo", label: "Maps & places", role: "engine", re: /\bmaps?\b|geocod|mapbox|makom|\bcities\b|globe|overpass|location/, keys: ["GOOGLE_MAPS_SERVER_KEY"], recs: ["overpass"], topics: ["geo"] },
  { id: "game", label: "Browser game engine", role: "engine", re: /phaser|godot|\bgames?\b|arcade|leaderboard/, recs: ["itch", "crazygames"], topics: ["games"], lib: "phaserjs/phaser" },
  { id: "3d", label: "3D / WebGL", role: "engine", re: /three\.?js|webgl|\b3d\b|gaussian|splat|blender/, topics: ["3d"], lib: "mrdoob/three.js" },
  { id: "agents", label: "Agent orchestration", role: "engine", re: /\bagents?\b|orchestr|herdr|\bmcp\b|claude code|codex|stasclaw|openclaw|paperclip/, topics: ["agents"] },
  { id: "mobile", label: "Phone app / PWA", role: "distribution", re: /\bpwa\b|android|mobile|app store|\bios\b|home screen/ },
  { id: "pdf-report", label: "PDF / document reports", role: "engine", re: /\bpdfs?\b|pandoc|\breports?\b|docx|nano-pdf/, lib: "puppeteer/puppeteer" },
  { id: "matching", label: "Compatibility & matching", role: "engine", re: /compatib|matching|\bmatch\b|dating|couples?|synastry|composite/, topics: ["matching"] },
  { id: "hebrew", label: "Hebrew / RTL", role: "audience", re: /hebrew|israel|\brtl\b|olim/, topics: ["hebrew"] },
  { id: "russian", label: "Russian-speaking", role: "audience", re: /russian|diaspora|\bvk\b/, topics: ["russian"] },
  { id: "community", label: "Community / membership", role: "channel", re: /communit|membership|patreon|\bgroups?\b/ },
  { id: "landing", label: "Landing page / site", role: "build", re: /landing|website builder|\bwix\b|carrd|astro (?:blog|site)|lovable|\bv0\b|portfolio/, recs: ["lovable", "v0"] },
  { id: "forecasting", label: "Forecasting & markets", role: "engine", re: /forecast|prediction market|polymarket|metaculus/, topics: ["forecasting"] },
  { id: "trading", label: "Trading tools", role: "engine", re: /trading|pine script|stocks?\b|crypto|backtest/, topics: ["trading"] },
];
export const CAP = Object.fromEntries(CAPS.map((c) => [c.id, c])) as Record<string, CapDef>;

/** Topic words for text that no capability names. */
const TOPIC_RE: [string, RegExp][] = [
  ["hd", /human design|bodygraph|\bhd\b/], ["astro", /astrolog|ephemeris|transit|horoscope|natal/], ["esoteric", /tarot|i ching|oracle|esoteric|occult|kabbal|numerolog/],
  ["video", /video|youtube|clip|podcast|shorts|reel|film/], ["voice", /voice|speech|narrat/], ["rag", /\brag\b|knowledge|corpus|search/],
  ["agents", /agent|claude|codex|mcp|herdr/], ["games", /\bgames?\b|phaser|godot|arcade/], ["osint", /osint|investigat|journalis/],
  ["hebrew", /hebrew|israel/], ["russian", /russian|diaspora|olim/], ["geo", /\bmaps?\b|city|cities|geo|globe/],
  ["business", /business|lead|tender|outbound|freelanc|agency|b2b|clients/], ["creators", /creator|youtuber|podcaster|influencer|channel/],
  ["community", /communit|group|admin|members/], ["matching", /couple|dating|compatib|relationship/], ["music", /music|song/],
  ["3d", /\b3d\b|three\.js|webgl/], ["trading", /trading|stock|crypto/], ["forecasting", /forecast|prediction/],
];
export function capsOf(text: string): string[] {
  const t = ` ${String(text ?? "").toLowerCase()} `;
  return CAPS.filter((c) => c.re.test(t)).map((c) => c.id);
}
export function topicsOf(text: string, caps: string[] = []): string[] {
  const t = String(text ?? "").toLowerCase();
  const out = new Set<string>();
  for (const [id, re] of TOPIC_RE) if (re.test(t)) out.add(id);
  for (const c of caps) for (const x of CAP[c]?.topics ?? []) out.add(x);
  return [...out];
}
export const rolesOf = (caps: string[]) => [...new Set(caps.map((c) => CAP[c]?.role).filter(Boolean))] as Role[];

// ── building the inventory ─────────────────────────────────────────────────────────────────
export type ConnItem = { id: string; name: string; state?: string; cat?: string; kind?: string; detail?: string; hidden?: boolean };
export type ConnSection = { id: string; items: ConnItem[] };
export type ProfileProject = { name: string; status: string; tags: string[]; tldr: string; weight: number };
export type GemRepo = { full: string; url: string; desc: string; stars: number; lang?: string; topics?: string[]; created?: string; pushed?: string };
export type RecLite = { id: string; name: string; url: string; free: string; what: string; cat: string };
export type InventoryInput = { sections?: ConnSection[]; projects?: ProfileProject[]; gems?: GemRepo[]; recs?: RecLite[]; now?: number };

const SECTION_KIND: Record<string, AssetKind> = { services: "service", accounts: "account", ai: "ai", mcp: "mcp", skills: "skill", projects: "project", keys: "key", recommended: "rec" };
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").replace(/(?:\/Users|\/home)\/[\w.-]+/g, "~").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const STATUS_W: Record<string, number> = { launched: 1, active: 0.85, prototype: 0.6, note: 0.3, "no-git": 0.3, stale: 0.2, legacy: 0.1, archived: 0.05, dead: 0 };
/** Project names that are forks/clones of someone else's work rather than the user's own product. */
const NOT_MINE = /zen-mcp-server|self-hosted-ai-starter-kit|claude-code-router|gods-eye-view|ace-step|deepseek|claudia|superclaude|agent-zero|claudecodeui|cline-mcp|n8n-/;
/** Personal art pieces and research harnesses: loved, but not product engines. */
const PERSONAL = /itay-howard|playa-between|the-apartment-behind|viktor-beyond-reality|context-maturity|emperor|the-signal|intent-compiler|cognitive-evolution/;

export function buildInventory(inp: InventoryInput): Inventory {
  const assets = new Map<string, Asset>();
  const add = (a: Asset) => { const prev = assets.get(a.id); if (!prev || (a.desc.length > prev.desc.length && prev.kind === a.kind)) assets.set(a.id, prev ? { ...prev, ...a, strength: Math.max(prev.strength, a.strength) } : a); };
  const keys: { name: string; where: string }[] = [];
  // Projects: wiki TLDRs carry the best descriptions; the connections scan adds folders the wiki doesn't have.
  const maxW = Math.max(1, ...(inp.projects ?? []).map((p) => p.weight));
  for (const p of inp.projects ?? []) {
    if (p.weight <= 0 || ["dead", "archived"].includes(p.status) || p.tags.includes("external")) continue;
    const text = `${p.name} ${p.tldr} ${p.tags.join(" ")}`;
    const caps = capsOf(text);
    const mine = !NOT_MINE.test(p.name);
    add({ id: `proj:${slug(p.name)}`, kind: "project", name: p.name, desc: clip(p.tldr, 220), caps, roles: rolesOf(caps), topics: topicsOf(text, caps), owned: true, ready: true,
      strength: Math.round(Math.min(1, (0.35 + 0.65 * p.weight / maxW) * (STATUS_W[p.status] ?? 0.5) * (mine ? 1 : 0.5) * (PERSONAL.test(p.name) ? 0.6 : 1) + 0.05) * 100) / 100 });
  }
  for (const s of inp.sections ?? []) {
    const kind = SECTION_KIND[s.id];
    if (!kind) continue;
    for (const i of s.items ?? []) {
      if (i.hidden) continue;
      if (kind === "key") { keys.push({ name: i.name, where: clip(i.detail, 80) }); continue; }
      const text = `${i.name} ${i.detail ?? ""}`;
      const caps = capsOf(text);
      const ready = !i.state || ["ready", "installed", "account"].includes(i.state);
      const owned = kind !== "rec";
      const id = kind === "project" ? `proj:${slug(i.name)}` : i.id;
      if (kind === "project" && assets.has(id)) continue;
      const base = kind === "project" ? 0.45 : kind === "service" || kind === "account" ? 0.4 : kind === "rec" ? 0.3 : 0.35;
      add({ id, kind, name: clip(i.name, 60), desc: clip(i.detail, 200), caps, roles: rolesOf(caps), topics: topicsOf(text, caps), owned, ready: owned && ready, strength: base });
    }
  }
  for (const r of inp.recs ?? []) {
    const id = `rec:${r.id}`;
    const text = `${r.name} ${r.what}`;
    const caps = capsOf(text);
    const prev = assets.get(id);
    assets.set(id, { id, kind: "rec", name: r.name, desc: clip(r.what, 160), caps, roles: rolesOf(caps), topics: topicsOf(text, caps), owned: false, ready: false, strength: 0.3, url: r.url, ...(prev ? { owned: prev.owned } : {}) });
  }
  // Gems: free engines someone else wrote. Strong when they're popular and fast-growing.
  const now = inp.now ?? Date.now();
  for (const g of inp.gems ?? []) {
    const text = `${g.full} ${g.desc} ${(g.topics ?? []).join(" ")}`;
    const caps = capsOf(text);
    const months = g.created ? Math.max(1, (now - Date.parse(g.created)) / (30 * 86_400_000)) : 24;
    const spm = g.stars / months;
    add({ id: `repo:${g.full}`, kind: "repo", name: g.full, desc: clip(g.desc, 180), caps, roles: rolesOf(caps).length ? rolesOf(caps) : ["engine"], topics: topicsOf(text, caps), owned: false, ready: true,
      strength: Math.round(Math.min(1, 0.2 + Math.log10(1 + g.stars) / 6 + Math.log10(1 + spm) / 8) * 100) / 100, url: g.url, stars: g.stars });
  }
  // A capability only a couple of owned things have is an edge: those assets get stronger.
  const owners = new Map<string, number>();
  for (const a of assets.values()) if (a.owned) for (const c of a.caps) owners.set(c, (owners.get(c) ?? 0) + 1);
  for (const a of assets.values()) if (a.owned && a.kind === "project") {
    const rare = a.caps.filter((c) => (owners.get(c) ?? 0) <= 3).length;
    a.strength = Math.round(Math.min(1, a.strength + 0.06 * rare) * 100) / 100;
  }
  const list = [...assets.values()];
  return { at: now, assets: list, audiences: AUDIENCES.map((au) => ({ ...au, reach: au.reach.filter((id) => list.some((a) => a.id === id && a.owned)) })), keys };
}

// ── audiences the user can reach ─────────────────────────────────────────────────────────────
/** Curated from the wiki: who each of the user's projects, groups and accounts actually reaches. */
export const AUDIENCES: Audience[] = [
  { id: "hd-hebrew", label: "Hebrew Human Design community", who: "Hebrew-speaking Human Design fans in Israel", topics: ["hd", "hebrew", "community"],
    reach: ["acct:facebook", "proj:fb-group-scraper", "svc:whatsapp", "proj:hd-atlas"], places: ["Facebook group HumandesignIsrael", "Israeli HD WhatsApp groups", "Instagram HD accounts in Hebrew"], access: 0.7,
    query: "human design israel hebrew", jobs: ["understand my chart in plain Hebrew", "decide by my strategy & authority day to day", "check compatibility with a partner", "find a trustworthy reader"], caps: ["hd-calc", "hd-content", "rag", "matching", "telegram-bot", "whatsapp", "pdf-report", "fb-archive"] },
  { id: "hd-global", label: "Human Design enthusiasts", who: "English-speaking people exploring their Human Design chart", topics: ["hd", "community"],
    reach: ["acct:reddit", "svc:youtube-data-api", "proj:astra-apple", "svc:x-twitter", "acct:instagram", "proj:hd-atlas"], places: ["r/humandesign", "HD YouTube audiences (Vikram / 2027 Prophecy funnel)", "Instagram #humandesign"], access: 0.5,
    query: "human design chart", jobs: ["make sense of my chart without a $300 reading", "apply my type to work and relationships", "track transits for me today", "learn the system step by step"], caps: ["hd-calc", "hd-content", "rag", "astro-calc", "pdf-report", "3d", "tts", "video"] },
  { id: "hd-pros", label: "Human Design readers & coaches", who: "Human Design readers, coaches and analysts who sell readings", topics: ["hd", "business"],
    reach: ["acct:facebook", "acct:instagram", "proj:hd-atlas", "proj:bodygraph-3d"], places: ["r/humandesign", "HD professional Facebook groups", "Instagram HD coaches"], access: 0.4,
    query: "human design reading clients", jobs: ["prepare readings faster", "deliver beautiful branded reports", "get and keep clients", "explain charts visually"], caps: ["hd-calc", "hd-content", "rag", "pdf-report", "3d", "booking", "landing"] },
  { id: "astro-tarot", label: "Solo tarot readers & astrologers", who: "tarot readers and astrologers who work alone", topics: ["esoteric", "astro", "business"],
    reach: ["acct:instagram", "acct:tiktok", "proj:esoteric-rag"], places: ["r/tarot", "r/astrology", "Etsy reading shops", "TikTok #tarottok"], access: 0.3,
    query: "tarot readers who work alone", jobs: ["book and deliver readings", "create daily content", "look up meanings fast", "get paid without chasing"], caps: ["divination", "astro-calc", "rag", "booking", "pdf-report", "video"] },
  { id: "creators", label: "Podcasters & YouTubers", who: "podcasters and YouTubers who want clips, subtitles and searchable archives", topics: ["video", "creators"],
    reach: ["proj:yt-transcriber", "svc:youtube-data-api", "acct:tiktok"], places: ["r/podcasting", "r/NewTubers", "r/youtubers", "Indie Hackers"], access: 0.35,
    query: "podcasters clips", jobs: ["turn long episodes into shorts", "subtitle in other languages", "let fans search everything I said", "grow on shorts platforms"], caps: ["transcription", "video", "rag", "tts", "image-gen"] },
  { id: "devs-agents", label: "Agent-heavy developers", who: "developers running many AI coding agents (Claude Code, Codex) at once", topics: ["agents", "devtools"],
    reach: ["svc:github", "svc:x-twitter", "acct:indie-hackers", "proj:herdr-deck", "acct:reddit"], places: ["r/ClaudeAI", "r/ChatGPTCoding", "Hacker News", "X #buildinpublic", "herdr users"], access: 0.55,
    query: "claude code agents", jobs: ["see what every agent is doing", "stop agents from stalling unnoticed", "reuse prompts and skills", "ship more with less babysitting"], caps: ["agents", "llm", "mobile", "analytics"] },
  { id: "ru-israel", label: "Russian-speaking Israelis", who: "Russian-speaking immigrants in Israel active on Telegram", topics: ["russian", "hebrew", "community"],
    reach: ["svc:telegram", "acct:vk", "proj:tg-diaspora-cli", "acct:facebook"], places: ["Telegram channels for olim", "Russian-Israeli Facebook groups"], access: 0.5,
    query: "olim israel bureaucracy", jobs: ["deal with Israeli bureaucracy in Russian", "find services and jobs", "learn Hebrew for real life", "stay on top of local news"], caps: ["telegram-bot", "telegram-intel", "llm", "russian", "tts"] },
  { id: "il-smb", label: "Israeli small businesses", who: "Israeli small business owners and freelancers", topics: ["business", "hebrew"],
    reach: ["acct:facebook", "svc:whatsapp", "proj:gov-tender-sniper", "proj:bizgen", "acct:linkedin"], places: ["Israeli business Facebook groups", "LinkedIn Israel", "WhatsApp business groups"], access: 0.4,
    query: "small business owners manual work", jobs: ["win more work (tenders, leads)", "stop doing admin by hand", "answer customers on WhatsApp", "get found online"], caps: ["tenders", "lead-data", "llm", "whatsapp", "scraping", "landing", "maps-geo"] },
  { id: "fb-admins", label: "Facebook group admins", who: "admins of large Facebook groups and online communities", topics: ["community"],
    reach: ["proj:fb-group-scraper", "acct:facebook"], places: ["Facebook admin groups", "r/Facebook", "r/communitymanagement"], access: 0.35,
    query: "facebook group admin", jobs: ["find the best past posts", "answer repeat questions", "keep members engaged", "back up the group"], caps: ["fb-archive", "rag", "scraping", "community"] },
  { id: "gamers", label: "Casual mobile gamers (HE/RU)", who: "Hebrew- and Russian-speaking casual mobile players", topics: ["games", "hebrew", "russian"],
    reach: ["proj:falafel-rush", "proj:viktor-game", "acct:tiktok", "svc:telegram"], places: ["TikTok", "Telegram chats", "CrazyGames", "itch.io"], access: 0.4,
    query: "browser game players", jobs: ["kill 2 minutes with something funny", "beat friends on a leaderboard", "share a laugh in chats"], caps: ["game", "3d"] },
  { id: "osint", label: "OSINT researchers & citizen journalists", who: "citizen journalists and OSINT researchers", topics: ["osint"],
    reach: ["proj:llm-osint", "svc:github", "svc:x-twitter"], places: ["r/OSINT", "OSINT X community", "Bellingcat Discord"], access: 0.25,
    query: "citizen journalists who hate subscriptions", jobs: ["verify claims fast", "track sources over time", "audit my own exposure", "keep evidence with provenance"], caps: ["osint", "scraping", "search-api", "forecasting", "maps-geo"] },
  { id: "couples", label: "Couples & daters", who: "couples and daters curious about their compatibility", topics: ["matching", "hd", "hebrew"],
    reach: ["proj:zdainu", "acct:instagram", "acct:tiktok"], places: ["r/relationships", "Instagram couples accounts", "Hebrew dating groups"], access: 0.3,
    query: "couples compatibility quiz", jobs: ["understand our friction", "have a fun date-night activity", "check a new match before investing"], caps: ["matching", "hd-calc", "astro-calc"] },
  { id: "indie-hackers", label: "Indie hackers", who: "indie hackers and solo founders looking for their first customers", topics: ["business", "devtools"],
    reach: ["acct:indie-hackers", "svc:x-twitter", "proj:bizgen", "proj:lead-pipeline", "acct:reddit"], places: ["Indie Hackers", "r/SideProject", "r/indiehackers", "X #buildinpublic"], access: 0.45,
    query: "first customers side project", jobs: ["find people who'd pay", "validate before building", "write outreach that works", "launch without an audience"], caps: ["lead-data", "scraping", "landing", "search-api", "llm"] },
];

/** A short text summary of the inventory a model can read: strongest owned assets by kind, plus audiences. */
export function inventoryDigest(inv: Inventory, max = 40): string {
  const owned = inv.assets.filter((a) => a.owned && a.ready && a.kind !== "key");
  const by = (k: AssetKind) => owned.filter((a) => a.kind === k).sort((a, b) => b.strength - a.strength);
  const line = (a: Asset) => `- ${a.name}${a.desc ? `: ${clip(a.desc, 110)}` : ""}`;
  return [
    "Your projects (strongest first):", ...by("project").slice(0, Math.ceil(max / 2)).map(line),
    "Services & accounts you have:", by("service").concat(by("account")).filter((a) => a.caps.length).slice(0, 26).map((a) => a.name).join(", "),
    "Agent tools, MCP servers & skills:", by("ai").concat(by("mcp"), by("skill")).slice(0, 30).map((a) => a.name).join(", "),
  ].join("\n");
}
