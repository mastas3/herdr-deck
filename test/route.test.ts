import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _configure, _setRunner, setJevFeature } from "../src/jev";
import { ROUTE_INSTRUCTIONS, routeCandidates, routeMessage, routePicks, routeRequest } from "../src/route";

// No Jev calls here: the ask is always a stand-in, and the switch lives in a scratch dir.
const dir = mkdtempSync(join(tmpdir(), "deck-route-test-"));
let prevRunner: any;
let runnerCalls = 0;
beforeAll(() => {
  process.env.TYPESAFE_API_KEY = "test-not-a-key";
  delete process.env.DECK_NO_JEV;
  _configure({ dir, bin: join(dir, "fake-jev") });
  prevRunner = _setRunner(async () => { runnerCalls++; return { fallback: "unavailable" }; });
});
afterAll(() => { _setRunner(prevRunner); rmSync(dir, { recursive: true, force: true }); });

const row = (key: string, over: any = {}) => ({ key, agent: "claude", status: "idle", project: "demo", title: `task ${key}`, lastActiveAt: 1000, empty: false, ...over }) as any;

describe("routeCandidates", () => {
  test("only live coding-agent sessions, newest activity first", () => {
    const rows = [
      row("a", { lastActiveAt: 10 }),
      row("shell", { agent: "shell", lastActiveAt: 99 }),
      row("vim", { agent: "vim", lastActiveAt: 98 }),
      row("empty", { status: "empty", lastActiveAt: 97 }),
      row("blank", { empty: true, lastActiveAt: 96 }),
      row("app", { agent: "codex", app: "codex", lastActiveAt: 95 }),
      row("past", { status: "history", hist: "/x.jsonl", lastActiveAt: 94 }),
      row("b", { agent: "codex", status: "working", lastActiveAt: 30 }),
      row("c", { agent: "opencode", status: "blocked", lastActiveAt: 20 }),
      row("d", { status: "done", lastActiveAt: undefined }),
    ];
    const c = routeCandidates(rows);
    expect(c.map((x) => x.key)).toEqual(["b", "c", "a", "d"]);
    expect(c.map((x) => x.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  test("at most 60, ids valid for a Jev choice", () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(`k${i}`, { lastActiveAt: i }));
    const c = routeCandidates(rows);
    expect(c.length).toBe(60);
    expect(c[0].key).toBe("k79");
    expect(c[59].key).toBe("k20");
    for (const x of c) expect(x.id).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(new Set(c.map((x) => x.id)).size).toBe(60);
  });

  test("descriptions: project, title, what it's doing, status; scrubbed and clipped", () => {
    const [n, s, p] = routeCandidates([
      row("n", { project: "herdr-deck", title: "fix SSE", now: "Bash: bun test", step: "ignored", status: "working", lastActiveAt: 3 }),
      row("s", { project: "api", title: "deploy", step: "Write the migration", lastActiveAt: 2 }),
      row("p", { project: "site", title: "mail rpsm90@example.com about /Users/stas-2/secret sk-abcdefghijklmnopqrstuvwx", lastActiveAt: 1 }),
    ]);
    expect(n.description).toBe("herdr-deck · fix SSE · now: Bash: bun test · working");
    expect(s.description).toBe("api · deploy · step: Write the migration · idle");
    expect(p.description).not.toContain("@example.com");
    expect(p.description).not.toContain("/Users/stas-2");
    expect(p.description).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(p.description).toContain("<email>");
    const long = routeCandidates([row("l", { title: "x".repeat(20) + " word".repeat(100) })])[0];
    expect(long.description.length).toBeLessThanOrEqual(241);
  });

  test("the request carries ids and descriptions, never keys", () => {
    const c = routeCandidates([row("host|pane-secret-key", { title: "fix SSE", lastActiveAt: 2 }), row("other-key", { title: "docs", lastActiveAt: 1 })]);
    const req = routeRequest("  fix the SSE reconnect for alice@example.com ", c);
    expect(req.kind).toBe("deck-route");
    expect(req.state).toEqual({ message: "  fix the SSE reconnect for <email> " });
    expect(req.questions.to.type).toBe("choice");
    expect(req.questions.to.instructions).toBe(ROUTE_INSTRUCTIONS);
    expect(Object.keys(req.questions.to.criteria)).toEqual(["s1", "s2"]);
    expect(JSON.stringify({ state: req.state, questions: req.questions })).not.toContain("secret-key");
  });
});

describe("routePicks", () => {
  const cands = routeCandidates(["a", "b", "c", "d", "e"].map((k, i) => row(k, { lastActiveAt: 10 - i })));
  test("top 3 by probability, ids mapped back to keys", () => {
    const r = routePicks({ answers: { to: { choice: "s4", probabilities: { s1: 0.05, s2: 0.1, s3: 0.2, s4: 0.6, s5: 0.05 }, confidence: 0.7 } } }, cands);
    expect(r.picks).toEqual([{ key: "d", p: 0.6 }, { key: "c", p: 0.2 }, { key: "b", p: 0.1 }]);
    expect(r.confidence).toBe(0.7);
  });
  test("unknown ids dropped, numbers clamped, ties keep newest first", () => {
    const r = routePicks({ answers: { to: { choice: "s9", probabilities: { s9: 0.9, s3: 0.3, s1: 0.3, s2: 1.4, s5: "x" as any } } } } as any, cands);
    expect(r.picks).toEqual([{ key: "b", p: 1 }, { key: "a", p: 0.3 }, { key: "c", p: 0.3 }]);
    expect(r.confidence).toBeNull();
  });
  test("a choice without probabilities, or no answer at all", () => {
    expect(routePicks({ answers: { to: { choice: "s2", confidence: 0.8 } as any } }, cands).picks).toEqual([{ key: "b", p: 0.8 }]);
    expect(routePicks({ answers: {} }, cands)).toEqual({ picks: [], confidence: null });
  });
});

describe("routeMessage", () => {
  const rows = [row("a", { lastActiveAt: 2 }), row("b", { lastActiveAt: 1 })];
  const on = { feature: () => true, available: () => true };
  test("rejects empty and over-long text", async () => {
    expect((await routeMessage("   ", rows, on)).status).toBe(400);
    expect((await routeMessage(undefined, rows, on)).status).toBe(400);
    expect((await routeMessage("x".repeat(1001), rows, on)).status).toBe(400);
  });
  test("refuses when the switch is off or Jev isn't set up, without asking", async () => {
    let asked = 0;
    const ask = async () => { asked++; return { answers: {} }; };
    setJevFeature("route", false);
    const off = await routeMessage("send this to the api session", rows, { ask, available: () => true });
    expect(off.status).toBe(409);
    expect(off.body.error).toMatch(/switched off/);
    setJevFeature("route", true);
    const none = await routeMessage("send this to the api session", rows, { ask, available: () => false });
    expect(none.status).toBe(409);
    expect(asked).toBe(0);
    expect(runnerCalls).toBe(0);
  });
  test("one ask, picks and latency back; nothing to choose between means no ask", async () => {
    const seen: any[] = [];
    const ask = async (state: unknown, questions: any, kind: string) => {
      seen.push({ state, questions, kind });
      return { id: "d1", ms: 420, answers: { to: { choice: "s2", probabilities: { s1: 0.13, s2: 0.87 }, confidence: 0.8 } } };
    };
    const r = await routeMessage("  fix the reconnect  ", rows, { ...on, ask });
    expect(r).toEqual({ status: 200, body: { picks: [{ key: "b", p: 0.87 }, { key: "a", p: 0.13 }], confidence: 0.8, ms: 420 } });
    expect(seen.length).toBe(1);
    expect(seen[0].kind).toBe("deck-route");
    expect(seen[0].state).toEqual({ message: "fix the reconnect" });
    const one = await routeMessage("fix it", [rows[0]], { ...on, ask });
    expect(one.body).toEqual({ picks: [], confidence: null, fallback: "one_session" });
    expect(seen.length).toBe(1);
  });
  test("a cached answer shows no latency; a fallback leaves the choice to you", async () => {
    const cached = await routeMessage("fix it", rows, { ...on, ask: async () => ({ id: "d1", cached: true, fallback: null, answers: { to: { choice: "s1", probabilities: { s1: 0.9, s2: 0.1 } } } }) });
    expect(cached.body.ms).toBeUndefined();
    expect(cached.body.picks[0]).toEqual({ key: "a", p: 0.9 });
    const late = await routeMessage("fix it", rows, { ...on, ask: async () => ({ fallback: "timeout" }) });
    expect(late).toEqual({ status: 200, body: { picks: [], confidence: null, fallback: "timeout" } });
  });
});
