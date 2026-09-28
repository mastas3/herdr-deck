import { expect, test } from "bun:test";
import { codexLifecycleApi } from "../src/http/codex-lifecycle";
import { CodexControlError } from "../src/codex-ipc";
import { createForward } from "../src/http/forward";

const id = "11111111-1111-4111-8111-111111111111", key = `codex-app/${id}`;
function fixture() {
  const calls: any[] = [];
  const hub: any = {
    codexLifecycle: { available: () => true, create: async (args: any) => { calls.push(["create", args]); return { id, initialPromptPersisted: false }; },
      archive: async (...args: any[]) => calls.push(["archive", ...args]), rename: async (...args: any[]) => calls.push(["rename", ...args]),
      fork: async (...args: any[]) => { calls.push(["fork", ...args]); return { id }; },
      archived: async () => ({ tasks: [{ id, title: "Test" }], nextCursor: "next" }) },
    deck: { syncAppThread: async (...args: any[]) => calls.push(["sync", ...args]) },
    hosts: { localRow: () => ({ app: "codex", sessionId: id, status: "idle" }) },
    codexRecovery: { connect: async () => ({ ready: true }) },
    codex: { watch: async () => ({ ready: true, status: "idle" }), forget: (id: string) => calls.push(["forget", id]),
      sendInitial: async (...args: any[]) => calls.push(["send", ...args]) },
  };
  return { hub, calls };
}
test("native creation sends the first prompt only through the desktop owner", async () => {
  const { hub, calls } = fixture();
  const res = await codexLifecycleApi(hub, "/api/codex-create", { cwd: "/tmp", prompt: "Hello", requestId: "create_123" });
  expect(await res!.json()).toEqual({ key, id, promptSent: true });
  expect(calls.find((c) => c[0] === "send")).toEqual(["send", id, "Hello", expect.any(String)]);
});
test("uncertain first delivery preserves the created task and never claims it was unsent", async () => {
  const { hub } = fixture();
  hub.codex.sendInitial = async () => { throw new CodexControlError("Unconfirmed", "CODEX_DELIVERY_UNKNOWN"); };
  expect(await (await codexLifecycleApi(hub, "/api/codex-create", { cwd: "/tmp", prompt: "Hello", requestId: "create_123" }))!.json())
    .toMatchObject({ key, promptSent: false, deliveryUnknown: true });
});
test("blank creation connects the new task without starting a model turn", async () => {
  const { hub, calls } = fixture();
  expect(await (await codexLifecycleApi(hub, "/api/codex-create", { cwd: "/tmp", requestId: "blank_123" }))!.json()).toMatchObject({ key, promptSent: true });
  expect(calls.some((c) => c[0] === "send")).toBe(false);
});
test("a manually started creation cannot restore its first prompt as a fresh draft", async () => {
  const { hub } = fixture();
  hub.codex.sendInitial = async () => { throw new CodexControlError("Already started", "CODEX_STALE"); };
  expect(await (await codexLifecycleApi(hub, "/api/codex-create", { cwd: "/tmp", prompt: "Hello", requestId: "create_123" }))!.json())
    .toMatchObject({ key, promptSent: false, canRetryPrompt: false });
});
test("task mutations reject busy and unrelated task keys", async () => {
  const { hub, calls } = fixture();
  await expect(codexLifecycleApi(hub, "/api/codex-archive", { key: "claude/other", archived: true })).rejects.toMatchObject({ code: "CODEX_INVALID" });
  hub.codex.watch = async () => ({ ready: true, status: "working", activeTurnId: "current" });
  await expect(codexLifecycleApi(hub, "/api/codex-archive", { key, archived: true })).rejects.toMatchObject({ code: "CODEX_STALE" });
  await expect(codexLifecycleApi(hub, "/api/codex-fork", { key, requestId: "fork_123" })).rejects.toMatchObject({ code: "CODEX_STALE" });
  expect(calls).toHaveLength(0);
});
test("restore does not need a current row and immediately refreshes the restored task", async () => {
  const { hub, calls } = fixture(); hub.hosts.localRow = () => undefined;
  expect(await (await codexLifecycleApi(hub, "/api/codex-archive", { key, archived: false }))!.json()).toEqual({ ok: true, key, archived: false });
  expect(calls).toEqual([["archive", id, false], ["sync", id, false]]);
  expect(await (await codexLifecycleApi(hub, "/api/codex-archived", {}))!.json()).toMatchObject({ tasks: [{ id, key }], nextCursor: "next" });
});
test("federation preserves the owning host on created, forked and restored task keys", async () => {
  const remote: any = { conf: { id: "node" }, post: async (path: string) => ({ status: 200, data: path === "/api/codex-archived" ? { tasks: [{ key }] } : { key } }) };
  const forward = createForward({ remotes: new Map([["node", remote]]), selfId: "local", briefKey: () => "", closeLocal: async () => [] });
  for (const path of ["/api/codex-create", "/api/codex-fork", "/api/codex-archive"]) {
    const result = await forward(path, { machine: "node", key: `node|${key}` });
    expect(await result!.json()).toMatchObject({ key: `node|${key}` });
  }
  expect(await (await forward("/api/codex-archived", { machine: "node" }))!.json()).toMatchObject({ tasks: [{ key: `node|${key}` }] });
});
