import { describe, expect, test } from "bun:test";
import { RowFeed, rowSig } from "../src/row-feed";
import type { Row } from "../src/deck";

const row = (o: Partial<Row> = {}): Row => ({
  key: "h/1", herdr: "h", workspaceId: "w", workspace: "W", tabId: "t", tab: "", tabNumber: 1, tabPanes: 1, paneId: "1", agent: "claude",
  status: "idle", focused: false, title: "fix the list", cwd: "/p", project: "p", rssKB: 500_000, cpu: 1.5, procs: 4, tail: [],
  empty: false, stale: false, duplicate: false, approx: false, startedAt: 1_000_000, ...o,
});

describe("row feed", () => {
  test("new rows go out whole, unchanged ones don't, gone ones are removed", () => {
    const f = new RowFeed();
    expect(f.diff([row(), row({ key: "h/2" })]).upsert.map((r) => r.key)).toEqual(["h/1", "h/2"]);
    expect(f.diff([row(), row({ key: "h/2" })])).toEqual({ upsert: [], remove: [] });
    expect(f.diff([row({ status: "working" })])).toMatchObject({ upsert: [{ key: "h/1", status: "working" }], remove: ["h/2"] });
  });

  test("memory, CPU, process counts and a start time wobbling by milliseconds don't resend a row", () => {
    const f = new RowFeed();
    f.diff([row()]);
    const again = row({ rssKB: 501_234, cpu: 7.2, procs: 5, startedAt: 1_000_033 });
    expect(f.diff([again]).upsert).toEqual([]);
    // It keeps the start time the page has.
    expect(again.startedAt).toBe(1_000_000);
    // A different process (restarted agent) is a real change.
    expect(f.diff([row({ startedAt: 1_060_000 })]).upsert).toHaveLength(1);
  });

  test("only top-level readings are left out of the signature", () => {
    const r = row({ ports: [{ port: 3000, addr: "*", cmd: "node" }], check: { cpu: 1 } });
    expect(rowSig(r)).not.toContain("rssKB");
    expect(rowSig(r)).toContain('"check":{"cpu":1}');
  });

  test("readings go out at most every 10 s, only when what the page prints moved, and all of them once a minute", () => {
    const f = new RowFeed();
    const t = 1_000_000;
    f.diff([row()]);
    expect(f.takeUsage([row({ rssKB: 900_000 })], t)).toEqual({ "h/1": [900_000, 1.5, 4] });
    expect(f.takeUsage([row({ rssKB: 950_000 })], t + 5_000)).toBeUndefined(); // too soon
    expect(f.takeUsage([row({ rssKB: 900_300 })], t + 10_000)).toBeUndefined(); // same MB
    expect(f.takeUsage([row({ rssKB: 900_300, cpu: 2 })], t + 20_000)).toEqual({ "h/1": [900_300, 2, 4] });
    expect(f.takeUsage([row({ rssKB: 900_500, cpu: 2 })], t + 30_000)).toBeUndefined();
    expect(f.takeUsage([row({ rssKB: 900_500, cpu: 2 })], t + 60_000)).toEqual({ "h/1": [900_500, 2, 4] });
  });

  test("a row not sent yet carries its readings in its upsert; one resent whole counts as sent", () => {
    const f = new RowFeed();
    expect(f.takeUsage([row()], 1)).toBeUndefined();
    f.diff([row()]);
    f.diff([row({ status: "working", rssKB: 2_000_000 })]);
    expect(f.takeUsage([row({ status: "working", rssKB: 2_000_000 })], 20_000)).toBeUndefined();
  });

  test("readings mirrored from a node count as sent", () => {
    const f = new RowFeed();
    f.diff([row()]);
    f.noteUsage("h/1", [700_000, 3, 4]);
    expect(f.takeUsage([row({ rssKB: 700_000, cpu: 3 })], 20_000)).toBeUndefined();
  });

  test("partial diffs (a mirrored patch) never remove rows", () => {
    const f = new RowFeed();
    f.diff([row(), row({ key: "h/2" })]);
    expect(f.diff([row({ title: "renamed" })], false)).toMatchObject({ remove: [] });
  });
});
