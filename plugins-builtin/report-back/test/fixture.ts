// A small Claude Code transcript (JSONL, as ~/.claude/projects/<dir>/<id>.jsonl holds it) for the report-back tests
// and the end-to-end run: one earlier turn, then a turn that edits two files, runs the tests (a failure, then a pass)
// and ends with a summary.
export function claudeTranscript(o: { id: string; cwd: string; t0: number; final?: string; failTests?: boolean }) {
  const at = (s: number) => new Date(o.t0 + s * 1000).toISOString();
  const base = { sessionId: o.id, cwd: o.cwd, version: "2.0.0" };
  const user = (s: number, text: string) => ({ ...base, type: "user", timestamp: at(s), message: { role: "user", content: text } });
  const said = (s: number, mid: string, text: string) => ({ ...base, type: "assistant", timestamp: at(s), message: { id: mid, role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] } });
  const tool = (s: number, id: string, name: string, input: object) => ({ ...base, type: "assistant", timestamp: at(s), message: { id: `m-${id}`, role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id, name, input }] } });
  const result = (s: number, id: string, isError = false) => ({ ...base, type: "user", timestamp: at(s), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] } });
  const lines = [
    user(0, "Look around the repo"),
    said(5, "m0", "It is a small Bun app."),
    user(60, "Add a retry to the fetch helper and test it"),
    tool(62, "e1", "Edit", { file_path: `${o.cwd}/src/fetch.ts`, old_string: "a", new_string: "b" }),
    result(63, "e1"),
    tool(64, "w1", "Write", { file_path: `${o.cwd}/test/fetch.test.ts`, content: "x" }),
    result(65, "w1"),
    tool(66, "b1", "Bash", { command: "bun test", description: "Run the tests" }),
    result(70, "b1", true),
    tool(72, "e2", "Edit", { file_path: `${o.cwd}/src/fetch.ts`, old_string: "b", new_string: "c" }),
    result(73, "e2"),
    tool(74, "b2", "Bash", { command: "bun test", description: "Run the tests" }),
    result(78, "b2", !!o.failTests),
    said(80, "m9", o.final ?? "## Added retries to the fetch helper\n\nThree tries with backoff; `bun test` passes (12 tests)."),
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
