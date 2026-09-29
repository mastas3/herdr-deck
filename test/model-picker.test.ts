import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// model-search.js is pure (no DOM), so run the whole file.
const src = readFileSync(new URL("../public/js/model-search.js", import.meta.url), "utf8");
const { MODEL_MAX_ROWS, modelSearch, modelMarks, modelRecent, modelFind, modelCtx, modelPrice, modelBadges } = new Function(`${src}; return { MODEL_MAX_ROWS, modelSearch, modelMarks, modelRecent, modelFind, modelCtx, modelPrice, modelBadges };`)();
const ids = (r: any) => r.rows.map((m: any) => m.v);

describe("searching models", () => {
  const list = [
    { v: "x/foo-claude", l: "Foo Claude" },
    { v: "x/claude-1", l: "Claude One" },
    { v: "x/anthropic/claude-2" },
    { v: "x/reclaude" },
    { v: "x/gpt-4" },
    { v: "x/gpt-4.1", l: "GPT 4.1" },
  ];
  test("an empty query keeps the order and reports the total", () => {
    const r = modelSearch(list, "  ");
    expect(ids(r)).toEqual(list.map((m) => m.v));
    expect(r.total).toBe(6);
  });
  test("ranks a name prefix, then a word start, then anything else; ties keep the original order", () => {
    expect(ids(modelSearch(list, "claude"))).toEqual(["x/claude-1", "x/foo-claude", "x/anthropic/claude-2", "x/reclaude"]);
  });
  test("every word must match, in any order", () => {
    expect(ids(modelSearch(list, "one claude"))).toEqual(["x/claude-1"]);
    expect(ids(modelSearch(list, "claude nothing"))).toEqual([]);
  });
  test("an exact ID comes first", () => {
    expect(ids(modelSearch(list, "x/gpt-4"))[0]).toBe("x/gpt-4");
  });
  test("draws at most 60 rows but reports how many matched, so 998 models stay instant", () => {
    const many = Array.from({ length: 998 }, (_, i) => ({ v: `p/m${i}` }));
    const r = modelSearch(many, "m");
    expect(MODEL_MAX_ROWS).toBe(60);
    expect([r.rows.length, r.total]).toEqual([60, 998]);
    expect(modelSearch(many, "").rows.length).toBe(60);
  });
  test("regex characters are literal: c++, gpt-4.1, (, [ and a backslash never throw or over-match", () => {
    const odd = [{ v: "x/c++" }, { v: "x/cc" }, { v: "x/gpt-4.1" }, { v: "x/gpt-4x1" }, { v: "x/(paren" }, { v: "x/[br" }, { v: "x/a\\b" }];
    expect(ids(modelSearch(odd, "c++"))).toEqual(["x/c++"]);
    expect(ids(modelSearch(odd, "gpt-4.1"))).toEqual(["x/gpt-4.1"]);
    for (const q of ["(", "[", "\\", ")", "*", "?", "$", "^", "|"]) expect(() => modelSearch(odd, q)).not.toThrow();
    expect(ids(modelSearch(odd, "("))).toEqual(["x/(paren"]);
    expect(ids(modelSearch(odd, "["))).toEqual(["x/[br"]);
    expect(ids(modelSearch(odd, "\\"))).toEqual(["x/a\\b"]);
  });
  test("finds ~ aliases and slashes in the ID", () => {
    const m = [{ v: "openrouter/~anthropic/claude-sonnet-latest", l: "Claude Sonnet Latest" }];
    expect(ids(modelSearch(m, "~anthropic"))).toEqual([m[0].v]);
    expect(ids(modelSearch(m, "openrouter/~anthropic"))).toEqual([m[0].v]);
  });
});

describe("highlighting", () => {
  test("wraps matches, ignoring case, and merges overlaps", () => {
    expect(modelMarks("Claude Sonnet", "son")).toBe("Claude <mark>Son</mark>net");
    expect(modelMarks("Claude Sonnet", "son sonnet")).toBe("Claude <mark>Sonnet</mark>");
    expect(modelMarks("abc", "")).toBe("abc");
  });
  test("HTML in a name, an ID or the query is shown as text, never parsed", () => {
    expect(modelMarks("A<b>", "b")).toBe("A&lt;<mark>b</mark>&gt;");
    expect(modelMarks('<img src=x onerror="alert(1)">', "img")).toBe('&lt;<mark>img</mark> src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(modelMarks("plain", "<script>")).toBe("plain");
  });
});

describe("recent models", () => {
  test("newest first, no duplicates, at most five, empty values ignored", () => {
    expect(modelRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(modelRecent(["1", "2", "3", "4", "5"], "6")).toEqual(["6", "1", "2", "3", "4"]);
    expect(modelRecent(["a"], "")).toEqual(["a"]);
  });
});

describe("finding the chosen model", () => {
  const ps = [{ id: "p", label: "P", models: [{ v: "p/a" }] }, { id: "q", label: "Q", models: [{ v: "q/b", l: "B" }] }];
  test("returns the model and its provider", () => {
    expect(modelFind(ps, "q/b")).toEqual({ m: { v: "q/b", l: "B" }, p: ps[1] });
  });
  test("a saved model that is no longer offered is null, never guessed", () => {
    expect(modelFind(ps, "retired-model")).toBeNull();
    expect(modelFind(ps, "")).toBeNull();
    expect(modelFind([], "p/a")).toBeNull();
  });
});

describe("row details", () => {
  test("context, price and badges read at a glance", () => {
    expect([200000, 262144, 1000000, 1500000, 8192, 500, 0, undefined].map(modelCtx)).toEqual(["200k", "262k", "1M", "1.5M", "8k", "500", "", ""]);
    expect(modelPrice({ in: 3, out: 15 })).toBe("$3 / $15");
    expect(modelPrice({ in: 0.15, out: 0.6 })).toBe("$0.15 / $0.6");
    expect(modelPrice({ in: 0.075, out: 22.5 })).toBe("$0.075 / $22.5");
    expect(modelBadges({ v: "a", ctx: 200000, price: { in: 3, out: 15 }, reasoning: true }).map((b: any) => [b.k, b.t])).toEqual([["ctx", "200k"], ["price", "$3 / $15"], ["reason", "Reasoning"]]);
    expect(modelBadges({ v: "a", free: true }).map((b: any) => b.t)).toEqual(["Free"]);
    expect(modelBadges({ v: "a", efforts: ["low", "high"] }).map((b: any) => b.t)).toEqual(["Reasoning: low, high"]);
    expect(modelBadges({ v: "a", note: "private" }).map((b: any) => [b.k, b.t])).toEqual([["note", "private"]]);
    expect(modelBadges({ v: "a" })).toEqual([]); // a missing detail is skipped, never a blank badge
  });
});
