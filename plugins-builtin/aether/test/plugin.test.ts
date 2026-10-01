import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-aether-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("Aether has no control routes, timers or session calls, and disabling removes its surface", async () => {
  const builtin = join(root, "builtin"), data = join(root, "data");
  mkdirSync(builtin); mkdirSync(data);
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "aether"));
  const mutations: string[] = [];
  const host = createPluginHost({ builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => [], push: {}, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, history: async () => [], checks: () => new Map(), sessions: { start: async () => mutations.push("start"), send: async () => mutations.push("send"), close: async () => mutations.push("close"), keys: async () => mutations.push("keys") } } as any });
  await host.start();
  expect(host.active()).toEqual(["aether"]);
  expect(host.timers("aether")).toBe(0);
  expect(await host.api(new Request("http://d/api/aether", { method: "POST" }), new URL("http://d/api/aether"), {})).toBeUndefined();
  expect((await host.get(new Request("http://d/aether-art/server.ts"), new URL("http://d/aether-art/server.ts")))?.status).toBe(404);
  for (const name of ["world.webp", "aether.webp"]) {
    const image = await host.get(new Request(`http://d/aether-art/${name}`), new URL(`http://d/aether-art/${name}`));
    expect(image?.status).toBe(200);
    expect(image?.headers.get("content-type")).toBe("image/webp");
  }
  expect(mutations).toEqual([]);
  await host.setEnabled("aether", false);
  expect(host.active()).toEqual([]);
  expect(await host.get(new Request("http://d/aether-art/world.webp"), new URL("http://d/aether-art/world.webp"))).toBeUndefined();
});
