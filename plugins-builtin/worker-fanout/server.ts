// Worker fan-out: one brief to N workers (each a session in its own folder or worktree), each told to write
// REPORT.md and a DONE marker in <data>/fanout/<run>/w<n>/. The Workers board reads those files; "collect" merges the
// reports into one message for a session you pick. Nothing starts or sends without "confirmed": true (the page's
// confirm dialog). The deck never asks a worker for status: the files are the status.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "../../src/plugin-api";
import { agentArgs } from "../../src/args";
import { checkSpec, mergeReports, workerPrompt, workerState, type Files, type Run, type Worker } from "./fanout-core";

const quote = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const expand = (p: string) => String(p ?? "").trim().replace(/^~(?=\/|$)/, homedir());
const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return undefined; } };
/** Claude and Codex may write outside their folder only where they're told to: the worker's report folder. */
const extraArgs = (kind: string, dir: string) => (kind === "claude" || kind === "codex" ? ["--add-dir", dir] : []);

export function activate(host: Host) {
  const root = host.env("DECK_FANOUT_DIR") || `${host.dataDir}/fanout`;
  const dirOf = (id: string) => join(root, String(id).replace(/[^\w-]/g, ""));
  const load = (id: string): Run | undefined => { const t = read(join(dirOf(id), "run.json")); try { return t ? JSON.parse(t) : undefined; } catch { return undefined; } };
  const save = (r: Run) => { mkdirSync(dirOf(r.id), { recursive: true }); writeFileSync(join(dirOf(r.id), "run.json"), JSON.stringify(r, null, 1)); };
  const all = () => { let ids: string[] = []; try { ids = readdirSync(root); } catch {} return ids.map(load).filter(Boolean).sort((a, b) => b!.createdAt - a!.createdAt) as Run[]; };
  const files = (w: Worker): Files => ({ report: read(join(w.dir, "REPORT.md")), done: existsSync(join(w.dir, "DONE")), failed: existsSync(join(w.dir, "FAILED")) });

  function view(r: Run, keys = new Set(host.rows().map((x) => x.key))) {
    const workers = r.workers.map((w) => { const f = files(w); return { ...w, state: workerState(w, f, !!w.key && keys.has(w.key)), hasReport: !!f.report?.trim(), reportPath: join(w.dir, "REPORT.md") }; });
    return { id: r.id, title: r.title, brief: r.brief, createdAt: r.createdAt, collected: r.collected ?? [], workers };
  }
  function plan(body: any) {
    const spec = checkSpec(body);
    const id = typeof body.id === "string" && /^[\w-]{6,40}$/.test(body.id) && !load(body.id) ? body.id : `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
    const workers = spec.workers.map((s, i) => {
      const cwd = expand(s.cwd);
      try { if (!statSync(cwd).isDirectory()) throw 0; } catch { throw new Error(`Worker ${i + 1}: folder not found: ${s.cwd}`); }
      const dir = join(dirOf(id), `w${i + 1}`);
      const args = agentArgs(s.kind, { model: s.model, args: extraArgs(s.kind, dir) });
      return { ...s, cwd, n: i + 1, dir, cmd: [s.kind, ...args].map(quote).join(" ") };
    });
    const run = { id, title: spec.title, brief: spec.brief };
    return { ...run, workers: workers.map((w) => ({ ...w, prompt: workerPrompt(run, w, workers.length) })) };
  }
  const need = (id: unknown) => { const r = load(String(id ?? "")); if (!r) throw new Error("That run is gone"); return r; };

  // Tell open pages when a worker's state changes, and say so once when a whole run has finished.
  let last = "";
  host.every(10_000, () => {
    const keys = new Set(host.rows().map((x) => x.key));
    const runs = all().slice(0, 20).map((r) => ({ r, v: view(r, keys) }));
    for (const { r, v } of runs) {
      if (r.announced || v.workers.some((w) => w.state === "running")) continue;
      const ok = v.workers.filter((w) => w.state === "done").length;
      host.notice({ ok: ok === v.workers.length, message: `“${r.title}”: ${ok} of ${v.workers.length} workers done. Collect the reports on the Workers board.` });
      save({ ...r, announced: true });
    }
    const sig = JSON.stringify(runs.map(({ v }) => [v.id, v.workers.map((w) => w.state + w.hasReport)]));
    if (sig !== last) { if (last) host.broadcast("worker-fanout", { changed: true }); last = sig; }
  });

  host.routes("worker-fanout", async ({ path, body }) => {
    if (path !== "/api/worker-fanout") return undefined;
    const op = String(body?.op ?? "list");
    try {
      if (op === "list") { const keys = new Set(host.rows().map((x) => x.key)); return { runs: all().slice(0, 50).map((r) => view(r, keys)) }; }
      if (op === "get") return view(need(body.id));
      if (op === "plan") return plan(body);
      if (op === "worktrees") {
        const p = Bun.spawn(["git", "-C", expand(body.cwd), "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
        const out = await new Response(p.stdout).text(); await p.exited;
        return { worktrees: [...out.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]).slice(0, 20) };
      }
      if (op === "start") {
        if (body.confirmed !== true) throw new Error("Starting workers needs your confirmation");
        const p = plan(body);
        const run: Run = { id: p.id, title: p.title, brief: p.brief, createdAt: Date.now(), workers: p.workers.map(({ cmd, prompt, ...w }) => w) };
        save(run);
        for (const [i, w] of p.workers.entries()) {
          mkdirSync(w.dir, { recursive: true });
          try {
            const res = await host.sessions.start({ kind: w.kind, cwd: w.cwd, prompt: w.prompt, model: w.model, label: w.label || `w${w.n}: ${run.title}`.slice(0, 40), args: extraArgs(w.kind, w.dir) });
            run.workers[i] = { ...run.workers[i], key: res?.key, startedAt: Date.now() };
          } catch (e: any) { run.workers[i].error = e?.message ?? String(e); }
          save(run);
        }
        return view(run);
      }
      if (op === "report") {
        const w = need(body.id).workers.find((x) => x.n === Number(body.n));
        if (!w) throw new Error("No such worker");
        return { text: files(w).report ?? "" };
      }
      if (op === "collect") {
        const r = need(body.id), v = view(r);
        const text = mergeReports(r, v.workers.map((w) => ({ w, state: w.state, report: files(w).report })));
        if (!body.send) return { text };
        if (body.confirmed !== true) throw new Error("Sending needs your confirmation");
        const key = String(body.key ?? "");
        if (!key) throw new Error("Pick the session to send to");
        await host.sessions.send(key, text);
        save({ ...r, collected: [...(r.collected ?? []), { at: Date.now(), key }] });
        return { ok: true };
      }
      if (op === "delete") { const d = dirOf(String(body.id ?? "")); if (existsSync(join(d, "run.json"))) rmSync(d, { recursive: true, force: true }); return { ok: true }; }
      return Response.json({ error: "Unknown op" }, { status: 400 });
    } catch (e: any) { return Response.json({ error: e?.message ?? String(e) }, { status: 400 }); }
  });
}
