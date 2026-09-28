// Release train: a board per repo of its stages (QA → staging → production): what each stage is at (branch or newest
// matching tag), the commits waiting between stages, and health (a GET of the stage's URL, or its check command when
// you press Check). "Promote" starts an agent session with a deploy brief after the page's confirm. Everything the
// deck runs itself is read-only git, a GET, or your own check command; it never runs a deploy command.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Host } from "../../src/plugin-api";
import { agentArgs } from "../../src/args";
import { checkProject, isPattern, LOG_FORMAT, parseLog, promoteBrief, type Commit, type Project, type Stage } from "./release-core";

const expand = (p: string) => String(p ?? "").replace(/^~(?=\/|$)/, homedir());
const quote = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

async function run(argv: string[], cwd: string, timeoutMs = 10_000): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  const t = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited; clearTimeout(t);
  return { code: p.exitCode ?? 1, out, err };
}
const git = async (repo: string, ...a: string[]) => { const r = await run(["git", "-C", repo, ...a], repo); return r.code === 0 ? r.out.trim() : undefined; };

export function activate(host: Host) {
  const file = host.env("DECK_RELEASE_TRAIN_FILE") || `${host.dataDir}/release-train.json`;
  const read = (): Project[] => { try { return JSON.parse(readFileSync(file, "utf8")).projects ?? []; } catch { return []; } };
  const write = (ps: Project[]) => writeFileSync(file, JSON.stringify({ projects: ps }, null, 1));
  const need = (id: unknown) => { const p = read().find((x) => x.id === id); if (!p) throw new Error("No such project"); return p; };

  /** A stage's commit: a branch/tag/commit, or the newest tag matching a pattern. */
  async function head(repo: string, s: Stage): Promise<{ ref?: string; commit?: Commit; tags: string[] }> {
    let ref = s.ref;
    if (isPattern(ref)) { ref = (await git(repo, "tag", "--list", ref, "--sort=-creatordate"))?.split("\n")[0] ?? ""; if (!ref) return { tags: [] }; }
    const c = parseLog((await git(repo, "log", "-1", `--format=${LOG_FORMAT}`, `${ref}^{commit}`, "--")) ?? "")[0];
    const tags = c ? ((await git(repo, "tag", "--points-at", c.sha)) ?? "").split("\n").filter(Boolean).slice(0, 5) : [];
    return { ref, commit: c, tags };
  }
  async function health(url: string) {
    const t0 = performance.now();
    try { const r = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) }); return { ok: r.status < 400, status: r.status, ms: Math.round(performance.now() - t0) }; }
    catch (e: any) { return { ok: false, error: e?.name === "TimeoutError" ? "no answer in 8 s" : /unable to connect|ECONNREFUSED|ENOTFOUND/i.test(String(e?.message ?? e)) ? "can’t connect" : String(e?.message ?? e).slice(0, 120) }; }
  }
  async function board(p: Project) {
    const repo = expand(p.repo);
    if (!existsSync(repo) || !(await git(repo, "rev-parse", "--git-dir"))) return { ...p, error: `${p.repo} isn’t a git repo on this machine`, stages: p.stages.map((s) => ({ ...s, tags: [] })), gaps: [] };
    const heads = await Promise.all(p.stages.map((s) => head(repo, s)));
    const hs = await Promise.all(p.stages.map((s) => (s.health ? health(s.health) : undefined)));
    const gaps = await Promise.all(p.stages.slice(0, -1).map(async (_, i) => {
      const a = heads[i].commit, b = heads[i + 1].commit;
      if (!a || !b) return { n: 0, commits: [] as Commit[], unknown: true };
      const n = Number(await git(repo, "rev-list", "--count", `${b.sha}..${a.sha}`)) || 0;
      const behind = Number(await git(repo, "rev-list", "--count", `${a.sha}..${b.sha}`)) || 0; // the later stage has commits the earlier lacks (a hotfix)
      return { n, behind, commits: n ? parseLog((await git(repo, "log", `--format=${LOG_FORMAT}`, "-n", "40", `${b.sha}..${a.sha}`)) ?? "") : [] };
    }));
    return { ...p, stages: p.stages.map((s, i) => ({ ...s, at: heads[i].ref, commit: heads[i].commit, tags: heads[i].tags, health: hs[i] ? { url: s.health, ...hs[i] } : undefined })), gaps };
  }
  async function plan(p: Project, from: number) {
    const b: any = await board(p);
    if (b.error) throw new Error(b.error);
    const to = from + 1;
    if (!p.stages[from] || !p.stages[to]) throw new Error("No such stage");
    const gap = b.gaps[from];
    const brief = promoteBrief({ project: p, from: p.stages[from], to: p.stages[to], fromHead: b.stages[from].commit, toHead: b.stages[to].commit, commits: gap.commits, more: Math.max(0, gap.n - gap.commits.length) });
    const args = agentArgs(p.agent, { model: p.model });
    return { cwd: expand(p.repo), kind: p.agent, model: p.model, cmd: [p.agent, ...args].map(quote).join(" "), brief, label: `promote ${p.stages[to].name}: ${p.name}`.slice(0, 40), from: p.stages[from].name, to: p.stages[to].name, n: gap.n };
  }

  host.routes("release-train", async ({ path, body }) => {
    if (path !== "/api/release-train") return undefined;
    const op = String(body?.op ?? "list");
    try {
      if (op === "list") return { projects: read() };
      if (op === "board") return await board(need(body.id));
      if (op === "save") {
        const p = checkProject(body.project);
        try { if (!statSync(expand(p.repo)).isDirectory()) throw 0; } catch { throw new Error(`Folder not found: ${p.repo}`); }
        const all = read().filter((x) => x.id !== p.id && x.id !== body.was);
        write([...all, p].sort((a, b) => a.name.localeCompare(b.name)));
        return { ok: true, project: p };
      }
      if (op === "remove") { write(read().filter((x) => x.id !== body.id)); return { ok: true }; }
      if (op === "check") {
        // Your own check command for a stage, run in the repo when you press Check (never on a timer).
        const p = need(body.id), s = p.stages[Number(body.stage)];
        if (!s?.check) throw new Error("That stage has no check command");
        if (body.confirmed !== true) throw new Error("Running a check needs your confirmation");
        const r = await run(["sh", "-c", s.check], expand(p.repo), 30_000);
        return { ok: r.code === 0, code: r.code, out: (r.out + r.err).trim().split("\n").slice(-15).join("\n").slice(-2000) };
      }
      if (op === "plan") return await plan(need(body.id), Number(body.from));
      if (op === "promote") {
        if (body.confirmed !== true) throw new Error("Promoting needs your confirmation");
        const pl = await plan(need(body.id), Number(body.from));
        const res = await host.sessions.start({ kind: pl.kind, cwd: pl.cwd, prompt: pl.brief, label: pl.label, model: pl.model });
        return { ok: true, key: res?.key };
      }
      return Response.json({ error: "Unknown op" }, { status: 400 });
    } catch (e: any) { return Response.json({ error: e?.message ?? String(e) }, { status: 400 }); }
  });
}
