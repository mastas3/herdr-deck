import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The phone's screen stack decides from a marked pure block in nav.js, evaluated here on its own.
const src = readFileSync(new URL("../public/js/nav.js", import.meta.url), "utf8");
const a = src.indexOf("// ── pure (test/nav.test.ts");
const b = src.indexOf("// ── end pure");
const N = new Function(`${src.slice(a, b)}; return { navStep, navKey, NAV_LIST };`)();

const sess = (sel: string, o: Record<string, unknown> = {}) => { const s: any = { mv: "detail", sel, sub: null, tab: "chat", ...o }; s.k = N.navKey(s); return s; };
const view = (mode: string, path: string | null = null) => { const s: any = { mv: "detail", mode, path }; s.k = N.navKey(s); return s; };

describe("screen keys", () => {
  test("a session and its subagent are different screens; its tab and half are not", () => {
    expect(N.navKey(sess("a"))).toBe(N.navKey(sess("a", { tab: "info", mv: "term" })));
    expect(N.navKey(sess("a"))).not.toBe(N.navKey(sess("a", { sub: "x" })));
  });
  test("a view's own link tells two project pages apart; the list is one screen", () => {
    expect(N.navKey(view("project", "/p/a"))).not.toBe(N.navKey(view("project", "/p/b")));
    expect(N.navKey({ mv: "list", sel: "a" })).toBe("list");
    expect(N.navKey({ mv: "detail", board: true })).toBe("board");
  });
});

describe("what a screen change does to the history", () => {
  const L = N.NAV_LIST;
  test("list → session pushes; session → subagent pushes", () => {
    expect(N.navStep(sess("a"), L, null, 0)).toBe("push");
    expect(N.navStep(sess("a", { sub: "x" }), sess("a"), L, 1)).toBe("push");
  });
  test("chat ⇄ terminal and another tab replace the entry; nothing new is nothing", () => {
    expect(N.navStep(sess("a", { mv: "term" }), sess("a"), L, 1)).toBe("replace");
    expect(N.navStep(sess("a", { tab: "info" }), sess("a"), L, 1)).toBe("replace");
    expect(N.navStep(sess("a"), sess("a"), L, 1)).toBe("none");
  });
  test("going to the screen right below is a step back; to the list, a rewind to the root", () => {
    expect(N.navStep(sess("a"), sess("a", { sub: "x" }), sess("a"), 2)).toBe("back");
    expect(N.navStep(L, sess("b"), view("inbox"), 2)).toBe("root");
    expect(N.navStep(L, L, null, 0)).toBe("none");
  });
  test("inbox → a session opened from it pushes, so back returns to the inbox", () => {
    expect(N.navStep(sess("a"), view("inbox"), L, 1)).toBe("push");
  });
});
