// The projects and quests plugins as the deck runs them: through the real plugin host, data in a scratch folder.
// Quests needs projects: with project pages off, the quest board is failed and none of it is left running.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-projects-plugin-`);
const ENV = { DECK_JOURNEY_DIR: join(root, "journeys"), DECK_GAME_DIR: join(root, "game"), DECK_WIKI_DIR: join(root, "wiki"), DECK_PROJECTS_DIR: join(root, "projects"), DECK_GAME_AI: "0", DECK_JOURNEY_AI: "0" };
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);
afterAll(() => { rmSync(root, { recursive: true, force: true }); for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

function setup(ids: string[]) {
  const builtin = join(root, `builtin-${ids.join("-")}`), data = join(root, `data-${ids.join("-")}`);
  mkdirSync(builtin, { recursive: true }); mkdirSync(data, { recursive: true });
  for (const id of ids) symlinkSync(new URL(`../../${id}`, import.meta.url).pathname, join(builtin, id));
  const events: string[] = [];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {}, reservedState: ["rows", "plugins"],
    core: {
      rows: () => [], push: { deliver: async () => ({}) } as any, automations: () => undefined, decisions: () => [], isNode: () => false,
      machines: () => [{ id: "mac", label: "Mac", local: true, online: true }], history: async () => [], checks: () => new Map(),
      broadcast: (e) => events.push(e), notice: () => {}, sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}) },
    },
  });
  const post = (path: string, body: unknown = {}) => host.api(new Request(`http://d${path}`, { method: "POST" }), new URL(`http://d${path}`), body);
  return { host, post, events };
}

describe("the projects plugin", () => {
  test("serves /p, its API and the journeys service, and when turned off none of it is left", async () => {
    const { host, post } = setup(["projects"]);
    await host.start();
    expect(host.active()).toEqual(["projects"]);
    expect(host.assets()[0]).toMatchObject({ scripts: ["journey.js", "journey-graph.js", "journey-page.js", "journey-plan-comparables.js"], styles: ["journey.css"] });
    expect(host.isPage("/p") && host.isPage("/p/acme") && !host.isPage("/pp")).toBe(true);
    expect(Array.isArray(((await (await post("/api/journeys"))!.json()) as any).projects)).toBe(true);
    expect(((await (await post("/api/journey"))!.json()) as any)).toMatchObject({ error: "Which project?", plugin: "projects" });
    expect(typeof host.service("journeys")?.index).toBe("function");
    expect(host.timers("projects")).toBe(0);

    await host.setEnabled("projects", false);
    expect(host.service("journeys")).toBeUndefined();
    expect(await post("/api/journeys")).toBeUndefined();
    expect(host.isPage("/p")).toBe(false);
    expect(host.assets()).toEqual([]);
  });
});

describe("the quests plugin", () => {
  test("runs on the host's clock with its state, digest lines and API, and fails without project pages", async () => {
    const { host, post, events } = setup(["projects", "quests"]);
    host.provideCore("discover", { leadsSaved: { get: () => [] } });
    await host.start();
    expect(host.active()).toEqual(["projects", "quests"]);
    expect(host.timers("quests")).toBe(1);
    expect(host.assets().map((a) => a.id)).toEqual(["projects", "quests"]);
    expect(host.state()).toHaveProperty("game");
    expect(host.contributions("digest.lines")).toMatchObject([{ title: "Today's quests", pref: "questDigest" }]);
    const board: any = await (await post("/api/game", { tz: "UTC" }))!.json();
    expect(board.level.name).toBe("Maker");
    expect(events).toContain("game"); // the header chip's live updates: its own SSE event, no longer the core's
    expect(typeof host.service("game")?.mkdirRun).toBe("function");

    await host.setEnabled("projects", false);
    const q = host.entries().find((e) => e.id === "quests")!;
    expect(q.state).toBe("failed");
    expect(q.error).toBe("Needs Projects (off)");
    expect(host.active()).toEqual([]);
    expect(host.timers("quests")).toBe(0);
    expect(host.state()).toEqual({});
    expect(host.contributions("digest.lines")).toEqual([]);
    expect(host.service("game")).toBeUndefined();
    expect(await post("/api/game")).toBeUndefined();
    expect(host.assets()).toEqual([]);

    await host.setEnabled("projects", true);
    expect(host.active()).toEqual(["projects", "quests"]);
    await host.stop();
  });
});
