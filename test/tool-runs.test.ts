import { describe, expect, test } from "bun:test";
import { createToolRuns } from "../src/http/run-tools";

// A tool run reports what it sent in your name, so the page can show each step as your message at once.
describe("tool runs report what they sent", () => {
  test("a sequence: step 1 in the result, step 2 in its notice", async () => {
    const row: any = { key: "k1", agent: "claude", status: "idle", title: "T", project: "p", cwd: "/tmp/p", sessionId: "abcdef12" };
    const rows = new Map([["k1", row]]);
    const sent: string[] = [], notices: any[] = [];
    const runs = createToolRuns({
      deck: { rows } as any, remotes: new Map(), selfId: "me", extraTools: () => [],
      sendText: async (_k, text) => { sent.push(text); row.status = "working"; setTimeout(() => (row.status = "idle"), 1600); },
      notice: (n) => notices.push(n),
    });
    const tool: any = { id: "seq", label: "Seq", kind: "sequence", prompt: "Write the note", then: "/compact Keep it short" };
    const results = await runs.runToolLocal(tool, ["k1"]);
    expect(results).toEqual([{ key: "k1", ok: true, text: "Write the note" }]);
    for (let i = 0; i < 40 && !notices.length; i++) await Bun.sleep(200);
    expect(notices[0]).toMatchObject({ key: "k1", ok: true, text: "/compact Keep it short" });
    expect(sent).toEqual(["Write the note", "/compact Keep it short"]);
  }, 15_000);
});
