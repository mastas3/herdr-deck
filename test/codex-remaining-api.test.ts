import { expect, test } from "bun:test";
import { codexApi } from "../src/http/codex";
import { createForward } from "../src/http/forward";
import { createCodexDelivery } from "../src/codex-delivery";

test("native mutations reject missing and non-string receipts before sending", async () => {
  const deliver = createCodexDelivery(); let sends = 0;
  for (const receipt of [undefined, null, 123456789, { toString: () => "valid_receipt" }]) {
    await expect(deliver(receipt as any, {}, async () => { sends++; })).rejects.toMatchObject({ code: "CODEX_INVALID" });
  }
  expect(sends).toBe(0);
});

test("selected-reply fork capability follows host metadata availability, independently of desktop ownership", async () => {
  let available = true;
  const hub: any = { hosts: { localRow: () => ({ app: true, sessionId: "native-task" }) },
    codex: { watch: async () => ({ ready: false, status: "unavailable" }), conversation: { queue: async () => ({ status: "ready", messages: [] }) } },
    codexLifecycle: { available: () => available, capabilities: () => ({ archiveLoaded: false }) } };
  expect(await (await codexApi(hub, "/api/codex-state", { key: "task" }))!.json()).toMatchObject({
    ready: false, capabilities: { forkPoint: true, settings: false, edit: false, archiveLoaded: false } });
  available = false;
  expect(await (await codexApi(hub, "/api/codex-state", { key: "task" }))!.json()).toMatchObject({ capabilities: { forkPoint: false } });
});

test("selected-reply forks keep their host identity when forwarded", async () => {
  const calls: any[] = [], remote: any = { conf: { id: "node" }, post: async (...args: any[]) => {
    calls.push(args); return { status: 200, data: { ok: true, id: "child", key: "codex-app/child" } };
  } };
  const forward = createForward({ remotes: new Map([["node", remote]]), selfId: "local", briefKey: () => "", closeLocal: async () => [] });
  const body = { key: "node|codex-app/parent", lastTurnId: "turn-1", replyHash: "hash", requestId: "receipt-123" };
  const response = await forward("/api/codex-fork-point", body);
  expect(calls).toEqual([["/api/codex-fork-point", { ...body, key: "codex-app/parent" }]]);
  expect(await response!.json()).toEqual({ ok: true, id: "child", key: "node|codex-app/child" });
});
