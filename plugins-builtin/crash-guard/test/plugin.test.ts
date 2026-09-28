// The crash-guard plugin as the deck runs it: through the real plugin host, with scratch data, rows it's handed and a
// stub for the core's Reopen. Snapshots are taken on change, a crash is recorded only when it lasts two looks, the
// crash closes itself once its sessions are back, and turning the plugin off stops all of it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../../../src/plugin-host";

const root = mkdtempSync(`${tmpdir()}/deck-cg-plugin-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const row = (i: number, o: any = {}) => ({
  key: `default/p${i}`, machine: "mac", herdr: "default", workspaceId: "w1", workspace: "1", tabId: `t${i}`, tab: `tab${i}`, tabNumber: i, tabPanes: 1, paneId: `p${i}`,
  agent: "claude", status: "idle", focused: false, title: `session ${i}`, cwd: `/work/${i}`, project: `proj${i}`, rssKB: 0, cpu: 0, procs: 0, tail: [],
  empty: false, stale: false, duplicate: false, approx: false, sessionId: `s${i}`, resume: `claude --resume s${i}`, ...o,
});

describe("the crash-guard plugin", () => {
  test("snapshots, a crash after two looks, restore through Reopen, and the crash closing itself", async () => {
    const builtin = join(root, "builtin"), data = join(root, "data");
    mkdirSync(builtin, { recursive: true }); mkdirSync(data, { recursive: true });
    symlinkSync(new URL("..", import.meta.url).pathname, join(builtin, "crash-guard"));
    let rows: any[] = [1, 2, 3, 4, 5].map((i) => row(i));
    let online = true;
    const reopened: any[] = [], events: any[] = [], notices: any[] = [];
    const host = createPluginHost({
      builtinDir: builtin, root: data, dataDir: data, log: () => {},
      core: {
        rows: () => rows, push: {} as any, automations: () => undefined, decisions: () => [], isNode: () => false,
        machines: () => [{ id: "mac", label: "Mac", local: true, online: true, herdr: [{ name: "default", online }] }] as any,
        broadcast: (e, d) => events.push([e, d]), notice: (n) => notices.push(n),
        sessions: { start: async () => ({}), send: async () => {}, close: async () => ({}), screen: async () => "", keys: async () => {},
          reopen: async (o: any) => { reopened.push(o); return { key: `default/new${reopened.length}` }; } },
      } as any,
    });
    await host.start();
    expect(host.active()).toEqual(["crash-guard"]);
    expect(host.timers("crash-guard")).toBe(4);
    const post = async (body: any) => (await (await host.api(new Request("http://d/api/crash-guard", { method: "POST" }), new URL("http://d/api/crash-guard"), body))!.json()) as any;

    let st = await post({ op: "save" });
    expect(st.snapshots.length).toBe(1);
    expect(st.snapshots[0]).toMatchObject({ count: 5, agents: 5 });
    await post({ op: "save" }); // nothing changed: still one
    expect((await post({ op: "status" })).snapshots.length).toBe(1);

    // herdr goes away: one look isn't enough, the second records the crash.
    rows = []; online = false;
    expect((await post({ op: "save" })).crashes).toEqual([]);
    st = await post({ op: "save" });
    expect(st.crashes.length).toBe(1);
    expect(st.crashes[0]).toMatchObject({ reason: "restarted", lost: 5, total: 5 });
    expect(notices[0].message).toContain("5 sessions were open");

    // It comes back empty; that's a new snapshot, and the one before the crash is kept.
    rows = [row(9, { agent: "shell", empty: true, sessionId: undefined, resume: undefined })]; online = true;
    st = await post({ op: "save" });
    expect(st.snapshots.length).toBe(2);
    expect(st.crashes[0].lost).toBe(5);
    const snap = await post({ op: "snapshot", id: st.crashes[0].snapshotId });
    expect(snap.panes.map((p: any) => [p.key, p.open])).toEqual([1, 2, 3, 4, 5].map((i) => [`default/p${i}`, false]));

    // Restore three of them: each goes through the core's Reopen with where it was and how to resume it.
    const { job } = await post({ op: "restore", id: snap.id, keys: ["default/p1", "default/p2", "default/p3"] });
    expect(job.items.length).toBe(3);
    for (let i = 0; i < 100 && (await post({ op: "status" })).job?.running; i++) await Bun.sleep(50);
    expect(reopened.map((o) => [o.cwd, o.workspace, o.tab, o.resume, o.createWorkspace])).toEqual([1, 2, 3].map((i) => [`/work/${i}`, "1", `tab${i}`, `claude --resume s${i}`, true]));
    expect((await post({ op: "status" })).job.items.every((x: any) => x.state === "done")).toBe(true);

    // Three are back: two left to restore. All five back: the crash closes.
    rows = [...rows, row(11, { sessionId: "s1" }), row(12, { sessionId: "s2" }), row(13, { sessionId: "s3" })];
    expect((await post({ op: "save" })).crashes[0].lost).toBe(2);
    rows = [...rows, row(14, { sessionId: "s4" }), row(15, { sessionId: "s5" })];
    expect((await post({ op: "save" })).crashes).toEqual([]);
    expect(events.some(([e]) => e === "crash-guard")).toBe(true);
    expect(readdirSync(join(data, "crash-guard")).filter((f) => f.startsWith("snap-")).length).toBeGreaterThanOrEqual(2);

    await host.setEnabled("crash-guard", false);
    expect(host.timers("crash-guard")).toBe(0);
    expect(await host.api(new Request("http://d/api/crash-guard", { method: "POST" }), new URL("http://d/api/crash-guard"), { op: "status" })).toBeUndefined();
  }, 20_000);

  test("closing sessions from the deck, or a workspace by hand, is not a crash", async () => {
    const { lostPanes, looksLikeCrash } = await import("../snapshot");
    const before = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ ...row(i) } as any));
    const now = before.slice(0, 6);
    const lost = lostPanes(before, now, new Set(["s7", "s8"]));
    expect(lost.length).toBe(2);
    expect(looksLikeCrash({ lost: lost.length, before: 10, restarted: false, minLost: 3 })).toBe(false);
  });
});
