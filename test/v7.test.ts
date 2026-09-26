import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extractChoices, promptFromTail } from "../src/decisions";
import { claimsDone, detectCheck } from "../src/verify";
import { fillTool, BUILTIN } from "../src/tools";

process.env.DECK_NO_HISTORY = "1";
const { ftsQuery } = await import("../src/history");

describe("extractChoices", () => {
  test("options after a question become choices, recommended marked", () => {
    const c = extractChoices("I found two ways.\n\nWhich should I do?\n(a) **Patch it** — quick fix\n(b) Rewrite the module (recommended)\n");
    expect(c?.question).toBe("Which should I do?");
    expect(c?.options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(c?.options[0].title).toBe("Patch it");
    expect(c?.options[1].rec).toBe(true);
    expect(c?.options[0].send).toBe("(a) Patch it");
  });
  test("a plain numbered list of findings is not a decision", () => {
    expect(extractChoices("Findings:\n1. The cache leaks\n2. Tests are slow\n\nAll fixed.")).toBeUndefined();
  });
  test("numbered list followed by 'pick one' is", () => {
    expect(extractChoices("Directions:\n1. Dark neon\n2. Editorial\n3. Playful\n\nPick one.")?.options.length).toBe(3);
  });
});

describe("promptFromTail", () => {
  test("numbered permission prompt answers with digits", () => {
    const p = promptFromTail(["Do you want to make this edit?", "❯ 1. Yes", "  2. Yes, allow all edits", "  3. No"]);
    expect(p.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(p.question).toContain("edit");
  });
  test("cursor menu answers with arrows + enter", () => {
    const p = promptFromTail(["Do you trust the files in this folder?", "❯ No, exit", "  Yes, I trust this folder", "Enter to confirm · Esc to cancel"]);
    expect(p.options.map((o) => [o.title, o.keys])).toEqual([["No, exit", ["enter"]], ["Yes, I trust this folder", ["down", "enter"]]]);
  });
  test("unknown prompt falls back to enter / esc", () => {
    expect(promptFromTail(["Press any key"]).options.map((o) => o.keys[0])).toEqual(["enter", "esc"]);
  });
});

describe("claimsDone", () => {
  test("claims", () => {
    expect(claimsDone("Implemented the parser. All tests pass (42/42).")).toBe(true);
    expect(claimsDone("Deployed to production and verified the page loads.")).toBe(true);
  });
  test("questions and plans are not claims", () => {
    expect(claimsDone("I could fix it by patching the cache. Should I go ahead?")).toBe(false);
    expect(claimsDone("Here is the plan: first read the code.")).toBe(false);
  });
});

describe("detectCheck", () => {
  test("bun project with typecheck and test", () => {
    const d = mkdtempSync(`${tmpdir()}/deck-chk-`);
    writeFileSync(`${d}/package.json`, JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit", dev: "vite" } }));
    writeFileSync(`${d}/bun.lock`, "");
    expect(detectCheck(d)).toBe("bun run typecheck && bun run test");
    rmSync(d, { recursive: true, force: true });
  });
  test("npm default test script is ignored", () => {
    const d = mkdtempSync(`${tmpdir()}/deck-chk-`);
    writeFileSync(`${d}/package.json`, JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectCheck(d)).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("history search query", () => {
  test("words become prefix terms, joined with AND, quotes escaped", () => {
    expect(ftsQuery("herdr deck")).toBe('"herdr"* AND "deck"*');
    expect(ftsQuery('say "hi" x')).toBe('"say"* AND "hi"*');
    expect(ftsQuery("a")).toBeUndefined();
  });
});

describe("tools", () => {
  test("templates fill project, title and a handoff path", () => {
    const t = BUILTIN.find((x) => x.id === "handoff-compact")!;
    const text = fillTool(t.prompt!, { project: "herdr-deck", title: "x", sessionId: "abcdef1234" });
    expect(text).toContain("/herdr-deck-");
    expect(text).toContain("abcdef12.md");
    expect(fillTool("{project} on {branch} {unknown}", { project: "p", branch: "b" })).toBe("p on b {unknown}");
  });
});

describe("closing questions", () => {
  test("a question inside the last paragraph makes it a question", async () => {
    const { buildDecision } = await import("../src/decisions");
    const row: any = { key: "k", status: "done", seen: false, lastActiveAt: 1, tail: [], project: "p", title: "t" };
    const d = await buildDecision(row, async () => ({ messages: [{ i: 0, role: "assistant", text: "Plan written.\n\nDoes this test plan look right? If so, I'll write the spec." }] as any }));
    expect(d?.kind).toBe("question");
    expect(d?.options.length).toBe(3);
  });
});
