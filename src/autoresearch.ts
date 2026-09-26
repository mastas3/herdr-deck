// Autoresearch (Discover → Research): campaigns that run deep research sessions one after another to find the
// best niches and business combos to build right now. This file is what you control (create after confirming,
// pause, resume, skip, stop, the kill switch) and what the page gets; the loop itself is autoresearch-loop.ts.
import { existsSync, readFileSync } from "node:fs";
import { ACTIVE, HHMM, activeRun, attempts, clip, slugify, words, type Campaign, type Niche, type Quiet, type Run } from "./autoresearch-core";
import { createLoop, type Conf, type Deps } from "./autoresearch-loop";
import { PRESETS, planAppPrompt } from "./autoresearch-prompts";

export type { Conf, Deps };
export function createAutoresearch(conf: Conf, deps: Deps) {
  const L = createLoop(conf, deps);
  const { now, save, note, tick, closeOwn, allRows, fakes, tilde } = L;
  const byId = (id: string) => L.store.campaigns.find((c) => c.id === id);

  // ── what you control ─────────────────────────────────────────────────────────────────────
  function machinesOk() {
    const ms = deps.machines?.() ?? [{ id: conf.self, label: "This computer", online: true, local: true }];
    // Research runs where its reports are read: this machine. Others are listed, not offered (not verified end to end).
    return ms.map((m) => ({ ...m, ok: m.id === conf.self, why: m.id === conf.self ? "" : "Not verified for research yet" }));
  }
  function cleanQuiet(q: any): Quiet {
    return { on: !!q?.on, from: HHMM.test(q?.from) ? q.from : "23:00", to: HHMM.test(q?.to) ? q.to : "07:00" };
  }
  const int = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  function avgRunMs() {
    const done = L.store.campaigns.flatMap((c) => c.runs).filter((r) => r.endedAt && r.startedAt && (r.state === "kept" || r.state === "discarded"));
    return done.length ? done.reduce((s, r) => s + (r.endedAt! - r.startedAt!), 0) / done.length : 20 * 60_000;
  }
  function draft(body: any) {
    const goal = clip(body.goal, 400);
    if (goal.length < 8) throw new Error("Describe the goal in a sentence first");
    const seeds = (Array.isArray(body.seeds) ? body.seeds : String(body.seeds ?? "").split(/\n|;/)).map((s: unknown) => clip(s, 120)).filter(Boolean).slice(0, 12);
    const budget = int(body.budget, 1, 20, 5), dailyCap = int(body.dailyCap, 1, 20, Math.min(budget, 6)), runMinutes = int(body.runMinutes, 10, 120, 45);
    const machine = String(body.machine || conf.self);
    const m = machinesOk().find((x) => x.id === machine);
    if (!m) throw new Error("Unknown machine");
    if (!m.ok) throw new Error(`Research can't run on ${m.label} yet: ${m.why}`);
    const model = ["", "sonnet", "opus", "haiku", "fable"].includes(String(body.model ?? "")) ? String(body.model ?? "") : "";
    const quiet = cleanQuiet(body.quiet);
    const per = Math.min(avgRunMs(), runMinutes * 60_000);
    return { goal, seeds, budget, dailyCap, runMinutes, machine, machineLabel: m.label, model, quiet, estimate: { perRunMin: Math.round(per / 60_000), totalMin: Math.round((per * budget) / 60_000), days: Math.ceil(budget / dailyCap) } };
  }
  function create(body: any) {
    const d = draft(body);
    if (body.confirm !== true) throw new Error("Confirm the campaign first");
    const id = now().toString(36) + Math.random().toString(36).slice(2, 5);
    let slug = slugify(d.goal, 40) || "campaign";
    if (L.store.campaigns.some((c) => c.slug === slug) || existsSync(`${conf.dir}/${slug}`)) slug = `${slug}-${id.slice(-4)}`;
    const c: Campaign = {
      id, slug, goal: d.goal, seeds: d.seeds, budget: d.budget, dailyCap: d.dailyCap, machine: d.machine, agent: "claude", model: d.model || undefined, quiet: d.quiet, runMinutes: d.runMinutes,
      status: "running", createdAt: now(), startedAt: now(), runs: [], board: [], openQuestions: [], failStreak: 0, notified: [],
    };
    L.store.campaigns.unshift(c);
    save();
    note(`campaign ${c.slug} started (${c.budget} runs on ${c.machine})`);
    if (L.looping()) setTimeout(() => tick().catch(() => {}), 50);
    return c;
  }
  async function control(id: string, op: string) {
    const c = byId(id);
    if (!c) throw new Error("That campaign is gone");
    const run = activeRun(c);
    const endRun = async (why: string) => {
      if (!run) return;
      run.state = "skipped"; run.error = why; run.endedAt = now();
      if (!L.starting(run.id)) await closeOwn(run);
    };
    switch (op) {
      case "pause": if (c.status === "running") { c.status = "paused"; c.reason = "Paused by you"; c.waiting = undefined; } break;
      case "resume":
        if (L.store.halted) throw new Error("The kill switch is on: turn it off first");
        if (c.status === "paused" || (c.status === "done" && attempts(c) < c.budget)) { c.status = "running"; c.reason = undefined; c.failStreak = 0; }
        break;
      case "skip": if (!run) throw new Error("Nothing is running"); await endRun("Skipped by you"); c.lastRunAt = now(); break;
      case "stop": await endRun("Stopped by you"); c.status = "stopped"; c.reason = "Stopped by you"; c.waiting = undefined; c.finishedAt = now(); break;
      case "more": { const n = int(Number(c.budget) + 3, 1, 40, c.budget); c.budget = n; if (c.status === "done") { c.status = "running"; c.reason = undefined; } break; }
      case "delete":
        if (run) throw new Error("Stop it first");
        L.store.campaigns = L.store.campaigns.filter((x) => x !== c);
        break;
      default: throw new Error("unknown op");
    }
    note(`campaign ${c.slug}: ${op}`);
    save();
    if (L.looping()) setTimeout(() => tick().catch(() => {}), 50);
  }
  async function kill(on: boolean) {
    L.store.halted = on;
    if (on) {
      for (const c of L.store.campaigns) {
        const run = activeRun(c);
        if (run) { run.state = "skipped"; run.error = "Stopped by the kill switch"; run.endedAt = now(); if (!L.starting(run.id)) await closeOwn(run); }
        if (c.status === "running") { c.status = "paused"; c.reason = "Kill switch"; c.waiting = undefined; }
      }
    }
    note(`kill switch ${on ? "on" : "off"}`);
    save();
  }

  // ── what the page gets ─────────────────────────────────────────────────────────────────────
  function liveOf(run: Run) {
    if (!ACTIVE.includes(run.state)) return undefined;
    const r = run.key ? allRows().find((x) => x.key === run.key) : undefined;
    return r ? { status: r.status, fake: fakes.has(r.key) } : undefined;
  }
  const pubNiche = (n: Niche) => ({ ...n, evidence: n.evidence.slice(0, 12), pains: n.pains.slice(0, 5), where: n.where.slice(0, 8), competitors: n.competitors.slice(0, 8) });
  function pubCampaign(c: Campaign) {
    return {
      ...c, board: c.board.slice(0, 30).map(pubNiche), planning: L.planning() === c.id, attempts: attempts(c),
      runs: c.runs.map(({ prompt, ...r }) => ({ ...r, reportPath: tilde(r.reportPath), live: liveOf(r) })),
    };
  }
  async function state() {
    const ints = deps.interests ? await Promise.race([deps.interests().catch(() => []), Bun.sleep(800).then(() => [] as string[])]) : [];
    const covered = PRESETS.map((p) => p.goal.toLowerCase()).join(" ");
    const extra = ints.filter((i) => !words(i).every((w) => covered.includes(w))).slice(0, 3).map((i) => ({ id: `i-${slugify(i, 20)}`, label: i, goal: `The best niches to build in around "${i}" right now: who pays, what's missing, and where they gather.` }));
    return {
      halted: L.store.halted, fake: !!conf.fake, stats: L.store.stats, self: conf.self, machines: machinesOk(), presets: [...PRESETS, ...extra],
      jev: !!deps.jev && (!deps.jevReady || deps.jevReady()), planner: (conf.planner ?? "claude") === "claude" && !!deps.plan ? "claude" : "template",
      campaigns: L.store.campaigns.map(pubCampaign), avgRunMin: Math.round(avgRunMs() / 60_000), log: L.log.slice(-12),
    };
  }
  function readRunReport(id: string, n: number) {
    const c = byId(id);
    const run = c?.runs.find((r) => r.n === n);
    if (!c || !run) throw new Error("No such run");
    let t = ""; try { t = readFileSync(run.reportPath, "utf8"); } catch {}
    if (!t) throw new Error("That report isn't written yet");
    return { text: stripFm(t), path: tilde(run.reportPath) };
  }
  const stripFm = (t: string) => t.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
  /** "Plan the app" for a niche: a prompt for the New session dialog (the user confirms it there). */
  function planPrompt(id: string, nicheId: string, ideasDir: string) {
    const c = byId(id);
    const n = c?.board.find((x) => x.id === nicheId);
    if (!c || !n) throw new Error("That niche is gone");
    const slug = slugify(`${n.name} app`, 50) || "niche-app";
    return { prompt: planAppPrompt(n, tilde(`${ideasDir}/${slug}.md`), tilde(`${conf.dir}/${c.slug}`)), slug, label: `Plan: ${clip(n.name, 28)}`, idea: `${n.name}${n.summary ? ` — ${n.summary}` : ""}` };
  }

  async function handle(path: string, body: any, ctx: { ideasDir?: string; projectsDir?: string } = {}): Promise<any> {
    switch (path) {
      case "/api/research": return state();
      case "/api/research/draft": return draft(body);
      case "/api/research/create": { const c = create(body); return { id: c.id, state: await state() }; }
      case "/api/research/control": await control(String(body.id ?? ""), String(body.op ?? "")); return state();
      case "/api/research/kill": await kill(!!body.on); return state();
      case "/api/research/report": return readRunReport(String(body.id ?? ""), Number(body.n));
      case "/api/research/plan-prompt": return { ...planPrompt(String(body.id ?? ""), String(body.niche ?? ""), ctx.ideasDir ?? `${conf.dir}/../ideas`), cwd: ctx.projectsDir ?? conf.workRoot };
    }
    return undefined;
  }

  return { handle, state, create, control, kill, tick, start: L.start, get store() { return L.store; }, fakes };
}
