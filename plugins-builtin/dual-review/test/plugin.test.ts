// Dual review through the real plugin host, in a scratch data folder and a scratch git repo. Sessions are stubs:
// nothing real starts, and nothing is sent anywhere.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-dual-review-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("plans, starts two stubbed reviewers only when confirmed, groups their files and sends picks back", async () => {
  const builtin = join(root, "builtin"), data = join(root, "data"), repo = join(root, "repo");
  mkdirSync(builtin); mkdirSync(data); mkdirSync(repo);
  symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "dual-review"));
  git(repo, "init", "-q"); writeFileSync(join(repo, "a.ts"), "1\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "one");
  writeFileSync(join(repo, "a.ts"), "1\n2\n");
  const started: any[] = [], sent: [string, string][] = [];
  const rows = [{ key: "h/p1", title: "build pay" }];
  const host = createPluginHost({
    builtinDir: builtin, root: data, dataDir: data, log: () => {},
    core: { rows: () => rows as any, push: {} as any, automations: () => undefined, decisions: () => [], machines: () => [], isNode: () => false, broadcast: () => {}, notice: () => {}, history: async () => [], checks: () => new Map(),
      sessions: { start: async (o: any) => { started.push(o); const key = `h/${o.kind}`; rows.push({ key, title: o.label }); return { key }; }, send: async (k: string, t: string) => { sent.push([k, t]); }, close: async () => ({}), screen: async () => "", keys: async () => {} } } as any,
  });
  await host.start();
  expect(host.active()).toEqual(["dual-review"]);
  const post = async (body: any) => { const r = await host.api(new Request("http://d/api/dual-review", { method: "POST" }), new URL("http://d/api/dual-review"), body); return { status: r!.status, j: (await r!.json()) as any }; };

  expect((await post({ op: "diffstat", cwd: repo, range: "" })).j).toMatchObject({ files: 1 });
  expect((await post({ op: "diffstat", cwd: repo, range: "--x" })).j.error).toContain("isn’t a git ref");
  const plan = (await post({ op: "plan", cwd: repo, models: { codex: "gpt-x" } })).j;
  expect(plan.sessions.map((s: any) => s.cmd)).toEqual([`claude --add-dir ${plan.dir}`, `codex -m gpt-x --add-dir ${plan.dir}`]);
  expect(started).toEqual([]); // planning starts nothing

  expect((await post({ op: "start", cwd: repo, id: plan.id })).status).toBe(400); // no confirmation, no sessions
  expect(started).toEqual([]);
  const r = (await post({ op: "start", cwd: repo, id: plan.id, models: { codex: "gpt-x" }, origin: { key: "h/p1", title: "build pay" }, confirmed: true })).j;
  expect(r.id).toBe(plan.id);
  expect(started.map((s) => [s.kind, s.cwd, s.model, s.args])).toEqual([["claude", repo, undefined, ["--add-dir", plan.dir]], ["codex", repo, "gpt-x", ["--add-dir", plan.dir]]]);
  expect(started[0].prompt).toBe(plan.sessions[0].prompt);
  expect(r.sides.claude.status).toBe("waiting");

  writeFileSync(join(plan.dir, "claude.json"), JSON.stringify({ findings: [{ file: "a.ts", line: 2, severity: "high", title: "second line breaks the parser" }] }));
  writeFileSync(join(plan.dir, "codex.json"), JSON.stringify({ findings: [{ file: "a.ts", line: 2, severity: "medium", title: "parser breaks on the second line" }, { file: "b.ts", title: "no tests" }] }));
  const got = (await post({ op: "get", id: r.id })).j;
  expect(got.ready).toBe(true);
  expect(got.groups.map((g: any) => g.status)).toEqual(["agree", "codex"]);

  expect((await post({ op: "send", id: r.id, picks: [0] })).status).toBe(400); // unconfirmed
  expect((await post({ op: "send", id: r.id, picks: [0, 1], confirmed: true })).j).toEqual({ ok: true, n: 2 });
  expect(sent[0][0]).toBe("h/p1");
  expect(sent[0][1]).toContain("[both found, high] a.ts:2");
  expect((await post({ op: "list" })).j.reviews[0].sent[0].n).toBe(2);

  await host.setEnabled("dual-review", false);
  expect(host.timers("dual-review")).toBe(0);
  expect(await host.api(new Request("http://d/api/dual-review", { method: "POST" }), new URL("http://d/api/dual-review"), {})).toBeUndefined();
});
