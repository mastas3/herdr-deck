// The library plugin through the real plugin host: while it runs, the deck's shared library (the quest board, research,
// project pages, the Studio and the gallery read comparables from it) has its cards; switched off, it has none.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";
import { comparablesFor, libraryCards } from "../../../src/library-strategy";
import { openCards } from "../library-cards";
import { CARDS } from "../../../test/strategy-fixtures";

const root = mkdtempSync(`${tmpdir()}/deck-library-plugin-`);
const ENV = { DECK_LIBRARY_DIR: join(root, "library"), DECK_NO_LIBRARY: "1" };
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
afterAll(() => { rmSync(root, { recursive: true, force: true }); for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

describe("the library plugin", () => {
  test("shares its cards for comparables while on, and takes them back when turned off", async () => {
    mkdirSync(ENV.DECK_LIBRARY_DIR, { recursive: true });
    const db = openCards(`${ENV.DECK_LIBRARY_DIR}/cards.db`);
    for (const c of CARDS) db.put(c);
    db.close();
    const builtin = join(root, "builtin"), data = join(root, "data");
    mkdirSync(builtin, { recursive: true }); mkdirSync(data, { recursive: true });
    symlinkSync(new URL("../", import.meta.url).pathname, join(builtin, "library"));
    const host = createPluginHost({
      builtinDir: builtin, root: data, dataDir: data, log: () => {}, reservedState: ["rows", "plugins"],
      core: {
        rows: () => [], push: { deliver: async () => ({}) } as any, automations: () => undefined, decisions: () => [], isNode: () => false,
        machines: () => [{ id: "mac", label: "Mac", local: true, online: true }], history: async () => [], checks: () => new Map(),
        broadcast: () => {}, notice: () => {}, sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} },
      },
    });
    const target = { name: "Podcast clip maker", offer: "turns podcast episodes into short clips", btype: "saas" };
    expect(libraryCards()).toEqual([]);
    await host.start();
    expect(host.active()).toEqual(["library"]);
    expect(libraryCards().length).toBe(CARDS.length);
    expect(comparablesFor(target)?.comparables.length).toBeGreaterThan(0);
    expect(host.service("library")?.comparables(target)?.comparables.length).toBeGreaterThan(0);

    await host.setEnabled("library", false);
    expect(host.service("library")).toBeUndefined();
    expect(libraryCards()).toEqual([]);
    expect(comparablesFor(target)).toBeUndefined();
    await host.stop();
  });
});
