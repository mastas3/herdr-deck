import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The list's tree of fleet workers lives in the browser script (no build step); evaluate just its marked block, and
// splitWorktrees from the list's own block.
const src = readFileSync(new URL("../public/js/list-tree.js", import.meta.url), "utf8");
const T = new Function(`${src.slice(src.indexOf("/* @pure:tree-begin"), src.indexOf("/* @pure:tree-end */"))}; return { treeParent, orphanKey, treeWithContext, treeFamilies, treeShown, treeOrderSig, treeSummary };`)();
const lsrc = readFileSync(new URL("../public/js/list-rows.js", import.meta.url), "utf8");
const L = new Function(`${lsrc.slice(lsrc.indexOf("/* @pure:list-begin"), lsrc.indexOf("/* @pure:list-end */"))}; return { splitWorktrees };`)();

const row = (key: string, o: any = {}) => ({ key, status: "idle", title: key, machine: "linux", ...o });
const kid = (key: string, parent: string | null, o: any = {}) => row(key, { parent: parent ? { key: parent, brief: key.toUpperCase(), srcName: "Disp" } : { brief: key.toUpperCase(), srcName: o.src ?? "Gone dispatcher", miss: "closed" }, ...o });
const all = (...rs: any[]) => new Map(rs.map((r) => [r.key, r]));
const keys = (fams: any[]) => T.treeShown(fams).map((r: any) => r.key);

describe("families", () => {
  test("a worker follows its dispatcher, in its own order; other rows keep theirs", () => {
    const rows = [row("a"), row("p"), kid("w2", "p"), row("b"), kid("w1", "p")];
    const fams = T.treeFamilies(rows, all(...rows));
    expect(keys(fams)).toEqual(["a", "p", "w2", "w1", "b"]);
    const p = fams.find((f: any) => f.key === "p");
    expect(p.count).toBe(2);
    expect([...p.depth.entries()]).toEqual([["p", 0], ["w2", 1], ["w1", 1]]);
  });
  test("a worker that needs you lifts its dispatcher to where the worker would be", () => {
    // List order is priority order: the blocked worker comes first, so the whole family does.
    const rows = [kid("w1", "p", { status: "blocked" }), row("a", { status: "working" }), row("p"), kid("w2", "p")];
    const fams = T.treeFamilies(rows, all(...rows));
    expect(keys(fams)).toEqual(["p", "w1", "w2", "a"]);
    expect(fams[0].lead.key).toBe("w1"); // the section goes by the most urgent row
  });
  test("workers of a dispatcher that isn't open sit together under one header per dispatcher", () => {
    const rows = [kid("q1", null, { status: "blocked" }), row("a"), kid("q2", null), kid("z1", null, { src: "Other" })];
    const fams = T.treeFamilies(rows, all(...rows));
    expect(fams.map((f: any) => f.key)).toEqual(["o:linux|gone dispatcher", "a", "o:linux|other"]);
    expect(fams[0].root).toBeNull();
    expect(fams[0].orphan).toMatchObject({ srcName: "Gone dispatcher", machine: "linux", miss: "closed" });
    expect(fams[0].count).toBe(2);
    expect(keys(fams)).toEqual(["q1", "q2", "a", "z1"]);
    // A link to a row that went away is an orphan too.
    const gone = [kid("w", "p-closed")];
    expect(T.treeFamilies(gone, all(...gone))[0].key).toBe("o:linux|disp");
  });
  test("workers of workers nest a level further", () => {
    const rows = [row("p"), kid("w", "p"), kid("ww", "w"), kid("w2", "p")];
    const f = T.treeFamilies(rows, all(...rows))[0];
    expect(keys([f])).toEqual(["p", "w", "ww", "w2"]);
    expect(f.depth.get("ww")).toBe(2);
    expect(f.count).toBe(3);
    expect(f.node.kids.map((n: any) => n.r.key)).toEqual(["w", "w2"]);
  });
  test("two sessions naming each other don't loop", () => {
    const a = row("a", { parent: { key: "b", srcName: "b" } }), b = row("b", { parent: { key: "a", srcName: "a" } });
    const fams = T.treeFamilies([a, b], all(a, b));
    expect(keys(fams)).toEqual(["b", "a"]);
  });
  test("folded: workers hide, except the ones to keep in sight", () => {
    const rows = [row("p"), kid("w1", "p"), kid("w2", "p", { status: "blocked" }), kid("w3", "p")];
    const keep = (r: any) => r.status === "blocked";
    const f = T.treeFamilies(rows, all(...rows), { p: true }, keep)[0];
    expect(f.closed).toBe(true);
    expect(keys([f])).toEqual(["p", "w2"]);
    expect(f.members.map((r: any) => r.key)).toEqual(["p", "w1", "w2", "w3"]);
    expect(f.count).toBe(3);
    // A worker deeper down that must stay keeps the worker above it.
    const deep = [row("p"), kid("w", "p"), kid("ww", "w", { status: "blocked" })];
    expect(keys(T.treeFamilies(deep, all(...deep), { p: true, w: true }, keep))).toEqual(["p", "w", "ww"]);
    // Orphan headers fold too.
    const o = [kid("q1", null), kid("q2", null)];
    expect(keys(T.treeFamilies(o, all(...o), { "o:linux|gone dispatcher": true }))).toEqual([]);
  });
  test("the layout signature moves with folds, nesting and order", () => {
    const rows = [row("p"), kid("w", "p")];
    const a = T.treeOrderSig(T.treeFamilies(rows, all(...rows)));
    expect(a).toBe("p(p@0,w@1)");
    expect(T.treeOrderSig(T.treeFamilies(rows, all(...rows), { p: true }))).toBe("px(p@0)");
    const flat = [row("p"), row("w")];
    expect(T.treeOrderSig(T.treeFamilies(flat, all(...flat)))).not.toBe(a);
  });
});

describe("context and summary", () => {
  test("a filter that matched only the worker brings its dispatcher along, marked", () => {
    const p = row("p"), w = kid("w", "p"), ww = kid("ww", "w");
    const { rows, ctx } = T.treeWithContext([ww], all(p, w, ww));
    expect(rows.map((r: any) => r.key)).toEqual(["ww", "w", "p"]);
    expect([...ctx]).toEqual(["w", "p"]);
    // Then the family still starts with the dispatcher.
    expect(keys(T.treeFamilies(rows, all(p, w, ww)))).toEqual(["p", "w", "ww"]);
    expect(T.treeWithContext([p, w], all(p, w)).ctx.size).toBe(0);
  });
  test("a dispatcher's line says how its workers are doing", () => {
    expect(T.treeSummary([row("a", { status: "working" }), row("b", { status: "done" }), row("c", { status: "done" })])).toBe("3 workers · 1 running · 2 done");
    expect(T.treeSummary([row("a", { status: "blocked" })])).toBe("1 worker · 1 waiting");
    expect(T.treeSummary([row("a"), row("b", { status: "empty" })])).toBe("2 workers · 2 idle");
  });
  test("only a live parent that isn't the row itself counts", () => {
    const p = row("p");
    expect(T.treeParent(kid("w", "p"), all(p))).toBe("p");
    expect(T.treeParent(kid("w", "x"), all(p))).toBeNull();
    expect(T.treeParent(row("p", { parent: { key: "p" } }), all(p))).toBeNull();
    expect(T.orphanKey(kid("w", null, { src: "Stage to QA" }))).toBe("o:linux|stage to qa");
  });
});

describe("projects grouping", () => {
  test("a worker in another repo's worktree goes where its dispatcher is; only the dispatcher names the branch", () => {
    const p = row("p", { branch: "main" }), w = kid("w", "p", { worktree: "server-PS1", branch: "PS1", projectRoot: "/x/server-PS1" });
    const head = (r: any) => (r === w ? p : r);
    const s = L.splitWorktrees("Conductor", [p, w], {}, head);
    expect(s.main.map((r: any) => r.key)).toEqual(["p", "w"]);
    expect(s.trees).toEqual([]);
    expect(s.branch).toBe("main");
    // Without a family, the worker's own worktree makes a sub-section, as before.
    expect(L.splitWorktrees("Conductor", [p, w]).trees.map((t: any) => t.name)).toEqual(["server-PS1"]);
  });
});
