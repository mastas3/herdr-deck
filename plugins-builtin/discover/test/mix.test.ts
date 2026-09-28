import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  collectIngredients, createMixer, dailyDue, dayOf, forYouIngredients, matchIngredient, mixKey, mixPrompt, normalizeMix, parseMixes, rawMixes,
  sanitizeIngredient, templateMixes, type Daily, type Ingredient, type RunOpts,
} from "../mix";
import type { Gem, Profile } from "../discover";

const root = mkdtempSync(`${tmpdir()}/deck-mix-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const profile: Profile = {
  at: 0, removed: [], languages: [], recent: [], connections: [], local: [], names: [], counts: { wiki: 3, concepts: 0, repos: 0, log: 0 },
  interests: [
    { id: "human-design", label: "Human Design", kind: "domain", q: "", terms: [], score: 20, projects: ["chart-chat"], source: "wiki" },
    { id: "video", label: "AI video & clips", kind: "tech", q: "", terms: [], score: 8, projects: [], source: "wiki" },
  ],
  projects: [
    { name: "chart-chat", status: "active", tags: ["human-design"], tldr: "Talk to your bodygraph with sources.", weight: 3 },
    { name: "yt-transcriber", status: "active", tags: ["video"], tldr: "Long YouTube videos into vertical clips.", weight: 2 },
    { name: "forked-tool", status: "stale", tags: ["external"], tldr: "Someone else's tool.", weight: 1 },
    { name: "old-wallet", status: "archived", tags: ["crypto"], tldr: "An old wallet.", weight: 0.2 },
  ],
};
const gem = (full: string, desc: string): Gem => ({ full, url: `https://github.com/${full}`, desc, stars: 100, pushed: "", created: "", topics: [], owner: full.split("/")[0], name: full.split("/")[1], score: 1, spm: 1, why: [] });
const items = [
  { id: "svc:telegram", name: "Telegram", cat: "comms", state: "ready", detail: "Bots and messages", kind: "service" },
  { id: "svc:stripe", name: "Stripe", cat: "commerce", state: "signed-out", detail: "Payments", kind: "service" },
  { id: "agent:claude", name: "Claude Code", cat: "ai", state: "ready", detail: "Coding agent", kind: "agent" },
  { id: "skill:yt", name: "yt-transcriber", cat: "skills", state: "ready", detail: "Turn videos into clips", kind: "skill" },
  { id: "key:OPENAI", name: "OPENAI_API_KEY", cat: "keys", state: "ready", kind: "key" },
  { id: "svc:hidden", name: "Hidden", cat: "cloud", state: "ready", hidden: true },
];
const ALL = collectIngredients({ profile, gems: [gem("acme/voicebox", "Local text to speech")], trending: [gem("acme/voicebox", "dupe"), gem("zed/splat", "Gaussian splats in the browser")], saved: [], items, catLabels: { comms: "Communication", commerce: "Commerce & payments", ai: "AI models & agents", skills: "Skills" } });
const ing = (id: string) => ALL.find((x) => x.id === id)!;

describe("collectIngredients", () => {
  test("every kind, grouped, deduped; external, archived, hidden and key names left out", () => {
    const ids = ALL.map((x) => x.id);
    expect(ids).toContain("p:chart-chat");
    expect(ids).toContain("p:yt-transcriber");
    expect(ids).not.toContain("p:forked-tool");
    expect(ids).not.toContain("p:old-wallet");
    expect(ids.filter((x) => x === "r:acme/voicebox")).toHaveLength(1);
    expect(ids).toContain("r:zed/splat");
    expect(ids).toContain("c:svc:telegram");
    expect(ids).toContain("t:agent:claude");
    expect(ids).toContain("t:skill:yt");
    expect(ids).toContain("i:human-design");
    expect(ids).not.toContain("c:key:OPENAI");
    expect(ids.some((x) => x.includes("hidden"))).toBe(false);
  });
  test("categories become groups; readiness comes from the store state", () => {
    expect(ing("c:svc:telegram")).toMatchObject({ kind: "conn", group: "Communication", ready: true });
    expect(ing("c:svc:stripe")).toMatchObject({ kind: "conn", ready: false });
    expect(ing("t:skill:yt")).toMatchObject({ kind: "tool", group: "Skills" });
    expect(ing("i:human-design").desc).toBe("From chart-chat");
  });
  test("a project and a skill with the same name are both kept (different kinds)", () => {
    expect(ALL.filter((x) => x.name === "yt-transcriber").map((x) => x.kind).sort()).toEqual(["project", "tool"]);
  });
  test("sanitizeIngredient keeps only kind, name, a one-line description", () => {
    expect(sanitizeIngredient({ kind: "nope", name: "x" })).toBeUndefined();
    expect(sanitizeIngredient({ kind: "conn", name: "" })).toBeUndefined();
    const s = sanitizeIngredient({ kind: "conn", name: "Gmail", desc: "a\n\nb ".repeat(200), secret: "sk-123" })!;
    expect(s.desc.length).toBeLessThanOrEqual(140);
    expect(JSON.stringify(s)).not.toContain("sk-123");
  });
  test("the prompt carries names, kinds and descriptions only, plus the direction", () => {
    const { user } = mixPrompt([ing("p:chart-chat"), ing("c:svc:telegram")], "make money");
    expect(user).toContain("- chart-chat (my project): Talk to your bodygraph");
    expect(user).toContain("- Telegram (service/connection I have): Bots and messages");
    expect(user).toContain('"make money"');
  });
});

const SEL: Ingredient[] = [ing("p:chart-chat"), ing("r:acme/voicebox"), ing("c:svc:telegram"), ing("i:human-design")];
const good = JSON.stringify({ mixes: [
  { title: "Voice Chart", pitch: "Your chart talks.", ingredients: ["chart-chat", "acme/voicebox"], how: [{ name: "chart-chat", role: "answers" }, { name: "acme/voicebox", role: "speaks" }], why_novel: "Nobody voices charts.", first_steps: ["a", "b", "c"], difficulty: "weekend", wow: 4 },
  { title: "Transit Bot", pitch: "Daily transits on Telegram.", ingredients: ["Telegram", "Human Design"], how: { Telegram: "delivers", "Human Design": "the content" }, why_novel: "x", first_steps: "1. one\n2. two\n3. three", difficulty: "2 weeks", wow: "5/5" },
] });

describe("parsing model output", () => {
  test("clean JSON", () => {
    const m = parseMixes(good, SEL, "claude");
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ title: "Voice Chart", ingredients: ["chart-chat", "acme/voicebox"], ids: ["p:chart-chat", "r:acme/voicebox"], difficulty: "weekend", wow: 4, source: "claude" });
    expect(m[1].how).toEqual([{ name: "Telegram", role: "delivers" }, { name: "Human Design", role: "the content" }]);
    expect(m[1].first_steps).toEqual(["one", "two", "three"]);
    expect(m[1].difficulty).toBe("week");
    expect(m[1].wow).toBe(5);
  });
  test("code fences, prose around it, smart quotes and trailing commas", () => {
    const messy = `Sure! Here are your mixes:\n\`\`\`json\n{"mixes":[{"title":"A","ingredients":["chart-chat","Telegram",],"pitch":"p",},]}\n\`\`\`\nEnjoy!`;
    expect(parseMixes(messy, SEL, "claude").map((m) => m.title)).toEqual(["A"]);
  });
  test("partial (streaming or cut off): every complete mix is kept, the unfinished one dropped", () => {
    const cut = good.slice(0, good.indexOf("Transit Bot") + 30);
    const m = parseMixes(cut, SEL, "claude");
    expect(m.map((x) => x.title)).toEqual(["Voice Chart"]);
    expect(rawMixes('{"mixes":[{"title":"X","ingredients":["a"],"how":[{"name":"a","role":"b"}]}')).toHaveLength(1);
  });
  test("garbage gives nothing (so templates take over)", () => {
    for (const g of ["", "I can't help with that.", "{{{{", "[1,2,3]", '{"mixes": "none"}', "null"]) expect(parseMixes(g, SEL, "claude")).toEqual([]);
  });
  test("a bare array, or a single object, also works", () => {
    expect(parseMixes(JSON.stringify([{ title: "B", ingredients: ["chart-chat", "Telegram"] }]), SEL, "ollama")[0].source).toBe("ollama");
    expect(parseMixes(JSON.stringify({ title: "C", ingredients: ["chart-chat", "Telegram"] }), SEL, "ollama")).toHaveLength(1);
  });
  test("invented ingredients are dropped; a mix left with fewer than two is dropped", () => {
    const m = parseMixes(JSON.stringify({ mixes: [{ title: "D", ingredients: ["chart-chat", "Kubernetes", "Blockchain"] }, { title: "E", ingredients: ["voicebox", "telegram", "Mars"] }] }), SEL, "claude");
    expect(m.map((x) => x.title)).toEqual(["E"]);
    expect(m[0].ingredients).toEqual(["acme/voicebox", "Telegram"]);
  });
  test("names are matched exactly, by repo short name, and loosely", () => {
    expect(matchIngredient("VOICEBOX", SEL)?.id).toBe("r:acme/voicebox");
    expect(matchIngredient("chart chat", SEL)?.id).toBe("p:chart-chat");
    expect(matchIngredient("human design interest", SEL)?.id).toBe("i:human-design");
    expect(matchIngredient("tv", SEL)).toBeUndefined();
  });
  test("normalizeMix fills what's missing and clamps what's out of range", () => {
    const m = normalizeMix({ title: "F", ingredients: ["chart-chat", "Telegram", "acme/voicebox", "Human Design", "chart-chat"], wow: 99 }, SEL, "claude")!;
    expect(m.ingredients).toHaveLength(4);
    expect(m.wow).toBe(5);
    expect(m.difficulty).toBe("month");
    expect(m.how).toHaveLength(4);
    expect(m.first_steps).toHaveLength(3);
    expect(normalizeMix({ ingredients: ["chart-chat", "Telegram"] }, SEL, "claude")).toBeUndefined();
    // Ingredients named only in "how" still count.
    expect(normalizeMix({ title: "G", ingredients: ["chart-chat"], how: ["Telegram: sends it"] }, SEL, "claude")?.ingredients).toEqual(["chart-chat", "Telegram"]);
  });
  test("duplicate titles are dropped", () => {
    const twice = JSON.stringify({ mixes: [{ title: "Same", ingredients: ["chart-chat", "Telegram"] }, { title: "same", ingredients: ["acme/voicebox", "Telegram"] }] });
    expect(parseMixes(twice, SEL, "claude")).toHaveLength(1);
  });
});

describe("deterministic fallback", () => {
  test("six distinct mixes that use only the selection and cover it", () => {
    const m = templateMixes(SEL, "", 7, 6);
    expect(m).toHaveLength(6);
    expect(new Set(m.map((x) => x.title)).size).toBe(6);
    const used = new Set(m.flatMap((x) => x.ids));
    for (const x of SEL) expect(used.has(x.id)).toBe(true);
    for (const x of m) {
      expect(x.source).toBe("template");
      expect(x.ids.length).toBeGreaterThanOrEqual(2);
      expect(x.ids.every((id) => SEL.some((s) => s.id === id))).toBe(true);
      expect(x.first_steps).toHaveLength(3);
      expect(x.wow).toBeGreaterThanOrEqual(1);
      expect(x.wow).toBeLessThanOrEqual(5);
    }
  });
  test("same seed, same mixes; the direction shows up", () => {
    expect(templateMixes(SEL, "", 3)).toEqual(templateMixes(SEL, "", 3));
    expect(templateMixes(SEL, "privacy-first", 3)[0].pitch).toContain("privacy-first");
  });
  test("two ingredients still give a mix; none gives none", () => {
    expect(templateMixes(SEL.slice(0, 2), "", 1).length).toBeGreaterThanOrEqual(1);
    expect(templateMixes([], "", 1)).toEqual([]);
  });
  test("forYouIngredients: interests, projects, repos and ready connections, stable per day", () => {
    const f = forYouIngredients(ALL, 100);
    expect(f).toEqual(forYouIngredients(ALL, 100));
    expect(new Set(f.map((x) => x.kind))).toEqual(new Set(["interest", "project", "repo", "conn"]));
    expect(f.every((x) => x.ready)).toBe(true);
  });
});

describe("cache keys and the once-a-day rule", () => {
  test("mixKey ignores order and direction case/spacing, not engine or content", () => {
    expect(mixKey(["a", "b"], "Make  Money ", "claude")).toBe(mixKey(["b", "a", "a"], "make money", "claude"));
    expect(mixKey(["a", "b"], "", "claude")).not.toBe(mixKey(["a", "b"], "", "ollama"));
    expect(mixKey(["a", "b"], "", "claude")).not.toBe(mixKey(["a", "c"], "", "claude"));
    expect(mixKey(["a", "b"], "x", "claude")).not.toBe(mixKey(["a", "b"], "y", "claude"));
  });
  test("dailyDue: never ran, or last ran on another local day", () => {
    const now = new Date(2026, 8, 26, 9, 0).getTime();
    const d = (t: number, status: Daily["status"] = "done"): Daily => ({ day: dayOf(t), at: t, status });
    expect(dailyDue(undefined, now)).toBe(true);
    expect(dailyDue(d(new Date(2026, 8, 26, 0, 5).getTime()), now)).toBe(false);
    expect(dailyDue(d(new Date(2026, 8, 26, 0, 5).getTime(), "error"), now)).toBe(false); // a failure doesn't retry today
    expect(dailyDue(d(new Date(2026, 8, 26, 8, 0).getTime(), "running"), now)).toBe(false);
    expect(dailyDue(d(new Date(2026, 8, 25, 23, 59).getTime()), now)).toBe(true);
  });
});

// ── the job runner, with fake engines ─────────────────────────────────────────────────
const waitFor = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await Bun.sleep(10); return f(); };
function fakeClaude(chunks: string[], gap = 5, calls = { n: 0 }) {
  return async (o: RunOpts) => {
    calls.n++;
    let all = "";
    for (const c of chunks) {
      if (o.signal.aborted) throw new Error("cancelled");
      await Bun.sleep(gap);
      if (o.signal.aborted) throw new Error("cancelled");
      all += c; o.onText(all);
    }
    return { text: all, model: "haiku" };
  };
}

describe("createMixer", () => {
  test("streams mixes in, caches by selection/direction/engine, serves the cache next time", async () => {
    const calls = { n: 0 };
    const mx = createMixer({ file: `${root}/a/mix-cache.json`, runClaude: fakeClaude([good.slice(0, 200), good.slice(200, 420), good.slice(420)], 250, calls), claudeAvailable: () => true, ollamaModels: async () => [] });
    const r1 = mx.mix(SEL, "", "claude");
    expect(r1.job?.status).toBe("running");
    await waitFor(() => mx.status(r1.job!.id).mixes.length >= 1 && mx.status(r1.job!.id).status === "running", 2000);
    expect(mx.status(r1.job!.id).mixes[0]?.title).toBe("Voice Chart"); // before the model finished
    await waitFor(() => mx.status(r1.job!.id).status === "done");
    const done = mx.status(r1.job!.id);
    // Two model mixes aren't enough: templates fill up to six.
    expect(done.mixes.length).toBe(6);
    expect(done.mixes.filter((m) => m.source === "claude")).toHaveLength(2);
    const r2 = mx.mix([...SEL].reverse(), "", "claude");
    expect(r2.cached).toBe(true);
    expect(r2.result!.mixes[0].title).toBe("Voice Chart");
    expect(calls.n).toBe(1);
    expect(mx.peek(SEL, "", "claude").cached).toBe(true);
    expect(mx.peek(SEL, "other direction", "claude").cached).toBeUndefined();
    const forced = mx.mix(SEL, "", "claude", undefined, true);
    expect(forced.job).toBeTruthy();
    await waitFor(() => mx.status(forced.job!.id).status === "done");
    expect(calls.n).toBe(2);
    mx.flush();
    expect(Object.keys(JSON.parse(readFileSync(`${root}/a/mix-cache.json`, "utf8")).entries)).toHaveLength(1);
  });
  test("a slow model hits the time limit: finished mixes stay, templates fill the rest", async () => {
    const six = JSON.stringify({ mixes: Array.from({ length: 6 }, (_, i) => ({ title: `M${i}`, ingredients: ["chart-chat", "Telegram"] })) });
    const mx = createMixer({ file: `${root}/b/mix-cache.json`, runClaude: fakeClaude([six.slice(0, 160), six.slice(160)], 400), claudeAvailable: () => true, ollamaModels: async () => [], timeouts: { claude: 600, ollama: 600 } });
    const { job } = mx.mix(SEL, "", "claude");
    await waitFor(() => mx.status(job!.id).status !== "running", 3000);
    const s = mx.status(job!.id);
    expect(s.status).toBe("done");
    expect(s.elapsed).toBeLessThan(1500);
    expect(s.mixes.length).toBeGreaterThanOrEqual(3);
    expect(s.mixes.some((m) => m.source === "template")).toBe(true);
    expect(s.note).toMatch(/too long|time limit/);
  });
  test("an unavailable model falls back to templates at once and isn't cached", async () => {
    const mx = createMixer({ file: `${root}/c/mix-cache.json`, runClaude: async () => { throw new Error("Claude Code (claude) isn't installed here"); }, claudeAvailable: () => false, ollamaModels: async () => [] });
    const { job } = mx.mix(SEL, "", "claude");
    await waitFor(() => mx.status(job!.id).status === "done");
    const s = mx.status(job!.id);
    expect(s.mixes).toHaveLength(6);
    expect(s.mixes.every((m) => m.source === "template")).toBe(true);
    expect(s.note).toContain("isn't installed");
    expect(mx.peek(SEL, "", "claude").cached).toBeUndefined();
  });
  test("cancel stops the run", async () => {
    const mx = createMixer({ file: `${root}/d/mix-cache.json`, runClaude: fakeClaude(Array(50).fill(" "), 30), claudeAvailable: () => true, ollamaModels: async () => [] });
    const { job } = mx.mix(SEL, "", "claude");
    await Bun.sleep(40);
    expect(mx.cancel(job!.id).status).toBe("cancelled");
    await Bun.sleep(80);
    expect(mx.status(job!.id).status).toBe("cancelled");
    expect(() => mx.status("nope")).toThrow();
  });
  test("the daily mix: templates at once, the model once a day, never again that day", async () => {
    const calls = { n: 0 };
    const mx = createMixer({ file: `${root}/e/mix-cache.json`, runClaude: fakeClaude([good], 5, calls), claudeAvailable: () => true, ollamaModels: async () => [] });
    const now = Date.now();
    const d1 = mx.daily(SEL, now);
    expect(d1.generated).toBe(false);
    expect(d1.running).toBe(true);
    expect(d1.mixes.length).toBeGreaterThan(0);
    expect(d1.mixes.every((m) => m.source === "template")).toBe(true);
    await waitFor(() => mx.daily(SEL, now).generated);
    const d2 = mx.daily(SEL, now);
    expect(d2.running).toBe(false);
    expect(d2.mixes[0].title).toBe("Voice Chart");
    mx.daily(SEL, new Date(now).setHours(23, 59, 59, 999)); // Adding an hour can cross midnight on the test host.
    expect(calls.n).toBe(1);
    // Waiting for the connections scan doesn't start it.
    const mx2 = createMixer({ file: `${root}/f/mix-cache.json`, runClaude: fakeClaude([good], 5, calls), claudeAvailable: () => true, ollamaModels: async () => [] });
    expect(mx2.daily(SEL, now, true).waiting).toBe(true);
    expect(calls.n).toBe(1);
    // The next day it runs again.
    mx.daily(SEL, now + 86_400_000 * 1.2);
    await waitFor(() => calls.n === 2);
    expect(calls.n).toBe(2);
  });
  test("ollama runs through its own engine and model", async () => {
    let seen: string | undefined;
    const mx = createMixer({ file: `${root}/g/mix-cache.json`, runOllama: async (o) => { seen = o.model; o.onText(good); return { text: good, model: o.model ?? "x" }; }, claudeAvailable: () => false, ollamaModels: async () => ["gemma4:e4b"] });
    expect((await mx.engines()).ollama).toEqual(["gemma4:e4b"]);
    const { job } = mx.mix(SEL, "privacy-first", "ollama", "gemma4:e4b");
    await waitFor(() => mx.status(job!.id).status === "done");
    expect(seen).toBe("gemma4:e4b");
    expect(mx.status(job!.id).mixes[0].source).toBe("ollama");
  });
});

// ── the routes, through createDiscover (no network, fake engine) ─────────────────────────
import { createDiscover } from "../discover";
describe("Discover routes for the mixer", () => {
  const wiki = `${root}/w`, projects = `${root}/p`;
  require("node:fs").mkdirSync(`${wiki}/projects`, { recursive: true });
  require("node:fs").mkdirSync(projects, { recursive: true });
  for (const [n, t] of [["chart-chat", "Talk to your bodygraph."], ["yt-transcriber", "Clips from long videos."]]) require("node:fs").writeFileSync(`${wiki}/projects/${n}.md`, `---\nstatus: active\ntags: [human-design, video]\n---\n\n${t}\n`);
  const calls = { n: 0 };
  const d = createDiscover({ dataDir: `${root}/dd`, wikiDir: wiki, projectsDir: projects }, {
    gh: async () => ({ ok: false, status: 0, error: "offline" }), gap: 0,
    items: async () => ({ items, categories: [{ id: "comms", label: "Communication" }] }),
    mixer: { runClaude: fakeClaude([good], 5, calls), claudeAvailable: () => true, ollamaModels: async () => [] },
  });
  test("ingredients, mix (then cache), status, save and unsave, and state's Mixes for you", async () => {
    const ing = await d.handle("/api/discover/mix-ingredients", {});
    expect(ing.ingredients.some((x: Ingredient) => x.id === "c:svc:telegram" && x.group === "Communication")).toBe(true);
    expect(ing.engines).toEqual({ claude: true, ollama: [] });
    await expect(d.handle("/api/discover/mix", { ingredients: [{ id: "p:chart-chat" }] })).rejects.toThrow(/two/);
    const sel = [{ id: "p:chart-chat", kind: "project", name: "chart-chat" }, { id: "c:svc:telegram", kind: "conn", name: "Telegram", desc: "IGNORED: the server's own description wins" }];
    const r = await d.handle("/api/discover/mix", { ingredients: sel, engine: "claude" });
    expect(r.job.status).toBe("running");
    await waitFor(() => d.mixer.status(r.job.id).status === "done");
    const s = await d.handle("/api/discover/mix-status", { id: r.job.id });
    // The fake model only named ingredients outside this two-item selection: all dropped, the one possible template pair fills in.
    expect(s.mixes).toHaveLength(1);
    expect(s.mixes[0]).toMatchObject({ source: "template", ids: ["p:chart-chat", "c:svc:telegram"] });
    expect(s.mixes[0].how[1].role).toContain("bots and messages"); // the server's description, not the page's
    expect((await d.handle("/api/discover/mix", { ingredients: sel, engine: "claude", peek: true })).cached).toBeUndefined(); // templates aren't cached
    const sel3 = [...sel, { id: "i:human-design", kind: "interest", name: "Human Design" }];
    const r3 = await d.handle("/api/discover/mix", { ingredients: sel3, engine: "claude" });
    await waitFor(() => d.mixer.status(r3.job.id).status === "done");
    expect(d.mixer.status(r3.job.id).mixes.some((m) => m.source === "claude")).toBe(true);
    expect((await d.handle("/api/discover/mix", { ingredients: [...sel3].reverse(), engine: "claude", peek: true })).cached).toBe(true);
    const saved = await d.handle("/api/discover/mix-save", { op: "save", mix: s.mixes[0], direction: "make money" });
    expect(saved.mixes[0]).toMatchObject({ id: s.mixes[0].id, direction: "make money" });
    expect(JSON.parse(readFileSync(`${root}/dd/discover.json`, "utf8")).mixes).toHaveLength(1);
    const st = await d.handle("/api/discover", {});
    expect(st.mixes.saved).toHaveLength(1);
    expect(st.mixes.forYou).toBeUndefined(); // "Ideas for you" is its own route now (src/feed.ts)
    expect((await d.handle("/api/discover/mix-save", { op: "unsave", id: s.mixes[0].id })).mixes).toHaveLength(0);
  });
});
