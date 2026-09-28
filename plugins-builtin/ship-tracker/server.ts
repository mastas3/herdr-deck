// Ship tracker: started vs shipped, per project. Reads the wiki's project pages (status, path), each repo's git
// (last commit, commits in 14 days, newest release tag) and the deck's session history (agent sessions in 14 days),
// all read-only. The Shipped view lists projects by days since they last shipped and flags the busy ones that
// haven't; on Mondays the morning digest gets one line for the week.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Host } from "../../src/plugin-api";
import { parsePage, shipRows, weeklyLine, type Facts, type Page } from "./ship-core";

const DAY = 86400_000;
const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

async function git(repo: string, ...a: string[]) {
  const p = Bun.spawn(["git", "-C", repo, ...a], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const t = setTimeout(() => p.kill(), 8000);
  const out = await new Response(p.stdout).text(); await p.exited; clearTimeout(t);
  return p.exitCode === 0 ? out.trim() : undefined;
}
/** Runs fn over items, n at a time. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export function activate(host: Host) {
  const wiki = () => host.env("DECK_WIKI_DIR") || join(homedir(), "wiki");
  let cache: { at: number; data: any } | undefined, running: Promise<any> | undefined;

  function pages(): Page[] {
    const dir = join(wiki(), "projects");
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { return []; }
    return files.map((f) => { try { return parsePage(f.slice(0, -3), readFileSync(join(dir, f), "utf8")); } catch { return undefined; } }).filter(Boolean) as Page[];
  }
  async function facts(p: Page, now: number): Promise<Facts> {
    const f: Facts = {};
    const repo = p.path ? expand(p.path) : undefined;
    if (repo && existsSync(join(repo, ".git"))) {
      f.lastCommit = Number(await git(repo, "log", "-1", "--format=%ct")) * 1000 || undefined;
      f.commits14 = Number(await git(repo, "rev-list", "--count", "--since=14.days", "HEAD")) || 0;
      const t = (await git(repo, "for-each-ref", "--sort=-creatordate", "--count=1", "--format=%(refname:short)%09%(creatordate:unix)", "refs/tags"))?.split("\t");
      if (t?.[0]) { f.tag = t[0]; f.tagAt = Number(t[1]) * 1000 || undefined; }
    }
    // Agent sessions in the last 14 days, from the history search (every machine) by the project's folder name.
    const name = repo ? basename(repo) : p.slug;
    const since = now - 14 * DAY;
    try {
      const hist = await host.history({ project: name, limit: 200 });
      f.sessions14 = hist.filter((s) => (s.last ?? 0) >= since).length;
    } catch { f.sessions14 = 0; }
    f.live = host.rows().filter((r) => (repo && r.projectRoot === repo) || r.project === name).length;
    return f;
  }
  async function build() {
    const now = Date.now();
    const ps = pages();
    const all = await pool(ps, 4, async (p) => ({ ...p, ...(await facts(p, now)) }));
    const rows = shipRows(all, now, { busyAt: Number(host.setting("busyAt")) || 5, staleDays: Number(host.setting("staleDays")) || 30 });
    return { at: now, wiki: wiki(), rows, week: weeklyLine(rows, now), counts: Object.fromEntries([...new Set(rows.map((r) => r.status))].map((s) => [s, rows.filter((r) => r.status === s).length])) };
  }
  /** Fresh for 10 minutes; one build at a time. */
  async function get(force = false) {
    if (!force && cache && Date.now() - cache.at < 10 * 60_000) return cache.data;
    running ??= build().then((data) => { cache = { at: Date.now(), data }; return data; }).finally(() => { running = undefined; });
    return running;
  }

  host.extend("digest.lines", { title: "Shipping this week", pref: "shipDigest", lines: async () => (new Date().getDay() === 1 ? [(await get()).week] : []) });
  host.routes("ship-tracker", async ({ path, body }) => {
    if (path !== "/api/ship-tracker") return undefined;
    try { return await get(body?.force === true); }
    catch (e: any) { return Response.json({ error: e?.message ?? String(e) }, { status: 400 }); }
  });
}
