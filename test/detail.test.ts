import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The client is one classic script; its pure detail-pane logic sits in a marked block we evaluate on its own.
const src = readFileSync(new URL("../public/js/core.js", import.meta.url), "utf8");
const a = src.indexOf("// ── detail-pane logic (pure");
const b = src.indexOf("// ── end detail-pane logic");
const L = new Function(`${src.slice(a, b)}; return { effTab, tabAfterSelect, escAction, permChoices, ctxInfo, checkInfo, dirtyText };`)();

describe("effective tab", () => {
  test("empty tabs fall back to chat", () => {
    expect(L.effTab("images", { imagesTotal: 0 })).toBe("chat");
    expect(L.effTab("images", { imagesTotal: 3 })).toBe("images");
  });
  test("subagents moved to the inspector: a remembered Subagents tab opens on chat", () => {
    expect(L.effTab("agents", { subagents: [{}] })).toBe("chat");
  });
  test("about and info always exist; simple mode and junk mean chat", () => {
    expect(L.effTab("about", undefined)).toBe("about");
    expect(L.effTab("info", undefined)).toBe("info");
    expect(L.effTab("info", undefined, true)).toBe("chat");
    expect(L.effTab("bogus", {})).toBe("chat");
  });
  test("a different session opens on chat, the same one keeps its tab", () => {
    expect(L.tabAfterSelect("a", "b", "images")).toBe("chat");
    expect(L.tabAfterSelect(null, "b", "info")).toBe("chat");
    expect(L.tabAfterSelect("a", "a", "info")).toBe("info");
  });
});

describe("Esc", () => {
  const base = { chatPicks: 0, mode: null, sub: null, q: "", picked: 0, sel: "k", board: false };
  test("innermost first", () => {
    expect(L.escAction({ ...base, chatPicks: 2, mode: "inbox" })).toBe("picks");
    expect(L.escAction({ ...base, mode: "tools", sub: "x" })).toBe("mode");
    expect(L.escAction({ ...base, sub: "x", q: "hi" })).toBe("sub");
    expect(L.escAction({ ...base, q: "hi", picked: 1 })).toBe("search");
    expect(L.escAction({ ...base, picked: 1 })).toBe("picked");
  });
  test("a selected session goes home; home stays home", () => {
    expect(L.escAction(base)).toBe("home");
    expect(L.escAction({ ...base, board: true })).toBeNull();
    expect(L.escAction({ ...base, sel: null })).toBeNull();
  });
});

describe("permission prompts", () => {
  test("Claude's numbered menu: yes approves, no denies, the rest stay", () => {
    const d = { options: [{ id: "1", title: "Yes" }, { id: "2", title: "Yes, allow all edits during this session" }, { id: "3", title: "No, and tell Claude what to do differently (esc)" }] };
    const p = L.permChoices(d);
    expect(p.approve.id).toBe("1");
    expect(p.deny.id).toBe("3");
    expect(p.rest.map((o: any) => o.id)).toEqual(["2"]);
  });
  test("no deny option: Esc", () => {
    const p = L.permChoices({ options: [{ id: "1", title: "Yes, I trust this folder" }] });
    expect(p.approve.id).toBe("1");
    expect(p.deny).toMatchObject({ keys: ["esc"], synthetic: true });
  });
  test("fallback prompt (Confirm / Cancel)", () => {
    const p = L.permChoices({ options: [{ id: "enter", title: "Confirm (Enter)", keys: ["enter"] }, { id: "esc", title: "Cancel (Esc)", keys: ["esc"] }] });
    expect([p.approve.id, p.deny.id, p.rest.length]).toEqual(["enter", "esc", 0]);
  });
  test("no approve-like option: nothing to approve", () => {
    expect(L.permChoices({ options: [{ id: "1", title: "Opus" }, { id: "2", title: "Sonnet" }] }).approve).toBeNull();
  });
});

describe("context", () => {
  test("known window gives a percentage", () => {
    expect(L.ctxInfo({ agent: "codex", ctxTokens: 129200, ctxWindow: 258400 })).toMatchObject({ pct: 50, window: 258400, guessed: false });
    expect(L.ctxInfo({ agent: "opencode", ctxTokens: 86119, ctxWindow: 500000 }).pct).toBeCloseTo(17.2, 1);
  });
  test("Claude and Codex guess a window; OpenCode without one shows tokens only", () => {
    expect(L.ctxInfo({ agent: "claude", ctxTokens: 100000, model: "claude-opus-5" })).toMatchObject({ window: 200000, pct: 50, guessed: true });
    expect(L.ctxInfo({ agent: "claude", ctxTokens: 300000 }).window).toBe(1000000);
    expect(L.ctxInfo({ agent: "codex", ctxTokens: 1000 }).window).toBe(272000);
    expect(L.ctxInfo({ agent: "opencode", ctxTokens: 5000 })).toMatchObject({ tokens: 5000, window: null, pct: null });
    expect(L.ctxInfo({ agent: "claude" })).toBeNull();
  });
});

describe("header chips", () => {
  test("proof of done has a clear label and says what it runs", () => {
    const c = L.checkInfo({ state: "needs-approval", cmd: "bun test" }, "deck");
    expect(c.label).toBe("Verify it’s done");
    expect(c.tip).toContain("`bun test`");
    expect(c.tip).toContain("deck");
    expect(L.checkInfo({ state: "fail", cmd: "npm test", exit: 1 }).tip).toContain("exit 1");
    expect(L.checkInfo({ state: "skipped" })).toBeNull();
    expect(L.checkInfo(undefined)).toBeNull();
  });
  test("uncommitted count", () => {
    expect(L.dirtyText(28)).toBe("28 uncommitted");
    expect(L.dirtyText(0)).toBe("");
  });
});
