import { beforeEach, describe, expect, test } from "bun:test";
import { _resetJudge, buildDecision, mayAsk } from "../src/decisions";

// A pending question must not blink: it stays until it's answered, a newer message replaces it, or it goes stale.
process.env.DECK_NO_JEV = "1";
const ask = { i: 7, role: "assistant", at: 5000, text: "Which cache should I use?\n\n(a) Redis\n(b) SQLite\n\nWhich do you prefer?" };
const chatOf = (...messages: any[]) => async () => ({ messages });
const chat = chatOf({ i: 6, role: "user", at: 4000, text: "Add a cache" }, ask);
const row = (over: any = {}) => ({ key: "h/p", project: "demo", status: "done", seen: false, stale: false, lastActiveAt: 5000, tail: ["❯ "], ...over }) as any;

beforeEach(() => _resetJudge());

describe("a question stays until it's answered", () => {
  test("opening the session (seen) keeps the question", async () => {
    const before = (await buildDecision(row(), chat))!;
    expect(before.kind).toBe("question");
    const seen = row({ seen: true, lastActiveAt: 5001 });
    expect(mayAsk(seen, before)).toBe(true);
    const after = await buildDecision(seen, chat, undefined, before);
    expect(after?.kind).toBe("question");
    expect(after?.id).toBe(before.id);
  });

  test("a plain finished session still settles once seen", async () => {
    const done = chatOf({ i: 1, role: "assistant", at: 10, text: "All done, tests pass." });
    expect((await buildDecision(row(), done))?.kind).toBe("review");
    const seen = row({ seen: true, lastActiveAt: 5001 });
    expect(await buildDecision(seen, done)).toBeUndefined();
  });

  test("herdr moving the pane to idle keeps the question on screen, and only that one", async () => {
    const d = (await buildDecision(row(), chat))!;
    const idle = row({ status: "idle", seen: true, lastActiveAt: 5002 });
    expect(mayAsk(idle, d)).toBe(true);
    expect((await buildDecision(idle, chat, undefined, d))?.id).toBe(d.id);
    // An idle session nobody saw ask anything doesn't grow a card.
    _resetJudge();
    expect(mayAsk(idle, undefined)).toBe(false);
    expect(await buildDecision(idle, chat)).toBeUndefined();
  });

  test("an answer after the question settles it, wherever it was typed", async () => {
    const d = (await buildDecision(row(), chat))!;
    const answered = chatOf({ i: 6, role: "user", text: "Add a cache" }, ask, { i: 8, role: "user", at: 6000, text: "(b) SQLite" });
    const r = row({ seen: true, lastActiveAt: 6000 });
    expect(await buildDecision(r, answered, undefined, d)).toBeUndefined();
  });

  test("a newer agent message replaces it", async () => {
    const d = (await buildDecision(row(), chat))!;
    const next = chatOf(ask, { i: 8, role: "user", at: 6000, text: "(a) Redis" }, { i: 9, role: "assistant", at: 7000, text: "Done. Should I also add a TTL?" });
    const d2 = (await buildDecision(row({ lastActiveAt: 7000 }), next, undefined, d))!;
    expect(d2.kind).toBe("question");
    expect(d2.id).not.toBe(d.id);
    expect(d2.question).toBe("Done. Should I also add a TTL?");
  });

  test("its id and time are the message's, not the row's: later writes don't make it a new question", async () => {
    const d = (await buildDecision(row(), chat))!;
    const later = (await buildDecision(row({ lastActiveAt: 9999, tail: ["❯ x"] }), chat, undefined, d))!;
    expect(later.id).toBe(d.id);
    expect(later.at).toBe(5000);
  });

  test("a stale session's question goes away", () => {
    expect(mayAsk(row({ seen: true, stale: true }), undefined)).toBe(false);
  });
});

describe("a failed read never turns a question into something else", () => {
  test("the conversation can't be read: the question on screen stays", async () => {
    const d = (await buildDecision(row(), chat))!;
    const fail = async () => { throw new Error("remote timed out"); };
    const r = row({ lastActiveAt: 5003, lastMessage: "Which cache should I…" });
    const kept = await buildDecision(r, fail, undefined, d);
    expect(kept).toBe(d);
    // And it isn't remembered: the next rebuild of the same row reads again.
    expect((await buildDecision(r, chat, undefined, d))?.kind).toBe("question");
  });

  test("a guess from the row's clipped last message isn't cached over the real read", async () => {
    const fail = async () => undefined;
    const r = row({ lastMessage: "Which cache should I use? (a) Redis (b) SQ…" });
    await buildDecision(r, fail);
    const real = await buildDecision(r, chat);
    expect(real?.kind).toBe("question");
    expect(real?.options.map((o) => o.id)).toEqual(["a", "b"]);
  });

  test("a terminal prompt keeps its time across redraws", async () => {
    const screen = async () => ["Do you want to run ls?", "❯ 1. Yes", "  2. No"];
    const p = (await buildDecision(row({ status: "blocked", lastActiveAt: 100 }), chat, screen))!;
    const p2 = (await buildDecision(row({ status: "blocked", lastActiveAt: 200, tail: ["spinner"] }), chat, screen, p))!;
    expect(p2.id).toBe(p.id);
    expect(p2.at).toBe(100);
  });
});
