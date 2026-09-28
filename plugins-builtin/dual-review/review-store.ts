// Dual review, on disk: one folder per review under <data>/dual-review/<id>/ with review.json (what was asked, which
// sessions) and the two findings files the reviewers write (claude.json, codex.json). Nothing here starts a session;
// server.ts does that after the page's confirm dialog.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { agentArgs } from "../../src/args";
import { parseFindings, parseRange, reviewPrompt, type Finding, type Side } from "./review-match";

export const SIDES: Side[] = ["claude", "codex"];
export type SideState = { key?: string; file: string; model?: string; error?: string; startedAt?: number };
export type Review = { id: string; cwd: string; project: string; range: string; words: string; focus?: string; origin?: { key: string; title?: string }; createdAt: number; sides: Record<Side, SideState>; sent?: { at: number; n: number }[] };
export type SidePlan = { side: Side; kind: Side; cwd: string; label: string; model?: string; args: string[]; cmd: string; prompt: string };

const quote = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const expandHome = (p: string) => String(p ?? "").trim().replace(/^~(?=\/|$)/, homedir());

export function createReviewStore(root: string) {
  const dirOf = (id: string) => join(root, id.replace(/[^\w-]/g, ""));
  function read(id: string): Review | undefined {
    try { return JSON.parse(readFileSync(join(dirOf(id), "review.json"), "utf8")); } catch { return undefined; }
  }
  const save = (r: Review) => { mkdirSync(dirOf(r.id), { recursive: true }); writeFileSync(join(dirOf(r.id), "review.json"), JSON.stringify(r, null, 1)); };
  function all(): Review[] {
    let ids: string[] = [];
    try { ids = readdirSync(root); } catch {}
    return ids.map(read).filter(Boolean).sort((a, b) => b!.createdAt - a!.createdAt) as Review[];
  }
  /** A side's findings, once its file is there and readable. */
  function findings(r: Review, side: Side): Finding[] | undefined {
    const f = r.sides[side]?.file;
    if (!f || !existsSync(f)) return;
    try { return parseFindings(readFileSync(f, "utf8")); } catch { return; }
  }
  /** waiting (its session is up), done (findings read), gone (session closed without a file), failed (never started). */
  function sideStatus(r: Review, side: Side, liveKeys: Set<string>) {
    const s = r.sides[side];
    if (findings(r, side)) return "done";
    if (s.error) return "failed";
    if (s.key && liveKeys.has(s.key)) return "waiting";
    // A session takes a moment to show up in the list: don't call it gone straight away.
    return Date.now() - (s.startedAt ?? r.createdAt) < 90_000 ? "waiting" : "gone";
  }

  /** What would run, for the confirm dialog, and exactly what start() then runs. */
  function plan(o: { cwd: string; range?: string; focus?: string; models?: Partial<Record<Side, string>>; id?: string }) {
    const cwd = expandHome(o.cwd);
    try { if (!statSync(cwd).isDirectory()) throw 0; } catch { throw new Error(`Folder not found: ${o.cwd}`); }
    const rg = parseRange(o.range ?? "");
    if (!rg.ok) throw new Error(rg.error);
    const id = o.id && /^[\w-]{6,40}$/.test(o.id) && !read(o.id) ? o.id : `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = dirOf(id);
    const project = basename(cwd);
    const sessions: SidePlan[] = SIDES.map((side) => {
      const file = join(dir, `${side}.json`);
      const model = String(o.models?.[side] ?? "").trim() || undefined;
      const extra = ["--add-dir", dir]; // the reviewer may write its findings there even when sandboxed to the repo
      const args = agentArgs(side, { model, args: extra });
      return { side, kind: side, cwd, label: `review ${side}: ${project}`.slice(0, 40), model, args, cmd: [side, ...args].map(quote).join(" "), prompt: reviewPrompt({ side, cwd, words: rg.words, file, focus: o.focus }) };
    });
    return { id, dir, cwd, project, range: rg.range, words: rg.words, focus: o.focus?.trim() || undefined, sessions };
  }

  function create(p: ReturnType<typeof plan>, origin?: Review["origin"]): Review {
    const r: Review = { id: p.id, cwd: p.cwd, project: p.project, range: p.range, words: p.words, focus: p.focus, origin, createdAt: Date.now(),
      sides: Object.fromEntries(p.sessions.map((s) => [s.side, { file: join(p.dir, `${s.side}.json`), model: s.model }])) as Review["sides"] };
    save(r);
    return r;
  }
  function remove(id: string) { const d = dirOf(id); if (existsSync(join(d, "review.json"))) rmSync(d, { recursive: true, force: true }); }
  return { root, dirOf, read, save, all, findings, sideStatus, plan, create, remove };
}
export type ReviewStore = ReturnType<typeof createReviewStore>;

/** `git diff --stat` for the range, read-only, for the dialog: which files the reviewers will look at. */
export async function diffStat(cwd: string, diff: string[], timeoutMs = 10_000): Promise<{ stat: string; files: number; error?: string }> {
  const p = Bun.spawn(["git", "-C", cwd, ...diff, "--stat=100", "--no-color"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const t = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited; clearTimeout(t);
  if (p.exitCode !== 0) return { stat: "", files: 0, error: err.trim().split("\n")[0] || "git diff failed" };
  const lines = out.trimEnd().split("\n").filter(Boolean);
  return { stat: lines.slice(-40).join("\n"), files: Math.max(0, lines.length - 1) };
}
