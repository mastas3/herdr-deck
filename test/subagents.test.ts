import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeSubagents } from "../src/transcript";
import { subRunning } from "../src/subagent-state";

// Four subagents beside one session: a background one waiting on a long command, a background one that finished, a
// foreground one still working, and a foreground one that returned to its parent.
const MIN = 60_000;
let root = "", session = "";
const at = (ms: number) => new Date(ms).toISOString();
const L = (o: any) => JSON.stringify(o) + "\n";
const user = (t: number, content: any) => L({ type: "user", timestamp: at(t), message: { role: "user", content } });
const asst = (t: number, content: any[], stop: string | null = null) => L({ type: "assistant", timestamp: at(t), message: { role: "assistant", content, stop_reason: stop } });
const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
function agent(id: string, lines: string, shape: "background" | undefined, quietMs: number, now: number) {
  const dir = `${root}/s/subagents`;
  writeFileSync(`${dir}/agent-${id}.jsonl`, lines);
  writeFileSync(`${dir}/agent-${id}.meta.json`, JSON.stringify({ agentType: "general-purpose", description: id, toolUseId: `toolu_${id}`, ...(shape ? { requestShape: shape } : {}) }));
  const t = (now - quietMs) / 1000;
  utimesSync(`${dir}/agent-${id}.jsonl`, t, t);
}
const NOW = Date.now();
beforeAll(() => {
  root = mkdtempSync(`${tmpdir()}/deck-subs-`);
  session = `${root}/s.jsonl`;
  mkdirSync(`${root}/s/subagents`, { recursive: true });
  writeFileSync(session, "");
  const start = NOW - 20 * MIN;
  // Waits on a 5-minute test run: its Bash call has no result yet, and nothing was written for 5 minutes.
  agent("bglong", user(start, "Run the tests") + asst(start + 1000, [bash("t1", "ls")]) + user(start + 2000, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }])
    + asst(NOW - 5 * MIN, [bash("t2", "bun test --timeout 600000")]), "background", 5 * MIN, NOW);
  agent("bgdone", user(start, "Summarize") + asst(start + 1000, [bash("t1", "ls")]) + user(start + 2000, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }])
    + asst(NOW - 2 * MIN, [{ type: "text", text: "Done." }], "end_turn"), "background", 2 * MIN, NOW);
  agent("fgrun", user(start, "Look around") + asst(NOW - 10_000, [bash("t1", "rg foo")]) + user(NOW - 5_000, [{ type: "tool_result", tool_use_id: "t1", content: "x" }]), undefined, 5_000, NOW);
  agent("fgret", user(start, "Look around") + asst(NOW - 20_000, [bash("t1", "rg foo")]) + user(NOW - 15_000, [{ type: "tool_result", tool_use_id: "t1", content: "x" }]), undefined, 10_000, NOW);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The parent's Agent calls: a background launch returns at once ("Async agent launched"); fgret has returned too.
const parent: any = { messages: [
  { role: "tool", tool: "Agent", state: "done", sub: "bglong" }, { role: "tool", tool: "Agent", state: "done", sub: "bgdone" },
  { role: "tool", tool: "Agent", state: "running", sub: "fgrun" }, { role: "tool", tool: "Agent", state: "done", sub: "fgret" },
] };
const running = async (now = NOW) => Object.fromEntries((await claudeSubagents(session, parent, now)).map((s) => [s.id, s.running]));

describe("which subagents are running", () => {
  test("background waiting on a long command: running; background finished: not; foreground working: running; foreground returned: not", async () => {
    expect(await running()).toEqual({ bglong: true, bgdone: false, fgrun: true, fgret: false });
  });
  test("the same answers from the cache, and time still moves them: an open call waits up to 30 minutes, a quiet one 45 s", async () => {
    expect(await running()).toEqual({ bglong: true, bgdone: false, fgrun: true, fgret: false });
    // fgrun's parent call is still open, so it may be deep in a long command too.
    expect(await running(NOW + 20 * MIN)).toMatchObject({ bglong: true, fgrun: true });
    expect(await running(NOW + 26 * MIN)).toMatchObject({ bglong: false, fgrun: true }); // bglong has been quiet 31 minutes
    expect(await running(NOW + 31 * MIN)).toMatchObject({ fgrun: false });
  });
  test("the rule on its own", () => {
    const base = { ended: false, pending: false, background: true, call: "done" as const, quietMs: 10_000 };
    expect(subRunning(base)).toBe(true); // a background launch can read as a closed call
    expect(subRunning({ ...base, background: false })).toBe(false);
    expect(subRunning({ ...base, call: "error" })).toBe(false); // killed or failed
    expect(subRunning({ ...base, background: false, call: "running", quietMs: 10 * MIN })).toBe(true); // the parent still waits on it
    expect(subRunning({ ...base, call: undefined, quietMs: 10 * MIN })).toBe(false);
    expect(subRunning({ ...base, quietMs: 50_000 })).toBe(false);
    expect(subRunning({ ...base, quietMs: 50_000, pending: true })).toBe(true);
    expect(subRunning({ ...base, quietMs: 31 * MIN, pending: true })).toBe(false);
    expect(subRunning({ ...base, ended: true })).toBe(false);
  });
});
