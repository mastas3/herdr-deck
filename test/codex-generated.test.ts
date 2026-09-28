import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCodexGenerated, readCodexGenerated } from "../src/codex-generated";
import type { Detail } from "../src/transcript";

const home = mkdtempSync(join(tmpdir(), "deck-codex-generated-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const source = "source-task", child = "child-task", cutoff = 1_800_000_000_000;
function image(task: string, name: string, at: number, content = "image data") {
  const dir = join(home, "generated_images", task);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content); utimesSync(path, at / 1000, at / 1000);
  return path;
}
function detail(): Detail {
  return {
    gen: 1, turns: [], compactions: 0, asks: 1, touch: new Map(),
    images: [{ id: "x:12:0", source: "pasted" }],
    messages: [
      { i: 0, role: "assistant", at: cutoff - 5000, text: "Inherited", codexSourceId: source, images: ["x:12:0"] },
      { i: 1, role: "assistant", at: cutoff - 5000, text: "Different ancestor", codexSourceId: "other-task" },
      { i: 2, role: "assistant", at: cutoff - 5000, text: "Child with an older timestamp" },
    ],
  };
}

describe("generated images in Codex fork history", () => {
  test("inherits only files at the validated cutoff and attaches to their source messages", async () => {
    image(source, "inherited.png", cutoff - 1000);
    image(source, "at-boundary.png", cutoff);
    image(source, "later.png", cutoff + 1000);
    const d = detail(), ancestors = [{ threadId: source, lastAt: cutoff }];
    attachCodexGenerated(d, child, ancestors, home);
    expect(d.images.map((i) => i.id).sort()).toEqual(["g:source-task:at-boundary.png", "g:source-task:inherited.png", "x:12:0"]);
    expect(d.messages[0].images).toContain("g:source-task:inherited.png");
    expect(d.messages[1].images).toBeUndefined();
    expect(d.messages[2].images).toBeUndefined();
    expect((await readCodexGenerated(child, "g:source-task:inherited.png", ancestors, home))?.type).toBe("image/png");
    expect(await readCodexGenerated(child, "g:source-task:later.png", ancestors, home)).toBeUndefined();
  });
  test("keeps current task image IDs compatible and does not duplicate attachments", async () => {
    image(child, "own.png", cutoff + 2000);
    const d = detail();
    attachCodexGenerated(d, child, [], home); attachCodexGenerated(d, child, [], home);
    expect(d.images.filter((i) => i.id === "g:own.png")).toHaveLength(1);
    expect(d.messages[2].images).toEqual(["g:own.png"]);
    expect(new TextDecoder().decode((await readCodexGenerated(child, "g:own.png", [], home))?.data)).toBe("image data");
  });
  test("cannot read unrelated tasks, traversal, invalid IDs, or missing timestamp bounds", async () => {
    for (const id of ["g:source-task:inherited.png", "g:../source-task:inherited.png", "g:source-task:../inherited.png", "g:own.png:extra:part", "g:child-task:own.png"]) {
      expect(await readCodexGenerated(child, id, [], home)).toBeUndefined();
    }
    for (const lastAt of [undefined, NaN, Infinity, -1]) {
      expect(await readCodexGenerated(child, "g:source-task:inherited.png", [{ threadId: source, lastAt }], home)).toBeUndefined();
    }
  });
  test("removes inherited files if their content is replaced after the fork boundary", async () => {
    const d = detail(), ancestors = [{ threadId: source, lastAt: cutoff }];
    image(source, "replaced.png", cutoff - 500);
    attachCodexGenerated(d, child, ancestors, home);
    expect(d.images.some((i) => i.id === "g:source-task:replaced.png")).toBe(true);
    image(source, "replaced.png", cutoff + 500, "new content");
    attachCodexGenerated(d, child, ancestors, home);
    expect(d.images.some((i) => i.id === "g:source-task:replaced.png")).toBe(false);
    expect(d.messages[0].images).not.toContain("g:source-task:replaced.png");
    expect(await readCodexGenerated(child, "g:source-task:replaced.png", ancestors, home)).toBeUndefined();
  });
  test("uses the narrower cutoff for duplicate ancestor descriptors and removes lost ancestry", async () => {
    const d = detail();
    const ancestors = [{ threadId: source, lastAt: cutoff + 10_000 }, { threadId: source, lastAt: cutoff }];
    attachCodexGenerated(d, child, ancestors, home);
    expect(d.images.some((i) => i.id === "g:source-task:later.png")).toBe(false);
    expect(await readCodexGenerated(child, "g:source-task:later.png", ancestors, home)).toBeUndefined();
    attachCodexGenerated(d, child, [], home);
    expect(d.images.some((i) => i.id.startsWith("g:source-task:"))).toBe(false);
    expect(d.images.some((i) => i.id === "x:12:0")).toBe(true);
  });
});
