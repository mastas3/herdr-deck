// Worker fan-out through the real plugin host with stubbed sessions: nothing real starts or is sent.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-fanout-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("plans, starts only when confirmed, tracks markers and collects into one stubbed send", async () => {
  const builtin = join(root, "builtin"), data = join(root, "data"), a = join(root, "a"), b = join(root, "b");
  for (const d of [builtin, data, a, b]) mkdirSync(d);
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "worker-fanout"));
  const started: any[] = [], sent: [string, string][] = [], rows: any[] = [];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => rows, push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, history: async () => [], checks: () => new Map(),
      sessions: { start: async (o: any) => { started.push(o); const key = `h/w${started.length}`; rows.push({ key }); return { key }; }, send: async (k: string, t: string) => { sent.push([k, t]); }, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any,
  });
  await host.start();
  const post = async (body: any) => { const r = await host.api(new Request("http://d/api/worker-fanout", { method: "POST" }), new URL("http://d/api/worker-fanout"), body); return { status: r!.status, j: (await r!.json()) as any }; };
  const spec = { title: "Audit", brief: "Check every route for auth.", workers: [{ cwd: a, kind: "claude" }, { cwd: b, kind: "codex", model: "gpt-x" }] };

  expect((await post({ op: "plan", ...spec, workers: [{ cwd: join(root, "nope") }] })).j.error).toContain("folder not found");
  const plan = (await post({ op: "plan", ...spec })).j;
  expect(plan.workers.map((w: any) => w.cmd)).toEqual([`claude --add-dir ${plan.workers[0].dir}`, `codex -m gpt-x --add-dir ${plan.workers[1].dir}`]);
  expect((await post({ op: "start", ...spec, id: plan.id })).status).toBe(400);
  expect(started).toEqual([]);

  const run = (await post({ op: "start", ...spec, id: plan.id, confirmed: true })).j;
  expect(run.id).toBe(plan.id);
  expect(started.map((s) => [s.kind, s.cwd, s.model])).toEqual([["claude", a, undefined], ["codex", b, "gpt-x"]]);
  expect(started[1].prompt).toBe(plan.workers[1].prompt);
  expect(run.workers.map((w: any) => w.state)).toEqual(["running", "running"]);

  writeFileSync(join(plan.workers[0].dir, "REPORT.md"), "Routes a, b checked.");
  writeFileSync(join(plan.workers[0].dir, "DONE"), "");
  writeFileSync(join(plan.workers[1].dir, "REPORT.md"), "Blocked: no access.");
  writeFileSync(join(plan.workers[1].dir, "FAILED"), "");
  const got = (await post({ op: "get", id: run.id })).j;
  expect(got.workers.map((w: any) => [w.state, w.hasReport])).toEqual([["done", true], ["failed", true]]);
  expect((await post({ op: "report", id: run.id, n: 2 })).j.text).toBe("Blocked: no access.");

  const preview = (await post({ op: "collect", id: run.id })).j.text;
  expect(preview).toContain("(1 done, 1 failed)");
  expect(sent).toEqual([]);
  expect((await post({ op: "collect", id: run.id, send: true, key: "h/boss" })).status).toBe(400);
  expect((await post({ op: "collect", id: run.id, send: true, key: "h/boss", confirmed: true })).j).toEqual({ ok: true });
  expect(sent).toEqual([["h/boss", preview]]);

  await host.setEnabled("worker-fanout", false);
  expect(host.timers("worker-fanout")).toBe(0);
});
