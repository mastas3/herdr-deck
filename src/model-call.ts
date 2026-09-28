// One headless Claude Code call (print mode, a fast model, low effort, no tools, MCP, settings or plugins, nothing
// saved) and reading the loosely formatted JSON it answers with. Lent to plugins that ask a model for a short JSON
// answer: project pages (their AI read) and the quest board (today's quests) share it.
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const HOME = homedir();
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").replace(/\/(?:Users|home)\/[^/\s]+/g, "~").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };

// ── parsing and repair ─────────────────────────────────────────────────────────────
/** Closes whatever a truncated reply left open (strings, arrays, objects), so the complete part still parses. */
export function closeJson(t: string): string {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (const c of t) {
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if ((c === "}" || c === "]") && stack.length) stack.pop();
  }
  let out = t;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, "").replace(/,\s*"[^"]*"\s*:?\s*$/, "").replace(/:\s*$/, ": null");
  return out + stack.reverse().join("");
}
const loose = (t: string) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1");
export function parseJsonLoose(text: string): any {
  const t = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("{");
  if (a < 0) return undefined;
  const b = t.lastIndexOf("}");
  for (const cand of [b > a ? t.slice(a, b + 1) : "", t.slice(a)]) {
    if (!cand) continue;
    for (const f of [(x: string) => x, loose, (x: string) => closeJson(loose(x))]) { try { const j = JSON.parse(f(cand)); if (j && typeof j === "object") return j; } catch {} }
  }
  return undefined;
}

// ── the call ──────────────────────────────────────────────────────────────────────
const BIN_DIRS = [`${HOME}/.local/bin`, `${HOME}/.claude/local`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH ?? "").split(":")];
const CLAUDE = process.env.DECK_CLAUDE_BIN || BIN_DIRS.map((d) => `${d}/claude`).find((p) => existsSync(p));
export const claudeAvailable = () => !!CLAUDE;
export type Runner = (system: string, user: string, timeoutMs: number) => Promise<{ text: string; model: string }>;

/** Headless Claude Code: print mode, a small fast model, low effort, no tools/MCP/settings/plugins, nothing saved. */
export const runClaude: Runner = async (system, user, timeoutMs) => {
  if (!CLAUDE) throw new Error("Claude Code (claude) isn't installed here");
  const model = process.env.DECK_JOURNEY_MODEL || "haiku";
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", MAX_THINKING_TOKENS: "0", NO_COLOR: "1" };
  delete env.CLAUDECODE;
  const p = Bun.spawn([CLAUDE, "-p", "--safe-mode", "--model", model, "--effort", "low", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "",
    "--output-format", "json", "--system-prompt", system], { cwd: tmpdir(), stdin: new Blob([user]), stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => { try { p.kill(9); } catch {} }, timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
    await p.exited;
    if (p.signalCode) throw new Error("Claude took too long");
    let j: any; try { j = JSON.parse(out); } catch { throw new Error(clip(err.split("\n").filter(Boolean).pop() || "Claude returned nothing readable", 160)); }
    if (j.is_error) throw new Error(clip(j.result || "Claude reported an error", 160));
    return { text: String(j.result ?? ""), model };
  } finally { clearTimeout(timer); }
};
