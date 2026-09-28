import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// The keyboard is data (public/js/keymap.js): the "?" sheet and ⌘K's hints are generated from it. Run exactly its data
// block, and the pure inbox-keys block, and check the table against the code that really answers the keys.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const km = read("../public/js/keymap.js");
const { DECK_KEYS, INBOX_KEYS } = new Function(`${km.slice(km.indexOf("// ── keymap (data)"), km.indexOf("// ── end keymap"))}; return { DECK_KEYS, INBOX_KEYS };`)();
const ik = read("../public/js/inbox-cards.js");
const { inboxKey } = new Function(`${ik.slice(ik.indexOf("// <inbox-keys>"), ik.indexOf("// </inbox-keys>"))}; return { inboxKey };`)();
const BUILTIN = new URL("../plugins-builtin", import.meta.url).pathname;

describe("the keymap", () => {
  const live = DECK_KEYS.filter((b: any) => b.run);
  test("no key runs two things, and every binding has an id, a section and a label", () => {
    const seen = new Map<string, string>();
    for (const b of live) {
      expect([b.id, typeof b.sec, typeof b.label]).toEqual([expect.any(String), "string", "string"]);
      for (const k of b.keys) { expect([k, seen.get(k)]).toEqual([k, undefined]); seen.set(k, b.id); }
    }
    expect(new Set(live.map((b: any) => b.id)).size).toBe(live.length);
  });
  test("the core's everyday keys are all there", () => {
    const keys = new Set(live.flatMap((b: any) => b.keys));
    for (const k of [..."/jkrtfyxsbeihlgnc[]`\\?.JYAU123456789", "Escape", "ArrowDown", "ArrowUp"]) expect([k, keys.has(k)]).toEqual([k, true]);
  });
  test("built-in plugins' keys don't collide with the core's", () => {
    const core = new Set(DECK_KEYS.flatMap((b: any) => b.keys));
    const files = readdirSync(BUILTIN).flatMap((d) => (existsSync(`${BUILTIN}/${d}/plugin.json`) ? JSON.parse(readFileSync(`${BUILTIN}/${d}/plugin.json`, "utf8")).client.map((f: string) => `${BUILTIN}/${d}/${f}`) : []));
    const taken: string[] = [];
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/^\s*keys: \{ (\w):/gm)) taken.push(m[1]);
    expect(taken.sort()).toEqual(["d", "q"]);
    for (const k of taken) expect([k, core.has(k)]).toEqual([k, false]);
  });
  test("the Decisions list matches what inboxKey() answers", () => {
    const review = { kind: "review", options: [] }, prompt = { kind: "prompt", options: [{ id: "1", title: "Yes" }, { id: "2", title: "No" }] };
    const listed = new Set(INBOX_KEYS.flatMap((b: any) => b.keys));
    for (const k of "ynvros".split("").concat("x", "Enter")) {
      expect([k, listed.has(k)]).toEqual([k, true]);
      expect([k, inboxKey(k === "v" ? review : prompt, k)]).not.toEqual([k, null]);
    }
    expect(inboxKey(prompt, "1")).toEqual({ opt: prompt.options[0] });
    expect(listed.has("1–9")).toBe(true);
    expect(inboxKey(prompt, "q")).toBeNull(); // a key the list doesn't name isn't a card key
  });
});
