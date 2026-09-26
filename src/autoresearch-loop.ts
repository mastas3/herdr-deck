// Autoresearch, the loop: campaigns that run deep research sessions one after another to find the best niches
// and business combos to build right now. Karpathy's autoresearch loop, with coding agents:
//
//   plan (headless Claude picks the next question; a deterministic planner fills in)
//   → run (ONE agent session at a time, through the deck's own new-session machinery, labeled "research: …")
//   → evaluate (parse the report, score every niche with a rubric + Jev, merge them into one leaderboard)
//   → keep / discard → plan the next question.
//
// Safety: nothing runs until you confirm a campaign. A run never contacts anyone; its prompt forbids it. The loop
// only ever closes its own sessions (same key, still labeled "research: …", in its own folder). State lives in
// campaigns.json and survives restarts: a run that was starting when the deck died is adopted if its session
// exists and never started twice. Pure decisions: autoresearch-core.ts and -eval.ts. Controls and routes: autoresearch.ts.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import {
  activeRun, canClose, clip, emptyStore, findRow, labelFor, localDay, nextStep, plannerPrompt, slugify, templatePlan, validatePlan,
  type Campaign, type Plan, type RowLite, type Run, type Store,
} from "./autoresearch-core";
import { KEEP_MIN, keepRun, mergeNiches, nicheProblems, parseReport, reportProblems, rubric, type ParsedNiche, type Report } from "./autoresearch-eval";
import { fixtureReport, researchPrompt } from "./autoresearch-prompts";
import { comparablesText, type Comparables, type Target } from "./library-strategy";

export type StartOpts = { machine: string; kind: "claude"; cwd: string; prompt: string; label: string; model?: string };
export type Deps = {
  rows: () => RowLite[];
  start: (o: StartOpts) => Promise<{ key: string }>;
  close: (key: string) => Promise<{ ok: boolean; error?: string }>;
  send?: (key: string, text: string) => Promise<void>;
  keys?: (key: string, keys: string[]) => Promise<void>;
  screen?: (key: string) => Promise<string>;
  plan?: (system: string, user: string, timeoutMs: number) => Promise<string>;
  jev?: (state: unknown, questions: Record<string, any>, label: string) => Promise<{ answers?: any; fallback?: string | null; cached?: boolean }>;
  jevReady?: () => boolean;
  notify?: (m: { title: string; body: string; tag: string; url?: string }) => Promise<unknown> | unknown;
  assets?: () => Promise<string[]>;
  interests?: () => Promise<string[]>;
  machines?: () => { id: string; label: string; online: boolean; local?: boolean }[];
  /** Comparable founders for a niche (src/library-strategy.ts): the planner and the evaluator account for what worked. */
  comparables?: (t: Target) => Comparables | undefined;
  changed?: () => void;
};
export type Conf = {
  dir: string; // campaigns.json and the reports (~/.config/herdr-deck/research)
  workRoot: string; // where research sessions run (~/Documents/Projects/_research/<campaign>)
  self: string; // this machine's id
  home?: string;
  fake?: { ms: number; fail?: number[] }; // simulated sessions: no herdr, no agent time
  planner?: "claude" | "template";
  timeoutMs?: number; // overrides every campaign's per-run limit (tests)
  now?: () => number;
  tickMs?: number;
};

const DONE_STATUSES = new Set(["done", "idle", "empty"]);
const TRUST_RE = /trust (?:this|the files in this) folder|Do you trust|Yes, I trust|Is this a project you/i;

export function createLoop(conf: Conf, deps: Deps) {
  const now = () => (conf.now ? conf.now() : Date.now());
  const FILE = `${conf.dir}/campaigns.json`;
  mkdirSync(conf.dir, { recursive: true });
  let store: Store = emptyStore();
  try { const j = JSON.parse(readFileSync(FILE, "utf8")); if (j?.v === 1 && Array.isArray(j.campaigns)) store = { ...emptyStore(), ...j, stats: { ...emptyStore().stats, ...j.stats } }; } catch {}
  const save = () => {
    const tmp = `${FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 1));
    renameSync(tmp, FILE);
    deps.changed?.();
  };
  const log: string[] = []; // recent loop events, newest last (for tests and the UI's "what happened")
  const note = (s: string) => { log.push(`${new Date(now()).toISOString().slice(11, 19)} ${s}`); if (log.length > 80) log.shift(); };

  // ── the fake runner: simulated sessions, a fixture report after a delay ─────────────────────
  type Fake = RowLite & { runId: string; timer?: Timer };
  const fakes = new Map<string, Fake>();
  function fakeStart(o: StartOpts, run: Run, c: Campaign): { key: string } {
    const key = `fake|research-${run.id}`;
    const f: Fake = { key, tab: o.label, title: o.label, status: "working", cwd: o.cwd, firstPrompt: o.prompt, machine: o.machine, runId: run.id };
    fakes.set(key, f);
    f.timer = setTimeout(() => {
      if (!fakes.has(key)) return;
      if (conf.fake?.fail?.includes(run.n)) { f.status = "idle"; return; } // never writes its report: the run times out
      try { mkdirSync(run.reportPath.replace(/\/[^/]+$/, ""), { recursive: true }); writeFileSync(run.reportPath, fixtureReport(run, c)); } catch {}
      f.status = "done";
    }, conf.fake!.ms);
    return { key };
  }
  const allRows = (): RowLite[] => [...(conf.fake ? [] : safe(() => deps.rows(), [] as RowLite[])), ...fakes.values()];
  function safe<T>(fn: () => T, d: T): T { try { return fn(); } catch { return d; } }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────
  const runTimeout = (c: Campaign) => conf.timeoutMs ?? c.runMinutes * 60_000;
  const tilde = (p: string) => (conf.home ? p.replace(conf.home, "~") : p);
  function rollDay() { const d = localDay(now()); if (store.stats.day !== d) store.stats = { ...store.stats, day: d, dayPlanner: 0, dayJev: 0 }; }
  const assetsCache: { at: number; list: string[] } = { at: 0, list: [] };
  async function assets() {
    if (now() - assetsCache.at < 10 * 60_000 && assetsCache.at) return assetsCache.list;
    try { assetsCache.list = deps.assets ? (await Promise.race([deps.assets(), Bun.sleep(4000).then(() => assetsCache.list)])).slice(0, 24) : []; } catch {}
    assetsCache.at = now();
    return assetsCache.list;
  }
  async function notify(title: string, body: string, tag: string) {
    try { await deps.notify?.({ title, body, tag, url: "/?research=1" }); note(`push: ${title}`); } catch {}
  }

  // ── reports ─────────────────────────────────────────────────────────────────────────────
  /** The run's report, parsed, with its raw text; an older file at that path isn't this run's report. */
  function readReport(run: Run): (Report & { text: string }) | undefined {
    try {
      if (run.startedAt && statSync(run.reportPath).mtimeMs < run.startedAt - 5_000) return undefined;
      const text = readFileSync(run.reportPath, "utf8");
      return { ...parseReport(text), text };
    } catch { return undefined; }
  }

  // ── closing: only ever the loop's own session ────────────────────────────────────────────────
  async function closeOwn(run: Run) {
    if (!run.key || run.closed) return;
    const row = allRows().find((r) => r.key === run.key);
    if (!row) { run.closed = "gone"; return; }
    if (!canClose(row, run)) { run.closed = "left-open"; note(`#${run.n}: left ${run.key} open (it no longer looks like its research session)`); return; }
    if (fakes.has(run.key)) { clearTimeout(fakes.get(run.key)!.timer); fakes.delete(run.key); run.closed = "closed"; return; }
    const r = await deps.close(run.key).catch((e: any) => ({ ok: false, error: String(e?.message ?? e) }));
    run.closed = r.ok ? "closed" : "left-open";
    note(`#${run.n}: ${r.ok ? "closed" : `couldn't close (${r.error})`} ${run.key}`);
  }

  // ── plan → start ─────────────────────────────────────────────────────────────────────────────
  let planning: string | undefined;
  const starting = new Set<string>(); // run ids whose start call is in flight (never adopted as "interrupted")
  async function planNext(c: Campaign): Promise<Plan> {
    const list = await assets();
    const useClaude = (conf.planner ?? "claude") === "claude" && !!deps.plan;
    if (useClaude) {
      // Founders like the campaign's best niche so far (or its goal, before there is one).
      const top = c.board[0];
      const comps = safe(() => deps.comparables?.(top ? { name: top.name, offer: top.summary, buyer: top.audience, price: top.prices[0] } : { text: c.goal }), undefined);
      const { system, user } = plannerPrompt(c, list, comparablesText(comps, 4));
      rollDay();
      store.stats.planner++; store.stats.dayPlanner++;
      try {
        const text = await deps.plan!(system, user, 60_000);
        const p = validatePlan(text, c.runs.map((r) => r.question));
        if (p) return p;
        note(`planner: unusable answer, using the template planner`);
      } catch (e: any) { note(`planner: ${e?.message ?? e}; using the template planner`); }
      store.stats.plannerFallback++;
    }
    return templatePlan(c, list);
  }
  async function planAndStart(c: Campaign) {
    planning = c.id;
    deps.changed?.();
    let plan: Plan;
    try { plan = await planNext(c); } finally { planning = undefined; }
    // Paused, stopped, killed or already running something while the planner thought: start nothing.
    if (c.status !== "running" || store.halted || store.campaigns.some((x) => activeRun(x))) { save(); return; }
    const n = c.runs.length + 1;
    const id = `${c.id}-${n}-${now().toString(36).slice(-4)}`;
    const slug = slugify(plan.focus || plan.question, 40) || `run-${n}`;
    const reportDir = `${conf.dir}/${c.slug}`, cwd = `${conf.workRoot}/${c.slug}`;
    mkdirSync(cwd, { recursive: true });
    mkdirSync(reportDir, { recursive: true });
    const run: Run = {
      id, n, question: plan.question, type: plan.type, why: plan.why, focus: plan.focus, planner: plan.planner,
      slug, reportPath: `${reportDir}/${String(n).padStart(2, "0")}-${slug}.md`, label: labelFor(plan.question), cwd, machine: c.machine,
      state: "starting", createdAt: now(), startedAt: now(),
    };
    run.prompt = researchPrompt(run, c, await assets(), { home: conf.home });
    c.runs.push(run);
    c.lastRunAt = now();
    c.waiting = undefined;
    save(); // persisted as "starting" before anything is started: a restart adopts it or fails it, never starts it twice
    note(`#${n} start: ${run.label} (${plan.planner})`);
    starting.add(run.id);
    try {
      const o: StartOpts = { machine: c.machine, kind: "claude", cwd, prompt: run.prompt, label: run.label, model: c.model };
      const r = conf.fake ? fakeStart(o, run, c) : await deps.start(o);
      run.key = r.key;
      if (run.state === "starting") run.state = "running";
      else await closeOwn(run); // skipped or stopped while it was starting
    } catch (e: any) {
      if (run.state === "starting") failRun(c, run, `Couldn't start the session: ${e?.message ?? e}`);
    } finally { starting.delete(run.id); }
    save();
  }

  function failRun(c: Campaign, run: Run, error: string, o: { interrupted?: boolean } = {}) {
    run.state = "failed"; run.error = error; run.endedAt = now(); run.interrupted = o.interrupted || undefined;
    if (!o.interrupted) c.failStreak++;
    c.lastRunAt = now();
    note(`#${run.n} failed: ${error}`);
  }

  /** Comparables for Jev's state: the counts, and each founder in a line (claims marked as claims). */
  function comparablesState(r: Comparables | undefined) {
    if (!r) return undefined;
    return { summary: r.summary, strategy_check: r.checks, founders: r.comparables.slice(0, 4).map((x) => `${x.name}${x.published ? ` (${x.published})` : ""}: ${x.sells ?? ""}${x.revenue ? `; claimed revenue "${x.revenue.text}"` : ""}${x.first[0] ? `; first customers via ${x.first[0].channel.replace(/_/g, " ")}` : ""}`) };
  }
  // ── evaluate → keep / discard ──────────────────────────────────────────────────────────────
  async function jevFor(c: Campaign, n: ParsedNiche): Promise<number | undefined> {
    if (!deps.jev || (deps.jevReady && !deps.jevReady())) return undefined;
    const state = {
      builder: { kind: "solo developer building with AI coding agents", assets: (await assets()).slice(0, 12).map((a) => clip(a, 60)) },
      niche: { name: n.name, summary: n.summary, why_now: n.whyNow, audience: n.audience, price_points: n.prices.slice(0, 3), competitors: n.competitors.length, pains_with_links: n.pains.filter((p) => p.url).length, evidence_links: n.evidence.length, scores_0_to_10: n.scores },
      campaign_goal: clip(c.goal, 200),
      comparable_founders: comparablesState(safe(() => deps.comparables?.({ name: n.name, offer: n.summary, buyer: n.audience, price: n.prices[0] }), undefined)),
    };
    const questions = { customers: { type: "noul", instructions: "Probability that this builder, starting today, gets at least 10 paying customers in this niche within 60 days, given the evidence and what comparable founders (their claims) managed." } };
    try {
      const r = await deps.jev(state, questions, `Niche: ${clip(n.name, 50)}`);
      if (!r.cached && r.fallback !== "unavailable" && r.fallback !== "deck_daily_cap") { rollDay(); store.stats.jev++; store.stats.dayJev++; }
      const p = r.answers?.customers?.noul;
      return typeof p === "number" && Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : undefined;
    } catch { return undefined; }
  }
  async function evaluate(c: Campaign, run: Run, rep: Report & { text: string }) {
    if (!run.merged) {
      // Slop never reaches the board: an unsourced or generic report is discarded whole; a niche without a named
      // buyer, a place, an observed price and linked pains is left out (and the run says why).
      const whole = reportProblems(rep, rep.text);
      const rejected = rep.niches.map((n) => ({ name: n.name, why: whole.length ? "the report was discarded" : nicheProblems(n).join("; ") })).filter((x) => x.why);
      const good = whole.length ? [] : rep.niches.filter((n) => !nicheProblems(n).length);
      const ranked = good.sort((a, b) => rubric(b.scores, b.evidence.length) - rubric(a.scores, a.evidence.length));
      const withJev: (ParsedNiche & { jev?: number })[] = [];
      for (let i = 0; i < ranked.length; i++) withJev.push({ ...ranked[i], jev: i < 3 ? await jevFor(c, ranked[i]) : undefined });
      if (run.state !== "evaluating") return; // skipped or stopped meanwhile
      const before = c.board;
      const { board, ids } = mergeNiches(before, withJev, run.n, now());
      const keep = !whole.length && keepRun(before, board, ids);
      const best = board.find((n) => ids.includes(n.id));
      // Keep or discard, Karpathy-style: only a kept run changes the leaderboard. One synchronous step, then saved:
      // a restart mid-evaluation re-evaluates, it never merges twice.
      if (keep) c.board = board;
      const discardWhy = keep ? undefined : whole.join("; ") || (!best ? "no niche met the bar (named buyer, place, observed price, linked pains)" : best.score < KEEP_MIN ? `its best niche scored ${best.score}; the bar is ${KEEP_MIN}` : "it didn't improve the top 10");
      Object.assign(run, { niches: keep ? ids : [], merged: true, verdict: rep.verdict, title: rep.title, summary: rep.summary, scores: rep.scores, state: keep ? "kept" : "discarded", endedAt: now(), discardWhy, rejected: rejected.length ? rejected : undefined });
      run.best = best ? { id: best.id, name: best.name, score: best.score } : undefined;
      c.openQuestions = [...new Set([...c.openQuestions, ...rep.openQuestions])].slice(-20);
      c.failStreak = 0;
      c.lastRunAt = now();
      note(`#${run.n} ${run.state}: ${ids.length} niche(s)${best ? `, best ${best.name} ${best.score}` : ""}`);
      save();
      // A push when this run put a new niche at #1 with a real score (at most three per campaign).
      const hot = keep ? board.slice(0, 1).filter((n) => n.score >= 60 && ids.includes(n.id) && !c.notified.includes(n.id)) : [];
      if (hot.length && c.notified.length < 3) {
        c.notified.push(hot[0].id);
        save();
        await notify(`Top niche found: ${clip(hot[0].name, 60)}`, `${hot[0].score}/100 · demand ${hot[0].scores.demand ?? "?"}, pay ${hot[0].scores.willingness_to_pay ?? "?"}${hot[0].jev != null ? ` · Jev ${Math.round(hot[0].jev * 100)}%` : ""} · ${clip(c.goal, 60)}`, `research-top-${c.id}`);
      }
    } else if (ACTIVE.includes(run.state)) { run.state = "discarded"; run.endedAt ??= now(); }
    await closeOwn(run);
    save();
  }

  // ── watching a run ────────────────────────────────────────────────────────────────────────
  async function monitor(c: Campaign, run: Run) {
    const rows = allRows();
    const row = findRow(rows, run);
    if (run.state === "starting") {
      if (starting.has(run.id)) return;
      if (row) { run.key = row.key; run.state = "running"; note(`#${run.n}: adopted ${row.key} after a restart`); save(); return; }
      if (now() - (run.startedAt ?? run.createdAt) > 120_000) { failRun(c, run, "The deck restarted while this run was starting. It wasn't started again, so nothing runs twice.", { interrupted: true }); save(); }
      return;
    }
    if (run.state === "evaluating") {
      const rep = readReport(run);
      if (rep?.ok) await evaluate(c, run, rep);
      else { failRun(c, run, `The report became unreadable${rep?.error ? ` (${rep.error})` : ""}`); await closeOwn(run); save(); }
      return;
    }
    if (run.state !== "running") return;
    if (row && !run.key) run.key = row.key;
    const rep = readReport(run);
    if (rep?.ok) {
      run.reportAt ??= now();
      // Written and the agent has finished its turn (or the file has sat still for five minutes).
      if (!row || DONE_STATUSES.has(row.status) || now() - run.reportAt > 5 * 60_000) {
        run.state = "evaluating";
        save();
        await evaluate(c, run, rep);
      }
      return;
    }
    const age = now() - (run.startedAt ?? run.createdAt);
    if (age > runTimeout(c)) {
      await closeOwn(run);
      failRun(c, run, `No valid report after ${Math.max(1, Math.round(runTimeout(c) / 60_000))} min${rep && !rep.ok ? ` (the file is there but ${rep.error})` : ""}`);
      save();
      return;
    }
    if (!row) {
      if (age > 90_000) { run.closed = "gone"; failRun(c, run, "The session was closed before it wrote its report"); save(); }
      return;
    }
    // Its own folder opened on Claude's "trust this folder?" question: answer yes, once, for its own session only.
    if (row.status === "blocked" && !run.trustAnswered && age < 5 * 60_000 && deps.screen && deps.keys && canClose(row, run)) {
      const text = await deps.screen(row.key).catch(() => "");
      if (TRUST_RE.test(text)) { run.trustAnswered = true; await deps.keys(row.key, ["enter"]).catch(() => {}); note(`#${run.n}: answered the folder-trust question`); save(); }
    }
    // A restart can cut the first message's delivery short: hand it over once more, same session.
    if (!run.redelivered && run.prompt && deps.send && age > 4 * 60_000 && (row.status === "idle" || row.status === "empty") && !row.firstPrompt && canClose(row, run)) {
      run.redelivered = true;
      await deps.send(row.key, run.prompt).catch(() => {});
      note(`#${run.n}: re-sent the research prompt`);
      save();
    }
  }

  // ── the loop ─────────────────────────────────────────────────────────────────────────────
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      rollDay();
      for (const c of store.campaigns) { const r = activeRun(c); if (r) await monitor(c, r); }
      if (store.halted || planning || store.campaigns.some((c) => activeRun(c))) return;
      const ready = store.campaigns.filter((c) => c.status === "running").sort((a, b) => (a.lastRunAt ?? a.startedAt) - (b.lastRunAt ?? b.startedAt));
      let dirty = false;
      for (const c of ready) {
        const nx = nextStep(c, now(), store.halted);
        if (nx.act === "done") {
          c.status = "done"; c.finishedAt = now(); c.waiting = undefined; c.reason = nx.why; dirty = true;
          const top = c.board[0];
          save();
          await notify(`Research finished: ${clip(c.goal, 50)}`, top ? `Top niche: ${clip(top.name, 60)} (${top.score}/100). ${c.runs.filter((r) => r.state === "kept").length} of ${c.runs.length} runs kept.` : `${c.runs.length} runs, no niche scored yet.`, `research-done-${c.id}`);
        } else if (nx.act === "pause") {
          c.status = "paused"; c.reason = nx.why; c.waiting = undefined; dirty = true;
          save();
          await notify(`Research paused: ${clip(c.goal, 50)}`, `${nx.why}. Open Discover → Research to look, then resume.`, `research-paused-${c.id}`);
        } else if (nx.act === "wait") { if (c.waiting !== nx.why) { c.waiting = nx.why; dirty = true; } }
        else if (nx.act === "plan") { await planAndStart(c); return; }
      }
      if (dirty) save();
    } finally { busy = false; }
  }
  let timer: Timer | undefined;
  function start() { if (!timer) { timer = setInterval(() => { tick().catch((e) => note(`tick: ${e?.message ?? e}`)); }, conf.tickMs ?? 4000); (timer as any).unref?.(); } setTimeout(() => tick().catch(() => {}), 500); }

  return {
    conf, deps, now, save, note, log, tick, start, closeOwn, allRows, fakes, tilde,
    get store() { return store; },
    starting: (id: string) => starting.has(id), planning: () => planning, looping: () => !!timer,
  };
}
