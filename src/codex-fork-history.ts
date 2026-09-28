// Native paginated forks reference a bounded prefix in another indexed rollout.
// Read those bytes only; later parent turns never become part of the child's history.
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { codexStore } from "./codex-store";
import { codexTimestamp } from "./codex-turn";

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CHUNK = 1 << 20, MAX_LINE = 32 << 20, MAX_HEADER = 4 << 20, MAX_BYTES = 256 << 20;
const unavailable = () => new Error("Earlier messages could not be read from this fork’s original task. Open the task in Codex to view its full history.");
export type CodexHistorySegment = { threadId: string; path: string; byteEnd: number; ordinalEnd: number; recordCount: number; digest: string; version: string; lastAt?: number };
export type CodexHistoryPlan = { key: string; segments: CodexHistorySegment[]; warning?: string };
type Header = { payload: any; end: number; digest: string };

async function stamp(path: string) {
  const s = await stat(path, { bigint: true });
  if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  return { size: Number(s.size), key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` };
}
async function header(path: string): Promise<Header> {
  const file = Bun.file(path);
  for (let end = 64 << 10; end <= MAX_HEADER; end *= 2) {
    const bytes = new Uint8Array(await file.slice(0, end).arrayBuffer());
    const newline = bytes.indexOf(10);
    if (newline >= 0) {
      const raw = bytes.subarray(0, newline);
      const first = JSON.parse(new TextDecoder().decode(raw));
      if (first?.type !== "session_meta" || !ID.test(first.payload?.id ?? "")) throw unavailable();
      return { payload: first.payload, end: newline + 1, digest: createHash("sha256").update(raw).digest("hex") };
    }
    if (bytes.length < end) break;
  }
  throw unavailable();
}

/** Fixed-size asynchronous reads bound memory even for large inline-image records. */
async function prefix(path: string, end: number, visit?: (line: string, offset: number) => void) {
  const hash = createHash("sha256"), file = Bun.file(path), decoder = new TextDecoder();
  let records = 0, pending = new Uint8Array(0), lineOffset = 0, lastAt: number | undefined;
  for (let offset = 0; offset < end; offset += CHUNK) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(end, offset + CHUNK)).arrayBuffer());
    if (bytes.length !== Math.min(CHUNK, end - offset)) throw unavailable();
    hash.update(bytes);
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      const size = pending.length + i - start;
      if (!size || size > MAX_LINE) throw unavailable();
      const lineBytes = new Uint8Array(size);
      lineBytes.set(pending); lineBytes.set(bytes.subarray(start, i), pending.length);
      const line = decoder.decode(lineBytes), record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record)) throw unavailable();
      const at = codexTimestamp(record.timestamp);
      if (at !== undefined) lastAt = Math.max(lastAt ?? at, at);
      if (visit) visit(line, lineOffset);
      records++; pending = new Uint8Array(0); start = i + 1; lineOffset = offset + start;
    }
    if (start < bytes.length) {
      if (pending.length + bytes.length - start > MAX_LINE) throw unavailable();
      const rest = new Uint8Array(pending.length + bytes.length - start);
      rest.set(pending); rest.set(bytes.subarray(start), pending.length); pending = rest;
    }
    // A large first parse must leave time for HTTP and SSE work between chunks.
    if (offset + CHUNK < end) await Bun.sleep(0);
  }
  if (pending.length || !records || lineOffset !== end) throw unavailable();
  return { digest: hash.digest("hex"), records, lastAt };
}

export function createCodexForkHistory(fileFor: (id: string) => string | undefined = (id) => codexStore.file(id)) {
  const verified = new Map<string, { stamp: string; digest: string; lastAt?: number }>();
  async function resolve(path: string): Promise<CodexHistoryPlan> {
    let root: Header;
    try { root = await header(path); } catch { return { key: "none", segments: [] }; }
    if (root.payload.history_base == null) return { key: "none", segments: [] };
    const segments: CodexHistorySegment[] = [], seen = new Set<string>([root.payload.id]), paths = new Set<string>([path]);
    let total = 0;
    try {
      async function descend(h: Header, depth: number): Promise<void> {
        const base = h.payload.history_base;
        if (base == null) return;
        const id = base.thread_id, byteEnd = base.end_byte_offset, ordinalEnd = base.end_ordinal_exclusive;
        if (depth >= 16 || typeof id !== "string" || !ID.test(id) || seen.has(id) ||
            !Number.isSafeInteger(byteEnd) || byteEnd <= 0 || !Number.isSafeInteger(ordinalEnd) || ordinalEnd <= 0 ||
            (total += byteEnd) > MAX_BYTES) throw unavailable();
        const parent = fileFor(id);
        if (!parent || paths.has(parent)) throw unavailable();
        seen.add(id); paths.add(parent);
        const before = await stamp(parent), ph = await header(parent);
        if (ph.payload.id !== id || before.size < byteEnd || ph.end > byteEnd) throw unavailable();
        await descend(ph, depth + 1);
        // Ordinals include inherited records; byte offsets address only this physical file.
        const recordCount = ordinalEnd - (ph.payload.history_base?.end_ordinal_exclusive ?? 0);
        if (!Number.isSafeInteger(recordCount) || recordCount <= 0 || recordCount > byteEnd) throw unavailable();
        // The anchor survives path moves and appends, but never accepts rewritten inherited content.
        const cacheKey = `${root.digest}:${id}:${byteEnd}:${ordinalEnd}`;
        const cached = verified.get(cacheKey);
        let result = cached;
        if (!cached || cached.stamp !== before.key) {
          const read = await prefix(parent, byteEnd);
          if (read.records !== recordCount || (cached && cached.digest !== read.digest)) throw unavailable();
          if ((await stamp(parent)).key !== before.key || fileFor(id) !== parent) throw unavailable();
          result = { stamp: before.key, digest: read.digest, lastAt: read.lastAt };
          verified.set(cacheKey, result);
          if (verified.size > 256) verified.delete(verified.keys().next().value!);
        }
        if ((await stamp(parent)).key !== before.key || fileFor(id) !== parent) throw unavailable();
        segments.push({ threadId: id, path: parent, byteEnd, ordinalEnd, recordCount, digest: result!.digest, version: before.key, lastAt: result!.lastAt });
      }
      await descend(root, 0);
      return { key: `${root.digest}:${segments.map((s) => s.digest).join(":")}`, segments };
    } catch { return { key: `unavailable:${root.digest}`, segments: [], warning: unavailable().message }; }
  }
  async function replay(plan: CodexHistoryPlan, visit: (line: string, offset: number, threadId: string) => void) {
    for (const segment of plan.segments) {
      if (fileFor(segment.threadId) !== segment.path) throw unavailable();
      const result = await prefix(segment.path, segment.byteEnd, (line, offset) => visit(line, offset, segment.threadId));
      if (result.digest !== segment.digest || result.records !== segment.recordCount) throw unavailable();
    }
  }
  async function imageLine(path: string, threadId: string, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    const plan = await resolve(path), segment = plan.segments.find((s) => s.threadId === threadId);
    if (!segment || offset >= segment.byteEnd) return;
    if ((await stamp(segment.path)).key !== segment.version) return;
    const file = Bun.file(segment.path);
    if (offset > 0 && new Uint8Array(await file.slice(offset - 1, offset).arrayBuffer())[0] !== 10) return;
    for (let size = 64 << 10; size <= MAX_LINE; size *= 2) {
      const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + size, segment.byteEnd)).arrayBuffer());
      const newline = bytes.indexOf(10);
      if (newline >= 0) {
        if ((await stamp(segment.path)).key !== segment.version || fileFor(threadId) !== segment.path) return;
        return new TextDecoder().decode(bytes.subarray(0, newline));
      }
      if (offset + size >= segment.byteEnd) return;
    }
  }
  return { resolve, replay, imageLine };
}
export const codexForkHistory = createCodexForkHistory();
