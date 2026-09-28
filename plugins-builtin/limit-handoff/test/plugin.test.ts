// Limit handoff through the real plugin host: it watches rows for limit lines, and only sends after a confirm (stubbed).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-limit-handoff-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("state, note, ask only when confirmed", async () => {
  const builtin = join(root, "builtin"), data = join(root, "data");
  mkdirSync(builtin); mkdirSync(data);
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "limit-handoff"));
  const sent: [string, string][] = [], events: any[] = [];
  const rows = [{ key: "h/1", agent: "claude", project: "acme", title: "retries", cwd: "/r", tail: ["Claude usage limit reached. Your limit will reset at 3pm."] }, { key: "h/2", agent: "codex", tail: ["all good"] }];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => rows as any, push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: (e: string, d: any) => events.push([e, d]), notice: () => {}, history: async () => [], checks: () => new Map(),
      sessions: { start: async () => ({}), send: async (k: string, t: string) => { sent.push([k, t]); }, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any,
  });
  await host.start();
  const post = async (body: any) => { const r = await host.api(new Request("http://d/api/limit-handoff", { method: "POST" }), new URL("http://d/api/limit-handoff"), body); return { status: r!.status, j: (await r!.json()) as any }; };
  expect(host.contributions("fullState").map((c: any) => c.get())).toEqual([{ threshold: 90, hits: {} }]);
  // state scans now (the timer scans 5 s after start, then every 20 s)
  expect((await post({ op: "state" })).j.hits).toEqual({ "h/1": "Claude usage limit reached. Your limit will reset at 3pm." });
  expect(events[0][0]).toBe("limit-handoff");

  const note = (await post({ op: "note", key: "h/1", target: "codex", messages: [{ role: "user", text: "Add retries" }] })).j.note;
  expect(note).toContain("You are Codex.");
  expect((await post({ op: "note", key: "gone" })).status).toBe(400);

  expect((await post({ op: "ask", key: "h/1", target: "codex" })).j.text).toContain("HANDOFF NOTE");
  expect((await post({ op: "ask", key: "h/1", send: true })).status).toBe(400);
  expect(sent).toEqual([]);
  expect((await post({ op: "ask", key: "h/1", target: "codex", send: true, confirmed: true })).j.ok).toBe(true);
  expect(sent[0][0]).toBe("h/1");
  expect((await post({ op: "find", askedAt: 0, messages: [{ role: "assistant", text: "HANDOFF NOTE\nx" }] })).j.note).toBe("x");

  await host.setEnabled("limit-handoff", false);
  expect(host.timers("limit-handoff")).toBe(0);
  expect(host.contributions("fullState")).toEqual([]);
});
