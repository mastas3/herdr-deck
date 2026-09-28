// The Files plugin's parts on their own: git output parsing, the tree (and .gitignore), the safety rules, and which
// files an agent touched, from Claude- and Codex-shaped transcripts written by fixtures.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { claudeDetail, codexDetail } from "../../../src/transcript";
import { addedDiff, parseDiff, parseNameStatus, parseNumstat } from "../diff";
import { listFiles, parseStatus, status } from "../git";
import { inside, safeRoot } from "../safe";
import { touchedList, touchedPaths } from "../touched";
import { buildIndex, changedDirs, diskDir, find, repoDir, walk } from "../tree";
import { claudeTranscript, codexTranscript, makeRepo, scratch } from "./fixtures";

const s = scratch("unit");
afterAll(s.done);
const base = realpathSync(s.dir);
const outside = join(base, "outside");
mkdirSync(outside);
const root = makeRepo(base, outside);

describe("git output", () => {
  test("status: badges for changed, new, deleted, renamed and conflicted files", () => {
    const out = [" M src/app.ts", "?? src/new.ts", " D gone.txt", "R  src/new-name.ts", "src/old-name.ts", "UU both.ts", "A  added.ts", "MM staged.ts", ""].join("\0");
    expect(parseStatus(out)).toEqual([
      { path: "src/app.ts", st: "M", old: undefined, staged: false },
      { path: "src/new.ts", st: "?", old: undefined, staged: false },
      { path: "gone.txt", st: "D", old: undefined, staged: false },
      { path: "src/new-name.ts", st: "R", old: "src/old-name.ts", staged: true },
      { path: "both.ts", st: "U", old: undefined, staged: true },
      { path: "added.ts", st: "A", old: undefined, staged: true },
      { path: "staged.ts", st: "M", old: undefined, staged: true },
    ]);
  });
  test("numstat and name-status, renames and binaries included", () => {
    const num = parseNumstat(["3\t1\tsrc/app.ts", "-\t-\tlogo.png", "0\t0\t", "src/old.ts", "src/new.ts", ""].join("\0"));
    expect(num.get("src/app.ts")).toEqual({ add: 3, del: 1 });
    expect(num.get("logo.png")).toEqual({ bin: true });
    expect(num.get("src/new.ts")).toEqual({ add: 0, del: 0 });
    expect(parseNameStatus(["M", "a.ts", "R087", "old.ts", "new.ts", "D", "gone.txt", "A", "b.ts", ""].join("\0"))).toEqual([
      { path: "a.ts", st: "M" }, { path: "new.ts", old: "old.ts", st: "R" }, { path: "gone.txt", st: "D" }, { path: "b.ts", st: "A" },
    ]);
  });
  test("a unified diff becomes numbered lines; headers become notes", () => {
    const out = [
      "diff --git a/src/app.ts b/src/app.ts", "index 1..2 100644", "--- a/src/app.ts", "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@ export", " export const a = 1;", "-export const b = 2;", "+export const b = 20;", " export const c = 3;", "+export const d = 4;",
      "\\ No newline at end of file",
      "diff --git a/x.png b/x.png", "new file mode 100644", "Binary files /dev/null and b/x.png differ", "",
    ].join("\n");
    expect(parseDiff(out)).toEqual([
      ["@", "@@ -1,3 +1,4 @@ export"], [" ", "export const a = 1;", 1, 2 - 1], ["-", "export const b = 2;", 2], ["+", "export const b = 20;", undefined, 2],
      [" ", "export const c = 3;", 3, 3], ["+", "export const d = 4;", undefined, 4], ["!", "No newline at end of file"],
      ["!", "New file"], ["!", "Binary file changed"],
    ]);
    expect(addedDiff("a\nb\n")).toEqual([["@", "@@ -0,0 +1,2 @@"], ["+", "a", undefined, 1], ["+", "b", undefined, 2]]);
    expect(parseDiff("@@ -1 +1 @@\n-" + "x".repeat(5000))[1][1].length).toBeLessThan(2100);
  });
});

describe("the tree", () => {
  test("follows git: ignored folders never show, deleted files are marked, changed folders counted", async () => {
    const { files } = await listFiles(root);
    expect(files).toContain("src/new.ts"); // new, not ignored
    expect(files.some((f) => f.startsWith("node_modules/") || f.startsWith("dist/"))).toBe(false);
    const st = await status(root);
    const map = new Map(st.list.map((e) => [e.path, e.st] as const));
    expect(map.get("src/app.ts")).toBe("M");
    expect(map.get("src/new.ts")).toBe("?");
    expect(map.get("gone.txt")).toBe("D");
    expect(map.get("src/new-name.ts")).toBe("R");
    const idx = buildIndex(files);
    const top = repoDir(root, idx, "", map, changedDirs(map.keys()));
    const names = top.entries.map((e) => e.name);
    expect(names.slice(0, 1)).toEqual(["src"]); // folders first
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("dist");
    expect(top.entries.find((e) => e.name === "src")!.n).toBeGreaterThanOrEqual(3);
    expect(top.entries.find((e) => e.name === "gone.txt")).toMatchObject({ st: "D", gone: true });
    expect(top.entries.find((e) => e.name === ".env")).toMatchObject({ blocked: true, st: "?" });
    expect(top.entries.find((e) => e.name === "escape-link")).toMatchObject({ link: true, blocked: true });
    expect(top.entries.find((e) => e.name === "readme-link")).toMatchObject({ link: true });
    expect(top.entries.find((e) => e.name === "readme-link")!.blocked).toBeUndefined();
    const src = repoDir(root, idx, "src", map, changedDirs(map.keys()));
    expect(src.entries.map((e) => e.name)).toEqual(["lib", "app.ts", "new-name.ts", "new.ts"]); // the rename is staged: the old name left the index
  });
  test("without git: the disk, minus node_modules, capped", () => {
    const d = diskDir(root, "");
    expect(d.entries.map((e) => e.name)).toContain("dist");
    expect(d.entries.map((e) => e.name)).not.toContain("node_modules");
    expect(d.entries.map((e) => e.name)).not.toContain(".git");
    const w = walk(root, 3);
    expect(w).toMatchObject({ truncated: true });
    expect(w.files.length).toBe(3);
  });
  test("the filter: every word, names first", () => {
    const files = ["src/app.ts", "docs/app-notes.md", "src/lib/apple/x.ts", "test/app.test.ts"];
    expect(find(files, "app").paths).toEqual(["src/app.ts", "test/app.test.ts", "docs/app-notes.md", "src/lib/apple/x.ts"]);
    expect(find(files, "src app").paths).toEqual(["src/app.ts", "src/lib/apple/x.ts"]);
    expect(find(files, "  ").paths).toEqual([]);
  });
});

describe("safety", () => {
  test("paths stay inside the session's folder and away from secrets", () => {
    expect(inside(root, "")).toBe(root);
    expect(inside(root, "src/app.ts")).toBe(`${root}/src/app.ts`);
    expect(inside(root, "./src/")).toBe(`${root}/src`);
    expect(inside(root, "gone.txt")).toBe(`${root}/gone.txt`); // deleted: checked through its folder
    for (const bad of ["../outside/private.txt", "src/../../outside", "/etc/passwd", `${root}/src/app.ts`, ".env", "escape-link", "a\0b", ".git/../.env", 42, null]) {
      expect(inside(root, bad as any)).toBeUndefined();
    }
    mkdirSync(join(root, "keys"), { recursive: true });
    for (const secret of ["keys/id_rsa", "keys/server.pem", "keys/api.token", ".ssh/config", "config/.env.local"]) expect(inside(root, secret)).toBeUndefined();
    symlinkSync(outside, join(root, "out-dir"));
    expect(inside(root, "out-dir")).toBeUndefined();
    expect(inside(root, "out-dir/private.txt")).toBeUndefined();
  });
  test("only folders in your home or /tmp can be a root", () => {
    expect(safeRoot(root)).toBe(root);
    expect(safeRoot("/etc")).toBeUndefined();
    expect(safeRoot("/")).toBeUndefined();
    expect(safeRoot("relative/path")).toBeUndefined();
    expect(safeRoot(`${root}/nope`)).toBeUndefined();
    expect(safeRoot(undefined)).toBeUndefined();
  });
});

describe("files the agent touched", () => {
  test("Claude: Edit, Write, MultiEdit and NotebookEdit, newest first; reads, commands and sidechains don't count", async () => {
    const f = join(base, "claude.jsonl");
    claudeTranscript(f, root);
    const d = await claudeDetail(f);
    const paths = touchedPaths(d.edits!, root);
    expect(paths.map((p) => p.path)).toEqual([`${root}/.env`, `${root}/src/app.ts`, `${root}/notes.ipynb`, `${root}/src/lib/deep.ts`, `${root}/src/new.ts`]);
    const map = new Map([["src/app.ts", "M"], ["src/new.ts", "?"]] as const);
    const list = touchedList(paths, [root], map as any);
    expect(list.map((t) => t.rel)).toEqual(["src/app.ts", "notes.ipynb", "src/lib/deep.ts", "src/new.ts"]); // the secret is dropped
    expect(list[0]).toMatchObject({ st: "M" });
    expect(list.find((t) => t.rel === "notes.ipynb")).toMatchObject({ gone: true });
  });
  test("Codex: apply_patch (relative paths, adds, deletes, moves), patches in shell commands, and file changes", async () => {
    const f = join(base, "rollout.jsonl");
    codexTranscript(f, root);
    const d = await codexDetail(f);
    const paths = touchedPaths(d.edits!, root).map((p) => p.path);
    expect(paths[0]).toBe(`${root}/src/lib/deep.ts`); // the newest
    expect([...paths].sort()).toEqual([`${root}/README.md`, `${root}/docs/added.md`, `${root}/gone.txt`, `${root}/src/app.ts`, `${root}/src/lib/deep.ts`, `${root}/src/new-name.ts`, `${root}/src/old-name.ts`].sort());
  });
  test("relative and home paths resolve; the same file twice is listed once", () => {
    const r = touchedPaths([["a.ts", 1], ["./a.ts", 5], ["~/x.ts", 3]], "/tmp/p");
    expect(r[0]).toEqual({ path: "/tmp/p/a.ts", at: 5 });
    expect(r.length).toBe(2);
    expect(r[1].path).toEndWith("/x.ts");
  });
});
