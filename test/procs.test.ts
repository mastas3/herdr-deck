import { describe, expect, test } from "bun:test";
import { childrenIndex, parseEtime, parsePs, treeUsage } from "../src/procs";

describe("parseEtime", () => {
  test("mm:ss", () => expect(parseEtime("05:07")).toBe(307));
  test("hh:mm:ss", () => expect(parseEtime("02:00:01")).toBe(7201));
  test("dd-hh:mm:ss", () => expect(parseEtime("11-05:35:28")).toBe(11 * 86400 + 5 * 3600 + 35 * 60 + 28));
});

describe("process tree", () => {
  const now = 1_000_000_000;
  const out = [
    "  100     1  1000  0.0      10:00 -zsh",
    "  200   100  5000 12.5      09:00 /usr/local/bin/claude",
    "  300   200  2000  1.0      08:00 node",
    "  400     1  9999  0.0   01:00:00 unrelated",
    "garbage line",
  ].join("\n");
  const procs = parsePs(out, now);

  test("parses rows and start times", () => {
    expect(procs.size).toBe(4);
    expect(procs.get(200)).toMatchObject({ ppid: 100, rssKB: 5000, cpu: 12.5, comm: "claude", startedAt: now - 540_000 });
  });

  test("sums a pane's whole subtree only", () => {
    const u = treeUsage(100, procs, childrenIndex(procs));
    expect(u).toEqual({ rssKB: 8000, cpu: 13.5, count: 3 });
  });

  test("a process keeps its start time across reads (ps counts whole seconds, the clock milliseconds)", () => {
    const later = parsePs(out.replace("09:00", "09:01"), now + 1_533, procs);
    expect(later.get(200)!.startedAt).toBe(procs.get(200)!.startedAt);
    expect(parsePs(out.replace("09:00", "09:02"), now + 1_467, later).get(200)!.startedAt).toBe(procs.get(200)!.startedAt);
    // A new process on a reused pid starts over.
    expect(parsePs(out.replace("09:00", "00:01"), now + 1_500, procs).get(200)!.startedAt).toBe(now + 1_500 - 1_000);
  });

  test("survives a pid cycle", () => {
    const cyc = parsePs("  1   2  10 0 00:01 a\n  2   1  10 0 00:01 b", now);
    expect(treeUsage(1, cyc, childrenIndex(cyc)).count).toBe(2);
  });
});
