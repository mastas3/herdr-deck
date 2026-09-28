// Dual review's pure logic: ranges, reading findings files, matching the two lists, the message sent back.
import { describe, expect, test } from "bun:test";
import { composeMessage, likeness, matchFindings, parseFindings, parseRange, reviewPrompt, type Finding } from "../review-match";

const f = (file: string, line: number | undefined, title: string, severity: Finding["severity"] = "medium", detail = ""): Finding => ({ file, line, severity, title, detail });

describe("parseRange", () => {
  test("blank, a base ref, and two-dot / three-dot ranges", () => {
    expect(parseRange("")).toMatchObject({ ok: true, diff: ["diff", "HEAD"] });
    expect(parseRange("main")).toMatchObject({ ok: true, diff: ["diff", "main...HEAD"] });
    expect(parseRange("v1.2..HEAD")).toMatchObject({ ok: true, diff: ["diff", "v1.2..HEAD"] });
    expect(parseRange("origin/main...feat/x")).toMatchObject({ ok: true, diff: ["diff", "origin/main...feat/x"] });
  });
  test("refuses flags and shell text", () => {
    expect(parseRange("--output=/etc/passwd").ok).toBe(false);
    expect(parseRange("main; rm -rf /").ok).toBe(false);
    expect(parseRange("a..-b").ok).toBe(false);
  });
});

describe("parseFindings", () => {
  test("JSON as asked, with the severity words agents use", () => {
    const got = parseFindings(JSON.stringify({ findings: [{ file: "./src/a.ts", line: 12, endLine: 14, severity: "critical", title: "Null deref", detail: "x" }, { path: "b/src/b.ts:40-42", priority: "nit", summary: "Typo" }] }))!;
    expect(got).toEqual([
      { file: "src/a.ts", line: 12, endLine: 14, severity: "high", title: "Null deref", detail: "x" },
      { file: "src/b.ts", line: 40, endLine: 42, severity: "low", title: "Typo", detail: "" },
    ]);
  });
  test("JSON inside prose and fences, and a markdown list", () => {
    expect(parseFindings('Here you go:\n```json\n{"findings":[{"file":"a.ts","title":"T",}]}\n```')?.[0]).toMatchObject({ file: "a.ts", title: "T" });
    expect(parseFindings("- [high] src/x.ts:9 — leaks the token\n- src/y.py: slow loop")).toEqual([
      { file: "src/x.ts", line: 9, endLine: undefined, severity: "high", title: "leaks the token", detail: "" },
      { file: "src/y.py", line: undefined, endLine: undefined, severity: "medium", title: "slow loop", detail: "" },
    ]);
  });
  test("nothing readable yet is undefined, an empty list is []", () => {
    expect(parseFindings("")).toBeUndefined();
    expect(parseFindings("still thinking")).toBeUndefined();
    expect(parseFindings('{"findings":[]}')).toEqual([]);
  });
});

describe("matching", () => {
  test("same file, close lines and shared words match; other files never do", () => {
    const a = f("src/pay.ts", 40, "Retry loop never stops when the charge fails");
    expect(likeness(a, f("src/pay.ts", 43, "Infinite retry when charge fails"))).toBeGreaterThan(0.5);
    expect(likeness(a, f("src/other.ts", 40, "Retry loop never stops when the charge fails"))).toBe(0);
    expect(likeness(a, f("src/pay.ts", 400, "Unused import"))).toBe(0);
  });
  test("without line numbers the words must agree", () => {
    expect(likeness(f("a.ts", undefined, "SQL injection in search query builder"), f("a.ts", undefined, "search query builder allows SQL injection"))).toBeGreaterThan(0.3);
    expect(likeness(f("a.ts", undefined, "SQL injection"), f("a.ts", undefined, "Missing test for dates"))).toBe(0);
  });
  test("groups: agreements first, each finding used once, the rest per side", () => {
    const claude = [f("a.ts", 10, "token logged in plain text", "high"), f("b.ts", 5, "off by one in page count", "low")];
    const codex = [f("a.ts", 11, "access token is written to the log", "medium"), f("c.ts", 1, "race when two saves overlap", "high")];
    const g = matchFindings(claude, codex);
    expect(g.map((x) => x.status)).toEqual(["agree", "codex", "claude"]);
    expect(g[0].claude?.file).toBe("a.ts");
    expect(g[0].codex?.line).toBe(11);
  });
  test("the message names who found what and the higher severity", () => {
    const g = matchFindings([f("a.ts", 10, "token logged", "low", "Remove it")], [f("a.ts", 10, "token logged", "high", "Scrub it")]);
    const msg = composeMessage(g, { words: "the uncommitted changes" });
    expect(msg).toContain("1. [both found, high] a.ts:10: token logged");
    expect(msg).toContain("Claude: Remove it");
    expect(msg).toContain("Codex: Scrub it");
  });
});

test("the prompt says where to write and in which shape, and not to edit", () => {
  const p = reviewPrompt({ side: "codex", cwd: "/r", words: "the changes", file: "/d/codex.json" });
  expect(p).toContain("/d/codex.json");
  expect(p).toContain('"reviewer":"codex"');
  expect(p).toContain("Do not change any file");
});
