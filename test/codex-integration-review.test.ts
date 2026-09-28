import { expect, test } from "bun:test";
import { createCodexControl } from "../src/codex-control";

function preparedFixture(turns: any[] = [], canonical = false) {
  const id = "prepared-fixture", calls: any[] = [];
  let handlers: any;
  const state: any = { id, threadRuntimeStatus: { type: "idle" }, turns, requests: [] };
  if (canonical) { state.turns = []; state.turnHistory = { kind: "canonical", history: { entitiesByKey: Object.fromEntries(turns.map((t, i) => [`turn:${i}`, t])) } }; }
  const control = createCodexControl({ transport(h) {
    handlers = h;
    return {
      ready: async () => {},
      request: async (method: string, params: any) => {
        if (method === "thread-owner-discovery") return { handledByClientId: "owner", result: {} };
        calls.push({ method, params }); return { result: { result: { turn: { id: "prepared-turn" } } } };
      },
      follow(threadId, owner, following) {
        if (following) handlers.broadcast({ method: "thread-stream-state-changed", version: 11, sourceClientId: owner,
          params: { hostId: "local", conversationId: threadId, change: { type: "snapshot", revision: 1,
            conversationState: state } } });
      },
      close: () => {},
    };
  } });
  return { id, control, calls, setTurns(next: any[]) {
    state.turns = next;
    handlers.broadcast({ method: "thread-stream-state-changed", version: 11, sourceClientId: "owner", params: { hostId: "local", conversationId: id,
      change: { type: "snapshot", revision: 2, conversationState: state } } });
  } };
}

test("retrying a new task's first message does not create another turn even after the first answer", async () => {
  const f = preparedFixture();
  try {
    await Promise.all([f.control.sendInitial(f.id, "First prompt", "prepared_receipt_1"), f.control.sendInitial(f.id, "First prompt", "prepared_receipt_1")]);
    f.setTurns([{ turnId: "already-completed", status: "completed", items: [{ type: "agentMessage", text: "Done" }] }]);
    await f.control.sendInitial(f.id, "First prompt", "prepared_receipt_1");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "thread-follower-start-turn", params: { turnStart: { request: { input: [{ type: "text", text: "First prompt" }] } } } });
  } finally { f.control.close(); }
});

test("a create retry cannot execute a first prompt already answered in the desktop", async () => {
  const f = preparedFixture([{ turnId: "already-completed", status: "completed", params: { input: [{ type: "text", text: "Initial prompt" }] },
    items: [{ type: "userMessage", content: [{ type: "text", text: "Initial prompt" }] }, { type: "agentMessage", text: "Already answered" }] }]);
  try {
    await expect(f.control.sendInitial(f.id, "First prompt", "prepared_receipt_2")).rejects.toMatchObject({ code: "CODEX_STALE" });
    expect(f.calls).toHaveLength(0);
  } finally { f.control.close(); }
});

test("first-send guard includes incomplete user-only and canonical histories", async () => {
  for (const canonical of [false, true]) for (const item of [{ type: "userMessage", content: [{ type: "text", text: "Manually submitted" }] }, { type: "agentMessage", text: "Existing answer" }]) {
    const f = preparedFixture([{ status: "completed", items: [item] }], canonical);
    try {
      await expect(f.control.sendInitial(f.id, "First prompt", "prepared_receipt_3")).rejects.toMatchObject({ code: "CODEX_STALE" });
      expect(f.calls).toHaveLength(0);
    } finally { f.control.close(); }
  }
});
