// History indexer, run as its own short-lived process (one pass, then exit) so parsing gigabytes of
// transcripts never stalls the live deck, its memory is returned to the OS, and a crash stays contained.
// Every Claude Code and Codex conversation on this machine goes into SQLite: one row per session and
// its chat text in an FTS5 table. Files are re-read only when they change; growing files are indexed
// incrementally from where the last pass stopped.
import { Database } from "bun:sqlite";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { claudeDetail, codexDetail, forgetTranscript, type Detail } from "./transcript";
import { inferProject, projectRoot, displayName } from "./projects";
import { HISTORY_DB, SCHEMA } from "./history-schema";
import { isPrivatePath } from "./private-folder";
import { claudeProjectDirs } from "./claude-profiles";

const HOME = homedir();
const db = new Database(HISTORY_DB, { create: true });
db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000;");
db.exec(SCHEMA);
// Bump when what we store per session changes (titles, projects): every session gets re-read once.
const VERSION = 3;
if ((db.query("pragma user_version").get() as any).user_version < VERSION) { db.exec("update sess set size = -1"); db.exec(`pragma user_version = ${VERSION}`); }

/** Codex names its threads ("Build multiplayer dating game"); the last entry per id wins. */
const codexNames = new Map<string, string>();
try {
  for (const line of (await Bun.file(`${HOME}/.codex/session_index.jsonl`).text()).split("\n")) {
    try { const o = JSON.parse(line); if (o.id && o.thread_name) codexNames.set(o.id, o.thread_name); } catch {}
  }
} catch {}
/** Text agents inject before your first message isn't a title. */
const PREAMBLE = /^(the following is the codex agent history|<environment_context>|<user_instructions>|# agents\.md|<permissions|you are (a|an) |<system|caveat:)/i;

type Src = { file: string; agent: "claude" | "codex"; id: string; size: number; mtime: number; ino: number };

function walk(dir: string, out: string[], depth = 0) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (depth < 5 && e.name !== "subagents") walk(p, out, depth + 1); }
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}

function sources(): Src[] {
  const out: Src[] = [];
  const claude: string[] = [];
  for (const dir of claudeProjectDirs()) walk(dir, claude);
  for (const f of claude) {
    const name = basename(f, ".jsonl");
    if (name.startsWith("agent-") || f.includes("/subagents/") || f.includes("claude-mem-observer")) continue; // sidechains belong to their parent; memory-plugin observers are noise
    if (isPrivatePath(f)) continue; // a private session's folder: never indexed (its old rows go at the next pass)
    try { const st = statSync(f); out.push({ file: f, agent: "claude", id: name, size: st.size, mtime: st.mtimeMs, ino: st.ino }); } catch {}
  }
  const codex: string[] = [];
  walk(`${HOME}/.codex/sessions`, codex);
  walk(`${HOME}/.codex/archived_sessions`, codex);
  for (const f of codex) {
    const id = basename(f, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
    if (!id) continue;
    try { const st = statSync(f); out.push({ file: f, agent: "codex", id, size: st.size, mtime: st.mtimeMs, ino: st.ino }); } catch {}
  }
  return out;
}

function readSlice(file: string, from: number, len: number) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

/** cwd and model come from the raw lines: the first cwd the agent recorded, the last model it used. */
function facts(s: Src) {
  const head = readSlice(s.file, 0, 96 * 1024);
  const tail = s.size > 96 * 1024 ? readSlice(s.file, Math.max(0, s.size - 96 * 1024), 96 * 1024) : head;
  const cwd = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/)?.[1]?.replace(/\\\//g, "/");
  const models = [...tail.matchAll(/"model"\s*:\s*"([\w.:\-/\[\]]{3,60})"/g)].map((m) => m[1]).filter((m) => !/^(gpt-image|text-embedding)/.test(m));
  return { cwd, model: models[models.length - 1] };
}

const oneLine = (t: string | undefined, n: number) => {
  const s = String(t ?? "").replace(/<\/?[a-z_-]+(\s[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

const q = {
  get: db.query("select file, size, mtime, ino, msgs, gen from sess where file = ?"),
  upsert: db.query(`insert into sess (file, id, agent, cwd, project, root, title, first, started, last, asks, model, size, mtime, ino, msgs, gen, empty)
    values ($file, $id, $agent, $cwd, $project, $root, $title, $first, $started, $last, $asks, $model, $size, $mtime, $ino, $msgs, $gen, $empty)
    on conflict(file) do update set id=$id, agent=$agent, cwd=$cwd, project=$project, root=$root, title=$title, first=$first, started=$started, last=$last,
      asks=$asks, model=$model, size=$size, mtime=$mtime, ino=$ino, msgs=$msgs, gen=$gen, empty=$empty`),
  delMsgs: db.query("delete from msg where file = ?"),
  delFrom: db.query("delete from msg where file = ? and cast(i as integer) >= ?"),
  ins: db.query("insert into msg (text, file, i, role, at) values (?, ?, ?, ?, ?)"),
  drop: db.query("delete from sess where file = ?"),
  files: db.query("select file from sess"),
};

/** Text worth finding later: what you asked, what the agent said, and the one-line gist of each tool call. */
function msgText(m: Detail["messages"][number]) {
  if (m.role === "tool") return `${m.tool ?? ""} ${m.summary ?? ""}`.trim();
  if (m.role === "note") return "";
  return (m.text ?? "").slice(0, 12_000);
}

/** Nothing said, or a machine-to-machine session (Codex's approval judges answer in bare JSON). */
function noise(d: Detail, asks: number) {
  if (!d.messages.some((m) => m.role === "user" || m.role === "assistant")) return true;
  const firstA = d.messages.find((m) => m.role === "assistant")?.text?.trim() ?? "";
  return asks === 0 && /^[{\[]/.test(firstA);
}

async function indexOne(s: Src, prev: any) {
  const f = facts(s);
  if (isPrivatePath(f.cwd)) {
    // A private session (Codex names no folder in its path): keep only a blank marker row so it isn't re-read each
    // pass. No title, no text, and empty = 1 keeps it out of every search and list.
    db.transaction(() => {
      q.delMsgs.run(s.file);
      q.upsert.run({ $file: s.file, $id: s.id, $agent: s.agent, $cwd: "", $project: "", $root: null, $title: "", $first: "", $started: null, $last: s.mtime, $asks: 0,
        $model: null, $size: s.size, $mtime: s.mtime, $ino: s.ino, $msgs: 0, $gen: 0, $empty: 1 });
    })();
    return;
  }
  const d = s.agent === "claude" ? await claudeDetail(s.file) : await codexDetail(s.file);
  const userMsgs = d.messages.filter((m) => m.role === "user");
  // Sessions another agent started (codex exec, spawned workers) have no typed prompt: their first reply stands in.
  const first = [d.started, ...userMsgs.map((m) => m.text)].find((t) => t && !PREAMBLE.test(t.trim())) ?? d.messages.find((m) => m.role === "assistant")?.text;
  const lastAt = d.messages.reduce((t, m) => Math.max(t, m.at ?? 0), 0) || s.mtime;
  const cwd = f.cwd ?? "";
  const proj = inferProject(d.touch, cwd);
  const root = proj?.root ?? (cwd ? projectRoot(cwd) : undefined);
  // Same parse generation and a longer file: only the tail is new. Resend the last couple of messages,
  // since a turn's final text can still grow while it streams.
  // (Each pass is a fresh process, so this is "the file only grew": same inode, first messages unchanged.)
  const incremental = prev && s.size >= prev.size && prev.ino === s.ino && (prev.msgs ?? 0) <= d.messages.length;
  const from = incremental ? Math.max(0, (prev.msgs ?? 0) - 2) : 0;
  db.transaction(() => {
    if (from === 0) q.delMsgs.run(s.file); else q.delFrom.run(s.file, from);
    for (const m of d.messages.slice(from)) {
      const text = msgText(m);
      if (text) q.ins.run(text, s.file, m.i, m.role, m.at ?? null);
    }
    q.upsert.run({
      $file: s.file, $id: s.id, $agent: s.agent, $cwd: cwd, $project: proj?.name ?? (root ? displayName(root) : cwd ? basename(cwd) : ""), $root: root ?? null,
      $title: oneLine((s.agent === "codex" && codexNames.get(s.id)) || d.aiTitle || first, 140), $first: oneLine(first, 600), $started: d.startedAt ?? null, $last: lastAt, $asks: d.asks,
      $model: f.model ?? null, $size: s.size, $mtime: s.mtime, $ino: s.ino, $msgs: d.messages.length, $gen: d.gen, $empty: noise(d, userMsgs.filter((m) => m.text && !PREAMBLE.test(m.text.trim())).length) ? 1 : 0,
    });
  })();
  forgetTranscript(s.file);
}

async function pass() {
  const t0 = Date.now();
  try {
    const all = sources();
    const seen = new Set(all.map((s) => s.file));
    for (const r of q.files.all() as any[]) if (!seen.has(r.file)) db.transaction(() => { q.delMsgs.run(r.file); q.drop.run(r.file); })();
    const todo = all.filter((s) => { const p: any = q.get.get(s.file); return !p || p.size !== s.size || p.mtime !== s.mtime || p.ino !== s.ino; })
      .sort((a, b) => b.mtime - a.mtime); // newest first: recent work is searchable soonest
    let done = 0, bytes = 0, passBytes = 0;
    // A bounded pass keeps the peak low; the parent starts another straight away when there's more.
    const BUDGET = Number(process.env.DECK_HIST_PASS_BYTES ?? 5e8);
    postMessage({ type: "progress", done, total: todo.length, sessions: all.length });
    for (const s of todo) {
      if (process.env.DECK_HIST_TRACE) process.stderr.write(`${s.size} ${s.file}\n`);
      try { await indexOne(s, q.get.get(s.file)); } catch (e: any) { postMessage({ type: "error", file: s.file, error: String(e?.message ?? e) }); }
      done++; bytes += s.size; passBytes += s.size;
      if ((passBytes > BUDGET || process.memoryUsage().rss > 1.2e9) && done < todo.length) { postMessage({ type: "progress", done, total: todo.length, sessions: all.length }); postMessage({ type: "more" }); return; }
      if (done % 10 === 0 || done === todo.length) postMessage({ type: "progress", done, total: todo.length, sessions: all.length });
      if (bytes > 25e6) { bytes = 0; Bun.gc(true); await Bun.sleep(2); } // keep the peak down between big files
    }
    if (todo.length > 50) db.exec("insert into msg(msg) values('optimize')");
    postMessage({ type: "idle", indexed: todo.length, sessions: all.length, ms: Date.now() - t0 });
  } catch (e: any) {
    postMessage({ type: "error", error: String(e?.message ?? e) });
  }
}

function postMessage(m: unknown) { process.stdout.write(JSON.stringify(m) + "\n"); }
await pass();
db.close();
process.exit(0);
