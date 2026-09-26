// Full-conversation readers for the detail view: how a session started, the turn-by-turn
// history of asks and replies, recaps, and the images that passed through it.
// Transcripts are parsed incrementally: an active 35 MB file only costs the bytes appended since last time.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

export type Turn = { at?: number; ask: string; reply?: string; images: string[] };
export type Img = { id: string; at?: number; source: "pasted" | "viewed"; name?: string };
export type Detail = {
  startedAt?: number;
  started?: string; // the first ask, fuller than the row's clip
  recap?: { text: string; at?: number; source: string };
  aiTitle?: string;
  turns: Turn[];
  images: Img[];
  compactions: number;
  asks: number;
  workMs?: number; // total time the agent spent working, where the agent records it
};

const clean = (s: string, n: number) => {
  const t = s.replace(/<\/?[a-z_-]+(\s[^>]*)?>/gi, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// ── Claude Code ──────────────────────────────────────────────────────────────

type ClaudeState = { path: string; pos: number; detail: Detail; cur?: Turn; ino?: number; head?: string };
const claudeStates = new Map<string, ClaudeState>();

function claudeAsk(o: any): string | undefined {
  if (o.type !== "user" || o.isMeta || o.isCompactSummary) return;
  const c = o.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
  if (!text || /^\s*</.test(text) || text.startsWith("Caveat:") || text.startsWith("[Request interrupted")) return;
  return text;
}

function feedClaude(st: ClaudeState, line: string, offset: number) {
  let o: any;
  try { o = JSON.parse(line); } catch { return; }
  const d = st.detail;
  const at = o.timestamp ? Date.parse(o.timestamp) : undefined;
  if (d.startedAt === undefined && at) d.startedAt = at;
  if (o.type === "ai-title" && o.aiTitle) d.aiTitle = o.aiTitle;
  if (o.type === "system") {
    if (o.subtype === "away_summary" && o.content) d.recap = { text: clean(o.content, 1200), at, source: "Claude’s recap" };
    if (o.subtype === "compact_boundary") d.compactions++;
    if (o.subtype === "turn_duration" && o.durationMs) d.workMs = (d.workMs ?? 0) + o.durationMs;
    return;
  }
  if (o.type === "user") {
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    const ask = claudeAsk(o);
    if (ask) {
      st.cur = { at, ask: clean(ask, 900), images: [] };
      d.turns.push(st.cur);
      d.asks++;
      d.started ??= clean(ask, 2400);
    }
    // Images the user pasted, and images the agent looked at (screenshots, renders) via tool results.
    content.forEach((p: any, i: number) => {
      if (p?.type === "image") addImage(st, { id: `c:${offset}:${i}:-1`, at, source: "pasted" });
      if (p?.type === "tool_result" && Array.isArray(p.content)) {
        p.content.forEach((q: any, j: number) => {
          if (q?.type === "image") addImage(st, { id: `c:${offset}:${i}:${j}`, at, source: "viewed" });
        });
      }
    });
    return;
  }
  if (o.type === "assistant" && st.cur && !o.isSidechain) {
    const text = o.message?.content?.filter?.((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
    if (text) st.cur.reply = clean(text, 1200);
  }
}

function addImage(st: { detail: Detail; cur?: Turn }, img: Img) {
  st.detail.images.push(img);
  st.cur?.images.push(img.id);
}

const emptyDetail = (): Detail => ({ turns: [], images: [], compactions: 0, asks: 0 });

/**
 * Feeds only the bytes appended since the last call. Agents sometimes rewrite a transcript in place
 * (Claude does on some compactions), so a changed inode, changed first bytes, or a last position that
 * no longer sits right after a newline all mean "start over": stale offsets would point into garbage.
 */
async function readIncremental(states: Map<string, ClaudeState>, path: string, feed: (st: ClaudeState, line: string, offset: number) => void): Promise<Detail> {
  const stat = statSync(path);
  const file = Bun.file(path);
  const head = await file.slice(0, 64).text();
  let st = states.get(path);
  let fresh = !st || stat.size < st.pos || st.ino !== stat.ino || st.head !== head;
  if (!fresh && st!.pos > 0) {
    const prev = new Uint8Array(await file.slice(st!.pos - 1, st!.pos).arrayBuffer());
    if (prev[0] !== 10) fresh = true;
  }
  if (fresh) {
    st = { path, pos: 0, detail: emptyDetail(), ino: stat.ino, head };
    states.set(path, st);
  }
  const s = st!;
  if (stat.size > s.pos) {
    const bytes = new Uint8Array(await file.slice(s.pos, stat.size).arrayBuffer());
    const lastNl = bytes.lastIndexOf(10);
    if (lastNl >= 0) {
      const dec = new TextDecoder();
      let start = 0;
      for (let i = 0; i <= lastNl; i++) {
        if (bytes[i] !== 10) continue;
        if (i > start) feed(s, dec.decode(bytes.subarray(start, i)), s.pos + start);
        start = i + 1;
      }
      s.pos += lastNl + 1;
    }
  }
  return s.detail;
}

export function claudeDetail(path: string): Promise<Detail> {
  return readIncremental(claudeStates, path, feedClaude);
}

/** Re-reads one transcript line and returns the image block it points at. */
export async function claudeImage(path: string, id: string): Promise<{ type: string; data: Uint8Array } | undefined> {
  const [, off, i, j] = id.split(":");
  const offset = Number(off);
  const file = Bun.file(path);
  // Lines holding screenshots can be several MB; read until the newline.
  let chunk = 4 * 1024 * 1024;
  let text = "";
  for (;;) {
    text = await file.slice(offset, offset + chunk).text();
    if (text.includes("\n") || offset + chunk >= file.size) break;
    chunk *= 2;
  }
  const o = JSON.parse(text.split("\n")[0]);
  const part = o.message?.content?.[Number(i)];
  const block = Number(j) < 0 ? part : part?.content?.[Number(j)];
  if (block?.type !== "image" || block.source?.type !== "base64") return;
  return { type: block.source.media_type, data: Buffer.from(block.source.data, "base64") };
}

// ── Codex ────────────────────────────────────────────────────────────────────

const codexStates = new Map<string, ClaudeState>();

function feedCodex(st: ClaudeState, line: string, offset: number) {
  let o: any;
  try { o = JSON.parse(line); } catch { return; }
  const d = st.detail;
  const at = o.timestamp ? Date.parse(o.timestamp) : undefined;
  const p = o.payload;
  if (o.type === "session_meta") d.startedAt = Date.parse(p?.timestamp ?? o.timestamp);
  if (o.type === "compacted") d.compactions++;
  if (o.type !== "response_item" || p?.type !== "message") return;
  if (p.role === "user") {
    const texts = (p.content ?? []).filter((c: any) => c?.type === "input_text").map((c: any) => c.text as string);
    // Codex injects AGENTS.md and environment context as user messages; they start with markup or a heading.
    const ask = texts.filter((t: string) => !/^\s*(<|# AGENTS\.md)/.test(t)).join("\n").trim();
    if (ask) {
      st.cur = { at, ask: clean(ask, 900), images: [] };
      d.turns.push(st.cur);
      d.asks++;
      d.started ??= clean(ask, 2400);
    }
    (p.content ?? []).forEach((c: any, i: number) => {
      if (c?.type === "input_image") addImage(st, { id: `x:${offset}:${i}`, at, source: "pasted" });
    });
  } else if (p.role === "assistant" && st.cur) {
    const text = (p.content ?? []).filter((c: any) => c?.type === "output_text").map((c: any) => c.text).join("\n");
    if (text) st.cur.reply = clean(text, 1200);
  }
}

export function codexDetail(path: string): Promise<Detail> {
  return readIncremental(codexStates, path, feedCodex);
}

export async function codexImage(path: string, id: string) {
  const [, off, i] = id.split(":");
  const file = Bun.file(path);
  let chunk = 4 * 1024 * 1024, text = "";
  for (;;) {
    text = await file.slice(Number(off), Number(off) + chunk).text();
    if (text.includes("\n") || Number(off) + chunk >= file.size) break;
    chunk *= 2;
  }
  const url: string | undefined = JSON.parse(text.split("\n")[0]).payload?.content?.[Number(i)]?.image_url;
  return dataUrl(url);
}

function dataUrl(url?: string) {
  const m = url?.match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { type: m[1], data: Buffer.from(m[2], "base64") } : undefined;
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

let ocDb: Database | null | undefined;
function oc() {
  if (ocDb !== undefined) return ocDb;
  const p = `${homedir()}/.local/share/opencode/opencode.db`;
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
  // Only text and file parts matter here; skip the (often huge) tool outputs without parsing them.
  const partsOf = db.query<{ id: string; data: string }, [string]>(
    `select id, data from part where message_id = ? and json_extract(data, '$.type') in ('text', 'file') order by id`,
  );
  const st: { detail: Detail; cur?: Turn } = { detail: d };
  for (const m of msgs) {
    const parts = partsOf.all(m.id).map((p) => ({ id: p.id, v: JSON.parse(p.data) }));
    if (m.role === "user") {
      const ask = parts.filter((p) => p.v.type === "text" && !p.v.synthetic).map((p) => p.v.text).join("\n").trim();
      if (ask) {
        st.cur = { at: m.time_created, ask: clean(ask, 900), images: [] };
        d.turns.push(st.cur);
        d.asks++;
        d.started ??= clean(ask, 2400);
      }
      for (const p of parts) if (p.v.type === "file" && /^image\//.test(p.v.mime ?? "")) addImage(st, { id: `o:${p.id}`, at: m.time_created, source: "pasted", name: p.v.filename });
    } else if (st.cur) {
      const text = parts.filter((p) => p.v.type === "text").map((p) => p.v.text).join("\n").trim();
      if (text) st.cur.reply = clean(text, 1200);
    }
  }
  ocCache.set(sessionId, { updated: s.time_updated, detail: d });
  return d;
}

export function opencodeImage(id: string) {
  const row = oc()?.query<{ data: string }, [string]>(`select data from part where id = ?`).get(id.slice(2));
  return row ? dataUrl(JSON.parse(row.data).url) : undefined;
}
