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

describe("transcript rewritten in place", () => {
  test("starts over instead of trusting stale offsets", async () => {
    const dir = mkdtempSync(`${tmpdir()}/deck-`);
    const path = `${dir}/r.jsonl`;
    const pad = "x".repeat(400);
    writeFileSync(path, line({ type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: "old ask " + pad } }) + line({ type: "user", timestamp: "2026-09-20T10:01:00Z", message: { content: "second old ask " + pad } }));
    expect((await claudeDetail(path)).asks).toBe(2);
    // Rewritten shorter-then-longer with different content: same size class, new bytes.
    writeFileSync(path, line({ type: "user", timestamp: "2026-09-21T10:00:00Z", message: { content: "new ask" } }) + line({ type: "user", timestamp: "2026-09-21T10:01:00Z", message: { content: "another new ask " + pad + pad } }));
    const d = await claudeDetail(path);
    expect(d.asks).toBe(2);
    expect(d.started).toBe("new ask");
  });
});

describe("a message Claude took in mid-turn", () => {
  test("shows as your message, between the steps it came between", async () => {
    const dir = mkdtempSync(`${tmpdir()}/deck-`);
    const path = `${dir}/q.jsonl`;
    const asst = (id: string, text: string, ts: string) => line({ type: "assistant", timestamp: ts, message: { id, content: [{ type: "text", text }] } });
    writeFileSync(path,
      line({ type: "user", timestamp: "2026-09-28T10:00:00Z", message: { content: "Pick a cache" } }) +
      asst("m1", "Which one?\n\n(a) Redis\n(b) SQLite", "2026-09-28T10:00:05Z") +
      line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-28T10:00:07Z", content: "(b) SQLite" }) +
      line({ type: "attachment", timestamp: "2026-09-28T10:00:08Z", attachment: { type: "queued_command", prompt: "(b) SQLite", commandMode: "prompt", timestamp: "2026-09-28T10:00:08Z" } }) +
      line({ type: "attachment", timestamp: "2026-09-28T10:00:08Z", attachment: { type: "queued_command", prompt: "<task-notification>done</task-notification>", isMeta: true } }) +
      asst("m2", "SQLite it is.", "2026-09-28T10:00:12Z"));
    const d = await claudeDetail(path);
    expect(d.messages.map((m) => `${m.role}:${m.text}`)).toEqual(["user:Pick a cache", "assistant:Which one?\n\n(a) Redis\n(b) SQLite", "user:(b) SQLite", "assistant:SQLite it is."]);
  });
});
