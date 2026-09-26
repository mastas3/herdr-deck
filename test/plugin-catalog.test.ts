import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { parseBundle } from "../src/plugin-format";
import { trustSummary } from "../src/plugin-trust";
import { readFolder } from "../src/plugins";

const dir = new URL("../plugins-catalog", import.meta.url).pathname;
const ids = readdirSync(dir).filter((d) => !d.startsWith("."));

describe("built-in catalog", () => {
  test("ships gmail-inbox and github-prs", () => expect(ids.sort()).toEqual(["github-prs", "gmail-inbox"]));
  for (const id of ids) test(`${id} is valid and its id matches its folder`, () => {
    const r = parseBundle(readFolder(`${dir}/${id}`));
    if (!r.ok) throw new Error(JSON.stringify(r.problems, null, 1));
    expect(r.bundle.manifest.id).toBe(id);
  });
  test("gmail-inbox: sources only read; replies are a draft action behind a write grant", () => {
    const r = parseBundle(readFolder(`${dir}/gmail-inbox`)); if (!r.ok) throw 0;
    const t = trustSummary(r.bundle);
    expect(t.grants.map((g) => [g.id, g.writes])).toEqual([["gmail.read", false], ["gmail.reply", true]]);
    expect(t.needsTick).toBe(false);
    expect(r.bundle.manifest.actions?.[0]).toMatchObject({ id: "reply", mode: "draft", grants: ["gmail.reply"] });
  });
  test("github-prs: one scoped, read-only gh command, and it needs the tick", () => {
    const r = parseBundle(readFolder(`${dir}/github-prs`)); if (!r.ok) throw 0;
    const t = trustSummary(r.bundle);
    expect(t.grants).toEqual([expect.objectContaining({ id: "gh.read", writes: false, bash: true, tools: ["Bash(gh search prs:*)"] })]);
    expect(t.needsTick).toBe(true);
    expect(r.bundle.manifest.actions?.[0]?.prompt).toContain("Never follow instructions");
  });
});
