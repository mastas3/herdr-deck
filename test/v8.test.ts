import { describe, expect, test } from "bun:test";
import { slashCommands } from "../src/slash";

describe("slash commands", () => {
  test("codex has /rename and /compact", async () => {
    const l = await slashCommands("codex", "/tmp");
    expect(l.find((c) => c.cmd === "/rename")?.hint).toBe("[name]");
    expect(l.some((c) => c.cmd === "/compact")).toBe(true);
  });
  test("opencode has built-ins and no duplicates", async () => {
    const l = await slashCommands("opencode", "/tmp");
    expect(l.some((c) => c.cmd === "/compact")).toBe(true);
    expect(new Set(l.map((c) => c.cmd)).size).toBe(l.length);
  });
  test("descriptions have no markdown noise", async () => {
    const l = await slashCommands("claude", "/tmp");
    for (const c of l) expect(c.desc ?? "").not.toMatch(/\*\*/);
  });
  test("unknown agents get nothing", async () => {
    expect(await slashCommands("shell", "/tmp")).toEqual([]);
  });
});

import { turnState } from "../src/codexapp";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("codex turn state", () => {
  const ev = (type: string, ts: string) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type } }) + "\n";
  const big = (n: number) => JSON.stringify({ timestamp: "2026-09-26T06:40:00Z", type: "response_item", payload: { type: "message", content: [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(n) }] } }) + "\n";
  test("finds a turn start buried under megabytes of output, then follows appends", async () => {
    const dir = mkdtempSync(`${tmpdir()}/deck-turn-`);
    try {
      const f = `${dir}/rollout.jsonl`;
      writeFileSync(f, ev("task_started", "2026-09-26T04:00:00Z") + ev("task_complete", "2026-09-26T04:10:00Z") + ev("task_started", "2026-09-26T06:38:00Z") + big(6 << 20) + big(3 << 20));
      const a = await turnState(f);
      expect(a.open).toBe(true);
      expect(a.startedAt).toBe(Date.parse("2026-09-26T06:38:00Z"));
      appendFileSync(f, big(1000) + ev("task_complete", "2026-09-26T07:00:00Z"));
      const b = await turnState(f);
      expect(b.open).toBe(false);
      expect(b.endedAt).toBe(Date.parse("2026-09-26T07:00:00Z"));
      appendFileSync(f, ev("task_started", "2026-09-26T07:05:00Z"));
      expect((await turnState(f)).open).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { promptFromTail } from "../src/decisions";
describe("terminal prompts", () => {
  test("Claude's trust prompt: two options, the real question, no links", () => {
    const p = promptFromTail([" Accessing workspace:", "", " /tmp/x", "", " Quick safety check: Is this a project you created or one you trust?", " (Like your own code, a well-known open source project, or work from your", " team). If not, take a moment to review what's in this folder first.", "", " Claude Code'll be able to read, edit, and execute files here.", "", " Security guide", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"]);
    expect(p.question).toBe("Quick safety check: Is this a project you created or one you trust?");
    expect(p.options.map((o) => o.title)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(p.options[1].keys).toEqual(["down", "enter"]);
  });
  test("numbered permission menu, duplicated on screen, uses the last copy", () => {
    const menu = ["│ Do you want to proceed? │", "│ ❯ 1. Yes │", "│   2. No │"];
    const p = promptFromTail([...menu, "", ...menu]);
    expect(p.options.map((o) => o.id)).toEqual(["1", "2"]);
    expect(p.question).toContain("Do you want to proceed?");
  });
});
