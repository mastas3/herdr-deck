import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createCodexLifecycle } from "../src/codex-lifecycle";
import { archivedCodexTasks } from "../src/codex-lifecycle-index";
import { openCodexMetadataSession } from "../src/codex-app-server";
import { CodexControlError } from "../src/codex-ipc";

const root = mkdtempSync(`${tmpdir()}/deck-lifecycle-test-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sourceId = "01a0e943-5b84-7462-b625-7009c89d107d", createdId = "01a0e946-3f93-73b3-92c9-b58fb900ea66";
const thread = (id = sourceId) => ({ id, source: "vscode", cwd: root, name: "Test task" });
function fixture(overrides: Record<string, any> = {}, receiptsFile?: string) {
  const calls: { method: string; params: any; mutation?: boolean }[] = []; let closed = 0;
  const api = createCodexLifecycle({ receiptsFile, transport: async () => ({
    async request(method, params, mutation) {
      calls.push({ method, params, mutation });
      if (method in overrides) {
        const result = overrides[method]; if (result instanceof Error) throw result;
        return typeof result === "function" ? result(params) : result;
      }
      if (["thread/start", "thread/fork"].includes(method)) return { thread: thread(createdId) };
      if (method === "thread/read") return { thread: thread() };
      return {};
    },
    async close() { closed++; },
  }) });
  return { api, calls, get closed() { return closed; } };
}

describe("canonical Codex lifecycle", () => {
  test("creates durable neutral history without adding user messages or running a turn", async () => {
    const f = fixture(), input = { cwd: root, title: "  Native task  ", prompt: "First user prompt", requestId: "create-receipt-001" };
    const result = await f.api.create(input);
    expect(result).toMatchObject({ id: createdId, title: "Native task", initialPromptPersisted: false });
    expect(f.calls.map((c) => c.method)).toEqual(["thread/start", "thread/inject_items", "thread/name/set", "thread/unsubscribe"]);
    expect(f.calls[0].params).toEqual({ cwd: realpathSync(root), threadSource: "herdr-deck", ephemeral: false });
    expect(f.calls[1].params.items).toEqual([{ type: "other" }]);
    expect(JSON.stringify(f.calls)).not.toContain("First user prompt");
    expect(f.closed).toBe(1);
    await expect(f.api.create(input)).resolves.toEqual(result); expect(f.calls).toHaveLength(4);
    await expect(f.api.create({ ...input, prompt: "Different" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
  });
  test("blank new tasks are supported and invalid folders or titles never spawn a backend", async () => {
    const f = fixture();
    await expect(f.api.create({ cwd: "relative", requestId: "bad-folder-001" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
    await expect(f.api.create({ cwd: root, title: "x\ny", requestId: "bad-title-001" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
    expect(f.calls).toHaveLength(0);
    expect(await f.api.create({ cwd: root, requestId: "blank-task-001" })).toMatchObject({ title: "New Codex task", initialPromptPersisted: false });
  });
  test("incomplete creation is never retried after restart", async () => {
    const file = `${root}/receipts.json`, input = { cwd: root, requestId: "incomplete-create" };
    const f = fixture({ "thread/inject_items": new CodexControlError("failed", "CODEX_INVALID") }, file);
    await expect(f.api.create(input)).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    const next = fixture({}, file);
    await expect(next.api.create(input)).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    expect(next.calls).toHaveLength(0); expect(f.closed).toBe(1);
  });
  test("renames, archives, restores and forks only verified app tasks", async () => {
    const f = fixture();
    expect(await f.api.rename(sourceId, "Renamed")).toMatchObject({ id: sourceId, title: "Renamed" });
    expect(await f.api.archive(sourceId, true)).toMatchObject({ archived: true });
    expect(await f.api.archive(sourceId, false)).toMatchObject({ archived: false });
    expect(await f.api.fork(sourceId, "fork-receipt-001")).toMatchObject({ id: createdId });
    expect(f.calls.filter((c) => c.method === "thread/read")).toHaveLength(4);
    expect(f.calls.find((c) => c.method === "thread/fork")).toMatchObject({ params: { threadId: sourceId, excludeTurns: true }, mutation: true });
    const count = f.calls.length; await f.api.fork(sourceId, "fork-receipt-001"); expect(f.calls).toHaveLength(count);
    const nonApp = fixture({ "thread/read": { thread: { ...thread(), source: "cli" } } });
    await expect(nonApp.api.rename(sourceId, "No")).rejects.toMatchObject({ code: "CODEX_INVALID" });
    await expect(nonApp.api.archive(sourceId, true)).rejects.toMatchObject({ code: "CODEX_INVALID" });
    await expect(nonApp.api.fork(sourceId, "wrong-source-fork")).rejects.toMatchObject({ code: "CODEX_INVALID" });
    expect(nonApp.calls.every((c) => c.method === "thread/read")).toBe(true);
    const mismatched = fixture({ "thread/read": { thread: thread(createdId) } });
    await expect(mismatched.api.archive(sourceId, true)).rejects.toMatchObject({ code: "CODEX_INVALID" });
    expect(mismatched.calls).toHaveLength(1);
  });
  test("writer ownership conflicts are actionable and never bypassed", async () => {
    const f = fixture({ "thread/archive": new CodexControlError(`thread ${sourceId} already has an active writer`, "CODEX_INVALID") });
    await expect(f.api.archive(sourceId, true)).rejects.toMatchObject({ code: "CODEX_STALE", message: "Codex still has this task loaded. Archive it in the Codex app." });
    expect(f.calls.map((c) => c.method)).toEqual(["thread/read", "thread/archive"]);
  });
  test("malformed successful creation acknowledgement remains uncertain", async () => {
    const f = fixture({ "thread/start": { thread: { id: createdId, source: "cli" } } });
    await expect(f.api.create({ cwd: root, requestId: "wrong-created-source" })).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    await expect(f.api.create({ cwd: root, requestId: "wrong-created-source" })).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" });
    expect(f.calls).toHaveLength(1);
  });
});

describe("Codex archived index", () => {
  test("includes paginated tasks with no legacy user event and paginates equal timestamps without duplicates", () => {
    const home = `${root}/index`; mkdirSync(home);
    const db = new Database(`${home}/state_12.sqlite`);
    db.exec("create table threads(id text primary key, cwd text, title text, name text, source text, archived integer, updated_at integer, has_user_event integer)");
    for (let n = 0; n < 54; n++) db.query("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?)").run(`task-${String(n).padStart(3, "0")}`, root, "Old", "Named", "vscode", 1, 42, 0);
    db.query("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?)").run("cli-task", root, "CLI", null, "cli", 1, 100, 1);
    db.query("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?)").run("live-task", root, "Live", null, "vscode", 0, 100, 1);
    const first = archivedCodexTasks(undefined, home), next = archivedCodexTasks(first.nextCursor!, home);
    expect(first.tasks).toHaveLength(50); expect(next.tasks).toHaveLength(4); expect(next.nextCursor).toBeNull();
    expect(new Set([...first.tasks, ...next.tasks].map((t) => t.id)).size).toBe(54);
    expect(first.tasks[0].title).toBe("Named");
    expect(db.query("select count(*) as n from threads where archived = 1").get()).toEqual({ n: 55 }); db.close();
    expect(() => archivedCodexTasks("not-a-cursor", home)).toThrow("Invalid archive cursor");
    expect(archivedCodexTasks(undefined, `${root}/missing`)).toEqual({ tasks: [], nextCursor: null });
  });
});

function fakeBinary(name: string, body: string) {
  const file = `${root}/${name}`;
  writeFileSync(file, `#!${process.execPath}\n${body}`); chmodSync(file, 0o700); return file;
}
const fakeLoop = (body: string) => `let buffer='';for await(const chunk of Bun.stdin.stream()){buffer+=new TextDecoder().decode(chunk);let at;while((at=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);${body}}}`;
describe("metadata process safety", () => {
  test("rejects execution methods and unsolicited approval requests", async () => {
    const marker = `${root}/rejected.json`;
    const binary = fakeBinary("metadata-good", fakeLoop(`if(m.error) await Bun.write(${JSON.stringify(marker)}, JSON.stringify(m));else if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{}}));console.log(JSON.stringify({id:'approval',method:'item/commandExecution/requestApproval',params:{}}));}else if(m.id)console.log(JSON.stringify({id:m.id,result:{ok:true}}));`));
    const s = await openCodexMetadataSession(binary, 1000);
    try {
      await expect(s.request("turn/start", {}, true)).rejects.toMatchObject({ code: "CODEX_INVALID" });
      await s.request("thread/read", { threadId: sourceId });
      for (let n = 0; n < 10 && !await Bun.file(marker).exists(); n++) await Bun.sleep(10);
      expect(await Bun.file(marker).json()).toMatchObject({ id: "approval", error: { code: -32601 } });
    } finally { await s.close(); }
  });
  test("lost mutation acknowledgement is uncertain and process is reaped", async () => {
    const binary = fakeBinary("metadata-lost", fakeLoop(`if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.id)process.exit(0);`));
    const s = await openCodexMetadataSession(binary, 1000);
    try { await expect(s.request("thread/name/set", {}, true)).rejects.toMatchObject({ code: "CODEX_DELIVERY_UNKNOWN" }); }
    finally { await s.close(); }
  });
});
