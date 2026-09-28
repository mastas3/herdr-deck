import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codex-store";
import type { Detail, Msg } from "./transcript";

/** Supplied only after the referenced rollout prefix has been validated. */
export type CodexGeneratedAncestor = {
  threadId: string;
  lastAt?: number;
};
const taskId = (s: string) => /^[\w-]{1,100}$/.test(s);
const imageName = (s: string) => /^[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(s);
const cutoff = (a: CodexGeneratedAncestor) => taskId(a.threadId) && typeof a.lastAt === "number" && Number.isFinite(a.lastAt) && a.lastAt > 0;

function sources(threadId: string, ancestors: CodexGeneratedAncestor[]) {
  const out = new Map<string, CodexGeneratedAncestor | undefined>();
  if (taskId(threadId)) out.set(threadId, undefined);
  for (const a of ancestors) {
    if (!cutoff(a) || a.threadId === threadId) continue;
    const old = out.get(a.threadId);
    if (!old || a.lastAt! < old.lastAt!) out.set(a.threadId, a);
  }
  return out;
}

/** Keep generated files tied to the conversation prefix that actually inherited them. */
export function attachCodexGenerated(d: Detail, threadId: string, ancestors: CodexGeneratedAncestor[] = [], home = codexHome()) {
  const entries: { id: string; at: number; name: string; target: Msg }[] = [];
  for (const [source, ancestor] of sources(threadId, ancestors)) {
    const dir = join(home, "generated_images", source);
    let names: string[];
    try { names = readdirSync(dir).filter(imageName); } catch { continue; }
    for (const name of names) {
      let at: number;
      try {
        const st = statSync(join(dir, name));
        if (!st.isFile()) continue;
        at = st.mtimeMs;
      } catch { continue; }
      if (ancestor && at > ancestor.lastAt!) continue;
      let target: Msg | undefined;
      for (let i = d.messages.length - 1; i >= 0; i--) {
        const m = d.messages[i];
        if (ancestor && m.codexSourceId !== source) continue;
        if ((m.at ?? 0) <= at) { target = m; break; }
      }
      if (!target) continue;
      entries.push({ id: ancestor ? `g:${source}:${name}` : `g:${name}`, at, name, target });
    }
  }
  // Reconcile on every read: a parent file replaced after the fork must disappear from the child.
  d.images = d.images.filter((i) => !i.id.startsWith("g:"));
  for (const m of d.messages) if (m.images) m.images = m.images.filter((id) => !id.startsWith("g:"));
  for (const e of entries) {
    d.images.push({ id: e.id, at: e.at, source: "viewed", name: e.name });
    (e.target.images ??= []).push(e.id);
  }
}

/** An inherited ID is usable only while its source is in the freshly validated ancestry. */
export async function readCodexGenerated(threadId: string, id: string, ancestors: CodexGeneratedAncestor[] = [], home = codexHome()) {
  const parts = id.split(":");
  if (parts[0] !== "g" || (parts.length !== 2 && parts.length !== 3)) return;
  const source = parts.length === 3 ? parts[1] : threadId, name = parts.at(-1)!;
  if (!taskId(source) || !imageName(name)) return;
  const allowed = sources(threadId, ancestors);
  if (!allowed.has(source) || (parts.length === 3 && source === threadId)) return;
  const ancestor = allowed.get(source), path = join(home, "generated_images", source, name);
  let st;
  try { st = statSync(path, { bigint: true }); } catch { return; }
  if (!st.isFile() || !st.size || (ancestor && Number(st.mtimeNs) / 1e6 > ancestor.lastAt!)) return;
  const file = Bun.file(path), data = new Uint8Array(await file.arrayBuffer());
  // Refuse a file that changed while it was being served across the prefix boundary.
  try {
    const after = statSync(path, { bigint: true });
    if (after.ino !== st.ino || after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) return;
  } catch { return; }
  return { type: file.type || "image/png", data };
}
