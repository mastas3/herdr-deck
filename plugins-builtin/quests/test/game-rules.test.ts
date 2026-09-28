import { describe, expect, test } from "bun:test";
import {
  achievements, addDays, appendProofs, bossesFor, dayOf, last30, levelOf, levelReach, proofsFromJourney, score, scoreLines, seasonFor, streak, weekOf, XP,
  type JourneyLike, type Line, type Proof,
} from "../game-rules";

const DAY = 86_400_000, H = 3600_000;
const T0 = Date.UTC(2026, 8, 21, 9); // Monday 2026-09-21, 09:00 UTC

// ── fixtures ──
function journey(p: string, over: Partial<JourneyLike> = {}): JourneyLike {
  return { project: p, events: [], metrics: [], milestones: [], next: [], now: { t: T0, github: "me/" + p }, ...over };
}
const ms = (o: Partial<JourneyLike["milestones"][number]> & { source: string; target: number }) => ({ id: o.id ?? `${o.source}-${o.target}`, title: o.title ?? `${o.target} ${o.source}`, metric: o.metric ?? "m", unit: o.unit ?? "", tier: o.tier ?? 1, state: o.state ?? "locked", ...o });
const line = (o: Partial<Line> & { id: string; t: number }): Line => ({ project: "app", kind: "release", type: "ship", title: o.id, evidence: "e", xp: 100, at: o.t, main: true, ...o });


// ── proofs: only evidence pays ────────────────────────────────────────────────────────
describe("proofs from a journey", () => {
  const j = journey("app", {
    events: [
      { id: "c1", t: T0, kind: "commits", title: "12 commits" },
      { id: "s1", t: T0, kind: "session", title: "a long agent session" },
      { id: "t1", t: T0 + H, kind: "tag", title: "Tagged v1.2", link: { commit: "abc123def456" } },
      { id: "r1", t: T0 + 2 * H, kind: "release", title: "Released v1.2" },
      { id: "d1", t: T0, kind: "deploy", title: "Deploy setup: Docker", detail: "Dockerfile added", link: { commit: "fff", file: "Dockerfile" } },
      { id: "l1", t: T0 + DAY, kind: "log", title: "funnel deployed to Netlify", link: { wiki: "log" } },
      { id: "l2", t: T0 + DAY, kind: "log", title: "refactored the parser", link: { wiki: "log" } },
      { id: "l3", t: T0 + DAY, kind: "wiki", title: "Pre-launch foundation audit", link: { wiki: "app" } },
      { id: "l4", t: T0 + DAY, kind: "log", title: "private Netlify rehearsal gate deployed", link: { wiki: "log" } },
      { id: "l5", t: T0 + DAY, kind: "log", title: "reactivated; a Claude session launched to build the studio", link: { wiki: "log" } },
      { id: "l6", t: T0 + DAY, kind: "log", title: "launched Hebrew Radar pilot on 2027prophecy.com", link: { wiki: "log" } },
      { id: "l7", t: T0 + DAY, kind: "log", title: "launched the redesign effort", link: { wiki: "log" } },
      { id: "m1", t: T0 + 2 * DAY, kind: "merge", title: "Merged “payments”", link: { commit: "0123456789abcdef" } },
      { id: "u1", t: T0 + 3 * DAY, kind: "manual", title: "users = 5", detail: "5 beta sign-ups from the reddit post" },
      { id: "u2", t: T0 + 4 * DAY, kind: "manual", title: "users = 4" },
      { id: "u3", t: T0 + 5 * DAY, kind: "manual", title: "users = 9" },
    ],
    metrics: [
      { key: "git.commits", value: 700, evidence: "700 commits" },
      { key: "manual.users", value: 9, series: [[T0 + 3 * DAY, 5], [T0 + 4 * DAY, 4], [T0 + 5 * DAY, 9]], evidence: "logged" },
      { key: "gumroad.sales", value: 3, series: [[T0 + DAY, 1], [T0 + 3 * DAY, 3]], evidence: "Gumroad: 3 sales of Reading" },
      { key: "gumroad.revenue", value: 90, series: [[T0 + DAY, 30], [T0 + 3 * DAY, 90]], evidence: "Gumroad revenue" },
    ],
    milestones: [
      ms({ id: "100-commits", source: "git.commits", target: 100, state: "unlocked", at: T0, evidence: "700 commits" }),
      ms({ id: "50h", source: "sessions.agent_hours", target: 50, state: "unlocked", at: T0, evidence: "hours" }),
      ms({ id: "first-paying-customer", title: "First paying customer", source: "manual.paying_customers", target: 1, tier: 3, state: "unlocked", at: T0 + DAY, evidence: "Marked unlocked by you: Anna paid", manual: true }),
      ms({ id: "10-users", source: "manual.users", target: 10, state: "progress", value: 9, pct: 0.9, evidence: "logged" }),
    ],
  });
  const ps = proofsFromJourney(j);
  const ids = ps.map((p) => p.id);
  test("no XP for commits, sessions or effort milestones", () => {
    expect(ps.some((p) => /commit|session/i.test(p.id) && !p.id.startsWith("merge"))).toBe(false);
    expect(ids.some((i) => i.includes("git.commits") || i.includes("sessions."))).toBe(false);
  });
  test("a tag and a GitHub release of the same version are one ship", () => {
    expect(ids.filter((i) => i.startsWith("rel:"))).toEqual(["rel:abc123def456:1.2"]);
    const r = ps.find((p) => p.id === "rel:abc123def456:1.2")!;
    expect(r.xp).toBe(XP.release); expect(r.type).toBe("ship"); expect(r.tags).toContain("live");
    expect(r.link).toMatchObject({ commit: "abc123def456", github: "me/app" });
  });
  test("a wiki entry that says it shipped is a ship; one that doesn't isn't", () => {
    expect(ids).toContain("ship:l1");
    expect(ids).not.toContain("ship:l2");
    expect(ids).not.toContain("ship:l3"); // a plan isn't a ship
    expect(ids).not.toContain("ship:l4"); // a private rehearsal isn't live for users
    expect(ids).not.toContain("ship:l5"); // starting an agent isn't shipping
    expect(ids).toContain("ship:l6"); // "launched" counts when it says where
    expect(ids).not.toContain("ship:l7");
    expect(ps.find((p) => p.id === "deploy:fff:Dockerfile")).toMatchObject({ xp: XP.deploy, type: "build" }); // config appeared: not a ship
    expect(ps.find((p) => p.id.startsWith("merge:"))!.xp).toBe(XP.merge);
  });
  test("business milestones pay by tier and are keyed by what they measure", () => {
    const m = ps.find((p) => p.kind === "milestone")!;
    expect(m.id).toBe("ms:app:manual.paying_customers:1");
    expect(m.type).toBe("sell"); expect(m.tags).toContain("money");
    expect(m.xp).toBe(XP.milestoneBase + 3 * XP.milestoneTier);
  });
  test("each Gumroad sale is its own proof, with the money it brought", () => {
    const sales = ps.filter((p) => p.kind === "sale");
    expect(sales.map((s) => s.id)).toEqual(["sale:app:1", "sale:app:2", "sale:app:3"]);
    expect(sales[0].title).toBe("First sale!");
    expect(sales[0].amount).toBe(30); expect(sales[1].amount).toBe(30);
    expect(sales[0].xp).toBe(XP.sale + 30);
  });
  test("a logged metric pays only when it went up and has a note", () => {
    const m = ps.filter((p) => p.kind === "metric");
    expect(m.map((x) => x.value)).toEqual([5]); // 4 went down; 9 has no note
    expect(m[0].type).toBe("ship"); expect(m[0].tags).toContain("live"); expect(m[0].evidence).toContain("reddit");
  });
});

// ── the ledger ─────────────────────────────────────────────────────────────────────
describe("ledger: idempotent, double for the main quest, capped side quests", () => {
  const ctx = { now: T0 + 10 * DAY, startedAt: T0 + 5 * DAY, history: [{ project: "main-app", from: T0 + 5 * DAY }], tz: "UTC" };
  const P = (id: string, project: string, t: number, xp = 100, kind: Proof["kind"] = "release"): Proof => ({ id, project, kind, type: "ship", t, title: id, evidence: "ev", xp });
  test("the same evidence never pays twice, whatever order it comes in", () => {
    const a = appendProofs([], [P("x", "main-app", T0 + 6 * DAY), P("y", "main-app", T0 + 6 * DAY)], ctx);
    expect(a.length).toBe(2);
    const b = appendProofs(a, [P("y", "main-app", T0 + 6 * DAY), P("x", "main-app", T0 + 6 * DAY), P("x", "main-app", T0 + 7 * DAY)], ctx);
    expect(b.length).toBe(0);
    expect(appendProofs([], [P("z", "main-app", T0), { ...P("nope", "main-app", T0), evidence: "" }], ctx).map((l) => l.id)).toEqual(["z"]);
  });
  test("a renamed milestone (same source and target) doesn't pay again", () => {
    const j1 = journey("app", { milestones: [ms({ id: "first-sale", source: "gumroad.sales", target: 1, state: "unlocked", at: T0, evidence: "1 sale" })] });
    const j2 = journey("app", { milestones: [ms({ id: "first-customer-ever", title: "First customer ever", source: "gumroad.sales", target: 1, state: "unlocked", at: T0, evidence: "1 sale" })] });
    const a = appendProofs([], proofsFromJourney(j1), ctx);
    expect(appendProofs(a, proofsFromJourney(j2), ctx)).toEqual([]);
  });
  test("main-quest lines count double; lines from before the game pay plainly", () => {
    const ls = appendProofs([], [P("old", "side", T0), P("m", "main-app", T0 + 6 * DAY)], ctx);
    expect(ls.find((l) => l.id === "old")!.main).toBeNull();
    expect(ls.find((l) => l.id === "m")!.main).toBe(true);
    const sc = score(ls, { tz: "UTC" });
    expect(sc.lines.find((l) => l.id === "m")!.eff).toBe(200);
    expect(sc.lines.find((l) => l.id === "old")!.eff).toBe(100);
    expect(sc.total).toBe(300);
  });
  test("side quests share a daily allowance: 30% of the main quest's XP, never under 50", () => {
    const d = T0 + 6 * DAY;
    const noMain = score(appendProofs([], [P("s1", "side", d, 40), P("s2", "side", d + H, 40)], ctx), { tz: "UTC" });
    expect(noMain.lines.map((l) => l.eff)).toEqual([40, 10]);
    expect(noMain.lines[1].capped).toBe(true);
    const withMain = score(appendProofs([], [P("s1", "side", d, 100), P("m1", "main-app", d + H, 250), P("s2", "side", d + 2 * H, 100)], ctx), { tz: "UTC" });
    // main 250×2 = 500 → allowance 150: s1 gets 100, s2 gets 50
    expect(withMain.days.get(dayOf(d, "UTC"))!.allowance).toBe(150);
    expect(withMain.lines.map((l) => [l.id, l.eff])).toEqual([["s1", 100], ["m1", 500], ["s2", 50]]);
    // a new day, a new allowance
    const next = score(appendProofs([], [P("s1", "side", d, 60), P("s3", "side", d + DAY, 60)], ctx), { tz: "UTC" });
    expect(next.lines.map((l) => l.eff)).toEqual([50, 50]);
  });
  test("two worktrees of one repo share its commits: a merge or a tag pays once", () => {
    const ev = [{ id: "m", t: T0, kind: "merge", title: "Merged “audio”", link: { commit: "7d18727d0000aaaa" } }, { id: "t", t: T0, kind: "tag", title: "Tagged v1", link: { commit: "abcdef123456" } }];
    const a = proofsFromJourney(journey("the-signal", { events: ev })), b = proofsFromJourney(journey("sig-audio", { events: ev }));
    expect(b.map((p) => p.id)).toEqual(a.map((p) => p.id));
    const ls = appendProofs([], [...a, ...b], ctx);
    expect(ls.map((l) => [l.id, l.project])).toEqual([["merge:7d18727d0000", "the-signal"], ["rel:abcdef123456:1", "the-signal"]]);
  });
  test("merges count a little, at most three a day per project", () => {
    const ms = [1, 2, 3, 4, 5].map((i) => ({ ...P(`merge:${i}`, "main-app", T0 + 6 * DAY + i * H, XP.merge, "merge"), type: "build" as const }));
    expect(appendProofs([], ms, ctx).length).toBe(3);
  });
  test("checks pay a little, at most three times a day per project", () => {
    const cs = [1, 2, 3, 4].map((i) => ({ ...P(`check:${i}`, "main-app", T0 + 6 * DAY + i * H, XP.check, "check"), type: "build" as const }));
    expect(appendProofs([], cs, ctx).length).toBe(3);
  });
  test("a revoked line stops counting", () => {
    const ls = appendProofs([], [P("a", "main-app", T0 + 6 * DAY)], ctx);
    ls.push({ ...ls[0], id: "revoke:a:1", kind: "revoke", revokes: "a", xp: 0 });
    expect(score(ls).total).toBe(0);
  });
});

// ── streaks ────────────────────────────────────────────────────────────────────────
describe("streaks: days you shipped, sold or talked to users", () => {
  test("consecutive days count; code and bonuses don't; a still-open today keeps it alive", () => {
    const ls = [0, 1, 2].map((i) => line({ id: `s${i}`, t: T0 + i * DAY }));
    ls.push(line({ id: "b", t: T0 + 3 * DAY, type: "build", kind: "merge" }), line({ id: "q", t: T0 + 3 * DAY, type: "bonus", kind: "quest" }));
    const today = dayOf(T0 + 3 * DAY, "UTC");
    const s = streak(ls, today, "UTC");
    expect(s).toMatchObject({ current: 3, today: false, atRisk: true, best: 3 });
    expect(streak([...ls, line({ id: "talk", t: T0 + 3 * DAY, type: "talk", kind: "talk" })], today, "UTC")).toMatchObject({ current: 4, today: true, atRisk: false });
    expect(streak(ls, addDays(today, 1), "UTC").current).toBe(0); // missed a day
  });
  test("a day is your day, in your time zone", () => {
    // 21:30 UTC on Monday is already Tuesday 00:30 in Jerusalem (UTC+3 in September)
    const mon = Date.UTC(2026, 8, 21, 12), lateMon = Date.UTC(2026, 8, 21, 21, 30);
    const ls = [line({ id: "a", t: mon }), line({ id: "b", t: lateMon })];
    expect(streak(ls, "2026-09-22", "Asia/Jerusalem")).toMatchObject({ current: 2, today: true });
    expect(streak(ls, "2026-09-22", "UTC")).toMatchObject({ current: 1, today: false, atRisk: true });
    expect(streak(ls, "2026-09-21", "America/Los_Angeles")).toMatchObject({ current: 1, today: true });
    expect(dayOf(lateMon, "Asia/Jerusalem")).toBe("2026-09-22");
    expect(weekOf("2026-09-27")).toBe("2026-09-21"); // Sunday belongs to the week that began Monday
    expect(weekOf("2026-09-21")).toBe("2026-09-21");
  });
  test("the best run is remembered", () => {
    const ls = [0, 1, 2, 3, 4, 10, 11].map((i) => line({ id: `d${i}`, t: T0 + i * DAY }));
    expect(streak(ls, dayOf(T0 + 11 * DAY, "UTC"), "UTC")).toMatchObject({ current: 2, best: 5 });
  });
});

// ── bosses ───────────────────────────────────────────────────────────────────────────
describe("bosses: health tied to the real number", () => {
  const now = T0 + 20 * DAY;
  test("money and users milestones become bosses; health = what's left to the target; sales are hits", () => {
    const j = journey("shop", {
      metrics: [
        { key: "gumroad.sales", value: 3, series: [[T0, 1], [T0 + 10 * DAY, 3]], evidence: "Gumroad: 3 sales" },
        { key: "gumroad.revenue", value: 90, series: [[T0, 30], [T0 + 10 * DAY, 90]], evidence: "Gumroad revenue" },
      ],
      milestones: [
        ms({ id: "first", title: "First paying customer", source: "manual.paying_customers", target: 1, tier: 2 }),
        ms({ id: "ten", title: "10 paying customers", source: "manual.paying_customers", target: 10, tier: 3 }),
        ms({ id: "mrr", title: "$100 MRR", source: "manual.mrr", target: 100, unit: "$", tier: 4 }),
        ms({ id: "commits", source: "git.commits", target: 100, tier: 0 }),
      ],
    });
    const lines = appendProofs([], proofsFromJourney(j), { now, startedAt: 0, history: [] });
    const bs = bossesFor(j, lines, now);
    expect(bs.map((b) => b.title)).toEqual(["First paying customer", "10 paying customers", "$100 MRR"]);
    expect(bs[0]).toMatchObject({ state: "defeated", hp: 0, value: 3 }); // Gumroad sales stand in for paying customers
    expect(bs[1]).toMatchObject({ state: "alive", value: 3, sigil: "cart" });
    expect(bs[1].hp).toBeCloseTo(0.7);
    expect(bs[1].hits.map((h) => h.id)).toEqual(["sale:shop:3", "sale:shop:2", "sale:shop:1"]);
    // $100 MRR: Gumroad revenue in the last 30 days (90 of 100)
    expect(bs[2].value).toBe(90); expect(bs[2].hp).toBeCloseTo(0.1); expect(bs[2].sigil).toBe("coin");
    expect(bs[2].hits[0].dmg).toBe(30);
  });
  test("a ladder without money milestones gets the standard bosses; logged numbers hit them", () => {
    const j = journey("tool", {
      events: [{ id: "u", t: T0 + DAY, kind: "manual", title: "users = 30", detail: "30 people in the discord" }],
      metrics: [{ key: "manual.users", value: 30, series: [[T0 + DAY, 30]], evidence: "logged" }],
      milestones: [ms({ source: "git.tags", target: 1 })],
    });
    const lines = appendProofs([], proofsFromJourney(j), { now, startedAt: 0, history: [] });
    const bs = bossesFor(j, lines, now);
    expect(bs.every((b) => b.standard)).toBe(true);
    const users = bs.find((b) => b.title === "100 active users")!;
    expect(users.value).toBe(30); expect(users.hp).toBeCloseTo(0.7);
    expect(users.hits[0]).toMatchObject({ dmg: 30 });
    expect(bs.find((b) => b.title === "First paying customer")!.hits).toEqual([]);
  });
  test("revenue in the last 30 days", () => {
    expect(last30([[T0, 100], [T0 + 40 * DAY, 150], [T0 + 50 * DAY, 400]], T0 + 60 * DAY)).toBe(300);
    expect(last30(undefined, T0)).toBe(0);
  });
});

// ── levels ───────────────────────────────────────────────────────────────────────────
describe("founder levels come from business milestones; XP fills the bar", () => {
  const sale = (id: string, t: number, amount: number) => line({ id, t, kind: "sale", type: "sell", amount, tags: ["money"], xp: 150 });
  test("Maker → Shipper → Seller → Founder → Operator", () => {
    const base = [line({ id: "merge", t: T0, kind: "merge", type: "build", xp: 15 })];
    expect(levelOf(score(base).lines).name).toBe("Maker");
    const shipped = [...base, line({ id: "rel", t: T0 + DAY, tags: ["live"] })];
    expect(levelOf(score(shipped).lines).name).toBe("Shipper");
    const sold = [...shipped, sale("s1", T0 + 2 * DAY, 20)];
    expect(levelOf(score(sold).lines).name).toBe("Seller");
    const twoMonths = [...sold, sale("s2", T0 + 20 * DAY, 20)]; // Sep → Oct
    const lv = levelReach(twoMonths);
    expect(lv.founder?.by.id).toBe("s2");
    expect(levelOf(score(twoMonths).lines).name).toBe("Founder");
    const big = [...twoMonths, sale("s3", T0 + 25 * DAY, 600), sale("s4", T0 + 30 * DAY, 500)];
    expect(levelOf(score(big).lines).name).toBe("Operator");
  });
  test("a sale alone also makes you a Shipper; XP can't buy a level", () => {
    const ls = [sale("s", T0, 10), ...Array.from({ length: 40 }, (_, i) => line({ id: `m${i}`, t: T0 + i * H, kind: "merge", type: "build", xp: 1000 }))];
    const lv = levelOf(score(ls).lines);
    expect(lv.name).toBe("Seller"); // not Founder, however much XP
    expect(levelReach(ls).shipper?.by.id).toBe("s");
  });
  test("rank and the bar inside a level", () => {
    const ls = [line({ id: "rel", t: T0, tags: ["live"], xp: 100 }), line({ id: "r2", t: T0 + H, xp: 300 }), line({ id: "r3", t: T0 + 2 * H, xp: 300 })];
    const lv = levelOf(score(ls).lines); // Shipper since T0; 700 XP×2 main = 1400 in level, step 500
    expect(lv).toMatchObject({ name: "Shipper", xpIn: 1400, rank: 3, toNext: 100 });
    expect(lv.pct).toBeCloseTo(0.8);
    expect(lv.next?.name).toBe("Seller");
  });
});

// ── achievements & the season ─────────────────────────────────────────────────────────
describe("achievements and the weekly season", () => {
  const talk = (i: number) => line({ id: `t${i}`, t: T0 + i * DAY, kind: "talk", type: "talk", xp: 80, title: `talk ${i}` });
  test("each achievement has the date it unlocked and its evidence", () => {
    const ls = [line({ id: "rel", t: T0, tags: ["live"], title: "Released v1" }), ...Array.from({ length: 10 }, (_, i) => talk(i + 1)), line({ id: "prune:x", t: T0 + 3 * DAY, kind: "prune", type: "prune", title: "Retired x" })];
    const a = achievements(ls, { bosses: [], quests: [{ at: T0 + 2 * DAY, title: "Post the demo", id: "q" }], tz: "UTC" });
    const by = Object.fromEntries(a.map((x) => [x.id, x]));
    expect(by["first-deploy"]).toMatchObject({ at: T0, evidence: expect.stringContaining("Released v1") });
    expect(by["first-talk"].at).toBe(T0 + DAY);
    expect(by["ten-talks"].at).toBe(T0 + 10 * DAY);
    expect(by["streak-7"].at).toBe(T0 + 6 * DAY); // the release on day 0 is a ship, then talks on days 1..6
    expect(by["zombie"].evidence).toContain("Retired x");
    expect(by["first-quest"]).toMatchObject({ at: T0 + 2 * DAY, evidence: "Post the demo" });
    expect(by["first-dollar"].at).toBeUndefined();
  });
  test("the season scoreboard counts the week's evidence", () => {
    const ls = [line({ id: "rel", t: T0 + DAY }), line({ id: "sale", t: T0 + 2 * DAY, kind: "sale", type: "sell", amount: 29, tags: ["money"] }), talk(3), line({ id: "old", t: T0 - DAY })];
    const sc = score(ls, { tz: "UTC" });
    const sb = seasonFor("2026-09-21", sc.lines, { tz: "UTC", bosses: [], quests: [{ at: T0 + DAY }], streak: 3 });
    expect(sb).toMatchObject({ sold: 1, revenue: 29, talks: 1, quests: 1, streak: 3 });
    expect(sb.shipped.map((s) => s.title)).toEqual(["rel"]);
    expect(sb.xp).toBe((100 + 100 + 80) * 2);
    expect(scoreLines(sb)[0]).toContain("Shipped 1");
  });
});

