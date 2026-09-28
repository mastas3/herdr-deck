import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findIn } from "../src/http/chat";

// The page's half lives in the browser script (no build step); evaluate just its marked block.
const src = readFileSync(new URL("../public/js/chat-find.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("/* @pure:find-begin"), src.indexOf("/* @pure:find-end */"));
const F = new Function(`${block}; return { findSpans, findList, findStart };`)();
const m = (i: number, role: string, text: string, extra: any = {}) => ({ i, role, text, ...extra });

describe("chat search on the server: the whole conversation", () => {
  const all = [
    m(0, "user", "Deploy the **Staging** build"),
    m(1, "assistant", "Staging is up: see [the staging dashboard](https://staging.example.com/x). staging, STAGING."),
    m(2, "tool", undefined as any, { tool: "Bash", summary: "ssh staging 'uptime'" }),
    m(3, "assistant", "שָׁלוֹם עולם, בדיקה".normalize("NFD")),
  ] as any[];
  test("counts each message's matches, any case, as they read on screen (no markdown marks or link targets)", () => {
    expect(findIn(all, "staging")).toEqual([[0, 1], [1, 4], [2, 1]]);
    expect(findIn(all, "staging build")).toEqual([[0, 1]]); // the ** around Staging isn't on screen
  });
  test("Hebrew finds its words whichever Unicode form either side uses", () => {
    expect(findIn(all, "שָׁלוֹם")).toEqual([[3, 1]]);
    expect(findIn(all, "בדיקה")).toEqual([[3, 1]]);
  });
  test("nothing to find, nothing found", () => {
    expect(findIn(all, "  ")).toEqual([]);
    expect(findIn(all, "prod")).toEqual([]);
  });
});

describe("chat search on the page", () => {
  test("spans are offsets in the text as shown, any case, including decomposed text", () => {
    expect(F.findSpans("Foo foo FOO", "foo")).toEqual([[0, 3], [4, 7], [8, 11]]);
    const nfd = "café".normalize("NFD");
    expect(F.findSpans(`a ${nfd} b`, "café")).toEqual([[2, 2 + nfd.length]]);
    expect(F.findSpans("İstanbul istanbul", "istanbul")).toEqual([[9, 17]]); // İ lowers to two characters: offsets must not drift
  });
  test("the server's counts become one list of matches, oldest first", () => {
    expect(F.findList([[2, 2], [9, 1]])).toEqual([{ i: 2, k: 0 }, { i: 2, k: 1 }, { i: 9, k: 0 }]);
  });
  test("it starts at the newest match at or above what you're looking at, else the first below", () => {
    const list = F.findList([[2, 1], [9, 2], [40, 1]]);
    expect(F.findStart(list, 20)).toBe(2);
    expect(F.findStart(list, 1)).toBe(0);
    expect(F.findStart(list, Infinity)).toBe(3);
    expect(F.findStart([], 5)).toBe(-1);
  });
});
