import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openIdeaArchive } from "../idea-archive";

const dir = mkdtempSync(`${tmpdir()}/deck-archive-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("ideas are kept for good, keep their first-seen time, and remember the critic's verdict", () => {
  const a = openIdeaArchive(`${dir}/ideas.db`);
  a.put({ id: "x1", title: "Clip Courier", source: "feed", row: "money" }, 1000);
  a.put({ id: "x2", title: "Weak idea", source: "feed" }, 2000);
  a.put({ id: "x1", title: "Clip Courier v2", source: "feed" }, 3000);
  a.score("x1", 7, false);
  a.score("x2", 3, true);
  const kept = a.list();
  expect(kept.map((i) => i.id)).toEqual(["x1"]);
  expect(kept[0]).toMatchObject({ title: "Clip Courier v2", score: 7, row: "money", createdAt: 1000 });
  expect(a.list({ all: true }).map((i) => i.id).sort()).toEqual(["x1", "x2"]);
  expect(a.count()).toEqual({ total: 2, dropped: 1 });
  a.close();
  const again = openIdeaArchive(`${dir}/ideas.db`);
  expect(again.count().total).toBe(2);
  again.close();
});
