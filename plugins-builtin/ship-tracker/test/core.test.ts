// Ship tracker's pure logic: reading a wiki project page, last shipped / busy, the weekly line.
import { expect, test } from "bun:test";
import { parsePage, shipRows, weeklyLine } from "../ship-core";

const DAY = 86400_000, now = Date.parse("2026-09-28T09:00:00Z");

test("parsePage reads status, date and the Path line", () => {
  const p = parsePage("herdr-deck", "---\ntype: project\nstatus: active\ndate_updated: 2026-09-28\n---\n\nText.\n\n- **Path:** `~/Documents/Projects/herdr-deck/`. **Repo:** x\n");
  expect(p).toEqual({ slug: "herdr-deck", name: "herdr-deck", status: "active", updated: "2026-09-28", path: "~/Documents/Projects/herdr-deck" });
  expect(parsePage("x", "no frontmatter").status).toBe("unknown");
});

test("last shipped is the newest tag or a launched page; busy means many sessions and nothing shipped lately", () => {
  const rows = shipRows([
    { slug: "a", name: "a", status: "active", sessions14: 12, tag: "v1", tagAt: now - 40 * DAY },
    { slug: "b", name: "b", status: "launched", updated: "2026-09-25", sessions14: 9 },
    { slug: "c", name: "c", status: "active", sessions14: 7 },
    { slug: "d", name: "d", status: "stale", sessions14: 0 },
    { slug: "e", name: "e", status: "active", sessions14: 2, tag: "v3", tagAt: now - 2 * DAY },
  ], now);
  expect(rows.map((r) => [r.slug, r.busy, r.daysSince, r.shippedBy])).toEqual([
    ["c", true, undefined, undefined], ["a", true, 40, "tag"], ["d", false, undefined, undefined], ["b", false, 3, "launched"], ["e", false, 2, "tag"],
  ]);
});

test("the weekly line names what shipped and the busiest that didn't", () => {
  const rows = shipRows([
    { slug: "a", name: "Astra", status: "active", sessions14: 12, tagAt: now - 40 * DAY, tag: "v1" },
    { slug: "e", name: "Deck", status: "active", sessions14: 2, tag: "v3", tagAt: now - 2 * DAY },
    { slug: "c", name: "Atlas", status: "active", sessions14: 30 },
  ], now);
  expect(weeklyLine(rows, now)).toBe("Shipped this week: Deck. Busy but not shipping: Atlas (30 sessions, never shipped), Astra (12 sessions, 40 days since).");
  expect(weeklyLine([], now)).toBe("Nothing shipped this week.");
});
