// Leads: find the people who need an idea, or the ideas an audience needs. The search itself is the core's pain
// search (src/pain-search.ts); this is the service around it: jobs that stream per source, a cache of recent
// searches (leads-cache.json, which Discover's gallery and Quests also read), deep-dive reports and saved leads.
// The deep dive hands a prompt to an agent (the user's last30days skill + web search); nothing starts until the
// user confirms the New session dialog.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { gh as ghDefault, type GhRes } from "../../src/gh";
import { frontmatter, slugify } from "../../src/text";
import {
  FETCHERS, REDDIT_WAIT, SOURCES, analyze, keywordsFor, scrub,
  type App, type Dir, type FetchLike, type LeadsResult, type Limits, type Place, type Raw, type SourceCtx, type SourceId, type SourceOut, type SrcStatus,
} from "../../src/pain-search";

const HOME = homedir();
const DAY = 86_400_000;
const tilde = (p: string) => p.replace(HOME, "~");

// ── prompts: the deep dive and "Plan the app for them" ─────────────────────────────────────────
export type Report = { slug: string; title: string; kind: Dir; query: string; date?: string; mtime: number; summary: string; pending?: boolean; session?: { key: string; title: string; status: string } };
type RowLite = { key: string; title: string; status: string; firstPrompt?: string };
export function deepPrompt(text: string, dir: Dir, slug: string, ctx: { leadsDir: string; result?: Pick<LeadsResult, "themes" | "places" | "apps" | "keywords"> }) {
  const file = `${tilde(ctx.leadsDir)}/${slug}.md`;
  const what = dir === "audience" ? "audience" : "app idea";
  const r = ctx.result;
  const topic = dir === "audience" ? text.trim() : (r?.keywords?.slice(0, 3).join(" ") || text.trim());
  const found = r && (r.themes.length || r.places.length) ? [
    "",
    "Starting points herdr deck's instant pass found in public posts (verify them, don't trust them):",
    ...r.themes.slice(0, 5).map((t) => `- Pain theme "${t.title ?? t.label}" (${t.n} posts): ${t.quotes.slice(0, 2).map((q) => `"${q.snippet.slice(0, 120)}" ${q.url}`).join(" · ")}`),
    r.places.length ? `- Where they gather: ${r.places.slice(0, 8).map((p) => `${p.label} (${p.url})`).join(", ")}` : "",
    r.apps?.length ? `- Existing apps: ${r.apps.slice(0, 5).map((a) => `${a.name}${a.rating ? ` ${a.rating}★/${a.ratings}` : ""}`).join(", ")}` : "",
  ].filter(Boolean) : [];
  return [
    `Find leads for this ${what}: who has the pain, in their own words, and what to build for them. Write the report to ${file} (create the folder if needed).`,
    "",
    `The ${what}: "${text.trim()}"`,
    "",
    "Rules: this is research only. Read public posts; never contact, message, follow, reply to, sign up or buy anything, and never collect private data (no emails, phone numbers or real names beyond public handles; public usernames and post links only).",
    "",
    `1. Run the last30days skill (\`/last30days ${topic}\`) to pull the last 30 days of Reddit, X, YouTube, TikTok, Hacker News, Polymarket, GitHub and the web. Then run it on one or two sharper angles, like "${topic} app frustrations" and "${topic} alternatives". If the skill isn't available, say so and use web search instead.`,
    "2. Also search the web for older and deeper evidence: 1–3★ App Store and Google Play reviews of the leading apps, Product Hunt comments, Stack Exchange, niche forums, public Discord or Facebook group posts that are indexed, and YouTube comments.",
    "3. Collect pain points as short quotes (one or two sentences), each with source, date and link. Group them into themes and count how often each one comes up.",
    "4. Who needs it: the segments, the communities where they gather (with size or activity), and notable public voices (public handles only).",
    "5. Demand and willingness to pay: evidence of people paying for workarounds, asking for paid options, or the prices of what they use now. Give demand as low / medium / high, with the reasons. If the herdr-deck MCP tool `deck_library` is available, ask it how real founders priced and found the first customers for something similar, and cite its timestamp links.",
    "6. Competitors and gaps: a table of what exists (name, link, price, what its users complain about) and the gap nobody fills.",
    dir === "audience"
      ? "7. Propose 5 app or feature ideas ranked by the strength of the evidence. For each: a one-line pitch, the pains it solves (link the quotes), who pays and how much, why now, and a 1-week MVP plan (day by day)."
      : "7. Verdict: is this worth building, for whom first, and what to change about the idea. Then 3 adjacent ideas the evidence points to, each with a one-line pitch and a 1-week MVP plan (day by day).",
    ...found,
    "",
    "8. Write the report as Markdown with this front matter and these sections:",
    "---",
    `kind: ${dir}`,
    `query: ${text.trim().replace(/\n+/g, " ").slice(0, 200)}`,
    "date: <today's date>",
    "---",
    "# <a short title>",
    "## In one paragraph",
    "## Pain points (themes, with quotes and links)",
    "## Who needs it",
    "## Where they hang out",
    "## Demand and willingness to pay",
    "## Competitors and gaps",
    dir === "audience" ? "## 5 ideas, ranked by evidence (each with a 1-week MVP)" : "## Verdict and 3 adjacent ideas (each with a 1-week MVP)",
    "## Sources",
    "9. When the file is written, reply with its path and a five-line summary.",
  ].join("\n");
}
export type PlanItem = { label: string; idea?: string; catLabel?: string; n?: number; quotes?: { snippet: string; url: string; source: string; at?: number }[] };
export function planPrompt(item: PlanItem, ctx: { ideasDir: string; slug: string; text: string; dir: Dir; places?: string[] }) {
  const file = `${tilde(ctx.ideasDir)}/${ctx.slug}.md`;
  const who = ctx.dir === "audience" ? ctx.text.trim() : `people who want: ${ctx.text.trim()}`;
  const quotes = (item.quotes ?? []).slice(0, 8).map((q) => `- "${q.snippet.slice(0, 240)}" (${q.source}${q.at ? `, ${new Date(q.at).toISOString().slice(0, 10)}` : ""}) ${q.url}`);
  return [
    `Plan an app for the people with this pain, then write the plan to ${file} (create the folder if needed).`,
    "",
    `Who: ${who}`,
    `The pain: ${item.label}${item.catLabel ? ` (${item.catLabel})` : ""}${item.n ? `, seen in ${item.n} public posts` : ""}.`,
    item.idea ? `A first idea for it: ${item.idea}` : "",
    "",
    quotes.length ? "What they said (public posts; open the links and read the threads first):" : "",
    ...quotes,
    ctx.places?.length ? `Where they hang out: ${ctx.places.slice(0, 8).join(", ")}` : "",
    "",
    "This is research and planning only: don't build anything yet, and don't contact, message, sign up for, buy or publish anything.",
    "1. Read the linked posts and search for more of the same pain (web search; the last30days skill if you have it). Confirm it's real and recurring, or say it isn't.",
    "2. Check what already exists (apps, open-source repos, services) and exactly why it doesn't solve this for them.",
    "3. Design the smallest product that removes the pain: who it's for first, the one core flow, and why they'd switch or pay.",
    "4. Write the plan as Markdown with this front matter and these sections:",
    "---",
    `idea: <the product in one line>`,
    "created: <today's date>",
    "status: plan",
    "---",
    "# <a short name for it>",
    "## In one paragraph",
    "## The evidence (quotes with links)",
    "## Who it's for first",
    "## What already exists and why it falls short",
    "## The product (core flow, what we write ourselves, what we reuse)",
    "## 1-week MVP (day by day)",
    "## How it reaches them (the communities above; no spam, no cold messages)",
    "## Costs and risks",
    "## First 3 tasks (concrete enough for an agent to start today)",
    "5. When the file is written, reply with its path and a five-line summary.",
  ].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
}
export function listReports(dir: string, rows: RowLite[] = [], pending: { slug: string; text: string; dir: Dir; at: number }[] = []): Report[] {
  const out: Report[] = [];
  const sessionFor = (slug: string) => { const r = rows.find((x) => x.firstPrompt?.includes(`leads/${slug}.md`)); return r ? { key: r.key, title: r.title, status: r.status } : undefined; };
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch {}
  for (const f of files) {
    const p = `${dir}/${f}`;
    let st; try { st = statSync(p); } catch { continue; }
    let text = ""; try { text = readFileSync(p, "utf8").slice(0, 200_000); } catch {}
    const { data, body } = frontmatter(text);
    const slug = f.slice(0, -3);
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? String(data.query ?? slug);
    const para = body.replace(/^#.*$/gm, "").split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !/^(\||```|---|- |\* |\d+\. |>)/.test(x)) ?? "";
    out.push({ slug, title: title.slice(0, 120), kind: data.kind === "audience" ? "audience" : "idea", query: String(data.query ?? "").slice(0, 300), date: data.date, mtime: st.mtimeMs, summary: para.replace(/[*_`]/g, "").slice(0, 280), session: sessionFor(slug) });
  }
  for (const p of pending) {
    if (out.some((x) => x.slug === p.slug) || Date.now() - p.at > 14 * DAY) continue;
    out.push({ slug: p.slug, title: p.text.slice(0, 120), kind: p.dir, query: p.text, mtime: p.at, summary: "", pending: true, session: sessionFor(p.slug) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ── starters: the "endless possibilities" shelf, tailored to this user's world ─────────────────────
export const STARTERS: { dir: Dir; text: string }[] = [
  { dir: "idea", text: "A morning voice note that explains today's transits for my own Human Design chart" },
  { dir: "idea", text: "Chat with everything a YouTuber ever said, with timestamps as sources" },
  { dir: "idea", text: "Turn a long podcast into five vertical clips with burned-in captions, from the phone" },
  { dir: "idea", text: "An explainer video made from a blog post in one click" },
  { dir: "idea", text: "A Human Design compatibility reading for couples that reads like a story" },
  { dir: "idea", text: "An OSINT watcher that summarizes public Telegram channels about one city" },
  { dir: "idea", text: "Build and share a tiny browser game from your phone in one evening" },
  { dir: "idea", text: "One dashboard for every AI coding agent running across my machines" },
  { dir: "idea", text: "Dub and caption short videos into Hebrew with proper right-to-left subtitles" },
  { dir: "idea", text: "Alerts when prediction-market odds move on topics I follow" },
  { dir: "idea", text: "A daily I Ching reading that remembers your past questions" },
  { dir: "idea", text: "Faceless YouTube channel on autopilot: script, voice and edit from one idea" },
  { dir: "idea", text: "A personal knowledge base that answers from my notes with citations" },
  { dir: "idea", text: "A quiz funnel that turns astrology readers into paying chart customers" },
  { dir: "audience", text: "Human Design readers and coaches" },
  { dir: "audience", text: "Podcasters who clip episodes for TikTok and Reels" },
  { dir: "audience", text: "Indie game devs who build browser games" },
  { dir: "audience", text: "OSINT hobbyists and open-source investigators" },
  { dir: "audience", text: "Developers running several AI coding agents at once" },
  { dir: "audience", text: "Faceless YouTube channel creators" },
  { dir: "audience", text: "Tarot and I Ching readers who sell readings online" },
  { dir: "audience", text: "Astrology content creators on YouTube" },
  { dir: "audience", text: "Solo founders selling digital products on Gumroad" },
  { dir: "audience", text: "Hebrew-speaking small business owners" },
  { dir: "audience", text: "Polymarket and prediction-market traders" },
  { dir: "audience", text: "Teachers who make short explainer videos" },
  { dir: "audience", text: "People building a second brain in Obsidian" },
  { dir: "audience", text: "Self-hosters who run their own AI models" },
];
/** Discover's interests → the people who share them, for "Surprise me". */
const AUDIENCE_OF: Record<string, string[]> = {
  "human-design": ["Human Design readers", "Human Design coaches", "people new to Human Design"], astro: ["astrology fans", "astrologers who read charts for clients"],
  esoteric: ["tarot readers", "I Ching students", "spiritual content creators"], osint: ["OSINT hobbyists", "citizen journalists"], forecasting: ["prediction-market traders", "superforecasters"],
  trading: ["retail day traders", "crypto traders"], video: ["short-form video creators", "YouTube editors", "faceless channel creators"], speech: ["podcasters", "voice-over artists"],
  "3d": ["three.js developers", "3D artists on the web"], games: ["indie browser-game devs", "game jam participants"], genmedia: ["AI art makers", "AI music producers"],
  automation: ["small business owners", "freelancers drowning in admin"], education: ["self-taught learners", "online course creators"], hebrew: ["Hebrew-speaking creators", "Israeli small businesses"],
  agents: ["developers running AI coding agents", "AI agent builders"], "claude-code": ["Claude Code power users"], mcp: ["MCP server builders"], rag: ["people building a second brain", "researchers drowning in PDFs"],
  "local-first": ["privacy-minded self-hosters"], pwa: ["mobile-first web developers"], telegram: ["Telegram community admins"], geo: ["map and GIS hobbyists"],
  matching: ["people looking for a compatible partner"], viz: ["data journalists"], scraping: ["researchers who scrape the web"], evals: ["teams shipping LLM features"],
};
const MODS = ["", "", " on their phones", " who are just starting out", " who hate subscriptions", " with no coding skills", " who sell to their own audience", " who work alone", " in Israel"];
function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
export function starters(seed: number, n = 5): { idea: string[]; audience: string[] } {
  const r = rng(seed * 2654435761 + 11);
  const pick = (dir: Dir) => { const xs = STARTERS.filter((s) => s.dir === dir).map((s) => s.text); for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs.slice(0, n); };
  return { idea: pick("idea"), audience: pick("audience") };
}
export function surprise(interests: { id: string; label: string; score?: number }[], seed: number): string {
  const r = rng(seed * 40503 + 7);
  const pool = interests.flatMap((i) => (AUDIENCE_OF[i.id] ?? (i.id.startsWith("you:") ? [`people into ${i.label.toLowerCase()}`] : [])).map((a) => ({ a, w: Math.sqrt(Math.max(1, i.score ?? 1)) })));
  if (!pool.length) { const xs = STARTERS.filter((s) => s.dir === "audience"); return xs[Math.floor(r() * xs.length)].text; }
  let t = r() * pool.reduce((a, x) => a + x.w, 0);
  let pickd = pool[pool.length - 1].a;
  for (const x of pool) { t -= x.w; if (t <= 0) { pickd = x.a; break; } }
  const mod = MODS[Math.floor(r() * MODS.length)];
  return `${pickd[0].toUpperCase()}${pickd.slice(1)}${mod}`;
}

// ── the service: jobs that stream per source, a cache, reports, saves ───────────────────────────
export type SavedLead = { id: string; label: string; cat?: string; catLabel?: string; idea?: string; text: string; dir: Dir; n?: number; quotes: { snippet: string; url: string; source: string; author?: string; at?: number }[]; savedAt: number };
type CacheFile = { entries: Record<string, LeadsResult>; recent: { text: string; dir: Dir; at: number }[]; pending: { slug: string; text: string; dir: Dir; at: number }[]; limits?: Partial<Limits> };
export type LeadsDeps = {
  fetch?: FetchLike; gh?: (args: string[], timeoutMs?: number) => Promise<GhRes>; rows?: () => RowLite[];
  saved?: { get: () => any[]; set: (v: any[]) => void }; interests?: () => Promise<{ id: string; label: string; score?: number }[]>;
  timeout?: number; ttl?: number; projectsDir?: string; now?: () => number;
};
const FRESH = 12 * 3600_000;
export const keyOf = (text: string, dir: Dir) => `${dir}|${text.toLowerCase().replace(/\s+/g, " ").trim()}`;

export function createLeads(dataDir: string, deps: LeadsDeps = {}) {
  const f: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init as any) as any);
  const ghRun = deps.gh ?? ghDefault;
  const now = deps.now ?? Date.now;
  const TIMEOUT = deps.timeout ?? 9000;
  const TTL = deps.ttl ?? FRESH;
  const FILE = `${dataDir}/leads-cache.json`;
  const LEADS = `${dataDir}/leads`;
  const IDEAS = `${dataDir}/ideas`;
  const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
  let cache: CacheFile = { entries: {}, recent: [], pending: [], ...readJson(FILE) };
  const limits: Limits = { redditUntil: 0, ghRemaining: 30, ghReset: 0, seQuota: 300, seUntil: 0, ...cache.limits };
  let saveT: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    clearTimeout(saveT); saveT = undefined;
    try { mkdirSync(dataDir, { recursive: true }); cache.limits = limits; const tmp = `${FILE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(cache)); renameSync(tmp, FILE); } catch {}
  }
  const save = () => { clearTimeout(saveT); saveT = setTimeout(flush, 300); (saveT as any).unref?.(); };
  let savedLocal: any[] = [];
  const saved = deps.saved ?? { get: () => savedLocal, set: (v: any[]) => { savedLocal = v; } };

  type Job = { id: string; key: string; text: string; dir: Dir; keywords: string[]; raws: Partial<Record<SourceId, Raw[]>>; subs: Place[]; apps: App[]; status: Record<SourceId, SrcStatus>; result: LeadsResult; done: boolean; at: number };
  const jobs = new Map<string, Job>();
  const running = new Map<string, Job>(); // by query key: the same search twice joins the first

  function compute(j: Job): LeadsResult {
    const { bySource, ...a } = analyze({ raws: SOURCES.flatMap((s) => j.raws[s.id] ?? []), keywords: j.keywords, text: j.text, dir: j.dir, subs: j.subs, apps: j.apps, now: now() });
    // Each source's count is what survived relevance, dedupe and privacy filters, across all sources together.
    for (const s of SOURCES) if (j.status[s.id].state === "ok") j.status[s.id] = { ...j.status[s.id], n: bySource[s.id] ?? 0 };
    return { key: j.key, text: j.text, dir: j.dir, keywords: j.keywords, at: j.at, done: j.done, sources: j.status, apps: j.apps, ...a };
  }
  function start(text: string, dir: Dir, keywords: string[]): Job {
    const key = keyOf(text, dir);
    const dupe = running.get(key);
    if (dupe) return dupe;
    const id = `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const status = Object.fromEntries(SOURCES.map((s) => [s.id, { state: "pending", n: 0 } as SrcStatus])) as Record<SourceId, SrcStatus>;
    const j: Job = { id, key, text, dir, keywords, raws: {}, subs: [], apps: [], status, result: undefined as any, done: false, at: now() };
    j.result = compute(j);
    jobs.set(id, j); running.set(key, j);
    const ctx: SourceCtx = { fetch: f, gh: ghRun, limits, now: now(), timeout: TIMEOUT, note: (s, msg) => { if (j.status[s].state === "pending") { j.status[s] = { ...j.status[s], error: msg }; j.result = compute(j); } } };
    const t0 = Date.now();
    const runOne = async (s: SourceId) => {
      let out: SourceOut;
      const budget = TIMEOUT * 2 + 2000 + (s === "reddit" ? REDDIT_WAIT : 0);
      try { out = await Promise.race([FETCHERS[s](keywords, dir, ctx), Bun.sleep(budget).then(() => ({ raws: [], error: "didn't answer in time" }) as SourceOut)]); }
      catch (e: any) { out = { raws: [], error: e?.message ?? String(e) }; }
      j.raws[s] = out.raws;
      if (out.subs) j.subs.push(...out.subs);
      if (out.apps) j.apps = out.apps;
      j.status[s] = { state: out.skipped ? "skipped" : out.error && !out.raws.length ? "error" : "ok", n: 0, ms: Date.now() - t0, ...(out.error || out.skipped ? { error: out.error ?? out.skipped } : {}) };
      j.result = compute(j);
    };
    Promise.all(SOURCES.map((s) => runOne(s.id))).then(() => {
      j.done = true;
      j.result = compute(j);
      running.delete(key);
      // A search where every source failed isn't cached over a good older result.
      const anyOk = SOURCES.some((s) => j.status[s.id].state === "ok");
      if (anyOk || !cache.entries[key]) {
        cache.entries[key] = j.result;
        const keys = Object.keys(cache.entries);
        if (keys.length > 40) for (const k of keys.sort((a, b) => cache.entries[a].at - cache.entries[b].at).slice(0, keys.length - 40)) delete cache.entries[k];
      }
      save();
      (setTimeout(() => jobs.delete(id), 10 * 60_000) as any).unref?.();
    });
    return j;
  }
  function remember(text: string, dir: Dir) {
    cache.recent = [{ text, dir, at: now() }, ...cache.recent.filter((r) => keyOf(r.text, r.dir) !== keyOf(text, dir))].slice(0, 12);
    save();
  }
  function search(text: string, dir: Dir, force = false) {
    const keywords = keywordsFor(text, dir);
    if (!keywords.length) throw new Error(dir === "audience" ? "Name the audience in a few words: who they are and what they do" : "Say a little more about the idea: what it does and for whom");
    remember(text, dir);
    const key = keyOf(text, dir);
    const c = cache.entries[key];
    const fresh = c && now() - c.at < TTL && !force;
    if (fresh) return { id: null, done: true, cached: true, result: c };
    const j = start(text, dir, keywords);
    // Cached but old: show it at once while the new search streams in.
    return { id: j.id, done: false, cached: !!c, result: c && !j.done ? { ...c, done: false, sources: j.status } : j.result };
  }
  function state(seed = 0) {
    const day = Math.floor(now() / DAY);
    return {
      starters: starters(day + seed), sources: SOURCES, recent: cache.recent.slice(0, 8), saved: saved.get(),
      reports: listReports(LEADS, deps.rows?.() ?? [], cache.pending),
    };
  }
  const reportSlug = (text: string, dir: Dir) => {
    let slug = slugify(`${dir === "audience" ? "for" : "leads"} ${keywordsFor(text, dir).slice(0, 5).join(" ") || text}`, 56) || `leads-${now().toString(36)}`;
    if (existsSync(`${LEADS}/${slug}.md`) || cache.pending.some((x) => x.slug === slug && x.text !== text)) slug = `${slug}-${now().toString(36).slice(-4)}`;
    return slug;
  };
  const cleanDir = (d: unknown): Dir => (d === "audience" ? "audience" : "idea");

  async function handle(path: string, body: any): Promise<any> {
    switch (path) {
      case "/api/leads": return state(Number(body.seed) || 0);
      case "/api/leads/search": {
        const text = String(body.text ?? "").trim().slice(0, 400);
        if (text.length < 3) throw new Error("Describe an idea or an audience first");
        return search(text, cleanDir(body.dir), !!body.force);
      }
      case "/api/leads/status": {
        const j = jobs.get(String(body.id ?? ""));
        if (!j) throw new Error("That search has finished or expired; search again");
        return { id: j.id, done: j.done, result: j.result };
      }
      case "/api/leads/surprise": {
        const ints = deps.interests ? await Promise.race([deps.interests().catch(() => []), Bun.sleep(1500).then(() => [])]) : [];
        return { text: surprise(ints, Number(body.seed) || now()), dir: "audience" };
      }
      case "/api/leads/prompt": {
        const text = String(body.text ?? "").trim().slice(0, 400);
        const dir = cleanDir(body.dir);
        if (text.length < 3) throw new Error("Describe an idea or an audience first");
        const cwd = deps.projectsDir ?? `${HOME}/Documents/Projects`;
        if (body.kind === "deep") {
          const slug = reportSlug(text, dir);
          return { prompt: deepPrompt(text, dir, slug, { leadsDir: LEADS, result: cache.entries[keyOf(text, dir)] }), cwd, slug, label: `Leads: ${text.slice(0, 28)}` };
        }
        if (body.kind === "plan") {
          const it = body.item ?? {};
          const label = String(it.label ?? "").slice(0, 120);
          if (!label) throw new Error("Which pain?");
          const item: PlanItem = { label, idea: it.idea ? String(it.idea).slice(0, 300) : undefined, catLabel: it.catLabel ? String(it.catLabel).slice(0, 60) : undefined, n: Number(it.n) || undefined,
            quotes: (Array.isArray(it.quotes) ? it.quotes : []).slice(0, 8).map((q: any) => ({ snippet: scrub(String(q?.snippet ?? "")).slice(0, 240), url: String(q?.url ?? "").slice(0, 300), source: String(q?.source ?? "").slice(0, 20), at: Number(q?.at) || undefined })) };
          let slug = slugify(`${item.idea ?? label} ${dir === "audience" ? text : ""}`, 56) || `lead-${now().toString(36)}`;
          if (existsSync(`${IDEAS}/${slug}.md`)) slug = `${slug}-${now().toString(36).slice(-4)}`;
          const places = (Array.isArray(body.places) ? body.places : []).slice(0, 8).map((p: unknown) => String(p).slice(0, 120));
          return { prompt: planPrompt(item, { ideasDir: IDEAS, slug, text, dir, places }), cwd, slug, label: `Plan: ${label.slice(0, 28)}`, ideaText: item.idea ?? `${label} for ${text}` };
        }
        throw new Error("unknown prompt");
      }
      case "/api/leads/report": {
        const slug = String(body.slug ?? "");
        if (!/^[\w.-]+$/.test(slug)) throw new Error("Which report?");
        let text = ""; try { text = readFileSync(`${LEADS}/${slug}.md`, "utf8"); } catch {}
        if (!text) throw new Error("That report isn't written yet");
        const { data, body: md } = frontmatter(text);
        return { slug, text: md, meta: data, path: `${LEADS}/${slug}.md` };
      }
      case "/api/leads/report-started": {
        const slug = slugify(String(body.slug ?? ""), 64);
        if (!slug) throw new Error("Which report?");
        cache.pending = [{ slug, text: String(body.text ?? "").slice(0, 400), dir: cleanDir(body.dir), at: now() }, ...cache.pending.filter((x) => x.slug !== slug)].slice(0, 60);
        save();
        return { reports: listReports(LEADS, deps.rows?.() ?? [], cache.pending) };
      }
      case "/api/leads/report-forget": {
        const slug = String(body.slug ?? "");
        cache.pending = cache.pending.filter((x) => x.slug !== slug);
        save();
        return { reports: listReports(LEADS, deps.rows?.() ?? [], cache.pending) };
      }
      case "/api/leads/save": {
        const l = body.lead ?? {};
        const id = String(l.id ?? body.id ?? "").slice(0, 120);
        if (!id) throw new Error("Which lead?");
        let list = saved.get().filter((x: SavedLead) => x.id !== id);
        if (body.op === "save") {
          const keep: SavedLead = {
            id, label: String(l.label ?? "").slice(0, 120), cat: l.cat ? String(l.cat).slice(0, 20) : undefined, catLabel: l.catLabel ? String(l.catLabel).slice(0, 40) : undefined,
            idea: l.idea ? String(l.idea).slice(0, 300) : undefined, text: String(l.text ?? "").slice(0, 400), dir: cleanDir(l.dir), n: Number(l.n) || undefined, savedAt: now(),
            quotes: (Array.isArray(l.quotes) ? l.quotes : []).slice(0, 5).map((q: any) => ({ snippet: scrub(String(q?.snippet ?? "")).slice(0, 240), url: String(q?.url ?? "").slice(0, 300), source: String(q?.source ?? "").slice(0, 20), author: q?.author ? scrub(String(q.author)).slice(0, 40) : undefined, at: Number(q?.at) || undefined })),
          };
          if (!keep.label) throw new Error("Which lead?");
          list = [keep, ...list].slice(0, 200);
        } else if (body.op !== "unsave") throw new Error("unknown op");
        saved.set(list);
        return { saved: list };
      }
    }
    return undefined;
  }
  return { handle, search, state, flush: () => { if (saveT) flush(); }, limits, paths: { cache: FILE, leads: LEADS, ideas: IDEAS } };
}
