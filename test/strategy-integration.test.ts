// Comparable founders flowing into every strategy the deck writes: pre-mortems, starter kits, the idea panel, Studio
// builds, research planning and scoring, daily quests, the project page's plan prompt, and the library's own dates.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { findComparables, type Target } from "../src/library-strategy";
import { runPremortems } from "../plugins-builtin/discover/ideagen/premortem";
import { onlyKnownLinks, vetCite } from "../plugins-builtin/discover/ideagen/kit";
import { materializeKit } from "../plugins-builtin/discover/ideagen/kit-files";
import { buildInventory } from "../plugins-builtin/discover/ideagen/inventory";
import { createGalleryServer } from "../plugins-builtin/discover/gallery-server";
import { buildComps } from "../plugins-builtin/discover/studio";
import { plannerPrompt } from "../plugins-builtin/research/autoresearch-core";
import { createAutoresearch } from "../plugins-builtin/research/autoresearch";
import { createLibrary } from "../plugins-builtin/library/library";
import { openCards } from "../plugins-builtin/library/library-cards";
import type { Idea, StarterKit } from "../plugins-builtin/discover/ideagen/types";
import { CARDS } from "./strategy-fixtures";
import { camp, MIN, REPORT, T0 } from "../plugins-builtin/research/test/autoresearch-fixtures";

const root = mkdtempSync(`${tmpdir()}/deck-strategy-int-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const find = (t: Target) => { const r = findComparables(CARDS, t); return r.comparables.length ? r : undefined; };
const PLAN = { name: "Podcast Clip Studio", offer: "5 podcast clips and a transcript per episode", buyer: "podcasters who publish weekly", price: "$29/month", channel: "r/podcasting — a before/after post" };
const inv = buildInventory({ sections: [], projects: [{ name: "yt-transcriber", status: "active", tags: ["video"], tldr: "Clips from long videos.", weight: 5 }], gems: [], recs: [] });
const idea = (o: Partial<Idea> = {}): Idea => ({ id: "i1", strategy: "C-audience", promptVersion: "v4", round: 0, hook: "Clips from every episode", pain: "no time to cut clips", mvp: "upload → clips", stack: [], needs: [], timeToFirstDollarDays: 14, difficulty: "week", quests: [], evidenceIds: [], topics: [], ...PLAN, ...o } as Idea);

describe("pre-mortems cite comparables", () => {
  test("the prompt lists them as evidence with the strategy check; a cited id becomes the founder and the link", async () => {
    const o = idea({ price: "$149/month" });
    const comps = find({ ...PLAN, price: o.price });
    let user = "";
    const claude = async (x: any) => { user = x.user; return { text: JSON.stringify({ premortems: [{ ref: "i1", failures: [{ reason: "Churn after the first month, like comparable ClipPod", pattern: 3, evidence: "c1-1" }], fix: "Charge per episode", revised: { ...o, name: "Clip Studio per episode" } }] }), model: "haiku", ms: 1, costUsd: 0, inTok: 1, outTok: 1 }; };
    const { results } = await runPremortems([{ idea: o, posts: [], outside: [], comparables: comps }], inv, claude as any, "t");
    expect(user).toContain("(c1-1) comparable ClipPod [Nov 2025]: sold AI podcast clips for podcasters; price \"$29 a month\"");
    expect(user).toContain("what failed: Stalled for months on churn");
    expect(user).toContain("Strategy check against comparables: Comparables in this category charged $19 a month–$39 a month; this plan charges $149 a month");
    expect(user).toContain("comparable Acme stalled on retention");
    expect(results.get("i1")!.premortem.failures[0].evidence).toBe(`ClipPod: ${CARDS[0].url}&t=500s`);
  });
});

describe("starter kits are grounded in comparables", () => {
  test("the kit prompt carries them; pricing, first 10 and the launch cite them; invented links are dropped; files include COMPARABLES.md", async () => {
    const dir = mkdtempSync(`${root}/g-`);
    const lab = JSON.parse(readFileSync(new URL("../docs/idea-lab/gallery.json", import.meta.url).pathname, "utf8"));
    const id = "G-constraint:1:podcastclipstudiomembers:tzq";
    let user = "";
    const reply = { spec: { problem: "p", buyer: "b", jobs: [], scope_in: [], scope_out: [], metrics: [] }, architecture: { summary: "s", components: [], data_model: [], flows: [] }, tasks: [1, 2, 3].map((n) => ({ id: `T${n}`, title: `t${n}`, size: "S", prompt: "do it", accept: ["ok"] })),
      landing: { headline: "h", subhead: "s", benefits: [], cta: "Buy" }, pricing: [{ tier: "Pro", price: "$29/month", includes: [] }], pricing_why: `ClipPod charges $29 a month (${CARDS[0].url}&t=60s).`,
      first_10: [{ step: "Post a before/after in r/podcasting", cites: `ClipPod ${CARDS[0].url}&t=300s` }, { step: "DM 20 hosts", cites: "https://example.com/made-up" }],
      launch_plan: [{ when: "week 1", what: "Demo post on Reddit", cites: "Snippy" }], launch_posts: [], outreach: "hi" };
    const g = createGalleryServer({ dir, projectsDir: `${dir}/p`, labFile: new URL("../docs/idea-lab/gallery.json", import.meta.url).pathname, sections: async () => [], projects: async () => [], gems: () => [], gh: async () => ({ ok: false }) as any,
      corpus: async () => ({ at: Date.now(), posts: [], themes: [], queries: [] }), trends: async () => undefined, recipe: [], premortems: 0, rubric: false, log: () => {},
      claudeRaw: async (x: any) => { user = x.user; return { text: JSON.stringify(reply), model: "sonnet", ms: 1, costUsd: 0, inTok: 1, outTok: 1 }; }, jevRaw: async () => ({ fallback: "unavailable" }) as any, comparables: find });
    expect(lab.ideas[id]).toBeTruthy();
    const full: any = await g.handle("/api/ideas/card", { id });
    expect(full.comparables.items[0].name).toBe("ClipPod");
    const kit = (await g.handle("/api/ideas/kit", { id })) as StarterKit;
    expect(user).toContain("COMPARABLE FOUNDERS");
    expect(user).toContain("1. ClipPod [Nov 2025]");
    expect(user).toContain("first_10");
    expect(kit.comparables!.items.slice(0, 3).map((c) => c.name)).toEqual(["ClipPod", "Snippy", "CastCut"]);
    expect(kit.gtm.pricingWhy).toContain("ClipPod");
    expect(kit.gtm.first10![0].cites).toContain("ClipPod");
    expect(kit.gtm.first10![1].cites).toBe("none"); // a link none of them has
    expect(kit.gtm.launchPlan![0].cites).toBe("Snippy");
    const files = materializeKit(kit, "Podcast Clip Studio", `${dir}/out`);
    expect(files).toContain("COMPARABLES.md");
    const md = readFileSync(`${dir}/out/COMPARABLES.md`, "utf8");
    expect(md).toContain("## ClipPod (Nov 2025)");
    expect(md).toContain(`- **Claimed revenue:** “$12K a month” ([1:00](${CARDS[0].url}&t=60s))`);
    expect(readFileSync(`${dir}/out/GTM.md`, "utf8")).toContain("## The first 10 customers");
  });
  test("vetCite keeps a named founder or one of their links, never an outside link", () => {
    const r = find(PLAN);
    expect(vetCite("Snippy's Reddit launch", r)).toBe("Snippy's Reddit launch");
    expect(vetCite("ClipPod https://evil.example/x", r)).toBe("ClipPod");
    expect(vetCite("Some blog", r)).toBe("none");
    expect(vetCite("ClipPod", undefined)).toBe("none");
    expect(onlyKnownLinks(`ClipPod charges $29 (${CARDS[0].url}&t=60s); others (https://made.up/x) charge more.`, r)).toBe(`ClipPod charges $29 (${CARDS[0].url}&t=60s); others charge more.`);
  });
});

describe("Studio builds, quests, research and project pages", () => {
  test("a Studio build gets a compact comparables line with links and the check", () => {
    const c = buildComps({ title: "Podcast Clip Studio", pitch: "clips from each podcast episode", customer: "podcasters", price: "$149/month" }, find)!;
    expect(c.items[0]).toMatchObject({ name: "ClipPod", revenue: "$12K a month", published: "Nov 2025", channel: "Reddit", link: `${CARDS[0].url}&t=300s` });
    expect(c.checks[0]).toContain("over twice the highest");
    expect(buildComps({ title: "Tender alerts", pitch: "government tenders" }, find)).toBeUndefined();
  });
  test("the research planner sees comparables; the evaluator's Jev state carries them", async () => {
    expect(plannerPrompt(camp(), [], "Comparable founders (…):\n1. ClipPod").user).toContain("Use them: what worked for founders like these");
    expect(plannerPrompt(camp(), []).user).not.toContain("Use them:");
    const dir = mkdtempSync(`${root}/r-`);
    let t = T0, plannerUser = "", jevState: any;
    const rows: any[] = [];
    const ar = createAutoresearch({ dir: `${dir}/s`, workRoot: `${dir}/w`, self: "mac", now: () => t, planner: "claude" }, {
      rows: () => rows, start: async (s) => { const key = `k${rows.length}`; rows.push({ key, tab: s.label, title: s.label, status: "working", cwd: s.cwd, firstPrompt: s.prompt }); return { key }; },
      close: async () => ({ ok: true }), screen: async () => "",
      plan: async (_s, user) => { plannerUser = user; return JSON.stringify({ question: "Where do podcasters who publish weekly buy clip tools, and at what price?", type: "deep_dive", why: "x", focus: "podcast clips" }); },
      jev: async (state) => { jevState = state; return { answers: { customers: { noul: 0.5 } }, fallback: null }; },
      comparables: (x) => find({ ...x, name: x.name ?? "Podcast clips", offer: x.offer ?? "podcast clips" }),
    });
    ar.create({ goal: "Podcast clip tools people pay for", budget: 1, dailyCap: 5, confirm: true });
    await ar.tick();
    expect(plannerUser).toContain("Comparable founders");
    const run = ar.store.campaigns[0].runs[0];
    writeFileSync(run.reportPath, REPORT());
    rows[0].status = "done";
    t += MIN;
    await ar.tick();
    expect(jevState.comparable_founders.founders[0]).toContain("ClipPod (Nov 2025)");
    expect(jevState.comparable_founders.summary.length).toBeGreaterThan(0);
  });
});

describe("the library: dates reach the cards and the search", () => {
  test("syncDates dates cards from the backfill's file; last-12-months and newest-first in search", async () => {
    const dir = mkdtempSync(`${root}/lib-`);
    mkdirSync(dir, { recursive: true });
    const db = openCards(`${dir}/cards.db`);
    for (const c of CARDS) db.put({ ...c, date: undefined });
    db.close();
    writeFileSync(`${dir}/video-meta.json`, JSON.stringify(Object.fromEntries(CARDS.filter((c) => c.date).map((c) => [c.id, { date: c.date, duration: 600, at: 0 }]))));
    const lib = createLibrary({ dir, bridge: { available: () => ({ ok: false, why: "test" }), call: async () => { throw new Error("no bridge"); } } });
    expect(lib.syncDates()).toBe(4);
    expect(lib.cards().get("podclip0002")!.date).toBe("2025-06-10");
    expect(lib.dateCoverage()).toMatchObject({ cards: 5, cardsDated: 4 });
    const recent = await lib.search("podcast clips", 8, { since: "2025-01-01" });
    expect(recent.answers.map((a) => a.id).sort()).toEqual(["podclip0001", "podclip0002"]);
    const newest = await lib.search("podcast clips", 8, { sort: "published" });
    expect(newest.answers.map((a) => a.date)).toEqual(["2025-11-02", "2025-06-10", "2020-03-01"]);
    const ev = await lib.evidence("podcast clips", 5);
    expect(ev.text).toContain("ClipPod [Nov 2025]");
  });
});
