// herdr plugins as the deck runs it: through the real plugin host, with a fake `herdr` (DECK_HERDR_BIN) and a fake
// herdr socket (DECK_HERDR_SOCKET), so no test ever reaches the real herdr. `bun test` runs this.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

// Short: a unix socket path must fit in ~104 bytes.
const root = mkdtempSync(`/tmp/dhp-`);
const calls = join(root, "calls.log");
const sock = join(root, "h.sock");
const invoked: any[] = [];
let server: ReturnType<typeof Bun.listen> | undefined;
const PLUGIN = {
  plugin_id: "acme.tools", name: "Acme Tools", version: "1.2.0", enabled: true, min_herdr_version: "0.7.0", platforms: ["macos", "linux"],
  actions: [{ id: "tidy", title: "Acme Tools: Tidy the pane", contexts: ["pane"], command: ["sh", "tidy.sh"] }, { id: "hello", title: "Say hello", command: ["echo", "hi"] }],
  events: [{ on: "pane.created", command: ["sh", "on.sh"] }], build: [], startup: [], panes: [],
  source: { kind: "github", owner: "acme", repo: "tools", requested_ref: "a".repeat(40), resolved_commit: "a".repeat(40) },
};

beforeAll(() => {
  // The fake herdr: logs its argv, answers like herdr 0.8.2 does (JSON on stdout for API-backed commands).
  const bin = join(root, "herdr");
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> ${calls}
case "$1 $2" in
  "--version ") echo "herdr 0.8.2" ;;
  "plugin list") echo '{"id":"cli:plugin","result":{"plugins":[${JSON.stringify(PLUGIN)}],"type":"plugin_list"}}' ;;
  "plugin disable"|"plugin enable") echo '{"id":"cli:plugin","result":{"type":"plugin_updated"}}' ;;
  "plugin log") echo '{"id":"cli:plugin","result":{"logs":[{"log_id":"l1","plugin_id":"acme.tools","status":"succeeded","command":["x"],"started_unix_ms":1},{"log_id":"l2","plugin_id":"acme.tools","status":"failed","command":["y"],"started_unix_ms":2}],"type":"plugin_log_list"}}' ;;
  "plugin config-dir") echo "/tmp/cfg/$3" ;;
  "plugin uninstall") echo "Uninstalled $3" ;;
  "plugin install") echo "Cloning $3"; echo "build commands: 0"; echo "Installed acme.tools from $3." ;;
  *) echo '{"id":"cli:plugin","error":{"code":"nope","message":"not faked"}}' ;;
esac
`);
  chmodSync(bin, 0o755);
  process.env.DECK_HERDR_BIN = bin;
  process.env.DECK_HERDR_SOCKET = sock;
  // The fake herdr socket: records plugin.action.invoke and answers like herdr.
  server = Bun.listen({ unix: sock, socket: { data(s, d) {
    const req = JSON.parse(d.toString().trim());
    invoked.push(req);
    s.write(JSON.stringify({ id: req.id, result: { type: "plugin_action_invoked", action: { title: "Tidy" }, log: { log_id: "plugin-log-9", status: "running" } } }) + "\n");
  } } });
});
afterAll(() => { server?.stop(true); delete process.env.DECK_HERDR_BIN; delete process.env.DECK_HERDR_SOCKET; rmSync(root, { recursive: true, force: true }); });

const ROWS = [{ key: "w1:p2", herdr: "default", paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", cwd: "/work/api", agent: "claude", tab: "api", workspace: "work" }];
let n = 0;
async function start(remotes?: object) {
  const builtin = join(root, `builtin-${++n}`), data = join(root, `data-${n}`);
  mkdirSync(builtin); mkdirSync(data);
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "herdr-plugins"));
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => ROWS, push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [{ id: "mac", label: "MacBook", local: true, online: true }], isNode: () => false, broadcast: () => {}, notice: () => {}, history: async () => [], checks: () => new Map(), sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any,
  });
  if (remotes) host.provideCore("remotes", remotes);
  await host.start();
  const post = async (body: unknown) => {
    const r = await host.api(new Request("http://d/api/herdr-plugins", { method: "POST" }), new URL("http://d/api/herdr-plugins"), body);
    return { status: r!.status, data: await r!.json() };
  };
  return { host, post };
}

test("reads this machine's herdr plugins through the CLI, in the deck's words", async () => {
  const { host, post } = await start();
  expect(host.active()).toEqual(["herdr-plugins"]);
  const { data } = await post({ op: "status" });
  expect(data.version).toBe("0.8.2");
  expect(data.plugins[0]).toMatchObject({ id: "acme.tools", enabled: true, source: { kind: "github", owner: "acme", repo: "tools", commit: "a".repeat(40) } });
  expect(data.plugins[0].actions[0]).toMatchObject({ id: "tidy", contexts: ["pane"] });
  expect((await post({ op: "machines" })).data).toMatchObject({ self: "mac", machines: [{ id: "mac", label: "MacBook", local: true, version: "0.8.2" }] });
  await host.setEnabled("herdr-plugins", false);
  expect(await host.api(new Request("http://d/api/herdr-plugins", { method: "POST" }), new URL("http://d/api/herdr-plugins"), { op: "status" })).toBeUndefined();
});

test("on/off, logs (newest first), config folder, uninstall that says how to undo", async () => {
  const { post } = await start();
  rmSync(calls, { force: true });
  expect((await post({ op: "enable", id: "acme.tools", on: false })).data).toEqual({ ok: true });
  expect((await post({ op: "logs", id: "acme.tools" })).data.logs.map((l: any) => l.log_id)).toEqual(["l2", "l1"]);
  expect((await post({ op: "config-dir", id: "acme.tools" })).data.path).toBe("/tmp/cfg/acme.tools");
  expect((await post({ op: "remove", id: "acme.tools" })).data.undo).toEqual({ kind: "install", spec: "acme/tools", ref: "a".repeat(40), enabled: true });
  const log = readFileSync(calls, "utf8");
  expect(log).toContain("plugin disable acme.tools");
  expect(log).toContain("plugin uninstall acme.tools");
  // A plugin id is checked before it reaches the command line.
  expect((await post({ op: "enable", id: "$(rm -rf ~)", on: true })).status).toBe(500);
});

test("an install is pinned to a 40-character commit and runs as a job with its log", async () => {
  const { post } = await start();
  expect((await post({ op: "install", spec: "acme/tools", ref: "main" })).status).toBe(500);
  expect((await post({ op: "install", spec: "acme/../etc", ref: "b".repeat(40) })).status).toBe(500);
  rmSync(calls, { force: true });
  const job = (await post({ op: "install", spec: "acme/tools", ref: "b".repeat(40) })).data;
  expect(job.state).toBe("running");
  let j = job;
  for (let i = 0; i < 50 && j.state === "running"; i++) { await Bun.sleep(50); j = (await post({ op: "job", id: job.id })).data; }
  expect(j.state).toBe("done");
  expect(j.lines.join("\n")).toContain("Installed acme.tools from acme/tools.");
  expect(j.plugin).toMatchObject({ id: "acme.tools", name: "Acme Tools" });
  expect(readFileSync(calls, "utf8")).toContain(`plugin install acme/tools --ref ${"b".repeat(40)} --yes`);
});

test("an action for a session gets that pane as herdr's context, through the socket", async () => {
  const { post } = await start();
  invoked.length = 0;
  const { data } = await post({ op: "invoke", pluginId: "acme.tools", actionId: "tidy", key: "w1:p2" });
  expect(data.log.log_id).toBe("plugin-log-9");
  expect(invoked[0]).toMatchObject({ method: "plugin.action.invoke", params: { action_id: "tidy", plugin_id: "acme.tools", context: { invocation_source: "herdr-deck", focused_pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", focused_pane_cwd: "/work/api" } } });
  expect((await post({ op: "invoke", pluginId: "acme.tools", actionId: "tidy", key: "gone" })).status).toBe(500);
});

test("the hub asks another machine's deck, with the session key that machine knows", async () => {
  const sent: any[] = [];
  const remote = { conf: { id: "linux", label: "Linux" }, post: async (path: string, body: any) => { sent.push({ path, body }); return body.op === "status" ? { status: 200, data: { version: "0.7.5", platform: "linux", plugins: [] } } : { status: 200, data: { ok: true } }; } };
  const off = { conf: { id: "box", label: "Box" }, post: async () => ({ status: 404, data: {} }) };
  const { post } = await start({ get: (id: string) => (id === "linux" ? remote : id === "box" ? off : undefined), all: () => [remote, off] });
  const m = (await post({ op: "machines" })).data.machines;
  expect(m.map((x: any) => [x.id, x.version ?? null])).toEqual([["mac", "0.8.2"], ["linux", "0.7.5"], ["box", null]]);
  expect(m[2].error).toContain("Turn on “herdr plugins”");
  await post({ op: "invoke", machine: "linux", pluginId: "a.b", actionId: "x", key: "linux|w3:p1" });
  expect(sent.at(-1).body).toMatchObject({ op: "invoke", pluginId: "a.b", actionId: "x", key: "w3:p1" });
  expect(sent.at(-1).body.machine).toBeUndefined();
});
