// Plugin manifests. A plugin is data, never code: a plugin.json plus the prompt files it points to. Strangers
// write these, so the validator rejects anything it doesn't know and every problem names its exact JSON path.
import type { Need } from "./recipes";

export type Machine = "hub" | "other";
export type AgentKind = "claude" | "codex" | "opencode";
export type Template = "inbox" | "list" | "board";
export type SchemaDef = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, SchemaDef>; required?: string[]; items?: SchemaDef;
  maxItems?: number; maxLength?: number; enum?: (string | number)[]; description?: string;
};
export type GrantDef = { tools: string[]; writes?: boolean };
export type SourceDef = { id: string; prompt: string; grants: string[]; schema: SchemaDef; refresh?: string; model?: string; machine?: Machine };
export type ViewDef = { id: string; title: string; template: Template; source: string; item: Record<string, string>; actions?: string[]; pin?: boolean };
export type ActionDef = { id: string; label: string; mode: "draft" | "session"; prompt: string; draftSchema?: SchemaDef; grants?: string[] };
export type PluginRecipe = { id: string; title: string; pitch: string; cat: string; needs: Need[]; optional?: Need[]; steps: string[]; prompt: string; folder?: string; agent?: AgentKind; machine?: Machine };
export type ProjectDef = { id: string; name: string; folder: string; repo?: { url: string; ref: string }; playbook?: string };
export type RoleDef = { id: string; project: string; title: string; agent: AgentKind; model?: string; prompt: string; machine?: Machine };
export type ScheduleDef = { id: string; every: string; role: string; prompt: string };
export type Manifest = {
  deck: 1; id: string; name: string; version: string; kind: "integration" | "business";
  author?: string; description?: string; homepage?: string; icon?: { glyph: string; color: string };
  requires?: { plugins?: string[]; connections?: Need[] };
  grants?: Record<string, GrantDef>;
  sources?: SourceDef[]; views?: ViewDef[]; actions?: ActionDef[]; recipes?: PluginRecipe[];
  projects?: ProjectDef[]; roles?: RoleDef[]; schedules?: ScheduleDef[];
};
/** A plugin as the deck holds it: the parsed manifest and its files by relative path ("plugin.json" included). */
export type Bundle = { manifest: Manifest; files: Record<string, string> };
export type Problem = { path: string; message: string };

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const MAX_PROMPT = 8000;
/** A prompt field that names a file beside plugin.json: plain segments only, so it can never climb out of the folder. */
const FILE_REF = /^[A-Za-z0-9_][\w-]*(\/[A-Za-z0-9_][\w-]*){0,3}\.(md|txt)$/;
export const isFileRef = (s: unknown): s is string => typeof s === "string" && FILE_REF.test(s);

// ── tools ─────────────────────────────────────────────────────────────────────
const BUILTIN = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Write", "Edit", "Bash"];
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const SCOPED_BASH = /^Bash\(([A-Za-z0-9_][\w .\/-]{0,60}):\*\)$/;
/** Programs that reach the network or run arbitrary code: scoping Bash to them is no scope at all. */
const OPEN_BIN = /^(curl|wget|nc|ncat|ssh|scp|rsync|sftp|ftp|telnet|http|https|python|python3|node|bun|deno|ruby|perl|php|sh|bash|zsh|fish|env|xargs|eval|exec|sudo|osascript|open|npx|pnpx|bunx|uvx|pipx)$/;

const READ_WORDS = new Set([
  "search", "get", "list", "read", "query", "find", "lookup", "view", "show", "describe",
  "count", "stats", "status", "log", "diff", "ls", "cat", "resolve", "inspect", "preview",
  "check", "info", "whoami", "history",
]);

const WRITE_WORDS = new Set([
  // Original WRITE_VERB verbs
  "send", "reply", "forward", "create", "delete", "remove", "trash", "update", "edit", "write",
  "post", "publish", "upload", "share", "move", "archive", "label", "unlabel", "mark", "apply",
  "set", "add", "merge", "close", "reopen", "comment", "push", "commit", "approve", "assign",
  "invite", "pay", "refund", "cancel", "disable", "enable", "rename", "star", "unstar",
  // Extended verbs
  "untrash", "unmark", "copy", "cp", "mv", "rm", "rmdir", "run", "exec", "execute", "eval",
  "evaluate", "install", "uninstall", "click", "type", "fill", "press", "drag", "drop", "hover",
  "navigate", "select", "download", "batch", "clone", "pull", "fetch", "save", "import", "restore",
  "kill", "stop", "start", "restart", "deploy", "build", "init", "submit", "sync", "put", "patch",
  "tag", "fork", "transfer", "charge", "schedule", "book", "order", "buy", "grant", "revoke",
  "block", "unblock", "ban", "mute", "unmute", "follow", "unfollow", "like", "subscribe",
  "unsubscribe", "trigger", "output", "api",
]);

/** Tokenize a tool name: split camelCase, lowercase, split on non-alphanumeric, drop empties. */
function tokenize(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** A name is read-only when it contains at least one READ_WORD and no WRITE_WORDS. */
function readOnly(tokens: string[]): boolean {
  return tokens.some((t) => READ_WORDS.has(t)) && !tokens.some((t) => WRITE_WORDS.has(t));
}

export type ToolClass = { ok: boolean; writes: boolean; web: boolean; machine: boolean; bash: boolean };
/** What a tool can do, judged by the deck from its name, never from the plugin's own say-so.
 * Default-deny: a tool reads only when its name clearly says so. */
export function toolClass(t: string): ToolClass {
  const no: ToolClass = { ok: false, writes: false, web: false, machine: false, bash: false };
  if (typeof t !== "string") return no;
  if (BUILTIN.includes(t)) {
    if (t === "WebFetch" || t === "WebSearch") return { ok: true, writes: false, web: true, machine: false, bash: false };
    if (t === "Bash") return { ok: true, writes: true, web: true, machine: true, bash: true }; // any command can reach the network
    return { ok: true, writes: t === "Write" || t === "Edit", web: false, machine: true, bash: false };
  }
  const b = SCOPED_BASH.exec(t);
  if (b) {
    const words = b[1].trim().split(/\s+/);
    const open = OPEN_BIN.test(words[0]);
    // One program with any subcommand ("gh") can do anything that program can, including change things.
    const writes = open || words.length < 2 || !readOnly(tokenize(words.slice(1).join(" ")));
    return { ok: true, writes, web: open, machine: true, bash: true };
  }
  if (MCP_TOOL.test(t)) {
    const server = t.slice("mcp__".length, t.lastIndexOf("__"));
    const tool = t.slice(t.lastIndexOf("__") + 2);
    // Browser/web tools are always considered dangerous.
    if (/browser|playwright|puppeteer|selenium|chrome|fetch|http|scrape|crawl|navigate|url|web/i.test(server + " " + tool)) {
      return { ok: true, writes: true, web: true, machine: false, bash: false };
    }
    // Otherwise default-deny: writes only if tool name clearly says read.
    return { ok: true, writes: !readOnly(tokenize(tool)), web: false, machine: false, bash: false };
  }
  return no;
}
export function grantClass(g: GrantDef) {
  const cs = g.tools.map(toolClass);
  return { writes: g.writes === true || cs.some((c) => c.writes), web: cs.some((c) => c.web), machine: cs.some((c) => c.machine), bash: cs.some((c) => c.bash) };
}

// ── schedules and refresh ─────────────────────────────────────────────────────
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export type Every = { kind: "hours"; n: number } | { kind: "days"; days: number[]; h: number; m: number };
/** "day 09:00", "weekday 09:00", "mon,thu 09:00" or "6h". Local time on the hub. */
export function parseEvery(s: string): Every | null {
  const t = String(s ?? "").trim().toLowerCase();
  const hours = /^(\d{1,2})h$/.exec(t);
  if (hours) { const n = Number(hours[1]); return n >= 1 && n <= 24 ? { kind: "hours", n } : null; }
  const x = /^(day|weekday|[a-z]{3}(?:,[a-z]{3})*) ([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (!x) return null;
  const days = x[1] === "day" ? [0, 1, 2, 3, 4, 5, 6] : x[1] === "weekday" ? [1, 2, 3, 4, 5] : x[1].split(",").map((d) => DAYS.indexOf(d));
  if (days.some((d) => d < 0) || new Set(days).size !== days.length) return null;
  return { kind: "days", days: days.sort((a, b) => a - b), h: Number(x[2]), m: Number(x[3]) };
}
/** "10m" or "2h" in minutes, 5m to 24h; null otherwise. */
export function parseRefresh(s: string): number | null {
  const x = /^(\d{1,4})(m|h)$/.exec(String(s ?? "").trim());
  if (!x) return null;
  const min = Number(x[1]) * (x[2] === "h" ? 60 : 1);
  return min >= 5 && min <= 1440 ? min : null;
}
