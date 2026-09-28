import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The chat's block builder lives in the browser script (no build step); evaluate just its marked block.
const src = readFileSync(new URL("../public/js/chat.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("/* @pure:chat-begin"), src.indexOf("/* @pure:chat-end */"));
const C = new Function(`${block}; return { chatBlocks, settlePending, sendWords };`)();

const msg = (i: number, role: string, text = "", extra: any = {}) => ({ i, role, text, at: 1000 + i, ...extra });
const chat = (ms: any[], pending: any[] = []) => ({ msgs: new Map(ms.map((m) => [m.i, m])), pending });
const order = (c: any) => C.chatBlocks(c).map((b: any) => (b.kind === "pending" ? `pending:${b.ms[0].text}` : `${b.kind}:${b.ms[0].i}`));

describe("a send waiting for its echo", () => {
  test("sits right after the message it answered, above the agent's reply", () => {
    const sent = { role: "user", text: "(b) SQLite", at: 50, after: 5 };
    // The reply is in before the transcript shows your answer (it came in mid-turn, or the echo reads differently).
    const c = chat([msg(4, "user", "Pick a cache"), msg(5, "assistant", "(a) Redis\n(b) SQLite"), msg(6, "tool", "", { tool: "Bash" }), msg(7, "assistant", "SQLite it is.")], [sent]);
    expect(order(c)).toEqual(["user:4", "assistant:5", "pending:(b) SQLite", "tools:6", "assistant:7"]);
  });

  test("a send from before the chat loaded, or with nothing after it, still goes last", () => {
    expect(order(chat([msg(1, "assistant", "Hi")], [{ role: "user", text: "yo", at: 1 }]))).toEqual(["assistant:1", "pending:yo"]);
    expect(order(chat([msg(1, "assistant", "Hi")], [{ role: "user", text: "yo", at: 1, after: 1 }]))).toEqual(["assistant:1", "pending:yo"]);
  });

  test("the echo settles it whatever the spacing or Unicode form (Hebrew with niqqud, accents)", () => {
    const nfd = "שָׁלוֹם  café".normalize("NFD");
    const pending = [{ role: "user", text: "שָׁלוֹם café", at: 1, after: 3 }, { role: "user", text: "(a) Yes\n", at: 2, after: 3 }];
    expect(C.settlePending(pending, [msg(4, "user", nfd), msg(5, "user", "(a)  Yes")])).toEqual([]);
  });

  test("an older message with the same words (scrollback, a jump) doesn't settle a new send", () => {
    const p = { role: "user", text: "Yes, go ahead.", at: 1, after: 20 };
    expect(C.settlePending([p], [msg(12, "user", "Yes, go ahead.")])).toEqual([p]);
    expect(C.settlePending([p], [msg(21, "user", "Yes, go ahead.")])).toEqual([]);
  });

  test("a long send the transcript clipped still settles; the oldest matching send goes first", () => {
    const long = "x".repeat(300);
    const a = { role: "user", text: long, at: 1, after: 0 }, b = { role: "user", text: long, at: 2, after: 0 };
    expect(C.settlePending([a, b], [msg(1, "user", long.slice(0, 250) + "\n\n… (truncated)")])).toEqual([b]);
  });

  test("a command you ran yourself settles on its echo: `!ls` comes back as `! ls`", () => {
    const p = { role: "user", text: "!ls -la", at: 1, after: 3 };
    expect(C.sendWords("!ls")).toBe(C.sendWords("! ls"));
    expect(C.settlePending([p], [msg(4, "user", "! ls -la")])).toEqual([]);
  });
});
