// Private session folders stay out of the history index: the real indexer, run on a scratch HOME.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivatePath } from "../src/private-folder";

const home = mkdtempSync(`${tmpdir()}/deck-pvhist-`);
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("isPrivatePath knows the plugin's folders and their Claude project folders, nothing looser", () => {
  expect(isPrivatePath("/Users/x/.config/herdr-deck/private/deck-private-20260928abc123")).toBe(true);
  expect(isPrivatePath("/Users/x/.config/herdr-deck/private/deck-private-20260928abc123/sub")).toBe(true);
  expect(isPrivatePath("/Users/x/.claude/projects/-Users-x--config-herdr-deck-private-deck-private-20260928abc123/s.jsonl")).toBe(true);
  expect(isPrivatePath("/Users/x/Projects/deck-private-notes")).toBe(false);
  expect(isPrivatePath("/Users/x/Projects/my-deck-private-20260928abc123x")).toBe(false);
  expect(isPrivatePath(undefined)).toBe(false);
});

test("the indexer skips private sessions (Claude by path, Codex by cwd) and indexes the rest", async () => {
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  const pcwd = join(home, ".config/herdr-deck/private/deck-private-20260928abc123"), wcwd = join(home, "work/app");
  const claude = (cwd: string, id: string, text: string) => {
    const dir = join(home, ".claude/projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), line({ type: "user", cwd, timestamp: "2026-09-28T10:00:00Z", message: { content: text } }) + line({ type: "assistant", cwd, timestamp: "2026-09-28T10:01:00Z", message: { content: [{ type: "text", text: "ok" }] } }));
  };
  claude(pcwd, "11111111-0000-0000-0000-000000000001", "my bank statement");
  claude(wcwd, "11111111-0000-0000-0000-000000000002", "fix the dialer");
  const codexDir = join(home, ".codex/sessions/2026/09/28");
  mkdirSync(codexDir, { recursive: true });
  const cid = "019a0000-0000-7000-8000-000000000001";
  writeFileSync(join(codexDir, `rollout-2026-09-28T10-00-00-${cid}.jsonl`),
    line({ timestamp: "2026-09-28T10:00:00Z", type: "session_meta", payload: { id: cid, cwd: pcwd } }) +
    line({ timestamp: "2026-09-28T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "one-time code 4411" }] } }));
  const db = join(home, "history.db");
  const p = Bun.spawn([process.execPath, new URL("../src/history-worker.ts", import.meta.url).pathname], { env: { ...process.env, HOME: home, DECK_HISTORY_DB: db }, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  const d = new Database(db, { readonly: true });
  const rows = d.query("select agent, cwd, title, empty from sess order by agent, cwd").all() as any[];
  const hits = (w: string) => (d.query("select count(*) n from msg where msg match ?").get(w) as any).n;
  expect(rows).toEqual([{ agent: "claude", cwd: wcwd, title: "fix the dialer", empty: 0 }, { agent: "codex", cwd: "", title: "", empty: 1 }]);
  expect(hits("bank")).toBe(0);
  expect(hits("4411")).toBe(0);
  expect(hits("dialer")).toBe(1);
  d.close();
});
