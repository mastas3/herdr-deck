import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProfiles, claudeProfileEnv, claudeProfileForFile, claudeProjectDirs } from "../src/claude-profiles";
import { paneSignals } from "../src/pane-signals";
import { claudeWindow } from "../src/agents";
import { RowFeed } from "../src/row-feed";
const home = mkdtempSync("/tmp/deck-profiles-");
afterAll(() => rmSync(home, { recursive: true, force: true }));
for (const n of [".claude", ".claude-mac", ".claude-update-backup-2026", ".claude-switch"]) {
  mkdirSync(join(home, n, "projects/proj"), { recursive: true });
  writeFileSync(join(home, n, "settings.json"), "{}");
}
mkdirSync(join(home, ".claude-code-router"));
writeFileSync(join(home, ".claude-code-router/settings.json"), "{}");
symlinkSync(join(home, ".claude"), join(home, ".claude-link"));
test("discovers actual profiles, excludes backups and deduplicates symlinks", () => {
  const ps = claudeProfiles(home, {});
  expect(ps.map(p => p.dir)).toEqual([join(home, ".claude"), join(home, ".claude-mac")]);
  expect(claudeProjectDirs(ps)).toHaveLength(2);
  expect(claudeProfileEnv(ps[1].id, ps)).toEqual({ CLAUDE_CONFIG_DIR: ps[1].dir });
  expect(() => claudeProfileEnv("/tmp/unlisted", ps)).toThrow("no longer available");
  expect(claudeProfileEnv(undefined, ps)).toBeUndefined();
  expect(claudeProfileForFile(join(ps[1].dir, "projects/proj/session.jsonl"), ps)).toBe(ps[1].id);
  expect(claudeProfileForFile(join(ps[1].dir, "projects-other/session.jsonl"), ps)).toBeUndefined();
});
test("finds an alternate account transcript and preserves it when reopening", async () => {
  const id = "ebf676fd-b198-42a6-949c-c3f1f7e9bfb3", dir = join(home, ".claude-mac");
  writeFileSync(join(dir, `projects/proj/${id}.jsonl`), JSON.stringify({ type: "user", timestamp: "2026-10-03T10:00:00Z", message: { content: "profile fixture" } }) + "\n");
  const script = `import { claudeMeta, findClaudeFile, resumeCommand } from ${JSON.stringify(new URL("../src/agents.ts", import.meta.url).pathname)}; const m = await claudeMeta(${JSON.stringify(id)}); console.log(JSON.stringify({m, file:findClaudeFile(${JSON.stringify(id)}), resume:resumeCommand('claude',m.sessionId,m.claudeProfile),bad:findClaudeFile('../settings')}));`;
  const p = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", DECK_CLAUDE_CONFIG_DIRS: "" }, stdout: "pipe", stderr: "pipe" });
  const data = JSON.parse(await new Response(p.stdout).text());
  expect(await p.exited).toBe(0);
  expect(data.m.claudeProfile).toBe(dir);
  expect(data.m.firstPrompt).toBe("profile fixture");
  expect(data.resume).toContain(`CLAUDE_CONFIG_DIR='${dir}'`);
  expect(data.bad).toBeUndefined();
});
test("only public display signals survive, and live changes and clears produce SSE patches", () => {
  expect(paneSignals({ ctx: "\x1b[31mctx 28%\x1b[0m", cache: "cache 30m", stall: { secret: "hidden" }, api_key: "secret" })).toEqual({ ctx: "ctx 28%", cache: "cache 30m" });
  expect(paneSignals({ ctx: "" })).toBeUndefined();
  const feed = new RowFeed(), row: any = { key: "test", signals: paneSignals({ ctx: "ctx 28%" }) };
  expect(feed.diff([row]).upsert).toHaveLength(1);
  expect(feed.diff([{ ...row }]).upsert).toHaveLength(0);
  expect(feed.diff([{ ...row, signals: paneSignals({ ctx: "ctx 29%" }) }]).upsert).toHaveLength(1);
  expect(feed.diff([{ ...row, signals: undefined }]).upsert).toHaveLength(1);
});

test("context windows never borrow a different account’s model settings", () => {
  const a = join(home, ".claude"), b = join(home, ".claude-mac");
  writeFileSync(join(a, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
  writeFileSync(join(b, "settings.json"), JSON.stringify({ model: "sonnet" }));
  expect(claudeWindow("test-window", "claude-opus-5-5", home, 1000, a)).toBe(1_000_000);
  expect(claudeWindow("test-window", "claude-opus-5-5", home, 1000, b)).toBeUndefined();
});
