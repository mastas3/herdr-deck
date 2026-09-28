// Project pages: a journey for every project, from the first idea to where it's heading.
//
// The model is built from local evidence only (git, the wiki, the deck's session history across machines, live
// sessions, saved plans and leads, optional read-only GitHub and Gumroad numbers, and what you log by hand), cached
// per project in ~/.config/herdr-deck/journeys/, and rebuilt in the background when its inputs change: each source
// has its own fingerprint (git refs, wiki mtimes) or time-to-live (GitHub, Gumroad), so a rebuild only re-reads what
// moved (journey-service.ts). The AI read (journey-ai.ts) runs on first open, at most daily after that, or on Regenerate.
//
// Milestones are evaluated from the evidence on every build: a milestone is unlocked only when a measured value
// reaches its target (and says where the number came from) or you marked it yourself with a note.
import { guardLadder, guessNature, SOURCES, templateLadder, type AiResult, type DigestInput, type LadderItem, type Nature } from "./journey-ai";
import { clip, hash, type GitData, type JEvent, type Link, type Metric, type Series, type SideQuestRaw } from "./journey-collect";
import { agentMs, sessionEvents, worktreeOf, type GhData, type GumroadData, type SessRec, type WikiData } from "./journey-sources";

const DAY = 86_400_000;
export const V = 3; // bump when the cached shape changes

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
export type ManualData = { metrics: ManualEntry[]; unlocks: ManualUnlock[]; ladder?: LadderItem[] }; // ladder: seeded by a quest run (the quests plugin)

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
