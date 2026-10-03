import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";
const root = mkdtempSync("/tmp/deck-mod-host-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
async function start() {
  const dir = join(root, String(++n)), builtin = join(dir, "builtin"), data = join(dir, "data");
  mkdirSync(builtin, { recursive: true }); mkdirSync(data);
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "claude-mods"));
  const row: any = { key: "default/w1:p1", sessionId: "one", agent: "claude", cwd: "/work", status: "idle" };
  const calls: any[] = [], forwards: any[] = [];
  const host = createPluginHost({ builtinDir: builtin, root: data, dataDir: data, log: () => {}, core: {
    rows: () => [row], machines: () => [{ id: "mac", local: true, label: "Mac", online: true }], isNode: () => false,
    sessions: { send: async (...a: any[]) => { calls.push(["send", ...a]); }, keys: async (...a: any[]) => { calls.push(["keys", ...a]); } },
  } as any });
  host.provideCore("remotes", { get: (id: string) => id === "linux" ? { post: async (path: string, body: any) => { forwards.push({ path, body }); return { status: 200, data: { ok: true } }; } } : undefined, all: () => [] });
  await host.start();
  const post = async (body: any) => {
    const req = new Request("http://deck/api/claude-mods", { method: "POST" });
    const response = await host.api(req, new URL(req.url), body);
    return response instanceof Response ? { status: response.status, body: await response.json() } : { status: 200, body: response };
  };
  return { host, row, calls, forwards, post };
}
test("real plugin host: inspect is passive; commands, busy protection, occupant pinning and key allowlist", async () => {
  const x = await start();
  try {
    expect((await x.post({ op: "session", key: x.row.key })).status).toBe(200);
    expect(x.calls).toEqual([]);
    const base = { key: x.row.key, sessionId: "one" };
    expect((await x.post({ ...base, op: "command", command: "/plugin" })).status).toBe(200);
    expect(x.calls[0]).toEqual(["send", x.row.key, "/plugin"]);
    expect((await x.post({ ...base, op: "command", command: "/unlisted" })).status).toBe(400);
    x.row.status = "working";
    expect((await x.post({ ...base, op: "command", command: "/plugin" })).status).toBe(400);
    expect((await x.post({ ...base, op: "keys", keys: ["ctrl+x", "tab"] })).status).toBe(200);
    expect((await x.post({ ...base, op: "keys", keys: ["ctrl+c"] })).status).toBe(400);
    x.row.sessionId = "replacement";
    expect((await x.post({ ...base, op: "keys", keys: ["a"] })).status).toBe(400);
    expect(x.calls).toHaveLength(2);
  } finally { await x.host.stop(); }
});
test("remote calls route to the selected machine and strip only its key prefix; off removes route", async () => {
  const x = await start();
  try {
    expect((await x.post({ op: "keys", machine: "linux", key: "linux|default/w3:p1", sessionId: "remote", keys: ["a"] })).status).toBe(200);
    expect(x.forwards[0]).toEqual({ path: "/api/claude-mods", body: { op: "keys", key: "default/w3:p1", machine: undefined, sessionId: "remote", keys: ["a"] } });
    expect(await x.post({ op: "inventory", machine: "missing" })).toEqual({ status: 400, body: { error: "Unknown machine" } });
    x.row.machine = "linux";
    expect((await x.post({ op: "session", key: x.row.key })).status).toBe(400);
    expect((await x.post({ op: "keys", key: x.row.key, sessionId: x.row.sessionId, keys: ["a"] })).status).toBe(400);
    expect(x.calls).toEqual([]);
  } finally { await x.host.stop(); }
  expect((await x.post({ op: "inventory" })).body).toBeUndefined();
});
