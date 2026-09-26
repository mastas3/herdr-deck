// Trend signals: what is hot right now, and what is just starting to take off. All sources are open and keyless,
// fetched once a day with timeouts, and fail softly (a source that errors just contributes nothing):
//   Hacker News front page + Show/Launch HN of the last 14 days (Algolia), GitHub repos created in the last 60 days
//   by stars and star velocity (gh, within Discover's search budget), Product Hunt's public Atom feed, Reddit's
//   top-of-week RSS for startup/AI subreddits and the user's niches (one read per ~16 s), Polymarket's most-traded
//   tech markets, and research/leads reports other deck agents wrote to ~/.config/herdr-deck/{research,leads}/.
// Signals are clustered into trends by shared distinctive words; each trend gets "heat" (velocity × breadth across
// sources × recency) and "earliness" (fast growth from a small base, few signals yet, mostly new).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { decode, htmlText, UA, type FetchLike } from "../leads";
import { gh as ghDefault, type GhRes } from "../discover";
import { topicsOf } from "./inventory";

const HOME = homedir();
const DAY = 86_400_000;
type TrendSource = "hn" | "showhn" | "github" | "producthunt" | "reddit" | "polymarket" | "report";
export type TrendSignal = {
  id: string; source: TrendSource; title: string; url: string; at: number; text: string;
  /** Raw popularity (points, stars, 24h volume) and per-day velocity; rank = 0..1 within its source. */
  metric: number; velocity: number; rank: number; where?: string;
};
export type Trend = {
  id: string; label: string; terms: string[]; signals: TrendSignal[]; sources: TrendSource[];
  heat: number; earliness: number; newest: number; topics: string[];
};
export type TrendSet = { at: number; day: string; signals: TrendSignal[]; trends: Trend[]; status: Record<string, { ok: boolean; n: number; ms: number; error?: string }> };

const REDDIT_SUBS = ["SideProject", "startups", "Entrepreneur", "SaaS", "indiehackers", "artificial", "LocalLLaMA", "humandesign", "ClaudeAI", "podcasting"];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);

async function get(f: FetchLike, url: string, ms: number): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await f(url, { headers: { "user-agent": UA, accept: "application/json, application/atom+xml, application/rss+xml;q=0.9, */*;q=0.5" }, signal: ctl.signal });
    return { ok: r.ok, status: r.status, body: await r.text() };
  } catch (e: any) { return { ok: false, status: 0, body: "", error: ctl.signal.aborted ? "timeout" : String(e?.message ?? e) }; }
  finally { clearTimeout(t); }
}
const json = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
const ageDays = (at: number, now: number) => Math.max(0.5, (now - at) / DAY);

// ── parsers (pure, tested) ─────────────────────────────────────────────────────────────────────
export function parseHNHits(j: any, source: "hn" | "showhn", now: number): TrendSignal[] {
  return (j?.hits ?? []).filter((h: any) => h?.title).map((h: any) => {
    const at = (h.created_at_i ?? 0) * 1000 || now;
    const pts = Number(h.points ?? 0);
    return { id: `${source}:${h.objectID}`, source, title: String(h.title), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, at, text: htmlText(h.story_text ?? "").slice(0, 300), metric: pts, velocity: pts / ageDays(at, now), rank: 0, where: `https://news.ycombinator.com/item?id=${h.objectID}` };
  });
}
function parseGitHubRepos(j: any, now: number): TrendSignal[] {
  return (j?.items ?? []).filter((r: any) => !r.fork && !r.archived).map((r: any) => {
    const at = Date.parse(r.created_at) || now;
    const stars = Number(r.stargazers_count ?? 0);
    return { id: `gh:${r.full_name}`, source: "github" as const, title: `${r.full_name}: ${r.description ?? ""}`.slice(0, 200), url: r.html_url, at, text: [r.description, ...(r.topics ?? [])].filter(Boolean).join(" ").slice(0, 300), metric: stars, velocity: stars / ageDays(at, now), rank: 0 };
  });
}
/** Atom (Product Hunt, Reddit): entries with title, link, published/updated and content. */
export function parseAtom(xml: string, source: "producthunt" | "reddit", now: number, where?: string): TrendSignal[] {
  const out: TrendSignal[] = [];
  const entries = String(xml ?? "").split(/<entry[\s>]/).slice(1);
  entries.forEach((e, i) => {
    const title = decode((e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")).trim();
    const url = e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? "";
    const at = Date.parse(e.match(/<published>([^<]+)<\/published>/)?.[1] ?? e.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? "") || now;
    const text = clip(htmlText(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "").replace(/\bDiscussion\b\s*\|\s*\bLink\b/g, "").replace(/submitted by[\s\S]*$/, ""), 300);
    if (!title || !url) return;
    // Feeds are ordered by popularity: position is the metric (first = 1.0).
    const metric = 1 - i / Math.max(1, entries.length);
    // Product Hunt titles are bare names ("Wand"): the tagline is what says what it is.
    const full = source === "producthunt" && text ? `${title} — ${text}` : title;
    out.push({ id: `${source}:${url.replace(/^https?:\/\/(www\.)?/, "").replace(/\?.*$/, "")}`, source, title: clip(full, 180), url, at, text, metric, velocity: metric / ageDays(at, now), rank: 0, where });
  });
  return out;
}
const TECH_MARKET = /\b(ai|openai|gpt|anthropic|claude|gemini|llm|apple|google|meta|microsoft|nvidia|tesla|spacex|app store|iphone|launch|release|model|chip|bitcoin|crypto|startup|ipo|tiktok|x\.com|twitter)\b/i;
function parsePolymarket(j: any, now: number): TrendSignal[] {
  return (Array.isArray(j) ? j : []).filter((m: any) => m?.question && TECH_MARKET.test(m.question)).map((m: any) => {
    const vol = Number(m.volume24hr ?? m.volume ?? 0);
    const at = Date.parse(m.startDate ?? "") || now;
    return { id: `pm:${m.slug ?? m.id}`, source: "polymarket" as const, title: String(m.question).slice(0, 180), url: `https://polymarket.com/event/${m.slug ?? ""}`, at, text: String(m.description ?? "").slice(0, 200), metric: vol, velocity: vol, rank: 0 };
  });
}
/** Reports other agents wrote (autoresearch, leads deep dives): their headings and bold lines as signals. */
function parseReport(md: string, file: string, at: number): TrendSignal[] {
  const title = md.match(/^#\s+(.+)$/m)?.[1] ?? file.replace(/\.md$/, "");
  const lines = md.split("\n").filter((l) => /^#{2,3}\s+|^\s*[-*]\s+\*\*/.test(l)).slice(0, 12).map((l) => l.replace(/^#+\s*|^\s*[-*]\s+|\*\*/g, "").trim());
  return [{ id: `report:${file}`, source: "report", title: clip(title, 180), url: `file://${file}`, at, text: clip(lines.join("; "), 300), metric: 1, velocity: 1 / ageDays(at, Date.now()), rank: 0 }];
}
/** Rank 0..1 within each source by velocity, so points, stars and feed positions become comparable. */
export function rankWithinSource(xs: TrendSignal[]): TrendSignal[] {
  const by = new Map<string, TrendSignal[]>();
  for (const x of xs) by.set(x.source, [...(by.get(x.source) ?? []), x]);
  for (const list of by.values()) { list.sort((a, b) => b.velocity - a.velocity); list.forEach((x, i) => (x.rank = list.length === 1 ? 0.5 : 1 - i / (list.length - 1))); }
  return xs;
}

// ── clustering into trends ──────────────────────────────────────────────────────────────────────
const COMMON = new Set(("a about above after again against all almost also always am an and any are aren't around as at away back be because been before being below between both but by can can't cannot could did didn't do does doesn't doing don't done down during each either else enough even ever every few for from further get gets getting go goes going gone got had has hasn't have haven't having he her here hers him his how i i'm i've if in into is isn't it it's its itself just keep know last less let like likely little made make makes making many may me might mine more most much must my myself need needs never new next no nor not now of off often on once one only or other our ours out over own part per put quite rather really same see seen she should since so some something still such take than that the their them then there these they thing things think this those though through to too two under until up upon us use used using very via want wants was way ways we well went were what when where whether which while who whom whose why will with within without would yet you your yours " +
  "show hn ask launch launched launching built build building builder make made makes create created tool tools app apps application open source free new first ever best better good great cool simple easy fast faster help helps way week weekly month year years day days today yesterday tomorrow time times version release released update updates introducing announcing announced based feature features lets let's project projects product products startup startups founder founders company companies business businesses customer customers user users people team work working works real single turn turns wanted share shared because thread post posts reddit comment comments promote promotion will i'm feedback friday anyone someone everyone thing stuff lot lots question questions answer idea ideas thought thoughts guy guys hey hi help advice tips experience experiences story stories lesson lessons learned small big huge tiny finally actually really literally honestly just yet still").split(/\s+/));
/** Title words worth grouping by: not common words, not numbers; model names like "qwen3" and acronyms stay. */
function trendTerms(title: string, text = ""): string[] {
  const words = `${title} ${text.slice(0, 160)}`.replace(/[’']/g, "").split(/[^A-Za-z0-9+.#-]+/).map((w) => w.replace(/^[.#-]+|[.#-]+$/g, "")).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw.length < 3 || COMMON.has(lw) || /^\d+(\.\d+)?[kmb]?$/.test(lw)) continue;
    out.push(lw.replace(/(?<=[a-z]{4})s$/, ""));
  }
  // Adjacent pairs name things better than single words ("voice agent", "coding harness").
  const pairs: string[] = [];
  for (let i = 0; i + 1 < out.length; i++) pairs.push(`${out[i]} ${out[i + 1]}`);
  return [...new Set([...out, ...pairs])];
}
/**
 * Group signals into trends: a trend is a distinctive word or pair shared by signals from at least two sources, or by
 * three signals of one source. Heat = Σ (0.3 + rank) × breadth bonus × recency; earliness = young × fast × small base.
 * A single signal that is at the very top of a fast source (≥0.93 rank on Show HN, GitHub or Product Hunt) is a trend
 * of its own ("hot item").
 */
export function clusterTrends(signals: TrendSignal[], now: number, max = 36): Trend[] {
  const docs = signals.map((s) => ({ s, t: new Set(trendTerms(s.title, s.source === "github" ? s.text : "")) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.t) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length || 1;
  const cands = [...df].filter(([w, n]) => n >= 2 && n <= Math.max(4, N * 0.05) && (w.includes(" ") || w.length >= 4)).map(([w]) => w);
  const trends: Trend[] = [];
  const used = new Set<string>();
  const make = (words: string[], members: TrendSignal[]): Trend => {
    const sources = [...new Set(members.map((m) => m.source))];
    const newest = Math.max(...members.map((m) => m.at));
    const recency = Math.max(0.25, 0.5 ** (ageDays(newest, now) / 10));
    const heat = members.reduce((a, m) => a + 0.3 + m.rank, 0) * (1 + 0.6 * (sources.length - 1)) * recency;
    const young = members.filter((m) => ageDays(m.at, now) <= 30).length / members.length;
    const fast = members.reduce((a, m) => a + m.rank, 0) / members.length;
    const base = members.filter((m) => m.source === "github" || m.source === "hn" || m.source === "showhn").reduce((a, m) => a + m.metric, 0);
    const small = (1 / (1 + Math.log10(1 + base / 800))) * (members.length <= 4 ? 1 : 0.75);
    return { id: words.join("-").replace(/[^a-z0-9-]+/g, "-"), label: words.join(" · "), terms: words, signals: [...members].sort((a, b) => b.rank - a.rank).slice(0, 8), sources, heat: Math.round(heat * 100) / 100, earliness: Math.round(young * fast * small * 1000) / 1000, newest, topics: topicsOf(members.map((m) => `${m.title} ${m.text}`).join(" ")) };
  };
  const scored = cands.map((w) => {
    const members = docs.filter((d) => d.t.has(w)).map((d) => d.s);
    const sources = new Set(members.map((m) => m.source));
    return { w, members, sources, score: members.reduce((a, m) => a + 0.3 + m.rank, 0) * (1 + 0.6 * (sources.size - 1)) * (w.includes(" ") ? 1.3 : 1) };
  }).filter((c) => c.sources.size >= 2 || c.members.length >= 3).sort((a, b) => b.score - a.score);
  const termsOf = new Map(docs.map((d) => [d.s.id, d.t]));
  for (const c of scored) {
    if (trends.length >= max) break;
    let fresh = c.members.filter((m) => !used.has(m.id));
    if (fresh.length < 2 || trends.some((t) => t.terms.some((x) => x.includes(c.w) || c.w.includes(x)))) continue;
    // Cohesion: members must share something beyond the key word itself, or it's a coincidence ("support", "mean").
    const shareMore = (a: TrendSignal) => fresh.some((b) => b !== a && [...termsOf.get(a.id)!].filter((w) => w !== c.w && !w.includes(" ") && termsOf.get(b.id)!.has(w)).length >= 1);
    if (!c.w.includes(" ")) fresh = fresh.filter(shareMore);
    if (fresh.length < 2) continue;
    for (const m of fresh) used.add(m.id);
    trends.push(make([c.w], fresh));
  }
  for (const s of signals.filter((x) => !used.has(x.id) && x.rank >= 0.93 && ["showhn", "github", "producthunt", "hn"].includes(x.source))) {
    if (trends.length >= max + 12) break;
    const label = s.source === "github" ? s.title.split(":")[0] : s.title.replace(/^(Show|Launch) HN:\s*/i, "").split(/[–—:-]\s/)[0];
    trends.push(make([label.toLowerCase().slice(0, 60)], [s]));
    used.add(s.id);
  }
  return trends.sort((a, b) => b.heat - a.heat);
}

// ── fetching everything (once a day) ─────────────────────────────────────────────────────────────
type TrendOpts = { fetch?: FetchLike; gh?: (args: string[], timeoutMs?: number) => Promise<GhRes>; now?: number; timeout?: number; redditGapMs?: number; subs?: string[]; log?: (s: string) => void; reportsDirs?: string[] };
export async function gatherTrends(o: TrendOpts = {}): Promise<TrendSet> {
  const f: FetchLike = o.fetch ?? ((u, i) => fetch(u, i as any) as any);
  const ghRun = o.gh ?? ghDefault;
  const now = o.now ?? Date.now();
  const T = o.timeout ?? 9000;
  const status: TrendSet["status"] = {};
  const signals: TrendSignal[] = [];
  const run = async (name: string, fn: () => Promise<TrendSignal[]>) => {
    const t0 = Date.now();
    try { const xs = await fn(); signals.push(...xs); status[name] = { ok: true, n: xs.length, ms: Date.now() - t0 }; }
    catch (e: any) { status[name] = { ok: false, n: 0, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 160) }; }
    o.log?.(`${name}: ${status[name].ok ? `${status[name].n} signals` : status[name].error} (${status[name].ms} ms)`);
  };
  const since14 = Math.floor((now - 14 * DAY) / 1000);
  const iso = (d: number) => new Date(now - d * DAY).toISOString().slice(0, 10);
  await Promise.all([
    run("hn-front", async () => { const r = await get(f, "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60", T); if (!r.ok) throw new Error(r.error ?? `HN ${r.status}`); return parseHNHits(json(r.body), "hn", now); }),
    run("show-hn", async () => {
      const [a, b] = await Promise.all([
        get(f, `https://hn.algolia.com/api/v1/search?tags=show_hn&numericFilters=created_at_i>${since14},points>20&hitsPerPage=60`, T),
        get(f, `https://hn.algolia.com/api/v1/search?query=%22Launch%20HN%22&tags=story&numericFilters=created_at_i>${since14}&hitsPerPage=30`, T),
      ]);
      if (!a.ok && !b.ok) throw new Error(a.error ?? `HN ${a.status}`);
      return [...parseHNHits(json(a.body), "showhn", now), ...parseHNHits(json(b.body), "showhn", now)];
    }),
    run("producthunt", async () => { const r = await get(f, "https://www.producthunt.com/feed", T); if (!r.ok) throw new Error(r.error ?? `Product Hunt ${r.status}`); return parseAtom(r.body, "producthunt", now); }),
    run("polymarket", async () => { const r = await get(f, "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200", T); if (!r.ok) throw new Error(r.error ?? `Polymarket ${r.status}`); return parsePolymarket(json(r.body), now).slice(0, 20); }),
    run("github", async () => {
      // Two searches: brand-new repos (≤30 days) and young ones (≤60 days); Discover shares the 30/min budget.
      const out: TrendSignal[] = [];
      for (const [q, n] of [[`created:>${iso(30)} stars:>80`, 50], [`created:>${iso(60)} stars:>400`, 40]] as const) {
        const r = await ghRun(["-X", "GET", "search/repositories", "-f", `q=${q}`, "-f", "sort=stars", "-f", "order=desc", "-f", `per_page=${n}`], T + 6000);
        if (!r.ok) { if (!out.length) throw new Error(r.error ?? `GitHub ${r.status}`); break; }
        for (const x of parseGitHubRepos(r.data, now)) if (!out.some((y) => y.id === x.id)) out.push(x);
        if ((r.remaining ?? 30) <= 6) break;
      }
      return out;
    }),
    run("reports", async () => {
      const out: TrendSignal[] = [];
      for (const dir of o.reportsDirs ?? [`${HOME}/.config/herdr-deck/research`, `${HOME}/.config/herdr-deck/leads`]) {
        if (!existsSync(dir)) continue;
        for (const fn of readdirSync(dir).filter((x) => x.endsWith(".md")).slice(0, 40)) {
          const p = `${dir}/${fn}`;
          const st = statSync(p);
          if (now - st.mtimeMs > 30 * DAY) continue;
          out.push(...parseReport(readFileSync(p, "utf8"), p, st.mtimeMs));
        }
      }
      return out;
    }),
  ]);
  // Reddit last and one at a time: its keyless feeds allow about one read in 15 seconds.
  const subs = o.subs ?? REDDIT_SUBS;
  const gap = o.redditGapMs ?? 16_000;
  const t0 = Date.now();
  const got: TrendSignal[] = [];
  const errs: string[] = [];
  for (let i = 0; i < subs.length; i++) {
    if (i) await Bun.sleep(gap);
    const r = await get(f, `https://www.reddit.com/r/${subs[i]}/top/.rss?t=week&limit=25`, T);
    if (r.status === 429) { errs.push(`r/${subs[i]}: rate-limited`); await Bun.sleep(gap); continue; }
    if (!r.ok) { errs.push(`r/${subs[i]}: ${r.error ?? r.status}`); continue; }
    got.push(...parseAtom(r.body, "reddit", now, `r/${subs[i]}`));
  }
  signals.push(...got);
  status.reddit = { ok: got.length > 0, n: got.length, ms: Date.now() - t0, error: errs.length ? errs.join("; ") : undefined };
  o.log?.(`reddit: ${got.length} signals${errs.length ? ` (${errs.join("; ")})` : ""}`);
  rankWithinSource(signals);
  const d = new Date(now);
  return { at: now, day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, signals, trends: clusterTrends(signals, now), status };
}
