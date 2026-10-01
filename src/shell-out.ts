// The output of a command you ran yourself ("!" in Claude Code, a shell command in Codex), kept with the command so
// the chat can show what it printed. Clipped to its end: the last lines are the ones that say how it went.

export type ShellResult = { state: "done" | "error"; out: string; lines: number; clipped?: boolean };

export const SHELL_MAX_LINES = 200;
export const SHELL_MAX_CHARS = 16_000;

/** Terminal text as it reads: colours and other escape codes dropped, and a line rewritten with \r (a progress bar)
 *  shows only its last state. */
export function plainTerminal(s: string): string {
  return String(s ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n").map((l) => l.split("\r").pop() ?? "").join("\n");
}

/** What Claude Code writes when a command printed nothing. */
const NO_OUTPUT = /^\(Bash completed with no output\)$/;

/** The command's output, ready to keep: plain text, its last SHELL_MAX_LINES lines and SHELL_MAX_CHARS characters,
 *  with the full line count so the chat can say how much there was. */
export function clipShell(out: string, failed: boolean): ShellResult {
  const text = plainTerminal(out).replace(/\s+$/, "").replace(/^\n+/, "");
  const all = !text || NO_OUTPUT.test(text.trim()) ? [] : text.split("\n");
  let kept = all.slice(-SHELL_MAX_LINES);
  let body = kept.join("\n");
  if (body.length > SHELL_MAX_CHARS) {
    body = body.slice(-SHELL_MAX_CHARS);
    const nl = body.indexOf("\n");
    if (nl >= 0 && nl < body.length - 1) body = body.slice(nl + 1); // start on a whole line
    kept = body.split("\n");
  }
  const r: ShellResult = { state: failed ? "error" : "done", out: body, lines: all.length };
  if (kept.length < all.length) r.clipped = true;
  return r;
}

type Shellish = { role: string; text?: string; shell?: ShellResult };
/** The command a result belongs to: your newest "! command" without a result, a few entries back at most (the
 *  output record follows its command straight away). Returns its position in `messages`, or -1. */
export function pairShell(messages: Shellish[], result: ShellResult): number {
  for (let k = messages.length - 1; k >= Math.max(0, messages.length - 4); k--) {
    const m = messages[k];
    if (m.role === "user" && /^!\s/.test(m.text ?? "") && !m.shell) { m.shell = result; return k; }
  }
  return -1;
}
