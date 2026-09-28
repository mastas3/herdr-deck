// The covers plugin as the deck runs it: through the real plugin host, with its data in a scratch folder.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-covers-plugin-`);
afterAll(() => { rmSync(root, { recursive: true, force: true }); delete process.env.DECK_COVERS_DIR; });

describe("the covers plugin", () => {
  test("serves its files and controls, offers respond(), and when turned off stops its clock and all of it", async () => {
    const builtin = join(root, "builtin"), data = join(root, "data"), covers = join(root, "covers");
    mkdirSync(builtin, { recursive: true }); mkdirSync(data, { recursive: true }); mkdirSync(covers, { recursive: true });
    symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "covers"));
    writeFileSync(join(covers, "idea1.webp"), "W"); writeFileSync(join(covers, "idea1_thumb.webp"), "T");
    process.env.DECK_COVERS_DIR = covers;
    const host = createPluginHost({
      builtinDir: builtin, root: data, dataDir: data, log: () => {},
      core: { rows: () => [], push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}) } },
    });
    await host.start();
    expect(host.active()).toEqual(["covers"]);
    expect(host.timers("covers")).toBe(2);
    expect(host.assets()[0].scripts).toEqual(["covers.js"]);
    const get = (p: string) => host.get(new Request(`http://d${p}`), new URL(`http://d${p}`));
    const post = (body: unknown) => host.api(new Request("http://d/api/covers", { method: "POST" }), new URL("http://d/api/covers"), body);
    expect(await (await get("/covers/idea1.webp?v=1"))!.text()).toBe("W");
    expect((await get("/covers/nope.webp"))!.status).toBe(404);
    expect(((await (await post({}))!.json()) as any).count).toBe(1);
    expect((await post({ op: "explode" }))!.status).toBe(400);
    const svc = host.service<{ respond(d: unknown): Response }>("covers")!;
    const j: any = await svc.respond({ ideas: [{ id: "idea1", title: "T", pitch: "P", row: "saas" }] }).json();
    expect(j.ideas[0].coverUrl).toStartWith("/covers/idea1.webp?v=");
    expect(j.ideas[0].coverCat).toBe("saas");

    await host.setEnabled("covers", false);
    expect(host.timers("covers")).toBe(0);
    expect(host.service("covers")).toBeUndefined();
    expect(await get("/covers/idea1.webp")).toBeUndefined();
    expect(await post({})).toBeUndefined();
    expect(host.assets()).toEqual([]);
  });
});
