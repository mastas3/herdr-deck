import { describe, expect, test } from "bun:test";
import { arrange, fallbackQuests, generateQuests, genericReason, normalizeQuests, QUEST_XP, vetQuests, type QuestCtx } from "../game-quests";
import { cleanIdea, leadsFor, projectTerms, runFolderOk, runLadder } from "../game-runs";
import { parseJsonLoose } from "../../../src/model-call";

// ── quests: JSON repair and fallback ──────────────────────────────────────────────────
const qctx = (over: Partial<QuestCtx> = {}): QuestCtx => ({
  project: "astra", root: "/Users/me/Documents/Projects/astra", pitch: "Human Design readings", day: "2026-09-26",
  next: [{ id: "first-paying-customer", title: "First paying customer", metric: "Paying customers", target: 1, value: 0 }],
  boss: { title: "First paying customer", source: "manual.paying_customers", value: 0, target: 1, unit: "customers", measured: true }, recent: [],
  leads: [{ id: "l1", title: "Looking for an HD reader", url: "https://www.reddit.com/r/humandesign/comments/abc/", where: "r/humandesign" }, { id: "l2", title: "Any app for transits?", url: "https://news.ycombinator.com/item?id=1", where: "Hacker News" }],
  connections: ["Reddit", "X (Twitter)", "Gumroad"], done: [], ...over,
});
describe("quests: strict JSON, repaired, specific or thrown away", () => {
  test("a truncated, fenced answer still yields valid quests; bad shapes are dropped or fixed", () => {
    const text = '```json\n{"quests":[{"title":"Post the demo to r/humandesign","why":"moves first customer","milestone":"first-paying-customer","proof":"talk","mode":"diy","steps":["record","post"],"leads":[0,7]},{"title":"x"},{"title":"Reply to 2 people from the leads","proof":"lead","count":9,"mode":"diy","steps":["reply"]},{"title":"Ship the checkout page","proof":"banana","mode":"agent","prompt":"Add a checkout page with the Gumroad overlay and a clear price."},{"title":"Ask Dana to buy the reading","proof":"sell","mode":"agent","prompt":"short"},{"title":"Ship the checkout page"';
    const qs = normalizeQuests(parseJsonLoose(text), qctx());
    expect(qs.map((q) => q.title)).toEqual(["Post the demo to r/humandesign", "Reply to 2 people from the leads", "Ship the checkout page", "Ask Dana to buy the reading"]);
    expect(qs[0].leads.map((l) => l.id)).toEqual(["l1"]); // index 7 doesn't exist
    expect(qs[1]).toMatchObject({ proof: "lead", count: 2 }); // capped to the leads there are
    expect(qs[2]).toMatchObject({ proof: "ship", mode: "agent" }); // proof inferred from the title
    expect(qs[2].prompt).toMatch(/don't post/i); // the safety rules ride along
    expect(qs[2].prompt).toContain("~/Documents/Projects/astra");
    expect(qs[3]).toMatchObject({ proof: "sell", mode: "diy" }); // no usable prompt → a checklist
    expect(qs.every((q) => q.xp === QUEST_XP[q.proof] && q.milestone === "first-paying-customer")).toBe(true);
  });
  test("lead quests need real leads", () => {
    expect(normalizeQuests({ quests: [{ title: "Reply to 3 leads today", proof: "lead", mode: "diy", steps: ["a"] }] }, qctx({ leads: [] }))).toEqual([]);
  });
  test("a quest that could apply to any project is rejected, with the reason", () => {
    const ctx = qctx({ urls: ["https://2027prophecy.com/"], product: "2027 Prophecy: The Founding Reading" });
    const qs = normalizeQuests({ quests: [
      { title: "Engage with your audience on social media", proof: "talk", mode: "diy", steps: ["post daily"] },
      { title: "Improve the onboarding flow", proof: "ship", mode: "agent", prompt: "Make onboarding smoother and more delightful for users." },
      { title: "Talk to potential users about their needs", proof: "talk", mode: "diy", steps: ["find users", "ask questions"] },
      { title: "Ship the pricing page", proof: "ship", mode: "agent", prompt: "Add a pricing page with one plan and a buy button." },
      { title: "Put the Founding Reading's Gumroad link on the 2027prophecy.com home page", proof: "ship", mode: "agent", prompt: "Add the Gumroad buy link for the Founding Reading above the fold on the home page." },
      { title: "Reply to the r/humandesign post asking for a reader", proof: "lead", mode: "diy", steps: ["reply"], leads: [0] },
      { title: "Record a 30-second demo of the Human Design readings flow", proof: "talk", mode: "diy", steps: ["record it"] },
    ] }, ctx);
    const { kept, rejected } = vetQuests(qs, ctx);
    expect(kept.map((q) => q.title)).toEqual(["Put the Founding Reading's Gumroad link on the 2027prophecy.com home page", "Reply to the r/humandesign post asking for a reader", "Record a 30-second demo of the Human Design readings flow"]);
    expect(rejected).toEqual([
      { title: "Engage with your audience on social media", reason: "vague wording: advice, not a task" },
      { title: "Improve the onboarding flow", reason: "vague wording: advice, not a task" },
      { title: "Talk to potential users about their needs", reason: expect.stringContaining("could apply to any project") },
      { title: "Ship the pricing page", reason: expect.stringContaining("could apply to any project") },
    ]);
    expect(genericReason({ title: "Get the first paying customer", why: "the boss", steps: [], leads: [] }, ctx)).toContain("any project"); // a milestone name alone is on every ladder
    const [q] = vetQuests(normalizeQuests({ quests: [{ title: "Reply on r/humandesign to the chart-app thread", why: "Engage users and build audience", proof: "lead", mode: "diy", steps: ["reply"], leads: [0] }] }, ctx), ctx).kept;
    expect(q.why).toBe("Moves “First paying customer”."); // filler reasons are replaced, not shown
  });
  test("templates are built from real state only, so every one passes the same test", () => {
    const ctx = qctx({ urls: ["https://2027prophecy.com/"], product: "2027 Prophecy: The Founding Reading", boss: { title: "First paying customer", source: "manual.paying_customers", value: 0, target: 1, unit: "customers", measured: false } });
    const f = fallbackQuests(ctx);
    expect(vetQuests(f, ctx).rejected).toEqual([]);
    expect(f.map((q) => q.title)).toEqual([
      "Reply to the 2 posts from today's leads",
      "Offer “2027 Prophecy: The Founding Reading” to one person from r/humandesign",
      "Ship one change on 2027prophecy.com that moves “First paying customer”",
      "Log astra's real customers for “First paying customer”",
      "Draft a r/humandesign post about “2027 Prophecy: The Founding Reading”",
    ]);
    expect(f[0].steps.join(" ")).toContain("r/humandesign");
    expect(f.find((q) => q.proof === "metric")!.metric).toBe("manual.paying_customers"); // it wants that number, not any number
    expect(new Set(f.map((q) => q.id)).size).toBe(f.length);
    // no leads, no site, no product: fewer quests, not filler
    const bare = fallbackQuests(qctx({ leads: [], urls: [], product: undefined, boss: { title: "First paying customer", source: "manual.paying_customers", value: 0, target: 1, unit: "customers", measured: true } }));
    expect(bare.map((q) => q.proof)).toEqual(["ship"]);
    expect(bare[0].title).toBe("Ship one change to astra that moves “First paying customer”");
  });
  test("today's three: people first, at most one pure-code quest", () => {
    const ctx = qctx({ urls: ["https://2027prophecy.com/"], product: "The Founding Reading" });
    const code = normalizeQuests({ quests: [
      { title: "Make the astra tests pass", proof: "check", mode: "agent", prompt: "Run the tests and fix what fails, then show me." },
      { title: "Log astra's sign-ups from 2027prophecy.com", proof: "metric", mode: "diy", steps: ["log"] },
      { title: "Ship the 2027prophecy.com pricing section", proof: "ship", mode: "agent", prompt: "Add a pricing section with one plan and a buy button." },
    ] }, ctx);
    const a = arrange(code, fallbackQuests(ctx));
    const today = a.slice(0, 3);
    expect(["sell", "talk", "lead"]).toContain(today[0].proof);
    expect(today.filter((q) => !["sell", "talk", "lead", "ship"].includes(q.proof)).length).toBeLessThanOrEqual(1);
    expect(a.length).toBe(6);
    // a template spare that replies to leads a kept quest already has is dropped
    const kept = normalizeQuests({ quests: [{ title: "Reply on r/humandesign to the reader thread", proof: "lead", mode: "diy", steps: ["reply"], leads: [0, 1] }] }, ctx);
    expect(arrange(kept, fallbackQuests(ctx)).filter((q) => q.proof === "lead").length).toBe(1);
  });
  test("a failing, rambling or generic model falls back to rules; a specific one is used", async () => {
    let calls = 0;
    const boom = await generateQuests(qctx(), { runner: async () => { throw new Error("Claude took too long"); }, onCall: () => calls++ });
    expect(boom).toMatchObject({ source: "rules" }); expect(boom.note).toContain("took too long");
    const junk = await generateQuests(qctx(), { runner: async () => ({ text: "I think you should sell more!", model: "haiku" }), onCall: () => calls++ });
    expect(junk.source).toBe("rules");
    const generic = await generateQuests(qctx(), { runner: async () => ({ text: JSON.stringify({ quests: [{ title: "Work on marketing", proof: "talk", mode: "diy", steps: ["post"] }] }), model: "haiku" }), onCall: () => calls++ });
    expect(generic.source).toBe("rules"); expect(generic.rejected[0].title).toBe("Work on marketing");
    const good = await generateQuests(qctx(), { runner: async () => ({ text: JSON.stringify({ quests: [{ title: "Offer Dana from r/humandesign a founding reading", why: "first customer", proof: "sell", mode: "diy", steps: ["message Dana", "send the Gumroad link"] }] }), model: "haiku" }), onCall: () => calls++ });
    expect(good.source).toBe("claude"); expect(good.quests[0].title).toBe("Offer Dana from r/humandesign a founding reading");
    expect(calls).toBe(4);
    expect((await generateQuests(qctx(), {})).source).toBe("rules");
  });
});

// ── leads, runs ─────────────────────────────────────────────────────────────────────
describe("leads for a project, and runs from ideas", () => {
  const cache = { entries: {
    a: { text: "Human Design readers", keywords: ["human design", "reader"], themes: [{ quotes: [{ url: "https://www.reddit.com/r/humandesign/1", title: "Need a reader", where: { label: "r/humandesign" }, at: 3 }, { url: "https://www.reddit.com/r/humandesign/2", title: "Transit app?", at: 5 }] }] },
    b: { text: "Tarot readers who work alone", keywords: ["tarot", "alone", "reader"], themes: [{ quotes: [{ url: "https://x.com/t/1", title: "tarot", at: 9 }] }] },
  } };
  test("matched by the project's tags; generic words don't match; contacted ones are left out", () => {
    const terms = projectTerms("astra-apple", { tags: ["human-design", "sveltekit"] });
    expect(terms).toContain("human design");
    const ls = leadsFor(terms, cache);
    expect(ls.map((l) => l.url)).toEqual(["https://www.reddit.com/r/humandesign/2", "https://www.reddit.com/r/humandesign/1"]);
    expect(leadsFor(terms, cache, [], new Set(["reddit.com/r/humandesign/2"])).length).toBe(1);
    expect(leadsFor(["reader"], cache)).toEqual([]);
    const withReviews = { entries: { a: { keywords: ["human design"], themes: [{ quotes: [{ source: "appstore", url: "https://apps.apple.com/us/app/x/id1?see-all=reviews", title: "Stella", at: 9 }, { source: "reddit", url: "https://www.reddit.com/r/humandesign/3", title: "Chart app?", at: 1 }] }] } } };
    expect(leadsFor(terms, withReviews).map((l) => l.title)).toEqual(["Chart app?"]); // an App Store review can't be answered
  });
  test("an idea is cleaned (missing fields are fine) and gets a business ladder", () => {
    expect(cleanIdea(undefined)).toEqual({ error: "An idea needs a name" });
    expect(cleanIdea("  ")).toEqual({ error: "An idea needs a name" });
    const r = cleanIdea({ title: "Transit Buddy!", audience: "HD coaches", price: 19, starterKit: "sveltekit-starter" }) as any;
    expect(r).toMatchObject({ id: "transit-buddy", name: "Transit Buddy!", buyer: "HD coaches", price: "19", kit: "sveltekit-starter" });
    const L = runLadder(r);
    expect(L.map((x) => x.source)).toEqual(["deploy.live", "manual.users", "manual.paying_customers", "manual.paying_customers", "manual.mrr", "manual.mrr"]);
    expect(runFolderOk("/p/Projects/transit-buddy", "/p/Projects")).toBe(true);
    expect(runFolderOk("/p/Projects/../etc", "/p/Projects")).toBe(false);
    expect(runFolderOk("/p/Projects/a/b", "/p/Projects")).toBe(false);
    expect(runFolderOk("/elsewhere/x", "/p/Projects")).toBe(false);
  });
});

