// Private sessions through the real plugin host with a scratch HOME: follows a private row, marks it closed when it
// goes, and deletes only after a confirm and once the session is closed.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-pv-plugin-`);
afterAll(() => { rmSync(root, { recursive: true, force: true }); delete process.env.DECK_PRIVATE_HOME; });

test("prepare, follow, closed event, delete only when confirmed and closed", async () => {
  const builtin = join(root, "builtin"), data = join(root, "data"), home = join(root, "home");
  for (const d of [builtin, data, home]) mkdirSync(d);
  process.env.DECK_PRIVATE_HOME = home;
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "private-session"));
  const rows: any[] = [], events: any[] = [];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => rows, push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: (e: string, d: any) => events.push([e, d]), notice: () => {}, history: async () => [], checks: () => new Map(),
      sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any,
  });
  await host.start();
  const post = async (body: any) => { const r = await host.api(new Request("http://d/api/private-session", { method: "POST" }), new URL("http://d/api/private-session"), body); return { status: r!.status, j: (await r!.json()) as any }; };
  const { cwd } = (await post({ op: "prepare" })).j;
  expect(cwd).toStartWith(join(data, "private", "deck-private-"));
  expect(existsSync(cwd)).toBe(true);

  rows.push({ key: "h/p", agent: "claude", cwd, title: "tax letter" });
  expect((await post({ op: "list" })).j.sessions).toMatchObject([{ cwd, key: "h/p", live: true }]);
  const enc = cwd.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(home, ".claude/projects", enc), { recursive: true });
  writeFileSync(join(home, ".claude/projects", enc, "11111111-2222-3333-4444-555555555555.jsonl"), "{}");
  const files = (await post({ op: "files", cwd })).j.files;
  expect(files).toHaveLength(3);
  expect((await post({ op: "delete", cwd, files, confirmed: true })).j.error).toBe("Close the session first");

  rows.length = 0;
  expect((await post({ op: "list" })).j.sessions[0]).toMatchObject({ live: false });
  expect(events).toContainEqual(["private-session", { closed: cwd }]);
  expect((await post({ op: "delete", cwd, files })).status).toBe(400);
  expect(existsSync(cwd)).toBe(true);
  expect((await post({ op: "delete", cwd, files, confirmed: true })).j.deleted).toHaveLength(3);
  expect(existsSync(cwd)).toBe(false);
  expect((await post({ op: "list" })).j.sessions[0].title).toBeUndefined(); // no trace of what it was about
  expect((await post({ op: "files", cwd: join(root, "home") })).status).toBe(400); // only its own folders

  await host.setEnabled("private-session", false);
  expect(host.timers("private-session")).toBe(0);
});
