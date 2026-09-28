// The Files plugin as the deck runs it: through the real plugin host, answering about a live session's folder, and a
// hub passing a question about another machine's session on to that machine's deck (a second host, as a node).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";
import { claudeTranscript, makeRepo, put, scratch, sh, shAt } from "./fixtures";

const s = scratch("plugin");
afterAll(s.done);
const base = realpathSync(s.dir);
mkdirSync(join(base, "outside"));
const root = makeRepo(base, join(base, "outside"));
const transcript = join(base, "session.jsonl");
claudeTranscript(transcript, root);
put(root, "big.txt", Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n");
sh(root, "add", "big.txt");
shAt(root, "2026-09-28T09:00:00Z", "commit", "-q", "-m", "big", "--", "big.txt"); // after the session started (08:00)
put(root, "big.txt", Array.from({ length: 1000 }, (_, i) => `line ${i} changed`).join("\n") + "\n");
put(root, ".env", "SECRET=hunter2\n");
sh(root, "add", "-f", ".env"); // a tracked secret: its diff must still never be sent

const row = (key: string, extra: object = {}) => ({ key, agent: "claude", sessionId: "s1", cwd: root, hist: transcript, title: "t", project: "p", status: "idle", ...extra });
function makeHost(name: string, rows: () => any[]) {
  const builtin = join(base, `${name}-builtin`), data = join(base, `${name}-data`);
  mkdirSync(builtin, { recursive: true }); mkdirSync(data, { recursive: true });
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "files"));
  return createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows, push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => name === "node", broadcast: () => {}, notice: () => {}, sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} } },
  });
}
const call = async (host: ReturnType<typeof makeHost>, body: unknown) => {
  const r = (await host.api(new Request("http://d/api/files", { method: "POST" }), new URL("http://d/api/files"), body))!;
  return { status: r.status, data: (await r.json()) as any };
};

const hub = makeHost("hub", () => [row("here")]);
const node = makeHost("node", () => [row("n1", { key: "n1" })]);
const linux = { conf: { id: "linux", label: "Linux laptop" }, online: true, post: async (path: string, body: unknown) => {
  const r = await node.api(new Request(`http://n${path}`, { method: "POST" }), new URL(`http://n${path}`), body);
  if (!r) return { status: 404, data: {} };
  return { status: r.status, data: await r.json() };
} };
hub.provideCore("remotes", { get: (id: string) => (id === "linux" ? linux : undefined), all: () => [linux] });
await hub.start();
await node.start();

describe("the files plugin", () => {
  test("starts on any machine, with its page files", () => {
    expect(hub.active()).toEqual(["files"]);
    expect(node.active()).toEqual(["files"]);
    expect(hub.assets()[0].scripts).toContain("files-tree.js");
  });

  test("summary: the root listing, git state and the files the agent touched", async () => {
    const { status, data } = await call(hub, { op: "summary", key: "here" });
    expect(status).toBe(200);
    expect(data).toMatchObject({ root, repo: true, branch: "main" });
    expect(data.changed).toBeGreaterThanOrEqual(5);
    expect(data.entries.map((e: any) => e.name)).not.toContain("node_modules");
    expect(data.touched.map((t: any) => t.rel)).toEqual(["src/app.ts", "notes.ipynb", "src/lib/deep.ts", "src/new.ts"]);
    expect(JSON.stringify(data)).not.toContain("hunter2");
  });

  test("tree and find stay inside the folder", async () => {
    const src = await call(hub, { op: "tree", key: "here", dir: "src" });
    expect(src.data.entries.map((e: any) => e.name)).toContain("new.ts");
    for (const dir of ["..", "../outside", "/etc", "src/../..", "escape-link", ".git/../.."]) expect((await call(hub, { op: "tree", key: "here", dir })).status).toBe(400);
    const f = await call(hub, { op: "find", key: "here", q: "new" });
    expect(f.data.paths.map((p: any) => p.p)).toEqual(expect.arrayContaining(["src/new.ts", "src/new-name.ts"]));
    // The viewer's rule hides every .env* file (.env.example included): the filter never finds one.
    expect((await call(hub, { op: "find", key: "here", q: "env" })).data.paths).toEqual([]);
  });

  test("changes: every kind of change with counts; a secret listed without its content", async () => {
    const { data } = await call(hub, { op: "changes", key: "here" });
    const by = Object.fromEntries(data.files.map((f: any) => [f.path, f]));
    expect(by["src/app.ts"]).toMatchObject({ st: "M", add: 2, del: 1 });
    expect(by["src/new.ts"]).toMatchObject({ st: "?", add: 2, del: 0 });
    expect(by["gone.txt"]).toMatchObject({ st: "D", del: 1 });
    expect(by["src/new-name.ts"]).toMatchObject({ st: "R", old: "src/old-name.ts" });
    expect(by[".env"]).toMatchObject({ secret: true });
    expect(by[".env"].add).toBeUndefined();
    expect(data.add).toBeGreaterThan(1000);
  });

  test("diff: pages of lines, new files, and refusals", async () => {
    const d = await call(hub, { op: "diff", key: "here", path: "src/app.ts" });
    expect(d.data.lines.filter((l: any) => l[0] === "+").map((l: any) => l[1])).toEqual(["export const b = 20;", "export const d = 4;"]);
    const big = await call(hub, { op: "diff", key: "here", path: "big.txt" });
    expect(big.data.total).toBeGreaterThan(2000);
    expect(big.data.lines.length).toBe(400);
    const more = await call(hub, { op: "diff", key: "here", path: "big.txt", from: 400 });
    expect(more.data.from).toBe(400);
    expect(more.data.lines[0]).not.toEqual(big.data.lines[0]);
    const fresh = await call(hub, { op: "diff", key: "here", path: "src/new.ts", untracked: true });
    expect(fresh.data.lines[1]).toEqual(["+", "export const fresh = 1;", null, 1]);
    for (const path of [".env", "../outside/private.txt", "/etc/passwd", "escape-link"]) {
      const r = await call(hub, { op: "diff", key: "here", path, untracked: true });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.data)).not.toContain("hunter2");
    }
  });

  test("since the session started: commits the agent made count too", async () => {
    // The session started (08:00) after "first" and before "big": both big.txt and the agent's own commit count.
    sh(root, "add", "src/app.ts");
    shAt(root, "2026-09-28T10:00:00Z", "commit", "-q", "-m", "agent commit");
    const now = await call(hub, { op: "changes", key: "here" });
    expect(now.data.files.map((f: any) => f.path)).not.toContain("src/app.ts");
    const since = await call(hub, { op: "changes", key: "here", since: "start" });
    expect(since.data.label).toBe("Since this session started");
    expect(since.data.files.map((f: any) => f.path)).toEqual(expect.arrayContaining(["src/app.ts", "big.txt"]));
  });

  test("unknown sessions and requests are refused", async () => {
    expect((await call(hub, { op: "summary", key: "nope" })).status).toBe(404);
    expect((await call(hub, { op: "explode", key: "here" })).status).toBe(400);
    expect((await call(hub, { op: "summary" })).status).toBe(404);
  });

  test("another machine's session is answered by that machine's deck", async () => {
    const r = await call(hub, { op: "summary", key: "linux|n1" });
    expect(r.status).toBe(200);
    expect(r.data.root).toBe(root);
    expect((await call(hub, { op: "summary", key: "linux|missing" })).status).toBe(404);
    expect((await call(hub, { op: "summary", key: "mars|n1" })).status).toBe(404); // not a machine: a local key that isn't open
    await node.setEnabled("files", false);
    const off = await call(hub, { op: "summary", key: "linux|n1" });
    expect(off.status).toBe(409);
    expect(off.data.error).toContain("Linux laptop");
    linux.online = false;
    linux.post = async () => { throw new Error("Linux laptop is offline: no route"); };
    expect((await call(hub, { op: "summary", key: "linux|n1" })).data.error).toContain("offline");
  });

  test("a folder outside home or /tmp is refused", async () => {
    const h = makeHost("etc", () => [row("etc", { cwd: "/etc" })]);
    await h.start();
    const r = await call(h, { op: "summary", key: "etc" });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain("outside your home");
  });
});
