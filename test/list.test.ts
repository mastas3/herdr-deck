import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The list helpers live in the browser script (no build step); evaluate just their marked block.
const src = readFileSync(new URL("../public/js/list-rows.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("/* @pure:list-begin"), src.indexOf("/* @pure:list-end */"));
const L = new Function(`${block}; return { span, reasonLabel, reasonOf, stableSig, frozenOrder };`)();

const NOW = 1_800_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const row = (o: any = {}) => ({ key: "k", status: "idle", empty: false, stale: false, tail: [], rssKB: 0, cpu: 0, procs: 0, ...o });

describe("reason chip", () => {
  test("a pending decision wins: permission, then question", () => {
    expect(L.reasonOf(row({ status: "blocked" }), "prompt", NOW).text).toBe("needs permission");
    expect(L.reasonOf(row({ status: "done" }), "question", NOW).text).toBe("asks you");
    expect(L.reasonOf(row({ status: "blocked" }), undefined, NOW).text).toBe("needs you");
  });
  test("unseen finished says how long ago; seen finished is just idle", () => {
    expect(L.reasonOf(row({ status: "done", lastActiveAt: NOW - 2 * MIN }), undefined, NOW)).toEqual({ k: "done", t: NOW - 2 * MIN, text: "finished 2m ago" });
    expect(L.reasonOf(row({ status: "done", lastActiveAt: NOW - 10_000 }), undefined, NOW).text).toBe("just finished");
    expect(L.reasonOf(row({ status: "done", seen: true, lastActiveAt: NOW - 3 * HOUR }), undefined, NOW).text).toBe("idle 3h");
  });
  test("working counts from the turn start, and ignores a turn start older than 12h", () => {
    expect(L.reasonOf(row({ status: "working", turnStartedAt: NOW - 3 * MIN }), undefined, NOW).text).toBe("working 3m");
    expect(L.reasonOf(row({ status: "working" }), undefined, NOW).text).toBe("working");
    expect(L.reasonOf(row({ status: "working", turnStartedAt: NOW - 13 * HOUR }), undefined, NOW).text).toBe("working");
  });
  test("empty is new for 15 minutes, then empty", () => {
    expect(L.reasonOf(row({ status: "empty", empty: true, bornAt: NOW - 5 * MIN }), undefined, NOW).text).toBe("new");
    expect(L.reasonOf(row({ status: "empty", empty: true, bornAt: NOW - 20 * MIN }), undefined, NOW).text).toBe("empty");
    expect(L.reasonOf(row({ status: "empty", empty: true }), undefined, NOW).text).toBe("empty");
  });
  test("stale and idle carry their age", () => {
    expect(L.reasonOf(row({ stale: true, lastActiveAt: NOW - 5 * DAY }), undefined, NOW).text).toBe("stale 5d");
    expect(L.reasonOf(row({ lastActiveAt: NOW - 3 * DAY }), undefined, NOW).text).toBe("idle 3d");
    expect(L.reasonOf(row({}), undefined, NOW).text).toBe("idle");
  });
  test("the ticker relabels by kind and time", () => {
    expect(L.reasonLabel("work", NOW - 61 * MIN, NOW)).toBe("working 1h");
    expect(L.reasonLabel("done", NOW - 90 * DAY, NOW)).toBe("finished 3mo ago");
    expect(L.span(44_000)).toBe("");
    expect(L.span(46_000)).toBe("1m");
  });
});

describe("row throttle signature", () => {
  test("live fields don't change it; status and title do", () => {
    const a = row({ status: "working", now: "Bash: ls", tail: ["a"], todos: { done: 1, total: 3 }, rssKB: 10, lastActiveAt: 1 });
    const b = { ...a, now: "Read: x.ts", tail: ["b"], todos: { done: 2, total: 3 }, rssKB: 99, lastActiveAt: 2 };
    expect(L.stableSig(b)).toBe(L.stableSig(a));
    expect(L.stableSig({ ...a, status: "done" })).not.toBe(L.stableSig(a));
    expect(L.stableSig({ ...a, title: "renamed" })).not.toBe(L.stableSig(a));
  });
  test("a subagent starting or stopping is not throttled", () => {
    const a = row({ status: "working", subagents: [{ id: "1", running: true, description: "x", tools: 0 }] });
    expect(L.stableSig({ ...a, subagents: [{ id: "1", running: true, description: "x", now: "Bash", tools: 3 }] })).toBe(L.stableSig(a));
    expect(L.stableSig({ ...a, subagents: [] })).not.toBe(L.stableSig(a));
  });
});

describe("frozen order", () => {
  test("keeps shown rows in place, drops gone ones, holds new ones back", () => {
    expect(L.frozenOrder(["a", "b", "c", "d"], ["d", "new", "b", "a"])).toEqual({ keys: ["a", "b", "d"], held: ["new"] });
  });
});

describe("simple mode row", () => {
  // Rows re-render only when something shown changes (no longer every few seconds), so a time label must tick by itself.
  const fn = src.slice(src.indexOf("function simpleRow"), src.indexOf("/** The reason chip"));
  const simpleRow = new Function("SIMPLE_STATUS", "statusVar", "esc", "ago", "pc", "radarChip", "srcLine", "rowAsk", `${fn}; return simpleRow;`)(
    { idle: ["idle", ""], working: ["working", "…"] }, () => "", String, () => "3m", () => "", () => "", () => "", () => "");
  test("its time since last activity is a live label; a working row's isn't a time", () => {
    expect(simpleRow(row({ lastActiveAt: NOW }))).toContain(`<span class="ago" data-t="${NOW}">3m</span>`);
    expect(simpleRow(row({ status: "working", lastActiveAt: NOW }))).not.toContain("data-t");
  });
});
