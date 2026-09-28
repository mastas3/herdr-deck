import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appendProofs, XP, type JourneyLike } from "../game-rules";
import { QUEST_XP } from "../game-quests";
import { createGame, SWITCH_COOLDOWN } from "../game";
import { cleanPrefs, DEFAULT_PREFS, wants, type Device } from "../../../src/push";
import { Automations } from "../../../src/automations";

const root = mkdtempSync(`${tmpdir()}/deck-game-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const DAY = 86_400_000, H = 3600_000;
const T0 = Date.UTC(2026, 8, 21, 9); // Monday 2026-09-21, 09:00 UTC

function journey(p: string, over: Partial<JourneyLike> = {}): JourneyLike {
  return { project: p, events: [], metrics: [], milestones: [], next: [], now: { t: T0, github: "me/" + p }, ...over };
}
const ms = (o: Partial<JourneyLike["milestones"][number]> & { source: string; target: number }) => ({ id: o.id ?? `${o.source}-${o.target}`, title: o.title ?? `${o.target} ${o.source}`, metric: o.metric ?? "m", unit: o.unit ?? "", tier: o.tier ?? 1, state: o.state ?? "locked", ...o });

// ── the service, end to end with a fake journey source ───────────────────────────────────
describe("the quest board service", () => {
  const dir = `${root}/game`;
  const projectsDir = `${root}/Projects`;
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(`${root}/disc`, { recursive: true });
  writeFileSync(`${root}/disc/leads-cache.json`, JSON.stringify({ entries: { a: { text: "human design", keywords: ["human design"], themes: [{ quotes: [{ url: "https://www.reddit.com/r/humandesign/9", title: "Who reads charts?", where: { label: "r/humandesign" }, at: T0 }] }] } } }));
  let clock = T0 + 10 * DAY;
  const J: Record<string, JourneyLike & Record<string, any>> = {
    astra: journey("astra", { tags: ["human-design"], nature: "consumer-app", pitch: "HD readings", root: `${projectsDir}/astra`,
      events: [{ id: "l1", t: T0, kind: "log", title: "funnel deployed", link: { wiki: "log" } }],
      milestones: [ms({ id: "first-paying-customer", title: "First paying customer", source: "manual.paying_customers", target: 1, tier: 2 })], next: ["first-paying-customer"] }),
    side: journey("side", { events: [{ id: "t", t: T0 + 11 * DAY, kind: "tag", title: "Tagged v2" }], now: { t: T0, last: T0 - 40 * DAY } }),
  };
  const seeded: Record<string, any[]> = {};
  const pushes: any[] = [];
  const jevCalls: any[] = [];
  const outcomes: any[] = [];
  let model = 0;
  const game = createGame({
    dir, projectsDir, discoverDir: `${root}/disc`, now: () => clock,
    journeys: {
      get: async (p) => J[p] ?? journey(p),
      index: async () => ({ projects: Object.keys(J).map((p) => ({ project: p, last: clock, milestones: 1 })) }),
      seedLadder: (p, l) => { seeded[p] = l; },
    },
    runner: async () => { model++; return { text: JSON.stringify({ quests: [{ title: "Reply to the r/humandesign lead", proof: "lead", mode: "diy", steps: ["reply"], leads: [0] }, { title: "Ship the astra reading checkout", proof: "ship", mode: "agent", prompt: "Add a checkout for the founding reading with a clear price." }, { title: "Ask one r/humandesign member which chart app they use", proof: "talk", mode: "diy", steps: ["find one", "ask"] }, { title: "Offer the astra reading to the r/humandesign poster", proof: "sell", mode: "diy", steps: ["ask"] }, { title: "Engage with your audience", proof: "talk", mode: "diy", steps: ["post"] }, { title: "Draft the astra launch note for r/humandesign", proof: "talk", mode: "agent", prompt: "Write a short launch note for r/humandesign and save it as a draft." }] }), model: "haiku" }; },
    jev: { available: () => true, ask: async (state, q, kind) => { jevCalls.push({ state, q, kind }); return { id: "jev-1", answers: { met: { noul: 0.22 }, verdict: { choice: "partial" } }, fallback: null }; }, outcome: async (...a) => { outcomes.push(a); } },
    deliver: async (m) => { pushes.push(m); },
    connections: async () => ["Reddit", "Gumroad"],
  });
  test("nothing is written until the board is first opened", () => {
    expect(game.started()).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(game.summary()).toEqual({ started: false });
  });
  test("first open: history is paid plainly, then picking a main quest", async () => {
    const b = await game.handle("/api/game", { wait: true, tz: "UTC" });
    expect(existsSync(`${dir}/state.json`)).toBe(true);
    // the funnel deploy from before the game pays plainly; side's tag (after the start, no main quest yet) is capped at the floor
    expect(b.xp.total).toBe(XP.shipnote + XP.sideFloor);
    expect(b.level.name).toBe("Shipper");
    expect(b.main).toBeNull();
    expect(b.suggest.map((s: any) => s.project)).toContain("astra");
    const r = await game.handle("/api/game/main", { project: "astra" });
    expect(r.ok).toBe(true);
    await game.ensureQuests({ wait: true });
    const b2 = game.board();
    expect(b2.main.project).toBe("astra");
    expect(b2.main.bosses[0]).toMatchObject({ title: "First paying customer", hp: 1 });
    expect(b2.quests.items.length).toBe(3);
    expect(b2.quests.source).toBe("claude");
    expect(b2.quests.items[0].leads[0].url).toBe("https://www.reddit.com/r/humandesign/9");
    expect(model).toBe(1);
    await game.ensureQuests({ wait: true }); // once a day
    expect(model).toBe(1);
  });
  test("switching the main quest soon after asks for confirmation", async () => {
    clock += H;
    const r = await game.handle("/api/game/main", { project: "side" });
    expect(r).toMatchObject({ ok: false, needsConfirm: true });
    expect(r.message).toContain("astra");
    expect(game._state()!.main!.project).toBe("astra");
    expect(r.cooldownLeft).toBeLessThanOrEqual(SWITCH_COOLDOWN);
  });
  test("a lead needs its link, pays once, and completes the lead quest", async () => {
    clock += H;
    await expect(game.handle("/api/game/log", { kind: "lead", note: "replied" })).rejects.toThrow(/link/);
    const r = await game.handle("/api/game/log", { kind: "lead", url: "https://www.reddit.com/r/humandesign/9#comment", title: "Who reads charts?" });
    expect(r.logged).toMatchObject({ kind: "lead", main: true, xp: XP.lead });
    await expect(game.handle("/api/game/log", { kind: "lead", url: "https://reddit.com/r/humandesign/9/" })).rejects.toThrow(/never pays twice/);
    const q = r.quests.items.find((x: any) => x.proof === "lead");
    expect(q.state).toBe("done");
    expect(q.evidence.link.url).toContain("humandesign/9");
    expect(r.log.some((l: any) => l.id.startsWith("quest:") && l.eff === q.xp * 2)).toBe(true);
    expect(pushes.some((m) => m.kind === "quest" && m.title.startsWith("Quest done"))).toBe(true);
  });
  test("a conversation needs a note; a ship check-off needs the live link", async () => {
    await expect(game.handle("/api/game/log", { kind: "talk", note: "hi" })).rejects.toThrow(/who you talked/);
    const ship = game.board().quests.items.find((x: any) => x.proof === "ship");
    await expect(game.handle("/api/game/quest", { op: "done", id: ship.id, note: "done it" })).rejects.toThrow(/live link/);
    const b = await game.handle("/api/game/quest", { op: "done", id: ship.id, url: "https://2027prophecy.com/reading" });
    expect(b.quests.items.find((x: any) => x.id === ship.id)).toMatchObject({ state: "done", evidence: { manual: true } });
    expect(b.streak.today).toBe(true);
  });
  test("undo within a day takes the XP back and reopens the quest", async () => {
    const talk = game.board().quests.items.find((x: any) => x.proof === "talk");
    const b = await game.handle("/api/game/log", { kind: "talk", note: "Dana, HD coach: wants transit alerts" });
    expect(b.quests.items.find((x: any) => x.id === talk.id).state).toBe("done");
    const before = b.xp.total;
    const u = await game.handle("/api/game/log", { op: "undo", id: b.logged.id });
    expect(u.quests.items.find((x: any) => x.id === talk.id).state).toBe("open");
    expect(u.xp.total).toBe(before - XP.talk * 2 - QUEST_XP.talk * 2);
  });
  test("reroll swaps in a spare, twice a day at most", async () => {
    const open = game.board().quests.items.filter((x: any) => x.state === "open");
    await game.handle("/api/game/quests", { op: "reroll", id: open[0].id });
    const again = game.board().quests.items.filter((x: any) => x.state === "open");
    await game.handle("/api/game/quests", { op: "reroll", id: again[0].id });
    const third = game.board().quests.items.filter((x: any) => x.state === "open");
    await expect(game.handle("/api/game/quests", { op: "reroll", id: third[0].id })).rejects.toThrow(/2 rerolls/);
    expect(model).toBe(1); // spares, not new model calls
    // switching away and back brings today's quests back, without another model call
    const ids = game.board().quests.items.map((q: any) => q.id);
    await game.handle("/api/game/main", { project: "side", confirm: true });
    await game.ensureQuests({ wait: true });
    expect(model).toBe(2);
    await game.handle("/api/game/main", { project: "astra", confirm: true });
    await game.ensureQuests({ wait: true });
    expect(model).toBe(2);
    expect(game.board().quests.items.map((q: any) => q.id)).toEqual(ids);
  });
  test("side quests are capped; retiring a project is progress", async () => {
    clock = T0 + 11 * DAY + 2 * H; // side's v2 tag is today
    await game.sweep({ wait: true });
    const b = game.board();
    const tag = b.log.find((l: any) => l.id === "rel:side:2");
    expect(tag.main).toBe(false);
    expect(tag.eff).toBeLessThanOrEqual(Math.max(XP.sideFloor, Math.round(b.xp.main * XP.sideRatio)));
    await expect(game.handle("/api/game/retire", { project: "side", note: "" })).rejects.toThrow(/why/);
    const r = await game.handle("/api/game/retire", { project: "side", note: "nobody needs it" });
    expect(r.retired.map((x: any) => x.project)).toEqual(["side"]);
    expect(r.achievements.find((a: any) => a.id === "zombie").at).toBe(clock);
    expect(r.side.map((s: any) => s.project)).not.toContain("side");
  });
  test("a week goal, Jev's judgment with a reason, and a dispute that's recorded as an outcome", async () => {
    await expect(game.handle("/api/game/season", { op: "judge" })).rejects.toThrow(/goal first/);
    await game.handle("/api/game/week", { goal: "Get the first paying customer for astra" });
    const b = await game.handle("/api/game/season", { op: "judge" });
    expect(b.season.judge).toMatchObject({ id: "jev-1", p: 0.22, choice: "partial" });
    expect(b.season.judge.reason).toContain("Partly");
    expect(jevCalls[0].kind).toBe("game-season");
    expect(jevCalls[0].state.goal).toContain("first paying customer");
    expect(jevCalls[0].state.evidence.join(" ")).toContain("Shipped");
    await game.handle("/api/game/season", { op: "judge" }); // same evidence: not asked again
    expect(jevCalls.length).toBe(1);
    const d = await game.handle("/api/game/season", { op: "dispute", note: "Dana paid in cash" });
    expect(d.season.dispute.note).toBe("Dana paid in cash");
    expect(outcomes[0]).toEqual(["jev-1", false, "disputed by the user: Dana paid in cash"]);
  });
  test("startRun seeds a ladder, becomes a candidate, and creates no folder", async () => {
    await expect(game.handle("/api/game/run", { idea: {} })).rejects.toThrow(/name/);
    const r = await game.handle("/api/game/run", { idea: { name: "Transit Buddy", buyer: "HD coaches", offer: "daily transit alerts", price: "$9/mo" } });
    expect(r).toMatchObject({ project: "transit-buddy", exists: false, mkdir: true, isMain: false, main: "astra" });
    expect(existsSync(`${projectsDir}/transit-buddy`)).toBe(false);
    expect(seeded["transit-buddy"].map((m: any) => m.title)).toContain("First paying customer");
    expect(r.prompt).toContain("HD coaches");
    expect(r.prompt).toMatch(/don't post/i);
    expect(r.quest.title).toContain("Transit Buddy");
    expect(game._state()!.candidate).toBe("transit-buddy");
    // The gallery's Play: the kit's folder slug and its task 1 become the run's prompt.
    const k = await game.handle("/api/game/run", { idea: { name: "Transit Buddy", slug: "transit-buddy-2", firstTask: { title: "T1 Read the log format", prompt: "Do task T1 from TASKS.md" } } });
    expect(k).toMatchObject({ project: "transit-buddy-2", quest: { title: "T1 Read the log format" }, prompt: "Do task T1 from TASKS.md" });
  });
  test("the morning digest gets today's quest lines", async () => {
    const lines = await game.digestLines();
    expect(lines[0]).toContain("astra");
    expect(lines.length).toBe(4);
    expect(lines[1]).toMatch(/^1\. .+\(\+\d+ XP\)$/);
  });
  test("state files are plain JSON; the ledger only grows", () => {
    const led = JSON.parse(readFileSync(`${dir}/ledger.json`, "utf8"));
    expect(led.some((l: any) => l.kind === "revoke")).toBe(true);
    expect(led.every((l: any) => l.id && l.evidence !== undefined)).toBe(true);
  });
});

// ── push prefs and the digest ─────────────────────────────────────────────────────────
describe("quest pushes: the digest by default, the rest only if you ask", () => {
  const dev = (prefs: any): Device => ({ id: "d", endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" }, label: "Phone", prefs: cleanPrefs(prefs), createdAt: 0 });
  test("defaults: quests in the digest on, quest pushes off; the choices are the plugin's, kept by name", () => {
    expect(DEFAULT_PREFS).not.toHaveProperty("quests");
    expect(cleanPrefs({ questDigest: false, quests: true })).toMatchObject({ questDigest: false, quests: true });
    // Saved from a page where the quests plugin is off: the device keeps its earlier choices.
    expect(cleanPrefs({ needs: false }, cleanPrefs({ quests: true }))).toMatchObject({ needs: false, quests: true });
    expect(cleanPrefs({ "bad key": true, quiet: true })).not.toHaveProperty("bad key");
    const m = { kind: "quest", pref: "quests", title: "Quest done", body: "" };
    expect(wants(dev({}), m, new Date())).toBe(false);
    expect(wants(dev({ quests: true }), m, new Date())).toBe(true);
    expect(wants(dev({ quests: true, quiet: { on: true, from: "00:00", to: "23:59" } }), m, new Date(2026, 0, 1, 12))).toBe(false);
  });
  test("the digest push carries today's quests to devices that keep them on", async () => {
    const sent: { body: string; to: string[] }[] = [];
    const devices = [dev({}), { ...dev({ questDigest: false }), id: "e" }];
    const auto = new Automations({
      file: `${root}/auto.json`, rows: () => [], changed: () => {}, viewing: () => false, canSend: () => true, ctx: () => ({ machineLabel: () => "", multi: false }),
      deliver: async (m, o) => { const to = devices.filter((d) => !o?.filter || o.filter(d)).map((d) => d.id); sent.push({ body: m.body, to }); return { sent: to.length, targets: to.length, dropped: 0 }; },
      digest: () => [{ title: "Today's quests", pref: "questDigest", lines: async () => ["⚔ astra · boss: First paying customer (100% health)", "1. Post the demo (+160 XP)"] }],
    });
    await auto.runDigest(true);
    expect(sent.length).toBe(2);
    expect(sent.find((s) => s.to.includes("d"))!.body).toContain("Today's quests\n⚔ astra");
    expect(sent.find((s) => s.to.includes("e"))!.body).not.toContain("quests");
    expect(auto.state.status.digest?.lastResult).toContain("with today's quests");
  });
});

describe("evidence arriving later completes quests and hits the boss", () => {
  test("a Gumroad sale: the sell quest completes, the boss falls, bundled into one push, never twice", async () => {
    const dir = `${root}/game2`;
    let clock = T0 + 30 * DAY;
    const j = journey("shop", { nature: "consumer-app", events: [{ id: "old", t: T0, kind: "log", title: "shop launched", link: { wiki: "log" } }],
      milestones: [ms({ id: "first-paying-customer", title: "First paying customer", source: "manual.paying_customers", target: 1, tier: 2 })], next: ["first-paying-customer"] });
    const pushes: any[] = [];
    const game = createGame({ dir, projectsDir: `${root}/P2`, discoverDir: `${root}/none`, now: () => clock,
      journeys: { get: async () => j, index: async () => ({ projects: [{ project: "shop", last: clock, milestones: 1 }] }) },
      runner: async () => ({ text: JSON.stringify({ quests: [{ title: "Ask one shop reader to buy the reading", proof: "sell", mode: "diy", steps: ["ask"] }] }), model: "haiku" }),
      deliver: async (m) => { pushes.push(m); } });
    await game.handle("/api/game", { wait: true, tz: "UTC" });
    expect(pushes).toEqual([]); // history isn't news
    await game.handle("/api/game/main", { project: "shop" });
    await game.ensureQuests({ wait: true });
    const sellQ = game.board().quests.items.find((q: any) => q.proof === "sell")!;
    expect(sellQ.state).toBe("open");
    expect(game.board().quests.items.find((q: any) => q.proof === "ship")?.state ?? "open").toBe("open"); // the old launch doesn't count
    clock += 2 * H;
    j.metrics = [
      { key: "gumroad.sales", value: 1, series: [[clock - H, 1]], evidence: "Gumroad: 1 sale of Reading" },
      { key: "gumroad.revenue", value: 29, series: [[clock - H, 29]], evidence: "Gumroad revenue" },
    ];
    j.milestones[0] = { ...j.milestones[0], state: "unlocked", at: clock - H, value: 1, evidence: "Gumroad: 1 sale of Reading" };
    await game.sweep({ wait: true });
    const b = game.board();
    expect(b.quests.items.find((q: any) => q.id === sellQ.id)).toMatchObject({ state: "done", evidence: { title: "First sale!" } });
    expect(b.main.bosses[0]).toMatchObject({ state: "defeated", hp: 0 });
    expect(b.level.name).toBe("Seller");
    expect(b.revenue.total).toBe(0); // no Gumroad product named in this fake journey's sources
    expect(b.streak.today).toBe(true);
    const titles = pushes.map((m) => m.title).join(" | ");
    expect(pushes.length).toBe(1); // bundled: more than two wins become one push
    expect(titles).toContain("updates on the quest board");
    expect(pushes[0].body).toContain("Quest done");
    expect(pushes[0].body).toContain("Boss defeated: First paying customer");
    expect(pushes[0].body).toContain("Achievement: First dollar");
    await game.sweep({ wait: true });
    expect(pushes.length).toBe(1);
    expect(b.achievements.find((a: any) => a.id === "first-boss").at).toBe(clock - H);
    // a logged users number is a hit on a users boss only; it never lands on the customers boss
    clock += H;
    j.events = [...j.events, { id: "u1", t: clock - 60_000, kind: "manual", title: "users = 12", detail: "12 sign-ups from the landing page" }];
    j.metrics = [...j.metrics, { key: "manual.users", value: 12, series: [[clock - 60_000, 12]], evidence: "logged" }];
    await game.sweep({ wait: true });
    expect(pushes.slice(1).map((m) => m.title)).toEqual(["Achievement: First user"]); // no boss push: this shop's bosses count customers
  });
});
