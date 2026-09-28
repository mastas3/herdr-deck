// Turn markers are independent of JSON property order and of the size of tool output between them.
import { statSync } from "node:fs";

export type CodexTurn = { size: number; pos: number; mtime: number; ino: number; open: boolean; startedAt?: number; endedAt?: number; turnId?: string; interrupted?: boolean };
const cache = new Map<string, CodexTurn>();

export function codexTimestamp(value: unknown): number | undefined {
  const n = typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : Date.parse(String(value ?? ""));
  return Number.isFinite(n) ? n : undefined;
}

function marker(line: string) {
  if (!/task_started|task_complete|turn_aborted/.test(line)) return;
  try {
    const o = JSON.parse(line), p = o.payload;
    if (o.type !== "event_msg" || !["task_started", "task_complete", "turn_aborted"].includes(p?.type)) return;
    const at = (p.type === "task_started" ? codexTimestamp(p.started_at) : undefined) ?? codexTimestamp(o.timestamp);
    return { type: p.type, id: p.turn_id, at };
  } catch {}
}
function apply(v: CodexTurn, m: NonNullable<ReturnType<typeof marker>>) {
  if (m.type === "task_started") {
    v.open = true; v.startedAt = m.at; v.turnId = m.id; v.endedAt = undefined; v.interrupted = false;
  } else if (!v.open || !m.id || !v.turnId || m.id === v.turnId) {
    v.open = false; v.endedAt = m.at; v.interrupted = m.type === "turn_aborted";
  }
}
export async function turnState(file: string): Promise<CodexTurn> {
  const st = statSync(file), hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs && hit.ino === st.ino) return hit;
  const f = Bun.file(file);
  let v: CodexTurn;
  if (hit && hit.ino === st.ino && st.size > hit.size) {
    v = { ...hit, size: st.size, mtime: st.mtimeMs };
    const text = await f.slice(hit.pos, st.size).text(), end = text.lastIndexOf("\n");
    if (end >= 0) {
      for (const line of text.slice(0, end).split("\n")) { const m = marker(line); if (m) apply(v, m); }
      v.pos = hit.pos + Buffer.byteLength(text.slice(0, end + 1));
    }
  } else {
    v = { size: st.size, pos: 0, mtime: st.mtimeMs, ino: st.ino, open: false };
    const chunk = 256 * 1024;
    let suffix = "", foundEnd: ReturnType<typeof marker>;
    for (let end = st.size; end > 0;) {
      const from = Math.max(0, end - chunk);
      const bytes = Buffer.from(await f.slice(from, end).arrayBuffer()), text = bytes.toString("utf8");
      if (!v.pos) { const nl = bytes.lastIndexOf(10); if (nl >= 0) v.pos = from + nl + 1; }
      const lines = (text + suffix).split("\n");
      // The last line is incomplete at EOF; at later chunks it is the previous chunk's prefix.
      if (end === st.size) lines.pop();
      suffix = from ? lines.shift() ?? "" : "";
      // Turn markers are small. Don't retain a multi-megabyte screenshot/tool-output line.
      if (suffix.length > 64 * 1024) suffix = "";
      let found = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = marker(lines[i]); if (!m) continue;
        if (!foundEnd && m.type !== "task_started") { foundEnd = m; continue; }
        if (m.type === "task_started") {
          apply(v, m);
          if (foundEnd) apply(v, foundEnd);
          found = true; break;
        }
      }
      if (found) break;
      end = from;
    }
    if (!v.startedAt && foundEnd) apply(v, foundEnd);
  }
  cache.set(file, v);
  if (cache.size > 512) cache.delete(cache.keys().next().value!);
  return v;
}
