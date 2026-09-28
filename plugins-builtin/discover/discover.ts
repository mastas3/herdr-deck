// Discover: repos worth forking ("hidden gems" matched to what you build), an idea lab that searches GitHub
// for building blocks and hands a research brief to an agent, the plans those agents write, and "what if"
// sparks generated from your own profile.
//
// Privacy: the profile is built locally from the wiki, your repos and the connections scan. Only interest
// keywords (and the words of an idea you type) ever leave the machine, as GitHub search queries through `gh`.
// Network work never blocks a request for long: cached data is returned at once and refreshed in the background.
import { openIdeaArchive } from "./idea-archive";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { collectIngredients, createMixer, KIND_LABEL, sanitizeIngredient, type ConnLite, type Engine, type Ingredient, type MixerDeps } from "./mix";
import { createStudio, type StudioDeps } from "./studio";
import { createFeed, type FeedDeps } from "./feed";
import { gh, ghAvailable, type GhRes } from "../../src/gh";
import { frontmatter, hasTerm, slugify } from "../../src/text";
import { buildProfile, readText, type DiscoverConf, type Interest, type Profile, type Repo } from "./discover-profile";
import { buildPrompt, CONN_FITS, extractKeywords, forkPrompt, groupByRole, listIdeas, rankGems, rankIdeaRepos, rankTrending, researchPrompt, sparks, toRepo, type PromptCtx, type RankCtx, type RowLite } from "./discover-ideas";

// The GitHub CLI and the text helpers are core (Leads uses them too); Discover's own modules get them from here.
export { gh, ghAvailable, type GhRes } from "../../src/gh";
export { frontmatter, hasTerm, slugify } from "../../src/text";
// The profile and the pure parts live beside this file; importers keep asking "./discover" for all of it.
export * from "./discover-profile";
export * from "./discover-ideas";

const DAY = 86_400_000;

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
const SEARCH_GAP = 350;

export type ItemsDep = () => Promise<{ items: ConnLite[]; categories?: { id: string; label: string }[] }>;
export function createDiscover(paths: DiscoverPaths, deps: { connections?: () => Promise<string[]>; items?: ItemsDep; rows?: () => RowLite[]; gh?: (args: string[], timeoutMs?: number) => Promise<GhRes>; gap?: number; mixer?: Partial<MixerDeps>; studio?: Partial<StudioDeps>; feed?: Partial<FeedDeps> } = {}) {
  const run = deps.gh ?? gh;
  const GAP = deps.gap ?? SEARCH_GAP;
  const CONF = `${paths.dataDir}/discover.json`;
  const CACHE = `${paths.dataDir}/discover-cache.json`;
  const IDEAS = `${paths.dataDir}/ideas`;
  const CONN_FILE = `${paths.dataDir}/CONNECTIONS.md`;
  const pctx: PromptCtx = { ideasDir: IDEAS, connectionsFile: CONN_FILE, projectsDir: paths.projectsDir };
  const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
  const writeJson = (p: string, v: unknown) => { mkdirSync(paths.dataDir, { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, p); };
  let conf: DiscoverConf = { added: [], removed: [], saved: [], dismissed: [], ideas: [], mixes: [], ...readJson(CONF) };
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
  let progress = { done: 0, total: 0 };
  let lastError = "";
  async function search(kind: "repositories" | "topics", q: string, extra: string[] = [], reserve = 0): Promise<GhRes> {
    if (Date.now() > resetAt) remaining = Math.max(remaining, 30);
    if (remaining <= reserve) {
      const wait = resetAt - Date.now();
      if (wait > 65_000 || wait < 0) remaining = 30; // stale bookkeeping
      // The idea lab never waits silently: it says when GitHub's search limit frees up.
      else if (!reserve) return { ok: false, status: 429, error: `GitHub's search limit is used up for a moment. Try again in ${Math.ceil(wait / 1000) + 1}s.` } as GhRes;
      else await Bun.sleep(wait + 500);
    }
    // Each search books its own start slot, so parallel workers stay spaced out.
    if (reserve) { const at = Math.max(Date.now(), lastSearch + GAP); lastSearch = at; if (at > Date.now()) await Bun.sleep(at - Date.now()); }
    else lastSearch = Date.now();
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
      progress = { done: 0, total: jobs.length };
      // Four searches at a time (spaced a little), well under GitHub's 30 a minute; the idea lab keeps a reserve.
      let next = 0, stop = false;
      const worker = async () => {
        while (!stop && next < jobs.length) {
          const { it, kind } = jobs[next++];
          const q = kind === "gems" ? gemQuery(it) : trendQuery(it);
          const r = await search("repositories", q, kind === "gems" ? ["per_page=40"] : ["sort=stars", "order=desc", "per_page=20"], 8);
          const entry = { at: Date.now(), q: it.q, items: r.ok ? (r.data.items ?? []).map(toRepo) : (kind === "gems" ? cache.gems : cache.trend)[it.id]?.items ?? [], ...(r.ok ? {} : { error: r.error }) };
          (kind === "gems" ? cache.gems : cache.trend)[it.id] = entry;
          progress.done++;
          if (!r.ok) { lastError = r.error ?? "GitHub search failed"; if (r.status === 0 && /install|auth|login/i.test(lastError)) stop = true; }
          saveCache();
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
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

  // ── the Mixer: ingredients from the profile, gems, saved repos and the connections store ──
  const mixer = createMixer({ file: `${paths.dataDir}/mix-cache.json`, ...deps.mixer });
  let items: { at: number; items: ConnLite[]; labels: Record<string, string> } | undefined;
  let itemsLoading: Promise<void> | undefined;
  function loadItems() {
    if (!deps.items) return Promise.resolve();
    if (items && Date.now() - items.at < 10 * 60_000) return Promise.resolve();
    return (itemsLoading ??= deps.items().then((r) => { items = { at: Date.now(), items: r.items, labels: Object.fromEntries((r.categories ?? []).map((c) => [c.id, c.label])) }; }).catch(() => { items = { at: Date.now() - 9 * 60_000, items: [], labels: {} }; }).finally(() => { itemsLoading = undefined; }));
  }
  /** Everything you could mix. Waits briefly for the connections scan; the page asks again when it wasn't ready. */
  async function ingredients(wait = 2500) {
    const p = await profile();
    await Promise.race([loadItems(), Bun.sleep(wait)]);
    const { gems, trending } = ranked(p);
    return { list: collectIngredients({ profile: p, gems, trending, saved: conf.saved, items: items?.items, catLabels: items?.labels }), connLoading: !!deps.items && !items };
  }
  const byId = (xs: Ingredient[]) => new Map(xs.map((x) => [x.id, x]));
  // Studio: the chat that assembles builds out of all of it (src/studio.ts). Conversations in <dataDir>/studio/.
  // "Ideas for you": the feed of ready-to-execute ideas on For you (src/feed.ts), cached for the day in <dataDir>/feed.json.
  const archive = openIdeaArchive(`${paths.dataDir}/ideas.db`);
  // Today's feed from before the archive existed goes in once (put keeps first-seen times, so repeats are harmless).
  try { for (const x of JSON.parse(readFileSync(`${paths.dataDir}/feed.json`, "utf8")).ideas ?? []) { archive.put({ ...x, source: x.source ?? "feed" }); if (x.score != null) archive.score(x.id, x.score, false); } } catch {}
  const feed = createFeed({ file: `${paths.dataDir}/feed.json`, ingredients: async (w) => (await ingredients(w)).list, archive, ...deps.feed });
  const studio = createStudio({ dir: `${paths.dataDir}/studio`, projectsDir: paths.projectsDir, ingredients: async (w) => (await ingredients(w)).list, engines: () => mixer.engines(), archive, ...deps.studio });

  async function state(body: { refresh?: boolean; shuffle?: number; passive?: boolean } = {}) {
    const p = await profile(!!body.refresh);
    const ats = p.interests.map((i) => cache.gems[i.id]?.at ?? 0);
    const fetchedAt = ats.length ? Math.min(...ats) : 0;
    const missing = p.interests.filter((i) => !cache.gems[i.id]).length;
    const stale = !fetchedAt || Date.now() - fetchedAt > TTL;
    const retry = p.interests.some((i) => cache.gems[i.id]?.error && Date.now() - cache.gems[i.id].at > 5 * 60_000);
    if (body.refresh || !body.passive && (stale || missing || retry)) refresh(!!body.refresh);
    const { gems, trending } = ranked(p);
    const day = Math.floor(Date.now() / DAY);
    // "Ideas for you" is its own route (/api/discover/feed): generated in batches, at most once a day, only when Discover is open.
    return {
      mixes: { saved: conf.mixes ?? [] },
      profile: { interests: p.interests, removed: p.removed.map(({ id, label }) => ({ id, label })), languages: p.languages, connections: p.connections, recent: p.recent, counts: p.counts, projects: p.projects.slice(0, 40).map(({ name, status }) => ({ name, status })) },
      gems, trending, sparks: sparks(p, gems, day + (Number(body.shuffle) || 0)),
      saved: conf.saved, dismissed: conf.dismissed.length, ideas: listIdeas(IDEAS, deps.rows?.() ?? [], conf.ideas),
      fetchedAt, stale, refreshing: !!refreshing, progress: refreshing ? progress : undefined, error: lastError || undefined, gh: !!deps.gh || ghAvailable(), login: cache.login,
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
      const all = Promise.all([
        ...queries.map((x) => search("repositories", `${x} archived:false fork:false`, ["per_page=15"])),
        ...keywords.slice(0, 2).map((k) => search("topics", k, ["per_page=6"])),
      ]);
      const results = await Promise.race([all, Bun.sleep(20_000).then(() => null)]);
      if (!results) throw new Error("GitHub is slow to answer right now. Try again in a moment.");
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

  /** The execution-ready plan fields of a saved build, cleaned (only what's there). */
  function planOf(m: any) {
    const str = (v: unknown, n: number) => (v == null || v === "" ? undefined : String(v).slice(0, n));
    const arr = (v: unknown, n: number, max: number) => (Array.isArray(v) && v.length ? v.slice(0, max).map((x) => String(x).slice(0, n)) : undefined);
    const out: Record<string, unknown> = {
      customer: str(m.customer, 200), problem: str(m.problem, 220), offer: str(m.offer, 220), price: str(m.price, 120), model: str(m.model, 60), cost: str(m.cost, 100), first_dollar: str(m.first_dollar, 80),
      money: str(m.money, 160), project: str(m.project, 80), row: str(m.row, 20), mvp: arr(m.mvp, 160, 6), launch: arr(m.launch, 220, 5), week: arr(m.week, 180, 7), risks: arr(m.risks, 180, 4), extra: arr(m.extra, 60, 3),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
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
      case "/api/discover/archive": return { ideas: archive.list({ limit: Number(body.limit) || 100, offset: Number(body.offset) || 0, all: !!body.all }), ...archive.count() };
      case "/api/discover/mix-ingredients": {
        const [r, engines] = await Promise.all([ingredients(Number(body.wait) || 2500), mixer.engines()]);
        return { ingredients: r.list, connLoading: r.connLoading, engines, kinds: KIND_LABEL };
      }
      case "/api/discover/mix": {
        const known = byId((await ingredients(800)).list);
        const chosen = (Array.isArray(body.ingredients) ? body.ingredients : []).slice(0, 16).map((x: any) => known.get(String(x?.id ?? "")) ?? sanitizeIngredient(x)).filter((x: Ingredient | undefined): x is Ingredient => !!x);
        const uniq = chosen.filter((x: Ingredient, i: number) => chosen.findIndex((y: Ingredient) => y.id === x.id) === i);
        if (uniq.length < 2) throw new Error("Pick at least two ingredients to mix");
        const engine = (["claude", "ollama", "template"].includes(body.engine) ? body.engine : "claude") as Engine;
        const direction = String(body.direction ?? "").trim().slice(0, 200);
        const model = engine === "ollama" && body.model ? String(body.model).slice(0, 80) : undefined;
        return body.peek ? mixer.peek(uniq, direction, engine, model) : mixer.mix(uniq, direction, engine, model, !!body.force);
      }
      case "/api/discover/feed": {
        if (body.op === "more") feed.more(body.row ? String(body.row) : undefined);
        else if (body.op === "refresh") feed.refresh();
        else feed.ensure();
        return feed.state();
      }
      case "/api/discover/studio": return studio.home(body);
      case "/api/discover/studio/convo": return studio.get(String(body.id ?? ""));
      case "/api/discover/studio/send": return studio.send(body);
      case "/api/discover/studio/status": return studio.status(String(body.job ?? ""));
      case "/api/discover/studio/stop": return studio.stop(String(body.job ?? ""));
      case "/api/discover/studio/rename": return studio.rename(String(body.id ?? ""), String(body.title ?? ""));
      case "/api/discover/studio/delete": return studio.remove(String(body.id ?? ""));
      case "/api/discover/studio/dice": return studio.dice(Number(body.seed), !!body.wild);
      case "/api/discover/studio/build-prompt": return studio.buildPrompt(body.build ?? {});
      case "/api/discover/mix-status": return mixer.status(String(body.id ?? ""));
      case "/api/discover/mix-cancel": return mixer.cancel(String(body.id ?? ""));
      case "/api/discover/mix-save": {
        const m = body.mix ?? {};
        const id = String(m.id ?? body.id ?? "");
        if (!/^[\w-]{1,40}$/.test(id)) throw new Error("Which mix?");
        if (body.op === "save") {
          const clean = (v: unknown, n: number) => String(v ?? "").slice(0, n);
          const keep = {
            id, title: clean(m.title, 90), pitch: clean(m.pitch, 260), ingredients: (m.ingredients ?? []).slice(0, 6).map((x: unknown) => clean(x, 80)), ids: (m.ids ?? []).slice(0, 6).map((x: unknown) => clean(x, 160)),
            how: (m.how ?? []).slice(0, 6).map((h: any) => ({ name: clean(h?.name, 80), role: clean(h?.role, 200) })), why_novel: clean(m.why_novel, 260), first_steps: (m.first_steps ?? []).slice(0, 3).map((x: unknown) => clean(x, 200)),
            difficulty: ["weekend", "week", "month"].includes(m.difficulty) ? m.difficulty : "week", wow: Math.max(1, Math.min(5, Number(m.wow) || 3)), source: ["claude", "ollama", "template"].includes(m.source) ? m.source : "template",
            direction: body.direction ? clean(body.direction, 200) : undefined, savedAt: Date.now(),
            // A Studio or feed build keeps its plan (customer, price, MVP, launch, first week…), so it stays ready to execute.
            ...planOf(m),
          } as DiscoverConf["mixes"] extends (infer T)[] | undefined ? T : never;
          conf.mixes = [keep, ...(conf.mixes ?? []).filter((x) => x.id !== id)].slice(0, 200);
        } else if (body.op === "unsave") conf.mixes = (conf.mixes ?? []).filter((x) => x.id !== id);
        else throw new Error("unknown op");
        saveConf();
        return { mixes: conf.mixes };
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
  // Leads (src/leads.ts) keeps its saved pains and ideas in discover.json too; this is its only door into it.
  const leadsSaved = { get: () => conf.leads ?? [], set: (v: any[]) => { conf.leads = v; saveConf(); } };
  return { handle, refresh, profile, state, ingredients, mixer, studio, feed, leadsSaved, archive, flush: () => { clearTimeout(cacheTimer); writeJson(CACHE, cache); mixer.flush(); feed.flush(); }, paths: { conf: CONF, cache: CACHE, ideas: IDEAS } };
}
