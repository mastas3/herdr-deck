// Limit handoff's pure logic: limit lines, the ask message, finding the agent's note, the transcript note.
import { expect, test } from "bun:test";
import { askMessage, buildNote, findNote, limitLine, touchedFiles } from "../handoff-note";

test("spots the agents' own limit lines, not prose about limits", () => {
  expect(limitLine(["● Done.", "Claude usage limit reached. Your limit will reset at 3pm (Asia/Jerusalem)."])).toStartWith("Claude usage limit reached");
  expect(limitLine(["5-hour limit reached ∙ resets 3pm"])).toBeTruthy();
  expect(limitLine(["■ You've hit your usage limit. Upgrade to Pro or try again at 3:04 PM."])).toBeTruthy();
  expect(limitLine(["You’ve hit your limit · resets 11pm"])).toBeTruthy();
  expect(limitLine(["I added a rate limit to the API", "the usage limit logic is in usage.ts", undefined])).toBeUndefined();
});

test("the ask message names who continues and the mark to reply with", () => {
  expect(askMessage("Codex")).toContain("Codex will continue");
  expect(askMessage("Codex")).toContain('"HANDOFF NOTE"');
});

test("findNote takes the newest marked reply after the ask", () => {
  const msgs = [
    { role: "assistant", text: "HANDOFF NOTE old", at: 1000 },
    { role: "user", text: "Your usage limit is nearly used up… HANDOFF NOTE", at: 50_000 },
    { role: "assistant", text: "Sure.\n\nHANDOFF NOTE\nGoal: ship retries.\nLeft: tests.", at: 60_000 },
  ];
  expect(findNote(msgs, 50_000)).toBe("Goal: ship retries.\nLeft: tests.");
  expect(findNote(msgs.slice(0, 2), 50_000)).toBeUndefined();
});

test("buildNote: requests, where it stopped, files, branch, open question", () => {
  const messages = [
    { role: "user", text: "Add retries to the payment client" },
    { role: "tool", tool: "Edit", summary: "src/pay.ts" },
    { role: "tool", tool: "Read", summary: "src/other.ts" },
    { role: "tool", tool: "apply_patch", summary: "test/pay.test.ts +12 −0" },
    { role: "user", text: "also cap it at 3 attempts" },
    { role: "assistant", text: "Capped at 3. Tests pass.\nShould the delay grow each time?" },
  ];
  expect(touchedFiles(messages as any)).toEqual(["test/pay.test.ts", "src/pay.ts"]);
  const n = buildNote({ row: { project: "acme-api", agent: "claude", projectRoot: "/r/acme", branch: "feat/retry", dirty: 2 }, messages: messages as any, target: "codex", why: "Claude 5h limit at 94%" });
  expect(n).toContain("Continue this work from a Claude session that stopped at its usage limit (Claude 5h limit at 94%). You are Codex.");
  expect(n).toContain("Project: acme-api in /r/acme, branch feat/retry, 2 uncommitted files.");
  expect(n).toContain("- Add retries to the payment client\n- also cap it at 3 attempts");
  expect(n).toContain("Files it edited recently: test/pay.test.ts, src/pay.ts");
  expect(n).toContain("Open question it asked: Should the delay grow each time?");
  expect(n).toContain("git status");
});

test("buildNote with no transcript falls back to the row", () => {
  const n = buildNote({ row: { project: "p", agent: "codex", cwd: "/p", firstPrompt: "Fix the dialer", lastMessage: "Half done" }, messages: [], target: "claude" });
  expect(n).toContain("- Fix the dialer");
  expect(n).toContain("Half done");
  expect(n).toContain("near its usage limit");
});
