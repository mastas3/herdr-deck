// Project pages: a journey for every project, from the first idea to where it's heading.
//
// The model is built from local evidence only (git, the wiki, the deck's session history across machines, live
// sessions, saved plans and leads, optional read-only GitHub and Gumroad numbers, and what you log by hand), cached
// per project in ~/.config/herdr-deck/journeys/, and rebuilt in the background when its inputs change: each source
// has its own fingerprint (git refs, wiki mtimes) or time-to-live (GitHub, Gumroad), so a rebuild only re-reads what
// moved. The AI read (journey-ai.ts) runs on first open, at most daily after that, or on Regenerate.
//
// Milestones are evaluated from the evidence on every build: a milestone is unlocked only when a measured value
// reaches its target (and says where the number came from) or you marked it yourself with a note.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { aiSig, analyze, guardLadder, guessNature, slug, SOURCES, templateLadder, type AiResult, type DigestInput, type LadderItem, type Nature, type Runner } from "./journey-ai";
import {
  agentMs, clip, collectGit, collectGitHub, collectGumroad, collectNotes, collectWiki, dayKey, gitSig, hash, nameRe, sessionEvents, worktreeOf,
  type GhData, type GitData, type GumroadData, type JEvent, type Link, type Metric, type SessRec, type Series, type SideQuestRaw, type WikiData,
} from "./journey-collect";

const HOME = homedir();
const DAY = 86_400_000;
const V = 3; // bump when the cached shape changes

// ── types the page gets ──────────────────────────────────────────────────────────
export type MilestoneState = "locked" | "progress" | "unlocked";
export type Milestone = LadderItem & { state: MilestoneState; value?: number; pct?: number; at?: number; evidence?: string; link?: Link; manual?: boolean; measured: boolean };
export type Quest = Omit<SideQuestRaw, "commits"> & { commits: number; events: string[] };
type QuestW = SideQuestRaw & { events: string[] };
export type Turn = { event: string; t: number; label: string; why?: string };
export type Journey = {
  v: number; project: string; root?: string; builtAt: number; ms: number;
  status: string; tags: string[]; nature: Nature; pitch: string; tldr?: string; wikiPage?: string; urls: string[];
  origin: { t?: number; idea?: string; summary?: string; ideaFrom?: "session" | "wiki" | "git"; session?: Link & { title?: string; t?: number }; commit?: { sha: string; subject: string; t: number }; wiki?: string; parent?: string };
  events: JEvent[]; turns: Turn[]; quests: Quest[];
  now: { t: number; last?: number; live: { key: string; title: string; status: string; agent: string; machine?: string }[]; branch?: string; dirty?: number; defaultBranch?: string; remote?: string; github?: string; head?: string };
  metrics: Metric[]; milestones: Milestone[]; stage?: { index: number; title: string }; next: string[];
  heading: { direction: string }; story: string;
  ai: { state: "none" | "running" | "done" | "error"; source?: string; model?: string; at?: number; note?: string; ms?: number; stale?: boolean };
  sources: { git: boolean; wiki: boolean; sessions: number; machines: string[]; github?: string; gumroad?: string; notes: number };
  counts: { commits: number; sessions: number; events: number; turns: number; quests: number; unlocked: number; milestones: number };
};
export type ManualEntry = { metric: string; value: number; at: number; note?: string };
export type ManualUnlock = { id: string; at: number; note: string };
export type ManualData = { metrics: ManualEntry[]; unlocks: ManualUnlock[]; ladder?: LadderItem[] }; // ladder: seeded by a game run (src/game.ts)

// ── metrics from evidence ──────────────────────────────────────────────────────────
/** Cumulative series from event times, thinned to at most `max` points (the last point is always kept). */
export function cumulative(times: number[], max = 160): Series {
  const s = times.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return [];
  const step = Math.max(1, Math.ceil(s.length / max));
  const out: Series = [];
  for (let i = 0; i < s.length; i += step) out.push([s[i], i + 1]);
  if (out.at(-1)![1] !== s.length) out.push([s.at(-1)!, s.length]);
  return out;
}
const d10 = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : "");
const DEPLOY_WORDS = /\b(deploy(ed|s)?|launch(ed)?|shipped|went live|is live|live at|released|published|in production|production release)\b/i;

export type Evidence = { git?: GitData; wiki?: WikiData; sessions: SessRec[]; gh?: GhData; gum?: GumroadData; manual: ManualData; notes: JEvent[] };
export function computeMetrics(ev: Evidence): Metric[] {
  const out: Metric[] = [];
  const add = (m: Metric) => out.push(m);
  const g = ev.git;
  if (g) {
    add({ key: "git.commits", label: SOURCES["git.commits"], unit: "commits", value: g.commits, series: cumulative(g.commitTimes), at: g.last?.t, evidence: `${g.commits} commits in git${g.first ? ` since ${d10(g.first.t)}` : ""}`, link: g.last ? { commit: g.last.sha } : undefined });
    add({ key: "git.active_days", label: SOURCES["git.active_days"], unit: "days", value: g.activeDays.length, series: cumulative(g.activeDays.map((d) => Date.parse(`${d}T12:00:00`))), evidence: `${g.activeDays.length} different days with commits` });
    add({ key: "git.contributors", label: SOURCES["git.contributors"], unit: "people", value: g.authors.length, series: cumulative(g.authors.map((a) => a.first)), evidence: `${g.authors.length} commit author${g.authors.length === 1 ? "" : "s"}` });
    const tagTimes = [...g.tags.map((e) => e.t), ...(ev.gh?.releases ?? []).map((e) => e.t)];
    add({ key: "git.tags", label: SOURCES["git.tags"], unit: "releases", value: Math.max(g.tags.length, ev.gh?.releases.length ?? 0), series: cumulative(g.tags.length >= (ev.gh?.releases.length ?? 0) ? g.tags.map((e) => e.t) : (ev.gh?.releases ?? []).map((e) => e.t)), evidence: g.tags.length ? `tags: ${g.tags.slice(0, 3).map((t) => t.title.replace(/^Tagged /, "")).join(", ")}` : tagTimes.length ? "GitHub releases" : "no tags or releases yet" });
    add({ key: "git.side_quests", label: SOURCES["git.side_quests"], unit: "quests", value: g.quests.length, series: cumulative(g.quests.map((q) => q.from)), evidence: `${g.quests.length} branches off the main line` });
  }
  // Deploys: config that appeared in git, plus log/wiki entries that say something shipped.
  const shipped = [...(ev.wiki?.log ?? []), ...(ev.wiki?.sections ?? [])].filter((e) => DEPLOY_WORDS.test(e.title));
  const setups = g?.deploys ?? [];
  if (g || ev.wiki) {
    add({ key: "deploy.setups", label: SOURCES["deploy.setups"], unit: "setups", value: setups.length, series: cumulative(setups.map((e) => e.t)), evidence: setups.length ? setups.map((e) => e.detail).join(", ") : "no deploy config found", link: setups[0]?.link });
    const urls = ev.wiki?.urls ?? [];
    const live = shipped.length + (urls.length && !shipped.length ? 1 : 0);
    add({ key: "deploy.live", label: SOURCES["deploy.live"], unit: "deploys", value: live, series: cumulative(shipped.map((e) => e.t)), evidence: shipped.length ? `wiki: “${clip(shipped[0].title, 80)}” (${d10(shipped[0].t)})${shipped.length > 1 ? ` and ${shipped.length - 1} more` : ""}` : urls.length ? `wiki links ${urls[0]}` : "nothing in the wiki says it shipped", link: shipped.length ? shipped[0].link : urls[0] ? { url: urls[0] } : undefined });
  }
  const ss = ev.sessions.filter((s) => !s.mention);
  if (ss.length || g) {
    const times = ss.map((s) => s.started ?? s.last ?? 0).filter(Boolean);
    add({ key: "sessions.count", label: SOURCES["sessions.count"], unit: "sessions", value: ss.length, series: cumulative(times), evidence: `${ss.length} agent sessions in the deck's history${new Set(ss.map((s) => s.machine)).size > 1 ? " across machines" : ""}` });
    let h = 0;
    const hs: Series = ss.slice().sort((a, b) => (a.started ?? 0) - (b.started ?? 0)).map((s) => [s.started ?? s.last ?? 0, Math.round((h += agentMs(s) / 3600_000) * 10) / 10]);
    add({ key: "sessions.agent_hours", label: SOURCES["sessions.agent_hours"], unit: "h", value: Math.round(h * 10) / 10, series: hs.length > 160 ? hs.filter((_, i) => i % Math.ceil(hs.length / 160) === 0 || i === hs.length - 1) : hs, evidence: `estimated from ${ss.length} session spans (capped per prompt and at 8 h)` });
    let p = 0;
    add({ key: "sessions.prompts", label: SOURCES["sessions.prompts"], unit: "prompts", value: ss.reduce((n, s) => n + (s.asks ?? 0), 0), series: ss.slice().sort((a, b) => (a.started ?? 0) - (b.started ?? 0)).map((s) => [s.started ?? 0, (p += s.asks ?? 0)] as [number, number]).filter((_, i, a) => a.length <= 160 || i % Math.ceil(a.length / 160) === 0 || i === a.length - 1), evidence: "prompts you sent in those sessions" });
  }
  const gh = ev.gh;
  if (gh?.ok) {
    const url = gh.url ? { url: gh.url } : undefined;
    add({ key: "github.stars", label: SOURCES["github.stars"], unit: "stars", value: gh.stars, at: gh.at, evidence: `GitHub ${gh.repo}${gh.private ? " (private)" : ""}: ${gh.stars} stars`, link: url });
    add({ key: "github.external_stars", label: SOURCES["github.external_stars"], unit: "stars", value: gh.externalStars.at(-1)?.[1] ?? 0, series: gh.externalStars, evidence: `stars by accounts other than ${gh.owner ?? "the owner"}`, link: url });
    add({ key: "github.forks", label: SOURCES["github.forks"], unit: "forks", value: gh.forks, at: gh.at, evidence: `GitHub ${gh.repo}: ${gh.forks} forks`, link: url });
    add({ key: "github.external_issues", label: SOURCES["github.external_issues"], unit: "issues", value: gh.externalIssues.at(-1)?.[1] ?? 0, series: gh.externalIssues, evidence: "issues opened by other people", link: url });
    add({ key: "github.releases", label: SOURCES["github.releases"], unit: "releases", value: gh.releases.length, series: cumulative(gh.releases.map((r) => r.t)), evidence: `${gh.releases.length} GitHub releases`, link: url });
  }
  const gum = ev.gum;
  if (gum?.ok && gum.products.length) {
    add({ key: "gumroad.sales", label: SOURCES["gumroad.sales"], unit: "sales", value: gum.sales, series: gum.salesSeries.length > 160 ? gum.salesSeries.filter((_, i, a) => i % Math.ceil(a.length / 160) === 0 || i === a.length - 1) : gum.salesSeries, at: gum.at, evidence: `Gumroad: ${gum.sales} sales of ${gum.products.join(", ")}` });
    add({ key: "gumroad.revenue", label: SOURCES["gumroad.revenue"], unit: "$", value: gum.revenue, series: gum.series.length > 160 ? gum.series.filter((_, i, a) => i % Math.ceil(a.length / 160) === 0 || i === a.length - 1) : gum.series, at: gum.at, evidence: `Gumroad revenue from ${gum.products.join(", ")}` });
  }
  if (ev.wiki?.page || ev.wiki?.log.length) {
    const ws = [...(ev.wiki?.sections ?? []), ...(ev.wiki?.log ?? [])];
    add({ key: "wiki.updates", label: SOURCES["wiki.updates"], unit: "updates", value: ws.length, series: cumulative(ws.map((e) => e.t)), evidence: `${ws.length} dated wiki sections and log entries`, link: { wiki: ev.wiki?.page ?? "log" } });
  }
  // What you logged: each reading is the value on that date (not a running total).
  const byKey = new Map<string, ManualEntry[]>();
  for (const e of ev.manual.metrics) byKey.set(e.metric, [...(byKey.get(e.metric) ?? []), e]);
  for (const [k, es] of byKey) {
    const s = es.slice().sort((a, b) => a.at - b.at);
    const last = s.at(-1)!;
    add({ key: `manual.${k}`, label: k.replace(/_/g, " "), value: last.value, at: last.at, series: s.map((e) => [e.at, e.value]), evidence: `logged by you: ${last.value.toLocaleString("en")} on ${d10(last.at)}${last.note ? ` (${clip(last.note, 80)})` : ""}` });
  }
  return out;
}

// ── milestones ─────────────────────────────────────────────────────────────────────
/** Where each milestone stands. Unlocked needs a measured value at or past the target with its evidence, or your own mark. */
export function evaluate(ladder: LadderItem[], metrics: Metric[], manual: ManualData): Milestone[] {
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  return ladder.map((m) => {
    const mark = manual.unlocks.filter((u) => u.id === m.id).sort((a, b) => a.at - b.at)[0];
    const met = byKey.get(m.source);
    const base = { ...m, measured: !!met };
    if (mark) return { ...base, state: "unlocked" as const, at: mark.at, value: met?.value, pct: 1, manual: true, evidence: `Marked unlocked by you on ${d10(mark.at)}${mark.note ? `: ${clip(mark.note, 140)}` : ""}` };
    if (!met) return { ...base, state: "locked" as const, evidence: m.source.startsWith("manual.") ? "Not measured yet: log it" : "No evidence source for this yet" };
    const pct = Math.max(0, Math.min(1, met.value / m.target));
    if (met.value >= m.target && met.evidence) {
      const cross = met.series?.find(([, v]) => v >= m.target);
      const at = cross?.[0] ?? met.at;
      return { ...base, state: "unlocked" as const, value: met.value, pct: 1, at, evidence: met.evidence, link: met.link };
    }
    return { ...base, state: met.value > 0 ? ("progress" as const) : ("locked" as const), value: met.value, pct, evidence: met.evidence, link: met.link };
  });
}

// ── assembling the journey ───────────────────────────────────────────────────────────
export type Built = { journey: Journey; digest: DigestInput };
export function assemble(project: string, ev: Evidence, ai: AiResult | undefined, extra: { root?: string; live: SessRec[]; now?: number; t0?: number; aiState?: Journey["ai"]["state"]; siblings?: { name: string; sessions: SessRec[] }[] }): Built {
  const now = extra.now ?? Date.now();
  const g = ev.git, w = ev.wiki;
  // Sessions: live rows win over their own history entries; worktree sessions ride their branch's lane.
  const seenIds = new Set<string>();
  const sessions = [...extra.live.map((s) => ({ ...s, live: true })), ...ev.sessions].filter((s) => { const k = s.id || s.key; if (seenIds.has(k)) return false; seenIds.add(k); return true; });
  const quests: QuestW[] = (g?.quests ?? []).map((q) => ({ ...q, sessions: [], events: [] }));
  const sEvents = sessionEvents(sessions);
  const sById = new Map(sessions.map((s) => [`s${hash(s.key)}`, s]));
  for (const e of sEvents) {
    const s = sById.get(e.id)!;
    const wt = worktreeOf(s.cwd);
    if (!wt) continue;
    let q = quests.find((x) => x.branch && (x.branch === wt || x.branch === `worktree-${wt}` || x.branch.endsWith(`/${wt}`)));
    if (!q) {
      q = quests.find((x) => x.kind === "worktree" && x.id === `w${hash(wt)}`);
      if (!q) { q = { id: `w${hash(wt)}`, label: wt.replace(/[-_]+/g, " "), kind: "worktree", branch: wt, from: e.t, to: e.end ?? e.t, status: "active", commits: [], sessions: [], subjects: [], events: [] }; quests.push(q); }
    }
    e.lane = q.id; q.sessions.push(e.id); q.from = Math.min(q.from, e.t); q.to = Math.max(q.to, e.end ?? e.t);
    if (q.kind === "worktree" && !q.commits.length) q.status = now - q.to < 14 * DAY ? "active" : "abandoned";
  }
  // AI-grouped off-topic session clusters become their own quests.
  for (const sq of ai?.sessionQuests ?? []) {
    const es = sEvents.filter((e) => sq.sessions.includes(e.id) && !e.lane);
    if (!es.length) continue;
    const id = `x${hash(sq.label)}`;
    const q: QuestW = { id, label: sq.label, kind: "session", from: Math.min(...es.map((e) => e.t)), to: Math.max(...es.map((e) => e.end ?? e.t)), status: "active", commits: [], sessions: es.map((e) => e.id), subjects: es.map((e) => e.title).slice(0, 6), events: [] };
    q.status = now - q.to < 14 * DAY ? "active" : "abandoned";
    for (const e of es) e.lane = id;
    quests.push(q);
  }
  for (const child of w?.children ?? []) if (!extra.siblings?.some((x) => x.name === child)) quests.push({ id: `k${hash(child)}`, label: child, kind: "spinoff", from: now, to: now, status: "spun-off", commits: [], sessions: [], subjects: [], events: [], note: `spun off into ${child}` });
  // Sibling projects: a lane each, with their sessions on it.
  for (const sib of extra.siblings ?? []) {
    const es = sessionEvents(sib.sessions.map((s) => ({ ...s, mention: false })));
    if (!es.length) continue;
    const id = `k${hash(sib.name)}`;
    const from = Math.min(...es.map((e) => e.t)), to = Math.max(...es.map((e) => e.end ?? e.t));
    for (const e of es) { e.lane = id; e.title = clip(`${sib.name.slice(project.length + 1)}: ${e.title}`, 100); }
    sEvents.push(...es);
    quests.push({ id, label: sib.name.slice(project.length + 1).replace(/[-_]+/g, " "), kind: "spinoff", branch: sib.name, from, to, status: "spun-off", commits: [], sessions: es.map((e) => e.id), subjects: es.map((e) => e.title).slice(0, 6), events: [], note: `its own project: ${sib.name}` });
  }
  const manualEvents: JEvent[] = [
    ...ev.manual.metrics.map((m) => ({ id: `u${hash(`${m.metric}:${m.at}:${m.value}`)}`, t: m.at, kind: "manual" as const, title: `${m.metric.replace(/_/g, " ")} = ${m.value.toLocaleString("en")}`, detail: m.note, weight: 4 })),
  ];
  const events: JEvent[] = [
    ...(g?.mainChunks ?? []), ...(g?.merges ?? []), ...(g?.tags ?? []), ...(g?.deploys ?? []), ...(ev.gh?.releases ?? []),
    ...(w?.sections ?? []), ...(w?.log ?? []), ...sEvents, ...ev.notes, ...manualEvents,
  ].filter((e) => e.t > 0 && e.t <= now + DAY).sort((a, b) => a.t - b.t);
  // Merges carry their quest's lane id only as a pointer; they sit on the main line.
  for (const q of quests) q.events = events.filter((e) => e.lane === q.id && e.kind !== "merge").map((e) => e.id);
  // Spin-offs sit where the project was last active before the child showed up.
  const lastT = events.at(-1)?.t ?? now;
  for (const q of quests) if (q.kind === "spinoff" && !q.sessions.length) { q.from = q.to = lastT; }
  const metrics = computeMetrics({ ...ev, sessions }); // live and worktree sessions count too
  const commitsN = g?.commits ?? 0;
  const nature = ai?.nature ?? guessNature(w?.tags ?? [], `${w?.tldr ?? ""}`);
  const ladder = ev.manual.ladder?.length ? guardLadder(ev.manual.ladder) : ai?.ladder?.length ? guardLadder(ai.ladder) : templateLadder(nature);
  const milestones = evaluate(ladder, metrics, ev.manual);
  // Unlocks become flags on the line.
  for (const m of milestones) if (m.state === "unlocked" && m.at) events.push({ id: `f${hash(m.id)}`, t: m.at, kind: "milestone", title: `Unlocked: ${m.title}`, detail: m.evidence, weight: 6, link: m.link });
  events.sort((a, b) => a.t - b.t);
  let stageI = -1;
  milestones.forEach((m, i) => { if (m.state === "unlocked") stageI = i; });
  const aiNext = (ai?.heading.next ?? []).filter((id) => milestones.some((m) => m.id === id && m.state !== "unlocked"));
  const next = aiNext.length ? aiNext : milestones.filter((m) => m.state !== "unlocked").slice(0, 3).map((m) => m.id);
  // Origin: the first thing you asked for, the first commit, the wiki's own words.
  const own = sessions.filter((s) => !s.mention && (s.started || s.last)).sort((a, b) => (a.started ?? a.last!) - (b.started ?? b.last!));
  const firstS = own[0];
  const firstT = Math.min(...[g?.first?.t, firstS?.started ?? firstS?.last, events[0]?.t].filter((x): x is number => !!x));
  const ideaFromSession = firstS?.first && (!g?.first || Math.abs((firstS.started ?? 0) - g.first.t) < 30 * DAY || (firstS.started ?? 0) < g.first.t);
  const origin: Journey["origin"] = {
    t: Number.isFinite(firstT) ? firstT : undefined,
    idea: ideaFromSession ? clip(firstS!.first, 600) : w?.firstPara ? clip(w.firstPara, 600) : w?.tldr ? clip(w.tldr, 600) : g?.first?.subject,
    ideaFrom: ideaFromSession ? "session" : w?.firstPara || w?.tldr ? "wiki" : g?.first ? "git" : undefined,
    session: firstS ? { session: firstS.key, machine: firstS.machine, title: firstS.title, t: firstS.started ?? firstS.last } : undefined,
    commit: g?.first ? { sha: g.first.sha, subject: clip(g.first.subject, 160), t: g.first.t } : undefined,
    wiki: w?.tldr, parent: w?.parent, summary: ai?.idea,
  };
  const turns: Turn[] = (ai?.turns ?? []).map((x) => { const e = events.find((y) => y.id === x.event); return e ? { event: x.event, t: e.t, label: x.label, why: x.why } : undefined; }).filter((x): x is Turn => !!x).sort((a, b) => a.t - b.t);
  const lastActivity = Math.max(0, ...events.filter((e) => e.kind !== "manual").map((e) => e.end ?? e.t), ...extra.live.map((s) => s.last ?? 0));
  const status = w?.status ?? (extra.live.some((s) => s.status === "working") ? "active" : now - lastActivity > 90 * DAY ? "stale" : "active");
  const dig: DigestInput = {
    project, tldr: w?.tldr, status, tags: w?.tags ?? [], origin: origin.idea, early: own.slice(0, 3).map((x) => x.first ?? "").filter(Boolean), next: w?.next, nature: guessNature(w?.tags ?? [], w?.tldr ?? ""),
    events: events.filter((e) => !e.id.startsWith("f")),
    quests: quests.filter((q) => q.kind !== "spinoff").map((q) => ({ id: q.id, label: q.label, status: q.status, commits: q.commits.length, sessions: q.sessions.length, from: q.from, to: q.to, subjects: q.subjects })),
    metrics,
  };
  for (const q of quests) if (ai?.questLabels[q.id]) q.label = ai.questLabels[q.id]; // after the digest, so its fingerprint doesn't move
  const machines = [...new Set(sessions.map((s) => s.machine).filter(Boolean) as string[])];
  const journey: Journey = {
    v: V, project, root: extra.root, builtAt: now, ms: Date.now() - (extra.t0 ?? Date.now()),
    status, tags: w?.tags ?? [], nature, pitch: ai?.pitch || clip(w?.tldr ?? "", 140), tldr: w?.tldr, wikiPage: w?.page, urls: w?.urls ?? [],
    origin, events, turns,
    quests: quests.map((q) => ({ ...q, commits: q.commits.length })),
    now: { t: now, last: lastActivity || undefined, live: extra.live.map((s) => ({ key: s.key, title: s.title, status: s.status ?? "idle", agent: s.agent, machine: s.machine })), branch: g?.branch, dirty: g?.dirty, defaultBranch: g?.defaultBranch, remote: g?.remote, github: g?.github, head: g?.head },
    metrics, milestones, stage: stageI >= 0 ? { index: stageI, title: milestones[stageI].title } : undefined, next,
    heading: { direction: ai?.heading.direction || (w?.next?.[0] ?? "") }, story: ai?.story ?? "",
    ai: ai ? { state: extra.aiState ?? "done", source: ai.source, model: ai.model, at: ai.at, note: ai.note, ms: ai.ms } : { state: extra.aiState ?? "none" },
    sources: { git: !!g, wiki: !!w?.page, sessions: sessions.length, machines, github: ev.gh?.ok ? ev.gh.repo : ev.gh?.error ? `unavailable: ${ev.gh.error}` : undefined, gumroad: ev.gum ? (ev.gum.ok ? (ev.gum.products.length ? ev.gum.products.join(", ") : "no matching product") : `unavailable: ${ev.gum.error}`) : undefined, notes: ev.notes.length },
    counts: { commits: commitsN, sessions: sessions.filter((s) => !s.mention).length, events: events.length, turns: turns.length, quests: quests.length, unlocked: milestones.filter((m) => m.state === "unlocked").length, milestones: milestones.length },
  };
  return { journey, digest: dig };
}

// ── the service: cache, rebuilds, AI jobs, manual entries, the index ────────────────────────
export type JourneyDeps = {
  /** Past sessions for a project on every machine (history index), plus sessions that name it. */
  sessions: (project: string) => Promise<SessRec[]>;
  /** Live sessions now (rows), for every project. */
  live: () => SessRec[];
  /** Projects the history index knows, with counts. */
  historyProjects?: () => { project: string; n: number; last: number }[];
  /** This machine's history index, read-only: sessions under a folder (worktrees) and by project name (spin-offs). */
  local?: { underRoot: (root: string) => SessRec[]; byProject: (name: string) => SessRec[]; weeks: (since: number) => { project: string; week: number; n: number }[] };
  runner?: Runner;
  gh?: (args: string[]) => Promise<{ ok: boolean; out: string; err: string }>;
  fetch?: typeof fetch;
  now?: () => number;
};
export type JourneyPaths = { dataDir: string; wikiDir: string; projectsDir: string; cacheDir?: string };
type CacheFile = {
  v: number; project: string; journey?: Journey; root?: string;
  git?: { sig: string; data: GitData }; wiki?: { sig: string; data: WikiData };
  gh?: GhData; gum?: GumroadData; ai?: AiResult & { sig: string };
};
const safeName = (p: string) => String(p ?? "").replace(/[^\w.@-]+/g, "_").slice(0, 80);
const REBUILD_AFTER = 45_000;
const AI_EVERY = DAY;

export function createJourneys(paths: JourneyPaths, deps: JourneyDeps) {
  const dir = paths.cacheDir ?? `${paths.dataDir}/journeys`;
  mkdirSync(dir, { recursive: true });
  const now = () => deps.now?.() ?? Date.now();
  const mem = new Map<string, CacheFile>();
  const building = new Map<string, Promise<Journey>>();
  const aiRunning = new Map<string, Promise<void>>();
  let aiQueue: Promise<void> = Promise.resolve();
  const stats = { aiCalls: 0, builds: 0 };
  const aiOff = () => process.env.DECK_JOURNEY_AI === "0";

  const fileOf = (p: string) => `${dir}/${safeName(p)}.json`;
  function load(p: string): CacheFile {
    const hit = mem.get(p);
    if (hit) return hit;
    let c: CacheFile = { v: V, project: p };
    try { const j = JSON.parse(readFileSync(fileOf(p), "utf8")); if (j?.v === V) c = j; } catch {}
    mem.set(p, c);
    return c;
  }
  function save(c: CacheFile) {
    try { const f = fileOf(c.project), tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(c)); renameSync(tmp, f); } catch {}
  }
  // Manual entries: one small file for every project.
  const manualFile = `${dir}/manual.json`;
  let manualAll: Record<string, ManualData> = {};
  try { manualAll = JSON.parse(readFileSync(manualFile, "utf8")); } catch {}
  const manualOf = (p: string): ManualData => ({ metrics: [], unlocks: [], ...manualAll[p] });
  const saveManual = () => { try { const tmp = `${manualFile}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(manualAll, null, 1)); renameSync(tmp, manualFile); } catch {} };

  /** The project's folder on this machine: a live session's root, the history's, or <projects>/<name>. */
  function rootOf(p: string, ss: SessRec[] = []): string | undefined {
    const cands = [...deps.live().filter((s) => s.project === p && !s.machine?.includes("|")).map((s) => s.root), ...ss.filter((s) => !s.mention && s.root).map((s) => s.root), `${paths.projectsDir}/${p}`];
    return cands.find((r): r is string => !!r && r.startsWith(HOME) && existsSync(r) && r.split("/").pop() === p) ?? cands.find((r): r is string => !!r && existsSync(r));
  }

  async function build(p: string, opts: { quick?: boolean } = {}): Promise<Journey> {
    const t0 = Date.now();
    const c = load(p);
    const found = await deps.sessions(p).catch(() => [] as SessRec[]);
    const liveAll = deps.live();
    const live = liveAll.filter((s) => s.project === p);
    const root = rootOf(p, found);
    // Worktree sessions are filed under the worktree's name; they belong here, on their branch's lane.
    const have = new Set([...found, ...live].map((s) => s.id));
    const under = root ? (deps.local?.underRoot(root) ?? []).filter((s) => !have.has(s.id) && s.project !== p && !live.some((l) => l.id === s.id)) : [];
    under.forEach((s) => have.add(s.id));
    // Sibling projects named after this one ("herdr-deck-video") are spin-offs: their sessions ride their own lane.
    const sibs = siblingsOf(p);
    const sibSessions: SessRec[] = [];
    for (const sib of sibs) for (const s of [...liveAll.filter((x) => x.project === sib), ...(deps.local?.byProject(sib) ?? [])]) if (!have.has(s.id)) { have.add(s.id); sibSessions.push({ ...s, project: sib }); }
    const sessions = [...found, ...under];
    // Each source is re-read only when its fingerprint moved (git refs, wiki mtimes) or its time ran out (GitHub, Gumroad).
    const [git, wiki] = await Promise.all([
      (async () => {
        if (!root || !existsSync(`${root}/.git`)) return undefined;
        const sig = await gitSig(root);
        if (c.git && c.git.sig === sig && c.git.data.root === root && sig) {
          // Refs are the same: only the working tree may have changed.
          return c.git.data;
        }
        const data = await collectGit(root, { now: now() });
        if (data) c.git = { sig, data };
        return data;
      })(),
      (async () => { const w = await collectWiki(paths.wikiDir, p); c.wiki = { sig: w.sig, data: w }; return w; })(),
    ]);
    const notes = collectNotes(paths.dataDir, p);
    // GitHub and Gumroad are slow and change slowly: refreshed after this build, in the background, on their own clocks.
    if (!opts.quick && ((git?.github && (!c.gh || now() - c.gh.at > 12 * 3600_000)) || !c.gum || now() - c.gum.at > 6 * 3600_000)) setTimeout(() => refreshExternal(p, git?.github), 0);
    const ev: Evidence = { git, wiki, sessions, gh: c.gh, gum: c.gum, manual: manualOf(p), notes };
    const running = aiRunning.has(p);
    const { journey, digest } = assemble(p, ev, c.ai, { root, live, now: now(), t0, aiState: running ? "running" : undefined, siblings: sibs.map((name) => ({ name, sessions: sibSessions.filter((s) => s.project === name) })) });
    if (c.ai) journey.ai.stale = c.ai.sig !== aiSig(digest);
    c.journey = journey; c.root = root;
    stats.builds++;
    save(c);
    lastDigest.set(p, digest);
    return journey;
  }
  const lastDigest = new Map<string, DigestInput>();
  const external = new Set<string>();
  async function refreshExternal(p: string, github?: string) {
    if (external.has(p)) return;
    external.add(p);
    try {
      const c = load(p);
      if (github && (!c.gh || now() - c.gh.at > 12 * 3600_000)) c.gh = await collectGitHub(github, deps.gh);
      if (!c.gum || now() - c.gum.at > 6 * 3600_000) {
        const pageText = await Bun.file(`${paths.wikiDir}/projects/${p}.md`).text().catch(() => "");
        c.gum = (await collectGumroad(p, pageText, deps.fetch)) ?? { at: now(), ok: false, error: "not configured", products: [], sales: 0, revenue: 0, currency: "usd", series: [], salesSeries: [] };
      }
      save(c);
      await rebuild(p, { quick: true });
    } catch {} finally { external.delete(p); }
  }
  /** Projects whose name starts with this one's ("herdr-deck-video" for "herdr-deck"): folders, live sessions, history. */
  function siblingsOf(p: string): string[] {
    const pre = `${p}-`;
    const names = new Set<string>();
    try { for (const d of readdirSync(paths.projectsDir)) if (d.startsWith(pre)) names.add(d); } catch {}
    for (const s of deps.live()) if (s.project?.startsWith(pre)) names.add(s.project);
    for (const h of deps.historyProjects?.() ?? []) if (h.project.startsWith(pre)) names.add(h.project);
    return [...names].slice(0, 12);
  }

  function rebuild(p: string, opts: { quick?: boolean } = {}): Promise<Journey> {
    const cur = building.get(p);
    if (cur) return cur;
    const job = build(p, opts).finally(() => building.delete(p));
    building.set(p, job);
    return job;
  }

  /** Runs the AI read for a project (one at a time across projects), then rebuilds with it. */
  function startAi(p: string, force = false) {
    if (aiRunning.has(p)) return;
    const job = (aiQueue = aiQueue.then(async () => {
      try {
        const c = load(p);
        let dig = lastDigest.get(p);
        if (!dig) { await rebuild(p); dig = lastDigest.get(p); }
        if (!dig) return;
        const sig = aiSig(dig);
        if (!force && c.ai && c.ai.sig === sig) return;
        if (aiOff() && c.ai && c.ai.source !== "rules") return; // never replace a model's read with rules just because AI is off now
        const res = aiOff() ? await analyze(dig, { runner: async () => { throw new Error("AI is turned off (DECK_JOURNEY_AI=0)"); } }) : await analyze(dig, { runner: deps.runner, onCall: () => { stats.aiCalls++; } });
        c.ai = { ...res, sig };
        save(c);
      } catch {}
    }).finally(() => { aiRunning.delete(p); return rebuild(p, { quick: true }).catch(() => {}); }));
    aiRunning.set(p, job);
  }

  /** The page's data: from cache at once when there is one (rebuilding in the background when it's old). */
  async function get(p: string, opts: { refresh?: boolean; noAi?: boolean } = {}): Promise<Journey & { pending: boolean }> {
    const c = load(p);
    let j = c.journey;
    if (!j || opts.refresh) j = await rebuild(p);
    else if (now() - j.builtAt > REBUILD_AFTER) rebuild(p).catch(() => {});
    if (!opts.noAi) {
      const dig = lastDigest.get(p);
      const aged = c.ai && now() - c.ai.at > AI_EVERY && dig && c.ai.sig !== aiSig(dig);
      if (!c.ai || aged) startAi(p);
    }
    const running = aiRunning.has(p);
    return { ...j, ai: { ...j.ai, state: running ? "running" : j.ai.state === "running" ? (c.ai ? "done" : "none") : j.ai.state }, pending: running || building.has(p) };
  }

  function logMetric(p: string, body: { metric: string; value: number; at?: number; note?: string }) {
    const metric = slug(String(body.metric ?? ""), 30).replace(/-/g, "_");
    const value = Number(body.value);
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(metric) || !Number.isFinite(value)) throw new Error("A metric needs a name and a number");
    const at = Number(body.at) || now();
    const m = (manualAll[p] = manualOf(p));
    m.metrics.push({ metric, value, at, note: body.note ? clip(body.note, 200) : undefined });
    saveManual();
  }
  /** A milestone ladder seeded from an idea (a game run): it wins over the AI's and the template until cleared. */
  function seedLadder(p: string, items: LadderItem[]) {
    const m = (manualAll[p] = manualOf(p));
    m.ladder = guardLadder(items.map((x, i) => ({ ...x, id: slug(x.id || x.title), tier: x.tier ?? i })));
    saveManual();
    const c = load(p);
    c.journey = undefined; // the next open rebuilds with it
  }
  function markUnlocked(p: string, body: { id: string; note?: string; at?: number; undo?: boolean }) {
    const id = slug(String(body.id ?? ""));
    const m = (manualAll[p] = manualOf(p));
    if (body.undo) m.unlocks = m.unlocks.filter((u) => u.id !== id);
    else {
      const note = clip(body.note ?? "", 240);
      if (!note) throw new Error("Say what happened: a note is the evidence");
      m.unlocks = [...m.unlocks.filter((u) => u.id !== id), { id, at: Number(body.at) || now(), note }];
    }
    saveManual();
  }

  // ── the index: every project with a mini activity line ──────────────────────────
  const indexFile = `${dir}/index.json`;
  let gitWeeks: Record<string, { at: number; weeks: number[]; last?: number; commits?: number }> = {};
  try { gitWeeks = JSON.parse(readFileSync(indexFile, "utf8")); } catch {}
  let weeksJob: Promise<void> | undefined;
  const WEEKS = 26;
  function refreshGitWeeks(roots: [string, string][]) {
    if (weeksJob) return weeksJob;
    weeksJob = (async () => {
      const since = now() - WEEKS * 7 * DAY;
      const todo = roots.filter(([p]) => !gitWeeks[p] || now() - gitWeeks[p].at > 3600_000);
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(async ([p, root]) => {
          const { run } = await import("./journey-collect");
          const r = await run(["git", "log", "--all", `--since=${Math.floor(since / 1000)}`, "--format=%at"], { cwd: root, timeoutMs: 6000 });
          const l = await run(["git", "log", "-1", "--all", "--format=%at"], { cwd: root, timeoutMs: 4000 });
          const weeks = new Array(WEEKS).fill(0);
          for (const s of r.out.split("\n")) { const t = Number(s) * 1000; if (!t) continue; const w = Math.floor((now() - t) / (7 * DAY)); if (w >= 0 && w < WEEKS) weeks[WEEKS - 1 - w]++; }
          gitWeeks[p] = { at: now(), weeks, last: Number(l.out.trim()) * 1000 || undefined };
        }));
      }
      try { writeFileSync(indexFile, JSON.stringify(gitWeeks)); } catch {}
    })().finally(() => { weeksJob = undefined; });
    return weeksJob;
  }

  async function index(opts: { wait?: number } = {}) {
    const { readdirSync } = await import("node:fs");
    const { frontmatter } = await import("./journey-collect");
    const out = new Map<string, any>();
    const ensure = (p: string) => { let x = out.get(p); if (!x) { x = { project: p, sessions: 0, live: 0, working: 0, weeks: new Array(WEEKS).fill(0) }; out.set(p, x); } return x; };
    let files: string[] = [];
    try { files = readdirSync(`${paths.wikiDir}/projects`).filter((f) => f.endsWith(".md")); } catch {}
    await Promise.all(files.map(async (f) => {
      const p = f.slice(0, -3);
      const text = await Bun.file(`${paths.wikiDir}/projects/${f}`).text().catch(() => "");
      const { data, body } = frontmatter(text);
      const x = ensure(p);
      x.status = data.status; x.tags = Array.isArray(data.tags) ? data.tags.slice(0, 6) : []; x.updated = Date.parse(String(data.date_updated ?? "")) || undefined;
      x.tldr = clip((body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "").replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1").replace(/[*_`]/g, ""), 160);
      x.wiki = true;
    }));
    for (const h of deps.historyProjects?.() ?? []) { if (h.n < 2 && !out.has(h.project)) continue; const x = ensure(h.project); x.sessions = h.n; x.last = Math.max(x.last ?? 0, h.last ?? 0); }
    const since = now() - WEEKS * 7 * DAY;
    for (const w of deps.local?.weeks(since) ?? []) { const x = out.get(w.project); if (x && w.week >= 0 && w.week < WEEKS) x.weeks[WEEKS - 1 - w.week] += w.n; }
    for (const s of deps.live()) { if (!s.project) continue; const x = ensure(s.project); x.live++; if (s.status === "working") x.working++; x.last = Math.max(x.last ?? 0, s.last ?? 0); }
    let dirs: string[] = [];
    try { dirs = readdirSync(paths.projectsDir).filter((d) => !d.startsWith(".") && existsSync(`${paths.projectsDir}/${d}/.git`)); } catch {}
    for (const d of dirs) ensure(d).root = `${paths.projectsDir}/${d}`;
    const job = refreshGitWeeks([...out.values()].filter((x) => x.root).map((x) => [x.project, x.root]));
    if (opts.wait) await Promise.race([job, Bun.sleep(opts.wait)]);
    for (const x of out.values()) {
      const g = gitWeeks[x.project];
      if (g) { x.commitWeeks = g.weeks; x.last = Math.max(x.last ?? 0, g.last ?? 0); }
      x.last = Math.max(x.last ?? 0, x.updated ?? 0) || undefined;
      const c = mem.get(x.project) ?? (existsSync(fileOf(x.project)) ? load(x.project) : undefined);
      const j = c?.journey;
      if (j) {
        const next = j.milestones.find((m) => m.id === j.next[0]) ?? j.milestones.find((m) => m.state !== "unlocked");
        x.stage = j.stage?.title; x.next = next ? { title: next.title, pct: next.pct ?? 0 } : undefined; x.unlocked = j.counts.unlocked; x.milestones = j.counts.milestones; x.pitch = j.pitch;
        x.turns = j.turns.length; x.quests = j.quests.length;
      }
    }
    const list = [...out.values()].sort((a, b) => (b.working - a.working) || (b.live - a.live) || (b.last ?? 0) - (a.last ?? 0));
    return { projects: list, weeks: WEEKS, building: !!weeksJob };
  }

  async function handle(path: string, body: any): Promise<any> {
    const p = String(body?.project ?? "").trim();
    switch (path) {
      case "/api/journeys": return index({ wait: body?.wait ? 2500 : 0 });
      case "/api/journey": if (!p) throw new Error("Which project?"); return get(p, { refresh: !!body.refresh });
      case "/api/journey/regenerate": if (!p) throw new Error("Which project?"); await rebuild(p); startAi(p, true); return get(p, { noAi: true });
      case "/api/journey/metric": logMetric(p, body); return rebuild(p, { quick: true }).then(() => get(p, { noAi: true }));
      case "/api/journey/unlock": markUnlocked(p, body); return rebuild(p, { quick: true }).then(() => get(p, { noAi: true }));
    }
    return undefined;
  }

  return { get, rebuild, handle, index, logMetric, markUnlocked, seedLadder, startAi, stats, whenAiIdle: () => aiQueue, _cache: (p: string) => load(p) };
}

// ── glue for the server: rows and history hits as session records ─────────────────────────
type HitLike = { key: string; id: string; agent: string; machine?: string; title: string; first?: string; started?: number; last?: number; asks?: number; cwd?: string; root?: string; project?: string };
type RowLike = { key: string; machine?: string; agent: string; status: string; title: string; firstPrompt?: string; startedAt?: number; createdAt?: number; lastActiveAt?: number; cwd: string; projectRoot?: string; project: string; sessionId?: string; branch?: string; empty?: boolean };
export const rowToSess = (r: RowLike): SessRec => ({ key: r.key, id: r.sessionId ?? r.key, agent: r.agent, machine: r.machine, title: r.title, first: r.firstPrompt, started: r.startedAt ?? r.createdAt, last: r.lastActiveAt, cwd: r.cwd, root: r.projectRoot, project: r.project, status: r.status, branch: r.branch, live: true });
/** Live agent sessions; `started` looks up when a session really began (a pane's own times say when the deck saw it). */
export function liveSessions(rows: RowLike[], lookup?: (ids: string[]) => Map<string, { started?: number; asks?: number }>): SessRec[] {
  const out = rows.filter((r) => !r.empty && ["claude", "codex", "opencode"].includes(r.agent)).map(rowToSess);
  const m = lookup?.(out.map((s) => s.id).filter((x) => !x.includes("/")));
  if (m) for (const s of out) { const x = m.get(s.id); if (x?.started) s.started = x.started; if (x?.asks) s.asks = x.asks; }
  return out;
}
/** A project's past sessions on every machine, plus sessions elsewhere whose title or first prompt names it. */
export async function projectSessions(p: string, search: (o: { q?: string; project?: string; limit?: number }) => Promise<HitLike[]>): Promise<SessRec[]> {
  const [own, named] = await Promise.all([search({ project: p, limit: 200 }).catch(() => []), search({ q: p, limit: 80 }).catch(() => [])]);
  const re = nameRe(p);
  const seen = new Set(own.map((h) => h.key));
  const mentions = named.filter((h) => !seen.has(h.key) && h.project !== p && (re.test(h.title ?? "") || re.test(h.first ?? "")));
  const toRec = (h: HitLike, mention: boolean): SessRec => ({ key: h.key, id: h.id, agent: h.agent, machine: h.machine, title: h.title, first: h.first, started: h.started, last: h.last, asks: h.asks, cwd: h.cwd, root: h.root, project: h.project, mention });
  return [...own.map((h) => toRec(h, false)), ...mentions.map((h) => toRec(h, true))];
}
/** This machine's history index, read-only: weekly counts, sessions under a folder, by project, and start times by id. */
export function localHistory(dbPath: string, machine: string) {
  let db: any;
  const q = (sql: string, ...args: any[]): any[] => {
    try {
      if (!db) { const { Database } = require("bun:sqlite"); db = new Database(dbPath, { readonly: true }); db.exec("pragma busy_timeout = 2000;"); }
      return db.query(sql).all(...args);
    } catch { return []; }
  };
  const rec = (r: any): SessRec => ({ key: `h:${r.agent}:${r.id}`, id: r.id, agent: r.agent, machine, title: r.title ?? "", first: r.first ?? "", started: r.started ?? undefined, last: r.last ?? undefined, asks: r.asks ?? 0, cwd: r.cwd ?? "", root: r.root ?? undefined, project: r.project ?? "" });
  return {
    weeks: (since: number) => q("select project, cast((? - started) / 604800000 as integer) week, count(*) n from sess where empty = 0 and project != '' and started > ? group by project, week", Date.now(), since) as { project: string; week: number; n: number }[],
    underRoot: (root: string) => q("select * from sess where empty = 0 and (root like ? or cwd like ?) order by started limit 400", `${root}/%`, `${root}/%`).map(rec),
    byProject: (name: string) => q("select * from sess where empty = 0 and project = ? order by started limit 200", name).map(rec),
    started: (ids: string[]) => { const m = new Map<string, { started?: number; asks?: number }>(); if (ids.length) for (const r of q(`select id, started, asks from sess where id in (${ids.map(() => "?").join(",")})`, ...ids)) m.set(r.id, { started: r.started ?? undefined, asks: r.asks ?? undefined }); return m; },
  };
}
