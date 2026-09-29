// What the deck remembers about the worktrees it made: the branch each came from (what "Merge into <base>" means),
// the .env links it put there (not work to lose when it's removed), and when you chose to keep one (the weekly
// stale list leaves it alone for two weeks). One small JSON file in the deck's data folder.
import { readFileSync, writeFileSync } from "node:fs";

export type WtRecord = { path: string; main: string; branch: string; base: string; createdAt: number; links?: string[]; keptAt?: number };

let file = "";
let recs = new Map<string, WtRecord>();

export function loadWorktrees(path: string) {
  file = path;
  try { recs = new Map((JSON.parse(readFileSync(path, "utf8")).worktrees ?? []).map((r: WtRecord) => [r.path, r])); } catch { recs = new Map(); }
}
function save() {
  if (!file) return;
  try { writeFileSync(file, JSON.stringify({ worktrees: [...recs.values()].slice(-500) }, null, 1)); } catch {}
}
export const wtRecord = (path: string) => recs.get(path);
export const wtRecords = () => [...recs.values()];
export function putWorktree(r: WtRecord) { recs.set(r.path, r); save(); }
export function patchWorktree(path: string, patch: Partial<WtRecord>) { const r = recs.get(path); if (r) { recs.set(path, { ...r, ...patch }); save(); } }
