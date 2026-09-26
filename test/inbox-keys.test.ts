import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { promptFromTail } from "../src/decisions";

// The key mapping lives in the browser script between <inbox-keys> markers; run exactly that block.
const src = readFileSync(new URL("../public/js/inbox-cards.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("// <inbox-keys>"), src.indexOf("// </inbox-keys>"));
const { yesNoOption, inboxKey } = new Function(`"use strict";${block};return { yesNoOption, inboxKey };`)();

const claudePrompt = { kind: "prompt", options: [
  { id: "1", title: "Yes", keys: ["1"] },
  { id: "2", title: "Yes, and don’t ask again for bash commands in /repo", keys: ["2"] },
  { id: "3", title: "No, and tell Claude what to do differently (esc)", keys: ["3"] },
] };
const trust = { kind: "prompt", options: [{ id: "1", title: "Yes, I trust this folder", keys: ["enter"] }, { id: "2", title: "No, exit", keys: ["down", "enter"] }] };
const yesNoQ = { kind: "question", options: [{ id: "yes", title: "Yes, go ahead" }, { id: "no", title: "No, not now" }, { id: "more", title: "Tell me more first" }] };
const lettered = { kind: "question", options: [{ id: "a", title: "Ship it" }, { id: "b", title: "Refactor first", rec: true }, { id: "c", title: "Drop it" }] };
const plainLetters = { kind: "question", options: [{ id: "a", title: "Postgres" }, { id: "b", title: "SQLite" }] };
const review = { kind: "review", options: [] };

describe("y / n", () => {
  test("permission prompt: y is the first Yes, n the No", () => {
    expect(inboxKey(claudePrompt, "y")).toEqual({ opt: claudePrompt.options[0] });
    expect(inboxKey(claudePrompt, "n")).toEqual({ opt: claudePrompt.options[2] });
  });
  test("cursor menus and trust prompts", () => {
    expect(inboxKey(trust, "y").opt.id).toBe("1");
    expect(inboxKey(trust, "n").opt.id).toBe("2");
  });
  test("the fallback prompts built by promptFromTail", () => {
    const yn = promptFromTail(["Overwrite the file? (y/n)"]);
    expect(inboxKey(yn, "y").opt.keys).toEqual(["y", "enter"]);
    expect(inboxKey(yn, "n").opt.keys).toEqual(["n", "enter"]);
    const ce = promptFromTail(["Press enter to continue"]);
    expect(inboxKey(ce, "y").opt.id).toBe("enter");
    expect(inboxKey(ce, "n").opt.id).toBe("esc");
  });
  test("a real Claude screen parsed by promptFromTail", () => {
    const p = { kind: "prompt", ...promptFromTail(["Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again this session", "  3. No, and tell Claude what to do differently (esc)"]) };
    expect(inboxKey(p, "y").opt.keys).toEqual(["1"]);
    expect(inboxKey(p, "n").opt.keys).toEqual(["3"]);
  });
  test("yes/no questions", () => {
    expect(inboxKey(yesNoQ, "y").opt.id).toBe("yes");
    expect(inboxKey(yesNoQ, "n").opt.id).toBe("no");
  });
  test("lettered choices: y is the recommended one, n has nothing to pick", () => {
    expect(inboxKey(lettered, "y").opt.id).toBe("b");
    expect(inboxKey(lettered, "n").miss).toMatch(/1–3/);
    expect(inboxKey(plainLetters, "y").miss).toMatch(/No clear yes/);
  });
  test("finished work: y looks good, n sends back", () => {
    expect(inboxKey(review, "y")).toEqual({ act: "accept" });
    expect(inboxKey(review, "n")).toEqual({ act: "sendback" });
  });
  test("words that merely start like yes/no don't count", () => {
    const d = { kind: "question", options: [{ id: "a", title: "Nothing for now" }, { id: "b", title: "Yesterday's build" }, { id: "c", title: "Noted, carry on later" }] };
    expect(yesNoOption(d, "no")).toBeUndefined();
    expect(yesNoOption(d, "yes")).toBeUndefined();
  });
});

describe("other keys", () => {
  test("digits pick by position", () => {
    expect(inboxKey(lettered, "1").opt.id).toBe("a");
    expect(inboxKey(lettered, "3").opt.id).toBe("c");
    expect(inboxKey(lettered, "4").miss).toBe("This one has 3 options");
    expect(inboxKey(review, "1").miss).toMatch(/No options/);
  });
  test("verify only on finished work", () => {
    expect(inboxKey(review, "v")).toEqual({ act: "verify" });
    expect(inboxKey(claudePrompt, "v").miss).toBeTruthy();
  });
  test("reply, open, skip", () => {
    for (const d of [claudePrompt, yesNoQ, review]) {
      expect(inboxKey(d, "r")).toEqual({ act: "reply" });
      expect(inboxKey(d, "o")).toEqual({ act: "open" });
      expect(inboxKey(d, "Enter")).toEqual({ act: "open" });
      expect(inboxKey(d, "s")).toEqual({ act: "skip" });
      expect(inboxKey(d, "x")).toEqual({ act: "skip" });
    }
  });
  test("anything else is not a card key", () => {
    for (const k of ["a", "j", "0", "?", "i", "Y"]) expect(inboxKey(claudePrompt, k)).toBeNull();
    expect(inboxKey(undefined, "y")).toBeNull();
  });
});
