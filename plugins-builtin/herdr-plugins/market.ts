// The herdr plugin marketplace (herdr.dev/plugins), read-only. The site itself reads one JSON file,
// assets.herdr.dev/plugins/index.json: every public GitHub repo tagged `herdr-plugin` with a parseable
// herdr-plugin.toml, refreshed every 30 minutes, with stars, last push, the default branch's head commit and each
// manifest's id, version, platforms and min_herdr_version. We keep it 30 minutes too. If it can't be read we fall back
// to GitHub's search (topic:herdr-plugin) through `gh`. A manifest's commands come from the repo at that exact commit.
import { gh } from "../../src/gh";

export const INDEX_URL = "https://assets.herdr.dev/plugins/index.json";
const TTL = 30 * 60_000;

export type MManifest = { path: string; id: string; name: string; version: string; minHerdrVersion?: string; description?: string; platforms?: string[] };
export type Repo = {
  fullName: string; owner: string; name: string; description?: string; url: string; stars: number; starsDelta30d?: number;
  language?: string; pushedAt?: string; createdAt?: string; firstSeenAt?: string; headCommit?: string; manifests: MManifest[];
};
export type Detail = {
  id: string; name: string; version: string; minHerdrVersion?: string; platforms?: string[]; description?: string; lines: number;
  build: string[][]; startup: string[][]; events: { on: string; command: string[] }[]; actions: { id: string; title: string; contexts?: string[]; command: string[] }[];
  panes: { id: string; title: string; command: string[] }[]; linkHandlers: { id: string; title: string; pattern: string }[];
};
export type Commit = { sha: string; date?: string; message?: string; author?: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function createMarket(o: { fetch?: Fetch; now?: () => number } = {}) {
  const get: Fetch = o.fetch ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(20_000) }));
  const now = o.now ?? Date.now;
  let cache: { at: number; repos: Repo[]; source: string; generatedAt?: string } | undefined;
  let loading: Promise<typeof cache> | undefined;
  const manifests = new Map<string, Promise<Detail>>();
  const commits = new Map<string, Promise<Commit>>();

  async function load(force = false) {
    if (cache && !force && now() - cache.at < TTL) return cache;
    loading ??= (async () => {
      try {
        const r = await get(INDEX_URL);
        if (!r.ok) throw new Error(`the index said ${r.status}`);
        const d: any = await r.json();
        cache = { at: now(), repos: (d.plugins ?? []).filter((p: any) => p.manifests?.length), source: "herdr.dev", generatedAt: d.generatedAt };
      } catch (e) {
        const s = await gh(["search/repositories?q=topic:herdr-plugin+is:public+fork:false&sort=stars&per_page=100"]);
        if (!s.ok) { if (cache) return cache; throw new Error(`Couldn't read the marketplace (${(e as Error).message}; GitHub: ${s.error})`); }
        cache = { at: now(), source: "github", repos: (s.data.items ?? []).map(fromSearch) };
      }
      return cache;
    })().finally(() => { loading = undefined; });
    return (await loading)!;
  }

  /** Repos matching every word of `q` (name, owner, description, plugin ids and names, topics), sorted. */
  async function search(q = "", sort = "popular", limit = 40) {
    const c = await load();
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (r: Repo) => [r.fullName, r.description, ...r.manifests.flatMap((m) => [m.id, m.name, m.description]), ...((r as any).topics ?? [])].join(" ").toLowerCase();
    const hit = words.length ? c.repos.filter((r) => { const h = hay(r); return words.every((w) => h.includes(w)); }) : c.repos;
    const by: Record<string, (a: Repo, b: Repo) => number> = {
      popular: (a, b) => b.stars - a.stars,
      active: (a, b) => time(b.pushedAt) - time(a.pushedAt),
      new: (a, b) => time(b.firstSeenAt ?? b.createdAt) - time(a.firstSeenAt ?? a.createdAt),
      rising: (a, b) => (b.starsDelta30d ?? 0) - (a.starsDelta30d ?? 0),
    };
    const list = [...hit].sort(by[sort] ?? by.popular);
    return { total: list.length, all: c.repos.length, source: c.source, generatedAt: c.generatedAt, repos: list.slice(0, Math.min(100, limit)).map(slim) };
  }

  /** A manifest at the repo's indexed commit, parsed: every command it will run, verbatim. Cached per commit. */
  function manifest(fullName: string, path: string, commit: string): Promise<Detail> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName) || !/^[0-9a-f]{40}$/.test(commit) || !/^([\w.-]+\/)*herdr-plugin\.toml$/.test(path) || path.includes("..")) return Promise.reject(new Error("Bad manifest address"));
    const k = `${fullName}@${commit}/${path}`;
    if (!manifests.has(k)) {
      const p = (async () => {
        const r = await get(`https://raw.githubusercontent.com/${fullName}/${commit}/${path}`);
        if (!r.ok) throw new Error(`GitHub said ${r.status} for ${path}`);
        return parseManifest(await r.text());
      })();
      p.catch(() => manifests.delete(k));
      if (manifests.size > 300) manifests.delete(manifests.keys().next().value!);
      manifests.set(k, p);
    }
    return manifests.get(k)!;
  }

  /** The commit an install would pin: date, author and message (through `gh`; empty when it can't say). */
  function commit(fullName: string, sha: string): Promise<Commit> {
    const k = `${fullName}@${sha}`;
    if (!commits.has(k)) {
      const p = gh([`repos/${fullName}/commits/${sha}`]).then((r) => ({ sha, date: r.data?.commit?.committer?.date, message: r.data?.commit?.message?.split("\n")[0], author: r.data?.commit?.author?.name ?? r.data?.author?.login }));
      commits.set(k, p);
    }
    return commits.get(k)!;
  }

  /** A few to start with, with the facts behind each pick: well starred, pushed in the last month, and a manifest short
   *  enough to read in a minute (few commands, no or a small build step). Popularity is only what the index says. */
  async function recommended(skip: string[] = [], n = 6) {
    const c = await load();
    const month = now() - 30 * 86_400_000;
    const pool = c.repos
      .filter((r) => r.headCommit && r.manifests.length === 1 && time(r.pushedAt) > month && r.stars >= 20 && !skip.includes(r.manifests[0].id))
      .sort((a, b) => score(b) - score(a)).slice(0, 18);
    const out: (ReturnType<typeof slim> & { why: string[]; detail: Detail })[] = [];
    const details = await Promise.all(pool.map((r) => manifest(r.fullName, r.manifests[0].path, r.headCommit!).catch(() => undefined)));
    pool.forEach((r, i) => {
      const d = details[i];
      if (!d || out.length >= n) return;
      const runs = d.build.length + d.startup.length + d.events.length;
      if (d.lines > 160 || d.build.length > 2 || runs > 8) return;
      const why = [
        `${r.stars.toLocaleString("en")} stars${r.starsDelta30d ? `, ${r.starsDelta30d} of them this month` : ""}`,
        `last push ${ago(r.pushedAt!, now())}`,
        `${d.lines}-line manifest: ${[plural(d.actions.length, "action"), d.events.length && plural(d.events.length, "event hook"), d.panes.length && plural(d.panes.length, "pane"), d.build.length ? plural(d.build.length, "build step") : "no build step", d.startup.length && plural(d.startup.length, "startup command")].filter(Boolean).join(", ")}`,
      ];
      out.push({ ...slim(r), why, detail: d });
    });
    return out;
  }

  return { load, search, manifest, commit, recommended };
}
export type Market = ReturnType<typeof createMarket>;

/** herdr-plugin.toml → the parts that run code, as argv arrays exactly as written. Bun parses the TOML. */
export function parseManifest(text: string): Detail {
  const t: any = Bun.TOML.parse(text);
  const argv = (x: any) => (Array.isArray(x?.command) ? x.command.map(String) : []);
  return {
    id: String(t.id ?? ""), name: String(t.name ?? t.id ?? ""), version: String(t.version ?? ""), minHerdrVersion: t.min_herdr_version, platforms: t.platforms, description: t.description,
    lines: text.trimEnd().split("\n").length,
    build: (t.build ?? []).map(argv), startup: (t.startup ?? []).map(argv),
    events: (t.events ?? []).map((e: any) => ({ on: String(e.on ?? ""), command: argv(e) })),
    actions: (t.actions ?? []).map((a: any) => ({ id: String(a.id ?? ""), title: String(a.title ?? a.id ?? ""), contexts: a.contexts, command: argv(a) })),
    panes: (t.panes ?? []).map((p: any) => ({ id: String(p.id ?? ""), title: String(p.title ?? p.id ?? ""), command: argv(p) })),
    linkHandlers: (t.link_handlers ?? []).map((l: any) => ({ id: String(l.id ?? ""), title: String(l.title ?? ""), pattern: String(l.pattern ?? "") })),
  };
}

const time = (s?: string) => (s ? Date.parse(s) || 0 : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const score = (r: Repo) => Math.log10(r.stars + 1) * 2 + Math.log10((r.starsDelta30d ?? 0) + 1);
export function ago(iso: string, now = Date.now()) {
  const d = Math.max(0, Math.floor((now - time(iso)) / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "yesterday" : d < 45 ? `${d} days ago` : `${Math.round(d / 30)} months ago`;
}
/** What the page needs of a repo (the index carries more). */
const slim = (r: Repo) => ({
  fullName: r.fullName, url: r.url, description: r.description, stars: r.stars, starsDelta30d: r.starsDelta30d, language: r.language, pushedAt: r.pushedAt, headCommit: r.headCommit,
  manifests: r.manifests.map((m) => ({ path: m.path, id: m.id, name: m.name, version: m.version, minHerdrVersion: m.minHerdrVersion, platforms: m.platforms, description: m.description })),
});
/** GitHub search results carry no manifest info: assume one manifest at the root, confirmed when its detail loads. */
const fromSearch = (x: any): Repo => ({
  fullName: x.full_name, owner: x.owner?.login, name: x.name, description: x.description ?? undefined, url: x.html_url, stars: x.stargazers_count ?? 0,
  language: x.language ?? undefined, pushedAt: x.pushed_at, createdAt: x.created_at,
  manifests: [{ path: "herdr-plugin.toml", id: x.full_name, name: x.name, version: "" }],
});
