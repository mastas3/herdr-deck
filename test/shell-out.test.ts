import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { clipShell, pairShell, plainTerminal, SHELL_MAX_CHARS, SHELL_MAX_LINES } from "../src/shell-out";
import { claudeDetail, codexDetail } from "../src/transcript";

const dir = mkdtempSync(`${tmpdir()}/deck-shellout-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const line = (o: object) => JSON.stringify(o) + "\n";

describe("a command's output, kept with it", () => {
  test("plain text: colours, cursor codes and progress-bar rewrites are gone", () => {
    expect(plainTerminal("\x1b[32mok\x1b[0m\r\n\x1b]0;title\x07next\n10%\r50%\r100%")).toBe("ok\nnext\n100%");
  });

  test("clipped to its last lines and characters, with the full line count", () => {
    const many = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = clipShell(many, false);
    expect(r).toMatchObject({ state: "done", lines: 450, clipped: true });
    expect(r.out.split("\n")).toHaveLength(SHELL_MAX_LINES);
    expect(r.out.endsWith("line 450")).toBe(true);
    const wide = Array.from({ length: 50 }, (_, i) => `${i}:` + "x".repeat(1000)).join("\n");
    const w = clipShell(wide, true);
    expect(w.state).toBe("error");
    expect(w.out.length).toBeLessThanOrEqual(SHELL_MAX_CHARS);
    expect(w.out.startsWith(String(w.out.split(":")[0]) + ":")).toBe(true); // starts on a whole line
    expect(w.out.endsWith("x")).toBe(true);
    expect(w.clipped).toBe(true);
  });

  test("no output is no lines", () => {
    expect(clipShell("(Bash completed with no output)", false)).toEqual({ state: "done", out: "", lines: 0 });
    expect(clipShell("\n\n", false)).toEqual({ state: "done", out: "", lines: 0 });
    expect(clipShell("one\ntwo\n", false)).toEqual({ state: "done", out: "one\ntwo", lines: 2 });
  });

  test("pairs with the newest command without a result, never an older or finished one", () => {
    const ms: any[] = [{ role: "user", text: "! ls" }, { role: "tool", tool: "Shell" }, { role: "user", text: "! pwd" }];
    expect(pairShell(ms, clipShell("/tmp", false))).toBe(2);
    expect(ms[2].shell.out).toBe("/tmp");
    expect(pairShell(ms, clipShell("x", false))).toBe(0); // the only one left without a result
    expect(pairShell([{ role: "user", text: "hello" }], clipShell("x", false))).toBe(-1);
  });
});

describe("the parser keeps the output with the command", () => {
  test("Claude Code: stdout and stderr attach to the ! command; the Shell row still comes, pointing at it", async () => {
    const path = `${dir}/claude.jsonl`;
    const out = Array.from({ length: 30 }, (_, i) => `\x1b[1mfile${i}\x1b[0m`).join("\n");
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-29T10:00:00Z", message: { content: "<bash-input>ls</bash-input>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:00:02Z", message: { content: `<bash-stdout>${out}</bash-stdout><bash-stderr>warning: slow disk</bash-stderr>` } }) +
      line({ type: "user", timestamp: "2026-09-29T10:01:00Z", message: { content: "<bash-input>cat nope</bash-input>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:01:01Z", message: { content: "<bash-stdout></bash-stdout><bash-stderr>cat: nope: No such file\n</bash-stderr>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:02:00Z", message: { content: "<bash-input>true</bash-input>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:02:01Z", message: { content: "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>" } }));
    const d = await claudeDetail(path);
    const [ls, lsRow, cat, catRow, ok, okRow] = d.messages;
    expect(ls).toMatchObject({ role: "user", text: "! ls", shell: { state: "done", lines: 31 } });
    expect(ls.shell!.out.split("\n")[0]).toBe("file0");
    expect(ls.shell!.out.endsWith("warning: slow disk")).toBe(true);
    expect(lsRow).toMatchObject({ role: "tool", tool: "Shell", summary: "file0", state: "done", of: 0 });
    expect(cat.shell).toEqual({ state: "error", out: "cat: nope: No such file", lines: 1 });
    expect(catRow).toMatchObject({ tool: "Shell", state: "error", of: 2 });
    expect(ok.shell).toEqual({ state: "done", out: "", lines: 0 });
    expect(okRow.of).toBe(4);
  });

  test("a command still running has no result yet; it gets one when the output lands (read incrementally)", async () => {
    const path = `${dir}/claude-live.jsonl`;
    writeFileSync(path, line({ type: "user", timestamp: "2026-09-29T10:00:00Z", message: { content: "<bash-input>sleep 5</bash-input>" } }));
    expect((await claudeDetail(path)).messages[0].shell).toBeUndefined();
    writeFileSync(path, line({ type: "user", timestamp: "2026-09-29T10:00:00Z", message: { content: "<bash-input>sleep 5</bash-input>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:00:05Z", message: { content: "<bash-stdout>slept</bash-stdout><bash-stderr></bash-stderr>" } }));
    const d = await claudeDetail(path);
    expect(d.messages[0].shell).toEqual({ state: "done", out: "slept", lines: 1 });
  });

  test("Codex: a shell command you ran keeps its output too", async () => {
    const path = `${dir}/rollout-2026-09-29T10-00-00-019f0000-0000-7000-8000-000000000002.jsonl`;
    const shell = (cmd: string, code: number, out: string) => ({ type: "input_text", text: `<user_shell_command>\n<command>\n${cmd}\n</command>\n<result>\nExit code: ${code}\nDuration: 0.03 seconds\nOutput:\n${out}\n</result>\n</user_shell_command>` });
    const item = (content: any[]) => line({ timestamp: "2026-09-29T10:00:00Z", type: "response_item", payload: { type: "message", role: "user", content } });
    writeFileSync(path, item([shell("git status", 0, "On branch main\nnothing to commit")]) + item([shell("false", 1, "")]));
    const d = await codexDetail(path);
    expect(d.messages[0]).toMatchObject({ text: "! git status", shell: { state: "done", out: "On branch main\nnothing to commit", lines: 2 } });
    expect(d.messages[1]).toMatchObject({ tool: "Shell", of: 0 });
    expect(d.messages[2].shell).toEqual({ state: "error", out: "", lines: 0 });
  });
});
