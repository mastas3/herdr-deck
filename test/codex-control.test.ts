import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCodexIpc, ipcDecoder, ipcFrame, CodexControlError } from "../src/codex-ipc";
import { createCodexControl } from "../src/codex-control";
import { applyCodexPatches, codexControlState } from "../src/codex-control-state";
import { createCodexDelivery } from "../src/codex-delivery";
import { sessionsApi } from "../src/http/api-sessions";

const root = mkdtempSync(`${tmpdir()}/deck-native-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const thread = "native-test-task";
function desktopState(extra = {}) {
  return { id: thread, latestModel: "test-model", latestThreadSettings: { effort: "high" }, threadRuntimeStatus: { type: "idle" },
    requests: [], turns: [], turnHistory: { kind: "canonical", history: { entitiesByKey: {} } }, ...extra };
}
function fixture(initial = desktopState()) {
  let handlers: any, owner = "owner-a", revision = 1, online = true;
  const sent: any[] = [], updates: any[] = [], follows: any[] = [];
  const control = createCodexControl({ timeoutMs: 50, changed(id, state) { updates.push({ id, state }); }, transport(h) {
    handlers = h;
    return {
      async ready() { if (!online) throw new CodexControlError("offline"); },
      async request(method, params, version, target, mutation) {
        if (method === "thread-owner-discovery") return { handledByClientId: owner, result: {} };
        sent.push({ method, params, version, target, mutation });
        return { result: { result: { turn: { id: "new-turn" } } } };
      },
      follow(id, target, following) {
        follows.push({ id, target, following });
        if (following) handlers.broadcast({ method: "thread-stream-state-changed", version: 11, sourceClientId: target,
          params: { hostId: "local", conversationId: id, change: { type: "snapshot", revision, conversationState: initial } } });
      },
      close() { handlers.disconnected(); },
    };
  } });
  const broadcast = (change: any, sourceClientId = owner) => handlers.broadcast({ method: "thread-stream-state-changed", version: 11, sourceClientId,
    params: { hostId: "local", conversationId: thread, change } });
  return { control, sent, updates, follows, wire: (message: any) => handlers.broadcast(message), broadcast, replace(s: any) { initial = s; revision++; broadcast({ type: "snapshot", revision, conversationState: s }); },
    offline() { online = false; handlers.disconnected(); }, changeOwner() { owner = "owner-b"; } };
}

describe("native Codex state and actions", () => {
  test("uses the desktop's canonical history and actual approval ids", () => {
    const s = codexControlState(desktopState({ threadRuntimeStatus: { type: "active", activeFlags: [] },
      turnHistory: { kind: "canonical", history: { entitiesByKey: { t: { turnId: "turn-7", status: "inProgress", items: [{ id: "cmd", command: "bun test" }] } } } },
      requests: [{ id: 42, method: "item/commandExecution/requestApproval", params: { itemId: "cmd" } }] }));
    expect(s).toMatchObject({ ready: true, status: "blocked", activeTurnId: "turn-7", model: "test-model", effort: "high" });
    expect(s.requests[0]).toMatchObject({ id: 42, params: { command: "bun test" } });
  });
  test("patches arrays correctly and rejects prototype paths or missing parents", () => {
    expect(applyCodexPatches({ requests: [1, 3] }, [{ op: "add", path: ["requests", 1], value: 2 }, { op: "remove", path: ["requests", 0] }])).toEqual({ requests: [2, 3] });
    expect(() => applyCodexPatches({}, [{ op: "add", path: ["__proto__", "polluted"], value: true }])).toThrow();
    expect(() => applyCodexPatches({}, [{ op: "replace", path: ["missing", "x"], value: 1 }])).toThrow();
    expect(({} as any).polluted).toBeUndefined();
  });
  test("native reply keeps the task and settings, and retries the same receipt only once", async () => {
    const f = fixture();
    await Promise.all([f.control.send(thread, "Reply here", "receipt_123"), f.control.send(thread, "Reply here", "receipt_123")]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ method: "thread-follower-start-turn", version: 2, target: "owner-a", mutation: true,
      params: { conversationId: thread, turnStart: { context: { inheritThreadSettings: true }, request: { threadId: thread, clientUserMessageId: "receipt_123" } } } });
    expect(f.sent[0].params.turnStart.request.model).toBeUndefined();
    await expect(f.control.send(thread, "Different content", "receipt_123")).rejects.toMatchObject({ code: "CODEX_INVALID" });
    f.control.close();
  });
  test("steering and stopping address the owner; stale stop never reaches it", async () => {
    const f = fixture(desktopState({ threadRuntimeStatus: { type: "active" }, turnHistory: { kind: "canonical", history: { entitiesByKey: { t: { turnId: "turn-1", status: "inProgress" } } } } }));
    await f.control.send(thread, "Focus here", "receipt_steer");
    expect(f.sent[0].method).toBe("thread-follower-steer-turn");
    await expect(f.control.send(thread, "Later", "receipt_queue", true)).rejects.toMatchObject({ code: "CODEX_STALE" });
    await expect(f.control.stop(thread, "old-turn")).rejects.toMatchObject({ code: "CODEX_STALE" });
    expect(f.sent).toHaveLength(1);
    await f.control.stop(thread, "turn-1");
    expect(f.sent[1]).toMatchObject({ method: "thread-follower-interrupt-turn", version: 4, params: { expectedTurnId: "turn-1", mode: "user-stop" } });
    f.control.close();
  });
  test("lost owners and revision gaps disable controls, and a reconnect obtains a new snapshot", async () => {
    const f = fixture(); await f.control.watch(thread);
    f.broadcast({ type: "patches", baseRevision: 8, revision: 9, patches: [] });
    expect(f.control.state(thread).ready).toBe(false);
    f.changeOwner(); await f.control.watch(thread, true);
    expect(f.control.state(thread).ready).toBe(true);
    expect(f.updates.at(-1).state.ready).toBe(true);
    f.broadcast({ type: "snapshot", revision: 11, conversationState: desktopState({ latestModel: "spoof" }) }, "owner-a");
    expect(f.control.state(thread).model).toBe("test-model");
    f.offline(); expect(f.control.state(thread).ready).toBe(false);
    await expect(f.control.send(thread, "Hello", "receipt_offline")).rejects.toMatchObject({ code: "CODEX_UNAVAILABLE" });
    expect(f.sent).toHaveLength(0); f.control.close();
  });
  test("approvals preserve numeric ids, reject unsupported choices and stale requests", async () => {
    const f = fixture(desktopState({ requests: [{ id: 12, method: "item/commandExecution/requestApproval", params: { availableDecisions: ["accept", "decline"] } }] }));
    await expect(f.control.respond(thread, 12, { decision: "acceptForSession" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
    await expect(f.control.respond(thread, "12", { decision: "accept" })).rejects.toMatchObject({ code: "CODEX_STALE" });
    await f.control.respond(thread, 12, { decision: "decline" });
    expect(f.sent[0]).toMatchObject({ method: "thread-follower-command-approval-decision", params: { requestId: 12, decision: "decline" } });
    f.replace(desktopState());
    await expect(f.control.respond(thread, 12, { decision: "accept" })).rejects.toMatchObject({ code: "CODEX_STALE" });
    expect(f.sent).toHaveLength(1); f.control.close();
  });
  test("desktop follower-list recovery only answers its owner and resets require a new snapshot", async () => {
    const f = fixture(); await f.control.watch(thread);
    const request = { method: "thread-stream-following-status-requested", version: 1, sourceClientId: "unrelated-client", params: { hostId: "local" } };
    f.wire(request); expect(f.follows).toHaveLength(1);
    f.wire({ ...request, sourceClientId: "owner-a" }); expect(f.follows).toHaveLength(2);
    f.wire({ method: "ipc-connection-reset", version: 1 });
    expect(f.control.state(thread).ready).toBe(false);
    await f.control.watch(thread, true); expect(f.control.state(thread).ready).toBe(true);
    expect(f.follows).toHaveLength(3); f.control.close();
  });
  test("permissions can only grant the requested scope; multi-question answers preserve question ids", async () => {
    const f = fixture(desktopState({ requests: [{ id: "p", method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } }] }));
    await f.control.respond(thread, "p", { decision: "accept", permissions: { filesystem: { write: ["/"] } }, scope: "session" });
    expect(f.sent[0].params.response).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    f.replace(desktopState({ requests: [{ id: "q", method: "item/tool/requestUserInput", params: { questions: [{ id: "first" }, { id: "second" }] } }] }));
    await expect(f.control.respond(thread, "q", { answers: { first: { answers: ["Yes"] } } })).rejects.toMatchObject({ code: "CODEX_INVALID" });
    const answers = { first: { answers: ["Yes"] }, second: { answers: ["No"] } };
    await f.control.respond(thread, "q", { answers });
    expect(f.sent[1].params.response).toEqual({ answers }); f.control.close();
  });
  test("async question items are answered through the same active turn and disappear after a reply", async () => {
    const f = fixture(desktopState({ threadRuntimeStatus: { type: "active" }, turnHistory: { kind: "canonical", history: { entitiesByKey: {
      t: { turnId: "turn-1", status: "inProgress", items: [{ type: "agentMessage", id: "question-1", questions: [{ title: "Which marker?", options: ["A", "B"] }] }] },
    } } } }));
    const s = await f.control.watch(thread);
    expect(s).toMatchObject({ status: "blocked", requests: [{ id: "async:question-1", method: "deck/asyncQuestion" }] });
    await expect(f.control.send(thread, "queued", "async_queue_123", true)).rejects.toMatchObject({ code: "CODEX_STALE" });
    await f.control.respond(thread, "async:question-1", { answers: { q0: { answers: ["A"] } } });
    expect(f.sent[0]).toMatchObject({ method: "thread-follower-steer-turn", params: { input: [{ text: "Which marker?\nA" }] } });
    const answered = codexControlState(desktopState({ turns: [{ items: [{ type: "agentMessage", id: "q", questions: [{ title: "Q" }] }, { type: "steeringUserMessage", id: "a" }] }], turnHistory: undefined }));
    expect(answered.requests).toHaveLength(0); f.control.close();
  });
  test("native endpoints reject unrelated rows and forward exact stop and request ids", async () => {
    const f = fixture(), row = { app: "codex", sessionId: thread };
    const hub: any = { codex: f.control, hosts: { localRow: () => row } };
    expect(await (await sessionsApi(hub, "/api/codex-state", { key: "k" }))!.json()).toMatchObject({ ready: true });
    hub.hosts.localRow = () => ({ sessionId: thread, agent: "claude" });
    expect((await sessionsApi(hub, "/api/codex-stop", { key: "k" }))!.status).toBe(400); f.control.close();
  });
});

describe("native delivery recovery", () => {
  test("an uncertain delivery survives process restart and cannot be retransmitted", async () => {
    const file = `${root}/receipts.json`, payload = { task: thread, text: "Only once" };
    const deliver = createCodexDelivery(file); let sends = 0;
    await expect(deliver("uncertain_123", payload, async () => { sends++; throw new CodexControlError("lost", "CODEX_DELIVERY_UNKNOWN"); })).rejects.toThrow("lost");
    const restarted = createCodexDelivery(file);
    await expect(restarted("uncertain_123", payload, async () => { sends++; })).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    expect(sends).toBe(1);
    expect(await Bun.file(file).text()).not.toContain("Only once");
  });
  test("acknowledged sends survive restart and definite refusals may be tried again", async () => {
    const file = `${root}/acked.json`; let sends = 0;
    await createCodexDelivery(file)("acked_123", { a: 1 }, async () => { sends++; return { turnId: "ok" }; });
    expect(await createCodexDelivery(file)("acked_123", { a: 1 }, async () => { sends++; })).toEqual({ turnId: "ok" });
    const retry = createCodexDelivery();
    await expect(retry("refused_123", {}, async () => { throw new CodexControlError("no owner"); })).rejects.toThrow();
    expect(await retry("refused_123", {}, async () => "accepted")).toBe("accepted"); expect(sends).toBe(1);
  });
});

describe("desktop socket framing", () => {
  test("handles split headers, split UTF-8 and coalesced frames; rejects oversize frames", () => {
    const values: any[] = [], decode = ipcDecoder((m) => values.push(m));
    const frames = Buffer.concat([ipcFrame({ text: "שלום 🌍" }), ipcFrame({ id: 2 })]);
    for (const byte of frames) decode(Buffer.from([byte]));
    expect(values).toEqual([{ text: "שלום 🌍" }, { id: 2 }]);
    const bad = Buffer.alloc(4); bad.writeUInt32LE(0xffffffff);
    expect(() => decode(bad)).toThrow("Invalid Codex IPC frame");
  });
  test("handshakes on a real socket and marks a lost mutation acknowledgement uncertain", async () => {
    const path = `${root}/wire.sock`; let peer: Socket | undefined;
    const server = createServer((s) => {
      peer = s;
      s.on("data", ipcDecoder((m) => {
        if (m.method === "initialize") s.write(ipcFrame({ type: "response", requestId: m.requestId, resultType: "success", result: { clientId: "deck" } }));
        else s.destroy();
      }));
    });
    await new Promise<void>((r) => server.listen(path, r));
    const ipc = createCodexIpc({ path, timeoutMs: 500, broadcast() {}, disconnected() {} });
    try {
      await ipc.ready();
      await expect(ipc.request("thread-follower-start-turn", {}, 2, "owner", true)).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    } finally { ipc.close(); peer?.destroy(); await new Promise<void>((r) => server.close(() => r())); }
  });
});
