// Worker fan-out's pure logic: the form check, the worker footer, states from marker files, the merged message.
import { expect, test } from "bun:test";
import { checkSpec, mergeReports, workerPrompt, workerState, type Worker } from "../fanout-core";

test("checkSpec wants a brief, 1–12 workers with folders and known agents", () => {
  expect(() => checkSpec({ brief: "short", workers: [{ cwd: "/a" }] })).toThrow("brief");
  expect(() => checkSpec({ brief: "do the whole thing", workers: [] })).toThrow("at least one");
  expect(() => checkSpec({ brief: "do the whole thing", workers: [{ cwd: "" }] })).toThrow("needs a folder");
  expect(() => checkSpec({ brief: "do the whole thing", workers: [{ cwd: "/a", kind: "rm" }] })).toThrow("unknown agent");
  expect(() => checkSpec({ brief: "do the whole thing", workers: [{ cwd: "/a", model: "x; rm -rf" }] })).toThrow("model");
  expect(() => checkSpec({ brief: "do the whole thing", workers: Array(13).fill({ cwd: "/a" }) })).toThrow("At most 12");
  expect(checkSpec({ brief: "Audit every route\nmore", workers: [{ cwd: "/a", kind: "codex", model: "gpt-5.6" }] })).toEqual({ title: "Audit every route", brief: "Audit every route\nmore", workers: [{ cwd: "/a", kind: "codex", model: "gpt-5.6", label: undefined }] });
});

test("every worker is told where to write its report and markers", () => {
  const p = workerPrompt({ title: "T", brief: "Do X." }, { n: 2, cwd: "/repo", dir: "/d/w2" }, 3);
  expect(p).toStartWith("Do X.");
  expect(p).toContain("worker 2 of 3");
  expect(p).toContain("/d/w2/REPORT.md");
  expect(p).toContain("/d/w2/DONE");
  expect(p).toContain("/d/w2/FAILED");
});

test("state: markers first, then whether the session is still there", () => {
  const w: Worker = { n: 1, cwd: "/a", kind: "claude", dir: "/d", startedAt: 1000 };
  expect(workerState(w, { done: true, failed: false }, false, 10_000_000)).toBe("done");
  expect(workerState(w, { done: false, failed: true }, true)).toBe("failed");
  expect(workerState({ ...w, error: "no herdr" }, { done: false, failed: false }, false)).toBe("failed");
  expect(workerState(w, { done: false, failed: false }, true, 10_000_000)).toBe("running");
  expect(workerState(w, { done: false, failed: false }, false, 10_000_000)).toBe("stopped");
  expect(workerState(w, { done: false, failed: false }, false, 2000)).toBe("running"); // just started, not listed yet
});

test("merged reports: a tally, each report under its worker, long ones cut", () => {
  const w = (n: number): Worker => ({ n, cwd: `/r/w${n}`, kind: "codex", model: "m", dir: "/d" });
  const text = mergeReports({ id: "x", title: "Audit", brief: "", createdAt: 0, workers: [] }, [
    { w: w(1), state: "done", report: "All routes checked." },
    { w: w(2), state: "stopped" },
    { w: w(3), state: "done", report: "y".repeat(50) },
  ], 20);
  expect(text).toContain("(2 done, 1 stopped without a report)");
  expect(text).toContain("## Worker 1: w1 (codex m, /r/w1), done\n\nAll routes checked.");
  expect(text).toContain("## Worker 2: w2 (codex m, /r/w2), stopped without a report\n\n(no report written)");
  expect(text).toContain("y".repeat(20) + "\n… (cut here");
});
