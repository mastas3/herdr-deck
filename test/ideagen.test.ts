import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AUDIENCES, buildInventory, capsOf } from "../src/ideagen/inventory";
import { closeTruncated, extractRecords, parseLoose } from "../src/ideagen/json";
import { briefsFor, coherence, engineFit, pickDiverse, postRelevance } from "../src/ideagen/sampler";
import { combine, jevNorm, rubricNorm, scoreIdea, spearman, superiority } from "../src/ideagen/judge";
import { slopCheck, unsourcedStat } from "../src/ideagen/slop";
import { createRepoFinder, haveFor, mapConnectors, requiredCaps } from "../src/ideagen/connectors";
import { evidenceScore, indexPosts, matchEvidence } from "../src/ideagen/evidence";
import { clusterTrends, parseAtom, parseHNHits, rankWithinSource, type TrendSignal } from "../src/ideagen/trends";
import { laneize, toCard } from "../src/ideagen/gallery";
import { parsePremortems } from "../src/ideagen/premortem";
import { parseKitReply, readiness } from "../src/ideagen/kit";
import { materializeKit } from "../src/ideagen/kit-files";
import { budgetedClaude, createBudget } from "../src/ideagen/llm";
import { libraryEvidence, researchEvidence } from "../src/ideagen/library";
import { normalizeIdea } from "../src/ideagen/strategies";
import type { Idea, PainCorpus, PainPost, Rubric, StarterKit } from "../src/ideagen/types";

const root = mkdtempSync(`${tmpdir()}/deck-ideagen-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

// ── a small inventory ──────────────────────────────────────────────────────────────────────
const inv = buildInventory({
  projects: [
    { name: "hd-atlas", status: "active", tags: ["human-design", "rag"], tldr: "Human Design knowledge base with a curated corpus and chart chat.", weight: 5 },
    { name: "fb-group-scraper", status: "active", tags: ["osint"], tldr: "Archives Facebook groups into SQLite with a semantic index.", weight: 3 },
    { name: "osint-lab", status: "active", tags: ["osint"], tldr: "OSINT provenance lab for identity checks.", weight: 3 },
  ],
  sections: [
    { id: "services", items: [{ id: "svc:gumroad", name: "Gumroad", state: "ready", detail: "Sell digital products" }, { id: "svc:netlify", name: "Netlify", state: "ready", detail: "Deploys" }, { id: "svc:telegram", name: "Telegram", state: "ready", detail: "Bots and channels" }] },
    { id: "accounts", items: [{ id: "acct:facebook", name: "Facebook", state: "ready", detail: "Profile, Pages and groups" }] },
    { id: "keys", items: [{ id: "k1", name: "GUMROAD_ACCESS_TOKEN", state: "ready", detail: "set in ~/.zshrc" }] },
  ],
  recs: [{ id: "posthog", name: "PostHog", url: "https://posthog.com", free: "Free tier", what: "Product analytics, funnels", cat: "code" }],
});
const asset = (name: string) => inv.assets.find((a) => a.name === name)!;
const hdHebrew = inv.audiences.find((a) => a.id === "hd-hebrew")!;
const post = (id: string, text: string, pain = 3): PainPost => ({ id, source: "reddit", url: `https://reddit.com/${id}`, title: text.slice(0, 40), snippet: text, pain, score: 2, signals: [], at: 0, audience: "hd-global" });
const idea = (o: Partial<Idea> = {}): Idea => ({
  id: "B-pain:1:x:1", strategy: "B-pain", promptVersion: "v4", round: 1, name: "Hebrew chart reports", hook: "Your chart explained in plain Hebrew",
  buyer: "Hebrew-speaking Human Design fans in the HumandesignIsrael Facebook group", pain: "paid Human Design apps crash and their charts are only in English",
  offer: "A 6-page Hebrew PDF report of your chart", price: "₪49 one-time", channel: "Post in the HumandesignIsrael Facebook group and DM 20 members who asked",
  mvp: "A form, the chart from hd-atlas, a PDF", stack: [{ name: "hd-atlas", role: "chart + texts", assetId: asset("hd-atlas").id, owned: true }],
  needs: ["hd-calc", "pdf-report"], timeToFirstDollarDays: 7, difficulty: "weekend", evidenceIds: [], firstQuests: [], topics: ["hd"], source: "claude", ...o,
});
const rubric = (v: number, o: Partial<Rubric> = {}): Rubric => ({ spec: v, feasible: v, buyer: v, distribution: v, novelty: v, fun: v, p10: 0.1, flaw: "", ...o });

describe("JSON repair", () => {
  test("fences, prose and trailing commas", () => {
    expect(parseLoose('Here you go:\n```json\n{"ideas":[{"name":"A",},]}\n```')).toEqual({ ideas: [{ name: "A" }] });
  });
  test("a doubled quote after a key and a missing comma between objects", () => {
    const recs = extractRecords('{"scores":[{"ref":"i1","flaw"":"x"}{"ref":"i2","flaw":"y"}]}', ["scores"], ["ref"]);
    expect(recs.map((r) => r.ref)).toEqual(["i1", "i2"]);
  });
  test("Hebrew acronyms with a double quote inside strings", () => {
    expect(parseLoose('{"t":"גישה ניתנת ע"י הבוט"}')?.t).toBe("גישה ניתנת ע״י הבוט");
  });
  test("a reply cut off mid-string keeps what arrived", () => {
    expect(closeTruncated('{"ready":3,"notes":"half a sen')).toBe('{"ready":3,"notes":"half a sen"}');
    expect(parseLoose('{"ready":3,"questions":["a","b"],"notes":"cut')?.ready).toBe(3);
  });
  test("broken reply: every complete record with the expected keys", () => {
    const recs = extractRecords('{"ideas":[{"name":"A","hook":"h"},{"name":"B","hook":"h2"},{"name":"C","ho', ["ideas"], ["name"]);
    expect(recs.map((r) => r.name)).toEqual(["A", "B"]);
  });
});

describe("coherent sampler", () => {
  test("capabilities and the engine fit: an HD engine fits the HD crowd, an OSINT lab doesn't", () => {
    expect(capsOf("Human Design knowledge base with a curated corpus")).toContain("hd-calc");
    expect(engineFit(asset("hd-atlas"), { caps: hdHebrew.caps, topics: hdHebrew.topics })).toBeGreaterThan(0.5);
    expect(engineFit(asset("osint-lab"), { caps: hdHebrew.caps, topics: hdHebrew.topics })).toBe(0);
    expect(coherence({ audience: hdHebrew, engine: asset("hd-atlas") })).toBeGreaterThan(coherence({ audience: hdHebrew, engine: asset("osint-lab") }));
  });
  test("picking is diverse: the same engine isn't used over and over", () => {
    const e1 = asset("hd-atlas"), e2 = asset("fb-group-scraper");
    const cands = [0.9, 0.85, 0.8, 0.5].map((score, i) => ({ engine: i < 3 ? e1 : e2, compat: 1, demand: 1, score }));
    const picked = pickDiverse(cands, 2, 1);
    expect(new Set(picked.map((c) => c.engine!.id)).size).toBe(2);
  });
  test("audience-first briefs pair each audience with an engine that fits it", () => {
    const corpus: PainCorpus = { at: 0, posts: [], themes: [], queries: [] };
    const briefs = briefsFor("C-audience", 6, { inv, corpus, seed: 3, clusters: [] });
    expect(briefs.length).toBeGreaterThan(0);
    for (const b of briefs) if (b.engine && b.audience) expect(engineFit(b.engine, { caps: b.audience.caps, topics: b.audience.topics })).toBeGreaterThan(0);
  });
  test("a pain post is on topic only when it shares two of the query's words", () => {
    expect(postRelevance(post("a", "I want a relationship compatibility test that works"), "relationship compatibility app")).toBe(1);
    expect(postRelevance(post("b", "SteamOS compatibility layer is broken"), "relationship compatibility app")).toBeLessThan(0.5);
  });
  test("every audience names the capabilities that serve it", () => {
    for (const a of AUDIENCES) expect(a.caps.length).toBeGreaterThan(0);
  });
});

describe("scoring", () => {
  test("rubric and Jev normalize to 0..1; missing judges are reweighted, not zero", () => {
    expect(rubricNorm(rubric(1))).toBe(0);
    expect(rubricNorm(rubric(5))).toBe(1);
    expect(jevNorm(0.8)).toBe(1);
    const all = combine({ rubric: rubric(5), jevP10: 0.5, evidence: 1 });
    expect(all.quality).toBe(100);
    expect(combine({ jevP10: 0.5, evidence: 1 }).quality).toBe(100);
    expect(combine({ rubric: rubric(3), evidence: 0 }).qualityNoEvidence).toBe(50);
  });
  test("the slop gate zeroes quality but keeps the raw score", () => {
    const s = scoreIdea(idea({ hook: "A seamless AI-powered platform for everyone" }), { rubric: rubric(4), jevP10: 0.4, matches: [], posts: new Map(), inv });
    expect(s.slop!.pass).toBe(false);
    expect(s.quality).toBe(0);
    expect(s.qualityRaw).toBeGreaterThan(0);
  });
  test("statistics: claims are flagged, segment ranges and offer terms are not", () => {
    expect(unsourcedStat("cut no-shows by 40%")).toBe("40%");
    expect(unsourcedStat("post in r/humandesign (200k members)")).toBe("200k members");
    expect(unsourcedStat("YouTubers with 10k–1M subscribers", [], true)).toBeUndefined();
    expect(unsourcedStat("10 groups with 20k+ members each")).toBe("20k+ members");
    expect(unsourcedStat("30% revenue share for the coach")).toBeUndefined();
  });
  test("deterministic slop checks name what's missing", () => {
    const r = slopCheck(idea({ price: "", channel: "social media", stack: [] }), [], inv).reasons.join("; ");
    expect(r).toContain("no concrete price");
    expect(r).toContain("no specific first-customer channel");
    expect(r).toContain("no owned project");
    expect(r).toContain("no linked evidence");
  });
  test("agreement statistics", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(superiority([3, 4], [1, 2])).toBe(1);
  });
});

describe("evidence", () => {
  const posts = [
    post("p1", "Every Human Design app I paid for crashes, and the charts are only in English; I wish there was one in Hebrew for Israeli users"),
    post("p2", "This is the WORST"),
    post("p3", "Looking for a podcast clip tool that finds the best moments automatically"),
  ];
  const ix = indexPosts(posts);
  test("matches need three distinctive shared words; a two-word rant never counts", () => {
    const m = matchEvidence(idea(), ix);
    expect(m.map((x) => x.postId)).toEqual(["p1"]);
    expect(evidenceScore(m, new Map(posts.map((p) => [p.id, p])))).toBeGreaterThan(0);
    expect(evidenceScore([], new Map())).toBe(0);
  });
});

describe("connectors", () => {
  test("required capabilities include selling and measuring a web offer", () => {
    expect(requiredCaps(idea({ offer: "a web app with your chart" }))).toEqual(expect.arrayContaining(["payments", "hosting", "landing", "analytics"]));
  });
  test("infrastructure counts only through a service; missing ones get catalog services and a checked library", async () => {
    expect(haveFor("payments", inv).map((a) => a.name)).toEqual(["Gumroad"]);
    const gh = async (args: string[]) => (args[0] === "repos/PostHog/posthog-js" ? { ok: true, status: 200, data: { full_name: "PostHog/posthog-js", html_url: "https://github.com/PostHog/posthog-js", clone_url: "x", description: "js", stargazers_count: 600 } } : { ok: false, status: 404 });
    const needs = await mapConnectors(idea({ offer: "a web app with your chart" }), inv, createRepoFinder(gh as any));
    const analytics = needs.find((n) => n.cap === "analytics")!;
    expect(analytics.missing).toBe(true);
    expect(analytics.suggestions.map((s) => s.name)).toEqual(expect.arrayContaining(["PostHog", "PostHog/posthog-js"]));
    expect(needs.find((n) => n.cap === "payments")!.missing).toBe(false);
  });
});

describe("trends", () => {
  const now = Date.parse("2026-09-26T00:00:00Z");
  test("parsers: HN hits, Product Hunt Atom with the tagline in the title", () => {
    const hn = parseHNHits({ hits: [{ objectID: "1", title: "Show HN: Laya typed decisions", points: 200, created_at_i: now / 1000 - 86400 }] }, "showhn", now);
    expect(hn[0].velocity).toBe(200);
    const ph = parseAtom('<feed><entry><published>2026-09-25T00:00:00Z</published><link href="https://www.producthunt.com/products/wand"/><title>Wand</title><content type="html">&lt;p&gt;Build software fast&lt;/p&gt;</content></entry></feed>', "producthunt", now);
    expect(ph[0].title).toBe("Wand — Build software fast");
  });
  test("clustering: a word shared across sources is a trend with heat", () => {
    const sig = (id: string, source: TrendSignal["source"], title: string): TrendSignal => ({ id, source, title, url: id, at: now - 86400000, text: "", metric: 100, velocity: 100, rank: 0 });
    const t = clusterTrends(rankWithinSource([sig("a", "showhn", "Laya decision models run locally"), sig("b", "github", "Laya decision runtime for MLX"), sig("c", "reddit", "Unrelated cat picture")]), now);
    expect(t[0].signals.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(t[0].heat).toBeGreaterThan(0);
  });
});

describe("gallery", () => {
  const card = (id: string, name: string, q: number, extra: Partial<Idea> = {}) => toCard(idea({ id, name, offer: `${name} offer`, ...extra }), { evidence: 0.7, evidenceMatches: [], quality: q, qualityRaw: q, qualityNoEvidence: q, jevP10: 0.5, rubric: rubric(3) }, []);
  test("near-duplicates collapse; trend lanes don't repeat each other", () => {
    const trend = (heat: number, earliness: number) => ({ trend: { label: "t", whyNow: "Laya hit 25k stars", signals: [{ id: "s", source: "github", title: "t", url: "u" }], heat, earliness } });
    const lanes = laneize([card("1", "Hebrew chart report", 80), card("2", "Hebrew chart report pro", 70), card("3", "Tender alerts", 60, trend(5, 0.9)), card("4", "Clip finder", 50, trend(0.5, 0.9))]);
    const top = lanes.find((l) => l.id === "top")!.ideas;
    expect(top).toContain("1");
    expect(top).not.toContain("2");
    expect(lanes.find((l) => l.id === "hot")!.ideas).toEqual(["3"]);
    expect(lanes.find((l) => l.id === "early")!.ideas).toEqual(["4"]);
  });
});

describe("pre-mortem", () => {
  test("failures carry pattern labels, unsourced numbers are marked, the revision is a normal idea", () => {
    const o = idea();
    const text = JSON.stringify({ premortems: [{ ref: "i1", failures: [{ reason: "Only ~500 buyers exist", pattern: 2, evidence: "none" }, { reason: "One-off purchase", pattern: 8, evidence: "p1" }], fix: "Make it a monthly note", revised: { ...o, name: "Hebrew morning chart note", price: "₪19/month", stack: [{ name: "hd-atlas", role: "texts" }] } }] });
    const r = parsePremortems(text, [{ idea: o, posts: [], outside: [] }], inv).get(o.id)!;
    expect(r.premortem.failures[0].reason).toContain("estimate");
    expect(r.premortem.failures[1].pattern).toBe("Customers keep using it");
    expect(r.revised!.id).toBe(`${o.id}:pm`);
    expect(r.revised!.premortem!.pivotedFrom!.name).toBe(o.name);
  });
});

describe("starter kits", () => {
  const reply = JSON.stringify({ spec: { problem: "p", buyer: "b", jobs: ["j"], scope_in: ["a"], scope_out: ["b"], metrics: [{ metric: "sales", target: "1", milestone: "first paying" }] }, architecture: { summary: "s", components: [{ name: "bot", does: "d", uses: "hd-atlas" }], data_model: [{ entity: "User", fields: ["id"] }], flows: [{ name: "buy", steps: ["pay"] }] }, tasks: [1, 2, 3].map((n) => ({ id: `T${n}`, title: `t${n}`, size: "S", prompt: "do it", accept: ["ok"] })), landing: { headline: "h", subhead: "s", benefits: ["a", "b", "c"], cta: "Buy" }, pricing: [{ tier: "Solo", price: "₪49", includes: ["x"] }], launch_posts: [{ channel: "Facebook", text: "t" }], outreach: "hi" });
  test("parse, readiness, and files on disk with key names only", () => {
    const m = parseKitReply(reply);
    expect(m.buildPlan.length).toBe(3);
    const base = { ideaId: "i", slug: "s", at: 0, version: "k1", spec: m.spec, architecture: m.architecture, buildPlan: m.buildPlan,
      connectors: { repos: [{ name: "grammyjs/grammY", url: "https://github.com/grammyjs/grammY", why: "", verified: true }], services: [], keys: [{ name: "GUMROAD_ACCESS_TOKEN", purpose: "payments", have: true, where: "set in ~/.zshrc" }, { name: "TELEGRAM_BOT_TOKEN", purpose: "telegram-bot", have: false }], mcpAndSkills: [], missing: [] },
      scaffold: { folder: "~/x", base: "b", files: [], deploy: "Netlify" }, gtm: { landing: m.landing, pricing: m.pricing, launchPosts: m.launchPosts, outreach: m.outreach, graphics: [] }, quests: [] };
    const kit: StarterKit = { ...base, readiness: readiness(base), cost: { claudeCalls: 1, ms: 0 } };
    expect(kit.readiness.items.find((i) => i.label === "Key TELEGRAM_BOT_TOKEN")!.status).toBe("needs-user");
    const dir = `${root}/kit`;
    const files = materializeKit(kit, "Test", dir);
    expect(files).toContain("TASKS.md");
    const env = readFileSync(`${dir}/.env.example`, "utf8");
    expect(env).toContain("GUMROAD_ACCESS_TOKEN=");
    expect(env).not.toMatch(/=\S/);
    expect(() => materializeKit(kit, "Test", dir)).toThrow();
  });
});

describe("budget and outside evidence", () => {
  test("Claude calls are counted, cached by prompt, and refused over budget", async () => {
    const b = createBudget({ claudeMax: 1, jevMax: 0, cacheDir: `${root}/cache` });
    let n = 0;
    const run = budgetedClaude(b, async () => { n++; return { text: "ok", model: "haiku", ms: 1, costUsd: 0.01, inTok: 1, outTok: 1 }; });
    await run({ system: "s", user: "u", tag: "t" });
    await run({ system: "s", user: "u", tag: "t" });
    expect(n).toBe(1);
    await expect(run({ system: "s", user: "other", tag: "t" })).rejects.toThrow("budget");
  });
  test("library and research lookups are empty when absent and use what's there", async () => {
    expect(await libraryEvidence("human design reports", { dir: `${root}/nope` })).toEqual([]);
    expect(await libraryEvidence("x", { search: async () => [{ text: "t", source: "library" }] })).toHaveLength(1);
    mkdirSync(`${root}/research/run`, { recursive: true });
    writeFileSync(`${root}/research/run/01.md`, "# Etsy HD readings\n\nTop Human Design chart readings on Etsy sell PDF reports for $25 to $60; buyers complain about generic reports.\n");
    expect(researchEvidence("human design chart readings reports etsy", { dir: `${root}/research` })[0].source).toBe("research");
  });
  test("normalizing keeps only evidence ids the brief offered", () => {
    const b: any = { id: "b", strategy: "B-pain", pain: { quotes: [post("p1", "x")] }, compat: 1, demand: 1 };
    const i = normalizeIdea({ name: "N", hook: "h", evidence_ids: ["p1", "made-up"], stack: [{ name: "hd-atlas", role: "r" }] }, b, "B-pain", "v4", 1, inv)!;
    expect(i.evidenceIds).toEqual(["p1"]);
    expect(i.stack[0].owned).toBe(true);
  });
});
