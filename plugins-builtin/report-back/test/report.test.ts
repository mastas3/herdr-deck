import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeDetail } from "../../../src/transcript";
import { addNumstat, gitDelta } from "../git";
import { chipText, lastTurn, readTurn, summaryLine, verdict } from "../report";
import { claudeTranscript } from "./fixture";

const dir = mkdtempSync(`${tmpdir()}/deck-rb-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the one-line summary", () => {
  test("a heading wins; generic headings are skipped", () => {
    expect(summaryLine("## Added retries to the fetch helper\n\nThree tries.")).toBe("Added retries to the fetch helper");
    expect(summaryLine("## Summary\n\nFixed the **login** bug in `auth.ts`. Also cleaned up.")).toBe("Fixed the login bug in auth.ts.");
  });
  test("else the first sentence, two when the first is just \"Done.\"", () => {
    expect(summaryLine("Done. The deploy script now waits for the health check.\n\n- more")).toBe("Done. The deploy script now waits for the health check.");
    expect(summaryLine("I moved the parser into its own file and added tests for it. Next I would…")).toBe("I moved the parser into its own file and added tests for it.");
    expect(summaryLine("```ts\ncode\n```\n- **Renamed** the flag")).toBe("Renamed the flag");
  });
  test("long lines are cut at a word", () => {
    const s = summaryLine("word ".repeat(80));
    expect(s.length).toBeLessThanOrEqual(140);
    expect(s.endsWith("…")).toBe(true);
    expect(summaryLine(undefined)).toBe("");
  });
});

describe("reading the last turn from a real transcript", () => {
  test("files edited, test runs (a failure fixed later passes), and its summary", async () => {
    const f = `${dir}/s1.jsonl`;
    writeFileSync(f, claudeTranscript({ id: "s1", cwd: "/Users/me/app", t0: Date.parse("2026-09-28T10:00:00Z") }));
    const d = await claudeDetail(f);
    const turn = lastTurn(d.messages);
    expect(turn[0].role).toBe("tool");
    const { files, checks, final } = readTurn(turn);
    expect(files).toEqual(["/Users/me/app/src/fetch.ts", "/Users/me/app/test/fetch.test.ts"]);
    expect(checks).toEqual([{ cmd: "Run the tests", ok: false }, { cmd: "Run the tests", ok: true }]);
    expect(verdict(checks)).toBe("pass");
    expect(summaryLine(final)).toBe("Added retries to the fetch helper");
    expect(chipText({ fileCount: files.length, checks })).toBe("Done · 2 files · tests pass");
  });
  test("a turn that ends on failing tests says so", async () => {
    const f = `${dir}/s2.jsonl`;
    writeFileSync(f, claudeTranscript({ id: "s2", cwd: "/Users/me/app", t0: Date.now() - 600_000, failTests: true }));
    const { checks } = readTurn(lastTurn((await claudeDetail(f)).messages));
    expect(verdict(checks)).toBe("fail");
    expect(chipText({ fileCount: 0, checks: [], proof: { state: "pass" } })).toBe("Done · no file changes · checks pass");
    expect(chipText({ fileCount: 1, checks: [], git: { files: 4, add: 1, del: 1, commits: 0 } })).toBe("Done · 4 files");
  });
  test("a message sent while it worked stays in the same turn", () => {
    const m = (i: number, role: any, at: number) => ({ i, role, at, text: "x" });
    const msgs = [m(0, "user", 100), m(1, "tool", 200), m(2, "user", 300), m(3, "assistant", 400)] as any;
    expect(lastTurn(msgs).map((x: any) => x.i)).toEqual([1, 2, 3]);
    const next = [m(0, "user", 100), m(1, "assistant", 200), m(2, "user", 300), m(3, "assistant", 400)] as any;
    expect(lastTurn(next).map((x: any) => x.i)).toEqual([3]);
  });
});

describe("git", () => {
  test("numstat sums, binary files count as files", () => {
    const t = { files: new Set<string>(), add: 0, del: 0 };
    addNumstat("12\t3\tsrc/a.ts\n-\t-\timg.png\n\n@@abc\n1\t0\tsrc/a.ts", t);
    expect([t.files.size, t.add, t.del]).toEqual([2, 13, 3]);
  });
  test("a repo: uncommitted lines plus commits since the turn began; not a repo: nothing", async () => {
    const repo = `${dir}/repo`;
    const who = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const run = (a: string[], env: object = {}) => Bun.spawnSync(["git", "-C", repo, ...a], { env: { ...process.env, ...who, ...env } });
    Bun.spawnSync(["git", "init", "-q", repo]);
    writeFileSync(`${repo}/a.txt`, "1\n2\n");
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    run(["add", "."]); run(["commit", "-qm", "first"], { GIT_AUTHOR_DATE: hourAgo, GIT_COMMITTER_DATE: hourAgo });
    const since = Date.now() - 60_000;
    writeFileSync(`${repo}/b.txt`, "x\n"); run(["add", "."]); run(["commit", "-qm", "second"]);
    writeFileSync(`${repo}/a.txt`, "1\n3\n4\n");
    expect(await gitDelta(repo, since)).toEqual({ files: 2, add: 3, del: 1, commits: 1 });
    expect(await gitDelta(dir)).toBeUndefined();
  });
});
