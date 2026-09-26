"use strict";
// ── Project page (journeys) ─────────────────────────────────────────────────── <journey>
// Every project as a journey: origin → turns → now → where it's heading, with side quests branching off, milestone
// flags on the line and a ladder of milestones that unlock from evidence. Data comes from /api/journey (src/journey.ts),
// cached on the server; the graph is one inline SVG drawn from that data (no libraries), re-laid out on pan/zoom.
S.jp = { name: null, data: new Map(), idx: null, q: "", all: false, loading: new Set(), polls: 0, intro: new Set(), card: null };
const J_ICON = {
  flag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 14.5V2"/><path d="M3.5 2.5h8l-1.8 3 1.8 3h-8"/></svg>',
  lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
  trophy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5 2.5h6v3.5a3 3 0 0 1-6 0z"/><path d="M5 3.5H2.8v1a2.3 2.3 0 0 0 2.3 2.3M11 3.5h2.2v1a2.3 2.3 0 0 1-2.3 2.3M8 9v2.5M5.5 14h5M6.5 11.5h3V14h-3z"/></svg>',
  git: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="2.4"/><path d="M1.5 8h4.1M10.4 8h4.1"/></svg>',
  chat: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/></svg>',
  doc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M6.3 8.3h4M6.3 10.8h4"/></svg>',
  turn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5c4 0 5-2 5.5-5.5S10 3 13.5 3"/><path d="M10.8 1.8 13.5 3l-1.3 2.6"/></svg>',
  branch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="5.5" r="1.6"/><path d="M4 5.1v5.8M12 7.1c0 3-3 3.4-6.6 4.3"/></svg>',
  spark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 1.5 9.4 6.6l5.1 1.4-5.1 1.4L8 14.5 6.6 9.4 1.5 8l5.1-1.4z"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.2v9.6L12.8 8z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h10"/></svg>',
  fit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 5.5V2.5h3M14 5.5V2.5h-3M2 10.5v3h3M14 10.5v3h-3"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/></svg>',
  grid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  journey: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.5 11.5c2.5 0 2.5-5 5-5s2.5 4 5 4 2-6 3-7"/><circle cx="1.8" cy="11.5" r=".9" fill="currentColor"/><circle cx="14.4" cy="3.6" r=".9" fill="currentColor"/></svg>',
};
const JDAY = 86_400_000;
const jd10 = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "");
const JDF = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const jdate = (t) => (t ? JDF.format(new Date(t)) : "");
const jnum = (n) => (n == null ? "–" : n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(n * 10) / 10));
const jhue = (p, i = 0) => `oklch(var(--pc-l) var(--pc-c) ${(hue(p || "?") + i * 34) % 360})`;
const jdays = (a, b) => Math.max(1, Math.round((b - a) / JDAY));

function openJourney(name) {
  if (!name) return;
  if (S.jp.name !== name) S.jp.card = null;
  S.jp.name = name;
  setMode("project");
}
function openProjects() { setMode("projects"); }
async function loadJourney(name, opts = {}) {
  if (!name || (S.jp.loading.has(name) && !opts.force)) return;
  S.jp.loading.add(name);
  try {
    const j = await api(opts.regen ? "/api/journey/regenerate" : "/api/journey", { project: name, refresh: !!opts.refresh }, 60_000);
    S.jp.data.set(name, j);
    if (S.jp.name === name && S.mode === "project") renderJourney();
    clearTimeout(loadJourney.t);
    if (j.pending && S.jp.polls < 90) { S.jp.polls++; loadJourney.t = setTimeout(() => { if (S.mode === "project" && S.jp.name === name) loadJourney(name, { force: true }); }, 2000); }
    else S.jp.polls = 0;
  } catch (e) {
    if (!S.jp.data.has(name)) S.jp.data.set(name, { error: e.message });
    if (S.mode === "project") renderJourney();
  } finally { S.jp.loading.delete(name); }
}
async function loadProjects() {
  try { S.jp.idx = await api("/api/journeys", { wait: !S.jp.idx }, 20_000); } catch (e) { S.jp.idx = S.jp.idx ?? { error: e.message, projects: [] }; }
  if (S.mode === "projects") renderProjects();
  if (S.jp.idx?.building) setTimeout(() => { if (S.mode === "projects") loadProjects(); }, 2500);
}

// ── the journey graph ─────────────────────────────────────────────────────────
/** Time → 0..1: calendar time with long empty stretches squeezed, blended with event density so busy weeks get room. */
function jScale(j) {
  const ts = [];
  for (const e of j.events) { ts.push(e.t); if (e.end) ts.push(e.end); }
  for (const q of j.quests) ts.push(q.from, q.to);
  if (j.origin?.t) ts.push(j.origin.t);
  const now = j.now.t;
  const t0 = Math.min(...ts.filter(Boolean), now - 2 * 3600_000), t1 = now;
  const uniq = [...new Set(ts.filter((t) => t >= t0 && t <= t1).concat([t0, t1]))].sort((a, b) => a - b);
  const span = Math.max(1, t1 - t0);
  const G = Math.max(2 * JDAY, span / 22);
  const knots = [[t0, 0]], breaks = [];
  let acc = 0;
  for (let i = 1; i < uniq.length; i++) {
    const d = uniq[i] - uniq[i - 1];
    const dd = d > G ? G * 0.45 : d;
    if (d > G) breaks.push({ a: uniq[i - 1], b: uniq[i] });
    acc += dd;
    knots.push([uniq[i], acc]);
  }
  // Density: every event counts (heavier ones a little more), so a busy afternoon isn't a single dot.
  // Turns count extra, so the stretches where the project changed direction get room for their labels.
  const ev = [...j.events.map((e) => [e.t, Math.sqrt(e.weight || 1)]), ...j.turns.map((t) => [t.t, 9])].sort((a, b) => a[0] - b[0]);
  const W = ev.reduce((n, e) => n + e[1], 0) || 1;
  let c = 0;
  const cdf = [[t0, 0]];
  for (const [t, w] of ev) { c += w; cdf.push([t, c / W]); }
  cdf.push([t1, 1]);
  const interp = (ks, t) => {
    if (t <= ks[0][0]) return ks[0][1];
    let lo = 0, hi = ks.length - 1;
    if (t >= ks[hi][0]) return ks[hi][1];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ks[m][0] <= t) lo = m; else hi = m; }
    const [ta, va] = ks[lo], [tb, vb] = ks[hi];
    return tb === ta ? vb : va + ((t - ta) / (tb - ta)) * (vb - va);
  };
  const f = (t) => 0.5 * (interp(knots, t) / (acc || 1)) + 0.5 * interp(cdf, t);
  return { f, t0, t1, breaks };
}
/** Candidate tick times (years, months, weeks, days, 6 h) between a and b, coarsest first. */
function jTicks(a, b) {
  const out = [];
  const d = new Date(a); d.setHours(0, 0, 0, 0);
  const span = b - a;
  for (let y = new Date(a).getFullYear(); y <= new Date(b).getFullYear() + 1; y++) { const t = new Date(y, 0, 1).getTime(); if (t > a && t < b) out.push({ t, p: 0, l: String(y) }); }
  const MF = new Intl.DateTimeFormat(undefined, { month: "short" }), DF2 = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  for (let m = new Date(new Date(a).getFullYear(), new Date(a).getMonth() + 1, 1); m.getTime() < b; m.setMonth(m.getMonth() + 1)) out.push({ t: m.getTime(), p: 1, l: MF.format(m) });
  if (span < 400 * JDAY) for (let t = d.getTime() + JDAY; t < b; t += JDAY) { const x = new Date(t); if (x.getDate() !== 1) out.push({ t, p: x.getDay() === 1 ? 2 : 3, l: DF2.format(x) }); }
  if (span < 4 * JDAY) for (let t = d.getTime() + 6 * 3600_000; t < b; t += 6 * 3600_000) { const x = new Date(t); if (x.getHours()) out.push({ t, p: 4, l: `${String(x.getHours()).padStart(2, "0")}:00` }); }
  return out.filter((x) => x.t > a && x.t < b).sort((x, y) => x.p - y.p);
}
const J_TRACK = { commits: 0, merge: 0, tag: 0, release: 0, deploy: 0, milestone: 0, session: 1, wiki: -1, log: -1, idea: -1, lead: -1, manual: -1 };
const J_KIND = { commits: "Commits", merge: "Merge", tag: "Tag", release: "Release", deploy: "Deploy", milestone: "Milestone unlocked", session: "Session", wiki: "Wiki", log: "Wiki log", idea: "Plan", lead: "Leads", manual: "You logged" };
const jEsc = (s) => esc(s).replace(/\n/g, " ");
