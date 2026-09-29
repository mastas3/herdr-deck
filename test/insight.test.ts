import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { claudeDetail, claudeSubagents, forgetTranscript, prettyTool, toolSummary } from "../src/transcript";
import { inferProject } from "../src/projects";
import { agentArgs } from "../src/args";

const line = (o: object) => JSON.stringify(o) + "\n";
const made: string[] = [];
const tmp = () => { const d = mkdtempSync(`${homedir()}/.deck-test-`); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe("chat messages", () => {
  test("keeps asks, replies and one-line tool calls, and closes calls when results arrive", async () => {
    const dir = tmp();
    const path = `${dir}/s.jsonl`;
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: "Fix the build" } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:00:05Z", message: { id: "a1", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: `${dir}/src/app.ts` } }] } }) +
      line({ type: "user", timestamp: "2026-09-20T10:00:06Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:00:07Z", message: { id: "a2", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test", description: "Run tests" } }] } }));
    const d = await claudeDetail(path);
    expect(d.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(d.messages[2]).toMatchObject({ tool: "Edit", state: "done" });
    expect(d.messages[3]).toMatchObject({ tool: "Bash", summary: "Run tests", state: "running" });
    expect([...d.touch.keys()].some((k) => k.startsWith(dir))).toBe(true);
  });

  test("tool names and summaries read well", () => {
    expect(prettyTool("mcp__plugin_playwright_playwright__browser_click")).toBe("playwright · browser_click");
    expect(prettyTool("Bash")).toBe("Bash");
    expect(toolSummary("Grep", { pattern: "TODO", path: `${homedir()}/x` })).toBe("TODO in ~/x");
    expect(toolSummary("TodoWrite", { todos: [{ status: "done", content: "a" }, { status: "in_progress", content: "b", activeForm: "Doing b" }] })).toBe("Doing b");
  });

  test("a malformed tool input doesn't break the transcript", async () => {
    // A real session called TodoWrite with todos as the string "[]"; the whole chat failed to load.
    expect(toolSummary("TodoWrite", { todos: "[]" })).toBe("0 todos");
    const path = `${tmp()}/s.jsonl`;
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: "Plan it" } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:00:05Z", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: "[]" } }] } }));
    const d = await claudeDetail(path);
    expect(d.messages.map((m) => m.role)).toEqual(["user", "tool"]);
  });

  test("a message sent while Claude works shows; a task's notice doesn't, and closes its call", async () => {
    const path = `${tmp()}/s.jsonl`;
    const queued = (prompt: string, kind: string | undefined, mode: string, t: string) =>
      line({ type: "attachment", timestamp: t, attachment: { type: "queued_command", prompt, commandMode: mode, ...(kind ? { origin: { kind } } : {}) } });
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: "Review it" } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:00:05Z", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Review", subagent_type: "general-purpose", run_in_background: true } }] } }) +
      line({ type: "user", timestamp: "2026-09-20T10:00:06Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "launched" }] }, toolUseResult: { status: "async_launched", agentId: "ab12" } }) +
      queued("status?", "human", "prompt", "2026-09-20T10:01:00Z") +
      queued("<task-notification>\n<task-id>ab12</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n</task-notification>", undefined, "task-notification", "2026-09-20T10:02:00Z"));
    const d = await claudeDetail(path);
    expect(d.messages.map((m) => m.text ?? m.tool)).toEqual(["Review it", "Agent", "status?"]);
    expect(d.messages[1]).toMatchObject({ sub: "ab12", state: "done" });
  });

  test("a subagent busy in a long command still shows as running while its call is open", async () => {
    const dir = tmp();
    const path = `${dir}/s.jsonl`;
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: "Merge" } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:00:05Z", message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Merge", run_in_background: true } }] } }) +
      line({ type: "user", timestamp: "2026-09-20T10:00:06Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "launched" }] }, toolUseResult: { status: "async_launched", agentId: "ab12" } }));
    mkdirSync(`${dir}/s/subagents`, { recursive: true });
    const sub = `${dir}/s/subagents/agent-ab12.jsonl`;
    writeFileSync(`${dir}/s/subagents/agent-ab12.meta.json`, JSON.stringify({ agentType: "general-purpose", description: "Merge", toolUseId: "t1" }));
    writeFileSync(sub, line({ type: "user", timestamp: "2026-09-20T10:00:06Z", message: { content: "Merge" } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:00:07Z", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "bun test" } }] } }));
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    utimesSync(sub, fiveMinAgo, fiveMinAgo);
    expect((await claudeSubagents(path, await claudeDetail(path)))[0].running).toBe(true);
    // Its notice arrives: the same (unchanged) subagent file now reads as finished.
    appendFileSync(path, line({ type: "attachment", timestamp: "2026-09-20T10:09:00Z", attachment: { type: "queued_command", commandMode: "task-notification", prompt: "<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n</task-notification>" } }));
    forgetTranscript(path);
    expect((await claudeSubagents(path, await claudeDetail(path)))[0].running).toBe(false);
  });

  test("a message that starts with a paste shows, without the paste tags", async () => {
    const path = `${tmp()}/s.jsonl`;
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: '\n\n<pasted_content id="69c7">\nList cool things.\n\nAnd a sigil app.\n</pasted_content id="69c7">\n\nthoughts?' } }) +
      line({ type: "user", timestamp: "2026-09-20T10:00:01Z", message: { content: "<local-command-stdout>hidden</local-command-stdout>" } }));
    const d = await claudeDetail(path);
    expect(d.messages.map((m) => m.text)).toEqual(["List cool things.\n\nAnd a sigil app.\n\nthoughts?"]);
  });
});

describe("project inference", () => {
  test("work elsewhere beats the launch folder", () => {
    const base = tmp();
    for (const d of ["hub", "real"]) mkdirSync(`${base}/${d}/.git`, { recursive: true });
    const touch = new Map([[`${base}/real/src/a.ts`, 8], [`${base}/hub/notes.md`, 1]]);
    expect(inferProject(touch, `${base}/hub`)?.name).toBe("real");
    expect(inferProject(new Map(), `${base}/hub`)?.name).toBe("hub");
  });
});

describe("new-session flags", () => {
  test("claude", () => {
    expect(agentArgs("claude", { model: "opus", effort: "high", mode: "acceptEdits" })).toEqual(["--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits"]);
    expect(agentArgs("claude", { mode: "bypassPermissions", args: "--verbose" })).toEqual(["--dangerously-skip-permissions", "--verbose"]);
  });
  test("codex and opencode", () => {
    expect(agentArgs("codex", { model: "gpt-6-sol", effort: "xhigh", mode: "yolo" })).toEqual(["-m", "gpt-6-sol", "-c", 'model_reasoning_effort="xhigh"', "--dangerously-bypass-approvals-and-sandbox"]);
    expect(agentArgs("opencode", { model: "anthropic/claude-opus-5-5", mode: "plan" })).toEqual(["-m", "anthropic/claude-opus-5-5", "--agent", "plan"]);
  });
});

describe("Codex app turn state", () => {
  test("a task_started without task_complete is an open turn; completion or abort closes it", async () => {
    const { turnState } = await import("../src/codexapp");
    const dir = tmp();
    const ev = (type: string, ts: string) => line({ timestamp: ts, type: "event_msg", payload: { type } });
    const file = (name: string, body: string) => { const f = `${dir}/${name}.jsonl`; writeFileSync(f, body); return f; };
    expect(await turnState(file("open", ev("task_started", "2026-09-26T10:00:00Z") + ev("item_completed", "2026-09-26T10:00:05Z")))).toMatchObject({ open: true, startedAt: Date.parse("2026-09-26T10:00:00Z") });
    expect(await turnState(file("done", ev("task_started", "2026-09-26T10:00:00Z") + ev("task_complete", "2026-09-26T10:01:00Z")))).toMatchObject({ open: false, endedAt: Date.parse("2026-09-26T10:01:00Z") });
    expect((await turnState(file("aborted", ev("task_started", "2026-09-26T10:02:00Z") + ev("turn_aborted", "2026-09-26T10:03:00Z")))).open).toBe(false);
  });
});
