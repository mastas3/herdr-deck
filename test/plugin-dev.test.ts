// Writing a plugin: the scaffold (bin/new-plugin), dev folders, reloading one in place (src/plugin-dev.ts) and the
// file:line its failures point at.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost, framesIn } from "../src/plugin-host";
import { watchPlugins, type DevReload } from "../src/plugin-dev";

const root = mkdtempSync(`${tmpdir()}/deck-plugin-dev-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const core = { rows: () => [], push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, history: async () => [], checks: () => new Map(), sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any;
const REPO = new URL("..", import.meta.url).pathname;
const post = (host: any, id: string, body: unknown = {}) => host.api(new Request(`http://d/api/${id}`, { method: "POST" }), new URL(`http://d/api/${id}`), body);

function plugin(dir: string, id: string, value: string) {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "plugin.json"), JSON.stringify({ deck: 1, kind: "code", id, name: id, version: "1", server: "server.ts", client: ["p.js"], routes: [id] }));
  writeFileSync(join(dir, id, "lib.ts"), `export const value = ${JSON.stringify(value)};\n`);
  writeFileSync(join(dir, id, "server.ts"), `import { value } from "./lib.ts";\nexport function activate(host) {\n  host.routes("${id}", () => ({ value }));\n}\n`);
  writeFileSync(join(dir, id, "p.js"), "");
}

describe("plugin dev", () => {
  test("framesIn keeps the plugin's own frames, relative, without the reload query", () => {
    const e = new Error("x");
    e.stack = "Error: x\n    at activate (/p/a/server.ts?dev=3:12:5)\n    at y (/core/src/plugin-host.ts:1:1)\n    at file:///p/a/lib/z.js:9:2";
    expect(framesIn(e, "/p/a")).toEqual(["server.ts:12:5", "lib/z.js:9:2"]);
  });

  test("reload() starts a plugin again from its files as they are now, modules it imports included", async () => {
    const builtin = join(root, "b1"), data = join(root, "d1");
    mkdirSync(data, { recursive: true });
    plugin(builtin, "alpha", "one");
    const host = createPluginHost({ builtinDir: builtin, root: data, dataDir: data, log: () => {}, core });
    await host.start();
    expect(await (await post(host, "alpha"))!.json()).toEqual({ value: "one" });
    writeFileSync(join(builtin, "alpha", "lib.ts"), `export const value = "two";\n`);
    await host.reload("alpha");
    expect(await (await post(host, "alpha"))!.json()).toEqual({ value: "two" });
    // A failure to start says where, in the plugin's own files.
    writeFileSync(join(builtin, "alpha", "server.ts"), `export function activate(host) {\n  throw new Error("no key");\n}\n`);
    const e = await host.reload("alpha");
    expect([e.state, e.error, e.fault?.where[0], e.fault?.what]).toEqual(["failed", "no key", expect.stringMatching(/^server\.ts:2:\d+$/), "starting"]);
    expect(await post(host, "alpha")).toBeUndefined();
    await host.stop();
  });

  test("a route that throws is remembered on the plugin, with where", async () => {
    const builtin = join(root, "b2"), data = join(root, "d2");
    mkdirSync(data, { recursive: true });
    plugin(builtin, "beta", "x");
    writeFileSync(join(builtin, "beta", "server.ts"), `export function activate(host) {\n  host.routes("beta", () => {\n    throw new Error("bad input");\n  });\n}\n`);
    const host = createPluginHost({ builtinDir: builtin, root: data, dataDir: data, log: () => {}, core });
    await host.start();
    expect((await post(host, "beta"))!.status).toBe(500);
    const e = host.entries().find((x) => x.id === "beta")!;
    expect([e.state, e.fault?.message, e.fault?.what, e.fault?.where[0]]).toEqual(["on", "bad input", "/api/beta", expect.stringMatching(/^server\.ts:3:\d+$/)]);
    await host.stop();
  });

  test("editing files reloads just that plugin: server files restart it, page files don't", async () => {
    const builtin = join(root, "b3"), data = join(root, "d3");
    mkdirSync(data, { recursive: true });
    plugin(builtin, "gamma", "one");
    const host = createPluginHost({ builtinDir: builtin, root: data, dataDir: data, log: () => {}, core });
    await host.start();
    const seen: DevReload[] = [];
    const stop = watchPlugins({ host, dirs: [builtin], log: () => {}, onReload: (r) => seen.push(r) });
    await Bun.sleep(100);
    writeFileSync(join(builtin, "gamma", "lib.ts"), `export const value = "three";\n`);
    for (let i = 0; i < 40 && !seen.length; i++) await Bun.sleep(50);
    expect(seen[0]).toMatchObject({ id: "gamma", server: true, state: "on" });
    expect(await (await post(host, "gamma"))!.json()).toEqual({ value: "three" });
    writeFileSync(join(builtin, "gamma", "p.js"), "// changed");
    writeFileSync(join(builtin, "gamma", "test.tmp"), "editor droppings are ignored");
    for (let i = 0; i < 40 && seen.length < 2; i++) await Bun.sleep(50);
    await Bun.sleep(300);
    expect(seen.slice(1)).toEqual([expect.objectContaining({ id: "gamma", server: false })]);
    stop();
    await host.stop();
  });

  test("bin/new-plugin makes a local plugin that a dev folder runs, and its own test passes", async () => {
    const dev = join(root, "dev");
    mkdirSync(dev);
    const made = Bun.spawnSync(["bun", join(REPO, "bin/new-plugin"), "my-notes", "--name", "My Notes", "--dir", dev]);
    expect(made.exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", join(REPO, "bin/new-plugin"), "close"]).exitCode).toBe(1); // a core route
    expect(Bun.spawnSync(["bun", join(REPO, "bin/new-plugin"), "my-notes", "--dir", dev]).exitCode).toBe(1); // exists
    const data = join(root, "d4");
    mkdirSync(data);
    const host = createPluginHost({ builtinDir: join(root, "none"), root: data, dataDir: data, log: () => {}, core, devDirs: [dev] });
    await host.start();
    expect(host.active()).toEqual(["my-notes"]);
    expect(host.entries()[0].dev).toBe(true);
    expect(host.assets()[0]).toMatchObject({ scripts: ["my-notes.js"], styles: ["my-notes.css"] });
    expect(await (await post(host, "my-notes", { op: "hello" }))!.json()).toEqual({ message: "Hello from my-notes", count: 1 });
    await host.stop();
    const t = Bun.spawnSync(["bun", "test", join(dev, "my-notes")], { cwd: REPO });
    expect(t.exitCode).toBe(0);
  });
});
