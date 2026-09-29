// Read-only git for the Files plugin. Every call is one short `git` with a timeout and an output cap, and none takes
// the index lock (--no-optional-locks), so looking can never get in the way of the agent's own git commands.
// External diff drivers, textconv filters and fsmonitor hooks are off: a look runs nothing a repo configured.

export type GitOut = { ok: boolean; code: number; out: string; truncated: boolean };

const BASE = ["--no-optional-locks", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "color.ui=false"];

export async function git(root: string, args: string[], o: { cap?: number; timeoutMs?: number } = {}): Promise<GitOut> {
  const cap = o.cap ?? 4 << 20;
  let p;
  try {
    p = Bun.spawn(["git", ...BASE, "-C", root, ...args], {
      stdout: "pipe", stderr: "ignore", stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_PAGER: "cat" },
    });
  } catch { return { ok: false, code: -1, out: "", truncated: false }; }
  const timer = setTimeout(() => p.kill(), o.timeoutMs ?? 8000);
  const chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > cap) { chunks.push(value.subarray(0, cap - size)); size = cap; truncated = true; p.kill(); break; }
      chunks.push(value); size += value.length;
    }
  } catch {}
  const code = await p.exited;
  clearTimeout(timer);
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return { ok: code === 0 || truncated, code, out: new TextDecoder().decode(buf), truncated };
}

/** The repo's top folder, or undefined when `dir` isn't in one. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"], { timeoutMs: 3000 });
  const top = r.code === 0 ? r.out.trim() : "";
  return top || undefined;
}

import type { Badge } from "../../src/git-diff";
export type { Badge };
export type StatusEntry = { path: string; st: Badge; old?: string; staged: boolean };

/** `git status --porcelain=v1 -z`: "XY path\0" (+ "orig\0" after a rename or copy). */
export function parseStatus(out: string): StatusEntry[] {
  const parts = out.split("\0");
  const list: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0], y = e[1], path = e.slice(3);
    let old: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") old = parts[++i];
    list.push({ path, st: badgeOf(x, y), old, staged: x !== " " && x !== "?" });
  }
  return list;
}
function badgeOf(x: string, y: string): Badge {
  if (x === "?" && y === "?") return "?";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "U";
  const c = y !== " " ? y : x;
  if (c === "D") return "D";
  if (c === "A" || c === "C") return "A";
  if (c === "R") return "R";
  return "M";
}

export async function status(root: string): Promise<{ list: StatusEntry[]; truncated: boolean; branch?: string }> {
  const [s, b] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cap: 4 << 20 }),
    git(root, ["symbolic-ref", "--short", "-q", "HEAD"], { timeoutMs: 3000 }),
  ]);
  let list = parseStatus(s.out);
  // A cut-off last entry is garbage: drop it.
  if (s.truncated) list = list.slice(0, -1);
  return { list: list.slice(0, 20_000), truncated: s.truncated || list.length > 20_000, branch: b.out.trim() || undefined };
}

/** Every file git would show: tracked plus new ones that aren't ignored (so node_modules, build output and anything in
 *  .gitignore never appear). */
export async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const r = await git(root, ["ls-files", "-z", "-c", "-o", "--exclude-standard"], { cap: 24 << 20, timeoutMs: 10_000 });
  const all = r.out.split("\0").filter(Boolean);
  if (r.truncated) all.pop();
  const files = [...new Set(all)]; // a conflicted file is listed once per stage
  return { files: files.slice(0, 200_000), truncated: r.truncated || files.length > 200_000 };
}

/** The empty tree: the base for a diff in a repo with no commits yet. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function headOf(root: string): Promise<string | undefined> {
  const r = await git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { timeoutMs: 3000 });
  return r.code === 0 ? r.out.trim() || undefined : undefined;
}

/** The commit HEAD's branch was on when the session started: the last one before that time. */
export async function commitAt(root: string, ms: number): Promise<{ sha: string; subject: string; at: number } | undefined> {
  const r = await git(root, ["log", "-1", `--before=@${Math.floor(ms / 1000)}`, "--format=%H%x00%s%x00%ct", "HEAD"], { timeoutMs: 4000 });
  const [sha, subject, ct] = r.out.trim().split("\0");
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha ?? "") ? { sha, subject: subject ?? "", at: Number(ct) * 1000 } : undefined;
}
