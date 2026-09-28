import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCodexStore } from "../src/codex-store";
import { listAppThreads, turnState } from "../src/codexapp";
import { codexSubagents, codexSubFile } from "../src/codex-subagents";
import { codexDetail } from "../src/transcript";
import { parseCodex } from "../src/agents";
import { sessionsApi } from "../src/http/api-sessions";

const root = mkdtempSync(`${tmpdir()}/deck-codex-parity-`);
const stores: ReturnType<typeof createCodexStore>[] = [];
const dbs: Database[] = [];
afterAll(() => { stores.forEach((s) => s.close()); dbs.forEach((d) => d.close()); rmSync(root, { recursive: true, force: true }); });
const line = (o: any) => JSON.stringify(o) + "\n";
const event = (type: string, timestamp = new Date().toISOString(), more = {}) => line({ payload: { ...more, type }, timestamp, type: "event_msg" });
function file(text: string) { const p = `${root}/${crypto.randomUUID()}.jsonl`; writeFileSync(p, text); return p; }
function fixture() {
  const dir = mkdtempSync(`${root}/store-`), db = new Database(`${dir}/state_5.sqlite`); dbs.push(db);
  db.exec(`create table threads (id text primary key, rollout_path text, title text, name text, cwd text, created_at integer,
    updated_at integer, source text, archived integer, git_branch text, model text, agent_nickname text, agent_role text);
    create table thread_spawn_edges (parent_thread_id text, child_thread_id text primary key, status text);`);
  const store = createCodexStore(() => dir); stores.push(store);
  function add(id: string, p: string, { archived = 0, source = "vscode", updated = Date.now() / 1000 } = {}) {
    db.query("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, p, "Original title", "Renamed task", root, updated - 60, updated, source, archived, "main", "codex-model", "Ada", "explorer");
  }
  return { dir, db, store, add };
}

describe("Codex turn lifecycle", () => {
  test("accepts reordered JSON, preserves small-file starts, and ignores incomplete writes", async () => {
    const p = file(event("task_started", "2026-09-28T10:00:00Z", { turn_id: "one", started_at: Date.parse("2026-09-28T10:00:00Z") / 1000 }));
    expect(await turnState(p)).toMatchObject({ open: true, turnId: "one", startedAt: Date.parse("2026-09-28T10:00:00Z") });
    const end = event("task_complete", "2026-09-28T10:01:00Z", { turn_id: "one" });
    appendFileSync(p, end.slice(0, -5));
    expect((await turnState(p)).open).toBe(true);
    appendFileSync(p, end.slice(-5));
    expect(await turnState(p)).toMatchObject({ open: false, startedAt: Date.parse("2026-09-28T10:00:00Z"), endedAt: Date.parse("2026-09-28T10:01:00Z") });
    appendFileSync(p, event("task_started", undefined, { turn_id: "two" }) + event("task_complete", undefined, { turn_id: "one" }));
    expect((await turnState(p)).open).toBe(true);
  });
  test("does not mistake marker text inside tool output for a turn event", async () => {
    const p = file(event("task_started") + line({ type: "response_item", payload: { type: "custom_tool_call_output", output: event("task_complete") } }));
    expect((await turnState(p)).open).toBe(true);
  });
  test("chunk boundaries inside UTF-8 do not corrupt the next append offset", async () => {
    const p = file(event("task_started") + line({ type: "response_item", payload: { output: "界".repeat(100000) } }));
    const before = await turnState(p);
    expect(before.pos).toBe(before.size);
    appendFileSync(p, event("task_complete"));
    expect((await turnState(p)).open).toBe(false);
  });
  test("interruption is not a successful completion and replacement clears cached state", async () => {
    const p = file(event("task_started") + event("turn_aborted"));
    expect(await turnState(p)).toMatchObject({ open: false, interrupted: true });
    const replacement = file(event("task_started", undefined, { turn_id: "new" }));
    renameSync(replacement, p);
    expect(await turnState(p)).toMatchObject({ open: true, turnId: "new", interrupted: false });
  });
  test("cold and incremental reads agree on a late completion for a previous turn", async () => {
    const p = file(event("task_started", undefined, { turn_id: "a" }) + event("task_started", undefined, { turn_id: "b" }) + event("task_complete", undefined, { turn_id: "a" }));
    expect(await turnState(p)).toMatchObject({ open: true, turnId: "b" });
  });
});

describe("Codex index and desktop inventory", () => {
  test("uses indexed rollout paths and exposes only actual child threads", async () => {
    const f = fixture(), p = file(event("task_started") + line({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c", arguments: '{"cmd":"bun test"}' } }));
    f.add("parent", p); f.add("child", p, { source: "subagent" }); f.add("unrelated", p);
    f.db.query("insert into thread_spawn_edges values (?, ?, ?)").run("parent", "child", "active");
    expect(f.store.file("child")).toBe(p);
    expect(f.store.hasAppThreads()).toBe(true);
    expect(codexSubFile("parent", "child", f.store)).toBe(p);
    expect(codexSubFile("parent", "unrelated", f.store)).toBeUndefined();
    expect(await codexSubagents("parent", f.store)).toMatchObject([{ id: "child", description: "Renamed task", model: "codex-model", type: "explorer", running: true, tools: 1 }]);
  });
  test("merges a stale catalog with current state, excluding archived and hidden threads", async () => {
    const f = fixture(), now = Date.now(), p = file(event("task_started"));
    f.add("active", p, { updated: now / 1000 - 20 * 86400 });
    f.add("fresh", file(event("task_complete")));
    f.add("archived", p, { archived: 1 }); f.add("hidden", p);
    const cat = new Database(":memory:"); dbs.push(cat);
    cat.exec("create table local_thread_catalog (thread_id text, display_title text, cwd text, git_branch text, source_created_at real, source_updated_at real, host_id text, source_kind text)");
    for (const id of ["active", "archived", "hidden"]) cat.query("insert into local_thread_catalog values (?, 'Old title', ?, 'old', ?, ?, 'local', 'vscode')").run(id, root, now / 1000 - 20 * 86400, now / 1000 - 20 * 86400);
    const rows = await listAppThreads(new Set(["hidden"]), { catalog: cat, store: f.store, running: true, now, findFile: f.store.file });
    expect(rows.map((r) => r.id).sort()).toEqual(["active", "fresh"]);
    expect(rows.find((r) => r.id === "active")).toMatchObject({ title: "Renamed task", status: "working", branch: "main" });
  });
  test("an interrupted app task is idle; stale work is not shown as running", async () => {
    const f = fixture(), p = file(event("task_started"));
    utimesSync(p, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    f.add("stalled", p); f.add("interrupted", file(event("task_started") + event("turn_aborted")));
    const rows = await listAppThreads(new Set(), { catalog: null, store: f.store, running: true, findFile: f.store.file });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "idle")).toBe(true);
  });
  test("explicitly restored old desktop tasks remain visible without revealing archived or unrelated tasks", async () => {
    const f = fixture(), old = Date.now() / 1000 - 30 * 86400;
    f.add("restored", "", { updated: old }); f.add("old", "", { updated: old });
    f.add("archived", "", { updated: old, archived: 1 }); f.add("cli", "", { updated: old, source: "cli" });
    const rows = await listAppThreads(new Set(), { catalog: null, store: f.store, running: false, findFile: () => undefined,
      include: new Set(["restored", "archived", "cli"]) });
    expect(rows.map((r) => r.id)).toEqual(["restored"]);
  });
  test("missing databases and older schemas degrade without writes", () => {
    const f = fixture(); f.db.exec("drop table thread_spawn_edges");
    expect(f.store.subagents("parent")).toEqual([]);
    const missing = createCodexStore(() => `${root}/missing`); stores.push(missing);
    expect(missing.get("x")).toBeUndefined(); expect(missing.recentApp(0)).toEqual([]);
    expect(missing.hasAppThreads()).toBe(false);
  });
});

describe("Codex chat parity", () => {
  test("keeps the real prompt following app context without showing injected setup", async () => {
    const content = [{ type: "input_text", text: "<recommended_plugins>list</recommended_plugins>\nFix the dashboard" }];
    const user = { type: "response_item", payload: { type: "message", role: "user", content } };
    const setup = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\nsetup" }] } };
    const p = file(line(setup) + line(user));
    expect(parseCodex([line(setup), line(user)], []).firstPrompt).toBe("Fix the dashboard");
    const d = await codexDetail(p);
    expect(d.asks).toBe(1); expect(d.started).toBe("Fix the dashboard");
  });
  test("shows nested code-mode commands and edits once, including failures and elapsed work", async () => {
    const p = file(event("task_started", "2026-09-28T10:00:00Z") +
      line({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "command", arguments: '{"cmd":"bun test"}' } }) +
      event("item_completed", undefined, { item: { type: "CommandExecution", id: "command", command: ["bun", "test"], exit_code: 1, status: "completed" } }) +
      event("item_completed", undefined, { item: { type: "CommandExecution", id: "nested", command: ["git", "status"], exit_code: 0 } }) +
      event("item_completed", undefined, { item: { type: "FileChange", id: "edit", changes: { "/tmp/a.ts": {} }, status: "completed" } }) +
      event("task_complete", "2026-09-28T10:02:00Z"));
    const d = await codexDetail(p);
    expect(d.messages.filter((m) => m.role === "tool")).toHaveLength(3);
    expect(d.messages[0]).toMatchObject({ summary: "bun test", state: "error" });
    expect(d.messages[1]).toMatchObject({ summary: "git status", state: "done" });
    expect(d.messages[2]).toMatchObject({ tool: "apply_patch", summary: "/tmp/a.ts" });
    expect(d.workMs).toBe(120000); expect(d.turnOpen).toBe(false);
  });
  test("tracks namespaced plans and finishes remaining tools on interruption", async () => {
    const p = file(event("task_started") + line({ type: "response_item", payload: { type: "function_call", name: "functions.update_plan", call_id: "plan", arguments: JSON.stringify({ plan: [{ step: "Test", status: "in_progress" }] }) } }) + event("turn_aborted"));
    expect(await codexDetail(p)).toMatchObject({ todos: { done: 0, total: 1 }, todo: "Test", turnOpen: false });
    expect((await codexDetail(p)).messages[0].state).toBe("error");
  });
});

test("a live app turn cannot be resumed into a competing CLI writer", async () => {
  let starts = 0;
  const hub: any = { deck: {}, hosts: { localRow: () => ({ app: "codex", sessionId: "task", status: "working" }) },
    sessions: { startSession: () => { starts++; } }, chat: {}, queue: {} };
  const response = await sessionsApi(hub, "/api/codex-resume", { key: "codex-app/task" });
  expect(response?.status).toBe(409); expect(starts).toBe(0);
});
