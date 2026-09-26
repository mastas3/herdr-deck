import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createFeed, isDuplicate, seedCombos } from "../src/feed";
import type { Ingredient, RunOpts } from "../src/mix";
import { normalizeBuild } from "../src/studio";
import { FEED_BATCHES, FEED_ROWS, FEED_SYSTEM, feedPrompt, JUDGE_SYSTEM, judgePrompt, parseScores } from "../src/studio-prompts";

const root = mkdtempSync(`${tmpdir()}/deck-feed-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const I = (id: string, kind: Ingredient["kind"], name: string, desc: string, group?: string): Ingredient => ({ id, kind, name, desc, group, ready: true });
const ALL: Ingredient[] = [
  I("p:astra-apple", "project", "astra-apple", "HD engine and the 2027 app", "active"), I("p:yt-transcriber", "project", "yt-transcriber", "YouTube to clips and RAG", "active"),
  I("p:hd-core", "project", "hd-core", "HD calculation engine", "active"), I("p:chaos-os", "project", "chaos-os", "Chaos magick OS", "stale"),
  I("r:a/spark", "repo", "a/spark", "Gaussian splats", "TypeScript"), I("r:b/maestro", "repo", "b/maestro", "Agent command center", "TypeScript"),
  I("c:telegram", "conn", "Telegram", "Bots", "Communication"), I("c:gumroad", "conn", "Gumroad", "Products and sales", "Commerce & payments"),
  I("c:eleven", "conn", "ElevenLabs", "Voice", "Media & creative"), I("c:vercel", "conn", "Vercel", "Deploys", "Cloud & deploy"),
  I("t:claude", "tool", "Claude Code", "Coding agent", "AI models & agents"), I("t:l30", "tool", "last30days", "Research", "Skills"),
  I("i:hd", "interest", "Human Design", "From astra-apple"),
];
const PITCH = ["Weekly transit voice notes for Russian-speaking HD coaches", "Bodygraph posters printed on demand for new parents", "Tender alerts in WhatsApp for Israeli contractors", "Gaussian splat tours of Tel Aviv cafes for owners", "Hebrew captions for Instagram reels made by yoga teachers", "Chart readings by email for Telegram channel admins", "A 3D oracle game for esoteric streamers on Twitch", "Daily agent status digests for solo SaaS founders", "Voice clones of course creators answering student questions", "Local-first journaling with HD prompts for therapists", "Clip packs of podcasts for LinkedIn ghostwriters", "Price trackers for Shopify dropshippers in Israel"];
let pn = 0;
const P = ["", "astra-apple", "yt-transcriber", "hd-core", "chaos-os", "astra-apple", "yt-transcriber"];
const idea = (title: string, row: string, over: Record<string, unknown> = {}) => ({
  title, row, pitch: PITCH[pn++ % PITCH.length], customer: "Hebrew HD coaches in the big Facebook groups", problem: "No time to make content", offer: "Daily clips",
  price: "$19/month", model: "subscription", mvp: ["one", "two", "three"], ingredients: ["yt-transcriber", "Telegram"], how: [{ name: "Telegram", role: "delivers" }],
  launch: ["Post a sample in the group"], week: ["a", "b", "c"], cost: "$10/month", first_dollar: "2 weeks", risks: ["churn"], size: "week", wow: 4, ...over,
});
const block = (o: object) => `<build>${JSON.stringify(o)}</build>`;
const W = ["amber", "birch", "cobalt", "dune", "ember", "fjord", "garnet", "harbor", "indigo", "jasper", "kelp", "lumen", "mesa", "nectar", "onyx", "prism"];

describe("dedupe and seeds", () => {
  const b = (t: string, ings: string[], pitch = "p") => normalizeBuild({ title: t, pitch, ingredients: ings }, ALL, "claude")!;
  test("same title, same ingredient set, or nearly the same words", () => {
    expect(isDuplicate(b("Clip Courier", ["Telegram"]), b("clip courier", ["Gumroad"]))).toBe(true);
    expect(isDuplicate(b("One", ["Telegram", "hd-core"]), b("Two", ["hd-core", "Telegram"]))).toBe(true);
    expect(isDuplicate(b("Daily HD transit ritual bot", ["Telegram"]), b("HD daily transit ritual", ["Gumroad"]))).toBe(true);
    expect(isDuplicate(b("Clip Courier", ["Telegram"], "Daily HD clips for coaches"), b("Splat Oracle", ["Gumroad"], "Daily HD readings for coaches"))).toBe(false);
    expect(isDuplicate(b("Clip Courier", ["Telegram", "hd-core"]), b("Splat Oracle", ["a/spark", "hd-core"]))).toBe(false);
  });
  test("seed combos: distinct, seeded, gems always carry a repo", () => {
    const a = seedCombos(ALL, "money", 6, 1);
    expect(a.length).toBe(6);
    expect(new Set(a.map((c) => [...c].sort().join())).size).toBe(6);
    expect(seedCombos(ALL, "money", 6, 1)).toEqual(a);
    expect(seedCombos(ALL, "money", 6, 2)).not.toEqual(a);
    for (const c of seedCombos(ALL, "gem", 8, 3)) expect(c.some((n) => n.includes("/"))).toBe(true);
  });
  test("the feed prompt names the rows, the combos and what to avoid", () => {
    const p = feedPrompt(FEED_ROWS.slice(0, 2), 6, [["hd-core", "Telegram"]], ["Clip Courier"]);
    expect(p).toContain("Write 12 ideas: 6 for each of these rows.");
    expect(p).toContain('row "money" (Make money this month)');
    expect(p).toContain("1. hd-core + Telegram");
    expect(p).toContain("don't repeat these or near-copies of them: Clip Courier");
    expect(FEED_SYSTEM).toContain('"row":"row id"');
    expect(FEED_SYSTEM).toContain('"first_dollar"');
  });
});

describe("the feed", () => {
  const wait = async (f: () => boolean) => { for (let i = 0; i < 300; i++) { if (f()) return; await Bun.sleep(5); } throw new Error("timeout"); };
  const make = (reply: (o: RunOpts, n: number) => string | Error, name = Math.random().toString(36).slice(2), judge: (o: RunOpts) => string = (o) => JSON.stringify({ scores: [...o.user.matchAll(/^(\d+)\. /gm)].map((m) => ({ i: +m[1], s: 8 })) })) => {
    const calls: RunOpts[] = [], judged: RunOpts[] = [];
    let day = Date.parse("2026-09-26T09:00:00");
    const f = createFeed({
      file: `${root}/${name}.json`, ingredients: async () => ALL, claudeAvailable: () => true, now: () => day,
      runClaude: async (o: RunOpts) => {
        if (o.system === JUDGE_SYSTEM) { judged.push(o); return { text: judge(o), model: "haiku" }; }
        calls.push(o);
        const r = reply(o, calls.length);
        if (r instanceof Error) throw r;
        let all = "";
        for (const part of r.match(/[\s\S]{1,200}/g) ?? []) { all += part; o.onText(all); await Bun.sleep(1); }
        return { text: all, model: "haiku" };
      },
    });
    return { f, calls, judged, next: () => { day += 86_400_000; } };
  };
  test("a run a restart cut short (same day, never settled) starts again; a settled day doesn't", async () => {
    writeFileSync(`${root}/cut-short.json`, JSON.stringify({ day: "2026-09-26", ideas: [], cursor: 0, dropped: 0 }));
    const cut = make(() => "", "cut-short");
    cut.f.ensure();
    expect(cut.calls.length).toBeGreaterThan(0);
    writeFileSync(`${root}/settled.json`, JSON.stringify({ day: "2026-09-26", settled: "2026-09-26", ideas: [], cursor: 0, dropped: 0 }));
    const done = make(() => "", "settled");
    done.f.ensure();
    expect(done.calls.length).toBe(0);
  });
  test("the first view: six batches in parallel, ideas land in their rows, the gate and dedupe drop the weak ones", async () => {
    const { f, calls, judged } = make((o, n) => {
      const rows = FEED_BATCHES[n - 1];
      return [
        block(idea(`Good ${rows[0]} ${W[n]} idea`, rows[0], { ingredients: [P[n], n <= 4 ? "Gumroad" : "Telegram"], how: [] })),
        block(idea(`Good ${rows[1]} ${W[n + 5]} idea`, rows[1], { ingredients: [P[n], n <= 4 ? "ElevenLabs" : "a/spark"], how: [] })),
        block(idea(`Vague ${n}`, rows[0], { customer: "everyone", price: "cheap" })),
        block(idea(`Good ${rows[0]} ${W[n]} idea`, rows[0])), // same title again
        block(idea(`Wrong row ${W[(n + 10) % 16]}`, "nope", { ingredients: [P[n], n <= 4 ? "Vercel" : "last30days"], how: [] })),
      ].join("\n");
    });
    f.ensure();
    await wait(() => calls.length === 6 && !f.state().running.length && judged.length === 1 && !f.state().judging);
    const s = f.state();
    expect(calls.map((c) => c.model)).toEqual(Array(6).fill("haiku"));
    expect(judged[0].user).toContain(`Score these ${s.judged} ideas`); // one critic call for the whole first view
    expect(calls[0].user).toContain("Write 12 ideas");
    expect(calls[0].system).toContain("# His inventory");
    expect(s.total).toBe(s.judged);
    expect(s.total).toBeGreaterThanOrEqual(12);
    for (const r of s.rows) expect(r.ideas.length).toBeGreaterThanOrEqual(1);
    expect(s.rows.find((r) => r.id === "money")!.ideas.map((x: any) => x.title)).toContain("Good money birch idea");
    expect(s.rows.flatMap((r) => r.ideas).some((x: any) => x.title.startsWith("Vague"))).toBe(false);
    expect(s.dropped).toBeGreaterThanOrEqual(4);
    expect(s.generated).toBe(true);
    // Once a day: opening Discover again doesn't ask again.
    f.ensure();
    expect(calls.length).toBe(6);
  });
  test("More like this asks for one row; More ideas walks the next pairs; the feed is cached on disk", async () => {
    const name = "cache";
    const { f, calls } = make((o, n) => [1, 2, 3].map((k) => block(idea(`${W[n * 3 + k]} ${o.user.match(/row "(\w+)"/)?.[1]} product`, o.user.match(/row "(\w+)"/)?.[1] ?? "", { ingredients: k === 1 ? ["hd-core", "Telegram"] : k === 2 ? ["astra-apple", "Gumroad"] : ["yt-transcriber", "ElevenLabs"] }))).join("\n"), name);
    f.more("wild");
    await wait(() => calls.length === 1 && !f.state().running.length && !f.state().judging);
    expect(calls[0].user).toContain("Write 8 ideas: 8 for each");
    expect(f.state().rows.find((r) => r.id === "wild")!.ideas).toHaveLength(3);
    f.more();
    await wait(() => calls.length === 2 && !f.state().running.length && !f.state().judging);
    expect(calls[1].user).toContain('row "money"'); // the next pair after the first view's
    expect(calls[1].user).toContain("ember wild product"); // the titles already there, to avoid
    f.flush();
    const disk = JSON.parse(readFileSync(`${root}/${name}.json`, "utf8"));
    expect(disk.ideas.length).toBe(f.state().total);
  });
  test("the critic's second pass drops what it scores under 5, and the best go first", async () => {
    const { f, calls, judged } = make(() => [0, 1, 2, 3].map((k) => block(idea(`${W[k]} money product`, "money", { ingredients: [P[k + 1] || "hd-core", "Gumroad"], how: [] }))).join("\n"), undefined,
      () => '{"scores":[{"i":1,"s":9},{"i":2,"s":3},{"i":3,"s":7},{"i":4,"s":4.5}]}');
    f.more("money");
    await wait(() => calls.length === 1 && judged.length === 1 && !f.state().running.length && !f.state().judging);
    const titles = f.state().rows.find((r) => r.id === "money")!.ideas.map((x: any) => [x.title, x.score]);
    expect(titles).toEqual([["amber money product", 9], ["cobalt money product", 7]]);
    expect(f.state().dropped).toBe(2);
    expect(parseScores('noise {"i": 3, "s": 12} {"i":4,"s":0}')).toEqual(new Map([[3, 10], [4, 1]]));
    expect(judgePrompt([{ title: "T", pitch: "P", ingredients: ["a", "b"], price: "$9" }])).toContain("1. T: P | customer: ? | price: $9 | stack: a, b");
  });
  test("no model at all: template ideas as a last resort; a new day regenerates", async () => {
    const { f, calls, next } = make(() => new Error("Claude Code (claude) isn't installed here"));
    f.ensure();
    await wait(() => calls.length === 6 && !f.state().running.length);
    const s = f.state();
    expect(s.total).toBeGreaterThan(0);
    expect(s.rows.flatMap((r) => r.ideas).every((x: any) => x.source === "template")).toBe(true);
    expect(s.errors[0]).toContain("isn't installed");
    next();
    f.ensure();
    await wait(() => calls.length === 12);
  });
});
