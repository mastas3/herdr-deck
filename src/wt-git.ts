// Git for the deck's own worktrees: which repo a folder is in, branch names, keeping .claude/worktrees/ out of
// `git status`, and what a fresh worktree lacks (untracked .env files, node_modules). Every call is one short `git`
// with a timeout, no prompts and no pager.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseCheckout } from "./git-worktree";

export type Git = { ok: boolean; code: number; out: string; err: string };

export async function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<Git> {
  let p;
  try {
    p = Bun.spawn(["git", "-C", cwd, ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", GIT_EDITOR: "true" },
    });
  } catch (e: any) { return { ok: false, code: -1, out: "", err: e?.message ?? String(e) }; }
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { ok: code === 0, code, out, err: err.trim() };
}
/** The first line git printed on failure, for a message a person reads. */
export const gitError = (g: Git) => g.err.split("\n").map((l) => l.replace(/^(fatal|error): /, "")).find(Boolean) ?? `git exited with ${g.code}`;

/** `top` the checkout the folder is in, `main` the repo's main checkout, `common` its shared .git dir. */
export type Repo = { top: string; main: string; common: string; worktree: boolean; branch?: string; head?: string };

export async function repoOf(dir: string): Promise<Repo | undefined> {
  const g = await git(dir, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], 5000);
  const co = g.ok ? parseCheckout(dir, g.out) : undefined;
  if (!co) return;
  const common = resolve(dir, g.out.split("\n")[2].trim());
  const [b, h] = await Promise.all([git(co.root, ["symbolic-ref", "--short", "-q", "HEAD"], 5000), git(co.root, ["rev-parse", "-q", "--verify", "HEAD"], 5000)]);
  return { top: co.root, main: co.main, common, worktree: co.worktree, branch: b.out.trim() || undefined, head: h.out.trim() || undefined };
}

export const worktreesDir = (main: string) => `${main}/.claude/worktrees`;
/** A branch's folder: its name with "/" as "-" (stas/chat-search → stas-chat-search). */
export const worktreePath = (main: string, branch: string) => `${worktreesDir(main)}/${branch.replace(/\//g, "-")}`;
/** Only folders the deck makes (one level under <main>/.claude/worktrees/) are ones it will add or remove. */
export function isDeckPath(main: string, path: string) {
  const rel = relative(worktreesDir(main), resolve(path));
  return !!rel && !rel.includes("/") && !rel.startsWith(".");
}

export async function branches(dir: string): Promise<string[]> {
  const g = await git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], 5000);
  return g.out.split("\n").map((l) => l.trim()).filter(Boolean);
}
export const branchExists = async (dir: string, name: string) => (await git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], 5000)).ok;

/** Why a new branch can't have this name, or undefined when it can. */
export async function branchProblem(dir: string, name: string): Promise<string | undefined> {
  if (!name) return "Give the branch a name";
  if (!(await git(dir, ["check-ref-format", "--branch", name], 5000)).ok || name.startsWith("-")) return `“${name}” isn’t a name git allows for a branch`;
  if (await branchExists(dir, name)) return `A branch named ${name} already exists`;
}

/**
 * The prefix this repo's branches use for a person's work ("stas/…"): the most common first part among its local
 * branches when at least two share it and it isn't a kind of change (feat/, fix/…). A tie goes to the one that
 * matches git's user.name. Otherwise none: the deck doesn't invent a convention the repo doesn't have.
 */
export function pickPrefix(names: string[], user = ""): string {
  const KINDS = /^(feat|feature|fix|bugfix|hotfix|chore|docs|refactor|test|tests|release|build|ci|perf|style|dependabot|renovate|revert|wip)$/i;
  const n = new Map<string, number>();
  for (const b of names) { const i = b.indexOf("/"); if (i > 0 && !KINDS.test(b.slice(0, i))) n.set(b.slice(0, i), (n.get(b.slice(0, i)) ?? 0) + 1); }
  const me = user.toLowerCase().split(/\s+/)[0] ?? "";
  const best = [...n].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || Number(b[0].toLowerCase() === me) - Number(a[0].toLowerCase() === me))[0];
  return best ? `${best[0]}/` : "";
}

/** A branch name from the first message: its first few meaningful words, lowercase, joined by "-". */
export function slugBranch(text: string, prefix = ""): string {
  const STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "please", "can", "you", "could", "would", "i", "we", "it", "this", "that", "is", "be", "me", "my", "our", "so", "all", "at", "by", "from", "into", "let", "lets", "let's", "make", "some"]);
  const words = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s-]+/g, " ").split(/[\s-]+/).filter((w) => w && !STOP.has(w));
  let slug = "";
  for (const w of words) { if ((slug + "-" + w).length > 32 && slug) break; slug = slug ? `${slug}-${w}` : w; if (slug.split("-").length >= 4) break; }
  return prefix + (slug.slice(0, 40).replace(/-+$/, "") || `work-${Date.now().toString(36).slice(-4)}`);
}

/**
 * Keeps <main>/.claude/worktrees/ out of the repo's `git status`. Already ignored (by .gitignore or elsewhere) is left
 * alone; otherwise one line goes in the repo's own .git/info/exclude, which is never committed. Tracked files are
 * never touched. `dry` only says what it would do.
 */
export async function ensureExcluded(repo: Pick<Repo, "main" | "common">, dry = false): Promise<"ignored" | "exclude"> {
  if ((await git(repo.main, ["check-ignore", "-q", "--no-index", ".claude/worktrees/x/y"], 5000)).ok) return "ignored";
  if (dry) return "exclude";
  const file = join(repo.common, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch {}
  if (!text.split("\n").some((l) => l.trim() === "/.claude/worktrees/")) appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# herdr deck: its worktrees for agents\n/.claude/worktrees/\n`);
  return "exclude";
}

/**
 * The .env files a worktree won't have: untracked ones in the main checkout (ignored or not), anywhere outside
 * ignored folders such as node_modules. Paths are relative to the main checkout; examples that git tracks aren't
 * listed (the worktree has those already).
 */
export async function envFiles(main: string): Promise<string[]> {
  const [ign, un] = await Promise.all([
    git(main, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], 8000),
    git(main, ["ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"], 8000),
  ]);
  const all = new Set([...ign.out.split("\0"), ...un.out.split("\0")].filter((p) => p && !p.endsWith("/")));
  return [...all].filter((p) => /^\.env(\.|$)/.test(p.split("/").pop()!) && !p.startsWith(".claude/worktrees/")).sort().slice(0, 40);
}

/** The install command for a JavaScript project with a lockfile at its root, the way its lockfile says. */
export function installCommand(dir: string): { cmd: string; lock: string } | undefined {
  if (!existsSync(join(dir, "package.json"))) return;
  const LOCKS: [string, string][] = [["bun.lock", "bun install"], ["bun.lockb", "bun install"], ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"], ["yarn.lock", "yarn install --frozen-lockfile"], ["package-lock.json", "npm ci"]];
  const hit = LOCKS.find(([f]) => existsSync(join(dir, f)));
  return hit && { lock: hit[0], cmd: hit[1] };
}

/** `git status --porcelain` lines ("XY path"), untracked included unless `tracked` only. */
export async function changes(dir: string, tracked = false): Promise<string[]> {
  const g = await git(dir, ["status", "--porcelain=v1", tracked ? "--untracked-files=no" : "--untracked-files=all"], 8000);
  return g.out.split("\n").filter((l) => l.length > 3);
}

/** Where a branch is checked out ("" = nowhere), from `git worktree list --porcelain`. */
export type WtEntry = { path: string; branch?: string; head?: string; bare?: boolean };
export function parseWorktreeList(out: string): WtEntry[] {
  const list: WtEntry[] = [];
  let cur: WtEntry | undefined;
  for (const l of out.split("\n")) {
    if (l.startsWith("worktree ")) list.push((cur = { path: l.slice(9) }));
    else if (!cur) continue;
    else if (l.startsWith("HEAD ")) cur.head = l.slice(5);
    else if (l.startsWith("branch ")) cur.branch = l.slice(7).replace(/^refs\/heads\//, "");
    else if (l === "bare") cur.bare = true;
  }
  return list;
}
export async function worktreeList(dir: string) { return parseWorktreeList((await git(dir, ["worktree", "list", "--porcelain"], 8000)).out); }
