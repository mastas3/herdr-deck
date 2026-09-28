import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createShareOwner, listening } from "../src/share";

const host = "stas.tail.ts.net";
function setup(up: Set<number>) {
  const file = `${mkdtempSync(`${tmpdir()}/deck-share-`)}/shares.json`;
  let t = 0;
  const offs: number[] = [];
  const owner = createShareOwner({ file, graceMs: 1000, isUp: async (p) => up.has(p), off: async (h) => { offs.push(h); }, now: () => t });
  return { file, owner, offs, tick: (ms: number) => { t += ms; } };
}

describe("the deck's own tailnet addresses", () => {
  test("turns one off only after its server has been gone for the grace period", async () => {
    const up = new Set([5173]);
    const { owner, offs, tick, file } = setup(up);
    owner.add(15173, 5173, "127.0.0.1");
    const served = new Map([[5173, `https://${host}:15173`]]);
    expect(await owner.prune(served)).toBe(false);
    up.delete(5173);
    expect(await owner.prune(served)).toBe(false); // first seen gone: the clock starts
    tick(999);
    expect(await owner.prune(served)).toBe(false);
    tick(1);
    expect(await owner.prune(served)).toBe(true);
    expect(offs).toEqual([15173]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  test("a server that comes back resets the clock", async () => {
    const up = new Set<number>();
    const { owner, offs, tick } = setup(up);
    owner.add(3000, 3000, "127.0.0.1");
    const served = new Map([[3000, `https://${host}:3000`]]);
    await owner.prune(served);
    tick(900);
    up.add(3000);
    await owner.prune(served);
    up.delete(3000);
    tick(900);
    expect(await owner.prune(served)).toBe(false);
    expect(offs).toEqual([]);
  });

  test("never touches addresses it didn't make, and forgets ones turned off elsewhere", async () => {
    const { owner, offs, tick } = setup(new Set());
    owner.add(8443, 4173, "127.0.0.1");
    const served = new Map([[9006, `https://${host}:9006`]]); // someone else's, dead; ours already gone
    await owner.prune(served);
    tick(10_000);
    expect(await owner.prune(served)).toBe(false);
    expect(offs).toEqual([]);
    expect(owner.list()).toEqual({});
  });

  test("keeps the record when turning it off fails, and tries again", async () => {
    const file = `${mkdtempSync(`${tmpdir()}/deck-share-`)}/shares.json`;
    let t = 0, fail = true;
    const owner = createShareOwner({ file, graceMs: 0, isUp: async () => false, off: async () => { if (fail) throw new Error("no"); }, now: () => t });
    owner.add(4000, 4000, "127.0.0.1");
    const served = new Map([[4000, `https://${host}:4000`]]);
    expect(await owner.prune(served)).toBe(false);
    expect(Object.keys(owner.list())).toEqual(["4000"]);
    fail = false;
    expect(await owner.prune(served)).toBe(true);
  });
});

test("listening tells an open port from a closed one", async () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  expect(await listening(s.port)).toBe(true);
  s.stop(true);
  expect(await listening(s.port)).toBe(false);
});
