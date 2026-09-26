// Tools: one click that makes an agent (or the deck) do something useful. They replace recipes.
// Three kinds: a prompt sent to the agent, a sequence (prompt, wait for the agent to finish, next step),
// and a deck action that runs here (share a dev server, verify, find related past work).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const FILE = `${homedir()}/.config/herdr-deck/tools.json`;
export const HANDOFF_DIR = `${homedir()}/.config/herdr-deck/handoffs`;

export type Tool = {
  id: string;
  label: string;
  group: "context" | "session" | "knowledge" | "check" | "share" | "custom";
  icon: string;
  hint: string;
  kind: "prompt" | "sequence" | "action";
  prompt?: string; // prompt and the first step of a sequence
  then?: string; // sequence: sent once the agent has finished the first step
  action?: "share" | "verify" | "related" | "upload";
  agents?: string[];
  builtin?: boolean;
  multi?: boolean; // makes sense for many sessions at once
};

export const GROUPS: Record<Tool["group"], string> = {
  context: "Give it context",
  session: "Steer the session",
  knowledge: "Keep knowledge",
  check: "Check the work",
  share: "Show me",
  custom: "Your tools",
};

export const BUILTIN: Tool[] = [
  {
    id: "email", label: "Check my email", group: "context", icon: "mail", kind: "prompt", multi: true,
    hint: "The agent searches your Gmail for anything about this work, then carries on with that context",
    prompt: "Before you continue: check my email for context on this work. Use the Gmail tools you have (search recent threads about {project}, \"{title}\", and the people or products involved). Summarise what matters in up to 5 bullets: requests, deadlines, decisions, open questions, with who said it and when. Then tell me if it changes the plan, and continue. If you have no email access, say so in one line and continue.",
  },
  {
    id: "related", label: "Related past work", group: "context", icon: "history", kind: "action", action: "related",
    hint: "The deck finds past sessions about this project and hands the agent the list, with where to read them",
  },
  {
    id: "upload", label: "Attach files", group: "context", icon: "clip", kind: "action", action: "upload",
    hint: "Upload files (or drop them on the chat); the agent gets their paths",
  },
  {
    id: "handoff-compact", label: "Handoff → compact", group: "session", icon: "compact", kind: "sequence", agents: ["claude", "codex", "opencode"],
    hint: "Writes a handoff note, waits for it, then compacts the context around that note",
    prompt: "Write a handoff note for this session to {handoff} (create the folder if needed). Sections: Goal; Done so far (with file paths and commits); Current state; Next steps (ordered); Decisions and why; Open questions; Gotchas. Keep it under 80 lines, facts only. Reply with just \"Handoff written: <path>\" when done.",
    then: "/compact Keep only what the next steps need. The full handoff note is at {handoff}; read it first when you continue.",
  },
  {
    id: "status", label: "Status in one line", group: "session", icon: "pulse", kind: "prompt", multi: true,
    hint: "Asks for a one-line status: what's done, what's next, anything blocking",
    prompt: "In one line: what's done, what's next, and anything blocking you. No tools.",
  },
  {
    id: "step-back", label: "Step back", group: "session", icon: "back", kind: "prompt",
    hint: "For an agent going in circles: stop, list what was tried, propose a different approach",
    prompt: "Stop and step back. List what you've tried and why each didn't work, name the assumption that's probably wrong, and propose a different approach. Wait for my OK before continuing.",
  },
  {
    id: "wiki", label: "Update the wiki", group: "knowledge", icon: "book", kind: "prompt", multi: true,
    hint: "Files what this session learned into your LLM wiki (~/wiki), following its rules",
    prompt: "Update my LLM wiki at ~/wiki with what this session did and learned. Read ~/wiki/CLAUDE.md first and follow it exactly: update (or create) the page for {project} under projects/, touch the related concept/entity pages, refresh index.md and append one line to log.md. Summaries only; never copy secrets, tokens or .env contents. Tell me which pages you changed.",
  },
  {
    id: "handoff", label: "Write a handoff note", group: "knowledge", icon: "note", kind: "prompt",
    hint: "A handoff note only, no compaction",
    prompt: "Write a handoff note for this session to {handoff}: goal, done so far (paths, commits), current state, next steps, decisions, open questions, gotchas. Under 80 lines. Reply with the path.",
  },
  {
    id: "verify", label: "Verify it's done", group: "check", icon: "check", kind: "action", action: "verify",
    hint: "The deck re-runs this project's checks itself and Jev judges the evidence",
  },
  {
    id: "tests", label: "Run the tests", group: "check", icon: "flask", kind: "prompt", multi: true,
    hint: "The agent runs the tests and reports honestly, with the command and output",
    prompt: "Run the project's tests and type checks now. Report the exact commands, pass/fail counts, and the first failure verbatim if any. Don't fix anything yet, and don't claim success without output.",
  },
  {
    id: "review", label: "Review your diff", group: "check", icon: "eye", kind: "prompt",
    hint: "Self-review of uncommitted changes: bugs, leftovers, risks",
    prompt: "Review your uncommitted changes (git diff) as a strict reviewer: correctness bugs, edge cases, leftovers (debug code, TODOs), security issues, and anything untested. List findings by severity, then fix only the real bugs.",
  },
  {
    id: "share", label: "Tailscale link", group: "share", icon: "globe", kind: "action", action: "share",
    hint: "Puts the dev server this session runs on your tailnet, so you can open it on your phone",
  },
  {
    id: "show-me", label: "Show me what you built", group: "share", icon: "play", kind: "prompt",
    hint: "The agent starts it (if needed) and gives you a link you can open anywhere",
    prompt: "Show me what you built. If it's a web app, start its dev server if it isn't running, bound to 0.0.0.0 or localhost, then share it on my tailnet with `tailscale serve --bg --https=<port> http://localhost:<port>` and give me the https://…ts.net link. Otherwise show a screenshot or the output. One short paragraph.",
  },
];

let custom: Tool[] = [];
try { custom = JSON.parse(readFileSync(FILE, "utf8")); } catch {}

export const loadTools = (): Tool[] => [...BUILTIN.map((t) => ({ ...t, builtin: true })), ...custom];

export function saveCustomTools(list: Partial<Tool>[]): Tool[] {
  custom = list
    .filter((t) => t && String(t.label ?? "").trim() && String(t.prompt ?? "").trim())
    .slice(0, 40)
    .map((t, i) => ({
      id: String(t.id ?? "").match(/^c-[\w-]+$/) ? String(t.id) : `c-${Date.now().toString(36)}-${i}`,
      label: String(t.label).trim().slice(0, 40),
      group: "custom" as const,
      icon: "star",
      hint: String(t.hint ?? "").trim().slice(0, 140),
      kind: "prompt" as const,
      prompt: String(t.prompt).trim().slice(0, 4000),
      multi: true,
    }));
  mkdirSync(`${homedir()}/.config/herdr-deck`, { recursive: true });
  writeFileSync(FILE, JSON.stringify(custom, null, 1));
  return loadTools();
}

export function handoffPath(row: { project?: string; sessionId?: string }) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const slug = String(row.project ?? "session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
  return `${HANDOFF_DIR}/${slug}-${day}-${String(row.sessionId ?? "x").slice(0, 8)}.md`;
}

export function fillTool(text: string, row: { project?: string; branch?: string; title?: string; sessionId?: string }, extra: Record<string, string> = {}) {
  const vars: Record<string, string> = { project: row.project ?? "", branch: row.branch ?? "", title: row.title ?? "", handoff: handoffPath(row), ...extra };
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
