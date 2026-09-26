// Per-session insight from its transcript: the chat, the project it's really about, what it's doing
// right now, and its subagents. Shared by the row engine (list) and the HTTP API (detail, chat).
import { findClaudeFile, findCodexFile } from "./agents";
import { inferProject, type Project } from "./projects";
import {
  attachGenerated, claudeDetail, claudeImage, claudeSubagents, claudeSubDetail, claudeSubFile, codexDetail, codexGeneratedImage, codexImage,
  opencodeDetail, opencodeImage, opencodeSubagents, type Detail, type Sub,
} from "./transcript";

export type Who = { agent: string; sessionId?: string; cwd: string; file?: string }; // file: a past session found by the history index

export async function detailFor(w: Who): Promise<Detail | undefined> {
  if (!w.sessionId) return;
  if (w.agent === "claude") {
    const f = w.file ?? findClaudeFile(w.sessionId);
    return f ? claudeDetail(f) : undefined;
  }
  if (w.agent === "codex") {
    const f = w.file ?? findCodexFile(w.sessionId);
    const d = f ? await codexDetail(f) : undefined;
    if (d) attachGenerated(d, w.sessionId);
    return d;
  }
  if (w.agent === "opencode") return opencodeDetail(w.sessionId);
}

export async function subDetailFor(w: Who, subId: string): Promise<Detail | undefined> {
  if (w.agent === "claude" && w.sessionId) {
    const f = w.file ?? findClaudeFile(w.sessionId);
    const sf = f && claudeSubFile(f, subId);
    return sf ? claudeSubDetail(sf) : undefined;
  }
  if (w.agent === "opencode") return opencodeDetail(subId);
}

export async function imageFor(w: Who, id: string, subId?: string) {
  if (!w.sessionId) return;
  if (id.startsWith("c:")) {
    const f = w.file ?? findClaudeFile(w.sessionId);
    const path = f && subId ? claudeSubFile(f, subId) : f;
    return path ? claudeImage(path, id) : undefined;
  }
  if (id.startsWith("x:")) { const f = w.file ?? findCodexFile(w.sessionId); return f ? codexImage(f, id) : undefined; }
  if (id.startsWith("g:")) return codexGeneratedImage(w.sessionId, id);
  if (id.startsWith("o:")) return opencodeImage(id);
}

export async function subagentsFor(w: Who, d?: Detail): Promise<Sub[]> {
  if (!w.sessionId) return [];
  if (w.agent === "claude") {
    const f = w.file ?? findClaudeFile(w.sessionId);
    return f ? claudeSubagents(f, d) : [];
  }
  if (w.agent === "opencode") return opencodeSubagents(w.sessionId);
  return [];
}

export type Insight = {
  project?: Project;
  now?: string; // the tool call in flight, or the todo item in progress
  turnStartedAt?: number;
  turnOpen?: boolean;
  todo?: string;
  todos?: { done: number; total: number };
  subagents: Sub[];
  msgs: number;
};

const projCache = new Map<string, { gen: number; n: number; project?: Project }>();

export async function insightFor(w: Who): Promise<Insight | undefined> {
  const d = await detailFor(w).catch(() => undefined);
  if (!d) return;
  const k = `${w.agent}:${w.sessionId}`;
  let pc = projCache.get(k);
  // Re-infer only when the conversation moved on by a few messages; it's a stable answer.
  if (!pc || pc.gen !== d.gen || d.messages.length - pc.n >= 6) {
    pc = { gen: d.gen, n: d.messages.length, project: inferProject(d.touch, w.cwd) };
    projCache.set(k, pc);
  }
  let now: string | undefined;
  for (let i = d.messages.length - 1; i >= 0 && i >= d.messages.length - 40; i--) {
    const m = d.messages[i];
    if (m.role === "user") break;
    if (m.role === "tool" && m.state === "running") { now = m.summary ? `${m.tool}: ${m.summary}` : String(m.tool); break; }
  }
  const subagents = await subagentsFor(w, d).catch(() => []);
  return { project: pc.project, now, todo: d.todo, todos: d.todos, turnStartedAt: d.turnStartedAt, turnOpen: d.turnOpen, subagents, msgs: d.messages.length };
}
