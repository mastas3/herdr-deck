import { test, expect, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseFolders } from "../src/http/explorer";
import { createForward } from "../src/http/forward";
const src = readFileSync(new URL("../public/js/explorer-model.js", import.meta.url), "utf8");
const { exForest, exId, exPath, exSearch, exFreezeOrder } = new Function(src + "; return {exForest, exId, exPath, exSearch, exFreezeOrder};")();
const machines = [{ id: "mac", label: "Mac", local: true }, { id: "linux", label: "Linux" }, { id: "app", kind: "app" }];
const row = (key: string, machine: string, cwd: string, extra = {}) => ({ key, machine, cwd, status: "idle", ...extra });
test("same names on different machines and paths never combine", () => {
  const f = exForest(machines, [row("a", "mac", "/Users/me/Projects/api"), row("b", "linux", "/home/me/Projects/api"), row("c", "mac", "/Users/me/work/api")], "mac");
  expect(f.roots).toHaveLength(2);
  expect(f.nodes.get(exId("mac", "/Users/me/Projects/api")).rows.map((r: any) => r.key)).toEqual(["a"]);
  expect(f.nodes.get(exId("linux", "/home/me/Projects/api")).rows.map((r: any) => r.key)).toEqual(["b"]);
  expect(f.roots[0].all).toHaveLength(2);
});
test("app sessions live on their physical machine, nested folders retain direct sessions and aggregate attention", () => {
  const f = exForest(machines, [row("a", "mac", "/Users/me/Projects"), row("b", "app", "/Users/me/Projects/api", { status: "blocked" }), row("c", "mac", "/Users/me/Projects/api/src", { status: "working" })], "mac");
  const p = f.nodes.get(exId("mac", "/Users/me/Projects"));
  expect(p.rows.map((r: any) => r.key)).toEqual(["a"]); expect(p.all).toHaveLength(3); expect(p.attention).toBe(1); expect(p.working).toBe(1);
});
test("empty browsed folders, outside-home directories and normalized paths survive", () => {
  const listings = new Map([[exId("mac", "/tmp"), { data: { path: "/tmp", folders: [{ path: "/tmp/empty", name: "empty" }] } }]]);
  const f = exForest(machines, [row("a", "mac", "/Users/me/Projects/api")], "mac", listings);
  expect(f.nodes.get(exId("mac", "/tmp/empty")).rows).toEqual([]);
  expect(exPath("/Users/me/Projects/../wiki//")).toBe("/Users/me/wiki");
});
const scratch = mkdtempSync(join(tmpdir(), "deck-explorer-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
test("real browsing returns only folders, handles hidden directories and protects credential links", async () => {
  mkdirSync(join(scratch, "Project A")); mkdirSync(join(scratch, ".hidden")); mkdirSync(join(scratch, ".ssh"));
  writeFileSync(join(scratch, "file.txt"), "not a folder"); symlinkSync(join(scratch, ".ssh"), join(scratch, "innocent"));
  symlinkSync(join(scratch, "Project A"), join(scratch, "linked"));
  const found = await browseFolders("~", false, scratch);
  expect(found.folders.map(f => f.name)).toEqual(["linked", "Project A"]);
  expect((await browseFolders("~", true, scratch)).folders.map(f => f.name)).toContain(".hidden");
  expect(found.home).toBe(scratch);
  await expect(browseFolders(join(scratch, "innocent"))).rejects.toThrow("private");
  await expect(browseFolders("relative")).rejects.toThrow("absolute");
  await expect(browseFolders("/tmp/\0")).rejects.toThrow("Invalid");
  await expect(browseFolders(join(scratch, "missing"))).rejects.toThrow("no longer exists");
});
test("folder browsing forwards to the selected machine and refuses unknown machines", async () => {
  const calls: any[] = [];
  const remote = { post: async (...args: any[]) => { calls.push(args); return { status: 200, data: { path: "/home/me" } }; } };
  const forward = createForward({ selfId: "mac", remotes: new Map([["linux", remote]]) as any, briefKey: () => "", closeLocal: async () => [] });
  expect(await forward("/api/browse-folders", { machine: "mac", path: "~" })).toBeUndefined();
  expect((await forward("/api/browse-folders", { machine: "missing" }))?.status).toBe(400);
  expect((await forward("/api/browse-folders", { machine: "linux", path: "/home/me" }))?.status).toBe(200);
  expect(calls).toEqual([["/api/browse-folders", { machine: undefined, path: "/home/me" }]]);
});

test("machine home metadata anchors nonstandard homes without inventing parent folders", () => {
  const f = exForest([{ id: "scratch", label: "Scratch", home: "/tmp/preview" }], [row("a", "scratch", "/tmp/preview/Projects/demo")], "scratch");
  expect(f.roots[0].children.map((n: any) => n.name)).toEqual(["Projects"]);
  expect(f.roots[0].path).toBe("/tmp/preview");
});

test("search retains ancestors of matching empty folders and respects status queries", () => {
  const listings = new Map([[exId("mac", "/Users/me/Projects"), { data: { path: "/Users/me/Projects", folders: [{ path: "/Users/me/Projects/empty folder" }] } }]]);
  const f = exForest(machines, [], "mac", listings, new Map([["mac", "/Users/me"]]));
  exSearch(f, "empty folder");
  expect(f.roots[0].matches).toBe(true);
  expect(f.nodes.get(exId("mac", "/Users/me/Projects")).matches).toBe(true);
  expect(f.roots[1].matches).toBe(false);
  exSearch(f, "empty -folder"); expect(f.roots[0].matches).toBe(false);
  exSearch(f, "is:working"); expect(f.roots[0].matches).toBe(false);
});
test("root user's home and offline state carry through the hierarchy", () => {
  const f = exForest([{ id: "linux", label: "Linux", online: false }], [row("a", "linux", "/root")], "linux");
  expect(f.roots[0].path).toBe("/root");
  expect(f.roots[0].rows[0].key).toBe("a");
});

test("live order can freeze under the pointer without losing new or removed sessions", () => {
  const a = row("a", "mac", "/Users/me/Projects"), b = row("b", "mac", "/Users/me/Projects"), c = row("c", "mac", "/Users/me/Projects");
  const before = exForest(machines, [a, b], "mac"), next = exForest(machines, [c, b, a], "mac");
  exFreezeOrder(next, before.nodes);
  expect(next.nodes.get(exId("mac", "/Users/me/Projects")).rows.map((r: any) => r.key)).toEqual(["a", "b", "c"]);
  const removed = exForest(machines, [c, b], "mac"); exFreezeOrder(removed, next.nodes);
  expect(removed.nodes.get(exId("mac", "/Users/me/Projects")).rows.map((r: any) => r.key)).toEqual(["b", "c"]);
});
