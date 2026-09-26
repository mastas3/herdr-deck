import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  branchLabel, chunkCommits, collectGit, collectGumroad, collectNotes, collectWiki, headingDate, mergedBranchName, nameRe, parseGitLog, parseWikiLog, parseWikiPage,
  productMatches, sessionEvents, worktreeOf, agentMs, type Commit, type SessRec,
} from "../src/journey-collect";
import { analyze, closeJson, digest, guardLadder, guessNature, metricName, normalizeAi, parseJsonLoose, ruleBased, templateLadder, type DigestInput } from "../src/journey-ai";
import { assemble, computeMetrics, createJourneys, cumulative, evaluate, liveSessions, projectSessions, type Evidence } from "../src/journey";

const root = mkdtempSync(`${tmpdir()}/deck-journey-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 10); // a Monday

// ── a fixture repo ────────────────────────────────────────────────────────────
const repo = `${root}/Projects/demo-app`;
async function git(args: string[], at?: number) {
  const env: Record<string, string> = { ...process.env as any, GIT_AUTHOR_NAME: "Me", GIT_AUTHOR_EMAIL: "me@example.com", GIT_COMMITTER_NAME: "Me", GIT_COMMITTER_EMAIL: "me@example.com" };
  if (at) { const d = new Date(at).toISOString(); env.GIT_AUTHOR_DATE = d; env.GIT_COMMITTER_DATE = d; }
  const p = Bun.spawn(["git", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}
async function commit(file: string, msg: string, at: number) { writeFileSync(`${repo}/${file}`, `${msg}\n${Math.random()}\n`); await git(["add", "-A"], at); await git(["commit", "-q", "-m", msg], at); }
beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  await git(["init", "-q", "-b", "main"]);
  await commit("README.md", "Initial idea: a tiny demo app", T0);
  await commit("a.ts", "feat: first screen", T0 + 3600_000);
  await commit("b.ts", "feat: second screen", T0 + 2 * 3600_000);
  await commit("c.ts", "fix: typo", T0 + DAY);
  // a side quest that merges back
  await git(["checkout", "-q", "-b", "feat/payments"]);
  await commit("pay.ts", "payments: stripe checkout", T0 + 2 * DAY);
  await commit("pay2.ts", "payments: webhooks", T0 + 2 * DAY + 3600_000);
  await git(["checkout", "-q", "main"]);
  await commit("d.ts", "docs: readme", T0 + 3 * DAY);
  await git(["merge", "-q", "--no-ff", "feat/payments", "-m", "Merge branch 'feat/payments'"], T0 + 4 * DAY);
  await git(["tag", "-a", "v0.1", "-m", "first release"], T0 + 4 * DAY);
  // deploy config appears
  writeFileSync(`${repo}/vercel.json`, "{}");
  await commit("e.ts", "chore: deploy to vercel", T0 + 5 * DAY);
  // a branch that never merged, long ago
  await git(["checkout", "-q", "-b", "experiment/3d"]);
  await commit("x.ts", "try a 3D view", T0 + 6 * DAY);
  await git(["checkout", "-q", "main"]);
  await git(["remote", "add", "origin", "https://github.com/someone/demo-app.git"]);
});

describe("git", () => {
  test("parses name-only and shortstat logs", () => {
    const out = "\x1eaaaaaaa1\x1f\x1f1700000000\x1fa@b\x1fA\x1fHEAD -> main\x1ffirst\n\nsrc/a.ts\nsrc/b.ts\n\x1ebbbbbbb2\x1faaaaaaa1\x1f1700000100\x1fa@b\x1fA\x1f\x1fsecond\n 3 files changed, 10 insertions(+), 2 deletions(-)\n";
    const cs = parseGitLog(out);
    expect(cs.map((c) => [c.subject, c.files, c.lines])).toEqual([["first", 2, 0], ["second", 3, 12]]);
    expect(cs[1].parents).toEqual(["aaaaaaa1"]);
  });
  test("merge subjects name their branch; branch names read as words", () => {
    expect(mergedBranchName("Merge branch 'deck-mix'")).toBe("deck-mix");
    expect(mergedBranchName("Merge pull request #12 from me/feat-x")).toBe("feat-x");
    expect(mergedBranchName("fix: things")).toBeUndefined();
    expect(branchLabel("feat/payments-v2")).toBe("payments v2");
    expect(branchLabel("worktree-agent-a1b2")).toBe("agent a1b2");
  });
  test("commits group into sittings, and a one-day project still gets several", () => {
    const mk = (i: number, t: number): Commit => ({ sha: `${i}`.padStart(8, "0"), parents: [], t, email: "", author: "", refs: "", subject: `c${i}`, lines: i, files: 1 });
    const oneDay = Array.from({ length: 30 }, (_, i) => mk(i, T0 + i * 20 * 60_000)); // every 20 min for 10 h
    const chunks = chunkCommits(oneDay);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.reduce((n, c) => n + (c.n ?? 0), 0)).toBe(30);
    expect(chunkCommits([mk(1, T0), mk(2, T0 + DAY)]).length).toBe(2); // a new day is a new chunk
  });
  test("a fixture repo: main line, merged and abandoned side quests, tags, deploy setup, GitHub remote", async () => {
    const g = (await collectGit(repo, { now: T0 + 60 * DAY }))!;
    expect(g.commits).toBe(10);
    expect(g.defaultBranch).toBe("main");
    expect(g.github).toBe("someone/demo-app");
    expect(g.first?.subject).toBe("Initial idea: a tiny demo app");
    const merged = g.quests.find((q) => q.status === "merged")!;
    expect(merged.branch).toBe("feat/payments");
    expect(merged.commits.length).toBe(2);
    const lost = g.quests.find((q) => q.branch === "experiment/3d")!;
    expect(lost.status).toBe("abandoned"); // last touched 54 days before "now"
    expect(lost.commits.length).toBe(1);
    expect(g.merges.length).toBe(1);
    expect(g.tags.map((t) => t.title)).toEqual(["Tagged v0.1"]);
    expect(g.deploys.map((d) => d.title)).toEqual(["Deploy setup: Vercel"]);
    // Side-quest commits are not on the main line.
    const mainSubjects = g.mainChunks.flatMap((c) => c.items ?? []);
    expect(mainSubjects).not.toContain("payments: webhooks");
    expect(mainSubjects).toContain("feat: first screen");
    expect(g.activeDays.length).toBe(7); // side-quest days count too
  });
});

// ── the wiki ─────────────────────────────────────────────────────────────────
const PAGE = `---
type: project
status: launched
tags: [saas, payments, sveltekit]
date_updated: 2026-02-01
---

A tiny demo app that sells [[widgets]] — the successor to [[old-demo]].

## What it is
Demo app for testing the journey page.

## Voice layer (added 2026-01-10)
Added a voice layer with local TTS.

## Payments went live — 20 January 2026
Stripe checkout is live at https://demo.example.com and https://github.com/x/y.

## Next
- Get the first 10 paying users
- Add a mobile app
`;
describe("wiki", () => {
  test("dates in headings", () => {
    expect(new Date(headingDate("Voice layer (added 2026-01-10)")!).getDate()).toBe(10);
    expect(new Date(headingDate("Ra encounter (26 September 2026)")!).getMonth()).toBe(8);
    expect(new Date(headingDate("Launch — September 3, 2026")!).getDate()).toBe(3);
    expect(headingDate("What it is")).toBeUndefined();
  });
  test("a project page: status, tags, TLDR, dated sections, next, urls, lineage", () => {
    const w = parseWikiPage("demo-app", PAGE);
    expect(w.status).toBe("launched");
    expect(w.tags).toEqual(["saas", "payments", "sveltekit"]);
    expect(w.tldr).toStartWith("A tiny demo app that sells widgets");
    expect(w.sections.map((s) => s.title)).toEqual(["Voice layer", "Payments went live"]);
    expect(w.next).toEqual(["Get the first 10 paying users", "Add a mobile app"]);
    expect(w.urls).toEqual(["https://demo.example.com"]);
    expect(w.parent).toBe("old-demo");
    expect(w.firstPara).toBe("Demo app for testing the journey page.");
  });
  test("log entries that name the project (title or [[link]]), not ones that merely share a prefix", () => {
    const log = `# Log\n\n## [2026-01-05] ingest | demo-app — first version\n\n## [2026-01-06] update | demo-app-v2 — unrelated\n\n## [2026-01-07] update | something else\nTouched [[demo-app]] payments.\n\n## [2026-01-08] query | other\n`;
    const es = parseWikiLog(log, "demo-app");
    expect(es.map((e) => e.title)).toEqual(["first version", "something else"]);
    expect(nameRe("demo-app").test("see demo-app-v2")).toBe(false);
  });
  test("collectWiki finds spin-offs that say they grew out of the project", async () => {
    const wiki = `${root}/wiki`;
    mkdirSync(`${wiki}/projects`, { recursive: true });
    writeFileSync(`${wiki}/projects/demo-app.md`, PAGE);
    writeFileSync(`${wiki}/projects/demo-mobile.md`, "---\nstatus: active\n---\nThe phone app, spun off from [[demo-app]].\n");
    writeFileSync(`${wiki}/projects/unrelated.md`, "---\nstatus: active\n---\nUses [[demo-app]] as a reference.\n");
    writeFileSync(`${wiki}/log.md`, "## [2026-01-21] update | demo-app — deployed payments to production\n");
    const w = await collectWiki(wiki, "demo-app");
    expect(w.children).toEqual(["demo-mobile"]);
    expect(w.log.length).toBe(1);
  });
});

// ── sessions ─────────────────────────────────────────────────────────────────
const S = (o: Partial<SessRec>): SessRec => ({ key: `h:claude:${o.id}`, id: o.id!, agent: "claude", machine: "mac", title: o.title ?? "t", first: o.first, started: o.started, last: o.last, asks: o.asks ?? 2, cwd: o.cwd ?? repo, project: "demo-app", ...o });
describe("sessions", () => {
  test("worktree folders and agent time", () => {
    expect(worktreeOf("/x/demo/.claude/worktrees/deck-mix/src")).toBe("deck-mix");
    expect(worktreeOf("/x/demo/src")).toBeUndefined();
    expect(agentMs(S({ id: "a", started: 0, last: 10 * 3600_000, asks: 1 }))).toBe(20 * 60_000); // capped by prompts
    expect(agentMs(S({ id: "a", started: 0, last: 30 * 3600_000, asks: 100 }))).toBe(8 * 3600_000); // and at 8 h
  });
  test("session events link back to the session; mentions weigh less", () => {
    const [a, b] = sessionEvents([S({ id: "a", started: T0, last: T0 + 1000, asks: 8 }), S({ id: "b", started: T0, asks: 8, mention: true })]);
    expect(a.link?.session).toBe("h:claude:a");
    expect(b.weight).toBeLessThan(a.weight);
  });
  test("live rows become sessions with their real start time and prompt count", () => {
    const rows = [{ key: "p1", machine: "mac", agent: "claude", status: "working", title: "Live", cwd: repo, project: "demo-app", sessionId: "s1", lastActiveAt: T0 + 5000 }, { key: "p2", agent: "shell", status: "idle", title: "sh", cwd: repo, project: "demo-app" }];
    const out = liveSessions(rows as any, () => new Map([["s1", { started: T0, asks: 7 }]]));
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ id: "s1", started: T0, asks: 7, live: true });
  });
  test("projectSessions: own sessions plus ones elsewhere that name the project", async () => {
    const hits = [
      { key: "h:claude:1", id: "1", agent: "claude", title: "Build demo-app screens", project: "demo-app" },
      { key: "h:claude:2", id: "2", agent: "claude", title: "Plan demo-app pricing", project: "wiki" },
      { key: "h:claude:3", id: "3", agent: "claude", title: "demo-app-v2 thoughts", project: "wiki" },
    ];
    const got = await projectSessions("demo-app", async (o) => (o.project ? hits.filter((h) => h.project === o.project) : hits));
    expect(got.map((s) => [s.id, !!s.mention])).toEqual([["1", false], ["2", true]]);
  });
});

// ── milestones ──────────────────────────────────────────────────────────────────
describe("milestones", () => {
  const ladder = [
    { id: "first-commit", title: "First commit", metric: "Commits", unit: "commits", target: 1, source: "git.commits", tier: 0 },
    { id: "100-commits", title: "100 commits", metric: "Commits", unit: "commits", target: 100, source: "git.commits", tier: 1 },
    { id: "first-user", title: "First user", metric: "Users", unit: "users", target: 1, source: "manual.users", tier: 2 },
    { id: "10-users", title: "10 users", metric: "Users", unit: "users", target: 10, source: "manual.users", tier: 3 },
    { id: "public-launch", title: "Public launch", metric: "Done", unit: "", target: 1, source: "manual.public_launch", tier: 4 },
    { id: "stars", title: "10 stars", metric: "Stars", unit: "stars", target: 10, source: "github.stars", tier: 5 },
  ];
  const metrics = [
    { key: "git.commits", label: "commits", value: 40, series: cumulative([T0, T0 + DAY, T0 + 2 * DAY]).map(([t, v]) => [t, v * 20] as [number, number]), evidence: "40 commits in git" },
  ];
  test("locked, in progress and unlocked come from measured evidence", () => {
    const ms = evaluate(ladder, metrics, { metrics: [], unlocks: [] });
    const by = Object.fromEntries(ms.map((m) => [m.id, m]));
    expect(by["first-commit"].state).toBe("unlocked");
    expect(by["first-commit"].at).toBe(T0); // the date the series first reached the target
    expect(by["100-commits"]).toMatchObject({ state: "progress", value: 40, pct: 0.4 });
    expect(by["first-user"].state).toBe("locked");
    expect(by["stars"].state).toBe("locked"); // no GitHub evidence: never unlocked
    expect(by["stars"].measured).toBe(false);
  });
  test("manual readings unlock when they reach the target, dated by the reading that did", () => {
    const manual = { metrics: [{ metric: "users", value: 3, at: T0 + DAY }, { metric: "users", value: 12, at: T0 + 9 * DAY, note: "from analytics" }], unlocks: [] };
    const all = computeMetrics({ sessions: [], manual, notes: [] } as Evidence);
    const ms = evaluate(ladder, all, manual);
    const u10 = ms.find((m) => m.id === "10-users")!;
    expect(u10.state).toBe("unlocked");
    expect(u10.at).toBe(T0 + 9 * DAY);
    expect(u10.evidence).toContain("logged by you");
    expect(ms.find((m) => m.id === "first-user")!.at).toBe(T0 + DAY);
  });
  test("a milestone marked by hand is unlocked with your note as its evidence", () => {
    const ms = evaluate(ladder, metrics, { metrics: [], unlocks: [{ id: "public-launch", at: T0, note: "Posted on HN" }] });
    const m = ms.find((x) => x.id === "public-launch")!;
    expect(m).toMatchObject({ state: "unlocked", manual: true });
    expect(m.evidence).toContain("Posted on HN");
  });
  test("a measured source can't vouch for a milestone it doesn't count", () => {
    const g = guardLadder([
      { id: "a", title: "Hebrew and Russian", metric: "Localization", unit: "languages", target: 3, source: "git.side_quests", tier: 0 },
      { id: "b", title: "Chat service finalized", metric: "Commits", unit: "commits", target: 80, source: "git.commits", tier: 1 },
      { id: "c", title: "100 commits", metric: "Commits", unit: "commits", target: 100, source: "git.commits", tier: 2 },
      { id: "d", title: "5 live services running", metric: "Services", unit: "services", target: 5, source: "deploy.live", tier: 3 },
    ]);
    expect(g.map((m) => m.source)).toEqual(["manual.hebrew_and_russian", "manual.chat_service_finalized", "git.commits", "manual.services"]);
    expect(g[1]).toMatchObject({ metric: "Done", target: 1 });
    expect(metricName("API-first native endpoints live")).toBe("api_first_native_endpoints");
  });
});

// ── the AI read ───────────────────────────────────────────────────────────────────
const dig = (): DigestInput => ({
  project: "demo-app", tldr: "A tiny demo app.", status: "active", tags: ["saas"], origin: "Build a tiny demo app", nature: "consumer-app",
  events: [
    { id: "c1", t: T0, kind: "commits", title: "Initial idea", weight: 3, n: 1 },
    { id: "w1", t: T0 + 5 * DAY, kind: "wiki", title: "Payments went live", weight: 5 },
    { id: "s1", t: T0 + 6 * DAY, kind: "session", title: "Off-topic: a game", weight: 2 },
    { id: "c2", t: T0 + 40 * DAY, kind: "commits", title: "Back at it", weight: 3, n: 2 },
  ],
  quests: [{ id: "q1", label: "payments", status: "merged", commits: 2, sessions: 0, from: T0, to: T0 + DAY, subjects: ["stripe"] }],
  metrics: [{ key: "git.commits", label: "commits", value: 3, evidence: "3 commits" }],
});
describe("AI", () => {
  test("JSON repair: fences, trailing commas, smart quotes, truncation", () => {
    expect(parseJsonLoose('Sure! ```json\n{"a": 1, "b": [1,2,],}\n```')).toEqual({ a: 1, b: [1, 2] });
    expect(parseJsonLoose('{“a”: “x”}')).toEqual({ a: "x" });
    expect(parseJsonLoose('{"a": 1, "turns": [{"event": "c1", "label": "start"}, {"event": "w1", "lab')).toMatchObject({ a: 1, turns: [{ event: "c1" }] });
    expect(closeJson('{"a": [1, {"b": "c')).toBe('{"a": [1, {"b": "c"}]}');
    expect(parseJsonLoose("no json here")).toBeUndefined();
  });
  test("normalize keeps only known ids and real sources", () => {
    const raw = {
      nature: "consumer-app", pitch: "p", story: "s", idea: "Build a tiny demo app",
      turns: [{ event: "w1", label: "added payments" }, { event: "nope", label: "invented" }, { event: "w1", label: "dupe" }],
      sidequests: [{ id: "q1", label: "Stripe checkout" }, { id: "zz", label: "ghost" }, { sessions: ["s1", "x9"], label: "Game detour" }],
      ladder: [
        { id: "first-user", title: "First user", metric: "Users", unit: "users", target: 1, source: "manual.users" },
        { title: "100 commits", metric: "Commits", unit: "commits", target: "100", source: "git.commits" },
        { title: "First paying customer", metric: "Paying customers", unit: "customers", target: 1, source: "stripe.customers" },
        { title: "Bad", target: 0, source: "git.commits" },
      ],
      heading: { direction: "Get users", next: ["first-user", "nope"] },
    };
    const r = normalizeAi(raw, { events: new Set(["c1", "w1", "s1", "c2"]), quests: new Set(["q1"]), nature: "internal" })!;
    expect(r.turns).toEqual([{ event: "w1", label: "added payments", why: undefined }]);
    expect(r.questLabels).toEqual({ q1: "Stripe checkout" });
    expect(r.sessionQuests).toEqual([{ label: "Game detour", sessions: ["s1"] }]);
    expect(r.ladder.map((m) => [m.title, m.source, m.target])).toEqual([["First user", "manual.users", 1], ["100 commits", "git.commits", 100], ["First paying customer", "manual.paying_customers", 1]]);
    expect(r.heading.next).toEqual(["first-user"]);
    expect(r.idea).toBe("Build a tiny demo app");
  });
  test("a failing or unreadable model falls back to rules, with a note", async () => {
    let calls = 0;
    const failed = await analyze(dig(), { runner: async () => { throw new Error("Claude took too long"); }, onCall: () => calls++ });
    expect(failed.source).toBe("rules");
    expect(failed.note).toContain("took too long");
    const junk = await analyze(dig(), { runner: async () => ({ text: "I can't do that", model: "haiku" }), onCall: () => calls++ });
    expect(junk.source).toBe("rules");
    expect(junk.note).toContain("couldn't be used");
    expect(calls).toBe(2);
    const ok = await analyze(dig(), { runner: async () => ({ text: JSON.stringify({ story: "It began.", ladder: templateLadder("tool"), turns: [{ event: "c2", label: "picked back up" }] }), model: "haiku" }) });
    expect(ok).toMatchObject({ source: "claude", model: "haiku", story: "It began." });
  });
  test("rules find turns (wiki phases, revivals) and a template ladder fits the kind of project", () => {
    const r = ruleBased(dig());
    expect(r.turns.map((t) => t.event)).toEqual(["w1", "c2"]);
    expect(r.ladder.some((m) => m.source === "manual.mrr")).toBe(true);
    expect(guessNature(["film", "animation"])).toBe("creative");
    expect(guessNature(["library", "npm"])).toBe("tool");
    expect(guessNature(["agent-orchestration", "dashboard", "pwa"])).toBe("internal");
  });
  test("the digest carries titles and counts only", () => {
    const d = digest(dig());
    expect(d).toContain("c1 2026-01-05 commits(1): Initial idea");
    expect(d).toContain('q1 ');
    expect(d.length).toBeLessThan(4000);
  });
});

// ── notes and Gumroad ─────────────────────────────────────────────────────────────
describe("plans, leads and revenue", () => {
  test("saved plans and leads that mention the project become events", () => {
    const data = `${root}/data`;
    mkdirSync(`${data}/ideas`, { recursive: true }); mkdirSync(`${data}/leads`, { recursive: true });
    writeFileSync(`${data}/ideas/pricing.md`, "---\ntitle: Pricing for demo-app\ncreated: 2026-01-09\n---\n# Pricing\nPlan for demo-app.");
    writeFileSync(`${data}/ideas/other.md`, "# Other\nNothing to see.");
    writeFileSync(`${data}/leads/widgets-2026.json`, JSON.stringify({ project: "demo-app", leads: 3 }));
    const es = collectNotes(data, "demo-app");
    expect(es.map((e) => e.kind).sort()).toEqual(["idea", "lead"]);
    expect(es.find((e) => e.kind === "idea")!.title).toBe("Plan: Pricing for demo-app");
  });
  test("Gumroad: products match by name or the brand the wiki names; only aggregates come back", async () => {
    expect(productMatches("Demo App Pro", "demo-app")).toBe(true);
    expect(productMatches("2027 Prophecy: The Founding Reading", "astra-apple", "the 2027 prophecy funnel … 2027 Prophecy passport")).toBe(true);
    expect(productMatches("2027 Prophecy: The Founding Reading", "herdr-deck", "a dashboard")).toBe(false);
    const seen: string[] = [];
    const fake = (async (url: string, init: any) => {
      seen.push(`${url} ${init.headers.authorization === "Bearer test-token" ? "auth-ok" : "no-auth"}`);
      if (url.includes("/products")) return new Response(JSON.stringify({ success: true, products: [{ id: "p1", name: "Demo App Pro" }, { id: "p2", name: "Something else" }] }));
      if (url.includes("page_key=2")) return new Response(JSON.stringify({ success: true, sales: [{ created_at: "2026-01-12T00:00:00Z", price: 900 }] }));
      return new Response(JSON.stringify({ success: true, sales: [{ created_at: "2026-01-10T00:00:00Z", price: 1500 }, { created_at: "2026-01-11T00:00:00Z", price: 1500, refunded: true }], next_page_key: "2" }));
    }) as any;
    const g = (await collectGumroad("demo-app", "", fake, "test-token"))!;
    expect(g).toMatchObject({ ok: true, products: ["Demo App Pro"], sales: 2, revenue: 24 });
    expect(g.series.at(-1)).toEqual([Date.parse("2026-01-12T00:00:00Z"), 24]);
    expect(JSON.stringify(g)).not.toContain("test-token");
    expect(seen.every((s) => s.endsWith("auth-ok"))).toBe(true);
  });
});

// ── the service: assemble, cache, incremental rebuilds ────────────────────────────────────
describe("journey service", () => {
  test("assemble: origin, lanes for worktree sessions, spin-off lanes, unlock flags", async () => {
    const g = (await collectGit(repo, { now: T0 + 7 * DAY }))!;
    const sessions = [S({ id: "s1", started: T0 - 3600_000, last: T0, first: "I want a tiny demo app that sells widgets" }), S({ id: "s2", started: T0 + 2 * DAY, last: T0 + 2 * DAY + 3600_000, cwd: `${repo}/.claude/worktrees/payments` }), S({ id: "s3", started: T0 + 3 * DAY, cwd: `${repo}/.claude/worktrees/spike` })];
    const { journey: j, digest: d } = assemble("demo-app", { git: g, sessions, manual: { metrics: [], unlocks: [] }, notes: [] }, undefined, { live: [], now: T0 + 7 * DAY, siblings: [{ name: "demo-app-video", sessions: [S({ id: "v1", started: T0 + 5 * DAY, project: "demo-app-video" })] }] });
    expect(j.origin.ideaFrom).toBe("session");
    expect(j.origin.idea).toStartWith("I want a tiny demo app");
    expect(j.origin.t).toBe(T0 - 3600_000);
    const spike = j.quests.find((q) => q.kind === "worktree")!;
    expect(spike.label).toBe("spike");
    expect(j.events.find((e) => e.link?.session === "h:claude:s3")!.lane).toBe(spike.id);
    const video = j.quests.find((q) => q.kind === "spinoff")!;
    expect(video).toMatchObject({ label: "video", status: "spun-off" });
    expect(j.events.some((e) => e.kind === "milestone" && e.title === "Unlocked: First commit")).toBe(true);
    expect(j.counts.sessions).toBe(3);
    expect(d.events.some((e) => e.kind === "milestone")).toBe(false); // flags never go to the model
  });

  test("cached, rebuilt when git moves, AI run once per digest and forced by Regenerate", async () => {
    let now = T0 + 7 * DAY;
    let aiCalls = 0;
    const js = createJourneys({ dataDir: `${root}/data`, cacheDir: `${root}/cache`, wikiDir: `${root}/wiki`, projectsDir: `${root}/Projects` }, {
      sessions: async () => [S({ id: "s1", started: T0 - 3600_000, last: T0, first: "a tiny demo app" })],
      live: () => [],
      now: () => now,
      runner: async () => { aiCalls++; return { text: JSON.stringify({ nature: "consumer-app", story: "It began as a tiny demo.", ladder: templateLadder("consumer-app"), turns: [] }), model: "test" }; },
    });
    process.env.DECK_NO_GUMROAD = "1";
    const a = await js.get("demo-app");
    expect(a.counts.commits).toBe(11 - 1); // 10 commits in the fixture
    expect(a.root).toBe(repo);
    await js.whenAiIdle();
    const b = await js.get("demo-app");
    expect(aiCalls).toBe(1);
    expect(b.story).toBe("It began as a tiny demo.");
    expect(b.ai.source).toBe("claude");
    // Nothing moved: the cached journey comes back as is and the model isn't asked again.
    const c = await js.get("demo-app");
    expect(c.builtAt).toBe(b.builtAt);
    await js.whenAiIdle();
    expect(aiCalls).toBe(1);
    // A new commit: the next rebuild (once the cache is old) re-reads git.
    await commit("f.ts", "feat: new thing", T0 + 7 * DAY);
    now += 60_000;
    await js.rebuild("demo-app");
    const d = await js.get("demo-app", { noAi: true });
    expect(d.counts.commits).toBe(11);
    // Regenerate always asks again.
    await js.handle("/api/journey/regenerate", { project: "demo-app" });
    await js.whenAiIdle();
    expect(aiCalls).toBe(2);
    // Manual entries: a reading and a hand-marked unlock (which needs a note).
    const m = await js.handle("/api/journey/metric", { project: "demo-app", metric: "users", value: 12, at: T0 + 6 * DAY });
    expect(m.milestones.find((x: any) => x.id === "10-users").state).toBe("unlocked");
    expect(() => js.markUnlocked("demo-app", { id: "first-paying-customer", note: "" })).toThrow();
    const u = await js.handle("/api/journey/unlock", { project: "demo-app", id: "first-paying-customer", note: "Sold one to Dana" });
    expect(u.milestones.find((x: any) => x.id === "first-paying-customer")).toMatchObject({ state: "unlocked", manual: true });
    const idx = await js.index();
    expect(idx.projects.find((p: any) => p.project === "demo-app")).toMatchObject({ wiki: true, status: "launched" });
    delete process.env.DECK_NO_GUMROAD;
  });
});
