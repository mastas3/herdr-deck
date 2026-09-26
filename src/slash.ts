// The "/" menu: every slash command the session's agent understands on this machine.
// Claude Code's built-ins come from its own installed binary (so the list matches the version you run),
// plus your commands, plugin commands and skills. Codex and OpenCode get their documented built-ins plus
// your custom prompts/commands.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const HOME = homedir();
const CACHE = `${HOME}/.cache/herdr-deck`;

export type Slash = { cmd: string; desc?: string; hint?: string; src: "built-in" | "yours" | "project" | "plugin" | "skill" | "prompt" };

const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const ls = (p: string) => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };

function frontmatter(md: string) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const firstLine = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
  return { name: get("name"), desc: get("description") ?? firstLine, hint: get("argument-hint"), userInvocable: get("user-invocable") };
}
const clip = (raw: string | undefined, n = 140) => {
  const s = raw?.replace(/\*\*|__|`/g, "").replace(/^\s*(purpose|description)\s*:\s*/i, "").trim();
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** Markdown commands in a folder; subfolders become "dir:name" like Claude Code does. */
function mdCommands(dir: string, src: Slash["src"], prefix = ""): Slash[] {
  const out: Slash[] = [];
  const walk = (d: string, ns: string, depth: number) => {
    for (const e of ls(d)) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      if (e.isDirectory() && depth < 3) walk(join(d, e.name), ns ? `${ns}:${e.name}` : e.name, depth + 1);
      else if (e.name.endsWith(".md")) {
        const fm = frontmatter(readText(join(d, e.name)));
        const n = basename(e.name, ".md");
        out.push({ cmd: "/" + prefix + (ns ? `${ns}:${n}` : n), desc: clip(fm.desc), hint: fm.hint, src });
      }
    }
  };
  walk(dir, "", 0);
  return out;
}
function skillCommands(dir: string, src: Slash["src"], prefix = ""): Slash[] {
  const out: Slash[] = [];
  for (const e of ls(dir)) {
    if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name.startsWith("_") || e.name.startsWith(".")) continue;
    const md = readText(join(dir, e.name, "SKILL.md"));
    if (!md) continue;
    const fm = frontmatter(md);
    if (fm.userInvocable === "false") continue;
    out.push({ cmd: "/" + prefix + (fm.name ?? e.name), desc: clip(fm.desc), src });
  }
  return out;
}

// ── Claude Code ──────────────────────────────────────────────────────────────
function claudeBinary(): string | undefined {
  for (const p of [`${HOME}/.local/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude", `${HOME}/.claude/local/claude`]) {
    try { if (existsSync(p)) return realpathSync(p); } catch {}
  }
}
const HIDDEN = new Set(["heapdump", "pro-trial-expired", "rate-limit-options", "workflow-launch-exec", "passes", "wellbeing", "plugin-types", "extra-usage", "stickers"]);

/** Reads the command table out of the installed binary once per version (about a second), then caches it. */
async function claudeBuiltins(): Promise<Slash[]> {
  const bin = claudeBinary();
  if (!bin) return [];
  let st;
  try { st = statSync(bin); } catch { return []; }
  const cacheFile = `${CACHE}/slash-claude-${basename(bin)}-${Math.round(st.mtimeMs)}.json`;
  try { return JSON.parse(readFileSync(cacheFile, "utf8")); } catch {}
  let text = "";
  try { text = (await Bun.file(bin).arrayBuffer().then((b) => Buffer.from(b))).toString("latin1"); } catch { return []; }
  const found = new Map<string, Slash>();
  const re = /type:"(?:local|local-jsx|prompt)",name:"([a-z][a-z0-9-]{1,40})"([^{}]{0,700})/g;
  for (const m of text.matchAll(re)) {
    const name = m[1], rest = m[2];
    if (HIDDEN.has(name) || /isHidden:!0/.test(rest)) continue;
    const desc = rest.match(/description:"((?:[^"\\]|\\.){3,200})"/)?.[1] ?? rest.match(/description\(\)\{return`([^`]{3,200})`/)?.[1]?.replace(/\$\{[^}]*\}/g, "…");
    const hint = rest.match(/argumentHint:"([^"]{1,60})"/)?.[1];
    const prev = found.get(name);
    if (!prev || (!prev.desc && desc)) found.set(name, { cmd: "/" + name, desc: clip(desc), hint, src: "built-in" });
  }
  text = "";
  const list = [...found.values()].sort((a, b) => a.cmd.localeCompare(b.cmd));
  try { mkdirSync(CACHE, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(list)); } catch {}
  return list;
}

function claudePlugins(): Slash[] {
  const out: Slash[] = [];
  const reg = (() => { try { return JSON.parse(readText(`${HOME}/.claude/plugins/installed_plugins.json`)).plugins ?? {}; } catch { return {}; } })();
  const enabled = (() => { try { return JSON.parse(readText(`${HOME}/.claude/settings.json`)).enabledPlugins ?? {}; } catch { return {}; } })();
  for (const [id, installs] of Object.entries<any>(reg)) {
    if (enabled[id] === false) continue;
    const inst = Array.isArray(installs) ? installs[installs.length - 1] : installs;
    const root = inst?.installPath;
    if (!root) continue;
    const plugin = id.split("@")[0];
    out.push(...mdCommands(join(root, "commands"), "plugin", `${plugin}:`));
    out.push(...skillCommands(join(root, "skills"), "plugin", `${plugin}:`));
  }
  return out;
}

async function claudeCommands(cwd: string): Promise<Slash[]> {
  return [
    ...mdCommands(join(cwd, ".claude/commands"), "project"),
    ...skillCommands(join(cwd, ".claude/skills"), "project"),
    ...mdCommands(`${HOME}/.claude/commands`, "yours"),
    ...skillCommands(`${HOME}/.claude/skills`, "skill"),
    ...claudePlugins(),
    ...(await claudeBuiltins()),
  ];
}

// ── Codex (codex-cli 0.15x) ─────────────────────────────────────────────────
const CODEX: [string, string, string?][] = [
  ["model", "Choose what model and reasoning effort to use"], ["permissions", "Choose what Codex is allowed to do"], ["approvals", "Choose what Codex can do without asking"],
  ["review", "Review my current changes and find issues"], ["rename", "Rename the current thread", "[name]"], ["new", "Start a new chat during a conversation"],
  ["resume", "Resume a saved chat"], ["fork", "Fork the current chat"], ["compact", "Summarize the conversation to free up context"], ["recap", "Summarize the current conversation now"],
  ["plan", "Switch to Plan mode"], ["goal", "Set or view the goal for a long-running task"], ["init", "Create an AGENTS.md file with instructions for Codex"],
  ["diff", "Show git diff (including untracked files)"], ["mention", "Mention a file"], ["status", "Show session configuration and token usage"],
  ["usage", "View account usage"], ["copy", "Copy the last response"], ["export", "Export the conversation as markdown"], ["side", "Start a side conversation in an ephemeral fork"],
  ["agent", "View and switch between active agent sessions"], ["subagents", "Switch between this session's subagents"], ["cd", "Change the working directory"], ["pwd", "Show the working directory"],
  ["skills", "Use skills to improve how Codex performs tasks"], ["hooks", "View and manage lifecycle hooks"], ["memories", "Configure memory use and generation"],
  ["mcp", "List configured MCP tools"], ["apps", "Manage apps"], ["plugins", "Browse plugins"], ["personality", "Choose a communication style for Codex"],
  ["statusline", "Configure the status line"], ["theme", "Choose a syntax highlighting theme"], ["ps", "List background terminals"], ["stop", "Stop all background terminals"],
  ["worktree", "Start or continue a conversation in a new worktree"], ["app", "Continue this session in the Desktop app"], ["archive", "Archive this session"],
  ["clear", "Clear the terminal and start a new chat"], ["feedback", "Send logs to maintainers"], ["logout", "Log out of Codex"], ["quit", "Exit Codex"],
];
function codexCommands(): Slash[] {
  const prompts = mdCommands(`${HOME}/.codex/prompts`, "prompt", "prompts:");
  return [...prompts, ...skillCommands(`${HOME}/.codex/skills`, "skill", "$").map((s) => ({ ...s, cmd: s.cmd.replace(/^\/\$/, "$") })), ...CODEX.map(([c, d, h]) => ({ cmd: "/" + c, desc: d, hint: h, src: "built-in" as const }))];
}

// ── OpenCode ─────────────────────────────────────────────────────────────────
const OPENCODE: [string, string][] = [
  ["new", "Start a new session"], ["sessions", "List and switch sessions"], ["compact", "Summarize the session to free up context"], ["models", "Choose a model"],
  ["agents", "Choose an agent"], ["undo", "Undo the last message and file changes"], ["redo", "Redo"], ["share", "Share this session"], ["unshare", "Stop sharing"],
  ["init", "Create or update AGENTS.md"], ["details", "Toggle tool details"], ["thinking", "Toggle thinking blocks"], ["export", "Export the session to Markdown"],
  ["editor", "Compose in your editor"], ["themes", "Choose a theme"], ["help", "Show help"], ["exit", "Exit OpenCode"],
];
function opencodeCommands(cwd: string): Slash[] {
  return [
    ...mdCommands(join(cwd, ".opencode/command"), "project"),
    ...mdCommands(`${HOME}/.config/opencode/command`, "yours"),
    ...mdCommands(`${HOME}/.config/opencode/commands`, "yours"),
    ...OPENCODE.map(([c, d]) => ({ cmd: "/" + c, desc: d, src: "built-in" as const })),
  ];
}

const memo = new Map<string, { at: number; list: Slash[] }>();
export async function slashCommands(agent: string, cwd: string): Promise<Slash[]> {
  const k = `${agent}|${cwd}`;
  const m = memo.get(k);
  if (m && Date.now() - m.at < 60_000) return m.list;
  const raw = agent === "claude" ? await claudeCommands(cwd) : agent === "codex" ? codexCommands() : agent === "opencode" ? opencodeCommands(cwd) : [];
  const seen = new Set<string>();
  const list = raw.filter((s) => (seen.has(s.cmd) ? false : (seen.add(s.cmd), true)));
  memo.set(k, { at: Date.now(), list });
  return list;
}
/** Warm Claude's list at startup so the first "/" is instant. */
export const warmSlash = () => { claudeBuiltins().catch(() => {}); };
