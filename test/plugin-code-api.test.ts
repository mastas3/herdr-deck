import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../src/plugin-host";
import { createCodePluginApi } from "../src/plugin-code-api";
import { loadCodeState } from "../src/plugin-code-store";

const root = mkdtempSync(`${tmpdir()}/deck-codeapi-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function folder(id: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(`${root}/src-`);
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ deck: 1, kind: "code", id, name: "Hello", version: "0.1.0", server: "server.ts", client: ["hello.js"], routes: ["hello"] }));
  writeFileSync(join(dir, "server.ts"), `export function activate(host: any) { host.routes("hello", () => ({ hi: host.id })); }`);
  writeFileSync(join(dir, "hello.js"), "var HELLO = 1;");
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  return dir;
}
function deck(builtins: string[] = []) {
  const dir = mkdtempSync(`${root}/deck-`), builtin = join(dir, "builtin"), data = join(dir, "data");
  for (const id of builtins) { mkdirSync(join(builtin, id), { recursive: true }); writeFileSync(join(builtin, id, "plugin.json"), JSON.stringify({ deck: 1, kind: "code", id, name: id, version: "1" })); }
  mkdirSync(data, { recursive: true });
  const events: string[] = [];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => [], push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}) } },
  });
  const api = createCodePluginApi({ host, root: data, broadcast: (e) => events.push(e), dataPluginIds: () => ["taken-by-data"] });
  return { host, api, data, events };
}
const call = (h: ReturnType<typeof createPluginHost>, path: string) => h.api(new Request(`http://d${path}`, { method: "POST" }), new URL(`http://d${path}`), {});

describe("installing a code plugin", () => {
  test("from a folder: the trust screen lists every file and what it asks for; install runs exactly those bytes", async () => {
    const d = deck(["covers"]);
    await d.host.start();
    const pv: any = await d.api.handle("/api/plugins/code/inspect", { folder: folder("hello") });
    expect(pv.ok).toBe(true);
    expect(pv.trust).toContain("runs code on this machine with your full permissions");
    expect(pv.files.map((f: any) => f.path).sort()).toEqual(["hello.js", "plugin.json", "server.ts"]);
    expect(pv.manifest.routes).toEqual(["hello"]);
    await expect(d.api.handle("/api/plugins/code/install", { staged: pv.staged, approve: "0".repeat(64) })).rejects.toThrow(/changed since you reviewed/);
    const list: any = await d.api.handle("/api/plugins/code/install", { staged: pv.staged, approve: pv.hash });
    expect(list.plugins.find((p: any) => p.id === "hello")).toMatchObject({ state: "on", builtin: false, from: { folder: expect.any(String) } });
    expect(await (await call(d.host, "/api/hello"))!.json()).toEqual({ hi: "hello" });
    expect(Object.keys(loadCodeState(d.data).installed[0].files).sort()).toEqual(["hello.js", "plugin.json", "server.ts"]);
    expect(d.events).toContain("plugins"); // open pages reload to pick up its script
    // A file changed on disk turns it off until it's reviewed again.
    writeFileSync(join(d.data, "plugins", "hello", "hello.js"), "var HELLO = 2;");
    const after: any = await d.api.handle("/api/plugins/code/enable", { id: "hello", on: true });
    expect(after.plugins.find((p: any) => p.id === "hello").state).toBe("changed");
    expect(await call(d.host, "/api/hello")).toBeUndefined();
    const again: any = await d.api.handle("/api/plugins/code/inspect", { review: "hello" });
    await d.api.handle("/api/plugins/code/install", { staged: again.staged, approve: again.hash });
    expect(d.host.active()).toContain("hello");
    await d.api.handle("/api/plugins/code/remove", { id: "hello" });
    expect(existsSync(join(d.data, "plugins", "hello"))).toBe(false);
    expect(d.host.active()).not.toContain("hello");
  });

  test("names a built-in or a data plugin uses are refused", async () => {
    const d = deck(["covers"]);
    await d.host.start();
    expect(((await d.api.handle("/api/plugins/code/inspect", { folder: folder("covers") })) as any).problems[0].message).toContain("built-in");
    expect(((await d.api.handle("/api/plugins/code/inspect", { folder: folder("taken-by-data") })) as any).problems[0].message).toContain("data plugin");
    await expect(d.api.handle("/api/plugins/code/remove", { id: "covers" })).rejects.toThrow(/built-ins can be turned off/);
  });

  test("from git: only a full commit, and the checkout must be that commit", async () => {
    const repo = folder("from-git");
    const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo });
    git("init", "-q"); git("add", "."); git("commit", "-qm", "one");
    const commit = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();
    const d = deck();
    await d.host.start();
    await expect(d.api.handle("/api/plugins/code/inspect", { git: repo, commit: commit.slice(0, 12) })).rejects.toThrow(/40-character commit/);
    await expect(d.api.handle("/api/plugins/code/inspect", { git: "http://insecure.example/x.git", commit })).rejects.toThrow(/https/);
    const pv: any = await d.api.handle("/api/plugins/code/inspect", { git: repo, commit });
    expect(pv.ok).toBe(true);
    expect(pv.from).toEqual({ git: repo, commit });
    expect(pv.files.some((f: any) => f.path.startsWith(".git"))).toBe(false);
    await expect(d.api.handle("/api/plugins/code/inspect", { git: repo, commit: "f".repeat(40) })).rejects.toThrow();
  });

  test("a folder with a symbolic link can't be approved", async () => {
    const dir = folder("linky");
    Bun.spawnSync(["ln", "-s", "/etc/hosts", join(dir, "hosts")]);
    const d = deck();
    await d.host.start();
    await expect(d.api.handle("/api/plugins/code/inspect", { folder: dir })).rejects.toThrow(/symbolic link/);
  });
});
