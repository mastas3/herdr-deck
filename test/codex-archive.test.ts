import { expect, test } from "bun:test";
import { CodexArchiveDesktopRequired, codexArchiveFailure } from "../src/codex-archive";
import { CodexControlError } from "../src/codex-ipc";
import { createCodexLifecycle } from "../src/codex-lifecycle";
import { codexLifecycleApi } from "../src/http/codex-lifecycle";
import { createForward } from "../src/http/forward";

const id = "11111111-1111-4111-8111-111111111111", key = `codex-app/${id}`;
test("only an acknowledged writer refusal becomes a desktop archive action", () => {
  const refused = new CodexControlError(`thread ${id} already has an active writer`, "CODEX_INVALID");
  expect(codexArchiveFailure(refused, true)).toMatchObject({ code: "CODEX_DESKTOP_REQUIRED", action: { kind: "open-codex", label: "Open in Codex" } });
  expect((codexArchiveFailure(refused, false) as Error).message).toContain("Restore it");
  for (const error of [new Error(refused.message), new CodexControlError(refused.message, "CODEX_DELIVERY_UNKNOWN"), new CodexControlError("another failure", "CODEX_INVALID")])
    expect(codexArchiveFailure(error, true)).toBe(error);
});

test("capabilities distinguish inactive archive support from desktop-owned tasks", () => {
  const lifecycle = createCodexLifecycle({ transport: async () => { throw new Error("Must not launch for capabilities"); } });
  expect(lifecycle.capabilities()).toMatchObject({ available: true, archive: true, archiveLoaded: false });
});

test("archive handoff keeps the row and live connection and never opens desktop automatically", async () => {
  const calls: string[] = [];
  const hub: any = {
    codexLifecycle: { available: () => true, archive: async () => { calls.push("archive"); throw new CodexArchiveDesktopRequired(true); } },
    codex: { watch: async () => ({ ready: true, status: "idle" }), forget: () => calls.push("forget") },
    deck: { syncAppThread: async () => calls.push("sync") },
    hosts: { localRow: () => ({ app: "codex", sessionId: id, status: "idle" }) },
    codexRecovery: { connect: async () => calls.push("open") },
  };
  const result = await codexLifecycleApi(hub, "/api/codex-archive", { key, archived: true });
  expect(result?.status).toBe(409);
  expect(await result!.json()).toEqual({ code: "CODEX_DESKTOP_REQUIRED", error: "Codex still has this task loaded. Archive it in the Codex app.", action: { kind: "open-codex", label: "Open in Codex" } });
  expect(calls).toEqual(["archive"]);
  hub.codexLifecycle.archive = async () => { calls.push("archive"); };
  expect((await codexLifecycleApi(hub, "/api/codex-archive", { key, archived: true }))?.status).toBe(200);
  expect(calls).toEqual(["archive", "archive", "forget", "sync"]);
});

test("uncertain archive acknowledgement is not replaced by a desktop action", async () => {
  const uncertain = new CodexControlError("Check the task", "CODEX_DELIVERY_UNKNOWN");
  const hub: any = { codexLifecycle: { available: () => true, archive: async () => { throw uncertain; } } };
  await expect(codexLifecycleApi(hub, "/api/codex-archive", { key, archived: false })).rejects.toBe(uncertain);
});

test("federation preserves desktop archive handoff and refusal status", async () => {
  const data = { code: "CODEX_DESKTOP_REQUIRED", action: { kind: "open-codex", label: "Open in Codex" } };
  const remote: any = { conf: { id: "node" }, post: async () => ({ status: 409, data }) };
  const forward = createForward({ remotes: new Map([["node", remote]]), selfId: "local", briefKey: () => "", closeLocal: async () => [] });
  const result = await forward("/api/codex-archive", { key: `node|${key}`, archived: true });
  expect(result?.status).toBe(409); expect(await result!.json()).toEqual(data);
});
