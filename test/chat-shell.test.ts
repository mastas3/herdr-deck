import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeDetail, codexDetail } from "../src/transcript";
import { codexUserText } from "../src/agents";

const dir = mkdtempSync(`${tmpdir()}/deck-shell-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const line = (o: object) => JSON.stringify(o) + "\n";
const shown = (d: Awaited<ReturnType<typeof claudeDetail>>) => d.messages.map((m) => [m.role, m.role === "tool" ? `${m.tool}: ${m.summary} (${m.state})` : m.text]);

describe("commands you ran yourself show as your messages", () => {
  test("Claude Code: ! commands and slash commands", async () => {
    const path = `${dir}/claude.jsonl`;
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-29T10:00:00Z", message: { content: "Fix the build" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:01:00Z", message: { content: "<bash-input> launchctl kickstart -k gui/501/dev.herdr-deck</bash-input>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:01:01Z", message: { content: "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:02:00Z", message: { content: "<bash-input>ls nope</bash-input>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:02:01Z", message: { content: "<bash-stdout></bash-stdout><bash-stderr>ls: nope: No such file or directory\n</bash-stderr>" } }) +
      line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>Caveat: …</local-command-caveat>" } }) +
      line({ type: "user", timestamp: "2026-09-29T10:03:00Z", message: { content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>Keep the plan</command-args>" } }));
    const d = await claudeDetail(path);
    expect(shown(d)).toEqual([
      ["user", "Fix the build"],
      ["user", "! launchctl kickstart -k gui/501/dev.herdr-deck"],
      ["tool", "Shell: (Bash completed with no output) (done)"],
      ["user", "! ls nope"],
      ["tool", "Shell: ls: nope: No such file or directory (error)"],
      ["user", "/compact Keep the plan"],
    ]);
    expect(d.asks).toBe(1); // a command isn't a request to the agent
  });

  test("Codex: a shell command you ran", async () => {
    const path = `${dir}/rollout-2026-09-29T10-00-00-019f0000-0000-7000-8000-000000000001.jsonl`;
    const shell = (cmd: string, code: number, out: string) => ({ type: "input_text", text: `<user_shell_command>\n<command>\n${cmd}\n</command>\n<result>\nExit code: ${code}\nDuration: 0.03 seconds\nOutput:\n${out}\n</result>\n</user_shell_command>` });
    const item = (content: any[]) => line({ timestamp: "2026-09-29T10:00:00Z", type: "response_item", payload: { type: "message", role: "user", content } });
    writeFileSync(path, item([{ type: "input_text", text: "Read the docs" }]) + item([shell("cat AGENTS.md", 0, "# LLM Wiki\nmore")]) + item([shell("false", 1, "")]));
    const d = await codexDetail(path);
    expect(shown(d)).toEqual([
      ["user", "Read the docs"],
      ["user", "! cat AGENTS.md"],
      ["tool", "Shell: # LLM Wiki (done)"],
      ["user", "! false"],
      ["tool", "Shell: no output (error)"],
    ]);
    expect(codexUserText([shell("ls", 0, "x")])).toBe(""); // never a session's first prompt or title
  });
});
