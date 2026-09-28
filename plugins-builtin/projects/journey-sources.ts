// Project pages, part 1b: the evidence beyond git (journey-collect.ts has git and the shared helpers): the wiki page
// and log, agent sessions, ideas and leads the deck saved, read-only GitHub and Gumroad numbers, and project folders.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { clip, hash, nameRe, norm, escRe, readText, mtimeOf, ls, run, type JEvent, type Series } from "./journey-collect";

const HOME = homedir();

// ── the wiki ─────────────────────────────────────────────────────────────────────
export type WikiData = {
  sig: string; page?: string; status?: string; tags: string[]; updated?: string; tldr?: string; firstPara?: string; next?: string[];
  sections: JEvent[]; log: JEvent[]; urls: string[]; parent?: string; children: string[]; related: string[];
};
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** A date in a heading: "(2026-09-26)", "2026-09-26", "26 September 2026", "September 26, 2026". Local midday, so time zones don't shift the day. */
export function headingDate(h: string): number | undefined {
  let m = h.match(/(\d{4})-(\d\d)-(\d\d)/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  m = h.match(/(\d{1,2}) (january|february|march|april|may|june|july|august|september|october|november|december) (\d{4})/i);
  if (m) return new Date(Number(m[3]), MONTHS.indexOf(m[2].toLowerCase()), Number(m[1]), 12).getTime();
  m = h.match(/(january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2}),? (\d{4})/i);
  if (m) return new Date(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]), 12).getTime();
  return undefined;
}
const unlink = (s: string) => s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
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
const LINEAGE = /(successor (?:to|of)|spun (?:off|out) (?:of|from)|spin-?off (?:of|from)|forked from|grew out of|extracted from|split (?:off |out )?from|evolved from|based on|built on|replaces|replacing|rebuild of|v2 of)\s+(?:the\s+)?\[\[([^\]|]+)/i;

/** A wiki page: status, tags, TLDR, dated sections (each a point on the timeline), "Next", URLs, lineage. */
export function parseWikiPage(name: string, text: string): Omit<WikiData, "sig" | "log" | "children"> {
  const { data, body } = frontmatter(text);
  const lines = body.split(/\r?\n/);
  const tldr = unlink(lines.map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "");
  const sections: JEvent[] = [];
  let next: string[] | undefined;
  let whatIs = "";
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##+\s+(.+?)\s*$/);
    if (!h) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j++) body.push(lines[j]);
    const text = unlink(body.join(" ").replace(/\s+/g, " ").trim());
    const t = headingDate(h[1]);
    const title = unlink(h[1]).replace(/\s*\((?:added |updated |verified )?[^)]*\d{4}[^)]*\)\s*$/i, "").replace(/\s*[—–-]\s*\d{1,2} \w+ \d{4}$/, "").trim();
    if (t) sections.push({ id: `w${hash(h[1])}`, t, kind: "wiki", title: clip(title, 90), detail: clip(text, 320), weight: 4 + Math.min(3, text.length / 600), link: { wiki: name } });
    if (/^next\b/i.test(h[1])) next = body.map((l) => l.match(/^\s*[-*]\s+(.+)/)?.[1]).filter(Boolean).map((x) => clip(unlink(x!), 200)).slice(0, 6);
    if (!whatIs && /^(what it is|why it exists|overview|summary)/i.test(h[1])) whatIs = clip(text, 400);
  }
  const urls = [...new Set([...body.matchAll(/https?:\/\/[^\s)>\]`"']+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))].filter((u) => !/github\.com|localhost|127\.0\.0\.1|claude\.ai\/(artifact|code)/.test(u)).slice(0, 12);
  const lin = body.match(LINEAGE);
  const related = [...new Set([...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()))].filter((x) => x !== name).slice(0, 40);
  return { page: name, status: data.status, tags: Array.isArray(data.tags) ? data.tags : [], updated: data.date_updated, tldr: clip(tldr, 400), firstPara: whatIs || undefined, next, sections, urls, parent: lin?.[2]?.trim(), related };
}

/** log.md entries (`## [YYYY-MM-DD] action | title` + body) that name the project. */
export function parseWikiLog(text: string, name: string): JEvent[] {
  const re = nameRe(name);
  const link = new RegExp(`\\[\\[${escRe(name)}(\\||\\]\\])`, "i");
  const out: JEvent[] = [];
  const parts = text.split(/^(?=## \[\d{4}-\d\d-\d\d\])/m);
  for (const p of parts) {
    const m = p.match(/^## \[(\d{4})-(\d\d)-(\d\d)\]\s*([^|\n]*)\|\s*(.+)$/m);
    if (!m) continue;
    const title = m[5].trim();
    const body = p.slice(p.indexOf("\n") + 1).trim();
    if (!re.test(title) && !link.test(body) && !re.test(body.slice(0, 300))) continue;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
    const action = m[4].trim();
    out.push({ id: `l${hash(m[0])}`, t, kind: "log", title: clip(unlink(title).replace(new RegExp(`^${escRe(name)}\\s*[—–-]\\s*`, "i"), ""), 120), detail: body ? clip(unlink(body), 300) : undefined, weight: action === "ingest" ? 4 : 3, link: { wiki: "log" } });
  }
  return out;
}

export async function collectWiki(wikiDir: string, name: string): Promise<WikiData> {
  const pagePath = `${wikiDir}/projects/${name}.md`;
  const logPath = `${wikiDir}/log.md`;
  const sig = hash([mtimeOf(pagePath), mtimeOf(logPath), mtimeOf(`${wikiDir}/projects`)].join(":"));
  const [pageText, logText] = await Promise.all([Bun.file(pagePath).text().catch(() => ""), Bun.file(logPath).text().catch(() => "")]);
  const page = pageText ? parseWikiPage(name, pageText) : { tags: [], sections: [], urls: [], related: [] as string[] };
  // Spin-offs: other project pages that say they grew out of this one.
  const children: string[] = [];
  const target = new RegExp(`\\[\\[${escRe(name)}(\\||\\]\\])`, "i");
  for (const f of ls(`${wikiDir}/projects`)) {
    if (!f.endsWith(".md") || f === `${name}.md`) continue;
    const t = readText(`${wikiDir}/projects/${f}`);
    if (!target.test(t)) continue;
    const lin = t.match(LINEAGE);
    if (lin && lin[2].trim().toLowerCase() === name.toLowerCase()) children.push(f.slice(0, -3));
  }
  return { sig, ...page, log: logText ? parseWikiLog(logText, name) : [], children };
}

// ── sessions ─────────────────────────────────────────────────────────────────────
export type SessRec = { key: string; id: string; agent: string; machine?: string; title: string; first?: string; started?: number; last?: number; asks?: number; cwd?: string; root?: string; project?: string; status?: string; live?: boolean; branch?: string; mention?: boolean };
/** A worktree folder's name: ".../.claude/worktrees/deck-mix/src" → "deck-mix". */
export const worktreeOf = (cwd = "") => cwd.match(/\/(?:\.claude\/worktrees|\.worktrees|worktrees)\/([^/]+)/)?.[1];
/** Agent time a session represents: its span, capped by how much you asked (≈20 min a prompt) and at 8 hours. */
export const agentMs = (s: SessRec) => { const span = Math.max(0, (s.last ?? 0) - (s.started ?? s.last ?? 0)); return Math.min(span, Math.max(1, s.asks ?? 1) * 20 * 60_000, 8 * 3600_000); };

export function sessionEvents(ss: SessRec[]): JEvent[] {
  return ss.filter((s) => s.started || s.last).map((s) => ({
    id: `s${hash(s.key)}`, t: s.started ?? s.last!, end: s.last, kind: "session" as const, title: clip(s.title || s.first || "(untitled session)", 100),
    detail: s.first ? clip(s.first, 280) : undefined, n: s.asks, weight: Math.max(1, Math.min(8, 1 + Math.log2(1 + (s.asks ?? 1)) * 1.3)) * (s.mention ? 0.6 : 1),
    link: { session: s.key, machine: s.machine },
  }));
}

// ── ideas and leads the deck saved ───────────────────────────────────────────────
export function collectNotes(dataDir: string, name: string): JEvent[] {
  const re = nameRe(name);
  const out: JEvent[] = [];
  for (const [dir, kind] of [["ideas", "idea"], ["leads", "lead"], ["handoffs", "idea"]] as const) {
    for (const f of ls(`${dataDir}/${dir}`)) {
      if (!/\.(md|json|txt)$/.test(f)) continue;
      const p = `${dataDir}/${dir}/${f}`;
      const text = readText(p).slice(0, 200_000);
      if (!re.test(text) && !re.test(f.replace(/\.\w+$/, ""))) continue;
      const { data, body } = frontmatter(text);
      const title = data.title || body.match(/^#\s+(.+)$/m)?.[1] || f.replace(/\.\w+$/, "").replace(/[-_]+/g, " ");
      const t = Date.parse(String(data.created ?? data.date ?? "")) || mtimeOf(p);
      out.push({ id: `${kind[0]}${hash(p)}`, t, kind, title: clip(`${dir === "handoffs" ? "Handoff" : kind === "idea" ? "Plan" : "Leads"}: ${unlink(String(title))}`, 110), detail: clip(unlink(body.replace(/^#.*$/gm, "")), 260), weight: 4, link: { file: p.replace(HOME, "~") } });
    }
  }
  return out;
}

// ── GitHub (read-only, through `gh`) ───────────────────────────────────────────────
export type GhData = { at: number; ok: boolean; error?: string; repo: string; url?: string; homepage?: string; private?: boolean; stars: number; forks: number; watchers: number; openIssues: number; externalStars: Series; externalIssues: Series; releases: JEvent[]; owner?: string };
const GH_BIN = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", `${HOME}/.local/bin/gh`].find((p) => existsSync(p));
export async function collectGitHub(repo: string, ghRun: (args: string[]) => Promise<{ ok: boolean; out: string; err: string }> = (a) => GH_BIN ? run([GH_BIN, ...a], { timeoutMs: 15_000 }) : Promise.resolve({ ok: false, out: "", err: "gh isn't installed" })): Promise<GhData> {
  const base: GhData = { at: Date.now(), ok: false, repo, stars: 0, forks: 0, watchers: 0, openIssues: 0, externalStars: [], externalIssues: [], releases: [] };
  const info = await ghRun(["api", `repos/${repo}`]);
  if (!info.ok) return { ...base, error: clip(info.err || "gh api failed", 160) };
  let j: any; try { j = JSON.parse(info.out); } catch { return { ...base, error: "unreadable reply" }; }
  const owner = String(j.owner?.login ?? repo.split("/")[0]);
  const [rel, stars, issues] = await Promise.all([
    ghRun(["api", `repos/${repo}/releases?per_page=30`]),
    ghRun(["api", "-H", "Accept: application/vnd.github.star+json", `repos/${repo}/stargazers?per_page=100`]),
    ghRun(["api", `repos/${repo}/issues?state=all&per_page=100`]),
  ]);
  const parse = (r: { ok: boolean; out: string }) => { try { return r.ok ? JSON.parse(r.out) : []; } catch { return []; } };
  const cum = (ts: number[]): Series => ts.sort((a, b) => a - b).map((t, i) => [t, i + 1]);
  const releases: JEvent[] = (parse(rel) as any[]).filter((r) => r?.published_at).map((r) => ({ id: `r${hash(String(r.id ?? r.tag_name))}`, t: Date.parse(r.published_at), kind: "release" as const, title: `Released ${clip(r.name || r.tag_name, 60)}`, detail: r.body ? clip(r.body, 240) : undefined, weight: 7, link: { url: r.html_url } }));
  const ext = (parse(stars) as any[]).filter((s) => s?.user?.login && s.user.login !== owner).map((s) => Date.parse(s.starred_at)).filter(Number.isFinite);
  const extIssues = (parse(issues) as any[]).filter((i) => i?.user?.login && i.user.login !== owner && !i.pull_request).map((i) => Date.parse(i.created_at)).filter(Number.isFinite);
  return { ...base, ok: true, url: j.html_url, homepage: j.homepage || undefined, private: !!j.private, stars: Number(j.stargazers_count ?? 0), forks: Number(j.forks_count ?? 0), watchers: Number(j.subscribers_count ?? j.watchers_count ?? 0), openIssues: Number(j.open_issues_count ?? 0), externalStars: cum(ext), externalIssues: cum(extIssues), releases, owner };
}

// ── Gumroad (read-only; the token never leaves this function) ─────────────────────────
export type GumroadData = { at: number; ok: boolean; error?: string; products: string[]; sales: number; revenue: number; currency: string; series: Series; salesSeries: Series };
/** The access token the user's Gumroad MCP server is configured with, if any. Read on demand, never kept. */
function gumroadToken(): string | undefined {
  if (process.env.DECK_NO_GUMROAD) return;
  try {
    const j = JSON.parse(readFileSync(`${HOME}/.claude.json`, "utf8"));
    const servers = [j.mcpServers, ...Object.values(j.projects ?? {}).map((p: any) => p?.mcpServers)].filter(Boolean);
    for (const s of servers) { const t = s?.gumroad?.env?.GUMROAD_ACCESS_TOKEN; if (typeof t === "string" && t.length > 10) return t; }
  } catch {}
}
export const gumroadConfigured = () => !!gumroadToken();
/** Whether a Gumroad product belongs to the project: its name contains the project's, or the project's wiki page names it. */
export function productMatches(product: string, project: string, pageText = "") {
  const p = norm(product), n = norm(project);
  if (!p || !n) return false;
  if (p.includes(n) || (p.length >= 5 && n.includes(p))) return true;
  const text = pageText.toLowerCase(), full = product.trim().toLowerCase();
  if (full.length >= 6 && text.includes(full)) return true;
  // "2027 Prophecy: The Founding Reading" → the brand, "2027 prophecy", named on the page more than once.
  const brand = full.split(/\s*[:|—–]\s*|\s+-\s+/)[0].trim();
  return brand !== full && brand.length >= 8 && text.split(brand).length - 1 >= 2;
}
export async function collectGumroad(project: string, pageText: string, fetcher: typeof fetch = fetch, tokenOverride?: string): Promise<GumroadData | undefined> {
  const token = tokenOverride ?? gumroadToken();
  if (!token) return;
  const base: GumroadData = { at: Date.now(), ok: false, products: [], sales: 0, revenue: 0, currency: "usd", series: [], salesSeries: [] };
  const get = async (path: string) => {
    const r = await fetcher(`https://api.gumroad.com/v2/${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`Gumroad said ${r.status}`);
    return j;
  };
  try {
    const prods: any[] = (await get("products")).products ?? [];
    const mine = prods.filter((p) => productMatches(String(p.name ?? ""), project, pageText));
    if (!mine.length) return { ...base, ok: true };
    const sales: { t: number; cents: number }[] = [];
    let currency = "usd";
    for (const p of mine.slice(0, 5)) {
      let key: string | undefined;
      for (let page = 0; page < 10; page++) {
        const j = await get(`sales?product_id=${encodeURIComponent(p.id)}${key ? `&page_key=${encodeURIComponent(key)}` : ""}`);
        for (const s of j.sales ?? []) { if (s.refunded || s.chargedback) continue; sales.push({ t: Date.parse(s.created_at), cents: Number(s.price ?? 0) }); currency = s.currency ?? currency; }
        key = j.next_page_key;
        if (!key) break;
      }
    }
    sales.sort((a, b) => a.t - b.t);
    let sum = 0;
    const series: Series = sales.map((s) => [s.t, (sum += s.cents) / 100]);
    return { ...base, ok: true, products: mine.map((p) => clip(p.name, 60)), sales: sales.length, revenue: sum / 100, currency, series, salesSeries: sales.map((s, i) => [s.t, i + 1]) };
  } catch (e: any) { return { ...base, error: clip(e?.message ?? "Gumroad failed", 120) }; }
}

// ── where a project lives ───────────────────────────────────────────────────────────
export function projectDirs(projectsDir: string): string[] {
  return ls(projectsDir).filter((d) => !d.startsWith(".") && existsSync(`${projectsDir}/${d}/.git`)).map((d) => `${projectsDir}/${d}`);
}
export const baseName = (p: string) => basename(p);
