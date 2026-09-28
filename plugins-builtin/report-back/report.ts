// A finished turn, read from the transcript the deck already parses (src/transcript.ts): the agent's own one-line
// summary, the files it edited, the tests and checks it ran and how they ended. Pure: server.ts adds git and proof of
// done. No model calls.
import { EDIT_TOOLS, type Msg } from "../../src/transcript";

export type Check = { cmd: string; ok: boolean };
export type Report = {
  key: string; machine?: string; agent: string; sessionId: string; project: string; title: string;
  /** When the turn ended (the session's last activity) and began. `sig` is what it was built from. */
  at: number; since?: number; sig: string;
  summary: string; source: "message" | "report-file";
  files: string[]; fileCount: number;
  git?: { files: number; add: number; del: number; commits: number };
  checks: Check[];
  proof?: { state: string; cmd?: string };
  reportFile?: string; doneMarker?: boolean;
  dismissed?: boolean;
};

/** The messages of the last turn: from the ask that started it on. An ask sent while the agent was still running
 *  tools (a steer) belongs to the same turn, so keep going back past those. */
export function lastTurn(messages: Msg[]): Msg[] {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    start = i;
    let k = i - 1;
    while (k >= 0 && messages[k].role === "note") k--;
    if (k < 0 || messages[k].role !== "tool") break;
  }
  return messages.slice(start + 1);
}

const GENERIC = /^(summary|done|report|result|results|status|update|changes|what (i )?changed|all set|finished)[.:!]?$/i;
const plainMd = (s: string) => s
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1")
  .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
const cap = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

/** One line from an agent's final message: its first heading, else its first sentence (two if the first is "Done."). */
export function summaryLine(text: string | undefined): string {
  if (!text) return "";
  const lines = text.replace(/```[\s\S]*?(```|$)/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) { const t = plainMd(h[1]); if (t && !GENERIC.test(t)) return cap(t); continue; }
    const para = plainMd(lines[i]);
    if (!para || GENERIC.test(para)) continue;
    const first = (t: string) => t.match(/^(.*?[.!?])(?:\s+(.*))?$/) ?? [t, t, ""];
    const [, one, rest] = first(para);
    let out = one;
    if (out.length < 16 && rest) out = `${out} ${first(rest)[1]}`;
    return cap(out);
  }
  return "";
}

/** Commands that test or check the work: test runners, type checks, linters, builds. */
const CHECK_RE = /\b(test|tests|pytest|vitest|jest|mocha|playwright|spec|typecheck|tsc|lint|eslint|ruff|mypy|clippy|go vet|cargo (?:test|check|build)|build|check)\b/i;
const SHELL_TOOL = /^(bash|shell|exec_command|local_shell|run|command|terminal)$/i;

export function readTurn(turn: Msg[]) {
  const files: string[] = [];
  const checks: Check[] = [];
  for (const m of turn) {
    if (m.role !== "tool" || !m.tool) continue;
    const name = m.tool.split(" · ").pop()!;
    if (EDIT_TOOLS.test(name) && m.summary && m.state !== "error") {
      for (const f of m.summary.split(/,\s*/)) if (f && !files.includes(f)) files.push(f);
    } else if (SHELL_TOOL.test(name) && m.summary && CHECK_RE.test(m.summary) && m.state !== "running") {
      checks.push({ cmd: m.summary, ok: m.state !== "error" });
    }
  }
  const final = [...turn].reverse().find((m) => m.role === "assistant" && m.text?.trim())?.text;
  return { files, checks, final };
}

/** How the checks ended: the last run of each command decides (a failure fixed later counts as passing). */
export function verdict(checks: Check[], proof?: { state: string }): "pass" | "fail" | undefined {
  const last = new Map<string, boolean>();
  for (const c of checks) last.set(c.cmd, c.ok);
  if (last.size) return [...last.values()].every(Boolean) ? "pass" : "fail";
  if (proof?.state === "pass") return "pass";
  if (proof?.state === "fail") return "fail";
}

/** The chip on the list and board: "Done · 3 files · tests pass". */
export function chipText(r: Pick<Report, "fileCount" | "git" | "checks" | "proof">) {
  const n = Math.max(r.fileCount, r.git?.files ?? 0);
  const v = verdict(r.checks, r.proof);
  const what = r.checks.length ? "tests" : "checks";
  return ["Done", n ? `${n} file${n === 1 ? "" : "s"}` : "no file changes", v ? `${what} ${v}` : ""].filter(Boolean).join(" · ");
}
