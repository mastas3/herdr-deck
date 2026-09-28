import { describe, expect, test } from "bun:test";
import { keptFlags, looksLikeCrash, lostPanes, restoreCommand, restoreOrder, sigOf } from "../snapshot";
import { pane } from "./fixture";

describe("restore commands", () => {
  test("keep the model and permission flags the agent ran with, drop the rest", () => {
    expect(keptFlags("claude", "node /opt/homebrew/bin/claude --dangerously-skip-permissions --model opus --resume abc fix the bug")).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);
    expect(keptFlags("claude", "claude --permission-mode=plan --effort high")).toEqual(["--permission-mode", "plan", "--effort", "high"]);
    expect(keptFlags("codex", `codex -m gpt-5.5 -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox`)).toEqual(["-m", "gpt-5.5", "-c", `'model_reasoning_effort="high"'`, "--dangerously-bypass-approvals-and-sandbox"]);
    expect(keptFlags("claude", undefined)).toEqual([]);
    expect(keptFlags("shell", "zsh -l")).toEqual([]);
  });
  test("build on the deck's resume command", () => {
    expect(restoreCommand(pane({ key: "a", resume: "claude --resume s1", command: "claude --model opus" }))).toBe("claude --resume s1 --model opus");
    expect(restoreCommand(pane({ key: "b", agent: "codex", resume: "codex resume 019a-11", command: "codex -s workspace-write" }))).toBe("codex resume -s workspace-write 019a-11");
    expect(restoreCommand(pane({ key: "c", resume: "opencode -s ses_1", agent: "opencode" }))).toBe("opencode -s ses_1");
    expect(restoreCommand(pane({ key: "d", agent: "shell" }))).toBeUndefined();
  });
  test("a value with shell characters is quoted, never run", () => {
    expect(keptFlags("claude", "claude --model x;rm")).toEqual(["--model", "'x;rm'"]);
  });
});

describe("what a crash is", () => {
  const before = [
    pane({ key: "a", sessionId: "s1", resume: "claude --resume s1" }),
    pane({ key: "b", sessionId: "s2", resume: "claude --resume s2" }),
    pane({ key: "c", sessionId: "s3", resume: "claude --resume s3" }),
    pane({ key: "e", agent: "shell", empty: true }),
    pane({ key: "d", agent: "bun", command: "bun run dev" }),
  ];
  test("lost: sessions worth restoring that aren't open anywhere now; a moved conversation still counts as open", () => {
    const now = [pane({ key: "zz", sessionId: "s2", resume: "claude --resume s2" })];
    expect(lostPanes(before, now).map((p) => p.key)).toEqual(["a", "c", "d"]);
    expect(lostPanes(before, now, new Set(["s1"])).map((p) => p.key)).toEqual(["c", "d"]);
  });
  test("herdr going away needs only a few; otherwise most of them at once", () => {
    expect(looksLikeCrash({ lost: 3, before: 30, restarted: true, minLost: 3 })).toBe(true);
    expect(looksLikeCrash({ lost: 2, before: 30, restarted: true, minLost: 3 })).toBe(false);
    expect(looksLikeCrash({ lost: 6, before: 30, restarted: false, minLost: 3 })).toBe(false);
    expect(looksLikeCrash({ lost: 20, before: 30, restarted: false, minLost: 3 })).toBe(true);
    expect(looksLikeCrash({ lost: 4, before: 4, restarted: false, minLost: 3 })).toBe(false); // closing one small workspace
  });
  test("status changes don't make a new snapshot; a new pane or conversation does", () => {
    expect(sigOf(before)).toBe(sigOf(before.map((p) => ({ ...p, status: "working" }))));
    expect(sigOf(before)).not.toBe(sigOf([...before, pane({ key: "f" })]));
  });
  test("restore order: workspace as it was, then tab number", () => {
    const ps = [pane({ key: "x", workspaceId: "w2", tabNumber: 1 }), pane({ key: "y", tabNumber: 3 }), pane({ key: "z", tabNumber: 2 }), pane({ key: "q", workspaceId: "w2", tabNumber: 0 })];
    expect(restoreOrder(ps).map((p) => p.key)).toEqual(["q", "x", "z", "y"]);
  });
});
