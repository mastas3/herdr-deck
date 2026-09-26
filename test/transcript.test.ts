import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeDetail, claudeImage } from "../src/transcript";
import { briefPrompt, parseBrief } from "../src/brief";

const line = (o: object) => JSON.stringify(o) + "\n";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("Claude transcript detail", () => {
  const dir = mkdtempSync(`${tmpdir()}/deck-`);
  const path = `${dir}/s.jsonl`;
  writeFileSync(
    path,
    line({ type: "permission-mode" }) +
      line({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: "Build a dashboard" } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:01:00Z", message: { content: [{ type: "text", text: "Planning it." }] } }) +
      line({ type: "user", timestamp: "2026-09-20T10:02:00Z", message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } }] }] } }) +
      line({ type: "assistant", timestamp: "2026-09-20T10:03:00Z", message: { content: [{ type: "text", text: "Built it." }] } }) +
      line({ type: "system", subtype: "turn_duration", durationMs: 60000 }),
  );

  test("builds turns, images and the start", async () => {
    const d = await claudeDetail(path);
    expect(d.asks).toBe(1);
    expect(d.started).toBe("Build a dashboard");
    expect(d.turns[0]).toMatchObject({ ask: "Build a dashboard", reply: "Built it." });
    expect(d.images).toHaveLength(1);
    expect(d.images[0].source).toBe("viewed");
    expect(d.workMs).toBe(60000);
  });

  test("reads only appended bytes on the next call", async () => {
    appendFileSync(
      path,
      line({ type: "user", timestamp: "2026-09-21T09:00:00Z", message: { content: "Add a terminal" } }) +
        line({ type: "system", subtype: "away_summary", content: "Dashboard done; terminal next.", timestamp: "2026-09-21T09:05:00Z" }),
    );
    const d = await claudeDetail(path);
    expect(d.asks).toBe(2);
    expect(d.turns[1].ask).toBe("Add a terminal");
    expect(d.recap?.text).toBe("Dashboard done; terminal next.");
  });

  test("serves an image block back from its line offset", async () => {
    const d = await claudeDetail(path);
    const img = await claudeImage(path, d.images[0].id);
    expect(img?.type).toBe("image/png");
    expect(img?.data.length).toBeGreaterThan(50);
  });
});

describe("brief", () => {
  test("parses the three labelled lines, tolerating markdown bold", () => {
    expect(parseBrief("ABOUT: A dashboard.\n**STARTED:** You asked.\nNOW: Done.")).toEqual({ about: "A dashboard.", started: "You asked.", now: "Done." });
  });
  test("prompt carries the first ask and the latest reply", () => {
    const p = briefPrompt("T", "proj", { started: "first ask", turns: [{ ask: "a", images: [] }, { ask: "b", reply: "final reply", images: [] }], images: [], compactions: 0, asks: 2 });
    expect(p).toContain("first ask");
    expect(p).toContain("final reply");
    expect(p).toContain("ABOUT:");
  });
});
