import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _configure, _setRunner, cachedById, fingerprint, jevAskOnce, jevUsage, setJevCap } from "../src/jev";
import { _resetJudge, buildDecision, choiceFromInput, judge, recordOutcome, type Decision } from "../src/decisions";
import { Receipts, statsFor, summarize } from "../src/jevstats";

// Everything here runs against a scratch dir and a fake CLI: no real Jev calls, no writes to ~/.jev or
// ~/.config/herdr-deck.
const dir = mkdtempSync(join(tmpdir(), "deck-jev-test-"));
const calls: string[][] = [];
let asks = 0;
let prevRunner: any;
beforeAll(() => {
  process.env.TYPESAFE_API_KEY = "test-not-a-key";
  delete process.env.DECK_NO_JEV;
  _configure({ dir, bin: join(dir, "fake-jev") });
  prevRunner = _setRunner(async (args, stdin) => {
    calls.push(args);
    if (args[0] !== "ask") return {};
    asks++;
    const req = JSON.parse(stdin!);
    await Bun.sleep(40); // the call is out for a while: concurrent askers must wait for it, not start another
    const answers = req.kind === "deck-done"
      ? { done: { type: "noul", noul: 0.82 }, next: { type: "choice", choice: "accept", probabilities: { accept: 0.8, send_back: 0.1, ask: 0.1 } } }
      : { pick: { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.7, c: 0.1 } }, low: { type: "noul", noul: 0.9 } };
    return { decision_id: `d-${asks}`, answers, fallback: null };
  });
});
afterAll(() => { _setRunner(prevRunner); rmSync(dir, { recursive: true, force: true }); });

const msgs = [
  { role: "user", text: "Pick a database for the cache" },
  { role: "assistant", text: "Which one should I use?\n\n(a) Postgres\n(b) SQLite\n(c) Redis\n\nWhich do you prefer?" },
] as any[];
const chat = async () => ({ messages: msgs });
const row = (over: any = {}) => ({ key: "h/p1", project: "demo", status: "done", seen: false, lastActiveAt: 1000, tail: ["❯ "], firstPrompt: "Pick a database", ...over }) as any;

describe("dedupe: one Jev call per request", () => {
  test("concurrent judges on the same request, with rows that keep moving → exactly one call", async () => {
    _resetJudge();
    asks = 0;
    const r0 = row();
    const d = (await buildDecision(r0, chat))!;
    expect(d.kind).toBe("question");
    // Five rebuilds racing, each seeing a slightly different row (a redraw, a later transcript write).
    const rows = [0, 1, 2, 3, 4].map((i) => row({ lastActiveAt: 1000 + i, tail: [`❯ ${"·".repeat(i)}`] }));
    let changed = 0;
    await Promise.all(rows.map((r) => judge(d, r, chat, () => changed++)));
    expect(asks).toBe(1);
    // And after the answer is in, another move of the row still doesn't ask again.
    await judge(d, row({ lastActiveAt: 2000, tail: ["❯ later"] }), chat, () => {});
    expect(asks).toBe(1);
    const d2 = (await buildDecision(row({ lastActiveAt: 2000, tail: ["❯ later"] }), chat))!;
    expect(d2.jev?.state).toBe("done");
    expect(d2.jev?.pick).toBe("b");
  });

  test("a restarted deck finds the answer on disk instead of asking", async () => {
    const q = { pick: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } } };
    const first = await jevAskOnce({ s: 1 }, q, "deck-choice", { label: "demo: restart" });
    expect(first.cached).toBeUndefined();
    const n = asks;
    expect(JSON.parse(readFileSync(join(dir, "jev-cache.json"), "utf8"))[fingerprint("deck-choice", { s: 1 }, q)].id).toBe(first.id);
    _configure({ dir }); // what a restart does: in-memory state gone, reread from the dir
    const again = await jevAskOnce({ s: 1 }, q, "deck-choice");
    expect(again).toMatchObject({ id: first.id, cached: true });
    expect(asks).toBe(n);
    expect(cachedById().get(first.id!)?.label).toBe("demo: restart");
  });

  test("concurrent asks of one request share the call in flight", async () => {
    const n = asks;
    const q = { pick: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } } };
    const rs = await Promise.all([1, 2, 3, 4].map(() => jevAskOnce({ s: "together" }, q, "deck-choice")));
    expect(asks).toBe(n + 1);
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
  });

  test("a genuinely different request is asked", async () => {
    const n = asks;
    await jevAskOnce({ s: 2 }, { pick: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } } }, "deck-choice");
    expect(asks).toBe(n + 1);
  });
});

describe("outcomes", () => {
  test("an inbox pick records once, followed when it matches Jev's pick", async () => {
    _resetJudge();
    calls.length = 0;
    const r = row({ key: "h/p2", lastActiveAt: 5000 });
    const d = (await buildDecision(r, chat))!;
    await judge(d, r, chat, () => {});
    const res = recordOutcome(r.key, "answer", "b", d);
    expect(res?.followed).toBe(true);
    await Bun.sleep(5);
    const out = calls.filter((c) => c[0] === "outcome");
    expect(out.length).toBe(1);
    expect(out[0]).toContain("--followed");
    expect(out[0][out[0].indexOf("--followed") + 1]).toBe("true");
    expect(out[0][out[0].indexOf("--note") + 1]).toBe("answer:b");
    expect(recordOutcome(r.key, "answer", "b", d)).toBeUndefined(); // one outcome per decision
  });

  test("the answer still counts while a newer ask for the same decision is out", async () => {
    _resetJudge();
    const r = row({ key: "h/p3", lastActiveAt: 7000, firstPrompt: "other" });
    const d = (await buildDecision(r, async () => ({ messages: [{ role: "user", text: "p3" }, msgs[1]] as any })))!;
    await judge(d, r, async () => ({ messages: [{ role: "user", text: "p3" }, msgs[1]] as any }), () => {});
    // The row moves and its request changes (a new tool call shows up): a new ask goes out.
    const moved = row({ key: "h/p3", lastActiveAt: 7001 });
    const p = judge(d, moved, async () => ({ messages: [{ role: "user", text: "p3" }, { role: "tool", tool: "Bash", summary: "ls" }, msgs[1]] as any }), () => {});
    await Bun.sleep(5);
    expect(recordOutcome(r.key, "answer", "a", d)?.followed).toBe(false);
    await p;
  });

  test("replies and keys are read as answers", () => {
    const q: Decision = { key: "k", kind: "question", at: 0, question: "Which?", options: [{ id: "a", title: "Postgres", send: "(a) Postgres" }, { id: "b", title: "SQLite", send: "(b) SQLite" }] };
    expect(choiceFromInput(q, { text: "(b) SQLite" })).toBe("b");
    expect(choiceFromInput(q, { text: "b) go with sqlite" })).toBe("b");
    expect(choiceFromInput(q, { text: "Option A please" })).toBe("a");
    expect(choiceFromInput(q, { text: "a quick thought first: what about duckdb?" })).toBe("other");
    const yn: Decision = { key: "k", kind: "question", at: 0, question: "Deploy?", options: [{ id: "yes", title: "Yes, go ahead" }, { id: "no", title: "No, not now" }, { id: "more", title: "Tell me more first" }] };
    expect(choiceFromInput(yn, { text: "yes, and run the tests after" })).toBe("yes");
    expect(choiceFromInput(yn, { text: "No." })).toBe("no");
    const pr: Decision = { key: "k", kind: "prompt", at: 0, question: "Run it?", options: [{ id: "1", title: "Yes", keys: ["1"] }, { id: "2", title: "No, exit", keys: ["down", "enter"] }] };
    expect(choiceFromInput(pr, { keys: ["down", "enter"] })).toBe("2");
    expect(choiceFromInput(pr, { keys: ["esc"] })).toBe("esc");
    expect(choiceFromInput(pr, { keys: ["up"] })).toBeUndefined();
    expect(choiceFromInput({ ...q, kind: "review", options: [] }, { text: "looks good" })).toBeUndefined();
  });
});

describe("daily cap", () => {
  test("persists to the state dir and is enforced", async () => {
    setJevCap(1);
    expect(JSON.parse(readFileSync(join(dir, "jev-settings.json"), "utf8")).daily).toBe(1);
    expect(jevUsage()).toMatchObject({ cap: 1, capSource: "settings" });
    const n = asks;
    const r = await jevAskOnce({ capped: true }, { pick: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } } }, "deck-choice");
    expect(r.fallback).toBe("deck_daily_cap");
    expect(asks).toBe(n);
    expect(() => setJevCap(-3)).toThrow();
    setJevCap(1000);
  });
});

// ── aggregation over a fake receipts log ─────────────────────────────────────
const NOW = Date.parse("2026-09-26T12:00:00");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const dec = (id: string, hoursAgo: number, kind: string, sfp: string, answers: any, inTok = 1000, extra: any = {}) =>
  ({ schema: "jev-receipt-v1", event: "decision", type: "ask", decision_id: id, ts: iso(hoursAgo), agent: "herdr-deck", kind, calls_used: 1, state_fingerprint: sfp, questions_fingerprint: `q-${kind}`, usage: { input_tokens: inTok, output_tokens: 50 }, answers, fallback: null, ...extra });
const out = (id: string, hoursAgo: number, followed: boolean, note: string) => ({ schema: "jev-receipt-v1", event: "outcome", decision_id: id, ts: iso(hoursAgo), result: followed ? "success" : "failure", followed, note });
const pick = (c: string, p: number) => ({ pick: { type: "choice", choice: c, probabilities: { [c]: p } }, low: { type: "noul", noul: 0.8 } });
const done = (p: number, next = "send_back") => ({ done: { type: "noul", noul: p }, next: { type: "choice", choice: next } });

describe("stats from receipts", () => {
  const file = join(dir, "receipts.jsonl");
  const rows = [
    // 10 days ago: outside the week
    dec("old1", 240, "deck-choice", "s0", pick("a", 0.9), 2000),
    out("old1", 239, true, "answer:a"),
    // this week, not today (30 hours ago)
    dec("w1", 30, "deck-prompt", "s1", pick("1", 0.8), 500),
    out("w1", 29.9, false, "answer:2"),
    // today
    dec("t1", 3, "deck-choice", "s2", pick("b", 0.55), 1000),
    dec("t1dup", 2.999, "deck-choice", "s2", pick("b", 0.56), 1000), // same request again: a repeat
    out("t1dup", 2.9, true, "answer:b"),
    dec("t2", 2, "deck-done", "s3", done(0.8, "accept"), 1500),
    out("t2", 1.9, true, "accept"),
    dec("t3", 1.5, "deck-done", "s4", done(0.3), 1500),
    out("t3", 1.4, false, "accept"), // said 30% done; you accepted anyway
    dec("t4", 1, "deck-done", "s5", done(0.75, "accept"), 1500),
    out("t4", 0.9, false, "sendback"),
    dec("t5", 0.5, "deck-prompt", "s6", pick("enter", 0.2), 400), // no outcome yet
    // other agents and noise
    { schema: "jev-receipt-v1", event: "decision", type: "ask", decision_id: "cx1", ts: iso(1), agent: "codex", kind: "hd-pilot", calls_used: 1, usage: { input_tokens: 10000, output_tokens: 10 }, answers: {} },
    { schema: "jev-receipt-v1", event: "decision", type: "ask", decision_id: "cap1", ts: iso(0.2), agent: "herdr-deck", kind: "deck-choice", calls_used: 0, state_fingerprint: "s7", fallback: "budget_exhausted" },
    dec("self", 0.1, "deck-selftest", "s8", pick("a", 1), 300),
  ];

  test("exact numbers", () => {
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
    const rc = new Receipts(file);
    rc.refresh();
    const s = summarize(rc, { now: NOW, cap: 1000, used: 6, labels: new Map([["t1dup", { id: "t1dup", answers: {}, kind: "deck-choice", at: 0, label: "demo: Which db?", opts: { a: "Postgres", b: "SQLite" } }]]) });
    // today: t1, t1dup, t2, t3, t4, t5 (+ the capped one with 0 calls); the self-test isn't a deck decision kind
    expect(s.today).toEqual({ calls: 6, inputTokens: 6900, outputTokens: 300, cost: 0.00029, repeats: 1 });
    expect(s.week.calls).toBe(7);
    expect(s.week.inputTokens).toBe(7400);
    expect(s.total).toEqual({ calls: 8, inputTokens: 9400, outputTokens: 400, cost: 0.000395, repeats: 1 });
    expect(s.allAgentsToday.calls).toBe(8); // 6 deck + codex + self-test
    expect(s.allAgentsToday.inputTokens).toBe(6900 + 10000 + 300);
    expect(s.hit.question).toEqual({ n: 2, hits: 2, rate: 1 });
    expect(s.hit.prompt).toEqual({ n: 1, hits: 0, rate: 0 });
    expect(s.hit.done).toEqual({ n: 3, hits: 1, rate: 0.333 });
    expect(s.hit.all).toEqual({ n: 6, hits: 3, rate: 0.5 });
    // "done" calibration: ≥70% → t2 accepted, t4 sent back; <40% → t3 accepted
    expect(s.calibration.done).toEqual([
      { band: "≥70%", n: 2, accepted: 1, rate: 0.5 },
      { band: "40–69%", n: 0, accepted: 0, rate: null },
      { band: "<40%", n: 1, accepted: 1, rate: 1 },
    ]);
    expect(s.calibration.pick).toEqual([
      { band: "≥70%", n: 2, hits: 1, rate: 0.5 },
      { band: "40–69%", n: 1, hits: 1, rate: 1 },
      { band: "<40%", n: 0, hits: 0, rate: null },
    ]);
    expect(s.asked).toBe(7); // distinct requests (the repeat folded in, the capped one left out)
    expect(s.answered).toBe(6);
    expect(s.recent.length).toBe(7);
    expect(s.recent[0]).toMatchObject({ kind: "prompt", suggestion: "ENTER (20%)", actual: null, followed: null });
    const q = s.recent.find((x) => x.label)!;
    expect(q).toMatchObject({ label: "demo: Which db?", suggestion: "B (56%)", pickTitle: "SQLite", actual: "B", actualTitle: "SQLite", followed: true, repeats: 1 });
    expect(s.recent.find((x) => x.suggestion.startsWith("30%"))).toMatchObject({ actual: "accepted", followed: false });
    expect(s.cap).toMatchObject({ cap: 1000, used: 6 });
  });

  test("reads only what's appended, and starts over when the log is replaced", () => {
    writeFileSync(file, rows.slice(0, 2).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const a = statsFor(file, { now: NOW, cap: 10, used: 0 });
    expect(a.total.calls).toBe(1);
    expect(statsFor(file, { now: NOW, cap: 10, used: 0 })).toBe(a); // unchanged file → the same summary object
    // A line written in two pieces (the CLI mid-append) is only counted once it's whole.
    const line = JSON.stringify(rows[2]);
    appendFileSync(file, line.slice(0, 20));
    expect(statsFor(file, { now: NOW, cap: 10, used: 0 }).total.calls).toBe(1);
    appendFileSync(file, line.slice(20) + "\n");
    expect(statsFor(file, { now: NOW, cap: 10, used: 0 }).total.calls).toBe(2);
    writeFileSync(file, JSON.stringify(rows[4]) + "\n");
    expect(statsFor(file, { now: NOW, cap: 10, used: 0 }).total.calls).toBe(1);
  });

  test("a missing log is just empty", () => {
    const s = statsFor(join(dir, "nope.jsonl"), { now: NOW, cap: 5, used: 0 });
    expect(s.total.calls).toBe(0);
    expect(s.recent).toEqual([]);
    expect(existsSync(join(dir, "nope.jsonl"))).toBe(false);
  });
});
