// Project pages, part 1: the evidence. Every collector reads local files or runs a short-lived subprocess with a
// time limit (git, gh), so nothing here blocks the server's event loop. Each one returns plain data; the journey
// model (journey.ts) stitches it together and the page draws it.
//
// Privacy: collectors read commit subjects, wiki headings and TLDRs, session titles and first prompts, idea/lead
// file titles, and aggregated counts from GitHub and Gumroad. Nothing here sends anything anywhere except the
// read-only `gh api` and Gumroad calls, and the Gumroad token is read in this process only, never stored or shown.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const HOME = homedir();
const DAY = 86_400_000;

// ── small helpers ────────────────────────────────────────────────────────────────
/** FNV-1a: short stable ids for events, so AI labels keep pointing at the same points across rebuilds. */
export function hash(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
export const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").replace(/\/(?:Users|home)\/[^/\s]+/g, "~").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The project's name as a whole word ("hd-atlas" but not "hd-atlas-v2" or "myhd-atlas"). */
export function nameRe(name: string) { return new RegExp(`(^|[^\\w-])${escRe(name.toLowerCase())}(?![\\w]|-[a-z0-9])`, "i"); }
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const mtimeOf = (p: string) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };
export const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Runs a command with a time limit; never throws. */
export async function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<{ ok: boolean; out: string; err: string; code: number }> {
  try {
    const p = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...opts.env } });
    const timer = setTimeout(() => { try { p.kill(9); } catch {} }, opts.timeoutMs ?? 15_000);
    const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
    await p.exited;
    clearTimeout(timer);
    return { ok: p.exitCode === 0, out, err, code: p.exitCode ?? -1 };
  } catch (e: any) { return { ok: false, out: "", err: String(e?.message ?? e), code: -1 }; }
}

// ── shared types ─────────────────────────────────────────────────────────────────
export type Link = { session?: string; machine?: string; commit?: string; wiki?: string; url?: string; file?: string; branch?: string };
export type EventKind = "commits" | "merge" | "session" | "wiki" | "log" | "tag" | "release" | "deploy" | "idea" | "lead" | "manual" | "milestone";
export type JEvent = {
  id: string; t: number; end?: number; kind: EventKind; title: string; detail?: string; items?: string[];
  n?: number; weight: number; lane?: string; link?: Link;
};
export type Series = [number, number][]; // [time, cumulative value]
export type Metric = { key: string; label: string; unit?: string; value: number; at?: number; series?: Series; evidence: string; link?: Link };

// ── git ──────────────────────────────────────────────────────────────────────────
export type Commit = { sha: string; parents: string[]; t: number; email: string; author: string; refs: string; subject: string; lines: number; files: number };
export type SideQuestRaw = { id: string; label: string; kind: "branch" | "worktree" | "session" | "spinoff"; branch?: string; from: number; to: number; status: "merged" | "active" | "abandoned" | "spun-off"; commits: string[]; sessions: string[]; subjects: string[]; mergeSha?: string; note?: string };
export type GitData = {
  sig: string; root: string; defaultBranch: string; branch?: string; head?: string; dirty: number; remote?: string; github?: string;
  commits: number; first?: { sha: string; t: number; subject: string }; last?: { sha: string; t: number; subject: string };
  mainChunks: JEvent[]; merges: JEvent[]; tags: JEvent[]; quests: SideQuestRaw[];
  authors: { email: string; name: string; n: number; first: number }[];
  commitTimes: number[]; // every commit's time, for the cumulative series and sparklines
  activeDays: string[];
  deploys: JEvent[]; deployFiles: string[];
};

const SEP_REC = "\x1e", SEP_F = "\x1f";
/** Parses `git log --format=%x1e%H%x1f%P%x1f%at%x1f%ae%x1f%an%x1f%D%x1f%s --shortstat`. */
export function parseGitLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split(SEP_REC)) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf("\n");
    const head = nl < 0 ? rec : rec.slice(0, nl);
    const rest = nl < 0 ? "" : rec.slice(nl + 1);
    const [sha, parents, at, email, author, refs, ...subj] = head.split(SEP_F);
    if (!sha || !/^[0-9a-f]{7,}$/.test(sha)) continue;
    // --shortstat ("3 files changed, 10 insertions(+)") or --name-only (one path per line: much cheaper on big repos).
    const stat = rest.match(/(\d+) files? changed/);
    const ins = Number(rest.match(/(\d+) insertions?/)?.[1] ?? 0), del = Number(rest.match(/(\d+) deletions?/)?.[1] ?? 0);
    const files = stat ? Number(stat[1]) : rest.split("\n").filter((l) => l.trim()).length;
    commits.push({ sha, parents: parents ? parents.split(" ").filter(Boolean) : [], t: Number(at) * 1000, email: email ?? "", author: author ?? "", refs: refs ?? "", subject: subj.join(SEP_F).trim(), lines: ins + del, files });
  }
  return commits;
}

/** "Merge branch 'deck-mix'", "Merge pull request #3 from me/feat-x", "Merge remote-tracking branch 'origin/y'" → the branch. */
export function mergedBranchName(subject: string): string | undefined {
  const m = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/) ?? subject.match(/^Merge pull request #\d+ from [^/\s]+\/(\S+)/) ?? subject.match(/^Merge branch "([^"]+)"/) ?? subject.match(/^Merge (\S+) into /);
  return m?.[1]?.replace(/^origin\//, "");
}
/** "worktree-agent-a1b2c3" → "agent a1b2c3"; "feat/payments-v2" → "payments v2". */
export function branchLabel(b: string): string {
  const s = b.replace(/^(origin|upstream)\//, "").replace(/^refs\/(heads|remotes)\//, "").replace(/^(feat|feature|fix|chore|wip|exp|claude|codex)[/-]/i, "").replace(/^worktree-/, "");
  return s.replace(/[-_/]+/g, " ").trim() || b;
}

const chunkTitle = (cs: Commit[]) => {
  const real = cs.filter((c) => c.parents.length < 2);
  const pick = (real.length ? real : cs).slice().sort((a, b) => b.lines - a.lines || b.files - a.files || b.subject.length - a.subject.length)[0];
  return pick?.subject ?? "";
};
const commitWeight = (n: number, lines: number, files = 0) => Math.max(1, Math.min(10, 1 + Math.log2(1 + n) * 1.4 + Math.log10(1 + lines) * 0.9 + Math.log2(1 + files) * 0.35));

/**
 * Main-line commits grouped into sittings: a new chunk on a new day, after a pause, or when one gets big. The pause
 * scales with the project's span (a project built in one day still gets a readable handful of chunks).
 */
export function chunkCommits(cs: Commit[], opts: { gapMs?: number; maxPer?: number } = {}): JEvent[] {
  const sorted = cs.slice().sort((a, b) => a.t - b.t);
  if (!sorted.length) return [];
  const span = sorted[sorted.length - 1].t - sorted[0].t;
  const gapMs = opts.gapMs ?? Math.max(30 * 60_000, Math.min(4 * 3600_000, span / 40));
  const maxPer = opts.maxPer ?? 12;
  const out: Commit[][] = [];
  for (const c of sorted) {
    const cur = out[out.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && dayKey(prev.t) === dayKey(c.t) && c.t - prev.t < gapMs && cur.length < maxPer) cur.push(c);
    else out.push([c]);
  }
  return out.map((g) => {
    const lines = g.reduce((n, c) => n + c.lines, 0), files = g.reduce((n, c) => n + c.files, 0);
    return {
      id: `c${g[0].sha.slice(0, 8)}`, t: g[0].t, end: g[g.length - 1].t, kind: "commits" as const,
      title: clip(chunkTitle(g), 110), items: g.map((c) => clip(c.subject, 120)).slice(0, 14), n: g.length,
      detail: `${g.length} commit${g.length === 1 ? "" : "s"}${lines ? ` · ${lines.toLocaleString("en")} lines changed` : files ? ` · ${files.toLocaleString("en")} file changes` : ""}`,
      weight: commitWeight(g.length, lines, files), link: { commit: g[g.length - 1].sha },
    };
  });
}

/**
 * Splits the graph into the main line (first-parent history of the default branch) and side quests:
 * every merged branch (the commits a merge brought in) and every branch that never merged.
 */
export function splitHistory(commits: Commit[], tip: string | undefined, branches: { name: string; sha: string; t: number }[], now = Date.now()) {
  const by = new Map(commits.map((c) => [c.sha, c]));
  const chain: Commit[] = [];
  for (let c = tip ? by.get(tip) : undefined; c; c = c.parents[0] ? by.get(c.parents[0]) : undefined) chain.push(c);
  chain.reverse();
  const seen = new Set<string>();
  const quests: SideQuestRaw[] = [];
  const walk = (start: string, into: Commit[]) => {
    const stack = [start];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      const c = by.get(s);
      if (!c) continue;
      seen.add(s);
      into.push(c);
      for (const p of c.parents) stack.push(p);
    }
  };
  for (const c of chain) {
    // Ancestors of the previous main commit are all in `seen`; what the second parent adds is the side quest.
    if (c.parents.length >= 2) {
      const side: Commit[] = [];
      for (const p of c.parents.slice(1)) walk(p, side);
      if (side.length) {
        const name = mergedBranchName(c.subject);
        side.sort((a, b) => a.t - b.t);
        quests.push({ id: `q${c.sha.slice(0, 8)}`, label: name ? branchLabel(name) : clip(side[0].subject, 40), kind: "branch", branch: name, from: side[0].t, to: c.t, status: "merged",
          commits: side.map((x) => x.sha), sessions: [], subjects: side.map((x) => clip(x.subject, 100)).slice(0, 10), mergeSha: c.sha });
      }
    }
    seen.add(c.sha);
    for (const p of c.parents.slice(0, 1)) if (!by.has(p)) seen.add(p);
  }
  // Everything reachable from the default branch is settled; the rest belongs to branches that never merged.
  const mainAll = new Set<string>();
  if (tip) { const stack = [tip]; while (stack.length) { const s = stack.pop()!; if (mainAll.has(s)) continue; const c = by.get(s); if (!c) continue; mainAll.add(s); stack.push(...c.parents); } }
  const claimed = new Set<string>();
  for (const b of branches.slice().sort((a, b) => b.t - a.t)) {
    const own: Commit[] = [];
    const stack = [b.sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (mainAll.has(s) || claimed.has(s)) continue;
      const c = by.get(s);
      if (!c) continue;
      claimed.add(s); own.push(c); stack.push(...c.parents);
    }
    if (!own.length) continue;
    own.sort((a, b) => a.t - b.t);
    const last = own[own.length - 1].t;
    quests.push({ id: `b${hash(b.name)}`, label: branchLabel(b.name), kind: /worktree|agent/.test(b.name) ? "worktree" : "branch", branch: b.name.replace(/^origin\//, ""), from: own[0].t, to: last,
      status: now - last < 14 * DAY ? "active" : "abandoned", commits: own.map((x) => x.sha), sessions: [], subjects: own.map((x) => clip(x.subject, 100)).slice(0, 10) });
  }
  return { chain, quests, mainAll };
}

const DEPLOY_FILES: [string, string][] = [
  ["vercel.json", "Vercel"], [".vercel/project.json", "Vercel"], ["netlify.toml", "Netlify"], ["fly.toml", "Fly.io"], ["wrangler.toml", "Cloudflare"], ["wrangler.jsonc", "Cloudflare"],
  ["render.yaml", "Render"], ["railway.json", "Railway"], ["Procfile", "Heroku-style"], ["firebase.json", "Firebase"], ["app.yaml", "App Engine"], ["Dockerfile", "Docker"],
  ["docker-compose.yml", "Docker Compose"], ["bin/install.sh", "install script"], ["bin/deploy-node.sh", "deploy script"], ["deploy.sh", "deploy script"], ["scripts/deploy.sh", "deploy script"],
];

/** Cheap fingerprint of the repo: every ref's target plus HEAD. Changes when anything is committed, fetched or branched. */
export async function gitSig(root: string): Promise<string> {
  const r = await run(["git", "for-each-ref", "--format=%(objectname) %(refname)"], { cwd: root, timeoutMs: 5000 });
  const h = await run(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 3000 });
  return r.ok ? hash(r.out + h.out) : "";
}

export async function collectGit(root: string, opts: { now?: number; timeoutMs?: number } = {}): Promise<GitData | undefined> {
  if (!existsSync(`${root}/.git`)) return;
  const now = opts.now ?? Date.now();
  const T = opts.timeoutMs ?? 20_000;
  const [log, refs, headRef, status, remote, originHead, sig] = await Promise.all([
    run(["git", "log", "--all", "--date-order", `--format=${SEP_REC}%H${SEP_F}%P${SEP_F}%at${SEP_F}%ae${SEP_F}%an${SEP_F}%D${SEP_F}%s`, "--name-only", "-n", "20000"], { cwd: root, timeoutMs: T }),
    run(["git", "for-each-ref", `--format=%(refname)${SEP_F}%(objectname)${SEP_F}%(*objectname)${SEP_F}%(creatordate:unix)${SEP_F}%(committerdate:unix)${SEP_F}%(subject)`, "refs/heads", "refs/remotes", "refs/tags"], { cwd: root, timeoutMs: 8000 }),
    run(["git", "symbolic-ref", "--short", "-q", "HEAD"], { cwd: root, timeoutMs: 3000 }),
    run(["git", "status", "--porcelain", "-uno"], { cwd: root, timeoutMs: 8000 }),
    run(["git", "remote", "get-url", "origin"], { cwd: root, timeoutMs: 3000 }),
    run(["git", "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], { cwd: root, timeoutMs: 3000 }),
    gitSig(root),
  ]);
  if (!log.ok) return;
  const commits = parseGitLog(log.out);
  const heads: { name: string; sha: string; t: number }[] = [];
  const tagRefs: { name: string; sha: string; t: number; subject: string }[] = [];
  for (const line of refs.out.split("\n")) {
    const [ref, obj, peeled, created, committed, subject] = line.split(SEP_F);
    if (!ref) continue;
    if (ref.startsWith("refs/tags/")) tagRefs.push({ name: ref.slice(10), sha: peeled || obj, t: Number(created || committed) * 1000, subject: subject ?? "" });
    else if (!ref.endsWith("/HEAD")) heads.push({ name: ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, ""), sha: obj, t: Number(committed) * 1000 });
  }
  const names = new Set(heads.map((h) => h.name));
  const branch = headRef.out.trim() || undefined;
  const defaultBranch = originHead.out.trim().replace(/^origin\//, "") || ["main", "master", "trunk", "develop"].find((b) => names.has(b)) || branch || "main";
  const tipOf = (b: string) => heads.find((h) => h.name === b)?.sha ?? heads.find((h) => h.name === `origin/${b}`)?.sha;
  const tip = tipOf(defaultBranch) ?? commits[0]?.sha;
  const others = heads.filter((h) => h.name !== defaultBranch && h.name !== `origin/${defaultBranch}` && !(h.name.startsWith("origin/") && names.has(h.name.slice(7)) && heads.find((x) => x.name === h.name.slice(7))?.sha === h.sha));
  const { chain, quests } = splitHistory(commits, tip, others, now);
  const mainChunks = chunkCommits(chain.filter((c) => c.parents.length < 2));
  const merges: JEvent[] = chain.filter((c) => c.parents.length >= 2).map((c) => {
    const q = quests.find((x) => x.mergeSha === c.sha);
    return { id: `m${c.sha.slice(0, 8)}`, t: c.t, kind: "merge" as const, title: q ? `Merged “${q.label}”` : clip(c.subject, 100), detail: q ? `${q.commits.length} commit${q.commits.length === 1 ? "" : "s"} from the side` : undefined, weight: q ? commitWeight(q.commits.length, 0) : 2, lane: q?.id, link: { commit: c.sha, branch: q?.branch } };
  });
  const tags: JEvent[] = tagRefs.map((g) => ({ id: `t${hash(g.name)}`, t: g.t || (commits.find((c) => c.sha === g.sha)?.t ?? 0), kind: "tag" as const, title: `Tagged ${g.name}`, detail: g.subject ? clip(g.subject, 140) : undefined, weight: 6, link: { commit: g.sha } })).filter((e) => e.t);
  const byAuthor = new Map<string, { email: string; name: string; n: number; first: number }>();
  for (const c of commits) { const k = c.email.toLowerCase(); const a = byAuthor.get(k) ?? { email: c.email, name: c.author, n: 0, first: c.t }; a.n++; a.first = Math.min(a.first, c.t); byAuthor.set(k, a); }
  const sorted = commits.slice().sort((a, b) => a.t - b.t);
  // Deploy config: when each file first appeared in history (a signal that shipping started).
  const deployFiles = DEPLOY_FILES.filter(([f]) => existsSync(`${root}/${f}`));
  const firstAdds = await Promise.all(deployFiles.map(async ([f, what]) => {
    const r = await run(["git", "log", "--diff-filter=A", "--format=%at%x1f%H", "--", f], { cwd: root, timeoutMs: 6000 });
    const last = r.out.trim().split("\n").filter(Boolean).pop();
    if (!last) return undefined;
    const [at, sha] = last.split(SEP_F);
    return { id: `d${hash(f)}`, t: Number(at) * 1000, kind: "deploy" as const, title: `Deploy setup: ${what}`, detail: `${f} added`, weight: 5, link: { commit: sha, file: f } } as JEvent;
  }));
  const rem = remote.out.trim();
  const gh = rem.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return {
    sig, root, defaultBranch, branch, head: commits.find((c) => c.sha === tip)?.sha, dirty: status.out.split("\n").filter((l) => l.trim()).length,
    remote: rem ? rem.replace(/\/\/[^@/]+@/, "//") : undefined, github: gh ? `${gh[1]}/${gh[2]}` : undefined,
    commits: commits.length,
    first: sorted[0] && { sha: sorted[0].sha, t: sorted[0].t, subject: sorted[0].subject },
    last: sorted.at(-1) && { sha: sorted.at(-1)!.sha, t: sorted.at(-1)!.t, subject: sorted.at(-1)!.subject },
    mainChunks, merges, tags, quests,
    authors: [...byAuthor.values()].sort((a, b) => b.n - a.n),
    commitTimes: sorted.map((c) => c.t),
    activeDays: [...new Set(sorted.map((c) => dayKey(c.t)))],
    deploys: firstAdds.filter(Boolean) as JEvent[], deployFiles: deployFiles.map(([f]) => f),
  };
}

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
