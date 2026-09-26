// The game layer: a quest board that makes building a real, profitable business fun, without inventing anything.
//
// Everything is read from evidence the deck already has: project journeys (src/journey.ts: releases, deploys, wiki
// entries that say it shipped, milestones unlocked by measured numbers, Gumroad sales, metrics you log with a note),
// proof-of-done checks that passed (src/verify.ts), and what you log here with a link or a note (a lead you contacted,
// a conversation with a user). The rules are in game-rules.ts, today's quests in game-quests.ts and game-daily.ts,
// the week in game-season.ts, files in game-store.ts, leads and runs in game-runs.ts. Idempotent: the same evidence
// never pays twice.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { LadderItem, Runner } from "./journey-ai";
import {
  achievements, currentBoss, dayOf, dayOfWeek, bossesFor, hash, last30, levelOf, levelReach, proofsFromJourney, score, streak, validTz, XP,
  type JourneyLike, type Line, type Proof,
} from "./game-rules";
import type { Quest } from "./game-quests";
import { cleanIdea, isUrl, normUrl, runFolderOk, runLadder, runPrompt, type Run } from "./game-runs";
import { createStore, questKey, type DayQuests } from "./game-store";
import { createDaily, REROLLS_PER_DAY } from "./game-daily";
import { createSeason, type JevApi } from "./game-season";

const DAY = 86_400_000;
export const SWITCH_COOLDOWN = 24 * 3600_000;
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };

export type GameMessage = { kind: "quest"; title: string; body: string; tag?: string; url?: string };
export type GameDeps = {
  dir: string; projectsDir: string; discoverDir: string;
  journeys: { get: (p: string, o?: { noAi?: boolean }) => Promise<any>; index: (o?: { wait?: number }) => Promise<{ projects: any[] }>; seedLadder?: (p: string, ladder: LadderItem[]) => void };
  runner?: Runner; // headless Claude for quests; undefined: rules only
  jev?: JevApi;
  leadsSaved?: () => any[];
  connections?: () => Promise<string[]>;
  checks?: () => { root: string; state: string; sig?: string; at?: number; cmd?: string; ms?: number }[];
  deliver?: (m: GameMessage) => Promise<unknown>;
  changed?: (summary: object) => void;
  now?: () => number;
};

export function createGame(deps: GameDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const store = createStore(deps.dir, now);
  const { ledger } = store;
  const journeys = new Map<string, JourneyLike & Record<string, any>>();
  const stats = { claude: 0, jev: 0, sweeps: 0 };
  let sweeping: Promise<void> | undefined, lastSweep = 0;
  const tz = () => store.tz();
  const bossesOf = (p: string) => { const j = journeys.get(p); return j ? bossesFor(j, ledger, now()) : []; };
  const changed = () => deps.changed?.(summary());

  // ── projects and their journeys ──
  async function tracked(): Promise<string[]> {
    const s = store.ensure();
    const idx = await deps.journeys.index({}).catch(() => ({ projects: [] as any[] }));
    // Projects with a wiki page first: when a worktree or a clone shares a repo's commits, the real project keeps them.
    const recent = idx.projects.filter((x: any) => x.project && ((x.last ?? 0) > now() - 45 * DAY || x.milestones)).sort((a: any, b: any) => Number(!!b.wiki) - Number(!!a.wiki) || (b.last ?? 0) - (a.last ?? 0)).slice(0, 14).map((x: any) => x.project);
    return [...new Set([s.main?.project, s.candidate, ...Object.keys(s.runs), ...recent])].filter((p): p is string => !!p && !s.retired[p]).slice(0, 20);
  }
  async function loadJourney(p: string) {
    try { const j = await deps.journeys.get(p, { noAi: true }); if (j && !j.error && Array.isArray(j.milestones)) journeys.set(p, j); } catch {}
    return journeys.get(p);
  }
  const daily = createDaily({ store, now, stats, journeys, loadJourney, bossesOf, runner: deps.runner, discoverDir: deps.discoverDir, leadsSaved: deps.leadsSaved, connections: deps.connections, changed });
  const season = createSeason({ store, now, jev: deps.jev, bosses: () => [...journeys.keys()].flatMap(bossesOf), stats });

  const checkProof = (c: { root: string; sig?: string; at?: number; cmd?: string; ms?: number }): Proof => ({ id: `check:${c.root}:${c.sig}`, project: basename(c.root), kind: "check", type: "build", t: c.at!, title: "Checks passed", evidence: `${clip(c.cmd ?? "the project's checks", 80)} passed${c.ms ? ` in ${Math.round(c.ms / 1000)} s` : ""}`, link: { project: basename(c.root) }, xp: XP.check });
  /** Read every tracked project's evidence, pay what's new, complete the quests it proves, tell the phone if asked. */
  function sweep(opts: { wait?: boolean } = {}): Promise<void> {
    sweeping ??= (async () => {
      const main = store.ensure().main?.project;
      const ps = await tracked();
      const order = [main, ...ps.filter((p) => p !== main)].filter((p): p is string => !!p);
      for (let i = 0; i < order.length; i += 3) await Promise.all(order.slice(i, i + 3).map(loadJourney));
      const found = [...order, ...journeys.keys()].filter((p, i, a) => a.indexOf(p) === i && journeys.has(p)).flatMap((p) => proofsFromJourney(journeys.get(p)!));
      for (const c of deps.checks?.() ?? []) if (c.state === "pass" && c.sig && c.at) found.push(checkProof(c));
      const fresh = store.record([...found, ...store.manualProofs()]);
      const done = daily.verifyQuests();
      stats.sweeps++; lastSweep = now();
      await notify(fresh, done).catch(() => {});
      changed();
    })().finally(() => { sweeping = undefined; });
    return opts.wait ? sweeping : Promise.resolve();
  }
  /** A check that passed (verify.ts): kept, since checks.json only remembers the latest result. */
  function onCheck(root: string, r: { state: string; sig?: string; at?: number; cmd?: string; ms?: number }) {
    if (!store.state || r.state !== "pass" || !r.sig) return;
    const p = checkProof({ root, ...r, at: r.at ?? now() });
    if (!store.keepCheck(p)) return;
    notify(store.record([p]), daily.verifyQuests()).catch(() => {});
    changed();
  }

  // ── what you log here: leads contacted, conversations ──
  function log(body: any) {
    const project = String(body.project ?? store.ensure().main?.project ?? "").trim();
    if (!project) throw new Error("Which project? Pick a main quest first, or name one");
    const url = isUrl(body.url) ? body.url : undefined, note = clip(body.note, 240);
    let p: Proof;
    if (body.kind === "lead") {
      if (!url) throw new Error("A lead needs the link to their post or profile: that's the proof");
      p = { id: `lead:${normUrl(url)}`, project, kind: "lead", type: "talk", t: now(), title: clip(`Contacted: ${body.title || note || new URL(url).hostname}`, 90), evidence: `you contacted them: ${url}${note ? ` (${note})` : ""}`, link: { url, project }, xp: XP.lead };
    } else if (body.kind === "talk") {
      if (note.length < 8) throw new Error("Say who you talked to and one thing they said (a few words)");
      p = { id: `talk:${project}:${hash(`${url ?? ""}|${note}`)}:${store.today()}`, project, kind: "talk", type: "talk", t: now(), title: clip(`Talked to a user: ${note}`, 90), evidence: `logged by you${url ? `: ${url}` : ""} (${note})`, link: url ? { url, project } : { project }, xp: XP.talk };
    } else throw new Error("Log a lead (with its link) or a conversation (with a note)");
    const line = store.addManual(p);
    if (!line) throw new Error(body.kind === "lead" ? "You already logged that lead: the same evidence never pays twice" : "Already logged");
    notify([line], daily.verifyQuests()).catch(() => {});
    return line;
  }
  function undo(id: string) {
    const l = ledger.find((x) => x.id === id);
    if (!l || !store.proofs.some((p) => p.id === id)) throw new Error("Only what you logged here can be undone");
    if (now() - l.at > DAY) throw new Error("It's been more than a day: it stays in the ledger");
    store.unlog(id);
    daily.reopen(id);
  }

  // ── main quest, retiring, runs ──
  function setMain(project: string | null, confirm = false) {
    const s = store.ensure();
    const p = project ? String(project).trim() : null;
    if (p && s.retired[p]) throw new Error(`${p} is retired. Bring it back first.`);
    if (s.main?.project === p) return { ok: true, main: s.main };
    const since = s.main ? now() - s.main.since : Infinity;
    if (s.main && since < SWITCH_COOLDOWN && !confirm) {
      const h = Math.max(1, Math.round(since / 3600_000));
      return { ok: false, needsConfirm: true, message: `You picked ${s.main.project} ${h} hour${h === 1 ? "" : "s"} ago. Switching makes ${p ?? "nothing"} the main quest (proofs count double there) and ${s.main.project} a side quest (capped each day).`, cooldownLeft: SWITCH_COOLDOWN - since };
    }
    s.main = p ? { project: p, since: now() } : null;
    s.history.push({ project: p, from: now() });
    if (s.candidate === p) s.candidate = undefined;
    store.saveState();
    if (p) loadJourney(p).then(() => daily.ensureQuests()).catch(() => {});
    changed();
    return { ok: true, main: s.main };
  }
  function retire(project: string, note: string, undo = false) {
    const s = store.ensure();
    const p = String(project ?? "").trim();
    if (!p) throw new Error("Which project?");
    if (undo) { if (s.retired[p]) { delete s.retired[p]; store.saveState(); store.unlog(`prune:${p}`); } return; }
    const why = clip(note, 200);
    if (why.length < 4) throw new Error("Say why it's retired (a few words): that's the evidence");
    s.retired[p] = { at: now(), note: why };
    if (s.main?.project === p) { s.main = null; s.history.push({ project: null, from: now() }); }
    if (s.candidate === p) s.candidate = undefined;
    store.saveState();
    const last = journeys.get(p)?.now?.last;
    const quiet = last ? `quiet for ${Math.round((now() - last) / DAY)} days` : "";
    const line = store.addManual({ id: `prune:${p}`, project: p, kind: "prune", type: "prune", t: now(), title: `Retired ${p}`, evidence: [why, quiet].filter(Boolean).join(" · "), link: { project: p }, xp: XP.prune });
    notify(line ? [line] : [], []).catch(() => {});
  }
  /** An idea becomes a run: its ladder seeded on the project page, a candidate main quest, a prompt for the first quest. */
  function startRun(idea: any) {
    const s = store.ensure();
    const r = cleanIdea(idea);
    if ("error" in r) throw new Error(r.error);
    const prev = s.runs[r.id];
    const run: Run = { ...prev, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)), createdAt: prev?.createdAt ?? now() } as Run;
    s.runs[run.id] = run;
    if (s.main?.project !== run.id) s.candidate = run.id;
    delete s.retired[run.id];
    store.saveState();
    deps.journeys.seedLadder?.(run.id, runLadder(run));
    const cwd = `${deps.projectsDir.replace(/\/+$/, "")}/${run.id}`;
    const exists = existsSync(cwd);
    const quest = { title: `Ship the offer page for ${run.name}`, why: `Milestone one: a page ${run.buyer ?? "your buyers"} can read and buy from.` };
    return { ok: true, run, project: run.id, cwd, exists, mkdir: !exists && runFolderOk(cwd, deps.projectsDir), isMain: s.main?.project === run.id, main: s.main?.project ?? null, quest, prompt: runPrompt(run, cwd, quest, exists), label: clip(run.name, 40) };
  }

  // ── push: completions, boss hits and new achievements, only for devices that asked (push.ts "quests") ──
  async function notify(fresh: Line[], done: { q: Quest; dq: DayQuests }[]) {
    const s = store.state;
    if (!s || !deps.deliver) return;
    const msgs: GameMessage[] = [];
    const seen = new Set(s.notified);
    const mark = (id: string) => { if (seen.has(id)) return false; seen.add(id); s.notified.push(id); return true; };
    for (const { q } of done) if (mark(`q:${q.id}`)) msgs.push({ kind: "quest", title: `Quest done: ${clip(q.title, 60)}`, body: `+${q.xp} XP · ${clip(q.evidence?.title ?? "", 90)}`, tag: `quest:${q.id}`, url: "/?quests=1" });
    const main = s.main?.project;
    for (const l of fresh) {
      if (l.main === null || l.at - l.t > 7 * DAY || l.project !== main || !(l.kind === "sale" || (l.kind === "metric" && l.type !== "build"))) continue; // history found late isn't news
      const b = bossesOf(main).find((x) => x.hits.some((h) => h.id === l.id)); // the boss this proof actually hit
      if (b && mark(`hit:${l.id}`)) msgs.push({ kind: "quest", title: b.state === "defeated" ? `Boss defeated: ${b.title}` : `Boss hit: ${b.title}`, body: `${clip(l.title, 80)} · ${b.state === "defeated" ? "milestone unlocked" : `${Math.round(b.hp * 100)}% health left`}`, tag: `boss:${b.id}`, url: "/?quests=1" });
    }
    for (const a of achievements(ledger, { bosses: [...journeys.keys()].flatMap(bossesOf), quests: [], tz: tz() })) if (a.at && a.at >= s.startedAt && mark(`a:${a.id}`)) msgs.push({ kind: "quest", title: `Achievement: ${a.title}`, body: clip(a.evidence ?? a.desc, 120), tag: `ach:${a.id}`, url: "/?quests=1" });
    if (s.notified.length > 800) s.notified = s.notified.slice(-600);
    store.saveState();
    if (msgs.length > 2) await deps.deliver({ kind: "quest", title: `${msgs.length} updates on the quest board`, body: msgs.slice(0, 4).map((m) => `• ${m.title}`).join("\n"), tag: "quests", url: "/?quests=1" });
    else for (const m of msgs) await deps.deliver(m);
  }
  /** The morning digest's quest lines (writing today's quests first if needed; bounded wait). */
  async function digestLines(): Promise<string[]> {
    const main = store.state?.main?.project;
    if (!main) return [];
    await Promise.race([sweep({ wait: true }).then(() => daily.ensureQuests({ wait: true })), Bun.sleep(90_000)]).catch(() => {});
    const b = currentBoss(bossesOf(main));
    return [`Main quest: ${main}${b ? ` · boss: ${b.title} (${b.known ? `${b.value} of ${b.target}` : "not measured yet"})` : ""}`, ...(store.quests[questKey(store.today(), main)]?.items ?? []).map((q, i) => `${i + 1}. ${q.title} (+${q.xp * XP.mainMultiplier} XP)`)];
  }
  /** Every minute on the hub: a sweep every five, and on Sunday evening the week's review (a quest push). */
  async function tick() {
    const s = store.state;
    if (!s) return;
    const w = season.weekKey(), id = `week:${w}`;
    if (dayOfWeek(store.today()) === 0 && new Date(now()).getHours() >= 18 && deps.deliver && !s.notified.includes(id)) {
      s.notified.push(id); store.saveState();
      const sb = season.board();
      await deps.deliver({ kind: "quest", title: "Your week, reviewed", body: `${sb.shipped.length} shipped · ${sb.sold} sold · ${sb.talks} conversations · ${sb.xp} XP${s.weeks[w]?.goal ? `\nGoal: ${clip(s.weeks[w]!.goal, 80)}` : ""}`, tag: "season", url: "/?quests=1" }).catch(() => {});
    }
    if (now() - lastSweep > 5 * 60_000) await sweep({ wait: true }).catch(() => {});
  }

  // ── what the page gets ──
  const jsum = (p: string) => {
    const j: any = journeys.get(p);
    if (!j) return { project: p, loading: true };
    const next = j.milestones.find((m: any) => m.id === j.next?.[0]) ?? j.milestones.find((m: any) => m.state !== "unlocked");
    return { project: p, pitch: j.pitch, status: j.status, nature: j.nature, stage: j.stage?.title, root: j.root, last: j.now?.last, next: next ? { id: next.id, title: next.title, value: next.value, target: next.target, unit: next.unit, pct: next.pct ?? 0 } : undefined };
  };
  function summary() {
    const s = store.state;
    if (!s) return { started: false };
    const sc = score(ledger, { tz: tz() }), lv = levelOf(sc.lines), st = streak(ledger, store.today(), tz()), d = sc.days.get(store.today());
    return { started: true, level: lv.name, levelId: lv.id, rank: lv.rank, streak: st.current, streakToday: st.today, xpToday: (d?.main ?? 0) + (d?.side ?? 0) + (d?.before ?? 0), main: s.main?.project ?? null, questsOpen: s.main ? store.quests[questKey(store.today(), s.main.project)]?.items.filter((q) => q.state !== "done").length ?? null : null };
  }
  function board() {
    const s = store.ensure(), today = store.today(), main = s.main?.project;
    const sc = score(ledger, { tz: tz() }), reach = levelReach(sc.lines), st = streak(ledger, today, tz());
    const day = sc.days.get(today) ?? { main: 0, side: 0, allowance: XP.sideFloor, before: 0 };
    const bosses = new Map([...journeys.keys()].map((p) => [p, bossesOf(p)]));
    const qdone = Object.values(store.quests).flatMap((x) => x.items.filter((q) => q.state === "done" && q.doneAt).map((q) => ({ at: q.doneAt!, title: q.title, id: q.id })));
    // Revenue: Gumroad through the journeys, each product counted once.
    const gum = new Map<string, { total: number; last30: number }>();
    for (const j of journeys.values()) { const r = j.metrics.find((m) => m.key === "gumroad.revenue"); if (r && j.sources?.gumroad && !gum.has(j.sources.gumroad)) gum.set(j.sources.gumroad, { total: r.value, last30: last30(r.series, now()) }); }
    const dq = main ? store.quests[questKey(today, main)] : undefined;
    const todayLines = sc.lines.filter((l) => dayOf(l.t, tz()) === today);
    const wk = s.weeks[season.weekKey()] ?? {}, sb = season.board();
    return {
      ok: true, now: now(), day: today, week: season.weekKey(), startedAt: s.startedAt, pending: !!sweeping || [...daily.generating.keys()].some((k) => k.startsWith(today)),
      level: levelOf(sc.lines, reach),
      xp: { total: sc.total, today: day.main + day.side + day.before, main: day.main, side: day.side, allowance: day.allowance },
      streak: { current: st.current, best: st.best, today: st.today, atRisk: st.atRisk },
      revenue: { total: [...gum.values()].reduce((a, x) => a + x.total, 0), last30: [...gum.values()].reduce((a, x) => a + x.last30, 0), products: [...gum.keys()], sales: sc.lines.filter((l) => l.kind === "sale").length },
      main: main ? { ...jsum(main), since: s.main!.since, bosses: bosses.get(main) ?? [], run: s.runs[main] } : null,
      candidate: s.candidate ? { ...jsum(s.candidate), run: s.runs[s.candidate] } : null,
      suggest: main ? [] : [...journeys.keys()].filter((p) => !s.retired[p]).map((p) => ({ ...jsum(p), boss: currentBoss(bosses.get(p) ?? [])?.title })).sort((a: any, b: any) => Number(b.nature === "consumer-app") - Number(a.nature === "consumer-app") || (b.last ?? 0) - (a.last ?? 0)).slice(0, 6),
      quests: dq ? { source: dq.source, model: dq.model, note: dq.note, items: dq.items, rerollsLeft: Math.min(dq.spares.length, Math.max(0, REROLLS_PER_DAY - dq.rerolls)), rejected: dq.rejected ?? [] } : { items: [] as Quest[], generating: !!main, rerollsLeft: 0, rejected: [] },
      log: sc.lines.filter((l) => l.kind !== "revoke").slice(-60).reverse().map((l) => ({ id: l.id, t: l.t, project: l.project, kind: l.kind, type: l.type, title: l.title, evidence: l.evidence, link: l.link, xp: l.xp, eff: l.eff, capped: l.capped, main: l.main, undo: store.proofs.some((p) => p.id === l.id) && now() - l.at < DAY })),
      achievements: achievements(ledger, { bosses: [...bosses.values()].flat(), quests: qdone, tz: tz() }),
      // Side quests: XP today counts only lines since the game started (history dated today isn't side-quest XP).
      side: [...journeys.keys()].filter((p) => p !== main && !s.retired[p]).map((p) => { const ls = todayLines.filter((l) => l.project === p && l.main === false), b = currentBoss(bosses.get(p) ?? []); return { ...jsum(p), xpToday: ls.reduce((a, l) => a + l.eff, 0), capped: ls.some((l) => l.capped), boss: b ? { title: b.title, hp: b.hp } : undefined }; }).sort((a, b) => b.xpToday - a.xpToday || (b.last ?? 0) - (a.last ?? 0)),
      retired: Object.entries(s.retired).map(([project, r]) => ({ project, ...r })),
      season: { week: season.weekKey(), sunday: dayOfWeek(today) === 0, goal: wk.goal, lessons: wk.lessons, judge: wk.judge, dispute: wk.dispute, board: sb, jev: !!deps.jev?.available() },
      stats: { ...stats },
    };
  }

  async function handle(path: string, body: any): Promise<any> {
    switch (path) {
      case "/api/game": {
        const s = store.ensure();
        if (validTz(body?.tz) && s.tz !== body.tz) { s.tz = body.tz; store.saveState(); }
        if (!lastSweep) await Promise.race([sweep({ wait: true }), Bun.sleep(6_000)]);
        else if (body?.refresh || now() - lastSweep > 60_000) sweep();
        daily.ensureQuests();
        return board();
      }
      case "/api/game/main": { const r = setMain(body.project ?? null, !!body.confirm); return { ...r, board: r.ok ? board() : undefined }; }
      case "/api/game/quests": if (body.op === "reroll") daily.reroll(String(body.id ?? "")); else await daily.ensureQuests({ wait: true }); return board();
      case "/api/game/quest": { const r = daily.checkOff(String(body.id ?? ""), body); await notify(r.line ? [r.line] : [], [r]).catch(() => {}); return board(); }
      case "/api/game/log": { if (body.op === "undo") { undo(String(body.id ?? "")); return board(); } const line = log(body); return { ...board(), logged: line }; }
      case "/api/game/retire": retire(String(body.project ?? ""), String(body.note ?? ""), !!body.undo); return board();
      case "/api/game/week": season.setWeek(body); return board();
      case "/api/game/season": if (body.op === "dispute") await season.dispute(String(body.note ?? "")); else await season.judge(); return board();
      case "/api/game/run": { const r = startRun(body.idea ?? body); sweep(); return r; }
    }
    return undefined;
  }

  return { handle, sweep, onCheck, digestLines, tick, summary, board, started: () => !!store.state, ensureQuests: daily.ensureQuests, stats, _state: () => store.state };
}
