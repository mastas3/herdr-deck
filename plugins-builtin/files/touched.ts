// Files the agent changed in this session, from its transcript (src/transcript.ts records them as it parses: Claude's
// Edit/Write/MultiEdit/NotebookEdit, Codex's apply_patch and file changes, OpenCode's edits), subagents included.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { detailFor, subagentsFor, subDetailFor, type Who } from "../../src/insight";
import type { Badge } from "./git";
import { relTo, viewable } from "./safe";

export type Touched = { path: string; rel?: string; at?: number; st?: Badge; gone?: boolean };
export const TOUCHED_CAP = 300;

/** Raw edits (as the tools named them, newest last) → absolute paths, newest first, deduplicated. */
export function touchedPaths(edits: Iterable<[string, number]>, cwd: string): { path: string; at?: number }[] {
  const seen = new Map<string, number>();
  for (const [raw, at] of edits) {
    let p = raw.trim().replace(/^["'`]|["'`]$/g, "");
    if (!p) continue;
    if (p.startsWith("~/")) p = homedir() + p.slice(1);
    const abs = resolve(cwd || "/", p);
    seen.delete(abs);
    seen.set(abs, Math.max(at || 0, seen.get(abs) ?? 0));
  }
  return [...seen].reverse().sort((x, y) => (y[1] || 0) - (x[1] || 0)).map(([path, at]) => ({ path, at: at || undefined }));
}

/** Every edit in the session and its subagents (at most 40 of them, newest parses are cached by the transcript module). */
export async function sessionEdits(w: Who): Promise<[string, number][]> {
  const d = await detailFor(w).catch(() => undefined);
  const out: [string, number][] = [...(d?.edits ?? [])];
  if (!d) return out;
  const subs = await subagentsFor(w, d).catch(() => []);
  for (const s of subs.slice(-40)) {
    const sd = await subDetailFor(w, s.id).catch(() => undefined);
    if (sd?.edits) out.push(...sd.edits);
  }
  return out;
}

/** The Touched list: secrets and paths outside your home dropped, each with its git status and whether it still exists. */
export function touchedList(paths: { path: string; at?: number }[], roots: string[], st: Map<string, Badge>): Touched[] {
  const out: Touched[] = [];
  for (const { path, at } of paths) {
    if (!viewable(path)) continue;
    const rel = relTo(roots, path);
    out.push({ path, rel, at, st: rel ? st.get(rel) : undefined, gone: !existsSync(path) || undefined });
    if (out.length >= TOUCHED_CAP) break;
  }
  return out;
}
