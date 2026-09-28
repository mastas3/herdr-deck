// The report-back plugin through the real plugin host: its card in the page's state (only for sessions still there),
// dismissing it, the "Ask for a report" tool, the digest section, the other machines' cards on the hub, and turning it
// off. Building a card from a real transcript is covered by report.test.ts and the end-to-end run.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-rb-plugin-`);
afterAll(() => { rmSync(root, { recursive: true, force: true }); delete process.env.DECK_DEV; });

describe("the report-back plugin", () => {
  test("cards, dismiss, the tool, the digest, remote cards, and off", async () => {
    const builtin = join(root, "builtin"), data = join(root, "data");
    mkdirSync(builtin, { recursive: true }); mkdirSync(data, { recursive: true });
    symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "report-back"));
    process.env.DECK_DEV = "1";
    const rows: any[] = [{ key: "default/p1", machine: "mac", agent: "claude", status: "done", project: "app", title: "t" }, { key: "linux|default/p9", machine: "linux", agent: "codex", status: "done" }];
    const events: any[] = [];
    const remote = { online: true, conf: { id: "linux" }, post: async () => ({ status: 200, data: { reports: [{ key: "default/p9", sig: "a", at: Date.now(), project: "api", summary: "Fixed the queue", checks: [{ cmd: "go test", ok: true }], files: [], fileCount: 2 }] } }) };
    const host = createPluginHost({
      builtinDir: builtin, root: data, dataDir: data, log: () => {},
      core: {
        rows: () => rows, push: {} as any, automations: () => undefined, decisions: () => [], isNode: () => false, checks: () => new Map(),
        machines: () => [{ id: "mac", label: "Mac", local: true, online: true }] as any,
        broadcast: (e, d) => events.push([e, d]), notice: () => {},
        sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {}, reopen: async () => ({}) },
      } as any,
    });
    host.provideCore("remotes", { get: () => remote, all: () => [remote] });
    await host.start();
    expect(host.active()).toEqual(["report-back"]);
    const post = async (body: any) => (await (await host.api(new Request("http://d/api/report-back", { method: "POST" }), new URL("http://d/api/report-back"), body))!.json()) as any;

    await post({ op: "dev-report", report: { key: "default/p1", project: "app", summary: "Added retries", fileCount: 2, files: ["a", "b"], checks: [{ cmd: "bun test", ok: true }] } });
    await post({ op: "dev-report", report: { key: "default/gone", project: "old", summary: "Old" } });
    expect(events.at(-1)[0]).toBe("report-back");
    const state = () => host.state().reports as any[];
    expect(state().map((r) => [r.key, r.dismissed])).toEqual([["default/p1", false]]); // the gone session's card isn't sent

    await Bun.sleep(2100); // the first look at the other machines
    expect(state().map((r) => r.key)).toEqual(["default/p1", "linux|default/p9"]);
    await post({ op: "dismiss", key: "default/p1", at: Date.now() });
    expect(state().find((r) => r.key === "default/p1").dismissed).toBe(true);

    const tool = host.contributions("tools.entries")[0] as any;
    expect([tool.id, tool.kind, tool.label]).toEqual(["report-back", "prompt", "Ask for a report"]);
    expect(tool.prompt).toContain("REPORT.md");
    const digest = host.contributions("digest.lines")[0] as any;
    const lines = await digest.lines();
    expect(lines[0]).toBe("3 sessions finished · 4 files changed · checks passed in 2");
    expect(lines).toContain("api: Fixed the queue (2 files · tests pass)");

    await host.setEnabled("report-back", false);
    expect(host.timers("report-back")).toBe(0);
    expect(host.contributions("tools.entries")).toEqual([]);
  }, 15_000);
});
