import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildProfile, buildPrompt, createDiscover, extractKeywords, forkPrompt, frontmatter, groupByRole, hasTerm, isGem, listIdeas,
  rankGems, rankIdeaRepos, rankTrending, researchPrompt, roleOf, slugify, sparks, toRepo, type GhRes, type Interest, type RankCtx, type Repo,
} from "../src/discover";

const root = mkdtempSync(`${tmpdir()}/deck-discover-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NOW = Date.parse("2026-09-26T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const w = (p: string, text: string) => { mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true }); writeFileSync(p, text); };
const page = (fm: Record<string, string>, body: string) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

// A fake wiki and a fake ~/Documents/Projects.
const wiki = `${root}/wiki`, projects = `${root}/Projects`;
w(`${wiki}/projects/chart-chat.md`, page({ type: "project", status: "active", tags: "[human-design, rag, typescript]", date_updated: "2026-09-20" }, "Talk to your [[bodygraph]] with sources.\n\n## More"));
w(`${wiki}/projects/bodygraph-3d.md`, page({ type: "project", status: "launched", tags: "[human-design, threejs, visualization]", date_updated: "2026-09-01" }, "A 3D bodygraph."));
w(`${wiki}/projects/agent-deck.md`, page({ type: "project", status: "active", tags: "[agent-orchestration, pwa, bun]", date_updated: "2026-09-25" }, "Dashboard for every agent."));
w(`${wiki}/projects/old-thing.md`, page({ type: "project", status: "archived", tags: "[crypto, wallet]", date_updated: "2023-01-01" }, "An old wallet."));
w(`${wiki}/projects/forked-tool.md`, page({ type: "project", status: "stale", tags: "[claude-code, external]", date_updated: "2025-01-01" }, "Someone else's tool."));
w(`${wiki}/projects/kite-a.md`, page({ type: "project", status: "active", tags: "[kitesurfing, python]", date_updated: "2026-09-10" }, "Wind alerts."));
w(`${wiki}/projects/kite-b.md`, page({ type: "project", status: "active", tags: "[kitesurfing]", date_updated: "2026-09-10" }, "Spot map."));
w(`${wiki}/concepts/human-design-tech.md`, page({ type: "concept", tags: "[domain, human-design]" }, "HD software."));
w(`${wiki}/log.md`, "# Log\n\n## [2026-09-24] update | agent-deck gets a discover view\n\n## [2026-09-25] update | agent-deck polish\n\n## [2025-01-01] ingest | old-thing\n");
w(`${projects}/chart-chat/package.json`, JSON.stringify({ name: "chart-chat", keywords: ["human-design"], dependencies: { three: "1" }, devDependencies: { typescript: "5" } }));
w(`${projects}/chart-chat/.git/config`, '[remote "origin"]\n\turl = git@github.com:me/chart-chat.git\n');
w(`${projects}/whisper-cut/requirements.txt`, "openai-whisper==1\nyt-dlp\n");
w(`${projects}/cloned/.git/config`, '[remote "origin"]\n\turl = https://github.com/SomeOrg/Cool-Lib.git\n');

describe("frontmatter", () => {
  test("flat keys and lists", () => {
    const { data, body } = frontmatter("---\ntags: [a, b-c, 'd']\nstatus: active\n---\nHello");
    expect(data).toEqual({ tags: ["a", "b-c", "d"], status: "active" });
    expect(body).toBe("Hello");
  });
  test("no front matter", () => expect(frontmatter("# Title").data).toEqual({}));
});

describe("buildProfile", () => {
  test("derives interests from wiki tags, concepts, log and repos", async () => {
    const p = await buildProfile({ wikiDir: wiki, projectsDir: projects, connections: ["GitHub", "Telegram"], now: NOW });
    const ids = p.interests.map((i) => i.id);
    expect(ids[0]).toBe("human-design"); // two projects + a concept + a repo keyword
    expect(ids).toContain("agents");
    expect(ids).toContain("3d");
    expect(ids).toContain("kitesurfing"); // not in the dictionary, but two projects share it
    expect(ids).not.toContain("typescript"); // stacks aren't interests
    expect(ids).not.toContain("external");
    const hd = p.interests.find((i) => i.id === "human-design")!;
    expect(hd.projects).toContain("chart-chat");
    expect(hd.projects).toContain("bodygraph-3d");
    expect(hd.label).toBe("Human Design");
    // archived projects barely count
    const trading = p.interests.find((i) => i.id === "trading");
    expect(!trading || trading.score < hd.score / 5).toBe(true);
    expect(p.recent[0]).toBe("agent-deck");
    expect(p.languages.map((l) => l.name)).toEqual(expect.arrayContaining(["TypeScript", "Python"]));
    expect(p.local).toEqual(expect.arrayContaining(["me/chart-chat", "someorg/cool-lib"]));
    expect(p.names).toEqual(expect.arrayContaining(["chart-chat", "whisper-cut", "bodygraph-3d"]));
    expect(p.connections).toEqual(["GitHub", "Telegram"]);
    expect(p.counts.wiki).toBe(7);
    expect(p.counts.concepts).toBe(1);
    expect(p.counts.log).toBe(2);
    // repo dependencies feed interests too
    expect(p.interests.find((i) => i.id === "speech")?.projects).toContain("whisper-cut");
  });
  test("your additions come first; removals move to removed", async () => {
    const p = await buildProfile({ wikiDir: wiki, projectsDir: projects, now: NOW, conf: { added: [{ label: "Procedural music" }], removed: ["3d"] } });
    expect(p.interests[0]).toMatchObject({ id: "you:procedural-music", source: "you", q: '"procedural music"' });
    expect(p.interests.map((i) => i.id)).not.toContain("3d");
    expect(p.removed.map((i) => i.id)).toContain("3d");
  });
  test("an empty machine still gives a profile", async () => {
    const p = await buildProfile({ wikiDir: `${root}/nope`, projectsDir: `${root}/nope2`, now: NOW });
    expect(p.interests).toEqual([]);
    expect(p.counts).toEqual({ wiki: 0, concepts: 0, repos: 0, log: 0 });
  });
});

// ── gems ──
const repo = (full: string, o: Partial<Repo> & { archived?: boolean; fork?: boolean } = {}): Repo => ({
  full, url: `https://github.com/${full}`, desc: "", stars: 300, lang: "TypeScript", pushed: daysAgo(5), created: daysAgo(400), license: "MIT", topics: [],
  owner: full.split("/")[0], name: full.split("/")[1], ...o,
});
const HD: Interest = { id: "human-design", label: "Human Design", kind: "domain", q: '"human design"', terms: ["human design", "bodygraph"], tags: ["human-design"], score: 20, projects: ["chart-chat"], source: "wiki" };
const AG: Interest = { id: "agents", label: "Agent orchestration", kind: "tech", q: "agents", terms: ["agent orchestration", "agents", "orchestrat"], tags: ["multi-agent"], score: 10, projects: ["agent-deck"], source: "wiki" };
const ctx = (o: Partial<RankCtx> = {}): RankCtx => ({ now: NOW, dismissed: new Set(), exclude: new Set(), names: new Set(), own: "me", languages: new Set(["TypeScript"]), ...o });

describe("gem filtering", () => {
  test("moderately starred, alive, licensed, not archived/forked/yours/dismissed", () => {
    expect(isGem(repo("a/ok"), ctx())).toBe(true);
    expect(isGem(repo("a/tiny", { stars: 12 }), ctx())).toBe(false);
    expect(isGem(repo("a/giant", { stars: 90_000 }), ctx())).toBe(false);
    expect(isGem(repo("a/old", { pushed: daysAgo(400) }), ctx())).toBe(false);
    expect(isGem(repo("a/nolicense", { license: undefined }), ctx())).toBe(false);
    expect(isGem(repo("a/arch", { archived: true }), ctx())).toBe(false);
    expect(isGem(repo("a/fork", { fork: true }), ctx())).toBe(false);
    expect(isGem(repo("me/mine"), ctx())).toBe(false);
    expect(isGem(repo("a/Gone"), ctx({ dismissed: new Set(["a/gone"]) }))).toBe(false);
    expect(isGem(repo("SomeOrg/Cool-Lib"), ctx({ exclude: new Set(["someorg/cool-lib"]) }))).toBe(false);
    expect(isGem(repo("x/chart-chat"), ctx({ names: new Set(["chart-chat"]) }))).toBe(false);
  });
  test("toRepo keeps what cards need and flags archived/forks", () => {
    const r = toRepo({ full_name: "o/n", html_url: "u", description: null, stargazers_count: 5, language: null, pushed_at: "p", created_at: "c", license: { spdx_id: "NOASSERTION" }, topics: ["t"], owner: { login: "o" }, name: "n", archived: true }) as any;
    expect(r).toMatchObject({ full: "o/n", desc: "", stars: 5, license: "Other", topics: ["t"], owner: "o", name: "n", archived: true });
  });
  test("word-start matching", () => {
    expect(hasTerm("a rag pipeline", "rag")).toBe(true);
    expect(hasTerm("object storage", "rag")).toBe(false);
    expect(hasTerm("agent orchestration", "orchestrat")).toBe(true);
  });
});

describe("rankGems", () => {
  const results = {
    "human-design": [
      repo("x/hd-api", { desc: "Human Design chart API", topics: ["human-design"], stars: 80, created: daysAgo(900) }),
      repo("y/unrelated", { desc: "Object storage for teams", stars: 2000 }),
      repo("z/bodygraph-kit", { desc: "Render a bodygraph", stars: 150, lang: "Rust" }),
      repo("z/bodygraph-kit-windows", { desc: "Render a bodygraph (windows build)", stars: 120 }),
    ],
    agents: [
      repo("a/swarm", { desc: "Agent orchestration for coding agents", stars: 4000, created: daysAgo(60) }),
      repo("x/hd-api", { desc: "Human Design chart API", topics: ["human-design"], stars: 80, created: daysAgo(900) }),
      repo("b/awesome-agents", { desc: "A curated list of agents", stars: 4500, created: daysAgo(60) }),
      repo("c/agents-lite", { desc: "Small agents runner", stars: 900, created: daysAgo(90) }),
      repo("c/agents-pro", { desc: "Agents runner for teams", stars: 950, created: daysAgo(90) }),
    ],
  };
  const gems = rankGems(results, [HD, AG], ctx());
  const names = gems.map((g) => g.full);
  test("drops repos that don't mention the interest", () => expect(names).not.toContain("y/unrelated"));
  test("one entry per repo, with every interest that found it", () => {
    expect(names.filter((n) => n === "x/hd-api").length).toBe(1);
  });
  test("keeps one of a same-owner platform pair", () => {
    expect(names.filter((n) => n.startsWith("z/bodygraph-kit")).length).toBe(1);
  });
  test("lists rank below real projects", () => {
    expect(names.indexOf("b/awesome-agents")).toBeGreaterThan(names.indexOf("a/swarm"));
  });
  test("the main interest isn't drowned out by a louder one", () => {
    const top4 = rankGems(results, [HD, AG], ctx(), 3).map((g) => g.full);
    expect(top4.some((n) => n === "x/hd-api" || n.startsWith("z/bodygraph"))).toBe(true);
  });
  test("why names the interest and your projects", () => {
    const g = gems.find((x) => x.full === "a/swarm")!;
    expect(g.why[0]).toEqual({ id: "agents", label: "Agent orchestration", projects: ["agent-deck"] });
    expect(g.spm).toBeGreaterThan(1000);
  });
  test("dismissed repos disappear", () => {
    expect(rankGems(results, [HD, AG], ctx({ dismissed: new Set(["a/swarm"]) })).map((g) => g.full)).not.toContain("a/swarm");
  });
});

describe("rankTrending", () => {
  test("new and climbing, ranked by stars per day, giants and stale excluded", () => {
    const t = rankTrending({ agents: [
      repo("n/new-agents", { desc: "agents", stars: 1400, created: daysAgo(14) }),
      repo("n/slow-agents", { desc: "agents", stars: 400, created: daysAgo(100) }),
      repo("n/giant-agents", { desc: "agents", stars: 80_000, created: daysAgo(30) }),
    ] }, [AG], ctx());
    expect(t.map((g) => g.full)).toEqual(["n/new-agents", "n/slow-agents"]);
  });
});

describe("extractKeywords", () => {
  test("phrases, synonyms and tech words; no filler", () => {
    const k = extractKeywords("An app that watches my Human Design transits every morning and sends me a TTS voice note on Telegram");
    expect(k[0]).toBe("human design");
    expect(k).toContain("text to speech");
    expect(k).toContain("telegram");
    expect(k).not.toContain("app");
    expect(k).not.toContain("every");
    expect(k.length).toBeLessThanOrEqual(6);
  });
  test("plurals fold", () => expect(extractKeywords("maps of drones")).toEqual(["map", "drone"]));
  test("nothing searchable", () => expect(extractKeywords("I want to make something really cool")).toEqual([]));
});

describe("idea search ranking", () => {
  const items = [
    repo("a/drone-map", { desc: "Live map of drone flights", stars: 50, pushed: daysAgo(10) }),
    repo("b/voice-bot", { desc: "Telegram voice bot", stars: 900 }),
    repo("c/other", { desc: "Nothing relevant", stars: 5000 }),
    repo("d/old", { desc: "drone telemetry", archived: true } as any),
  ];
  const r = rankIdeaRepos(items as any, ["drone", "map", "telegram"], NOW);
  test("keeps repos that mention a keyword; more keywords rank higher", () => {
    expect(r.map((x) => x.full)).toEqual(["a/drone-map", "b/voice-bot"]);
    expect(r[0].hits).toEqual(["drone", "map"]);
  });
  test("with plenty of matches, one generic word in common isn't enough", () => {
    const many = [...Array.from({ length: 6 }, (_, i) => repo(`m/drone-map-${i}`, { desc: "drone map" })), repo("g/generic", { desc: "a map", stars: 90_000 })];
    const names = rankIdeaRepos(many as any, ["drone", "map", "live"], NOW).map((x) => x.full);
    expect(names).not.toContain("g/generic");
    expect(names.length).toBe(6);
  });
  test("weak words sort last", () => expect(extractKeywords("a live globe of satellites")).toEqual(["satellite", "globe", "live"]));
  test("roles", () => {
    expect(roleOf(repo("x/y", { desc: "Telegram bot framework" }))).toBe("Integrations & bots");
    expect(roleOf(repo("x/y", { desc: "Whisper speech to text" }))).toBe("Media: audio, video, images");
    expect(roleOf(repo("x/y", { desc: "Something" }))).toBe("Building blocks");
    const g = groupByRole(r);
    expect(g.map((x) => x.role)).toEqual(["Maps & places", "Integrations & bots"]);
  });
});

describe("ideas folder", () => {
  const dir = `${root}/ideas`;
  w(`${dir}/drone-map.md`, "---\nidea: A live map of every drone show\ncreated: 2026-09-26\nstatus: plan\n---\n# Drone Atlas\n\n## In one paragraph\nA map that finds shows.\n");
  w(`${dir}/notes.txt`, "ignored");
  utimesSync(`${dir}/drone-map.md`, new Date(NOW), new Date(NOW));
  test("plans, pending research and the sessions that made them", () => {
    const rows = [{ key: "k1", title: "Plan: drones", status: "working", firstPrompt: "Research and plan this idea, then write the plan to ~/.config/herdr-deck/ideas/drone-map.md" }];
    const list = listIdeas(dir, rows, [{ slug: "drone-map", text: "dup", at: Date.now() }, { slug: "tiny-idea", text: "A tiny idea", at: Date.now() }]);
    expect(list.length).toBe(2);
    const plan = list.find((x) => x.slug === "drone-map")!;
    expect(plan).toMatchObject({ title: "Drone Atlas", idea: "A live map of every drone show", status: "plan", created: "2026-09-26", session: { key: "k1", status: "working" } });
    expect(plan.summary).toBe("A map that finds shows.");
    expect(list.find((x) => x.slug === "tiny-idea")).toMatchObject({ pending: true, status: "researching", session: undefined });
  });
  test("missing folder is fine", () => expect(listIdeas(`${root}/none`)).toEqual([]));
});

describe("prompts", () => {
  const pctx = { ideasDir: "/Users/x/.config/herdr-deck/ideas", connectionsFile: "/Users/x/.config/herdr-deck/CONNECTIONS.md", projectsDir: "/Users/x/Documents/Projects" };
  test("research prompt: file, connections, sections, starting points, no building", () => {
    const p = researchPrompt("A live drone map", "drone-map", { ...pctx, repos: [repo("a/drone-map", { stars: 50 })], projects: ["gods-eye-view"], keywords: ["drone", "map"] });
    expect(p.split("\n")[0]).toContain("ideas/drone-map.md"); // first line, so the deck can match the session to the plan
    expect(p).toContain("CONNECTIONS.md");
    expect(p).toContain("a/drone-map (50★)");
    expect(p).toContain("gods-eye-view");
    expect(p).toContain("## First 3 tasks");
    expect(p).toContain("don't build anything");
  });
  test("fork prompt clones, doesn't fork or push", () => {
    const p = forkPrompt({ ...repo("o/cool", { desc: "Cool" }), why: [{ id: "agents", label: "Agent orchestration", projects: ["agent-deck"] }] }, pctx);
    expect(p).toContain("gh repo clone o/cool");
    expect(p).toContain("agent-deck");
    expect(p).toContain("Don't push");
  });
  test("build prompt points at the plan and stops after task 1", () => {
    const p = buildPrompt("drone-map", "Drone Atlas", pctx);
    expect(p).toContain("ideas/drone-map.md");
    expect(p).toContain("Documents/Projects/drone-map");
    expect(p).toContain("task 1");
  });
  test("slugify", () => expect(slugify("A Live Map of Drones!! 🚁 over Tel-Aviv")).toBe("a-live-map-of-drones-over-tel-aviv"));
});

describe("sparks", () => {
  test("deterministic per seed, varied, built from the profile", async () => {
    const p = await buildProfile({ wikiDir: wiki, projectsDir: projects, connections: ["Telegram", "ElevenLabs"], now: NOW });
    const a = sparks(p, [], 7), b = sparks(p, [], 7), c = sparks(p, [], 8);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(2);
    expect(a.map((s) => s.title)).not.toEqual(c.map((s) => s.title));
    for (const s of a) { expect(s.title).toMatch(/^What if /); expect(s.idea.length).toBeGreaterThan(20); expect(s.uses.length).toBeGreaterThan(0); }
    expect(new Set(a.map((s) => s.id)).size).toBe(a.length);
  });
});

describe("createDiscover (no network: gh is faked)", () => {
  const data = `${root}/data`;
  const calls: string[] = [];
  const fakeGh = async (args: string[]): Promise<GhRes> => {
    calls.push(args.join(" "));
    if (args[0] === "user") return { ok: true, status: 200, data: { login: "me" } };
    const q = args[args.indexOf("-f") + 1];
    if (args.includes("search/topics")) return { ok: true, status: 200, remaining: 25, data: { items: [{ name: "drones", short_description: "Drones" }] } };
    const item = (n: string, desc: string, extra = {}) => ({ full_name: n, html_url: `https://github.com/${n}`, description: desc, stargazers_count: 400, language: "TypeScript", pushed_at: new Date().toISOString(), created_at: "2025-01-01T00:00:00Z", license: { spdx_id: "MIT" }, topics: [], owner: { login: n.split("/")[0] }, name: n.split("/")[1], ...extra });
    if (/human design/.test(q)) return { ok: true, status: 200, remaining: 20, data: { items: [item("x/hd-lib", "Human Design calculator"), item("me/mine", "Human Design mine")] } };
    if (/drone/.test(q)) return { ok: true, status: 200, remaining: 20, data: { items: [item("d/drone-map", "Live drone map")] } };
    return { ok: true, status: 200, remaining: 20, data: { items: [] } };
  };
  const d = createDiscover({ dataDir: data, wikiDir: wiki, projectsDir: projects }, { gh: fakeGh, gap: 0, connections: async () => ["GitHub", "Telegram", "ElevenLabs", "Gmail"], rows: () => [] });

  test("state renders at once, refreshes in the background, then ranks gems", async () => {
    const first = await d.handle("/api/discover", {});
    expect(first.refreshing).toBe(true);
    expect(first.profile.interests[0].id).toBe("human-design");
    await d.refresh();
    const s = await d.handle("/api/discover", {});
    expect(s.gems.map((g: any) => g.full)).toEqual(["x/hd-lib"]); // your own repo is left out
    expect(s.login).toBe("me");
    expect(s.stale).toBe(false);
    expect(calls.some((c) => c.includes("stars:30..5000") && c.includes("archived:false"))).toBe(true);
    // only interest keywords go out: no wiki text
    expect(calls.join(" ")).not.toContain("Talk to your");
  });
  test("interests: add, remove, restore, persisted", async () => {
    let s = await d.handle("/api/discover/interest", { op: "add", label: "Drone shows" });
    expect(s.profile.interests[0]).toMatchObject({ id: "you:drone-shows", label: "Drone shows" });
    s = await d.handle("/api/discover/interest", { op: "remove", id: "agents" });
    expect(s.profile.interests.map((i: any) => i.id)).not.toContain("agents");
    expect(s.profile.removed.map((i: any) => i.id)).toContain("agents");
    expect(JSON.parse(readFileSync(`${data}/discover.json`, "utf8"))).toMatchObject({ added: [{ label: "Drone shows" }], removed: ["agents"] });
    s = await d.handle("/api/discover/interest", { op: "restore" });
    expect(s.profile.interests.map((i: any) => i.id)).toContain("agents");
  });
  test("save and dismiss", async () => {
    const g = { full: "x/hd-lib", desc: "Human Design calculator", stars: 400 };
    let r = await d.handle("/api/discover/repo", { op: "save", repo: g });
    expect(r.saved[0]).toMatchObject({ full: "x/hd-lib", url: "https://github.com/x/hd-lib" });
    r = await d.handle("/api/discover/repo", { op: "dismiss", repo: g });
    expect(r.dismissed).toBe(1);
    const s = await d.handle("/api/discover", {});
    expect(s.gems.map((x: any) => x.full)).not.toContain("x/hd-lib");
    await d.handle("/api/discover/repo", { op: "undismiss", full: "*/*" });
    await expect(d.handle("/api/discover/repo", { op: "save", repo: { full: "not a repo" } })).rejects.toThrow();
  });
  test("idea lab: keywords, grouped building blocks, topics and a research prompt", async () => {
    const r = await d.handle("/api/discover/idea", { text: "A live map of every drone show on Earth" });
    expect(r.keywords).toEqual(expect.arrayContaining(["drone", "map"]));
    expect(r.groups[0].repos[0].full).toBe("d/drone-map");
    expect(r.topics[0].name).toBe("drones");
    expect(r.prompt).toContain(`ideas/${r.slug}.md`);
    expect(r.cwd).toBe(projects);
    await expect(d.handle("/api/discover/idea", { text: "make it cool" })).rejects.toThrow(/Say a little more/);
    const v = await d.handle("/api/discover/idea", { text: "Drone show alerts as a voice note on Telegram" });
    expect(v.connections).toEqual(["Telegram", "ElevenLabs"]); // what the idea talks about, not every service you have
  });
  test("ideas: started, listed, read, forgotten", async () => {
    let r = await d.handle("/api/discover/idea-started", { slug: "drone-map", text: "A live drone map" });
    expect(r.ideas[0]).toMatchObject({ slug: "drone-map", pending: true });
    w(`${data}/ideas/drone-map.md`, "---\nidea: A live drone map\nstatus: plan\n---\n# Drone Atlas\n\nText.\n");
    r = await d.handle("/api/discover/ideas", {});
    expect(r.ideas[0]).toMatchObject({ slug: "drone-map", title: "Drone Atlas", status: "plan", summary: "Text." });
    expect(r.ideas[0].pending).toBeUndefined();
    const f = await d.handle("/api/discover/idea-file", { slug: "drone-map" });
    expect(f.text).toContain("# Drone Atlas");
    await expect(d.handle("/api/discover/idea-file", { slug: "../etc/passwd" })).rejects.toThrow();
    const b = await d.handle("/api/discover/prompt", { kind: "build", slug: "drone-map", title: "Drone Atlas" });
    expect(b.prompt).toContain("Start building \"Drone Atlas\"");
    r = await d.handle("/api/discover/idea-forget", { slug: "drone-map" });
    expect(r.ideas.find((x: any) => x.slug === "drone-map")?.pending).toBeUndefined();
  });
  test("cache survives a restart", async () => {
    d.flush();
    const again = createDiscover({ dataDir: data, wikiDir: wiki, projectsDir: projects }, { gh: fakeGh, gap: 0 });
    const s = await again.handle("/api/discover", {});
    expect(s.fetchedAt).toBeGreaterThan(0);
    expect(s.saved[0].full).toBe("x/hd-lib");
  });
});

describe("idea lab never waits silently on GitHub's search limit", () => {
  test("once the limit is used up, an idea search fails fast and says when to retry", async () => {
    let n = 0;
    const limited = async (args: string[]): Promise<GhRes> => {
      if (args[0] === "user") return { ok: true, status: 200, data: { login: "me" } };
      n++;
      return { ok: true, status: 200, remaining: 0, reset: Date.now() + 40_000, data: { items: [] } };
    };
    const d = createDiscover({ dataDir: `${root}/data-limit`, wikiDir: wiki, projectsDir: projects }, { gh: limited, gap: 0, rows: () => [] });
    await d.handle("/api/discover/idea", { text: "a live map of drones over the city" });
    const t0 = Date.now();
    const err = await d.handle("/api/discover/idea", { text: "a voice that reads today's transits every morning" }).catch((e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(String((err as Error).message)).toMatch(/search limit.*Try again in \d+s/);
    expect(n).toBeGreaterThan(0);
  });
});
