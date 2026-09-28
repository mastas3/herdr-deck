import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { codexEditableTurn, codexQueuedMessages, createCodexConversation } from "../src/codex-conversation";
import { codexControlState } from "../src/codex-control-state";
import { CodexControlError } from "../src/codex-ipc";

const root = mkdtempSync(`${tmpdir()}/deck-conversation-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const turn = (turnId: string, text: string) => ({ turnId, status: "completed", params: { input: [{ type: "text", text }] }, items: [{ type: "userMessage", content: [{ type: "text", text }] }] });
function fixture() {
  const raw: any = { threadRuntimeStatus: { type: "idle" }, turns: [turn("one", "First"), turn("two", "Second")] }, calls: any[] = [];
  const access = { current: async () => codexControlState(raw), raw: () => raw, action: async (...args: any[]) => { calls.push(args); return { ok: true }; } };
  return { raw, calls, access, conversation: createCodexConversation(access) };
}

describe("Codex native message editing and queue projection", () => {
  test("only the latest user turn is editable; active tasks and approvals disable editing", () => {
    const f = fixture(); expect(codexEditableTurn(f.raw)).toEqual({ turnId: "two", text: "Second" });
    f.raw.turns.push({ turnId: "auto", params: { input: [] }, items: [], status: "completed" });
    expect(codexEditableTurn(f.raw)?.turnId).toBe("two");
    f.raw.turns[2].status = "inProgress"; expect(codexEditableTurn(f.raw)).toBeUndefined();
    f.raw.turns[2].status = "completed"; f.raw.requests = [{ id: "approval" }]; expect(codexEditableTurn(f.raw)).toBeUndefined();
  });
  test("canonical history follows ordered islands and hides preserved context prefix", () => {
    const raw = { turnHistory: { kind: "canonical", history: { islands: [{ entries: [{ value: "first" }, { value: "last" }] }],
      entitiesByKey: { last: turn("last", "# Files mentioned by the user:\nfile.txt\n## My request:\nChange this"), first: turn("first", "Old") } } } };
    expect(codexEditableTurn(raw)).toEqual({ turnId: "last", text: "Change this" });
  });
  test("edits use the native rollback/replay path, preserve permissions, and deduplicate receipt", async () => {
    const f = fixture();
    await f.conversation.edit("task", "two", "New message", "edit_receipt_01");
    await f.conversation.edit("task", "two", "New message", "edit_receipt_01");
    expect(f.calls).toEqual([["task", "thread-follower-edit-last-user-turn", { turnId: "two", message: "New message", shouldSendPermissionOverrides: false }, 2]]);
    await expect(f.conversation.edit("task", "one", "Wrong", "edit_receipt_02")).rejects.toMatchObject({ code: "CODEX_STALE" });
    await expect(f.conversation.edit("task", "two", "", "edit_receipt_03")).rejects.toMatchObject({ code: "CODEX_INVALID" });
    expect(f.calls).toHaveLength(1);
  });
  test("unknown edit delivery stays blocked across restart", async () => {
    const f = fixture(), receiptsFile = `${root}/edits.json`;
    f.access.action = async () => { throw new CodexControlError("Lost acknowledgement", "CODEX_DELIVERY_UNKNOWN"); };
    const c = createCodexConversation(f.access, { receiptsFile });
    await expect(c.edit("task", "two", "New", "edit_unknown_1")).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    f.access.action = async () => { throw new Error("Must not retry"); };
    await expect(createCodexConversation(f.access, { receiptsFile }).edit("task", "two", "New", "edit_unknown_1")).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
  });
  test("queue projection exposes only the selected task's display fields", async () => {
    const value = { unrelated: "private", "queued-follow-ups": { task: [{ id: "q", text: "Draft", context: { private: true }, pausedReason: "Waiting" }], other: [{ id: "x", text: "Other task" }] } };
    expect(codexQueuedMessages(value, "task")).toEqual({ status: "ready", messages: [{ id: "q", text: "Draft", pausedReason: "Waiting" }] });
    const globalStateFile = `${root}/global.json`; writeFileSync(globalStateFile, JSON.stringify(value));
    const f = fixture(), c = createCodexConversation(f.access, { globalStateFile });
    expect(await c.queue("task")).toEqual(codexQueuedMessages(value, "task"));
    expect(await c.queue("unknown")).toEqual({ status: "ready", messages: [] });
    expect(await createCodexConversation(f.access, { globalStateFile: `${root}/missing` }).queue("task")).toEqual({ status: "unavailable", messages: [] });
  });
});
