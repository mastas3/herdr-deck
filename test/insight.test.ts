import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { claudeDetail, prettyTool, toolSummary } from "../src/transcript";
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
    const f = `${dir}/rollout.jsonl`;
    const ev = (type: string, ts: string) => line({ timestamp: ts, type: "event_msg", payload: { type } });
    writeFileSync(f, ev("task_started", "2026-09-26T10:00:00Z") + ev("item_completed", "2026-09-26T10:00:05Z"));
    expect(await turnState(f)).toMatchObject({ open: true, startedAt: Date.parse("2026-09-26T10:00:00Z") });
    writeFileSync(f, ev("task_started", "2026-09-26T10:00:00Z") + ev("task_complete", "2026-09-26T10:01:00Z") + " ");
    expect(await turnState(f)).toMatchObject({ open: false, endedAt: Date.parse("2026-09-26T10:01:00Z") });
    writeFileSync(f, ev("task_started", "2026-09-26T10:02:00Z") + ev("turn_aborted", "2026-09-26T10:03:00Z") + "  ");
    expect((await turnState(f)).open).toBe(false);
  });
});
