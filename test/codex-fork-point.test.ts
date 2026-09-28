import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCodexLifecycle } from "../src/codex-lifecycle";
import { codexReplyHash, verifyCodexForkPoint } from "../src/codex-fork-point";
import { codexDetail } from "../src/transcript";
import { codexLifecycleApi } from "../src/http/codex-lifecycle";

const source = "01a0e943-5b84-7462-b625-7009c89d107d", child = "01a0e946-3f93-73b3-92c9-b58fb900ea66";
const point = { lastTurnId: "chosen-turn", replyHash: codexReplyHash("Chosen reply") };
const root = mkdtempSync(`${tmpdir()}/deck-fork-point-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(overrides: Record<string, any> = {}, receiptsFile?: string) {
  const calls: any[] = [];
  const request = async (method: string, params: any, mutation?: boolean) => {
    calls.push({ method, params, mutation });
    if (overrides[method]) return overrides[method](params);
    if (method === "thread/read") return { thread: { id: source, source: "vscode", cwd: root, name: "Source" } };
    if (method === "thread/fork") return { thread: { id: child, source: "vscode", cwd: root, name: "Fork" } };
    if (method === "thread/turns/list") return { data: params.threadId === source
      ? [{ id: "later-turn", status: "inProgress" }, { id: point.lastTurnId, status: "completed" }]
      : [{ id: point.lastTurnId, status: "completed" }], nextCursor: null };
    if (method === "thread/items/list") return { data: [{ turnId: point.lastTurnId, item: { type: "agentMessage", text: "Chosen reply" } }], nextCursor: null };
    return {};
  };
  const session = { request, close: async () => {} };
  return { calls, session, api: createCodexLifecycle({ receiptsFile, transport: async () => session }) };
}

describe("forking after a selected Codex reply", () => {
  test("forks a completed prefix directly and never rolls back or starts either task", async () => {
    const f = fixture();
    expect(await f.api.forkPoint(source, point, "selected-fork-001")).toMatchObject({ id: child });
    expect(f.calls.filter((c) => c.mutation)).toEqual([{ method: "thread/fork", params: { threadId: source, lastTurnId: point.lastTurnId, excludeTurns: true, threadSource: "herdr-deck" }, mutation: true }]);
    expect(f.calls.at(-1)).toMatchObject({ method: "thread/unsubscribe", params: { threadId: child } });
    expect(f.calls.some((c) => /rollback|revert|turn\/start|inject/.test(c.method))).toBe(false);
  });
  test("same receipt returns the same child even after source history changes; different content is rejected", async () => {
    let changed = false;
    const f = fixture({ "thread/read": () => { if (changed) throw new Error("Must not read again"); return { thread: { id: source, source: "vscode", cwd: root } }; } });
    const first = await f.api.forkPoint(source, point, "selected-fork-002"); changed = true;
    expect(await f.api.forkPoint(source, point, "selected-fork-002")).toEqual(first);
    await expect(f.api.forkPoint(source, { ...point, replyHash: codexReplyHash("Changed") }, "selected-fork-002")).rejects.toMatchObject({ code: "CODEX_INVALID" });
    expect(f.calls.filter((c) => c.method === "thread/fork")).toHaveLength(1);
  });
  test("missing, running, or changed selected replies cannot create a fork", async () => {
    const cases = [
      { "thread/turns/list": () => ({ data: [], nextCursor: null }) },
      { "thread/turns/list": () => ({ data: [{ id: point.lastTurnId, status: "inProgress" }], nextCursor: null }) },
      { "thread/items/list": () => ({ data: [{ turnId: point.lastTurnId, item: { type: "agentMessage", text: "Edited answer" } }], nextCursor: null }) },
      { "thread/items/list": () => ({ data: [{ turnId: "other-turn", item: { type: "agentMessage", text: "Chosen reply" } }], nextCursor: null }) },
    ];
    for (const overrides of cases) {
      const f = fixture(overrides);
      await expect(f.api.forkPoint(source, point, "selected-fork-stale")).rejects.toMatchObject({ code: "CODEX_STALE" });
      expect(f.calls.some((c) => c.mutation)).toBe(false);
    }
  });
  test("pagination finds the selected turn and its last assistant output without trusting partial history", async () => {
    const f = fixture({
      "thread/turns/list": (p: any) => p.cursor ? { data: [{ id: point.lastTurnId, status: "completed" }], nextCursor: null } : { data: [{ id: "later" }], nextCursor: "older-turns" },
      "thread/items/list": (p: any) => p.cursor ? { data: [{ turnId: point.lastTurnId, item: { type: "agentMessage", text: "Chosen reply" } }], nextCursor: null }
        : { data: [{ turnId: point.lastTurnId, item: { type: "commandExecution" } }], nextCursor: "older-items" },
    });
    await verifyCodexForkPoint(f.session, source, point);
    expect(f.calls.map((c) => c.params.cursor)).toEqual([undefined, "older-turns", undefined, "older-items"]);
  });
  test("an app version ignoring the fork boundary is reported as uncertain and never retried", async () => {
    const receiptsFile = `${root}/receipts.json`;
    const f = fixture({ "thread/turns/list": (p: any) => ({ data: [{ id: p.threadId === child ? "later-turn" : point.lastTurnId, status: "completed" }], nextCursor: null }) }, receiptsFile);
    await expect(f.api.forkPoint(source, point, "selected-fork-unsafe")).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    const next = fixture({}, receiptsFile);
    await expect(next.api.forkPoint(source, point, "selected-fork-unsafe")).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    expect(next.calls).toHaveLength(0);
  });
  test("repeated history cursors stop instead of looping or guessing a fork point", async () => {
    for (const method of ["thread/turns/list", "thread/items/list"]) {
      const f = fixture({ [method]: () => ({ data: [], nextCursor: "stuck" }) });
      await expect(f.api.forkPoint(source, point, "selected-fork-cursor")).rejects.toMatchObject({ code: "CODEX_STALE" });
      expect(f.calls.filter((c) => c.method === method)).toHaveLength(2);
      expect(f.calls.some((c) => c.mutation)).toBe(false);
    }
  });
  test("invalid selectors fail before any native process is contacted", async () => {
    const f = fixture();
    expect(() => f.api.forkPoint(source, { lastTurnId: "", replyHash: "fake" }, "selected-fork-invalid")).toThrow("Choose a completed Codex reply");
    expect(f.calls).toHaveLength(0);
  });
  test("HTTP action syncs the new child and does not require an idle later turn", async () => {
    const f = fixture(), synced: string[] = [];
    const hub: any = { codexLifecycle: f.api, deck: { syncAppThread: async (id: string) => { synced.push(id); } },
      codex: { watch: () => { throw new Error("Completed prefix needs no active turn mutation"); } } };
    const res = await codexLifecycleApi(hub, "/api/codex-fork-point", { key: `codex-app/${source}`, ...point, requestId: "selected-fork-http" });
    expect(await res!.json()).toEqual({ ok: true, id: child, key: `codex-app/${child}` }); expect(synced).toEqual([child]);
  });
});

describe("stable Codex reply boundaries in the transcript", () => {
  const event = (type: string, turn_id?: string) => ({ type: "event_msg", payload: { type, ...(turn_id ? { turn_id } : {}) } });
  const answer = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
  let serial = 0;
  async function parse(lines: any[]) { const file = `${root}/rollout-${++serial}.jsonl`; writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); return codexDetail(file); }
  test("only final assistant reply receives the explicit completed turn boundary", async () => {
    const d = await parse([event("task_started", "turn-one"), answer("Working"), answer("Final"), event("task_complete", "turn-one")]);
    expect(d.messages[0].forkAfterTurnId).toBeUndefined();
    expect(d.messages[1]).toMatchObject({ forkAfterTurnId: "turn-one", forkReplyHash: codexReplyHash("Final") });
  });
  test("missing, mismatched, aborted or id-less turn events never offer a fork boundary", async () => {
    for (const lines of [
      [event("task_started", "a"), answer("A"), event("task_complete")],
      [event("task_started", "a"), answer("A"), event("task_complete", "b")],
      [event("task_started", "a"), answer("A"), event("turn_aborted", "a")],
      [event("task_started", "a"), answer("A"), event("turn_aborted", "a"), event("task_complete", "a")],
      [event("task_started", "a"), answer("A"), event("task_complete"), event("task_complete", "a")],
      [event("task_started"), answer("A"), event("task_complete", "a")],
    ]) expect((await parse(lines)).messages.every((m) => !m.forkAfterTurnId)).toBe(true);
  });
  test("hash covers the full reply even when display text is truncated", async () => {
    const text = "A".repeat(25_000), d = await parse([event("task_started", "a"), answer(text), event("task_complete", "a")]);
    expect(d.messages[0].text!.length).toBeLessThan(text.length);
    expect(d.messages[0].forkReplyHash).toBe(codexReplyHash(text));
  });
});
