// Scratch repos and transcripts for the Files tests. Everything lives under /tmp (the file viewer's rules allow your
// home or /tmp only, and the OS temp folder on a Mac is neither). The transcripts are written here, shaped like
// Claude Code's JSONL and Codex's rollouts, never copied from real sessions.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function scratch(prefix: string) {
  const dir = mkdtempSync(`/tmp/deck-files-${prefix}-`);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export function sh(cwd: string, ...args: string[]) { return shAt(cwd, undefined, ...args); }
/** git with the commit dated `iso` (the "since this session started" tests pin the session's start between commits). */
export function shAt(cwd: string, iso: string | undefined, ...args: string[]) {
  const env = { ...process.env, ...(iso ? { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } : {}) };
  const p = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

export function put(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A repo with one commit, then: a changed file, a new file, a deleted file, a renamed file, ignored build output, a
 *  secret, and symlinks (one inside, one out of the repo). Returns the repo's path. */
export function makeRepo(base: string, outside: string) {
  const root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  sh(root, "init", "-q", "-b", "main");
  put(root, ".gitignore", "node_modules/\ndist/\n");
  put(root, "src/app.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  put(root, "src/old-name.ts", "export const moved = true;\n");
  put(root, "src/lib/deep.ts", "// deep\n");
  put(root, "README.md", "# Demo\n");
  put(root, "gone.txt", "bye\n");
  put(root, ".env.example", "KEY=\n");
  sh(root, "add", "-A");
  shAt(root, "2026-09-28T07:00:00Z", "commit", "-q", "-m", "first"); // before the fixture sessions start (08:00)
  put(root, "src/app.ts", "export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\n");
  put(root, "src/new.ts", "export const fresh = 1;\nexport const two = 2;\n");
  unlinkSync(join(root, "gone.txt"));
  sh(root, "mv", "src/old-name.ts", "src/new-name.ts");
  put(root, "node_modules/pkg/index.js", "module.exports = 1;\n");
  put(root, "dist/out.js", "built\n");
  put(root, ".env", "SECRET=hunter2\n");
  put(outside, "private.txt", "not yours\n");
  symlinkSync(join(outside, "private.txt"), join(root, "escape-link"));
  symlinkSync(join(root, "README.md"), join(root, "readme-link"));
  return root;
}

const ts = (min: number) => new Date(Date.UTC(2026, 8, 28, 8, min)).toISOString();

/** A Claude Code session: Edit, Write, MultiEdit and NotebookEdit change files; Read and Bash don't. One edit is in a
 *  sidechain line (a subagent's, which the main transcript skips). */
export function claudeTranscript(file: string, root: string) {
  const lines = [
    { type: "user", timestamp: ts(0), message: { role: "user", content: "Tidy the app" } },
    { type: "assistant", timestamp: ts(1), message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${root}/README.md` } }] } },
    { type: "assistant", timestamp: ts(2), message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: `${root}/src/app.ts`, old_string: "2", new_string: "20" } }] } },
    { type: "assistant", timestamp: ts(3), message: { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Write", input: { file_path: `${root}/src/new.ts`, content: "x" } }] } },
    { type: "assistant", timestamp: ts(4), message: { id: "m4", role: "assistant", content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: `ls ${root}/src` } }] } },
    { type: "assistant", timestamp: ts(5), message: { id: "m5", role: "assistant", content: [{ type: "tool_use", id: "t5", name: "MultiEdit", input: { file_path: `${root}/src/lib/deep.ts`, edits: [] } }] } },
    { type: "assistant", timestamp: ts(6), message: { id: "m6", role: "assistant", content: [{ type: "tool_use", id: "t6", name: "NotebookEdit", input: { notebook_path: `${root}/notes.ipynb`, new_source: "" } }] } },
    { type: "assistant", timestamp: ts(7), isSidechain: true, message: { id: "m7", role: "assistant", content: [{ type: "tool_use", id: "t7", name: "Edit", input: { file_path: `${root}/sidechain.ts` } }] } },
    { type: "assistant", timestamp: ts(8), message: { id: "m8", role: "assistant", content: [{ type: "tool_use", id: "t8", name: "Edit", input: { file_path: `${root}/src/app.ts`, old_string: "c", new_string: "d" } }] } },
    { type: "assistant", timestamp: ts(9), message: { id: "m9", role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Write", input: { file_path: `${root}/.env`, content: "SECRET=1" } }] } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** A Codex rollout: apply_patch as a custom tool (relative paths), apply_patch inside a shell command, a FileChange
 *  item (absolute path), and a plain shell command that changes nothing. */
export function codexTranscript(file: string, root: string) {
  const patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Add File: docs/added.md\n+hi\n*** Delete File: gone.txt\n*** Update File: src/old-name.ts\n*** Move to: src/new-name.ts\n*** End Patch\n";
  const lines = [
    { timestamp: ts(0), type: "session_meta", payload: { id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", timestamp: ts(0), cwd: root } },
    { timestamp: ts(1), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: patch } },
    { timestamp: ts(2), type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c2", arguments: JSON.stringify({ command: ["bash", "-lc", `apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: ${root}/README.md\n@@\n-# Demo\n+# Demo app\n*** End Patch\nEOF`], workdir: root }) } },
    { timestamp: ts(3), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c3", arguments: JSON.stringify({ cmd: "git status --short" }) } },
    { timestamp: ts(4), type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: "i1", status: "completed", changes: { [`${root}/src/lib/deep.ts`]: { type: "update" } } } } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
