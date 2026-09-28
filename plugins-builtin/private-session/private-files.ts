// Private session, on disk: exactly which files hold a private session's words (Claude's transcript folder and the
// files it keeps per session id, Codex rollouts that ran in the folder, the typed-prompt history lines, the throwaway
// folder itself), and deleting only those after the user confirmed that same list.
import { existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isPrivatePath } from "../../src/private-folder";

export type Plan = { files: string[]; lines: { file: string; n: number }[] };

function ls(dir: string) { try { return readdirSync(dir); } catch { return []; } }
function head(file: string, n = 8192) {
  const fd = openSync(file, "r");
  try { const b = Buffer.alloc(n); const k = readSync(fd, b, 0, n, 0); return b.subarray(0, k).toString("utf8"); } finally { closeSync(fd); }
}
function walk(dir: string, out: string[], since: number, depth = 0) {
  for (const n of ls(dir)) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth < 4) walk(p, out, since, depth + 1); }
    else if (n.endsWith(".jsonl") && st.mtimeMs >= since) out.push(p);
  }
}
const lines = (f: string) => { try { return readFileSync(f, "utf8").split("\n"); } catch { return []; } };

/** Every file a private session in `cwd` left behind, found fresh from disk. `since`: skip Codex rollouts older. */
export function planFiles(o: { home: string; cwd: string; since?: number }): Plan {
  const { home } = o;
  const cwd = resolve(o.cwd);
  if (!isPrivatePath(cwd)) throw new Error("Not a private session folder");
  const id = basename(cwd);
  const files: string[] = [], sids: string[] = [], codexIds: string[] = [];
  // Claude: the project folder named after the cwd, and the per-session files keyed by each transcript's id.
  const projects = join(home, ".claude/projects");
  for (const d of ls(projects)) {
    if (!d.endsWith(id) || !isPrivatePath(d)) continue;
    for (const f of ls(join(projects, d))) if (f.endsWith(".jsonl")) { files.push(join(projects, d, f)); sids.push(basename(f, ".jsonl")); }
    files.push(join(projects, d));
  }
  for (const sid of sids) {
    for (const p of [join(home, ".claude/file-history", sid), join(home, ".claude/session-env", sid)]) if (existsSync(p)) files.push(p);
    for (const t of ls(join(home, ".claude/todos"))) if (t.startsWith(sid)) files.push(join(home, ".claude/todos", t));
  }
  // Codex: rollouts whose first lines say they ran in this folder.
  const rollouts: string[] = [];
  const since = o.since ?? 0;
  walk(join(home, ".codex/sessions"), rollouts, since);
  walk(join(home, ".codex/archived_sessions"), rollouts, since);
  const needle = JSON.stringify(cwd).slice(1, -1);
  for (const f of rollouts) {
    try { if (!head(f).includes(`"cwd":"${needle}"`)) continue; } catch { continue; }
    files.push(f);
    const m = basename(f).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (m) codexIds.push(m[1]);
  }
  if (existsSync(cwd)) files.push(cwd);
  // Typed-prompt history: Claude keys lines by project folder, Codex by session id.
  const out: Plan["lines"] = [];
  const count = (file: string, hit: (o: any) => boolean) => { const n = lines(file).filter((l) => { try { return l && hit(JSON.parse(l)); } catch { return false; } }).length; if (n) out.push({ file, n }); };
  count(join(home, ".claude/history.jsonl"), (x) => x.project === cwd);
  if (codexIds.length) count(join(home, ".codex/history.jsonl"), (x) => codexIds.includes(x.session_id));
  return { files, lines: out };
}

/** Where deletion may happen at all: the agents' own transcript folders and the private folders' root. */
function allowed(p: string, home: string, root: string) {
  const r = resolve(p);
  return [".claude/projects/", ".claude/file-history/", ".claude/session-env/", ".claude/todos/", ".codex/sessions/", ".codex/archived_sessions/"].some((d) => r.startsWith(join(home, d)))
    || (r.startsWith(resolve(root) + "/") && isPrivatePath(r));
}

/** Deletes what the user saw and confirmed, and only what a fresh plan still lists. Returns what went. */
export function deletePlan(o: { home: string; cwd: string; root: string; since?: number; files: string[]; lines: boolean }): { deleted: string[]; lines: number; skipped: string[] } {
  const fresh = planFiles(o);
  const want = new Set(o.files.map((f) => resolve(f)));
  const deleted: string[] = [], skipped: string[] = [];
  for (const f of fresh.files) {
    if (!want.has(resolve(f))) continue;
    if (!allowed(f, o.home, o.root)) { skipped.push(f); continue; }
    try { lstatSync(f); rmSync(f, { recursive: true, force: true }); deleted.push(f); } catch { skipped.push(f); }
  }
  let removed = 0;
  if (o.lines) {
    const cwd = resolve(o.cwd);
    const ids = fresh.files.map((f) => basename(f).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1]).filter(Boolean);
    for (const { file } of fresh.lines) {
      const all = lines(file);
      const keep = all.filter((l) => { try { const x = JSON.parse(l); return !(x.project === cwd || (x.session_id && ids.includes(x.session_id))); } catch { return true; } });
      if (keep.length === all.length) continue;
      // Written beside it and renamed over it, so a crash never leaves half a history file.
      const tmp = `${file}.deck-${process.pid}.tmp`;
      writeFileSync(tmp, keep.join("\n"));
      renameSync(tmp, file);
      removed += all.length - keep.length;
    }
  }
  return { deleted, lines: removed, skipped };
}
