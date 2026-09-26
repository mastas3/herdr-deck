import { describe, expect, test } from "bun:test";
import { grantClass, isFileRef, parseEvery, parseRefresh, toolClass } from "../src/plugin-format";

describe("toolClass", () => {
  test("MCP tools: reading vs changing is judged from the tool's own name", () => {
    expect(toolClass("mcp__claude_ai_Gmail__search_threads")).toEqual({ ok: true, writes: false, web: false, machine: false, bash: false });
    expect(toolClass("mcp__claude_ai_Gmail__get_thread").writes).toBe(false);
    expect(toolClass("mcp__claude_ai_Gmail__reply").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Gmail__label_thread").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Gmail__send_message").writes).toBe(true);
    expect(toolClass("mcp__plugin_context7_context7__query-docs").writes).toBe(false);
  });
  test("built-in tools", () => {
    expect(toolClass("Read")).toEqual({ ok: true, writes: false, web: false, machine: true, bash: false });
    expect(toolClass("Write").writes).toBe(true);
    expect(toolClass("WebFetch")).toEqual({ ok: true, writes: false, web: true, machine: false, bash: false });
    expect(toolClass("Bash")).toEqual({ ok: true, writes: true, web: true, machine: true, bash: true });
  });
  test("scoped Bash: a read-only two-word command reads; anything open-ended counts as writing", () => {
    expect(toolClass("Bash(gh search prs:*)")).toEqual({ ok: true, writes: false, web: false, machine: true, bash: true });
    expect(toolClass("Bash(gh pr merge:*)").writes).toBe(true);
    expect(toolClass("Bash(gh:*)").writes).toBe(true); // one program with any subcommand is no scope
    expect(toolClass("Bash(curl:*)")).toMatchObject({ writes: true, web: true });
    expect(toolClass("Bash(python3 x.py:*)").writes).toBe(true);
  });
  test("anything else is refused", () => {
    for (const t of ["mcp__x__*", "Bash(rm -rf /; echo:*)", "Bash(a|b:*)", "Task", "NotebookEdit", "mcp__x", "", "bash"]) expect(toolClass(t).ok).toBe(false);
    expect(toolClass(42 as any).ok).toBe(false);
  });
  test("a grant writes if its author says so or any tool does", () => {
    expect(grantClass({ tools: ["mcp__claude_ai_Gmail__search_threads"] }).writes).toBe(false);
    expect(grantClass({ tools: ["mcp__claude_ai_Gmail__search_threads"], writes: true }).writes).toBe(true);
    expect(grantClass({ tools: ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__reply"] }).writes).toBe(true);
    expect(grantClass({ tools: ["Bash(gh search prs:*)"] })).toEqual({ writes: false, web: false, machine: true, bash: true });
  });
});

describe("parsers", () => {
  test("parseEvery", () => {
    expect(parseEvery("day 09:00")).toEqual({ kind: "days", days: [0, 1, 2, 3, 4, 5, 6], h: 9, m: 0 });
    expect(parseEvery("weekday 18:30")).toEqual({ kind: "days", days: [1, 2, 3, 4, 5], h: 18, m: 30 });
    expect(parseEvery("thu,mon 07:05")).toEqual({ kind: "days", days: [1, 4], h: 7, m: 5 });
    expect(parseEvery("6h")).toEqual({ kind: "hours", n: 6 });
    for (const bad of ["day 24:00", "day 9:00", "mon,mon 09:00", "funday 09:00", "0h", "25h", "every day", ""]) expect(parseEvery(bad)).toBeNull();
  });
  test("parseRefresh: 5m to 24h", () => {
    expect(parseRefresh("10m")).toBe(10);
    expect(parseRefresh("2h")).toBe(120);
    expect(parseRefresh("24h")).toBe(1440);
    for (const bad of ["4m", "25h", "10", "1d", "m"]) expect(parseRefresh(bad)).toBeNull();
  });
  test("isFileRef: plain relative paths inside the plugin only", () => {
    for (const ok of ["prompts/inbox.md", "playbook.md", "a/b/c/d.txt", "_x.md"]) expect(isFileRef(ok)).toBe(true);
    for (const bad of ["../x.md", "/etc/x.md", "prompts/../x.md", "./x.md", "a/b/c/d/e.md", "x.js", "a b.md", "v1.2.md", 5]) expect(isFileRef(bad)).toBe(false);
  });
});
