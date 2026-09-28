// Reads each agent's own session store to recover what herdr does not track:
// when a conversation started, when it last did anything, model, context size, cost, last message.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { codexHome, codexStore } from "./codex-store";

export type AgentMeta = {
  sessionId?: string;
  createdAt?: number;
  lastActiveAt?: number;
  model?: string;
  /** The model's provider (OpenCode: openrouter, nano-gpt…), so the status line can show that account. */
  provider?: string;
  ctxTokens?: number;
  ctxWindow?: number;
  cost?: number;
  firstPrompt?: string;
  lastMessage?: string;
  title?: string;
  /** Agent is running but has no conversation yet. */
  empty?: boolean;
  /** Session was matched heuristically rather than by id. */
  approx?: boolean;
};

const HOME = homedir();
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 768 * 1024;

const clip = (s: string | undefined, n = 280) => {
  if (!s) return undefined;
  const one = s.replace(/<\/?[a-z_-]+(\s[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

async function readHead(path: string, size: number) {
  const text = await Bun.file(path).slice(0, Math.min(size, HEAD_BYTES)).text();
  const lines = text.split("\n");
  if (size > HEAD_BYTES) lines.pop(); // last line may be cut
  return lines;
}

async function readTail(path: string, size: number) {
  const start = Math.max(0, size - TAIL_BYTES);
  const text = await Bun.file(path).slice(start, size).text();
  const lines = text.split("\n");
  if (start > 0) lines.shift(); // first line may be cut
  return lines;
}

function* jsonLines(lines: string[]) {
  for (const l of lines) {
    if (!l) continue;
    try { yield JSON.parse(l); } catch {}
  }
}

const tsOf = (o: any) => (o?.timestamp ? Date.parse(o.timestamp) : NaN);

/** Parse cache keyed by file path + size + mtime: unchanged files are never re-read. */
const fileCache = new Map<string, { key: string; meta: AgentMeta }>();
async function cachedParse(path: string, parse: (size: number) => Promise<AgentMeta>): Promise<AgentMeta> {
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = fileCache.get(path);
  if (hit?.key === key) return hit.meta;
  const meta = await parse(st.size);
  fileCache.set(path, { key, meta });
  return meta;
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function userText(o: any): string | undefined {
  if (o?.type !== "user" || o.isMeta) return;
  const c = o.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((p: any) => p?.type === "text")?.text : undefined;
  if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return;
  return text;
}

export function parseClaudeHead(lines: string[]): Pick<AgentMeta, "createdAt" | "firstPrompt"> {
  let createdAt: number | undefined;
  let firstPrompt: string | undefined;
  for (const o of jsonLines(lines)) {
    const t = tsOf(o);
    if (createdAt === undefined && !Number.isNaN(t)) createdAt = t;
    firstPrompt ??= userText(o);
    if (createdAt !== undefined && firstPrompt) break;
  }
  return { createdAt, firstPrompt: clip(firstPrompt) };
}

export function parseClaudeTail(lines: string[]): Pick<AgentMeta, "lastActiveAt" | "model" | "ctxTokens" | "lastMessage" | "title"> {
  let lastActiveAt: number | undefined, model: string | undefined, ctxTokens: number | undefined;
  let lastMessage: string | undefined, title: string | undefined;
  for (const o of jsonLines(lines)) {
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    if (o.type === "summary" && o.summary) title ??= o.summary;
    if (o.type !== "user" && o.type !== "assistant") continue;
    const t = tsOf(o);
    if (!Number.isNaN(t) && (lastActiveAt === undefined || t > lastActiveAt)) lastActiveAt = t;
    if (o.type === "assistant") {
      const u = o.message?.usage;
      if (u && o.message?.model && o.message.model !== "<synthetic>") {
        ctxTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        model = o.message.model;
      }
      const text = o.message?.content?.find?.((p: any) => p?.type === "text")?.text;
      if (text) lastMessage = text;
    }
  }
  return { lastActiveAt, model, ctxTokens, lastMessage: clip(lastMessage), title };
}

/** The context window Claude Code reported for a session. Only its status line is told, so the user's statusline
 *  script saves it to ~/.claude/context-cache/<session id>.json: transcripts never say it, and claude-opus-5-5 is
 *  the same id with 200k or 1M. Read again every 30 s. A session without a file borrows the window last seen for
 *  its model; with neither, the page guesses. */
const ctxCache = new Map<string, { at: number; window?: number }>();
const modelWindow = new Map<string, number>();
export function claudeWindow(id: string, model?: string, home = HOME, now = Date.now()): number | undefined {
  let c = ctxCache.get(id);
  if (!c || now - c.at > 30_000) {
    let window: number | undefined;
    try {
      const w = JSON.parse(readFileSync(`${home}/.claude/context-cache/${id}.json`, "utf8")).window;
      if (Number.isFinite(w) && w > 0) window = w;
    } catch {}
    ctxCache.set(id, (c = { at: now, window }));
  }
  if (c.window && model) modelWindow.set(model, c.window);
  return c.window ?? (model ? modelWindow.get(model) : undefined);
}

let claudeDirs: { at: number; dirs: string[] } = { at: 0, dirs: [] };
const claudePathCache = new Map<string, string>();

export function findClaudeFile(id: string): string | undefined {
  const cached = claudePathCache.get(id);
  if (cached && existsSync(cached)) return cached;
  const root = `${HOME}/.claude/projects`;
  if (Date.now() - claudeDirs.at > 30_000) {
    try { claudeDirs = { at: Date.now(), dirs: readdirSync(root) }; } catch { return; }
  }
  for (const d of claudeDirs.dirs) {
    const p = `${root}/${d}/${id}.jsonl`;
    if (existsSync(p)) {
      claudePathCache.set(id, p);
      return p;
    }
  }
}

export async function claudeMeta(id: string): Promise<AgentMeta> {
  const path = findClaudeFile(id);
  // Claude only writes the transcript after the first message: no file means an untouched session.
  if (!path) return { sessionId: id, empty: true };
  const meta = await cachedParse(path, async (size) => {
    const head = parseClaudeHead(await readHead(path, size));
    const tail = parseClaudeTail(await readTail(path, size));
    return { sessionId: id, ...head, ...tail, empty: !head.firstPrompt && !tail.lastMessage && !tail.ctxTokens };
  });
  const ctxWindow = claudeWindow(id, meta.model);
  return ctxWindow ? { ...meta, ctxWindow } : meta;
}

// ── Codex ────────────────────────────────────────────────────────────────────

const codexPathCache = new Map<string, string>();

/** Codex ids are UUIDv7, so the id itself says which day folder the rollout lives in. */
export function findCodexFile(id: string): string | undefined {
  if (!/^[a-f0-9-]{20,64}$/i.test(id)) return;
  const indexed = codexStore.file(id);
  if (indexed) return indexed;
  const cached = codexPathCache.get(id);
  if (cached && existsSync(cached)) return cached;
  codexPathCache.delete(id);
  const ms = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
  if (!Number.isFinite(ms)) return;
  for (const offset of [0, -1, 1]) {
    const d = new Date(ms + offset * 86400_000);
    const dir = `${codexHome()}/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    try {
      const f = readdirSync(dir).find((n) => n.endsWith(`${id}.jsonl`));
      if (f) {
        codexPathCache.set(id, `${dir}/${f}`);
        return `${dir}/${f}`;
      }
    } catch {}
  }
}

/** Injected setup is separate from the user's request; markup can precede real text in the same item. */
export function codexUserText(content: any): string {
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "input_text" && typeof p.text === "string").map((p) => {
    if (/^\s*# AGENTS\.md/.test(p.text)) return "";
    return p.text.replace(/<(environment_context|recommended_plugins|permissions instructions|collaboration_mode)>[\s\S]*?<\/\1>/g, "").trim();
  }).filter((s) => s && !/^\s*<(?:system|developer|INSTRUCTIONS|environment_context)\b/.test(s)).join("\n");
}

export function parseCodex(head: string[], tail: string[]): AgentMeta {
  const meta: AgentMeta = {};
  let headModel: string | undefined;
  for (const o of jsonLines(head)) {
    if (o.type === "session_meta") meta.createdAt = Date.parse(o.payload?.timestamp ?? o.timestamp);
    if (!meta.firstPrompt && o.type === "event_msg" && o.payload?.type === "user_message") meta.firstPrompt = clip(o.payload.message);
    // Long sessions log turn_context rarely, so the tail may not have one: the first turn's model is the fallback.
    if (!headModel && o.type === "turn_context" && o.payload?.model) headModel = o.payload.model;
    if (!meta.firstPrompt && o.type === "response_item" && o.payload?.type === "message" && o.payload.role === "user") {
      meta.firstPrompt = clip(codexUserText(o.payload.content));
    }
    if (meta.createdAt && meta.firstPrompt && headModel) break;
  }
  for (const o of jsonLines(tail)) {
    const t = tsOf(o);
    if (!Number.isNaN(t)) meta.lastActiveAt = Math.max(meta.lastActiveAt ?? 0, t);
    if (o.type === "turn_context" && o.payload?.model) meta.model = o.payload.model;
    if (o.type === "event_msg") {
      const p = o.payload;
      if (p?.type === "token_count" && p.info) {
        meta.ctxTokens = p.info.last_token_usage?.input_tokens ?? meta.ctxTokens;
        meta.ctxWindow = p.info.model_context_window ?? meta.ctxWindow;
      }
      if (p?.type === "agent_message" && p.message) meta.lastMessage = clip(p.message);
    }
    if (o.type === "response_item" && o.payload?.type === "message" && o.payload.role === "assistant") {
      const text = o.payload.content?.find?.((c: any) => c?.type === "output_text")?.text;
      if (text) meta.lastMessage = clip(text);
    }
  }
  meta.model ??= headModel;
  meta.empty = !meta.firstPrompt && !meta.lastMessage && !meta.ctxTokens;
  return meta;
}

export async function codexMeta(id: string): Promise<AgentMeta> {
  const path = findCodexFile(id);
  if (!path) return { sessionId: id, empty: true };
  return cachedParse(path, async (size) => ({ sessionId: id, ...parseCodex(await readHead(path, size), await readTail(path, size)) }));
}

// ── OpenCode (sqlite) ────────────────────────────────────────────────────────

let ocDb: Database | null | undefined;
function oc(): Database | null {
  if (ocDb !== undefined) return ocDb;
  const path = `${HOME}/.local/share/opencode/opencode.db`;
  try { ocDb = existsSync(path) ? new Database(path, { readonly: true }) : null; } catch { ocDb = null; }
  return ocDb;
}

type OcRow = { id: string; title: string; directory: string; time_created: number; time_updated: number; cost: number; model: string | null };

const ocDetailCache = new Map<string, { updated: number; meta: AgentMeta }>();

function ocDetails(row: OcRow, approx: boolean): AgentMeta {
  const hit = ocDetailCache.get(row.id);
  if (hit && hit.updated === row.time_updated) return { ...hit.meta, approx };
  const db = oc()!;
  let ctxTokens: number | undefined, lastMessage: string | undefined;
  // Walk the newest messages through the (session_id, time_created) index, then their parts
  // through the message_id index; ordering all of a session's parts is far slower.
  const msgs = db
    .query<{ id: string }, [string]>(`select id from message where session_id = ? order by time_created desc limit 4`)
    .all(row.id);
  const partsOf = db.query<{ data: string }, [string]>(`select data from part where message_id = ? order by id desc`);
  outer: for (const m of msgs) {
    for (const { data } of partsOf.all(m.id)) {
      if (data.length > 200_000) continue; // huge tool outputs never hold the reply text we want
      try {
        const p = JSON.parse(data);
        if (ctxTokens === undefined && p.type === "step-finish" && p.tokens?.total) ctxTokens = p.tokens.total;
        if (lastMessage === undefined && p.type === "text" && p.text) lastMessage = clip(p.text);
      } catch {}
      if (ctxTokens !== undefined && lastMessage !== undefined) break outer;
    }
  }
  let model: string | undefined, provider: string | undefined, ctxWindow: number | undefined;
  try {
    const m = row.model ? JSON.parse(row.model) : undefined;
    model = m?.id;
    provider = m?.providerID;
    ctxWindow = contextLimit(ocModels(), m?.providerID, m?.id);
  } catch {}
  const meta: AgentMeta = {
    sessionId: row.id,
    title: row.title,
    createdAt: row.time_created,
    lastActiveAt: row.time_updated,
    cost: row.cost,
    model,
    provider,
    ctxTokens,
    ctxWindow,
    lastMessage,
    approx,
    empty: !lastMessage && ctxTokens === undefined,
  };
  ocDetailCache.set(row.id, { updated: row.time_updated, meta });
  return meta;
}

// OpenCode doesn't store a model's context window with the session; it caches the models.dev catalogue.
const OC_MODELS = `${HOME}/.cache/opencode/models.json`;
let ocModelsCache: { mtime: number; data: any } = { mtime: -1, data: undefined };
function ocModels(): any {
  let mtime = 0;
  try { mtime = statSync(OC_MODELS).mtimeMs; } catch { return undefined; }
  if (mtime !== ocModelsCache.mtime) {
    let data: any;
    try { data = JSON.parse(readFileSync(OC_MODELS, "utf8")); } catch {}
    ocModelsCache = { mtime, data };
  }
  return ocModelsCache.data;
}
/** A model's context window from a models.dev-style catalogue ({ provider: { models: { id: { limit: { context } } } } }). */
export function contextLimit(catalog: any, provider: string | undefined, id: string | undefined): number | undefined {
  if (!catalog || !id) return;
  const n = (p: string | undefined, m: string) => { const c = p ? catalog[p]?.models?.[m]?.limit?.context : undefined; return typeof c === "number" && c > 0 ? c : undefined; };
  const slash = id.indexOf("/");
  return n(provider, id) ?? (slash > 0 ? n(id.slice(0, slash), id.slice(slash + 1)) : undefined);
}

const OC_COLS = `id, title, directory, time_created, time_updated, cost, model`;

/**
 * herdr reports the OpenCode session id only for some panes. Otherwise match on the
 * title OpenCode puts in the terminal title ("OC | <title>"), then on directory.
 */
export function opencodeMeta(opts: { id?: string; cwd: string; terminalTitle?: string; claimed: Set<string> }): AgentMeta | undefined {
  const db = oc();
  if (!db) return;
  try {
    if (opts.id) {
      const row = db.query<OcRow, [string]>(`select ${OC_COLS} from session where id = ?`).get(opts.id);
      if (row) return ocDetails(row, false);
    }
    const t = opts.terminalTitle?.match(/^OC \| (.+)$/)?.[1];
    if (t) {
      const prefix = t.replace(/…$/, "");
      const row = db
        .query<OcRow, [string, string]>(`select ${OC_COLS} from session where directory = ? and parent_id is null and substr(title, 1, ${prefix.length}) = ? order by time_updated desc limit 1`)
        .get(opts.cwd, prefix);
      if (row) return ocDetails(row, false);
    }
    const rows = db
      .query<OcRow, [string]>(`select ${OC_COLS} from session where directory = ? and parent_id is null order by time_updated desc limit 8`)
      .all(opts.cwd);
    const row = rows.find((r) => !opts.claimed.has(r.id));
    if (row) return ocDetails(row, true);
  } catch {}
}

export function resumeCommand(agent: string | undefined, id: string | undefined): string | undefined {
  if (!agent || !id) return;
  switch (agent) {
    case "claude": return `claude --resume ${id}`;
    case "codex": return `codex resume ${id}`;
    case "opencode": return `opencode -s ${id}`;
  }
}
