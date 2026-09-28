// A project page's "Plan the next milestone" prompt gets comparable founders' tactics (src/library-strategy.ts).
import { describe, expect, test } from "bun:test";
import { findComparables, type Target } from "../../../src/library-strategy";
import { CARDS } from "../../../test/strategy-fixtures";
import { journeyComparables } from "../journey-comparables";

const find = (t: Target) => { const r = findComparables(CARDS, t); return r.comparables.length ? r : undefined; };

describe("project pages and comparables", () => {
  test("a project page's plan prompt gets the comparables' tactics for its next milestone", () => {
    const j = { project: "clip-studio", pitch: "podcast clips and transcripts for podcasters", milestones: [{ id: "a", title: "Offer page live", state: "unlocked" }, { id: "b", title: "First paying customer", state: "locked" }], next: ["b"] };
    const r = journeyComparables(j, find);
    expect(r.milestone).toBe("First paying customer");
    expect(r.kind).toBe("first");
    expect(r.text).toContain("how comparable founders got their first customers");
    expect(r.text).toContain("- Reddit: Posted before/after clips in r/podcasting — ClipPod (Nov 2025)");
    expect(journeyComparables({ ...j, next: [], milestones: [{ id: "c", title: "10 paying customers", state: "locked" }] }, find).text).toContain("grew past their first customers");
    expect(journeyComparables({ project: "x", milestones: [], next: [] }, () => undefined).text).toBe("");
  });
});
