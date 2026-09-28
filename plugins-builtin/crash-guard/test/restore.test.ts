// Restoring after a crash, end to end against a fake herdr (test/fake-herdr.ts): the core's own Reopen
// (src/http/sessions.ts openTab) opens each tab, waits for its shell and types the resume command. Nothing real is
// touched. Checks: the right command reaches the right new tab, in order, never more than `atOnce` at a time, a
// missing workspace is made once, and a partial failure leaves exactly the failed ones for Retry.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { call } from "../../../src/herdr";
import { createSessions } from "../../../src/http/sessions";
import { startFakeHerdr, type FakeState } from "../../../test/fake-herdr";
import { createRestorer, type Job } from "../restore";
import { restoreCommand } from "../snapshot";
import { pane } from "./fixture";

const dir = mkdtempSync(`${tmpdir()}/deck-cg-`);
const socket = `${dir}/herdr.sock`;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Before the crash: workspace "1" (w1) with three sessions, "infra" (w2) with two and an empty shell.
const before = [
  pane({ key: "default/a", paneId: "a", tabNumber: 1, cwd: "/work/app", tab: "app", sessionId: "s-a", resume: "claude --resume s-a", command: "claude --model opus" }),
  pane({ key: "default/b", paneId: "b", tabNumber: 2, cwd: "/work/api", tab: "api", agent: "codex", sessionId: "019a-b", resume: "codex resume 019a-b", command: "codex -s workspace-write" }),
  pane({ key: "default/c", paneId: "c", tabNumber: 3, cwd: "/work/broken-one", tab: "broken", sessionId: "s-c", resume: "claude --resume s-c" }),
  pane({ key: "default/d", paneId: "d", tabNumber: 1, workspaceId: "w2", workspace: "infra", cwd: "/work/infra", tab: "infra", sessionId: "s-d", resume: "claude --resume s-d" }),
  pane({ key: "default/e", paneId: "e", tabNumber: 2, workspaceId: "w2", workspace: "infra", cwd: "/work/broken-two", tab: "", sessionId: "s-e", resume: "claude --resume s-e" }),
  pane({ key: "default/f", paneId: "f", tabNumber: 3, workspaceId: "w2", workspace: "infra", cwd: "/work/ops", tab: "ops", sessionId: "s-f", resume: "claude --resume s-f" }),
];

describe("restoring a snapshot through the core's Reopen", () => {
  test("right commands to the right new tabs, in order, rate-limited; a partial failure retries only the rest", async () => {
    const fake = startFakeHerdr(socket); // a herdr that just restarted: workspace "1", one empty shell
    fake.delay(250); // each new shell takes a moment to draw its prompt
    fake.fail(["broken"]);
    const sess: any = { name: "default", socket, online: true, snap: undefined };
    const deck: any = { sessions: new Map([["default", sess]]), rows: new Map(), find: () => undefined, kick: async () => { sess.snap = (await call(socket, "session.snapshot")).snapshot; } };
    await deck.kick();
    const sessions = createSessions({ deck, graves: { list: [], save() {} } as any, remotes: new Map(), broadcastGraves() {}, notice() {} });
    const seen: Job[] = [];
    const workspaces = () => new Set((sess.snap as FakeState).workspaces.flatMap((w) => [w.workspace_id, w.label]));
    const r = createRestorer({ machine: "mac", reopen: (o) => sessions.openTab(o), workspaces, changed: (j) => seen.push(structuredClone(j)), gapMs: 30 });

    const job = r.start("snap1", before, 2);
    const waitIdle = async () => { for (let i = 0; i < 400 && (r.job()!.running || seen.length === 0); i++) await Bun.sleep(25); };
    await Bun.sleep(50);
    await waitIdle();
    const j = r.job()!;
    expect(j.id).toBe(job.id);
    expect(j.items.map((x) => [x.key, x.state])).toEqual([
      ["default/a", "done"], ["default/b", "done"], ["default/c", "failed"], ["default/d", "done"], ["default/e", "failed"], ["default/f", "done"],
    ]);
    expect(j.items.find((x) => x.key === "default/c")!.error).toContain("could not start a shell");

    // What herdr was asked: "infra" is made once (by its first session), tabs in order, each command after its prompt.
    const calls = fake.calls.filter((c) => ["workspace.create", "tab.create", "pane.send_input"].includes(c.method));
    expect(calls.filter((c) => c.method === "workspace.create").map((c) => c.params)).toEqual([{ cwd: "/work/infra", label: "infra", focus: false }]);
    const tabs = calls.filter((c) => c.method === "tab.create").map((c) => [c.params.cwd, c.params.label]);
    expect(tabs).toEqual([["/work/app", "app"], ["/work/api", "api"], ["/work/broken-one", "broken"], ["/work/broken-two", "p"], ["/work/ops", "ops"]]);
    const state = fake.state;
    const paneAt = (cwd: string) => state.panes.find((p) => p.cwd === cwd)!;
    const sent = calls.filter((c) => c.method === "pane.send_input").map((c) => [state.panes.find((p) => p.pane_id === c.params.pane_id)?.cwd, c.params.text, c.params.keys]);
    expect(sent).toEqual([
      ["/work/infra", "claude --resume s-d", ["enter"]],
      ["/work/app", "claude --resume s-a --model opus", ["enter"]],
      ["/work/api", "codex resume -s workspace-write 019a-b", ["enter"]],
      ["/work/ops", "claude --resume s-f", ["enter"]],
    ]);
    // Each went into the right workspace: infra's in the one it made, the rest in "1".
    const infra = state.workspaces.find((w) => w.label === "infra")!.workspace_id;
    expect([paneAt("/work/infra").workspace_id, paneAt("/work/ops").workspace_id]).toEqual([infra, infra]);
    expect([paneAt("/work/app").workspace_id, paneAt("/work/api").workspace_id]).toEqual(["w1", "w1"]);
    // Nothing was typed before that pane's shell had drawn its prompt (pane.read returned text).
    for (const c of fake.calls.filter((x) => x.method === "pane.send_input")) {
      const reads = fake.calls.filter((x) => x.method === "pane.read" && x.params.pane_id === c.params.pane_id && x.at <= c.at);
      expect(reads.length).toBeGreaterThan(1);
    }
    // Rate limit: never more than two sessions opening at once.
    const spans = j.items.map((x) => [x.startedAt!, x.endedAt!]);
    for (const [s] of spans) expect(spans.filter(([a, b]) => a <= s && s < b).length).toBeLessThanOrEqual(2);
    expect(Math.max(...seen.map((x) => x.items.filter((i) => i.state === "opening").length))).toBe(2);

    // Retry: only the two that failed go again, and now they open.
    fake.fail([]);
    const before2 = fake.calls.filter((c) => c.method === "tab.create").length;
    r.retry(j.id);
    await Bun.sleep(50);
    await waitIdle();
    expect(r.job()!.items.every((x) => x.state === "done")).toBe(true);
    const again = fake.calls.filter((c) => c.method === "tab.create").slice(before2).map((c) => c.params.cwd);
    expect(again).toEqual(["/work/broken-one", "/work/broken-two"]);
    expect(restoreCommand(before[2])).toBe("claude --resume s-c");
    fake.stop();
  }, 30_000);
});
