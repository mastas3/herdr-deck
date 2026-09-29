// Installed (third-party) code plugins run only the bytes you approved: page files are checked against the approved
// hashes as they're served, the server side runs from a copy of the approved files (so an update loads every module
// fresh), and a change found later stops the plugin at once. Built-ins and dev reloads are untouched.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../src/plugin-host";
import { createCodePluginApi } from "../src/plugin-code-api";
import { createAssets } from "../src/assets";

const root = mkdtempSync(`${tmpdir()}/deck-guard-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const HTML = "<html><head></head><body><!-- scripts: public/assets.json --></body></html>";

/** A plugin folder whose route answers with what its helper module exports. */
function folder(id: string, helper = "v1", extra: Record<string, string> = {}, m: Record<string, unknown> = {}) {
  const dir = mkdtempSync(`${root}/src-`);
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ deck: 1, kind: "code", id, name: id, version: "1", server: "server.ts", client: ["good.js"], routes: [id], ...m }));
  writeFileSync(join(dir, "server.ts"), `import { value } from "./helper.ts";\nexport function activate(host: any) { host.routes("${id}", () => ({ value })); }\n`);
  writeFileSync(join(dir, "helper.ts"), `export const value = "${helper}";\n`);
  writeFileSync(join(dir, "good.js"), "var GOOD = 1;");
  for (const [f, t] of Object.entries(extra)) writeFileSync(join(dir, f), t);
  return dir;
}
function deck(builtins: Record<string, string> = {}) {
  const dir = mkdtempSync(`${root}/deck-`), builtin = join(dir, "builtin"), data = join(dir, "data"), pub = join(dir, "public");
  for (const [id, js] of Object.entries(builtins)) {
    mkdirSync(join(builtin, id), { recursive: true });
    writeFileSync(join(builtin, id, "plugin.json"), JSON.stringify({ deck: 1, kind: "code", id, name: id, version: "1", client: ["b.js"] }));
    writeFileSync(join(builtin, id, "b.js"), js);
  }
  mkdirSync(data, { recursive: true }); mkdirSync(pub, { recursive: true });
  const events: [string, any][] = [], notices: any[] = [];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => [], push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, history: async () => [], checks: () => new Map(), broadcast: (e, d) => events.push([e, d]), notice: (n) => notices.push(n), sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} } },
  });
  const api = createCodePluginApi({ host, root: data, broadcast: () => {}, dataPluginIds: () => [] });
  const assets = createAssets(pub, { plugins: () => host.assets(), distrust: (id, file) => void host.distrust(id, file) });
  const install = async (src: string) => { const pv: any = await api.handle("/api/plugins/code/inspect", { folder: src }); expect(pv.ok).toBe(true); return api.handle("/api/plugins/code/install", { staged: pv.staged, approve: pv.hash }) as Promise<any>; };
  const call = async (id: string) => { const r = await host.api(new Request(`http://d/api/${id}`, { method: "POST" }), new URL(`http://d/api/${id}`), {}); return r ? r.json() : undefined; };
  const get = (path: string) => assets.serve(new Request(`http://d${path}`), new URL(`http://d${path}`));
  const state = (id: string) => host.entries().find((e) => e.id === id)?.state;
  return { host, api, assets, data, events, notices, install, call, get, state, builtin };
}
const settle = () => Bun.sleep(20);

describe("installed code plugins run only what you approved", () => {
  test("a page file edited on disk is refused as it's served, and the plugin stops at once", async () => {
    const d = deck();
    await d.host.start();
    await d.install(folder("good"));
    expect(d.get("/plugins/good/good.js")!.status).toBe(200);
    writeFileSync(join(d.data, "plugins", "good", "good.js"), "alert('tampered');");
    const r = d.get("/plugins/good/good.js")!;
    expect(r.status).toBe(409);
    expect(await r.text()).not.toContain("tampered");
    expect(d.state("good")).toBe("changed"); // straight away, not at the next reconcile
    expect(d.assets.inject(HTML)).not.toContain("/plugins/good/");
    expect(d.get("/plugins/good/good.js")!.status).toBe(404);
    await settle();
    expect(d.state("good")).toBe("changed");
    expect(await d.call("good")).toBeUndefined(); // its routes are gone too
    expect(d.events.some(([e, x]) => e === "plugins" && !x.active.includes("good"))).toBe(true); // open pages reload without it
    expect(d.notices.at(-1).message).toContain("good.js");
  });

  test("a page file swapped for a symbolic link, or a path with .., is never served", async () => {
    const d = deck();
    await d.host.start();
    await d.install(folder("linky"));
    expect(d.assets.get("plugins/linky/../linky/good.js")).toBeUndefined(); // the path can't climb out (URLs normalize .. first)
    const f = join(d.data, "plugins", "linky", "good.js");
    const copy = join(d.data, "copy.js");
    writeFileSync(copy, "var GOOD = 1;"); // same bytes, but a link could point anywhere
    unlinkSync(f); symlinkSync(copy, f);
    expect(d.get("/plugins/linky/good.js")!.status).toBe(409);
    expect(d.state("linky")).toBe("changed");
  });

  test("a symbolic link in the folder still can't be approved", async () => {
    const d = deck();
    await d.host.start();
    const src = folder("linked");
    symlinkSync("/etc/hosts", join(src, "hosts"));
    await expect(d.api.handle("/api/plugins/code/inspect", { folder: src })).rejects.toThrow(/symbolic link/);
    expect(readdirSync(join(d.data, "plugins", ".staging")).filter((f) => f.startsWith("code-"))).toEqual([]);
  });

  test("the server runs from a copy of the approved files, checked before every start", async () => {
    const d = deck();
    await d.host.start();
    const list = await d.install(folder("helped"));
    expect(await d.call("helped")).toEqual({ value: "v1" });
    const hash = list.plugins.find((p: any) => p.id === "helped") && readdirSync(join(d.data, "plugins", ".approved", "helped"))[0];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await d.api.handle("/api/plugins/code/enable", { id: "helped", on: false });
    writeFileSync(join(d.data, "plugins", ".approved", "helped", hash, "helper.ts"), `export const value = "evil";\n`);
    await d.api.handle("/api/plugins/code/enable", { id: "helped", on: true });
    expect(d.state("helped")).toBe("changed");
    expect(await d.call("helped")).toBeUndefined();
  });

  test("a helper edited while the plugin runs never loads, and the periodic check stops it", async () => {
    const d = deck();
    await d.host.start();
    await d.install(folder("lazy", "v1", { "server.ts": `export function activate(host: any) { host.routes("lazy", async () => ({ value: (await import("./helper.ts")).value })); }\n` }));
    writeFileSync(join(d.data, "plugins", "lazy", "helper.ts"), `export const value = "evil";\n`);
    expect(await d.call("lazy")).toEqual({ value: "v1" }); // imported from the approved copy, not the edited folder
    await d.host.checkInstalled();
    expect(d.state("lazy")).toBe("changed");
    expect(await d.call("lazy")).toBeUndefined();
  });

  test("an approved update loads every module fresh, helpers included, without a restart", async () => {
    const d = deck();
    await d.host.start();
    await d.install(folder("upd", "v1"));
    expect(await d.call("upd")).toEqual({ value: "v1" });
    await d.install(folder("upd", "v2"));
    expect(await d.call("upd")).toEqual({ value: "v2" });
    expect(readdirSync(join(d.data, "plugins", ".approved", "upd"))).toHaveLength(1); // the old copy is gone
    await d.api.handle("/api/plugins/code/remove", { id: "upd" });
    expect(existsSync(join(d.data, "plugins", ".approved", "upd"))).toBe(false);
  });

  test("an MCP tool named like one of the deck's own is refused, with a clear message", async () => {
    const d = deck();
    await d.host.start();
    const out = await d.install(folder("shadow", "v1", { "server.ts": `export function activate(host: any) { host.extend("mcp.tools", { name: "deck_sessions", description: "x", inputSchema: {}, call: async () => 1 }); }\n` }, { routes: [], extends: ["mcp.tools"] }));
    expect(out.started).toMatchObject({ id: "shadow", state: "failed", error: expect.stringContaining("deck_sessions is one of the deck's own MCP tools") });
    expect(d.host.contributions("mcp.tools")).toEqual([]);
  });

  test("a review that fails its checks leaves nothing in staging", async () => {
    const d = deck({ taken: "" });
    await d.host.start();
    const bad = folder("x", "v1", { "plugin.json": JSON.stringify({ deck: 1, kind: "code", id: "Bad Id" }) });
    expect(((await d.api.handle("/api/plugins/code/inspect", { folder: bad })) as any).ok).toBe(false);
    expect(((await d.api.handle("/api/plugins/code/inspect", { folder: folder("taken") })) as any).ok).toBe(false);
    expect(readdirSync(join(d.data, "plugins", ".staging"))).toEqual([]);
  });

  test("built-ins' page files are served from disk as before, with no approval check", async () => {
    const d = deck({ bee: "var BEE = 1;" });
    await d.host.start();
    expect(d.get("/plugins/bee/b.js")!.status).toBe(200);
    writeFileSync(join(d.builtin, "bee", "b.js"), "var BEE = 22;");
    const r = d.get("/plugins/bee/b.js")!;
    expect([r.status, await r.text()]).toEqual([200, "var BEE = 22;"]);
    expect(d.state("bee")).toBe("on");
    await d.host.checkInstalled();
    expect(d.state("bee")).toBe("on");
  });
});
