// The deck's own worktrees, against real throwaway git repos: making one (and leaving nothing behind when that fails),
// the New session plan, merging back by fast-forward only, removing with a way back, and the stale list.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, pickPrefix, slugBranch, branchProblem, envFiles, installCommand } from "../src/wt-git";
import { discardWorktree, mainPorts, makeWorktree, planWorktree, sameRepo } from "../src/wt-create";
import { mergeWorktree, removeWorktree, restoreWorktree, unmergeWorktree, worktreeDiff, worktreeFileDiff, worktreeStatus } from "../src/wt-ops";
import { cleanStale, staleLine, staleWorktrees } from "../src/wt-stale";
import { loadWorktrees, patchWorktree } from "../src/wt-store";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "deck-wt-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@example.com";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

let n = 0;
async function repo(files: Record<string, string> = { "a.txt": "one\n" }) {
  const dir = join(ROOT, `r${++n}`);
  mkdirSync(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), t); }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}
const commit = async (dir: string, f: string, text: string, msg = `edit ${f}`) => { writeFileSync(join(dir, f), text); await git(dir, ["add", "-A"]); await git(dir, ["commit", "-qm", msg]); };
const head = async (dir: string, ref = "HEAD") => (await git(dir, ["rev-parse", ref])).out.trim();
const ctx = { others: async () => [], listening: [] };

beforeEach(() => loadWorktrees(join(ROOT, `store-${++n}.json`)));

describe("names", () => {
  test("a branch name from the first message: a few meaningful words, the repo's prefix", () => {
    expect(slugBranch("Please add search to the chat view", "stas/")).toBe("stas/add-search-chat-view");
    expect(slugBranch("Fix: the flaky billing test (again!)")).toBe("fix-flaky-billing-test");
    expect(slugBranch("")).toMatch(/^work-/);
  });
  test("the prefix is the repo's own convention, never an invented one", () => {
    expect(pickPrefix(["main", "stas/a", "stas/b", "feat/x", "feat/y", "feat/z"], "Stas")).toBe("stas/");
    expect(pickPrefix(["main", "feat/x", "feat/y"])).toBe("");
    expect(pickPrefix(["main", "stas/a"])).toBe("");
    expect(pickPrefix(["bob/a", "bob/b", "stas/a", "stas/b"], "Stas M")).toBe("stas/");
  });
  test("branch names: git's rules, and not one that exists", async () => {
    const r = await repo();
    expect(await branchProblem(r, "stas/ok-name")).toBeUndefined();
    expect(await branchProblem(r, "bad..name")).toContain("isn’t a name git allows");
    expect(await branchProblem(r, "has space")).toContain("isn’t a name git allows");
    expect(await branchProblem(r, "main")).toBe("A branch named main already exists");
  });
});

describe("making one", () => {
  test("worktree add from the base, .env files linked (not copied), kept out of git status", async () => {
    const r = await repo({ "a.txt": "one\n", ".gitignore": ".env*\n!.env.example\n", ".env.example": "X=\n", "apps/web/page.ts": "x\n", "package.json": "{}", "bun.lock": "" });
    writeFileSync(join(r, ".env"), "SECRET=1\n");
    writeFileSync(join(r, "apps/web/.env.local"), "L=1\n");
    expect(await envFiles(r)).toEqual([".env", "apps/web/.env.local"]);
    expect(installCommand(r)).toEqual({ lock: "bun.lock", cmd: "bun install" });
    const m = await makeWorktree(join(r, "apps/web"), { branch: "stas/try-it", env: [".env", "apps/web/.env.local", "../../etc/passwd"] });
    expect(m.path).toBe(`${r}/.claude/worktrees/stas-try-it`);
    expect(m.cwd).toBe(`${m.path}/apps/web`);
    expect(await head(m.path, "HEAD")).toBe(await head(r));
    expect((await git(m.path, ["symbolic-ref", "--short", "HEAD"])).out.trim()).toBe("stas/try-it");
    expect(lstatSync(join(m.path, ".env")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(m.path, ".env"))).toBe(join(r, ".env"));
    expect(m.links).toEqual([".env", "apps/web/.env.local"]);
    expect(readFileSync(join(r, ".git/info/exclude"), "utf8")).toContain("/.claude/worktrees/");
    expect((await git(r, ["status", "--porcelain"])).out).toBe("");
    expect((await git(m.path, ["status", "--porcelain"])).out).toBe("");
  });
  test("an existing branch, a folder in the way or a bad base: refused, nothing left behind", async () => {
    const r = await repo();
    await git(r, ["branch", "taken"]);
    await expect(makeWorktree(r, { branch: "taken" })).rejects.toThrow("already exists");
    mkdirSync(`${r}/.claude/worktrees/in-the-way`, { recursive: true });
    await expect(makeWorktree(r, { branch: "in-the-way" })).rejects.toThrow("already exists");
    await expect(makeWorktree(r, { branch: "x", base: "nope" })).rejects.toThrow("no branch or commit named nope");
    expect((await git(r, ["branch", "--list", "x", "in-the-way"])).out).toBe("");
  });
  test("when git fails part way, the branch and the folder are gone again", async () => {
    const r = await repo();
    // A file where .claude/worktrees should be: the add can't make its folder.
    mkdirSync(`${r}/.claude`); writeFileSync(`${r}/.claude/worktrees`, "");
    await expect(makeWorktree(r, { branch: "half" })).rejects.toThrow();
    expect((await git(r, ["branch", "--list", "half"])).out).toBe("");
    expect((await git(r, ["worktree", "list"])).out.trim().split("\n").length).toBe(1);
    rmSync(`${r}/.claude/worktrees`);
    const m = await makeWorktree(r, { branch: "whole" });
    await discardWorktree(m);
    expect(existsSync(m.path)).toBe(false);
    expect((await git(r, ["branch", "--list", "whole"])).out).toBe("");
  });
  test("an ignored .claude/ needs no exclude line", async () => {
    const r = await repo({ ".gitignore": ".claude/\n" });
    const p = await planWorktree({ cwd: r }, ctx);
    expect(p.repo && p.exclude).toBe("ignored");
    await makeWorktree(r, { branch: "b1" });
    expect(readFileSync(join(r, ".git/info/exclude"), "utf8")).not.toContain("/.claude/worktrees/");
  });
});

describe("the plan", () => {
  test("suggests a branch, checks what you type, and warns about a dirty base and busy ports", async () => {
    const r = await repo();
    writeFileSync(join(r, "a.txt"), "changed\n");
    const listening = [{ port: 3000, cmd: "bun", cwd: r }, { port: 3001, cmd: "vite", cwd: `${r}/.claude/worktrees/x` }, { port: 5000, cmd: "node", cwd: "/elsewhere" }];
    const p: any = await planWorktree({ cwd: r, prompt: "Add chat search" }, { others: async () => [{ key: "h/p1", title: "other" }], listening });
    expect(p).toMatchObject({ repo: true, main: r, branch: "add-chat-search", suggest: "add-chat-search", base: "main", defaultOn: true, exclude: "exclude" });
    expect(p.problems).toEqual({ branch: undefined, base: undefined, path: undefined });
    expect(p.baseDirty).toEqual({ checkout: r, files: 1 });
    expect(p.ports).toEqual([{ port: 3000, cmd: "bun" }]);
    const bad: any = await planWorktree({ cwd: r, branch: "main", base: "nope" }, ctx);
    expect(bad.problems.branch).toContain("already exists");
    expect(bad.problems.base).toContain("nope");
    expect(bad.defaultOn).toBe(false);
    expect(await planWorktree({ cwd: ROOT }, ctx)).toEqual({ repo: false });
  });
  test("on by default only when another live session works in the same repo, its worktrees included", async () => {
    const r = await repo(), other = await repo();
    const m = await makeWorktree(r, { branch: "side" });
    const common = async (cwd: string) => (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).out.trim();
    const rows = [{ key: "a", cwd: r }, { key: "b", cwd: m.path }, { key: "c", cwd: other }, { key: "d", cwd: ROOT }];
    expect((await sameRepo(rows, await common(r), common)).map((x) => x.key)).toEqual(["a", "b"]);
    expect((await sameRepo(rows, await common(other), common)).map((x) => x.key)).toEqual(["c"]);
    expect(mainPorts(r, [])).toEqual([]);
  });
});

describe("getting the work back", () => {
  test("status and diff against the base; merge fast-forwards the base's checkout; Undo moves it back", async () => {
    const r = await repo();
    const m = await makeWorktree(r, { branch: "feature" });
    await commit(m.path, "b.txt", "new\n", "add b");
    const s = await worktreeStatus(m.path);
    expect(s).toMatchObject({ branch: "feature", base: "main", baseCheckout: r, ahead: 1, behind: 0, ff: true, merged: false, dirty: [] });
    expect(s.commits.map((c) => c.subject)).toEqual(["add b"]);
    const d = await worktreeDiff(s);
    expect(d).toMatchObject({ add: 1, del: 0, files: [{ path: "b.txt", st: "A", add: 1, del: 0 }] });
    expect((await worktreeFileDiff(s, "b.txt")).filter((l) => l[0] === "+")).toEqual([["+", "new", undefined, 1]]);
    const before = await head(r);
    const res: any = await mergeWorktree(m.path);
    expect(res).toMatchObject({ ok: true, base: "main", from: before, commits: 1 });
    expect(await head(r)).toBe(await head(m.path));
    expect(readFileSync(join(r, "b.txt"), "utf8")).toBe("new\n");
    expect((await worktreeStatus(m.path)).merged).toBe(true);
    await expect(mergeWorktree(m.path)).rejects.toThrow("nothing to merge");
    await unmergeWorktree(res);
    expect(await head(r)).toBe(before);
    expect(existsSync(join(r, "b.txt"))).toBe(false);
  });
  test("never with uncommitted changes in the base's checkout", async () => {
    const r = await repo();
    const m = await makeWorktree(r, { branch: "f2" });
    await commit(m.path, "b.txt", "x\n");
    writeFileSync(join(r, "a.txt"), "dirty\n");
    await expect(mergeWorktree(m.path)).rejects.toThrow("main has uncommitted changes");
  });
  test("not a fast-forward: handed to the agent with the exact message, conflicts named", async () => {
    const r = await repo();
    const m = await makeWorktree(r, { branch: "f3" });
    await commit(m.path, "a.txt", "theirs\n");
    await commit(r, "c.txt", "elsewhere\n");
    const clean: any = await mergeWorktree(m.path);
    expect(clean).toMatchObject({ ok: false, handoff: true, conflicts: [] });
    expect(clean.message).toBe('Rebase this branch (f3) onto main, so main can fast-forward to it. Run the checks, commit, and don\'t push. Then reply with one line: "Ready to merge".');
    await commit(r, "a.txt", "ours\n");
    const bad: any = await mergeWorktree(m.path);
    expect(bad.conflicts).toEqual(["a.txt"]);
    expect(bad.message).toContain("resolve the conflicts (a.txt)");
    expect(await head(r)).not.toBe(await head(m.path));
  });
  test("remove: asks first when work would be lost; keeps the branch; Undo brings back the folder and the changes", async () => {
    const r = await repo({ "a.txt": "one\n", ".gitignore": ".env\n" });
    writeFileSync(join(r, ".env"), "S=1\n");
    const m = await makeWorktree(r, { branch: "f4", env: [".env"] });
    await commit(m.path, "b.txt", "committed\n");
    writeFileSync(join(m.path, "a.txt"), "uncommitted\n");
    writeFileSync(join(m.path, "new.txt"), "untracked\n");
    const ask: any = await removeWorktree(m.path);
    expect(ask).toMatchObject({ ok: false, confirm: true, dirty: [" M a.txt", "?? new.txt"] });
    expect(ask.commits.map((c: any) => c.subject)).toEqual(["edit b.txt"]);
    expect(existsSync(m.path)).toBe(true);
    const done: any = await removeWorktree(m.path, true);
    expect(done.ok).toBe(true);
    expect(existsSync(m.path)).toBe(false);
    expect((await git(r, ["branch", "--list", "f4"])).out.trim()).toBe("f4");
    expect(done.undo.stash).toMatch(/^[0-9a-f]{40}$/);
    const back = await restoreWorktree(done.undo);
    expect(back).toMatchObject({ ok: true, note: "" });
    expect(readFileSync(join(m.path, "a.txt"), "utf8")).toBe("uncommitted\n");
    expect(readFileSync(join(m.path, "new.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(m.path, "b.txt"), "utf8")).toBe("committed\n");
    expect(lstatSync(join(m.path, ".env")).isSymbolicLink()).toBe(true);
    expect((await git(r, ["stash", "list"])).out).toBe("");
  });
  test("a clean, merged worktree goes without asking; Undo refuses paths the deck didn't make", async () => {
    const r = await repo();
    const m = await makeWorktree(r, { branch: "f5" });
    expect(await removeWorktree(m.path)).toMatchObject({ ok: true, undo: { stash: undefined } });
    await expect(restoreWorktree({ main: r, path: join(r, "elsewhere"), branch: "f5" })).rejects.toThrow("Not a worktree the deck removed");
    await expect(restoreWorktree({ main: r, path: m.path, branch: "gone" })).rejects.toThrow("is gone");
  });
});

describe("the weekly stale list", () => {
  test("merged or untouched for 14 days, not while a session works in it or you chose to keep it; Clean up keeps branches", async () => {
    const r = await repo();
    const merged = await makeWorktree(r, { branch: "done-one" });
    await commit(merged.path, "m.txt", "m\n");
    await mergeWorktree(merged.path);
    const fresh = await makeWorktree(r, { branch: "fresh-one" });
    await commit(fresh.path, "f.txt", "f\n");
    const busy = await makeWorktree(r, { branch: "busy-one" });
    const kept = await makeWorktree(r, { branch: "kept-one" });
    patchWorktree(kept.path, { keptAt: Date.now() });
    let list = await staleWorktrees([r], [busy.path]);
    expect(list.map((s) => [s.branch, s.why])).toEqual([["done-one", "merged"]]);
    // Two weeks later the unmerged one is stale too, and keeping one has run out.
    list = await staleWorktrees([r], [busy.path], Date.now() + 15 * 86400_000);
    expect(list.map((s) => s.branch).sort()).toEqual(["done-one", "fresh-one", "kept-one"]);
    expect(staleLine(list)).toContain("3 worktrees look finished");
    list = list.filter((s) => s.branch !== "kept-one");
    writeFileSync(join(fresh.path, "wip.txt"), "wip\n");
    const res = await cleanStale(list.map((s) => s.path), [busy.path]);
    expect(res.find((x) => x.path === merged.path)).toMatchObject({ ok: true });
    expect(res.find((x) => x.path === fresh.path)).toMatchObject({ ok: false, error: "1 uncommitted file, left alone" });
    expect(existsSync(merged.path)).toBe(false);
    expect((await git(r, ["branch", "--list", "done-one"])).out.trim()).toBe("done-one");
    await restoreWorktree(res.find((x) => x.ok)!.undo as any);
    expect(existsSync(merged.path)).toBe(true);
  });
});
