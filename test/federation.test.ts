import { describe, expect, test } from "bun:test";
import { RemoteHost } from "../src/federation";
import type { Row } from "../src/deck";

const row = (o: Partial<Row> = {}): Row => ({
  key: "h/1", herdr: "h", workspaceId: "w", workspace: "W", tabId: "t", tab: "", tabNumber: 1, tabPanes: 1, paneId: "1", agent: "claude",
  status: "idle", focused: false, title: "t", cwd: "/p", project: "p", rssKB: 500_000, cpu: 1.5, procs: 4, tail: [],
  empty: false, stale: false, duplicate: false, approx: false, startedAt: 1_000_000, ...o,
});
function mirror() {
  const got: { patches: [string[], string[]][]; procs: any[]; graves: number } = { patches: [], procs: [], graves: 0 };
  const h = new RemoteHost({ id: "linux", label: "Linux", ssh: "unused" }, {
    patch: (u, r) => got.patches.push([u.map((x) => x.key), r]), procs: (u) => got.procs.push(u),
    graveyard: () => got.graves++, notice: () => {}, usage: () => {},
  });
  const recv = (event: string, data: any, id = "") => (h as any).receive(event, data, id);
  return { h, got, recv };
}
const state = (rows: Row[], seq = "b.10") => ({ seq, rows, summary: { herdr: [] }, graveyard: [] });

describe("hub mirror of a node", () => {
  test("the node's whole state comes through as a patch of what changed, not a whole state", async () => {
    const { h, got, recv } = mirror();
    await recv("full", state([row(), row({ key: "h/2" })]), "b.10");
    expect(h.online).toBe(true);
    expect(got.patches).toEqual([[["linux|h/1", "linux|h/2"], []]]);
    // Reconnected after a node restart: only the row that differs, and the one that went.
    await recv("full", state([row({ status: "working" })], "c.3"), "c.3");
    expect(got.patches[1]).toEqual([["linux|h/1"], ["linux|h/2"]]);
  });

  test("numbered events apply once, in order; a skipped one makes it reconnect", async () => {
    const { got, recv } = mirror();
    await recv("full", state([row()]), "b.10");
    await recv("patch", { upsert: [row({ status: "working" })], remove: [], summary: { herdr: [] } }, "b.11");
    await recv("patch", { upsert: [row({ status: "done" })], remove: [], summary: { herdr: [] } }, "b.11"); // replayed twice
    expect(got.patches.length).toBe(2);
    await expect(recv("patch", { upsert: [row({ status: "idle" })], remove: [], summary: { herdr: [] } }, "b.13")).rejects.toThrow("missed events");
    expect(got.patches.length).toBe(2);
  });

  test("an older node's jittering rows don't reach the hub's pages; real changes and readings do", async () => {
    const { h, got, recv } = mirror();
    await recv("full", state([row()]));
    await recv("patch", { upsert: [row({ startedAt: 1_000_021, rssKB: 500_100, cpu: 3 })], remove: [], summary: { herdr: [] } });
    expect(got.patches.length).toBe(1);
    expect(h.rows.get("linux|h/1")!.cpu).toBe(3); // the hub's own copy is current
    await recv("patch", { upsert: [row({ tail: ["new line"] })], remove: [], summary: { herdr: [] } });
    expect(got.patches[1]).toEqual([["linux|h/1"], []]);
  });

  test("a node's own readings are passed on under the hub's keys", async () => {
    const { h, got, recv } = mirror();
    await recv("full", state([row()]), "b.10");
    await recv("procs", { "h/1": [800_000, 9, 6], "h/gone": [1, 1, 1] }, "b.11");
    expect(got.procs).toEqual([{ "linux|h/1": [800_000, 9, 6] }]);
    expect(h.rows.get("linux|h/1")).toMatchObject({ rssKB: 800_000, cpu: 9, procs: 6 });
  });

  test("stale: it fetches the node's state and carries on from there", async () => {
    const { h, got, recv } = mirror();
    await recv("full", state([row()]), "b.10");
    const node = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new URL(req.url).pathname === "/api/state" ? Response.json(state([row({ title: "new" })], "c.7")) : new Response("no", { status: 404 }) });
    try {
      h.base = `http://127.0.0.1:${node.port}`;
      await recv("stale", { seq: "c.7" });
      expect(got.patches[1]).toEqual([["linux|h/1"], []]);
      await recv("patch", { upsert: [row({ title: "newer" })], remove: [], summary: { herdr: [] } }, "c.8");
      expect(got.patches[2]).toEqual([["linux|h/1"], []]);
    } finally { node.stop(true); }
  });

  test("going offline and coming back announce the machine only", async () => {
    const { h, got, recv } = mirror();
    await recv("full", state([row()]), "b.10");
    (h as any).setOffline("SSH tunnel closed");
    await recv("ready", { seq: "b.10" });
    expect(got.patches.slice(1)).toEqual([[[], []], [[], []]]);
    expect(h.online).toBe(true);
  });
});
