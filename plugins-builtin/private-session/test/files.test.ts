// Private session's file finding and deleting, in a scratch HOME: only the private session's own files go.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePlan, planFiles } from "../private-files";

const home = mkdtempSync(`${tmpdir()}/deck-pv-files-`);
afterAll(() => rmSync(home, { recursive: true, force: true }));
const put = (p: string, s = "x") => { mkdirSync(join(home, p, ".."), { recursive: true }); writeFileSync(join(home, p), s); };

test("finds exactly the private session's files, deletes only the confirmed ones, trims history lines", () => {
  const root = join(home, ".config/herdr-deck/private"), cwd = join(root, "deck-private-20260928abcd12"), other = join(home, "work/app");
  mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, "statement.pdf"), "bank");
  const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");
  const sid = "11111111-2222-3333-4444-555555555555", cid = "019a0000-aaaa-bbbb-cccc-dddddddddddd", keepId = "019a0000-aaaa-bbbb-cccc-eeeeeeeeeeee";
  put(`.claude/projects/${enc(cwd)}/${sid}.jsonl`, "secret");
  put(`.claude/projects/${enc(other)}/aaaaaaaa-2222-3333-4444-555555555555.jsonl`, "work");
  put(`.claude/file-history/${sid}/abc@v1`); put(`.claude/session-env/${sid}/env`); put(`.claude/todos/${sid}-agent-${sid}.json`);
  put(`.codex/sessions/2026/09/28/rollout-2026-09-28T10-00-00-${cid}.jsonl`, `{"type":"session_meta","payload":{"id":"${cid}","cwd":"${cwd}"}}\n{"x":1}`);
  put(`.codex/sessions/2026/09/28/rollout-2026-09-28T11-00-00-${keepId}.jsonl`, `{"type":"session_meta","payload":{"id":"${keepId}","cwd":"${other}"}}`);
  put(".claude/history.jsonl", [JSON.stringify({ display: "my IBAN is", project: cwd }), JSON.stringify({ display: "fix tests", project: other })].join("\n"));
  put(".codex/history.jsonl", [JSON.stringify({ session_id: cid, text: "code 4411" }), JSON.stringify({ session_id: keepId, text: "deploy" })].join("\n"));

  expect(() => planFiles({ home, cwd: other })).toThrow("Not a private");
  const plan = planFiles({ home, cwd });
  const rel = plan.files.map((f) => f.slice(home.length + 1)).sort();
  expect(rel).toEqual([
    `.claude/file-history/${sid}`, `.claude/projects/${enc(cwd)}`, `.claude/projects/${enc(cwd)}/${sid}.jsonl`, `.claude/session-env/${sid}`, `.claude/todos/${sid}-agent-${sid}.json`,
    `.codex/sessions/2026/09/28/rollout-2026-09-28T10-00-00-${cid}.jsonl`, `.config/herdr-deck/private/deck-private-20260928abcd12`,
  ]);
  expect(plan.lines.map((l) => [l.file.slice(home.length + 1), l.n])).toEqual([[".claude/history.jsonl", 1], [".codex/history.jsonl", 1]]);

  // Only what was confirmed: leave the Codex rollout out, and it stays.
  const pick = plan.files.filter((f) => !f.includes(".codex/"));
  const r = deletePlan({ home, cwd, root, files: [...pick, join(home, "work/app"), "/etc/hosts"], lines: true });
  expect(r.deleted.length).toBe(pick.length);
  expect(existsSync(cwd)).toBe(false);
  expect(existsSync(join(home, `.claude/projects/${enc(cwd)}`))).toBe(false);
  expect(existsSync(join(home, `.codex/sessions/2026/09/28/rollout-2026-09-28T10-00-00-${cid}.jsonl`))).toBe(true);
  expect(existsSync(join(home, `.claude/projects/${enc(other)}/aaaaaaaa-2222-3333-4444-555555555555.jsonl`))).toBe(true);
  expect(existsSync("/etc/hosts")).toBe(true);
  expect(r.lines).toBe(2);
  expect(readFileSync(join(home, ".claude/history.jsonl"), "utf8")).toBe(JSON.stringify({ display: "fix tests", project: other }));
  expect(readFileSync(join(home, ".codex/history.jsonl"), "utf8")).toBe(JSON.stringify({ session_id: keepId, text: "deploy" }));
});
