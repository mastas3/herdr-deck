import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sessionOverview, overviewText } from "../src/session-overview";
const read = (name: string) => readFileSync(new URL(`../public/js/${name}.js`, import.meta.url), "utf8");
const tree = read("list-tree").match(/\/\* @pure:tree-begin[\s\S]*?\*\/([\s\S]*?)\/\* @pure:tree-end \*\//)![1];
const { exProjectForest, exAgentList, exSessionStory, exByteLabel, exElapsed } = new Function(tree + read("explorer-model") + read("explorer-projects") + ";return {exProjectForest,exAgentList,exSessionStory,exByteLabel,exElapsed}")();
const machines = [{ id: "mac", label: "Mac", home: "/Users/me", local: true }, { id: "linux", label: "Linux", home: "/home/me", online: false }, { id: "codex-app", kind: "app" }];
const row = (key: string, more: any = {}) => ({ key, machine: "mac", project: "Rook", projectRoot: "/Users/me/Projects/rook", cwd: "/Users/me/Projects/rook", status: "idle", ...more });
test("project view skips intermediate and empty directories, joins worktrees, and keeps machine/path identity", () => {
  const f = exProjectForest(machines, [row("a"), row("b", { machine: "codex-app", gitRoot: "/Users/me/Projects/rook", projectRoot: "/tmp/worktree", worktree: "feature" }), row("c", { machine: "linux", projectRoot: "/home/me/rook" }), row("d", { projectRoot: "/Users/me/other/rook" }), row("empty", { empty: true, projectRoot: "/Users/me/Downloads" })], "mac");
  expect(f.roots[0].children.map((n: any) => n.path)).toEqual(["/Users/me/Projects/rook", "/Users/me/other/rook"]);
  expect(f.roots[0].children[0].rows.map((r: any) => r.key)).toEqual(["a", "b"]);
  expect(f.roots[1].children[0].all.map((r: any) => r.key)).toEqual(["c"]);
  expect(f.roots[1].info.online).toBe(false);
  expect([...f.nodes.values()].some((n: any) => n.path === "/Users/me/Projects")).toBe(false);
});
test("fleet workers nest once under their parent across checkouts and worker-only search retains the parent", () => {
  const parent = row("parent"), worker = row("worker", { project: "Tests", projectRoot: "/tmp/tests", parent: { key: "parent", srcName: "Rook" }, status: "working" });
  const all = [parent, worker], f = exProjectForest(machines, all, "mac");
  expect(f.roots[0].children).toHaveLength(1);
  expect(f.roots[0].children[0].rows.map((r: any) => r.key)).toEqual(["parent"]);
  expect(f.roots[0].all).toHaveLength(2);
  expect(f.sessionTree.get("parent").all[0].r.key).toBe("worker");
  expect(f.roots[0].working).toBe(1);
  const search = exProjectForest(machines, [worker], "mac", all);
  expect(search.roots[0].children[0].rows[0].key).toBe("parent");
  expect(search.context.has("parent")).toBe(true);
});
test("orphan workers stay discoverable and malformed cyclic relationships terminate", () => {
  const rows = [row("a", { parent: { key: "b", srcName: "B" } }), row("b", { parent: { key: "a", srcName: "A" } }), row("orphan", { parent: { key: "missing", srcName: "Gone" } })];
  const f = exProjectForest(machines, rows, "mac");
  expect(new Set(f.roots[0].all.map((r: any) => r.key)).size).toBe(3);
  expect(f.sessionTree.has("orphan")).toBe(true);
});
test("native and fleet agents keep their sources and an indexed child is not counted twice", () => {
  const r = row("p", { subagents: [{ id: "native", running: true }, { id: "same", running: true }, { id: "idle", running: false }] });
  const list = exAgentList(r, { all: [{ r: row("worker", { sessionId: "same", status: "working" }) }] });
  expect(list.count).toBe(3); expect(list.running).toBe(2);
  expect(list.native.map((s: any) => s.id)).toEqual(["native", "idle"]);
});
test("attention projects lead, idle open sessions remain useful after days away", () => {
  const f = exProjectForest(machines, [row("quiet", { projectRoot: "/p/quiet", lastActiveAt: 10 }), row("working", { projectRoot: "/p/working", status: "working", lastActiveAt: 20 }), row("waiting", { projectRoot: "/p/waiting", status: "blocked", lastActiveAt: 5 })], "mac");
  expect(f.roots[0].children.map((n: any) => n.path)).toEqual(["/p/waiting", "/p/working", "/p/quiet"]);
});
test("session story shows purpose separately from the latest activity and avoids title duplication", () => {
  const r = row("a", { title: "Ship the dashboard", firstPrompt: "Ship the dashboard", overview: { purpose: "Ship the dashboard", request: "Add the project summary" }, status: "working", step: "Verify mobile navigation", lastMessage: "Old outcome" });
  expect(exSessionStory(r)).toEqual({ title: "Ship the dashboard", about: "Add the project summary", activity: "Verify mobile navigation" });
  expect(exSessionStory({ ...r, status: "idle" }).activity).toBe("");
  expect(exSessionStory(r, { brief: { about: "A place to manage your active projects" } }).about).toBe("A place to manage your active projects");
});
test("size and age distinguish unknown from zero and do not claim lifetime is running time", () => {
  expect(exByteLabel(undefined)).toBe("Not reported"); expect(exByteLabel(0)).toBe("0 B");
  expect(exByteLabel(1536)).toBe("1.5 KB"); expect(exByteLabel(5 * 1024 ** 2)).toBe("5.0 MB");
  expect(exElapsed(undefined, 1000)).toBe("Not reported"); expect(exElapsed(1000, 1000 + 49 * 3600_000)).toBe("2d 1h");
});
test("overview uses paired conversation excerpts and never reuses an old answer for an unfinished ask", () => {
  expect(sessionOverview({ started: "Make a **project explorer**", turns: [{ ask: "Make a project explorer", reply: "Done", at: 100 }, { ask: "Show native agents", at: 200 }] })).toEqual({ purpose: "Make a project explorer", request: "Show native agents", outcome: undefined, at: 200 });
  expect(overviewText('Read [the docs](https://example.com)\n```js\nsecretCode();\n```\n<environment_context>system paths</environment_context>then fix it')).toBe("Read the docs then fix it");
});
