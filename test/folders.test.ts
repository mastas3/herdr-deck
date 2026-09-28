import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { inWorktree, parseCheckout } from "../src/git-worktree";
import { listDir } from "../src/http/dir";

describe("which checkout a folder is in", () => {
  test("the main checkout: git dir and common dir agree (relative at the top, absolute below)", () => {
    expect(parseCheckout("/r/app", "/r/app\n.git\n.git")).toEqual({ root: "/r/app", main: "/r/app", worktree: false });
    expect(parseCheckout("/r/app/src", "/r/app\n/r/app/.git\n../.git")).toEqual({ root: "/r/app", main: "/r/app", worktree: false });
  });
  test("a linked worktree knows its repo's main checkout", () => {
    expect(parseCheckout("/r/app/.claude/worktrees/agent-1", "/r/app/.claude/worktrees/agent-1\n/r/app/.git/worktrees/agent-1\n/r/app/.git"))
      .toEqual({ root: "/r/app/.claude/worktrees/agent-1", main: "/r/app", worktree: true });
    expect(parseCheckout("/r/app-feat/lib", "/r/app-feat\n/r/app/.git/worktrees/app-feat\n/r/app/.git")).toEqual({ root: "/r/app-feat", main: "/r/app", worktree: true });
  });
  test("bare layouts, submodules and non-repos", () => {
    expect(parseCheckout("/r/proj/main", "/r/proj/main\n/r/proj/.bare/worktrees/main\n/r/proj/.bare")).toEqual({ root: "/r/proj/main", main: "/r/proj", worktree: true });
    expect(parseCheckout("/r/x", "/r/x\n/r/repo.git/worktrees/x\n/r/repo.git")).toEqual({ root: "/r/x", main: "/r/repo", worktree: true });
    // A submodule's git dir lives in the superproject, but it is its own common dir: not a worktree.
    expect(parseCheckout("/r/app/vendor/lib", "/r/app/vendor/lib\n/r/app/.git/modules/lib\n/r/app/.git/modules/lib")?.worktree).toBe(false);
    expect(parseCheckout("/tmp", "")).toBeUndefined();
  });
  test("a worktree session joins its repo's project; the main checkout and other projects don't move", () => {
    const rootOf = (d: string) => d;
    expect(inWorktree({ root: "/r/app/.claude/worktrees/a1", main: "/r/app" }, "/r/app/.claude/worktrees/a1", rootOf)).toEqual({ gitRoot: "/r/app", worktree: "a1" });
    expect(inWorktree({ root: "/r/app", main: undefined }, "/r/app", rootOf)).toBeUndefined();
    // It mostly worked on another project: it stays there.
    expect(inWorktree({ root: "/r/app-wt", main: "/r/app" }, "/r/other", rootOf)).toBeUndefined();
    expect(inWorktree(undefined, "/r/app", rootOf)).toBeUndefined();
  });
});

describe("the folder window's listing", () => {
  // Under the home folder: resolveSafe only shows files there (or in /tmp).
  let base = "", proj = "";
  beforeAll(() => {
    mkdirSync(`${homedir()}/.cache`, { recursive: true });
    base = realpathSync(mkdtempSync(`${homedir()}/.cache/deck-dir-test-`));
    proj = `${base}/proj`;
    mkdirSync(`${proj}/src/deep`, { recursive: true });
    mkdirSync(`${proj}/.git`);
    mkdirSync(`${base}/outside`);
    writeFileSync(`${base}/outside/secret.txt`, "no");
    writeFileSync(`${proj}/README.md`, "# hi");
    writeFileSync(`${proj}/file10.ts`, "x");
    writeFileSync(`${proj}/file2.ts`, "xx");
    writeFileSync(`${proj}/.env`, "A=1");
    writeFileSync(`${proj}/src/a.ts`, "a");
    utimesSync(`${proj}/README.md`, 1_700_000_000, 1_700_000_000);
    symlinkSync(`${base}/outside`, `${proj}/out-link`);
    symlinkSync(`${proj}/src`, `${proj}/src-link`);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test("folders (and links to folders) first, then files by natural name; hidden ones marked", async () => {
    const r: any = await listDir(proj, "");
    expect(r.error).toBeUndefined();
    expect(r.entries.map((e: any) => e.name)).toEqual([".git", "out-link", "src", "src-link", ".env", "file2.ts", "file10.ts", "README.md"]);
    const by = Object.fromEntries(r.entries.map((e: any) => [e.name, e]));
    expect(by[".git"]).toMatchObject({ kind: "dir", hidden: true });
    expect(by["README.md"]).toMatchObject({ kind: "file", size: 4, mtime: 1_700_000_000_000, hidden: false });
    expect(by["src-link"]).toMatchObject({ kind: "link", to: "dir", out: false });
    expect(by["out-link"]).toMatchObject({ kind: "link", to: "dir", out: true });
    expect(r).toMatchObject({ path: "", abs: proj, total: 8, truncated: false });
  });
  test("a subfolder, and a link that stays inside the project, can be opened", async () => {
    expect(((await listDir(proj, "src")) as any).entries.map((e: any) => e.name)).toEqual(["deep", "a.ts"]);
    expect((await listDir(proj, "src-link")) as any).toMatchObject({ path: "src", abs: `${proj}/src` });
    expect((await listDir(proj.replace(homedir(), "~"), "/src/deep")) as any).toMatchObject({ path: "src/deep", entries: [] });
  });
  test("nothing outside the project: .., absolute tricks and links out are refused", async () => {
    for (const rel of ["..", "../outside", "src/../../outside", "out-link"]) expect(((await listDir(proj, rel)) as any).error).toBe("That folder is outside the project.");
    expect(((await listDir(proj, "README.md")) as any).error).toBe("That isn’t a folder.");
    expect(((await listDir(proj, "missing")) as any).error).toBe("That folder no longer exists.");
  });
  test("only project folders the file viewer may show: in your home, never a secret, never relative", async () => {
    expect(((await listDir("/etc", "")) as any).error).toContain("outside your home");
    expect(((await listDir(`${homedir()}/.ssh`, "")) as any).error).toContain("isn’t one the deck will show");
    expect(((await listDir("proj", "")) as any).error).toContain("isn’t one the deck will show");
  });
  test("a home folder behind a symlink still counts as home, and paths come back as you gave the root", async () => {
    const was = process.env.HOME;
    symlinkSync(base, `${base}-home`);
    process.env.HOME = `${base}-home`;
    try {
      const r: any = await listDir(`${base}-home/proj`, "src");
      expect(r.error).toBeUndefined();
      expect([r.root, r.abs, r.path]).toEqual([`${base}-home/proj`, `${base}-home/proj/src`, "src"]);
      expect(((await listDir(`${base}-home/proj`, "out-link")) as any).error).toBe("That folder is outside the project.");
    } finally { process.env.HOME = was; rmSync(`${base}-home`, { force: true }); }
  });
  test("a big folder is capped and says so", async () => {
    const r: any = await listDir(proj, "", 3);
    // The cut keeps real folders first (links are only known to be folders once stat'ed).
    expect(r.entries.map((e: any) => e.name)).toEqual([".git", "src", ".env"]);
    expect(r).toMatchObject({ total: 8, truncated: true });
  });
});
