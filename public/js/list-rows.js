"use strict";
// The session list's rules (priority rank, reason chips, filters) and each row's HTML.
// ── inbox & projects ─────────────────────────────────────────────────────
/** A finished session stops needing you once you've opened it (on any device). */
const unseenDone = (r) => r.status === "done" && !r.seen;
const needsYou = (r) => r.status === "blocked" || unseenDone(r);
/** herdr's "priority" order: an attention queue. Lower rank comes first. */
/** Opened in the last 15 minutes: a new session stays in plain sight even before anything happens in it. */
const fresh = (r) => !!r.bornAt && Date.now() - r.bornAt < 15 * 60_000;
const act = (r) => r.lastActiveAt ?? r.bornAt ?? 0;
function rank(r) {
  if (r.status === "blocked") return 0;
  if (unseenDone(r)) return 1;
  if (r.status === "working") return 2;
  if (r.empty && fresh(r)) return 3;
  if (r.empty) return 6;
  if (r.stale) return 5;
  return 3;
}
/* @pure:list-begin: no globals in here; test/list.test.ts evaluates this block on its own. */
/** A compact span for reason chips: "" under 45 s, then "3m", "2h", "5d", "2mo". */
function span(ms) {
  const s = ms / 1000;
  if (!(s >= 45)) return "";
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 60) return Math.round(s / 86400) + "d";
  return Math.round(s / 86400 / 30) + "mo";
}
/** The chip text for a reason kind at time `now` (re-run by the ticker for chips that carry a time). */
function reasonLabel(k, t, now) {
  const s = t ? span(now - t) : "";
  switch (k) {
    case "perm": return "needs permission";
    case "ask": return "asks you";
    case "wait": return "needs you";
    case "done": return s ? `finished ${s} ago` : "just finished";
    case "work": return s ? `working ${s}` : "working";
    case "new": return "new";
    case "empty": return "empty";
    case "stale": return s ? `stale ${s}` : "stale";
    default: return s ? `idle ${s}` : "idle";
  }
}
/** Why a row sits where it does in the priority list, mirroring rank(). `ask` is the pending decision's kind, if any. */
function reasonOf(r, ask, now) {
  let k, t = 0;
  if (ask === "prompt") k = "perm";
  else if (ask === "question") k = "ask";
  else if (r.status === "blocked") k = "wait";
  else if (r.status === "done" && !r.seen) { k = "done"; t = r.lastActiveAt ?? 0; }
  else if (r.status === "working") { k = "work"; t = r.turnStartedAt && now - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : 0; }
  else if (r.empty) k = r.bornAt && now - r.bornAt < 15 * 60_000 ? "new" : "empty";
  else if (r.stale) { k = "stale"; t = r.lastActiveAt ?? 0; }
  else { k = "idle"; t = r.lastActiveAt ?? 0; }
  return { k, t, text: reasonLabel(k, t, now) };
}
/** Fields that change every few seconds while an agent works; a row that only changed these re-renders at most once a second. */
const VOLATILE = new Set(["now", "step", "todos", "tail", "subagents", "lastActiveAt", "rssKB", "cpu", "procs", "ctxTokens", "cost", "focused", "dirty", "cols", "rows", "_hay"]);
function stableSig(r) {
  const running = (r.subagents ?? []).filter((x) => x.running).length;
  return JSON.stringify(r, (k, v) => (VOLATILE.has(k) ? undefined : v)) + "|" + running + "|" + !!(r.tail?.length || r.now || r.step);
}
/** While the order is frozen: what is shown keeps its place, gone rows drop out, new rows wait. */
function frozenOrder(shown, next) {
  const want = new Set(next), have = new Set(shown);
  return { keys: shown.filter((k) => want.has(k)), held: next.filter((k) => !have.has(k)) };
}
/** The branch most of these rows are on (the first one seen wins a tie), or "". */
function commonBranch(rows) {
  const n = new Map();
  for (const r of rows) if (r.branch) n.set(r.branch, (n.get(r.branch) ?? 0) + 1);
  let best = "", most = 0;
  for (const [b, c] of n) if (c > most) { best = b; most = c; }
  return best;
}
/** One project's rows (already in list order) split by checkout: the main checkout's first, then one sub-section per
 *  linked worktree, in the order its first row comes. `closed` tells which sub-sections are folded (by key). */
function splitWorktrees(proj, rows, closed = {}) {
  const main = [], by = new Map();
  for (const r of rows) {
    if (!r.worktree) { main.push(r); continue; }
    if (!by.has(r.worktree)) by.set(r.worktree, []);
    by.get(r.worktree).push(r);
  }
  const trees = [...by].map(([name, rs]) => {
    const key = `w:${proj}/${name}`;
    return { key, name, rows: rs, branch: commonBranch(rs), root: rs.find((r) => r.projectRoot)?.projectRoot, closed: !!closed[key] };
  });
  // Display order, and what keyboard navigation walks (folded sub-sections are skipped).
  return { main, trees, branch: commonBranch(main), rows: main.concat(...trees.map((t) => t.rows)), open: main.concat(...trees.map((t) => (t.closed ? [] : t.rows))) };
}
/** Each row's time-based state at `now` (a new session reads "empty" after 15 minutes): the list's minute ticker redraws
 *  when this changes, so an idle deck moves such rows without waiting for an event. */
function timeSig(rows, askOf, now) {
  let s = "";
  for (const r of rows) s += r.key + ":" + reasonOf(r, askOf(r), now).k + ";";
  return s;
}
/* @pure:list-end */
function sectionOf(r) {
  const k = rank(r);
  return k <= 1 ? "needs" : k === 2 ? "running" : k === 6 ? "empty" : k === 5 ? "stale" : "quiet";
}
function parseQuery(q) {
  const inc = [], exc = [], is = [], agent = [];
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w.startsWith("is:")) is.push(w.slice(3));
    else if (w.startsWith("agent:")) agent.push(w.slice(6));
    else if (w.startsWith("-") && w.length > 1) exc.push(w.slice(1));
    else inc.push(w);
  }
  return { inc, exc, is, agent };
}
const hayHit = (r) => { const q = parseQuery(S.q); return q.inc.length && q.inc.every((w) => hay(r).includes(w)); };
function hay(r) {
  return (r._hay ??= [r.title, r.project, r.launch, r.branch, r.cwd, r.agent, r.status, r.model, r.tab, r.workspace, machineLabel(r.machine), r.firstPrompt, r.lastMessage, r.now, r.tail.join(" ")].filter(Boolean).join(" \u0001 ").toLowerCase());
}
const inScope = (r) => S.machine === "all" || r.machine === S.machine;
function visibleRows() {
  const q = parseQuery(S.q);
  const out = [];
  for (const r of S.rows.values()) {
    if (!inScope(r)) continue;
    if (q.is.length && !q.is.every((f) => (f === "stale" ? r.stale : f === "dup" ? r.duplicate : f === "empty" ? r.empty : f === "live" ? r.status === "working" || r.status === "blocked" : r.status === f))) continue;
    if (q.agent.length && !q.agent.some((a) => r.agent.startsWith(a))) continue;
    if (q.inc.length || q.exc.length) {
      const h = hay(r);
      if (q.exc.some((w) => h.includes(w))) continue;
      if (!q.inc.every((w) => h.includes(w)) && !(S.deep?.q === S.q && S.deep.byKey.has(r.key))) continue;
    }
    out.push(r);
  }
  const act = (r) => r.lastActiveAt ?? r.startedAt ?? 0;
  const deep = S.deep?.q === S.q ? S.deep.byKey : null;
  // Deep-search hits come first when the words only appear inside the conversation.
  out.sort((a, b) => rank(a) - rank(b) || act(b) - act(a));
  if (deep) out.sort((a, b) => Number(!!hayHit(b)) - Number(!!hayHit(a)) || 0);
  return out;
}

// ── list rendering (keyed; only changed rows touch the DOM) ──────────────
const rowCache = new Map();
const SIMPLE_STATUS = { working: ["Working on it", "✨"], blocked: ["Needs you", "👋"], done: ["Finished", "✅"], idle: ["Resting", "💤"], empty: ["Ready, nothing asked yet", "·"], unknown: ["Status unknown", "?"], history: ["Past session", "🕘"] };
/** The question an agent is waiting on, answerable right in the list (like Claude on the web and phone). */
const pendingAsk = (r) => (S.decisions ?? []).find((d) => d.key === r.key && (d.kind === "prompt" || d.kind === "question") && !answered(d));
/** You answered this very decision (by its id): it stays hidden until the server moves on, and a new one shows at once. */
const answered = (d) => S.done.get(d.key)?.id === (d.id ?? d.question);
function markAnswered(d) { S.done.set(d.key, { id: d.id ?? d.question, t: Date.now() }); }
function rowAsk(r) {
  const d = pendingAsk(r);
  if (!d) return "";
  const opts = d.options.slice(0, 4).map((o) => `<button class="ropt${o.rec ? " rec" : ""}" data-ropt="${esc(o.id)}" title="${esc(o.title)}"><span class="ol">${esc(String(o.id).toUpperCase())}</span>${esc(plain(o.title).slice(0, 44))}${plain(o.title).length > 44 ? "…" : ""}</button>`).join("");
  return `<div class="rask" data-rask="${esc(r.key)}"><div class="rq">${esc(plain(d.question))}</div><div class="ropts">${opts}${d.options.length > 4 ? `<button class="ropt more" data-ropen>+${d.options.length - 4} more</button>` : ""}<button class="ropt ghost" data-rreply>${d.options.length ? "Other…" : "Reply…"}</button></div></div>`;
}
async function answerOption(d, o) {
  if (d.kind === "prompt") await api("/api/keys", { key: d.key, keys: o.keys ?? [String(o.id)] });
  else await sendAnswer(d.key, o.send ?? o.title);
  markAnswered(d);
  api("/api/decide", { key: d.key, action: "answer", choice: String(o.id) }).catch(() => {});
  api("/api/seen", { key: d.key }).catch(() => {});
}

/** Where a session lives: which machine (and herdr workspace), shown under every row in both modes. */
const SRC_ICON = {
  mac: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="3" width="11" height="7.5" rx="1"/><path d="M1 13h14"/></svg>',
  remote: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><path d="M4.5 4.7h.01M4.5 11.2h.01"/></svg>',
  app: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M6 8h4"/></svg>',
  all: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3" width="8" height="6" rx="1"/><rect x="6.5" y="7" width="8" height="6" rx="1"/></svg>',
};
/** Where a row runs, as a small icon (its name and workspace on hover): only when there's more than one place. */
function machIcon(r) {
  if (!r.app && !multiMachine()) return "";
  const m = (S.summary.machines ?? []).find((x) => x.id === r.machine);
  const icon = r.app ? SRC_ICON.app : m && !m.local ? SRC_ICON.remote : SRC_ICON.mac;
  const where = r.app ? "Codex app" : `${machineLabel(r.machine)}${r.workspace ? ` · ${r.workspace}` : ""}${r.hist ? " · history" : ""}`;
  return `<span class="rmach" title="Runs on ${esc(where)}">${icon}</span>`;
}
function srcLine(r) {
  const m = (S.summary.machines ?? []).find((x) => x.id === r.machine);
  const icon = r.app ? SRC_ICON.app : m && !m.local ? SRC_ICON.remote : SRC_ICON.mac;
  const where = r.app ? "Codex app" : r.hist ? `${machineLabel(r.machine)} · history` : `${machineLabel(r.machine)}${r.workspace && !S.simple ? ` · ${r.workspace}` : ""}`;
  return `<span class="src" title="Runs on ${esc(machineLabel(r.machine))}">${icon}<span>${esc(where)}</span></span>`;
}
/** Plugins' chips for a row ("row.chips": (row, "list" | "board") => html), at the start of its status line. */
const rowChips = (r, where) => deckPlugins.each("row.chips", r, where).filter(Boolean).join("");
function simpleRow(r) {
  const [word, em] = SIMPLE_STATUS[r.status] ?? ["", ""];
  return `<span class="dot" style="--c:${statusVar(r.status)}"></span><span class="tl"><b>${esc(r.title || "(untitled)")}</b></span><span class="ago"${r.status === "working" ? "" : ` data-t="${r.lastActiveAt ?? ""}"`}>${r.status === "working" ? em : esc(ago(r.lastActiveAt))}</span><span class="ln"><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span> · <span class="sw" data-s="${r.status}">${esc(word)}</span>${radarChip(r)}${rowChips(r, "list")}</span>${srcLine(r)}${rowAsk(r)}`;
}
/** The reason chip: why this row is ranked where it is ("needs permission", "finished 2m ago", "working 3m", "idle 3d"…). */
function reasonChip(r, why) {
  const tip = why.k === "work" && why.t ? `Working since ${abs(why.t)}` : `Last active ${abs(r.lastActiveAt)}`;
  return `<span class="ago why" data-k="${why.k}"${why.t ? ` data-t="${why.t}" data-why="${why.k}"` : ""} title="${esc(tip)}">${esc(why.text)}</span>`;
}
const RADAR_PHASE = { exploring: "reading and searching", editing: "changing files", testing: "running tests or builds", debugging: "chasing a failure", wrapping_up: "wrapping up" };
const RADAR_WHY = { repeat: "it made the same tool call 3 or more times in its last 8", errors: "3 or more of its last 6 tool calls failed", stall: "this turn has run over 10 minutes without editing a file" };
/** Jev's stuck/drift read on a running session, as a small chip; nothing unless it's fairly sure (70%+). */
function radarChip(r) {
  const e = r.status === "working" && (S.radar ?? []).find((x) => x.key === r.key);
  if (!e) return "";
  const bits = [e.stuck >= 0.7 ? `looping ${Math.round(e.stuck * 100)}%` : "", e.offTask >= 0.7 ? `off task ${Math.round(e.offTask * 100)}%` : ""].filter(Boolean);
  if (!bits.length) return "";
  const tip = `Jev thinks this session may be ${e.stuck >= 0.7 && e.offTask >= 0.7 ? "stuck and off task" : e.stuck >= 0.7 ? "stuck" : "off task"}${e.phase ? `; it looks like it's mostly ${RADAR_PHASE[e.phase] ?? e.phase}` : ""}.\nThe deck asked because ${RADAR_WHY[e.trigger] ?? "it looked unusual"}.\nJust a heads-up: nothing happens on its own.`;
  return `<span class="rchip" title="${esc(tip)}">${esc(bits.join(" · "))}</span>`;
}
function rowHTML(r, byProject, why = reasonOf(r, pendingAsk(r)?.kind, Date.now())) {
  if (S.simple) return simpleRow(r);
  const live = r.status === "working";
  const agoEl = reasonChip(r, why);
  const title = `<span class="tl"><b>${esc(r.title || "(untitled)")}</b> <span class="pane">${paneTag(r)}</span></span>`;
  let line = "";
  const tail = r.tail?.length ? plain(r.tail[r.tail.length - 1]) : "";
  if (r.status === "blocked") line = pendingAsk(r) ? "" : `<span class="ln ask">${esc(tail || "waiting for you")}</span>`;
  else if (live) line = `<span class="ln now">${r.todos?.total ? `<span class="stp">${r.todos.done}/${r.todos.total}</span>` : ""}${r.now ? esc(nowWords(r.now)) : r.step ? esc(r.step) : "thinking…"}</span>`;
  else if (unseenDone(r)) line = `<span class="ln">${esc(plain(r.lastMessage) || tail || "finished")}</span>`;
  else if (r.empty) line = `<span class="ln">${r.agent === "shell" ? "empty shell" : "no conversation yet"}</span>`;
  const hit = S.q && S.deep?.q === S.q ? S.deep.byKey.get(r.key) : null;
  if (hit) {
    let snip = esc(hit.snippet);
    for (const w of parseQuery(S.q).inc) snip = snip.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (x) => `<mark>${x}</mark>`);
    line = `<span class="ln hit">${hit.role === "user" ? "You: " : hit.role === "tool" ? "" : "Agent: "}“${snip}”${hit.count > 1 ? ` <span class="hint">· ${hit.count} messages</span>` : ""}</span>`;
  }
  // The status line is always there (quiet rows show the last reply, or stay blank), so rows keep their height.
  if (!line && !pendingAsk(r)) { const last = plain(r.lastMessage); line = last ? `<span class="ln last">${esc(last)}</span>` : `<span class="ln ph" aria-hidden="true">&nbsp;</span>`; }
  // Three lines at most: project (where it runs, its subagents) and why it's here · the title · one live line.
  const chips = hit ? "" : rowChips(r, "list");
  if (chips && line) line = line.replace(/^<span class="ln[^"]*"( aria-hidden="true")?>/, (m) => m.replace(' aria-hidden="true"', "") + chips);
  const running = (r.subagents ?? []).filter((x) => x.running);
  const subs = running.length ? `<span class="rsub" title="${esc(running.map((x) => `${x.type || "agent"}: ${x.description ?? ""}${x.now ? " · " + x.now : ""}`).join("\n"))}"><span class="spin"></span>${running.length}</span>` : "";
  const dot = `<span class="dot" style="--c:${statusVar(r.status === "done" && r.seen ? "idle" : r.status)}"></span>`;
  const rc = radarChip(r);
  if (byProject) return `${dot}<span class="tl" style="grid-column:auto">${rc}<b>${esc(r.title || "(untitled)")}</b> <span class="pane">${paneTag(r)}</span>${r.launch ? ` <span class="via">via ${esc(r.launch)}</span>` : ""}${machIcon(r)}${subs}</span>${agoEl}${line}${rowAsk(r)}`;
  // Grouped by project, a worktree has its own sub-section; in the priority list the row says so itself.
  const wt = r.worktree ? `<span class="via wtag" title="In the worktree ${esc(r.worktree)}${r.branch ? ` (${esc(r.branch)})` : ""}">${ICON.tree}${esc(r.worktree)}</span>` : "";
  return `${dot}<span class="pl"><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>${r.launch ? `<span class="via">via ${esc(r.launch)}</span>` : ""}${wt}${machIcon(r)}${subs}${rc}</span>${agoEl}${title}${line}${rowAsk(r)}`;
}
