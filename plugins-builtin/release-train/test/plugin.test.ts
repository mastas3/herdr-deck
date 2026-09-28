// Release train through the real plugin host, on a scratch git repo with qa/staging/main and a local health URL.
// Sessions are stubs: promote starts nothing real, and no deploy command ever runs.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-release-train-`);
const srv = Bun.serve({ port: 0, fetch: (r) => new Response("ok", { status: new URL(r.url).pathname === "/health" ? 200 : 503 }) });
afterAll(() => { srv.stop(true); rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", "-C", cwd, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "Dana", GIT_AUTHOR_EMAIL: "d@x", GIT_COMMITTER_NAME: "Dana", GIT_COMMITTER_EMAIL: "d@x" } }); if (r.exitCode) throw new Error(r.stderr.toString()); };

test("board, check on demand, promote only when confirmed", async () => {
  const builtin = join(root, "builtin"), data = join(root, "data"), repo = join(root, "dialer");
  for (const d of [builtin, data, repo]) mkdirSync(d);
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "release-train"));
  git(repo, "init", "-q", "-b", "main");
  const commit = (m: string) => { writeFileSync(join(repo, "f.txt"), m); git(repo, "add", "."); git(repo, "commit", "-qm", m); };
  commit("one"); git(repo, "tag", "v1.0"); git(repo, "branch", "staging");
  commit("two"); commit("three"); git(repo, "branch", "qa");
  git(repo, "reset", "-q", "--hard", "v1.0"); // main (production) stays at v1.0
  const started: any[] = [];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => [], push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, history: async () => [], checks: () => new Map(),
      sessions: { start: async (o: any) => { started.push(o); return { key: "h/p" }; }, send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any,
  });
  await host.start();
  const post = async (body: any) => { const r = await host.api(new Request("http://d/api/release-train", { method: "POST" }), new URL("http://d/api/release-train"), body); return { status: r!.status, j: (await r!.json()) as any }; };
  const url = `http://127.0.0.1:${srv.port}`;
  expect((await post({ op: "save", project: { name: "Dialer", repo, stages: [{ name: "QA", ref: "qa", check: "echo fine" }, { name: "Staging", ref: "staging", health: `${url}/health` }, { name: "Production", ref: "v*", health: `${url}/down`, deploy: "touch DEPLOYED" }] } })).j.ok).toBe(true);
  expect((await post({ op: "save", project: { name: "X", repo: join(root, "nope"), stages: [{ name: "a", ref: "a" }, { name: "b", ref: "b" }] } })).j.error).toContain("Folder not found");

  const b = (await post({ op: "board", id: "dialer" })).j;
  expect(b.stages.map((s: any) => [s.name, s.at, s.commit?.subject])).toEqual([["QA", "qa", "three"], ["Staging", "staging", "one"], ["Production", "v1.0", "one"]]);
  expect(b.stages[2].tags).toEqual(["v1.0"]);
  expect(b.gaps.map((g: any) => g.n)).toEqual([2, 0]);
  expect(b.gaps[0].commits.map((c: any) => c.subject)).toEqual(["three", "two"]);
  expect(b.stages[1].health).toMatchObject({ ok: true, status: 200 });
  expect(b.stages[2].health).toMatchObject({ ok: false, status: 503 });

  expect((await post({ op: "check", id: "dialer", stage: 0 })).status).toBe(400);
  expect((await post({ op: "check", id: "dialer", stage: 0, confirmed: true })).j).toEqual({ ok: true, code: 0, out: "fine" });

  const plan = (await post({ op: "plan", id: "dialer", from: 0 })).j;
  expect(plan).toMatchObject({ kind: "codex", cmd: "codex", from: "QA", to: "Staging", n: 2 });
  expect(plan.brief).toContain("- ");
  expect((await post({ op: "promote", id: "dialer", from: 0 })).status).toBe(400);
  expect(started).toEqual([]);
  expect((await post({ op: "promote", id: "dialer", from: 1, confirmed: true })).j).toEqual({ ok: true, key: "h/p" });
  expect(started[0]).toMatchObject({ kind: "codex", cwd: repo });
  expect(started[0].prompt).toContain("`touch DEPLOYED`");
  expect(Bun.file(join(repo, "DEPLOYED")).size).toBe(0); // the deck never ran it
  expect(await Bun.file(join(repo, "DEPLOYED")).exists()).toBe(false);
});
