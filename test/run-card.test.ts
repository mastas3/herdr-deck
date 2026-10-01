import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The run card's logic lives in the browser script (no build step); evaluate just its marked block.
const src = readFileSync(new URL("../public/js/run-card.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("/* @pure:run-begin"), src.indexOf("/* @pure:run-end */"));
const R = new Function(`${block}; return { bangCmd, stripAnsi, clockText, screenRunLines, runPhase, runStop };`)();
const chatSrc = readFileSync(new URL("../public/js/chat.js", import.meta.url), "utf8");
const C = new Function(`${chatSrc.slice(chatSrc.indexOf("/* @pure:chat-begin"), chatSrc.indexOf("/* @pure:chat-end */"))}; return { chatBlocks, settlePending };`)();

describe("which messages are commands", () => {
  test("! with or without a space; anything else is not", () => {
    expect(R.bangCmd("! ls -la")).toBe("ls -la");
    expect(R.bangCmd("!git status")).toBe("git status");
    expect(R.bangCmd("  !  echo hi  ")).toBe("echo hi");
    expect(R.bangCmd("Hello!")).toBeNull();
    expect(R.bangCmd("!")).toBeNull();
    expect(R.bangCmd(undefined)).toBeNull();
  });
  test("elapsed time reads like a clock", () => {
    expect(R.clockText(0)).toBe("0:00");
    expect(R.clockText(75_400)).toBe("1:15");
    expect(R.clockText(3_723_000)).toBe("1:02:03");
  });
});

describe("what a running command printed, read off Claude Code's screen", () => {
  const screen = [
    "> Fix the build",
    "⏺ Done.",
    "",
    "! npm test",
    "  ⎿  \x1b[32m✓\x1b[0m parses dates",
    "     ✓ formats money",
    "     Running…",
    "",
    "╭──────────────────────────────╮",
    "│ >                            │",
    "╰──────────────────────────────╯",
    "  ? for shortcuts",
  ].join("\n");
  test("the lines under the newest command line, up to the message box, without the gutter", () => {
    expect(R.screenRunLines(screen, "npm test")).toEqual({ found: true, lines: ["✓ parses dates", "✓ formats money"], alive: true });
  });
  test("Claude Code 2.1 shows only \"Running…\" until the command ends: no lines yet, but alive", () => {
    const s = "✻ Crunched for 12s\n! for i in 1 2 3; do echo step $i; sleep 1; done\n  ⎿  Running…\n                                                                                ✔ Update installed\n────────\n❯ \n────────\n";
    expect(R.screenRunLines(s, "for i in 1 2 3; do echo step $i; sleep 1; done")).toEqual({ found: true, lines: [], alive: true });
  });
  test("the newest of two runs of the same command; at most `max` lines, the last ones", () => {
    const two = "! ls\n  ⎿  old\n! ls\n  ⎿  a\n     b\n     c\n────────\n";
    expect(R.screenRunLines(two, "ls").lines).toEqual(["a", "b", "c"]);
    expect(R.screenRunLines(two, "ls", 2).lines).toEqual(["b", "c"]);
  });
  test("a long command that wraps is not mistaken for output", () => {
    const cmd = "rsync -av --delete ./dist/ deploy@example.com:/var/www/site/";
    const s = `! rsync -av --delete ./dist/ deploy@example\n.com:/var/www/site/\n  ⎿  sending incremental file list\n────\n`;
    expect(R.screenRunLines(s, cmd).lines).toEqual(["sending incremental file list"]);
  });
  test("not on screen yet (queued below, or scrolled away): nothing", () => {
    expect(R.screenRunLines("⏺ Working on it\n────\n│ > ! ls\n", "ls")).toEqual({ found: false, lines: [], alive: false });
    expect(R.screenRunLines("", "ls").found).toBe(false);
  });
});

describe("where a run is", () => {
  const run = (o: any = {}) => ({ state: "sent", at: 0, live: [], ...o });
  test("its recorded result wins", () => {
    expect(R.runPhase({ run: run(), shell: { state: "done" } })).toBe("done");
    expect(R.runPhase({ run: run({ state: "sendfail" }), shell: { state: "error" } })).toBe("failed");
    expect(R.runPhase({ shell: { state: "done" } })).toBe("done");
  });
  test("before its result: sending, not sent, queued behind the current step, running, stopped watching", () => {
    expect(R.runPhase({ run: run({ state: "sending" }) })).toBe("sending");
    expect(R.runPhase({ run: run({ state: "sendfail" }) })).toBe("sendfail");
    expect(R.runPhase({ run: run({ queued: true }) })).toBe("queued");
    expect(R.runPhase({ run: run({ queued: true, live: ["x"] }) })).toBe("running");
    expect(R.runPhase({ run: run() })).toBe("running");
    expect(R.runPhase({ run: run({ stopped: "idle" }) })).toBe("lost");
  });
  test("a command from before this page with no result is just 'ran'; one waiting to be echoed is sending", () => {
    expect(R.runPhase({})).toBe("ran");
    expect(R.runPhase({ pending: true })).toBe("sending");
  });
});

describe("when to stop watching the screen", () => {
  test("the result is in, or 10 minutes passed", () => {
    expect(R.runStop({ at: 0, live: [] }, { now: 1000, status: "working", shell: { state: "done" } })).toBe("done");
    expect(R.runStop({ at: 0, live: [] }, { now: 600_001, status: "working" })).toBe("timeout");
  });
  test("a session quiet for 5 s (not working, nothing new on screen) stops it; busy or new output keeps it going", () => {
    const r: any = { at: 0, sentAt: 0, live: [] };
    expect(R.runStop(r, { now: 3000, status: "idle" })).toBeNull();
    expect(R.runStop(r, { now: 4000, status: "working" })).toBeNull();
    expect(R.runStop(r, { now: 8000, status: "idle" })).toBeNull(); // busy 4 s ago
    expect(R.runStop(r, { now: 9500, status: "idle" })).toBe("idle");
    r.liveAt = 9000;
    expect(R.runStop(r, { now: 12_000, status: "done" })).toBeNull();
  });
});

describe("the card in the chat", () => {
  const msg = (i: number, role: string, text = "", extra: any = {}) => ({ i, role, text, at: 1000 + i, ...extra });
  test("a command's Shell row folds into its card once the card has the output; without it the row stays", () => {
    const shown = (ms: any[]) => C.chatBlocks({ msgs: new Map(ms.map((m) => [m.i, m])), pending: [] }).map((b: any) => `${b.kind}:${b.ms[0].i}`);
    expect(shown([msg(0, "user", "! ls", { shell: { state: "done", out: "a", lines: 1 } }), msg(1, "tool", "", { tool: "Shell", of: 0 }), msg(2, "assistant", "ok")])).toEqual(["user:0", "assistant:2"]);
    expect(shown([msg(1, "tool", "", { tool: "Shell", of: 0 }), msg(2, "assistant", "ok")])).toEqual(["tools:1", "assistant:2"]); // its command isn't loaded
    expect(shown([msg(0, "user", "! ls"), msg(1, "tool", "", { tool: "Shell", summary: "a" })])).toEqual(["user:0", "tools:1"]); // an older parse
  });
  test("the echo settles a run's card and says which message took it; two runs of one command are two cards", () => {
    const a = { role: "user", text: "! ls", at: 1, after: 3, run: "r1" }, b = { role: "user", text: "!ls", at: 2, after: 3, run: "r2" };
    expect(C.settlePending([a, b], [msg(4, "user", "! ls")])).toEqual([b]);
    expect(a).toMatchObject({ echo: 4 });
    expect(C.settlePending([b], [msg(4, "user", "! ls"), msg(6, "user", "! ls")])).toEqual([]);
    expect(b).toMatchObject({ echo: 4 });
  });
});
