// Founder Library: which sources to learn from (~/.config/herdr-deck/library/channels.json, yours to edit) and what
// kind of thing a pasted link is. The list starts with builder channels that were checked by hand on 2026-09-26:
// each handle resolved to the right creator and its uploads are about building and selling. Rejected on that check:
// @IndieHackers (an unrelated channel; Indie Hackers has no official channel), @nkagan (someone else; Noah Kagan is
// @noahkagan) and @patwalls (no such channel; Pat Walls hosts Starter Story).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type SourceKind = "channel" | "playlist" | "videos";
export type LibSource = {
  id: string; // short stable key (the handle for channels)
  kind: SourceKind;
  url: string; // channel or playlist URL; for "videos" the list is in `videos`
  videos?: string[];
  title?: string;
  enabled: boolean;
  /** Ingest at most this many videos, best first (most viewed and most recent). Omit for all. */
  limit?: number;
  /** Only titles matching this (case-insensitive regex), e.g. to take only offers and pricing from a big channel. */
  include?: string;
  exclude?: string;
  shorts?: boolean;
  note?: string;
  addedAt?: number;
};
export type LibConfig = {
  version: 1;
  sources: LibSource[];
  /** Background ingestion: on or paused. Whisper is for videos without captions (minutes each, so off by default). */
  ingest: { running: boolean; whisper: boolean; pauseMs: number };
  /** Founder cards: local Ollama model for bulk extraction. */
  extract: { running: boolean; model: string };
  /** Where the library is used as context: Studio chats, the ideas feed, research agents (pre-mortems, autoresearch). */
  use: { studio: boolean; ideas: boolean; research: boolean };
};

const ch = (id: string, note: string, extra: Partial<LibSource> = {}): LibSource => ({ id, kind: "channel", url: `https://www.youtube.com/@${id}`, enabled: true, note, ...extra });
export const DEFAULT_SOURCES: LibSource[] = [
  ch("starterstory", "Founder interviews with revenue, first customers and stack. The core of the library."),
  ch("starterstorybuild", "Starter Story's build-in-public channel: small apps from idea to first revenue."),
  ch("marc-lou", "Solo maker with many small SaaS products; launches, pricing and distribution in public."),
  ch("GregIsenberg", "Startup ideas and distribution; many AI tool explainers, so only the best 150.", { limit: 150 }),
  ch("MyFirstMillionPod", "Business ideas and how real companies make money. Long episodes; the best 200.", { limit: 200 }),
  ch("CodieSanchezCT", "Boring businesses that print money: buying and running small companies.", { limit: 120 }),
  ch("noahkagan", "AppSumo founder: validating ideas, first customers, marketing.", { limit: 150 }),
  ch("ycombinator", "Startup School and founder talks. Only titles about starting, customers, pricing and growth.", {
    limit: 150, include: "startup|founder|customer|user|pricing|price|sales|sell|growth|launch|idea|product|market|revenue|mvp|advice|how to",
    exclude: "elon|game recommendations",
  }),
  ch("TheBootstrappedFounder", "Arvid Kahl: bootstrapping, audience building, founder interviews.", { limit: 100 }),
  ch("MicroConf", "Bootstrapped SaaS talks: pricing, marketing and churn."),
  ch("AlexHormozi", "Offers and pricing only (a title filter keeps the rest out).", { limit: 80, include: "offer|pric|lead|sales|sell|customer|client|ads|marketing" }),
  { id: "levels-interviews", kind: "videos", url: "", title: "Pieter Levels interviews", enabled: true, note: "Long interviews: Lex Fridman, My First Million, Stripe's Cheeky Pint, Arvid Kahl.",
    videos: ["oFtjKbXKqbg", "V0ej29G7ZGg", "StkCdcZ1ovE", "9Wjec3wh4p8"] },
  ch("levelsio", "Pieter Levels' own uploads: older talks on building without funding.", { enabled: false }),
];
export const defaultConfig = (): LibConfig => ({ version: 1, sources: DEFAULT_SOURCES.map((s) => ({ ...s })), ingest: { running: false, whisper: false, pauseMs: 1500 }, extract: { running: true, model: "gemma4:e4b" }, use: { studio: true, ideas: true, research: true } });

// ── what a pasted link is ─────────────────────────────────────────────────────
export type Parsed =
  | { type: "channel"; url: string; id: string }
  | { type: "playlist"; url: string; id: string }
  | { type: "video"; url: string; id: string }
  | { type: "web"; url: string }
  | { type: "invalid"; error: string };

const VIDEO_ID = /^[\w-]{11}$/;
/** A YouTube channel, playlist or video, or any other web page. Handles bare @handles and youtu.be links. */
export function parseSource(input: unknown): Parsed {
  const s = String(input ?? "").trim();
  if (!s) return { type: "invalid", error: "Paste a YouTube channel, playlist or video link, or a web page." };
  if (/^@[\w.-]{2,}$/.test(s)) return { type: "channel", url: `https://www.youtube.com/${s}`, id: s.slice(1) };
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return { type: "invalid", error: "That isn't a link." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { type: "invalid", error: "Only http and https links." };
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.slice(1, 12);
    return VIDEO_ID.test(id) ? { type: "video", url: `https://www.youtube.com/watch?v=${id}`, id } : { type: "invalid", error: "That YouTube link has no video id." };
  }
  if (host === "youtube.com") {
    const list = u.searchParams.get("list");
    const v = u.searchParams.get("v");
    if (u.pathname === "/watch" && v && VIDEO_ID.test(v)) return { type: "video", url: `https://www.youtube.com/watch?v=${v}`, id: v };
    const short = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
    if (short) return { type: "video", url: `https://www.youtube.com/watch?v=${short[1]}`, id: short[1] };
    if (list && /^[\w-]{10,}$/.test(list)) return { type: "playlist", url: `https://www.youtube.com/playlist?list=${list}`, id: list };
    const m = u.pathname.match(/^\/(@[\w.-]+|channel\/UC[\w-]{20,}|c\/[\w.-]+|user\/[\w.-]+)/);
    if (m) return { type: "channel", url: `https://www.youtube.com/${m[1]}`, id: m[1].replace(/^@|^channel\/|^c\/|^user\//, "") };
    return { type: "invalid", error: "That YouTube link isn't a channel, playlist or video." };
  }
  // Private and local addresses are never fetched.
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|0\.)/.test(u.hostname) || u.hostname.endsWith(".local") || u.hostname.endsWith(".ts.net")) {
    return { type: "invalid", error: "Only public web pages can be added." };
  }
  u.hash = "";
  return { type: "web", url: u.toString() };
}

// ── the file ───────────────────────────────────────────────────────────────────
function clean(x: any): LibSource | undefined {
  if (!x || typeof x !== "object") return undefined;
  const id = String(x.id ?? "").trim().replace(/[^\w.-]/g, "-").slice(0, 60);
  const kind: SourceKind = x.kind === "playlist" || x.kind === "videos" ? x.kind : "channel";
  if (!id) return undefined;
  const s: LibSource = { id, kind, url: String(x.url ?? ""), enabled: x.enabled !== false };
  if (Array.isArray(x.videos)) s.videos = x.videos.map(String).filter((v: string) => VIDEO_ID.test(v)).slice(0, 500);
  for (const k of ["title", "include", "exclude", "note"] as const) if (typeof x[k] === "string" && x[k]) s[k] = x[k].slice(0, 400);
  if (Number.isFinite(x.limit) && x.limit > 0) s.limit = Math.floor(x.limit);
  if (x.shorts === true) s.shorts = true;
  if (Number.isFinite(x.addedAt)) s.addedAt = x.addedAt;
  for (const k of ["include", "exclude"] as const) if (s[k]) { try { new RegExp(s[k]!, "i"); } catch { delete s[k]; } }
  return s;
}
/** Reads channels.json; a missing or broken file gives the defaults (a broken one is kept aside, not overwritten). */
export function loadConfig(file: string): LibConfig {
  if (!existsSync(file)) return defaultConfig();
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch {
    try { renameSync(file, `${file}.broken-${Date.now()}`); } catch {}
    return defaultConfig();
  }
  const d = defaultConfig();
  const seen = new Set<string>();
  const sources = (Array.isArray(raw?.sources) ? raw.sources : []).map(clean).filter((s: LibSource | undefined): s is LibSource => !!s && !seen.has(s.id) && !!seen.add(s.id));
  return {
    version: 1, sources,
    ingest: { running: raw?.ingest?.running === true, whisper: raw?.ingest?.whisper === true, pauseMs: Number.isFinite(raw?.ingest?.pauseMs) ? Math.max(0, raw.ingest.pauseMs) : d.ingest.pauseMs },
    extract: { running: raw?.extract?.running !== false, model: typeof raw?.extract?.model === "string" && raw.extract.model ? raw.extract.model : d.extract.model },
    use: { studio: raw?.use?.studio !== false, ideas: raw?.use?.ideas !== false, research: raw?.use?.research !== false },
  };
}
export function saveConfig(file: string, c: LibConfig) {
  mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Add a pasted YouTube link as a source (at the front of the queue), or say why not. */
export function addSource(c: LibConfig, p: Parsed, now = Date.now()): { config: LibConfig; source?: LibSource; error?: string } {
  if (p.type === "invalid") return { config: c, error: p.error };
  if (p.type === "web") return { config: c, error: "Web pages go to the page fetcher, not the channel list." };
  const exists = (id: string) => c.sources.find((s) => s.id.toLowerCase() === id.toLowerCase());
  if (p.type === "video") {
    // Single videos you paste gather in one "Added videos" source.
    const cur = exists("added-videos");
    const src: LibSource = cur ? { ...cur, videos: [...new Set([p.id, ...(cur.videos ?? [])])], enabled: true } : { id: "added-videos", kind: "videos", url: "", title: "Videos you added", enabled: true, videos: [p.id], addedAt: now };
    return { config: { ...c, sources: [src, ...c.sources.filter((s) => s.id !== "added-videos")] }, source: src };
  }
  const id = p.id.replace(/[^\w.-]/g, "-").slice(0, 60);
  const cur = exists(id);
  if (cur) return { config: { ...c, sources: c.sources.map((s) => (s === cur ? { ...s, enabled: true } : s)) }, source: { ...cur, enabled: true } };
  const src: LibSource = { id, kind: p.type, url: p.url, enabled: true, addedAt: now };
  return { config: { ...c, sources: [src, ...c.sources] }, source: src };
}
export function setEnabled(c: LibConfig, id: string, on: boolean): LibConfig {
  return { ...c, sources: c.sources.map((s) => (s.id === id ? { ...s, enabled: on } : s)) };
}
export function removeSource(c: LibConfig, id: string): LibConfig {
  return { ...c, sources: c.sources.filter((s) => s.id !== id) };
}
