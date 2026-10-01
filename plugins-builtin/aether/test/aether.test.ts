import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createAetherPreview, fixtureRow } from "../../../bin/aether-preview";
const logic = readFileSync(new URL("../aether-model.js", import.meta.url), "utf8");
const { aetherIdentity, aetherMatches, aetherStatus, aetherEntries } = new Function(`${logic}; return { aetherIdentity, aetherMatches, aetherStatus, aetherEntries };`)();

test("a reused key, moved project, other machine or agent never silently changes the pinned session", () => {
  const target = aetherIdentity(fixtureRow);
  expect(aetherMatches(fixtureRow, target)).toBe(true);
  for (const field of ["key", "sessionId", "machine", "agent", "cwd", "project"]) expect(aetherMatches({ ...fixtureRow, [field]: "different" }, target)).toBe(false);
  expect(aetherIdentity({ ...fixtureRow, hist: "/archive" })).toBeNull();
  expect(aetherMatches(null, target)).toBe(false);
});
test("status distinguishes disconnection, waiting, completion and unknown", () => {
  expect(aetherStatus(fixtureRow, false).kind).toBe("offline");
  expect(aetherStatus(null, true).kind).toBe("missing");
  expect(aetherStatus({ status: "blocked" }, true).label).toBe("Needs you");
  expect(aetherStatus({ status: "done" }, true).label).toBe("Turn complete");
  expect(aetherStatus({ status: "new-state" }, true).label).toBe("Status unknown");
});
test("journal caps history and excludes tool payloads", () => {
  const msgs = Array.from({ length: 9 }, (_, i) => ({ i, role: "assistant", text: `Update ${i}` }));
  expect(aetherEntries([...msgs, { role: "tool", text: "private tool output" }]).map((m: any) => m.i)).toEqual([3, 4, 5, 6, 7, 8]);
});
test("read-only preview strips unrelated sessions and blocks writes, forged host/origin/token and wrong target", async () => {
  const calls: any[] = []; let row: any = { ...fixtureRow };
  const upstream = async (url: any, init: any) => {
    calls.push([url, init]);
    return Response.json(String(url).endsWith("/api/state") ? { token: "existing-token", self: "preview", rows: [row, { ...fixtureRow, key: "other", sessionId: "secret" }], decisions: ["unrelated"], summary: { machines: [] } } : { messages: [] });
  };
  const handle = createAetherPreview({ sessionKey: fixtureRow.key, upstream: upstream as any });
  const request = (path: string, body?: any, headers = {}) => handle(new Request("http://127.0.0.1:4768" + path, { method: body ? "POST" : "GET", headers: { "x-deck-token": "existing-token", ...headers }, body: body ? JSON.stringify(body) : undefined }));
  const state = await (await request("/api/state")).json();
  expect(state.rows.map((r: any) => r.key)).toEqual([fixtureRow.key]); expect(state.decisions).toEqual([]);
  const before = calls.length;
  for (const route of ["send", "keys", "codex-connect", "codex-respond", "queue", "new", "seen"]) expect((await request("/api/" + route, { key: fixtureRow.key, text: "never send" })).status).toBe(403);
  expect(calls.length).toBe(before);
  expect((await request("/api/state", undefined, { host: "attacker.test" })).status).toBe(403);
  expect((await request("/api/state", undefined, { origin: "https://attacker.test" })).status).toBe(403);
  expect((await request("/api/chat", { key: fixtureRow.key }, { "x-deck-token": "bad" })).status).toBe(403);
  expect((await request("/api/chat", { key: "other" })).status).toBe(409);
  expect((await request("/api/chat", { key: fixtureRow.key, sub: "other" })).status).toBe(409);
  expect((await request("/api/chat", { key: fixtureRow.key, limit: 400 })).status).toBe(200);
  expect(JSON.parse(calls.at(-1)[1].body)).toEqual({ key: fixtureRow.key, limit: 40 });
  row = { ...row, sessionId: "reused-pane" };
  expect((await request("/api/chat", { key: fixtureRow.key })).status).toBe(409);
  expect((await (await request("/api/state")).json()).rows).toEqual([]);
});
test("upstream failure is recoverable without fabricating live state", async () => {
  const handle = createAetherPreview({ sessionKey: fixtureRow.key, upstream: (async () => { throw new Error("offline"); }) as any });
  expect((await handle(new Request("http://127.0.0.1:4768/api/state"))).status).toBe(503);
});
