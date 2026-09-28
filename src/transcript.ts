// Full-conversation readers: the chat (every ask, reply and tool call), how a session started,
// recaps, images, which folders the agent actually worked in, what it's doing right now, and its subagents.
// Transcripts are parsed incrementally: an active 35 MB file only costs the bytes appended since last time.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { codexUserText } from "./agents";
import { codexTimestamp } from "./codex-turn";
import { codexReplyHash } from "./codex-fork-point";
import { codexForkHistory, type CodexHistoryPlan } from "./codex-fork-history";
import { attachCodexGenerated, readCodexGenerated } from "./codex-generated";

const HOME = homedir();

export type Turn = { at?: number; ask: string; reply?: string; images: string[] };
export type Img = { id: string; at?: number; source: "pasted" | "viewed"; name?: string };
/** One chat entry. Tool calls carry a one-line summary, never their (often huge) output. */
export type Msg = {
  i: number;
  role: "user" | "assistant" | "tool" | "note";
  at?: number;
  text?: string;
  tool?: string;
  summary?: string;
  state?: "running" | "done" | "error";
  images?: string[];
  sub?: string; // subagent id, once known (Claude Agent/Task calls)
  subType?: string;
  codexSourceId?: string; // inherited rollout source; never inferred from timestamps
  codexTurnId?: string;
  forkAfterTurnId?: string;
  forkReplyHash?: string;
};
export type Detail = {
  gen: number; // bumps when a transcript is re-read from scratch, so cursors from before are void
  startedAt?: number;
  started?: string;
  recap?: { text: string; at?: number; source: string };
  aiTitle?: string;
  turns: Turn[];
  images: Img[];
  messages: Msg[];
  compactions: number;
  asks: number;
  workMs?: number;
  turnStartedAt?: number; // when the current (or last) turn began
  turnOpen?: boolean; // Codex only: a turn started and hasn't completed or been aborted
  turnId?: string;
  todo?: string; // the task the agent marked in progress, if it keeps a todo list
  todos?: { done: number; total: number }; // progress through that list (Claude/OpenCode todos, Codex plans)
  touch: Map<string, number>; // folder → how much work happened there (edits weigh most)
};

const TEXT_CAP = 24_000;
const clean = (s: string, n: number) => {
  const t = s.replace(/<\/?[a-z_-]+(\s[^>]*)?>/gi, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
/** Chat text keeps its formatting (code blocks, lists); only length is capped. */
const full = (s: string) => (s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + "\n\n… (truncated)" : s).trim();
const home = (p: string) => p.replace(HOME, "~");
const oneLine = (s: unknown, n = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

let genCounter = 0;
const emptyDetail = (): Detail => ({ gen: ++genCounter, turns: [], images: [], messages: [], compactions: 0, asks: 0, touch: new Map() });

// ── where the work happened ─────────────────────────────────────────────────

const PATH_RE = /(?:~|\/Users\/[\w.-]+|\/home\/[\w.-]+)\/[^\s"'`;|&<>()*?$\\,\]}]+/g;
const IGNORE = /^~\/(\.claude|\.codex|\.config|\.local|\.cache|\.npm|\.bun|\.ollama|Library)(\/|$)|\/node_modules\//;

/** Credits a path (collapsed below 7 levels) with some weight of work. */
function touch(d: Detail, rawPath: string, weight: number) {
  let p = rawPath.replace(/^~(?=\/)/, HOME).replace(/[.:]+$/, "");
  if (!p.startsWith(HOME + "/")) return;
  const rel = home(p);
  if (IGNORE.test(rel)) return;
  const parts = p.split("/");
  const dir = parts.slice(0, Math.min(parts.length, 8)).join("/"); // deep paths collapse, bounding the map
  if (dir === HOME) return;
  d.touch.set(dir, (d.touch.get(dir) ?? 0) + weight);
}
function touchText(d: Detail, text: string, weight: number) {
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) if (!seen.has(m[0])) { seen.add(m[0]); touch(d, m[0], weight); }
}

/** Tools that change files, by the names this module emits (Claude, Codex, OpenCode). */
export const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|patch)$/i;
const READ_TOOLS = /^(read|grep|glob|ls|view|list)$/i;

/** "mcp__plugin_playwright_playwright__browser_click" → "playwright · browser_click". */
export function prettyTool(name: string): string {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return name;
  const server = m[1].replace(/^plugin_/, "").replace(/^claude_ai_/, "").split("_").filter(Boolean);
  return `${server[server.length - 1] ?? m[1]} · ${m[2]}`;
}

/** Todo lists (Claude TodoWrite, OpenCode todowrite) and Codex plans all reduce to: current step + done/total. */
function trackTodos(d: Detail, items: any[] | undefined, text = (t: any) => t?.activeForm ?? t?.content ?? t?.step) {
  if (!Array.isArray(items) || !items.length) return;
  const cur = items.find((t) => t?.status === "in_progress");
  d.todo = cur ? oneLine(text(cur)) : undefined;
  d.todos = { done: items.filter((t) => t?.status === "completed" || t?.status === "done").length, total: items.length };
}

/** One line saying what a tool call does, for the chat and the "now" line. */
export function toolSummary(name: string, input: any): string {
  const n = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  const i = typeof input === "object" && input ? input : {};
  const path = i.file_path ?? i.filePath ?? i.notebook_path ?? i.path;
  switch (name.toLowerCase()) {
    case "bash": return oneLine(i.description || i.command);
    case "read": case "edit": case "write": case "multiedit": case "notebookedit": return home(String(path ?? ""));
    case "grep": return oneLine(`${i.pattern ?? ""}${path ? " in " + home(String(path)) : ""}`);
    case "glob": return oneLine(`${i.pattern ?? ""}${path ? " in " + home(String(path)) : ""}`);
    case "agent": case "task": return oneLine(`${i.description ?? ""}${i.subagent_type ? ` (${i.subagent_type})` : ""}`);
    case "webfetch": return oneLine(i.url);
    case "websearch": return oneLine(i.query);
    case "todowrite": {
      const cur = (i.todos ?? []).find((t: any) => t?.status === "in_progress");
      return cur ? oneLine(cur.activeForm ?? cur.content) : `${(i.todos ?? []).length} todos`;
    }
    case "skill": return oneLine(i.skill ?? i.command);
  }
  if (typeof input === "string") return oneLine(input);
  const firstStr = Object.values(i).find((v) => typeof v === "string" && v.length < 400);
  return oneLine(path ? home(String(path)) : firstStr ?? (n === name ? n : ""));
}

// ── Claude Code ──────────────────────────────────────────────────────────────

type State = { path: string; pos: number; detail: Detail; cur?: Turn; ino?: number; head?: string; tailSig?: string; mtime?: number; used?: number; open: Map<string, Msg>; items?: Map<string, Msg>; historyKey?: string; imageSource?: string };
const claudeStates = new Map<string, State>();

function claudeAsk(o: any): string | undefined {
  if (o.type !== "user" || o.isMeta || o.isCompactSummary) return;
  const c = o.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
  if (!text || /^\s*</.test(text) || text.startsWith("Caveat:")) return;
  return text;
}

/** A command you ran yourself (`!` in Claude Code, a shell command in Codex): your line, then its output as one
 *  folded Shell line (its first non-empty line; ANSI colours stripped). */
function shellRun(d: Detail, at: number | undefined, cmd: string) {
  push(d, { role: "user", at, text: "! " + cmd.trim() });
}
function shellOut(d: Detail, at: number | undefined, out: string, failed: boolean) {
  const first = out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "no output";
  push(d, { role: "tool", at, tool: "Shell", summary: oneLine(first), state: failed ? "error" : "done" });
}
/** Codex records a shell command you ran as a user message wrapped in <user_shell_command>. */
function codexShell(content: any): { cmd: string; out: string; failed: boolean } | undefined {
  const t = Array.isArray(content) ? content.find((c: any) => c?.type === "input_text" && /^\s*<user_shell_command>/.test(c.text ?? ""))?.text : undefined;
  const cmd = t?.match(/<command>\s*([\s\S]*?)\s*<\/command>/)?.[1];
  if (!cmd) return;
  const result = t.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? "";
  const code = Number(result.match(/Exit code:\s*(\d+)/)?.[1] ?? 0);
  return { cmd, out: result.split(/\nOutput:\n/)[1] ?? "", failed: code !== 0 };
}

function push(d: Detail, m: Omit<Msg, "i">): Msg {
  const msg = { i: d.messages.length, ...m } as Msg;
  d.messages.push(msg);
  return msg;
}

function feedClaude(st: State, line: string, offset: number) {
  let o: any;
  try { o = JSON.parse(line); } catch { return; }
  const d = st.detail;
  const at = o.timestamp ? Date.parse(o.timestamp) : undefined;
  if (d.startedAt === undefined && at) d.startedAt = at;
  if (o.type === "ai-title" && o.aiTitle) d.aiTitle = o.aiTitle;
  if (o.type === "system") {
    if (o.subtype === "away_summary" && o.content) {
      d.recap = { text: clean(o.content, 1600), at, source: "Claude’s recap" };
      push(d, { role: "note", at, text: "Recap: " + clean(o.content, 1600) });
    }
    if (o.subtype === "compact_boundary") { d.compactions++; push(d, { role: "note", at, text: "Conversation compacted" }); }
    if (o.subtype === "turn_duration" && o.durationMs) d.workMs = (d.workMs ?? 0) + o.durationMs;
    return;
  }
  if (o.isSidechain) return;
  if (o.type === "user") {
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    const ask = claudeAsk(o);
    const raw = typeof o.message?.content === "string" ? o.message.content : "";
    if (ask?.startsWith("[Request interrupted")) { push(d, { role: "note", at, text: "Interrupted" }); return; }
    let userMsg: Msg | undefined;
    if (ask) {
      st.cur = { at, ask: clean(ask, 900), images: [] };
      d.turns.push(st.cur);
      d.asks++;
      d.started ??= clean(ask, 2400);
      d.turnStartedAt = at;
      userMsg = push(d, { role: "user", at, text: full(ask) });
    } else if (/^\s*<bash-input>/.test(raw)) {
      const cmd = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.[1];
      if (cmd?.trim()) { shellRun(d, at, cmd); d.turnStartedAt = at; }
    } else if (/^\s*<bash-std(out|err)>/.test(raw)) {
      const out = raw.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/)?.[1] ?? "", err = raw.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/)?.[1] ?? "";
      shellOut(d, at, out.trim() ? out : err, !out.trim() && !!err.trim());
    } else if (/^\s*<command-name>/.test(raw)) {
      const cmd = raw.match(/<command-name>([^<]+)<\/command-name>/)?.[1];
      const args = raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1];
      if (cmd) { userMsg = push(d, { role: "user", at, text: `${cmd}${args ? " " + args : ""}` }); d.turnStartedAt = at; }
    }
    content.forEach((p: any, i: number) => {
      if (p?.type === "image") {
        const id = `c:${offset}:${i}:-1`;
        addImage(st, { id, at, source: "pasted" });
        if (userMsg) (userMsg.images ??= []).push(id);
      }
      if (p?.type === "tool_result") {
        const m = st.open.get(p.tool_use_id);
        if (m) {
          const async = o.toolUseResult?.isAsync || /async_launched|running in the background/i.test(String(o.toolUseResult?.status ?? ""));
          m.state = p.is_error ? "error" : async && m.sub !== undefined ? "running" : "done";
          if (o.toolUseResult?.agentId) m.sub = o.toolUseResult.agentId;
          if (!async) st.open.delete(p.tool_use_id);
        }
        if (Array.isArray(p.content)) {
          p.content.forEach((q: any, j: number) => {
            if (q?.type !== "image") return;
            const id = `c:${offset}:${i}:${j}`;
            addImage(st, { id, at, source: "viewed" });
            if (m) (m.images ??= []).push(id);
          });
        }
      }
    });
    return;
  }
  if (o.type === "assistant") {
    const parts = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const p of parts) {
      if (p?.type === "text" && p.text?.trim()) {
        const prev = d.messages[d.messages.length - 1];
        // One reply is often streamed as several lines of one message id; merge them.
        if (prev?.role === "assistant" && (prev as any)._mid === o.message?.id) prev.text = full(prev.text + "\n\n" + p.text);
        else { const m = push(d, { role: "assistant", at, text: full(p.text) }); Object.defineProperty(m, "_mid", { value: o.message?.id, enumerable: false }); }
        if (st.cur) st.cur.reply = clean(p.text, 1200);
      } else if (p?.type === "tool_use") {
        const name = String(p.name ?? "tool");
        const isAgent = /^(agent|task)$/i.test(name);
        const m = push(d, { role: "tool", at, tool: prettyTool(name), summary: toolSummary(name, p.input), state: "running", ...(isAgent ? { sub: "", subType: p.input?.subagent_type } : {}) });
        if (p.id) { st.open.set(p.id, m); if (isAgent) Object.defineProperty(m, "_tid", { value: p.id, enumerable: false }); }
        workFromInput(d, name, p.input);
        if (name.toLowerCase() === "todowrite") trackTodos(d, p.input?.todos);
      }
    }
  }
}

function workFromInput(d: Detail, name: string, input: any) {
  const i = typeof input === "object" && input ? input : {};
  const w = EDIT_TOOLS.test(name) ? 4 : READ_TOOLS.test(name) ? 1 : 2;
  const path = i.file_path ?? i.filePath ?? i.notebook_path ?? i.path;
  if (typeof path === "string") touch(d, path, w);
  const cmd = i.command ?? i.cmd;
  if (typeof cmd === "string") touchText(d, cmd, 2);
  else if (Array.isArray(cmd)) touchText(d, cmd.join(" "), 2);
  if (typeof i.workdir === "string") touch(d, i.workdir + "/", 2);
  if (typeof input === "string") touchText(d, input, /\*\*\* (Update|Add) File:/.test(input) ? 4 : 2);
}

function addImage(st: { detail: Detail; cur?: Turn }, img: Img) {
  st.detail.images.push(img);
  st.cur?.images.push(img.id);
}

/**
 * Feeds only the bytes appended since the last call. Agents sometimes rewrite a transcript in place
 * (Claude does on some compactions), so a changed inode, changed first bytes, or a last position that
 * no longer sits right after a newline all mean "start over": stale offsets would point into garbage.
 */
/** Old sessions opened from history must not pile up: keep the most recently used parses only. */
const KEEP = Number(process.env.DECK_TRANSCRIPT_CACHE ?? 90);
function trim(states: Map<string, State>) {
  if (states.size <= KEEP) return;
  const old = [...states.values()].sort((a, b) => (a.used ?? 0) - (b.used ?? 0)).slice(0, states.size - KEEP);
  for (const st of old) states.delete(st.path);
}
/** Drops a parsed transcript (the history indexer uses this so its worker stays small). */
export function forgetTranscript(path: string) {
  claudeStates.delete(path); codexStates.delete(path); subStates.delete(path);
}

async function readIncremental(states: Map<string, State>, path: string, feed: (st: State, line: string, offset: number) => void, history?: { key: string; seed: (st: State) => Promise<void> }): Promise<Detail> {
  const stat = statSync(path);
  const file = Bun.file(path);
  let st = states.get(path);
  const head = await file.slice(0, 64).text();
  if (st && stat.size === st.pos && st.ino === stat.ino && st.mtime === stat.mtimeMs && st.head === head && st.historyKey === history?.key) { st.used = Date.now(); return st.detail; } // untouched
  let fresh = !st || stat.size < st.pos || st.ino !== stat.ino || st.head !== head || st.historyKey !== history?.key;
  if (!fresh && st!.pos > 0) {
    // The bytes we already read must be unchanged: some writers (the Codex app) rewrite earlier parts of the
    // file in place, which a size/inode/head check can't see and which would leave every offset pointing into garbage.
    const prev = new Uint8Array(await file.slice(Math.max(0, st!.pos - 4096), st!.pos).arrayBuffer());
    if (prev[prev.length - 1] !== 10 || Bun.hash(prev).toString(36) !== st!.tailSig) fresh = true;
  }
  if (fresh) {
    st = { path, pos: 0, detail: emptyDetail(), ino: stat.ino, head, open: new Map() };
    if (history) { await history.seed(st); st.historyKey = history.key; }
    states.set(path, st);
  }
  const s = st!;
  s.mtime = stat.mtimeMs;
  s.used = Date.now();
  if (fresh) trim(states);
  // Read in chunks: a first look at a 150 MB rollout shouldn't hold all of it in memory at once.
  const CHUNK = 8 << 20;
  const dec = new TextDecoder();
  while (stat.size > s.pos) {
    const end = Math.min(stat.size, s.pos + CHUNK);
    let bytes = new Uint8Array(await file.slice(s.pos, end).arrayBuffer());
    let lastNl = bytes.lastIndexOf(10);
    if (lastNl < 0) {
      if (end >= stat.size) break; // a line still being written
      // One line longer than a chunk (inline images): read on to its end.
      const rest = new Uint8Array(await file.slice(end, stat.size).arrayBuffer());
      const nl = rest.indexOf(10);
      if (nl < 0) break;
      const joined = new Uint8Array(bytes.length + nl + 1);
      joined.set(bytes); joined.set(rest.subarray(0, nl + 1), bytes.length);
      bytes = joined;
      lastNl = bytes.length - 1;
    }
    let start = 0;
    for (let i = 0; i <= lastNl; i++) {
      if (bytes[i] !== 10) continue;
      if (i > start) feed(s, dec.decode(bytes.subarray(start, i)), s.pos + start);
      start = i + 1;
    }
    s.pos += lastNl + 1;
  }
  if (s.pos > 0) s.tailSig = Bun.hash(new Uint8Array(await file.slice(Math.max(0, s.pos - 4096), s.pos).arrayBuffer())).toString(36);
  return s.detail;
}

export function claudeDetail(path: string): Promise<Detail> {
  return readIncremental(claudeStates, path, feedClaude);
}

/** Subagent transcripts parse like any Claude transcript, minus the sidechain filter. */
const subStates = new Map<string, State>();
export function claudeSubDetail(path: string): Promise<Detail> {
  return readIncremental(subStates, path, (st, line, off) => {
    try { const o = JSON.parse(line); if (o.isSidechain) { o.isSidechain = false; return feedClaude(st, JSON.stringify(o), off); } } catch { return; }
    feedClaude(st, line, off);
  });
}

/** Re-reads one transcript line and returns the image block it points at. */
export async function claudeImage(path: string, id: string): Promise<{ type: string; data: Uint8Array } | undefined> {
  const [, off, i, j] = id.split(":");
  const text = await lineAt(path, Number(off));
  const o = JSON.parse(text);
  const part = o.message?.content?.[Number(i)];
  const block = Number(j) < 0 ? part : part?.content?.[Number(j)];
  if (block?.type !== "image" || block.source?.type !== "base64") return;
  return { type: block.source.media_type, data: Buffer.from(block.source.data, "base64") };
}

async function lineAt(path: string, offset: number) {
  const file = Bun.file(path);
  // An offset from a parse of an older version of the file: drop that parse so the next read starts clean.
  if (offset > 0) {
    const before = new Uint8Array(await file.slice(offset - 1, offset).arrayBuffer());
    if (before[0] !== 10) { forgetTranscript(path); throw new Error("stale image offset"); }
  }
  // Lines holding screenshots can be several MB; read until the newline.
  let chunk = 4 * 1024 * 1024, text = "";
  for (;;) {
    text = await file.slice(offset, offset + chunk).text();
    if (text.includes("\n") || offset + chunk >= file.size) break;
    chunk *= 2;
  }
  return text.split("\n")[0];
}

// ── Claude subagents ─────────────────────────────────────────────────────────

export type Sub = {
  id: string;
  type?: string;
  description?: string;
  model?: string;
  startedAt?: number;
  lastActiveAt?: number;
  running: boolean;
  now?: string; // its latest tool call
  tools: number;
};
const subCache = new Map<string, { mtime: number; sub: Sub }>();

/** Subagents live beside the transcript: <session>/subagents/agent-<id>.jsonl (+ .meta.json). */
export async function claudeSubagents(sessionFile: string, parent?: Detail): Promise<Sub[]> {
  const dir = sessionFile.replace(/\.jsonl$/, "") + "/subagents";
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return []; }
  const out: Sub[] = [];
  for (const n of names) {
    const path = `${dir}/${n}`;
    let st;
    try { st = statSync(path); } catch { continue; }
    const hit = subCache.get(path);
    if (hit && hit.mtime === st.mtimeMs) { out.push({ ...hit.sub, running: Date.now() - st.mtimeMs < 45_000 && hit.sub.running }); continue; }
    const id = n.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    let meta: any = {};
    try { meta = await Bun.file(`${dir}/agent-${id}.meta.json`).json(); } catch {}
    const tail = await Bun.file(path).slice(Math.max(0, st.size - 48 * 1024), st.size).text();
    let now: string | undefined, tools = 0, lastAt: number | undefined, ended = false;
    for (const l of tail.split("\n").slice(1)) {
      let o: any;
      try { o = JSON.parse(l); } catch { continue; }
      if (o.timestamp) lastAt = Date.parse(o.timestamp);
      if (o.type === "assistant") {
        const parts = o.message?.content ?? [];
        const tu = parts.filter?.((p: any) => p?.type === "tool_use") ?? [];
        tools += tu.length;
        if (tu.length) { const t = tu[tu.length - 1]; now = `${prettyTool(t.name)}: ${toolSummary(t.name, t.input)}`; ended = false; }
        else if (parts.some?.((p: any) => p?.type === "text") && o.message?.stop_reason === "end_turn") ended = true;
      }
    }
    const firstLine = await Bun.file(path).slice(0, 4096).text();
    let startedAt: number | undefined;
    try { startedAt = Date.parse(JSON.parse(firstLine.split("\n")[0]).timestamp); } catch {}
    // The parent's Agent call closes when a foreground subagent returns; background ones only go quiet.
    const call = parent?.messages.find((m) => m.sub === id || (m.tool && /^(agent|task)$/i.test(m.tool) && meta.toolUseId && (m as any)._tid === meta.toolUseId));
    const running = !ended && Date.now() - st.mtimeMs < 45_000 && call?.state !== "done";
    const sub: Sub = { id, type: meta.agentType, description: meta.description, model: meta.model, startedAt, lastActiveAt: lastAt ?? st.mtimeMs, running, now, tools };
    subCache.set(path, { mtime: st.mtimeMs, sub });
    out.push(sub);
  }
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

export function claudeSubFile(sessionFile: string, id: string) {
  if (!/^[\w-]+$/.test(id)) return;
  const p = sessionFile.replace(/\.jsonl$/, "") + `/subagents/agent-${id}.jsonl`;
  return existsSync(p) ? p : undefined;
}

// ── Codex ────────────────────────────────────────────────────────────────────

const codexStates = new Map<string, State>();

/** Codex's `exec` tool takes JavaScript; the shell command inside is what's worth showing. */
function codexToolSummary(name: string, raw: string): string {
  let args: any = raw;
  try { args = JSON.parse(raw); } catch {}
  if (typeof args === "object" && args) {
    const cmd = args.command ?? args.cmd;
    if (cmd) return oneLine(Array.isArray(cmd) ? cmd.slice(-1)[0] : cmd);
    if (args.title) return oneLine(args.title);
    return toolSummary(name, args);
  }
  const s = String(raw);
  const cmd = s.match(/\b(?:cmd|command)\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/s)?.[2];
  if (cmd) return oneLine(cmd.replace(/\\n/g, " "));
  const file = s.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)?.[1];
  if (file) return home(file.trim());
  return oneLine(s.split("\n").find((l) => l.trim() && !l.trim().startsWith("//")) ?? name);
}

function feedCodex(st: State, line: string, offset: number) {
  let o: any;
  try { o = JSON.parse(line); } catch { return; }
  const d = st.detail;
  const at = o.timestamp ? Date.parse(o.timestamp) : undefined;
  const p = o.payload;
  if (o.type === "session_meta") d.startedAt = Date.parse(p?.timestamp ?? o.timestamp);
  if (o.type === "compacted") { d.compactions++; push(d, { role: "note", at, text: "Conversation compacted" }); }
  if (o.type === "event_msg" && p?.type === "task_started") { d.turnStartedAt = codexTimestamp(p.started_at) ?? at; d.turnOpen = true; d.turnId = p.turn_id; }
  if (o.type === "event_msg" && (p?.type === "task_complete" || p?.type === "turn_aborted") && (!p.turn_id || !d.turnId || p.turn_id === d.turnId)) {
    const wasOpen = d.turnOpen;
    if (d.turnOpen && d.turnStartedAt && at) d.workMs = (d.workMs ?? 0) + Math.max(0, at - d.turnStartedAt);
    d.turnOpen = false;
    for (const m of st.open.values()) m.state = p.type === "turn_aborted" ? "error" : "done";
    st.open.clear();
    // Only an explicit matching completion can identify a stable native fork boundary.
    if (wasOpen && p.type === "task_complete" && p.turn_id && p.turn_id === d.turnId) {
      const reply = d.messages.findLast((m) => m.role === "assistant" && m.codexTurnId === p.turn_id);
      if (reply?.forkReplyHash) reply.forkAfterTurnId = p.turn_id;
    }
  }
  if (o.type === "event_msg" && p?.type === "turn_aborted") push(d, { role: "note", at, text: "Interrupted" });
  // Code mode wraps many actual commands/edits in one `exec` call. The completed items expose that work.
  if (o.type === "event_msg" && p?.type === "item_completed") {
    const item = p.item;
    if (item?.type === "CommandExecution" || item?.type === "FileChange") {
      const edit = item.type === "FileChange";
      const paths = edit && item.changes && typeof item.changes === "object" ? Object.keys(item.changes) : [];
      for (const path of paths) touch(d, path, 4);
      if (item.cwd) touch(d, item.cwd + "/", 2);
      const summary = edit ? paths.map(home).slice(0, 3).join(", ") : oneLine(Array.isArray(item.command) ? item.command.join(" ") : item.command);
      const state = item.status === "failed" || item.status === "declined" || (typeof item.exit_code === "number" && item.exit_code !== 0) ? "error" : "done";
      const items = st.items ??= new Map<string, Msg>();
      const existing = item.id && items.get(item.id);
      if (existing) { existing.summary = summary; existing.state = state; st.open.delete(item.id); }
      else { const m = push(d, { role: "tool", at, tool: edit ? "apply_patch" : "shell", summary, state }); if (item.id) items.set(item.id, m); }
    }
  }
  if (o.type !== "response_item") return;
  if (p?.type === "function_call" || p?.type === "custom_tool_call" || p?.type === "local_shell_call") {
    const raw = p.arguments ?? p.input ?? JSON.stringify(p.action ?? {});
    const name = String(p.name ?? "shell");
    const m = push(d, { role: "tool", at, tool: prettyTool(name), summary: codexToolSummary(name, String(raw)), state: "running" });
    if (p.call_id ?? p.id) (st.items ??= new Map()).set(p.call_id ?? p.id, m);
    if (p.call_id) st.open.set(p.call_id, m);
    let args: any = raw;
    try { args = JSON.parse(raw); } catch {}
    const shortName = name.replace(/^(?:functions|collaboration)\./, "");
    if (shortName === "update_plan" && typeof args === "object") trackTodos(d, args?.plan);
    workFromInput(d, shortName, args);
    if (typeof args === "string") {
      const wd = args.match(/workdir\s*:\s*["'`]([^"'`]+)/)?.[1];
      if (wd) touch(d, wd + "/", 2);
      for (const f of args.matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)) touch(d, f[1].trim(), 4);
    }
    return;
  }
  if (p?.type === "function_call_output" || p?.type === "custom_tool_call_output") {
    const m = st.open.get(p.call_id);
    if (m) { m.state = /"exit_code":\s*[1-9]|Exit code: [1-9]/.test(String(typeof p.output === "string" ? p.output : "").slice(0, 400)) ? "error" : "done"; st.open.delete(p.call_id); }
    // Screenshots and other images the agent looked at come back inside the tool output.
    if (Array.isArray(p.output)) {
      p.output.forEach((c: any, j: number) => {
        if (typeof c?.image_url !== "string" || !c.image_url.startsWith("data:image")) return;
        const id = `${st.imageSource ? `b:${st.imageSource}:` : ""}x:${offset}:o:${j}`;
        st.detail.images.push({ id, at, source: "viewed" });
        if (m) (m.images ??= []).push(id);
      });
    }
    return;
  }
  if (p?.type !== "message") return;
  if (p.role === "user") {
    const sh = codexShell(p.content);
    if (sh) { shellRun(d, at, sh.cmd); shellOut(d, at, sh.out, sh.failed); return; }
    const ask = codexUserText(p.content);
    let userMsg: Msg | undefined;
    if (ask) {
      st.cur = { at, ask: clean(ask, 900), images: [] };
      d.turns.push(st.cur);
      d.asks++;
      d.started ??= clean(ask, 2400);
      d.turnStartedAt ??= at;
      userMsg = push(d, { role: "user", at, text: full(ask) });
    }
    (p.content ?? []).forEach((c: any, i: number) => {
      if (c?.type !== "input_image") return;
      const id = `${st.imageSource ? `b:${st.imageSource}:` : ""}x:${offset}:${i}`;
      addImage(st, { id, at, source: "pasted" });
      if (userMsg) (userMsg.images ??= []).push(id);
    });
  } else if (p.role === "assistant") {
    const text = (p.content ?? []).filter((c: any) => c?.type === "output_text").map((c: any) => c.text).join("\n");
    if (text.trim()) {
      push(d, { role: "assistant", at, text: full(text), ...(d.turnOpen && d.turnId ? { codexTurnId: d.turnId, forkReplyHash: codexReplyHash(text) } : {}) });
      if (st.cur) st.cur.reply = clean(text, 1200);
    }
  }
}

const codexPending = new Map<string, Promise<Detail>>();
export function codexDetail(path: string, historyReader = codexForkHistory): Promise<Detail> {
  const pending = codexPending.get(path);
  if (pending) return pending;
  const work = (async () => {
    const plan = await historyReader.resolve(path);
    const read = (history: CodexHistoryPlan) => readIncremental(codexStates, path, feedCodex, { key: history.key, seed: async (st) => {
      if (history.warning) push(st.detail, { role: "note", text: history.warning });
      await historyReader.replay(history, (line, offset, id) => {
        const before = st.detail.messages.length;
        st.imageSource = id; feedCodex(st, line, offset);
        for (let i = before; i < st.detail.messages.length; i++) st.detail.messages[i].codexSourceId = id;
      });
      st.imageSource = undefined;
    } });
    try { return await read(plan); }
    catch (e) {
      if (!plan.segments.length) throw e;
      return read({ key: `unavailable:${plan.key}`, segments: [], warning: "Earlier messages could not be read from this fork’s original task. Open the task in Codex to view its full history." });
    }
  })();
  codexPending.set(path, work);
  void work.finally(() => { if (codexPending.get(path) === work) codexPending.delete(path); }).catch(() => {});
  return work;
}

export async function codexImage(path: string, id: string, historyReader = codexForkHistory) {
  let parts = id.split(":"), line: string | undefined;
  if (parts[0] === "b") {
    const [, source, kind, offset] = parts;
    if (kind !== "x") return;
    line = await historyReader.imageLine(path, source, Number(offset));
    if (!line) return;
    parts = parts.slice(2);
  } else line = await lineAt(path, Number(parts[1]));
  const payload = JSON.parse(line).payload;
  // x:<offset>:<i> is an image in a message; x:<offset>:o:<j> one in a tool's output
  const url: string | undefined = parts[2] === "o" ? payload?.output?.[Number(parts[3])]?.image_url : payload?.content?.[Number(parts[2])]?.image_url;
  return dataUrl(url);
}

/**
 * Images Codex generated for a thread are saved to ~/.codex/generated_images/<thread id>/, with no link back
 * to the call that made them; each one is attached to the latest message written before the file was.
 */
export async function attachGenerated(d: Detail, threadId: string, path?: string) {
  const ancestors = path ? (await codexForkHistory.resolve(path)).segments : [];
  attachCodexGenerated(d, threadId, ancestors);
}

export async function codexGeneratedImage(threadId: string, id: string, path?: string) {
  const ancestors = path && id.split(":").length === 3 ? (await codexForkHistory.resolve(path)).segments : [];
  return readCodexGenerated(threadId, id, ancestors);
}

function dataUrl(url?: string) {
  const m = url?.match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { type: m[1], data: Buffer.from(m[2], "base64") } : undefined;
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

let ocDb: Database | null | undefined;
function oc() {
  if (ocDb !== undefined) return ocDb;
  const p = `${HOME}/.local/share/opencode/opencode.db`;
  try { ocDb = existsSync(p) ? new Database(p, { readonly: true }) : null; } catch { ocDb = null; }
  return ocDb;
}
const ocCache = new Map<string, { updated: number; detail: Detail }>();

export function opencodeDetail(sessionId: string): Detail | undefined {
  const db = oc();
  if (!db) return;
  const s = db.query<{ time_created: number; time_updated: number }, [string]>(`select time_created, time_updated from session where id = ?`).get(sessionId);
  if (!s) return;
  const hit = ocCache.get(sessionId);
  if (hit?.updated === s.time_updated) return hit.detail;

  const d = emptyDetail();
  d.startedAt = s.time_created;
  const msgs = db
    .query<{ id: string; time_created: number; role: string }, [string]>(
      `select id, time_created, json_extract(data, '$.role') as role from message where session_id = ? order by time_created`,
    )
    .all(sessionId);
  // Tool parts: only name, input and status (outputs are often huge and never parsed).
  const partsOf = db.query<{ id: string; type: string; data: string | null; tool: string | null; input: string | null; status: string | null }, [string]>(
    `select id, json_extract(data, '$.type') as type,
            case when json_extract(data, '$.type') in ('text', 'file') then data end as data,
            json_extract(data, '$.tool') as tool, json_extract(data, '$.state.input') as input, json_extract(data, '$.state.status') as status
       from part where message_id = ? and json_extract(data, '$.type') in ('text', 'file', 'tool') order by id`,
  );
  const st: { detail: Detail; cur?: Turn } = { detail: d };
  for (const m of msgs) {
    const parts = partsOf.all(m.id);
    if (m.role === "user") {
      const texts = parts.filter((p) => p.type === "text").map((p) => JSON.parse(p.data!)).filter((v) => !v.synthetic).map((v) => v.text);
      const ask = texts.join("\n").trim();
      let userMsg: Msg | undefined;
      if (ask) {
        st.cur = { at: m.time_created, ask: clean(ask, 900), images: [] };
        d.turns.push(st.cur);
        d.asks++;
        d.started ??= clean(ask, 2400);
        d.turnStartedAt = m.time_created;
        userMsg = push(d, { role: "user", at: m.time_created, text: full(ask) });
      }
      for (const p of parts) {
        if (p.type !== "file") continue;
        const v = JSON.parse(p.data!);
        if (!/^image\//.test(v.mime ?? "")) continue;
        addImage(st, { id: `o:${p.id}`, at: m.time_created, source: "pasted", name: v.filename });
        if (userMsg) (userMsg.images ??= []).push(`o:${p.id}`);
      }
    } else {
      for (const p of parts) {
        if (p.type === "text") {
          const text = String(JSON.parse(p.data!).text ?? "").trim();
          if (!text) continue;
          push(d, { role: "assistant", at: m.time_created, text: full(text) });
          if (st.cur) st.cur.reply = clean(text, 1200);
        } else if (p.type === "tool") {
          let input: any = {};
          try { input = JSON.parse(p.input ?? "{}"); } catch {}
          const tool = String(p.tool ?? "tool");
          push(d, { role: "tool", at: m.time_created, tool: prettyTool(tool), summary: toolSummary(tool, input), state: p.status === "error" ? "error" : p.status === "completed" ? "done" : "running" });
          workFromInput(d, tool, input);
          if (tool === "todowrite") trackTodos(d, input.todos);
        }
      }
    }
  }
  ocCache.set(sessionId, { updated: s.time_updated, detail: d });
  return d;
}

/** OpenCode subagents are child sessions. */
export function opencodeSubagents(sessionId: string): Sub[] {
  const db = oc();
  if (!db) return [];
  try {
    return db
      .query<{ id: string; title: string; time_created: number; time_updated: number }, [string]>(
        `select id, title, time_created, time_updated from session where parent_id = ? order by time_created`,
      )
      .all(sessionId)
      .map((s) => ({ id: s.id, description: s.title, startedAt: s.time_created, lastActiveAt: s.time_updated, running: Date.now() - s.time_updated < 45_000, tools: 0 }));
  } catch { return []; }
}

export function opencodeImage(id: string) {
  const row = oc()?.query<{ data: string }, [string]>(`select data from part where id = ?`).get(id.slice(2));
  return row ? dataUrl(JSON.parse(row.data).url) : undefined;
}
