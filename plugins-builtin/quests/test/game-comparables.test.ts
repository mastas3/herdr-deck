// Today's quests lean on what worked for founders like the main quest (the Founder Library's comparables).
import { describe, expect, test } from "bun:test";
import { prompt as questPrompt, type QuestCtx } from "../game-quests";

describe("quests and comparables", () => {
  test("today's quests are asked to prefer what worked for comparables of the main quest", () => {
    const ctx: QuestCtx = { project: "clipstudio", pitch: "podcast clips", day: "2026-09-26", next: [], recent: [], leads: [], connections: [], done: [], comparables: "What worked for founders most like this (how comparable founders got their first customers; …):\n- Reddit: Posted before/after clips in r/podcasting — ClipPod (Nov 2025) https://…" };
    const p = questPrompt(ctx);
    expect(p).toContain("- Reddit: Posted before/after clips in r/podcasting — ClipPod");
    expect(p).toContain("Prefer these tactics when they fit this project's buyer");
    expect(questPrompt({ ...ctx, comparables: undefined })).not.toContain("Prefer these tactics");
  });
});
