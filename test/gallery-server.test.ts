import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createGalleryServer, dayOf, parseRecipe, type GalleryServerDeps } from "../src/gallery-server";
import { KIT_FILES } from "../src/ideagen/kit-files";
import { coverIdOf } from "../src/idea-archive";
import { createCovers } from "../plugins-builtin/covers/covers";
import type { PainCorpus } from "../src/ideagen/types";
import type { TrendSet } from "../src/ideagen/trends";

const root = mkdtempSync(`${tmpdir()}/deck-gallery-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const LAB = new URL("../docs/idea-lab/gallery.json", import.meta.url).pathname;
const lab = JSON.parse(readFileSync(LAB, "utf8"));
const topId: string = lab.lanes.find((l: any) => l.id === "top").ideas[0];
const today = () => dayOf(Date.now());

type Call = { tag?: string; user: string; model?: string };
/** A raw Claude that answers like the real one: ideas for gallery briefs, a kit for kits, junk for the rest. */
function fakeClaude(calls: Call[], o: { hang?: () => boolean } = {}) {
  return async (x: any) => {
    calls.push({ user: x.user, model: x.model });
    if (o.hang?.()) return new Promise<never>(() => {});
    const briefs = [...new Set([...String(x.user).matchAll(/\b([A-Z]\d?-[a-z]+-\d+)\b/g)].map((m) => m[1]))];
    const sig = [...String(x.user).matchAll(/\((hn:\w+)\)/g)].map((m) => m[1]);
    const text = /starter kit/.test(x.system) ? JSON.stringify({
      spec: { problem: "Readers can't find answers offline", buyer: "HD readers", jobs: ["look up a gate"], scope_in: ["search"], scope_out: ["accounts"], metrics: [{ metric: "sales", target: "1", milestone: "first paying customer" }] },
      architecture: { summary: "Static site", components: [{ name: "site", does: "serves cards", uses: "hd-atlas" }], data_model: [], flows: [] },
      tasks: [1, 2, 3].map((i) => ({ id: `T${i}`, title: `Task ${i}`, size: "S", prompt: `Do step ${i} in src/step${i}.ts`, accept: [`step ${i} works`], depends_on: [] })),
      landing: { headline: "Answers offline", subhead: "Every card", benefits: ["a", "b", "c"], cta: "Buy" }, pricing: [{ tier: "One", price: "$19", includes: ["all"] }], launch_posts: [], outreach: "Hi",
    }) : briefs.length ? JSON.stringify({ ideas: briefs.map((b, i) => ({ brief: b, name: `Idea ${b} ${i}`, hook: "A plain hook", buyer: "Hebrew HD readers in the HumandesignIsrael Facebook group", pain: "They ask the same questions", offer: "A lookup", price: "$19 one-time", channel: "DM 30 admins of the HumandesignIsrael Facebook group", mvp: "A static site", stack: [{ name: "hd-atlas", role: "the cards" }], needs: ["payments"], days_to_first_dollar: 10, difficulty: "week", quests: [], trend: "offline chart apps", trend_ids: sig.slice(0, 2), why_now: "Two launches this week show buyers want offline chart lookups" })) }) : "{}";
    return { text, model: x.model ?? "haiku", ms: 1, costUsd: 0, inTok: 1, outTok: 1 };
  };
}
const corpus = async (): Promise<PainCorpus> => ({ at: Date.now(), posts: [], themes: [], queries: [] });
/** One hot trend about Human Design apps, so trend briefs exist and their ideas can pass the slop gate. */
const signal = (id: string, title: string) => ({ id, source: "hn" as const, title, url: `https://news.ycombinator.com/item?id=${id}`, at: Date.now() - 86_400_000, text: title, metric: 300, velocity: 200, rank: 0.9 });
const trendSet = async (): Promise<TrendSet> => ({ at: Date.now(), day: dayOf(Date.now()), status: {}, signals: [], trends: [{ id: "t1", label: "human design chart apps", terms: ["human", "design"], signals: [signal("hn:1", "Show HN: offline Human Design chart app"), signal("hn:2", "Human Design readers want offline apps")], sources: ["hn"], heat: 4, earliness: 0.5, newest: Date.now(), topics: ["hd"] }] });
function deps(dir: string, extra: Partial<GalleryServerDeps> = {}): GalleryServerDeps {
  return {
    dir, projectsDir: `${dir}/projects`, labFile: LAB, evidenceFirst: false,
    sections: async () => [{ id: "services", items: [{ id: "svc:gumroad", name: "Gumroad", state: "ready", detail: "Sell digital products" }] }, { id: "accounts", items: [{ id: "acct:facebook", name: "Facebook", state: "ready", detail: "Profile, Pages and groups" }] }],
    projects: async () => [{ name: "hd-atlas", status: "active", tags: ["human-design", "rag"], tldr: "Human Design knowledge base with a curated corpus and chart chat.", weight: 5 }],
    gems: () => [], gh: async () => ({ ok: false, error: "offline" }) as any,
    corpus, trends: trendSet, recipe: [["T-hot", 3]], premortems: 0, rubric: false,
    jevRaw: async () => ({ fallback: "unavailable" }) as any, log: () => {},
    ...extra,
  };
}

describe("gallery: what the page gets", () => {
  test("before today's run, the lab's cards show at once, lite, with cover ids; the archive gets them with quality as score", async () => {
    const put: any[] = [], scores: [string, number][] = [];
    const g = createGalleryServer(deps(mkdtempSync(`${root}/a-`), { archive: { put: (x: any) => put.push(x), score: (id: string, s: number) => scores.push([id, s]) } }));
    const s: any = await g.handle("/api/ideas/state", {});
    expect(s.source).toBe("lab");
    expect(s.lanes.length).toBeGreaterThan(5);
    const c = s.ideas[topId];
    expect(c.title).toBe(lab.ideas[topId].name);
    expect(c.coverId).toBe(coverIdOf(topId));
    expect(c.coverId).toMatch(/^[\w-]{1,64}$/);
    expect(c.connectors).toBeUndefined(); // the full card comes with /api/ideas/card
    expect(JSON.stringify(s).length).toBeLessThan(JSON.stringify(lab).length / 4);
    expect(Object.values<any>(s.ideas).every((x) => x.quality > 0)).toBe(true);
    // Nothing was generated: state without ensure never starts a run.
    expect(s.job).toBeUndefined();
    expect(put.find((x) => x.id === coverIdOf(topId))?.pitch).toBe(lab.ideas[topId].hook);
    expect(scores.find(([id]) => id === coverIdOf(topId))?.[1]).toBe(lab.ideas[topId].quality);
    const full: any = await g.handle("/api/ideas/card", { id: topId });
    // The lab's finished kits come along: opening one costs no model call.
    const g2 = createGalleryServer(deps(mkdtempSync(`${root}/k-`), { labKits: new URL("../docs/idea-lab/kits", import.meta.url).pathname, claudeRaw: async () => { throw new Error("no calls"); } }));
    const kitId = "T-hot:4:agentsessionarchive:g4a";
    expect(((await g2.handle("/api/ideas/state", {})) as any).kits).toContain(kitId.replace(/[^\w.-]+/g, "_"));
    expect(((await g2.handle("/api/ideas/kit", { id: kitId })) as any).buildPlan.length).toBeGreaterThan(2);
    expect(full.connectors.length).toBeGreaterThan(0);
  });
  test("the covers job paints the best gallery idea first (by its cover id, with its hook as the pitch)", async () => {
    const dir = mkdtempSync(`${root}/paint-`);
    const { openIdeaArchive } = await import("../src/idea-archive");
    const archive = openIdeaArchive(`${dir}/ideas.db`);
    await createGalleryServer(deps(`${dir}/gallery`, { archive })).handle("/api/ideas/state", {});
    const prompts: string[] = [];
    const covers = createCovers({ dir: `${dir}/covers`, confFile: `${dir}/c.json`, dataDir: dir, enabled: () => true, busy: () => false, paint: async (p) => { prompts.push(p); throw new Error("no painter in tests"); } });
    await covers.tick();
    const best = Object.values<any>(lab.ideas).sort((a, b) => b.quality - a.quality)[0];
    expect(covers._state().last?.id).toBe(coverIdOf(best.id));
    expect(prompts[0]).toContain(best.hook.slice(0, 30));
    covers.stop(); archive.close();
  });
  test("covers.respond puts the painted cover on a gallery card by its coverId", () => {
    const dir = mkdtempSync(`${root}/cov-`);
    const id = coverIdOf(topId);
    writeFileSync(`${dir}/${id}.webp`, "x"); writeFileSync(`${dir}/${id}_thumb.webp`, "x");
    const covers = createCovers({ dir, confFile: `${dir}/c.json`, dataDir: dir, enabled: () => false });
    return covers.respond({ ideas: { [topId]: { id: topId, coverId: id, title: "T", pitch: "P" } } }).json().then((j: any) => {
      expect(j.ideas[topId].coverUrl).toStartWith(`/covers/${id}.webp?v=`);
      expect(j.ideas[topId].thumbUrl).toContain("_thumb.webp");
      covers.stop();
    });
  });
  test("save and unsave keep a full snapshot", async () => {
    const g = createGalleryServer(deps(mkdtempSync(`${root}/s-`)));
    const r: any = await g.handle("/api/ideas/save", { id: topId });
    expect(r.saved[0].id).toBe(topId);
    expect(((await g.handle("/api/ideas/save", { id: topId, op: "unsave" })) as any).saved).toEqual([]);
  });
  test("recipes from the environment", () => {
    expect(parseRecipe("C-audience:6, B-pain:4,bogus:3,T-hot:x")).toEqual([["C-audience", 6], ["B-pain", 4]]);
    expect(parseRecipe("")).toBeUndefined();
  });
});

describe("gallery: the daily run", () => {
  test("Discover opening starts it in the background; it ends with today's gallery and a done job", async () => {
    const calls: Call[] = [];
    const dir = mkdtempSync(`${root}/run-`);
    const g = createGalleryServer(deps(dir, { claudeRaw: fakeClaude(calls) }));
    expect(g._job()).toBeUndefined();
    const s: any = await g.handle("/api/ideas/state", { ensure: true });
    expect(s.job.status).toBe("running");
    await g.whenIdle();
    const j = g._job()!;
    expect(j.status).toBe("done");
    expect(existsSync(`${dir}/gallery-${today()}.json`)).toBe(true);
    expect(existsSync(`${dir}/inventory-${today()}.json`)).toBe(true);
    expect(calls.length).toBe(1);
    expect(j.calls.claude).toBe(1);
    expect(j.ideas).toBeGreaterThan(0);
    const st: any = await g.handle("/api/ideas/state", {});
    expect(st.source).toBe("today");
    expect(Object.values<any>(st.ideas)[0].title).toStartWith("Idea T-hot-");
    // Asking again the same day starts nothing.
    await g.handle("/api/ideas/state", { ensure: true });
    await g.whenIdle();
    expect(calls.length).toBe(1);
  });
  test("a run cut short by a restart resumes at boot, and the replies it already had cost nothing again", async () => {
    const dir = mkdtempSync(`${root}/resume-`);
    const first: Call[] = [];
    // The first process: Claude answers, then Jev never does (the deck is killed while judging).
    const g1 = createGalleryServer(deps(dir, { claudeRaw: fakeClaude(first), jevRaw: () => new Promise<never>(() => {}) }));
    g1.ensure();
    for (let i = 0; i < 100 && g1._job()?.phase !== "judging"; i++) await Bun.sleep(10);
    expect(g1._job()!.phase).toBe("judging");
    expect(JSON.parse(readFileSync(`${dir}/job.json`, "utf8")).status).toBe("running");
    expect(first.length).toBe(1);
    // The next process finds the unfinished job and runs it again at once, without Discover being opened.
    const second: Call[] = [];
    const g2 = createGalleryServer(deps(dir, { claudeRaw: fakeClaude(second) }));
    expect(g2._job()!.status).toBe("running");
    await g2.whenIdle();
    expect(g2._job()!.status).toBe("done");
    expect(g2._job()!.attempts).toBe(2);
    expect(second.length).toBe(0); // the same prompt came back from the reply cache
    expect(existsSync(`${dir}/gallery-${today()}.json`)).toBe(true);
  });
  test("a day where nothing passes (no model answered) keeps the earlier cards instead of an empty gallery", async () => {
    const dir = mkdtempSync(`${root}/empty-`);
    const g = createGalleryServer(deps(dir, { claudeRaw: async () => { throw new Error("claude isn't installed"); } }));
    g.ensure(); await g.whenIdle();
    expect(g._job()!.status).toBe("error");
    expect(g._job()!.error).toContain("no idea passed");
    expect(existsSync(`${dir}/gallery-${today()}.json`)).toBe(false);
    expect(((await g.handle("/api/ideas/state", {})) as any).source).toBe("lab");
  });
  test("a failed run isn't retried at once; the lab's cards stay up", async () => {
    const dir = mkdtempSync(`${root}/fail-`);
    const g = createGalleryServer(deps(dir, { corpus: async () => { throw new Error("offline"); } }));
    g.ensure(); await g.whenIdle();
    expect(g._job()!.status).toBe("error");
    g.ensure();
    expect(g._job()!.status).toBe("error");
    expect(((await g.handle("/api/ideas/state", {})) as any).source).toBe("lab");
  });
});

describe("gallery: More and Play", () => {
  test("More in a lane waits for today's gallery, then asks the lane's strategy for more", async () => {
    const dir = mkdtempSync(`${root}/more-`);
    const calls: Call[] = [];
    const g = createGalleryServer(deps(dir, { claudeRaw: fakeClaude(calls) }));
    await expect(g.handle("/api/ideas/more", { lane: "fastest" })).rejects.toThrow(/still being written/);
    writeFileSync(`${dir}/gallery-${today()}.json`, JSON.stringify({ ...lab, day: today() }));
    const s: any = await g.handle("/api/ideas/more", { lane: "fastest" });
    expect(calls.length).toBe(1);
    expect(calls[0].user).toContain("G-constraint-1");
    expect(s.source).toBe("today");
    expect(JSON.parse(readFileSync(`${dir}/gallery-${today()}.json`, "utf8")).stats.refills.fastest).toBe(1);
    await expect(g.handle("/api/ideas/more", { lane: "nope" })).rejects.toThrow(/No lane/);
  });
  test("Play without confirm writes nothing; with confirm it writes the kit into a fresh folder and records it", async () => {
    const dir = mkdtempSync(`${root}/play-`);
    const calls: Call[] = [];
    const g = createGalleryServer(deps(dir, { claudeRaw: fakeClaude(calls) }));
    const pv: any = await g.handle("/api/ideas/play", { id: topId });
    expect(pv.preview).toBe(true);
    expect(pv.files).toEqual(KIT_FILES);
    expect(pv.dir.startsWith(`${dir}/projects/`)).toBe(true);
    expect(existsSync(pv.dir)).toBe(false);
    expect(existsSync(`${dir}/projects`)).toBe(false);
    expect(calls.length).toBe(0);
    expect(((await g.handle("/api/ideas/state", {})) as any).playing).toEqual({});
    await g.handle("/api/ideas/play", { id: topId, confirm: "yes" }); // only the boolean true counts
    expect(existsSync(pv.dir)).toBe(false);

    const r: any = await g.handle("/api/ideas/play", { id: topId, confirm: true });
    expect(r.dir).toBe(pv.dir);
    expect(readdirSync(r.dir).sort()).toEqual([...new Set(KIT_FILES.map((f) => f.split("/")[0]))].sort());
    expect(readFileSync(`${r.dir}/TASKS.md`, "utf8")).toContain("Do step 1");
    expect(r.firstTask.title).toBe("T1 Task 1");
    expect(r.firstTask.prompt).toContain("Do step 1 in src/step1.ts");
    expect(r.firstTask.prompt).toContain("don't deploy without asking");
    expect(calls.length).toBe(1); // the kit, built once and cached
    const st: any = await g.handle("/api/ideas/state", {});
    expect(st.playing[topId].dir).toBe(r.dir);
    expect(st.kits.length).toBe(1);
    // Playing it again never touches the first folder.
    const again: any = await g.handle("/api/ideas/play", { id: topId, confirm: true });
    expect(again.dir).toBe(`${r.dir}-2`);
    expect(calls.length).toBe(1);
  });
});
