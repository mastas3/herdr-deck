// Limit handoff, the pure part: spotting an agent's own "you've hit your limit" line, the message that asks an agent
// for a handoff note, finding its reply, and building a note from the transcript when the agent can't answer.

/** The lines Claude Code and Codex print when a plan limit stops them (not prose that merely mentions limits). */
const LIMIT = /(claude (ai )?usage limit reached|\b(5-hour|five-hour|weekly|opus weekly|session) limit reached|you['’]ve hit your (usage )?limit|you['’]ve reached your (usage )?limit|usage limit reached\W+(your limit will reset|resets?|try again))/i;
export function limitLine(lines: (string | undefined)[]): string | undefined {
  for (const l of lines) if (l && LIMIT.test(l)) return l.replace(/\s+/g, " ").trim().slice(0, 200);
}

export const NOTE_MARK = "HANDOFF NOTE";
/** What we send when the agent can still answer. It replies in chat, so it needs no extra file permissions. */
export function askMessage(target: string) {
  return `Your usage limit is nearly used up, so ${target} will continue this work in a new session. Stop what you are doing and reply with a handoff note only, starting with the line "${NOTE_MARK}". Include: the goal, what is done, what is left (in order), files and branch you touched, commands to check the work, and any open question for me. Plain words, no preamble.`;
}
type Msg = { i?: number; role: string; text?: string; tool?: string; summary?: string; at?: number };
/** The agent's note: the newest assistant reply after we asked that carries the mark. */
export function findNote(messages: Msg[], askedAt: number): string | undefined {
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k];
    if (m.role !== "assistant" || !m.text || (m.at && m.at < askedAt - 5000)) continue;
    const at = m.text.indexOf(NOTE_MARK);
    if (at >= 0) return m.text.slice(at + NOTE_MARK.length).replace(/^[\s:*#-]+/, "").trim() || undefined;
  }
}

const EDIT = /^(edit|write|multiedit|notebookedit|apply_patch|patch|update|create)\b/i;
const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** Paths the session edited, newest first. */
export function touchedFiles(messages: Msg[], max = 12): string[] {
  const out: string[] = [];
  for (let k = messages.length - 1; k >= 0 && out.length < max; k--) {
    const m = messages[k];
    if (m.role !== "tool" || !EDIT.test(m.tool ?? "")) continue;
    for (const p of String(m.summary ?? "").match(/[\w@~.\-]*\/?[\w@.\-\/]+\.\w{1,8}/g) ?? []) if (!out.includes(p) && out.length < max) out.push(p);
  }
  return out;
}

export type NoteInput = {
  row: { title?: string; project?: string; agent?: string; cwd?: string; projectRoot?: string; branch?: string; dirty?: number; firstPrompt?: string; lastMessage?: string; step?: string; todos?: { done: number; total: number } };
  messages: Msg[]; target: string; why?: string;
};
const NAME: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

/** A handoff note from what the transcript shows: recent requests, where it stopped, files, branch, open question. */
export function buildNote({ row, messages, target, why }: NoteInput): string {
  const asks = messages.filter((m) => m.role === "user" && m.text?.trim()).map((m) => m.text!);
  const recent = (asks.length ? asks : [row.firstPrompt].filter(Boolean) as string[]).slice(-4);
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.text?.trim())?.text ?? row.lastMessage ?? "";
  const question = last.trim().split(/\n+/).reverse().find((l) => /\?\s*$/.test(l));
  const files = touchedFiles(messages);
  const where = row.projectRoot ?? row.cwd ?? "";
  const lines = [
    `Continue this work from a ${NAME[row.agent ?? ""] ?? row.agent ?? "previous"} session${why ? ` that stopped at its usage limit (${why})` : " that is near its usage limit"}. You are ${NAME[target] ?? target}.`,
    `Project: ${row.project || "?"}${where ? ` in ${where}` : ""}${row.branch ? `, branch ${row.branch}` : ""}${row.dirty ? `, ${row.dirty} uncommitted file${row.dirty === 1 ? "" : "s"}` : ""}.`,
    recent.length ? `What was asked (oldest first):\n${recent.map((a) => `- ${cut(a, 400)}`).join("\n")}` : "",
    row.step ? `The step in progress: ${cut(row.step, 200)}${row.todos ? ` (${row.todos.done} of ${row.todos.total} done)` : ""}.` : "",
    last ? `Where it stopped (its last reply):\n${cut(last, 900)}` : "",
    files.length ? `Files it edited recently: ${files.join(", ")}` : "",
    question && question !== last.trim() ? `Open question it asked: ${cut(question, 300)}` : "",
    "Start with `git status` and `git diff` to see the real state, then carry on. Ask me before anything risky.",
  ];
  return lines.filter(Boolean).join("\n\n");
}
