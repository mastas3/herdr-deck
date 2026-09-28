"use strict";
// ══ Autoresearch ═════════════════════════════════════════════════════════════
// Discover → Research: campaigns that run research sessions one after another (plan → run → evaluate → keep or
// discard) and rank the niches they find. Server: src/autoresearch*.ts. Nothing starts until you confirm a campaign;
// each run opens its own "research: …" session and closes it when the report is in.
S.rs = { st: null, sel: load("rsSel", null), open: new Set(), reports: new Map(), timer: 0, loading: false };
const RS_TYPE = { trend: "Trend scan", deep_dive: "Deep-dive", sizing: "Market sizing", combo: "Combo test", teardown: "Teardown", channel: "Channel test" };
const RS_STATE = { starting: ["Starting", "working"], running: ["Running", "working"], evaluating: ["Evaluating", "done"], kept: ["Kept", "idle"], discarded: ["Discarded", "empty"], failed: ["Failed", "blocked"], skipped: ["Skipped", "empty"] };
const RS_CAMP = { running: ["Running", "working"], paused: ["Paused", "blocked"], stopped: ["Stopped", "empty"], done: ["Done", "idle"] };
const RS_BARS = [["demand", "Demand"], ["willingness_to_pay", "Pay"], ["competition", "Competition"], ["fit_with_user_assets", "Fit"], ["timing", "Heat"]];
const rsOnScreen = () => S.mode === "discover" && S.disc.tab === "research" && !!$("dbody").querySelector(":scope > .view #rsbody");
const rsCamp = () => S.rs.st?.campaigns.find((c) => c.id === S.rs.sel) ?? S.rs.st?.campaigns[0];
const rsMin = (ms) => (ms < 60_000 ? "<1 min" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`);

/** Loads the state; polls while the tab is open (often while a run is live). */
async function rsLoad() {
  clearTimeout(S.rs.timer);
  if (S.rs.loading) return;
  S.rs.loading = true;
  try { S.rs.st = await api("/api/research", {}); } catch (e) { toast(e.message, true); }
  S.rs.loading = false;
  rsPatch();
  const live = S.rs.st?.campaigns.some((c) => c.status === "running" || c.runs.some((r) => ["starting", "running", "evaluating"].includes(r.state)));
  S.rs.timer = setTimeout(() => { if (S.mode === "discover" && S.disc.tab === "research") rsLoad(); }, live ? 3000 : 15000);
}
function rsPatch() { if (rsOnScreen()) setHTML($("dbody").querySelector("#rsbody"), rsBody()); }
function discResearch() { if (!S.rs.st && !S.rs.loading) setTimeout(rsLoad, 0); return `<div id="rsbody">${rsBody()}</div>`; }

function rsBody() {
  const st = S.rs.st;
  if (!st) return `<div class="rsgrid">${'<div class="gcard skel"></div>'.repeat(2)}</div>`;
  const c = rsCamp();
  const calls = `${st.stats.dayPlanner} planner · ${st.stats.dayJev} Jev call${st.stats.dayJev === 1 ? "" : "s"} today`;
  const head = `<section class="rshead"><p class="hint">Research sessions run one after another, each on a sharper question than the last. Only niches with a named buyer, a place they gather, a real price and linked pains make the board.</p>
    <div class="rsacts"><button class="btn primary" data-rsnew>${ICON.plus}New campaign</button>
    ${st.halted ? `<button class="btn danger" data-rskill="0" title="Research is stopped everywhere">Kill switch on · turn off</button>` : st.campaigns.length ? `<button class="btn ghost" data-rskill="1" title="Stop every campaign and close its running research session">Stop everything</button>` : ""}
    <span class="hint rsmeta">${st.fake ? "<b>Simulated sessions</b> · " : ""}Planner: ${st.planner === "claude" ? "Claude (haiku)" : "built-in"} · Jev ${st.jev ? "on" : "off"} · ${calls}</span></div></section>`;
  if (!st.campaigns.length) return head + `<section class="rsempty"><h3 class="dsub">Start from a goal</h3><div class="lchips">${st.presets.map((p) => `<button class="lstart" data-rspreset="${esc(p.id)}" title="${esc(p.goal)}">${esc(p.label)}</button>`).join("")}</div></section>`;
  const list = st.campaigns.length > 1 ? `<nav class="rslist">${st.campaigns.map((x) => {
    const [w, k] = RS_CAMP[x.status];
    return `<button class="rscamp" data-rssel="${esc(x.id)}" aria-pressed="${x.id === c.id}"><span class="dot" style="--c:${statusVar(k)}"></span><span class="rsct">${esc(x.goal)}</span><span class="hint">${esc(w)} · ${x.attempts}/${x.budget}${x.board[0] ? ` · ${esc(x.board[0].name)}` : ""}</span></button>`;
  }).join("")}</nav>` : "";
  return head + list + rsCampaign(c);
}

function rsCampaign(c) {
  const [word, kind] = RS_CAMP[c.status];
  const active = c.runs.find((r) => ["starting", "running", "evaluating"].includes(r.state));
  const note = c.planning ? "Planning the next question…" : active ? `Run ${active.n}: ${RS_STATE[active.state][0].toLowerCase()} for ${rsMin(Date.now() - active.startedAt)}` : c.waiting ?? c.reason ?? "";
  const ctl = [
    c.status === "running" && `<button class="btn" data-rsop="pause">Pause</button>`,
    c.status === "paused" && `<button class="btn primary" data-rsop="resume">Resume</button>`,
    active && `<button class="btn" data-rsop="skip" title="Abandon this run, close its session, go on to the next">Skip run</button>`,
    (c.status === "running" || c.status === "paused") && `<button class="btn ghost" data-rsop="stop">Stop</button>`,
    (c.status === "done" || c.status === "stopped") && `<button class="btn" data-rsop="more">3 more runs</button>`,
    !active && c.status !== "running" && `<button class="btn ghost" data-rsop="delete">Delete</button>`,
  ].filter(Boolean).join("");
  const pct = Math.round((100 * c.attempts) / c.budget);
  return `<section class="rsc" data-rsc="${esc(c.id)}">
    <header class="rsch"><h3>${esc(c.goal)}</h3>
      <p class="rsline"><span class="rspill" style="--c:${statusVar(kind)}">${esc(word)}</span><span>${c.attempts} of ${c.budget} runs</span><span>up to ${c.dailyCap} a day</span>${c.quiet.on ? `<span>quiet ${esc(c.quiet.from)}–${esc(c.quiet.to)}</span>` : ""}${note ? `<span class="rsnote">${c.planning ? '<span class="spin"></span>' : ""}${esc(note)}</span>` : ""}</p>
      <div class="rsprog"><i style="transform:scaleX(${pct / 100})"></i></div>
      ${c.seeds.length ? `<p class="dkw">${c.seeds.map((s) => `<span class="dtag">${esc(s)}</span>`).join("")}</p>` : ""}
      <div class="gacts">${ctl}</div></header>
    <div class="rscols"><div class="rsboard"><h3 class="dsub">Niche leaderboard <span class="hint">${c.board.length ? `${c.board.length} niche${c.board.length === 1 ? "" : "s"}, best first` : ""}</span></h3>
      ${c.board.length ? c.board.map((n, i) => rsNiche(n, i)).join("") : `<p class="hint rsnone">Niches appear here once a report passes the bar.</p>`}</div>
    <div class="rsruns"><h3 class="dsub">Runs</h3><ol class="rstl">${[...c.runs].reverse().map((r) => rsRun(c, r)).join("")}${c.planning ? `<li class="rsr" style="--c:var(--working)"><p class="rsq hint"><span class="spin"></span> Planning run ${c.runs.length + 1}…</p></li>` : ""}</ol></div></div>
  </section>`;
}

function rsNiche(n, i) {
  const bar = ([k, label]) => { const v = n.scores[k]; return `<span class="rsb${k === "competition" ? " inv" : ""}"><span>${label}</span><i><b style="transform:scaleX(${(v ?? 0) / 10})"></b></i><em>${v ?? "–"}</em></span>`; };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  const price = [...n.prices, ...n.competitors.filter((x) => x.price).map((x) => `${x.name} ${x.price}`)].slice(0, 3);
  return `<article class="rsn" data-rsniche="${esc(n.id)}" style="--i:${Math.min(i, 8)}">
    <div class="rsntop"><span class="rsrank">${i + 1}</span><h4>${esc(n.name)}</h4><span class="rsscore" style="--p:${n.score}" title="Score out of 100: rubric${n.jev != null ? " blended with Jev" : ""}">${n.score}</span></div>
    ${n.summary ? `<p class="rssum">${esc(n.summary)}</p>` : ""}
    <dl class="rsfacts">${n.audience ? `<dt>Buyer</dt><dd>${esc(n.audience)}</dd>` : ""}${n.whyNow ? `<dt>Why now</dt><dd>${esc(n.whyNow)}</dd>` : ""}${price.length ? `<dt>Prices seen</dt><dd>${price.map(esc).join(" · ")}</dd>` : ""}${n.jev != null ? `<dt>Jev</dt><dd>${Math.round(n.jev * 100)}% chance of 10 paying customers in 60 days</dd>` : ""}</dl>
    <div class="rsbars">${RS_BARS.map(bar).join("")}</div>
    ${n.pains[0] ? `<blockquote class="lq"><p>“${esc(n.pains[0].quote)}”</p><footer><a href="${esc(n.pains[0].url)}" target="_blank" rel="noopener">${esc(host(n.pains[0].url))}</a></footer></blockquote>` : ""}
    <p class="rslinks">${n.where.filter((w) => w.url).slice(0, 3).map((w) => `<a class="dtag" href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.name)}</a>`).join("")}${n.evidence.slice(0, 4).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join("")}<span class="hint">runs ${n.runs.join(", ")}</span></p>
    <div class="gacts"><button class="btn primary" data-rsplan>Plan the app</button>${typeof leadsFor === "function" ? `<button class="btn ghost" data-rsleads>Find users</button>` : ""}<button class="btn ghost" data-rsplay>${typeof startRun === "function" ? "Play" : "Idea lab"}</button></div>
  </article>`;
}

function rsRun(c, r) {
  const [word, kind] = RS_STATE[r.state];
  const live = r.live;
  const took = r.startedAt ? rsMin((r.endedAt ?? Date.now()) - r.startedAt) : "";
  const k = `${c.id}:${r.n}`, open = S.rs.open.has(k), rep = S.rs.reports.get(k);
  const canRead = r.merged || (r.state === "failed" && r.reportAt);
  return `<li class="rsr" style="--c:${statusVar(kind)}" data-rsrun="${r.n}">
    <p class="rsrh"><b>#${r.n}</b><span class="rspill" style="--c:${statusVar(kind)}">${esc(word)}</span><span class="hint">${esc(RS_TYPE[r.type] ?? r.type)}${took ? ` · ${took}` : ""}${r.planner === "template" ? " · built-in planner" : ""}</span></p>
    <p class="rsq">${esc(r.question)}</p>
    ${live ? `<p class="hint rslive">${live.status === "blocked" ? "Waiting on you in its session" : STATUS_NAME[live.status] ?? live.status}${live.fake ? " (simulated)" : ""}${!live.fake && rowOf(r.key) ? ` · <button class="link" data-rssess="${esc(r.key)}">Open the session</button>` : ""}</p>` : ""}
    ${r.best ? `<p class="rsbest">Best: <b>${esc(r.best.name)}</b> ${r.best.score}</p>` : ""}
    ${r.verdict ? `<p class="hint">${esc(r.verdict)}</p>` : ""}
    ${r.discardWhy || r.error ? `<p class="rswhy">${esc(r.discardWhy ?? r.error)}</p>` : ""}
    ${r.rejected?.length ? `<details class="rsrej"><summary class="hint">${r.rejected.length} niche${r.rejected.length === 1 ? "" : "s"} left off the board</summary>${r.rejected.map((x) => `<p><b>${esc(x.name)}</b>: ${esc(x.why)}</p>`).join("")}</details>` : ""}
    ${canRead ? `<button class="link" data-rsread>${open ? "Close the report" : "Read the report"}</button>` : ""}
    ${open ? `<div class="md rsrep">${rep ? md(rep.text) : '<span class="spin"></span>'}</div>` : ""}
  </li>`;
}

/** The New campaign dialog: the form, then a summary you confirm. Nothing starts before "Start campaign". */
async function rsNew(pre = {}) {
  if (!S.rs.st) await rsLoad();
  const st = S.rs.st;
  if (!st) return;
  const tray = (S.disc.mix?.sel ?? []).map((x) => x.name).slice(0, 8);
  const d = document.createElement("dialog");
  d.className = "rsdlg";
  const ms = st.machines;
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>New research campaign</h3>
    <div class="lchips rspre">${st.presets.map((p) => `<button type="button" class="lstart" data-p="${esc(p.id)}">${esc(p.label)}</button>`).join("")}</div>
    <label class="field"><span>Goal</span><textarea name="goal" rows="3" required placeholder="What should the research find? Name the buyers or the market if you can.">${esc(pre.goal ?? "")}</textarea></label>
    <label class="field"><span>Seeds <span class="hint">(optional: niches, audiences, trends, one per line)</span></span><textarea name="seeds" rows="2">${esc(pre.seeds ?? "")}</textarea>${tray.length ? `<button type="button" class="link" data-tray>Add the Studio tray (${tray.length})</button>` : ""}</label>
    <div class="fields2"><label class="field"><span>Runs</span><input name="budget" type="number" min="1" max="20" value="${pre.budget ?? 5}"></label><label class="field"><span>At most a day</span><input name="dailyCap" type="number" min="1" max="20" value="${pre.dailyCap ?? 6}"></label></div>
    <div class="fields2"><div class="field"><span>Machine</span><div class="seg" data-machine>${ms.map((m) => `<button type="button" data-m="${esc(m.id)}" aria-pressed="${m.id === st.self}" ${m.ok ? "" : "disabled"} title="${esc(m.why)}">${esc(m.label)}</button>`).join("")}</div></div>
      <div class="field"><span>Agent</span><div class="seg"><button type="button" aria-pressed="true">Claude Code</button></div></div></div>
    <div class="fields2"><label class="field"><span>Model</span><select name="model"><option value="">Default</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></label><label class="field"><span>Time limit per run (min)</span><input name="runMinutes" type="number" min="10" max="120" value="45"></label></div>
    <div class="field"><span>Quiet hours <span class="hint">(no new runs start)</span></span><span class="rsquiet"><input type="checkbox" name="qon"> from <input name="qfrom" type="time" value="23:00"> to <input name="qto" type="time" value="07:00"></span></div>
    <div class="rssum2" hidden></div></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" type="button" data-next>Review</button></div></form>`;
  document.body.append(d);
  const f = d.querySelector("form"), next = d.querySelector("[data-next]"), sum = d.querySelector(".rssum2");
  let machine = st.self, draft = null;
  const body = () => ({ goal: f.goal.value, seeds: f.seeds.value, budget: Number(f.budget.value), dailyCap: Number(f.dailyCap.value), machine, model: f.model.value, runMinutes: Number(f.runMinutes.value), quiet: { on: f.qon.checked, from: f.qfrom.value, to: f.qto.value } });
  const back = () => { draft = null; sum.hidden = true; next.textContent = "Review"; for (const el of d.querySelectorAll(".field, .rspre")) el.hidden = false; };
  d.addEventListener("click", async (e) => {
    const p = e.target.closest("[data-p]");
    if (p) { f.goal.value = st.presets.find((x) => x.id === p.dataset.p)?.goal ?? ""; return back(); }
    if (e.target.closest("[data-tray]")) { f.seeds.value = [f.seeds.value.trim(), ...tray].filter(Boolean).join("\n"); return; }
    const m = e.target.closest("[data-m]");
    if (m && !m.disabled) { machine = m.dataset.m; for (const b of d.querySelectorAll("[data-m]")) b.setAttribute("aria-pressed", b === m); return; }
    if (e.target.closest("[data-back]")) return back();
    if (!e.target.closest("[data-next]")) return;
    if (!draft) {
      try { draft = await api("/api/research/draft", body()); } catch (err) { return toast(err.message, true); }
      for (const el of d.querySelectorAll(".field, .rspre")) el.hidden = true;
      const x = draft.estimate;
      sum.innerHTML = `<p class="rsgoal">${esc(draft.goal)}</p><ul class="rslist2">
        <li><b>${draft.budget} research run${draft.budget === 1 ? "" : "s"}</b>, one at a time, at most ${draft.dailyCap} a day${x.days > 1 ? ` (about ${x.days} days)` : ""}.</li>
        <li>On <b>${esc(draft.machineLabel)}</b> with Claude Code${draft.model ? ` (${esc(draft.model)})` : ""}: about ${x.perRunMin} min a run, ${rsMin(x.totalMin * 60_000)} in all; a run is stopped after ${draft.runMinutes} min.</li>
        <li>Each run <b>opens its own session</b> labeled “research: …” in <code>~/Documents/Projects/_research</code>, and the deck <b>closes it</b> when its report is in. It never touches your other sessions.</li>
        <li>Research only: it reads public pages and posts and never messages, posts, signs up for or buys anything.</li>
        ${draft.quiet.on ? `<li>No new runs between ${esc(draft.quiet.from)} and ${esc(draft.quiet.to)}.</li>` : ""}
        ${draft.seeds.length ? `<li>Seeds: ${draft.seeds.map(esc).join(", ")}</li>` : ""}</ul>
        <button type="button" class="link" data-back>Change something</button>`;
      sum.hidden = false;
      next.textContent = "Start campaign";
      return;
    }
    try {
      const r = await api("/api/research/create", { ...body(), confirm: true });
      S.rs.st = r.state; S.rs.sel = r.id; store("rsSel", r.id);
      d.close();
      toast("Campaign started: the first run begins in a moment");
      rsPatch(); rsLoad();
    } catch (err) { toast(err.message, true); }
  });
  f.addEventListener("submit", (e) => { if (e.submitter?.value !== "cancel") e.preventDefault(); }); // Enter in a field doesn't close it
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

async function rsControl(op) {
  const c = rsCamp();
  if (!c) return;
  if ((op === "stop" || op === "delete") && !(await askDialog({ title: op === "stop" ? "Stop this campaign?" : "Delete this campaign?", text: op === "stop" ? "The run in progress is abandoned and its research session closed. Reports and the leaderboard stay." : "It leaves the list. The report files stay on disk.", ok: op === "stop" ? "Stop" : "Delete", danger: true }))) return;
  try { S.rs.st = await api("/api/research/control", { id: c.id, op }); rsPatch(); } catch (e) { toast(e.message, true); }
}
async function rsKill(on) {
  if (on && !(await askDialog({ title: "Stop all research?", text: "Every campaign pauses and every running research session is closed. Nothing starts again until you turn the switch off and resume.", ok: "Stop everything", danger: true }))) return;
  try { S.rs.st = await api("/api/research/kill", { on }); rsPatch(); } catch (e) { toast(e.message, true); }
}
async function rsPlan(c, n) {
  try {
    const r = await api("/api/research/plan-prompt", { id: c.id, niche: n.id });
    S.disc.pending = { slug: r.slug, text: r.idea };
    await openNew({ machine: S.self, ...ownFolder(r, n.name), project: "Research", prompt: r.prompt, kind: "claude", label: r.label, title: `Plan the app: ${n.name.slice(0, 40)}` });
    promptTop();
  } catch (e) { toast(e.message, true); }
}
/** ⌘K entries (paletteItems calls this). */
function rsPalette(q) {
  const go = () => { S.disc.tab = "research"; store("discTab", "research"); setMode("discover"); };
  return [
    { t: "Research: campaigns and the niche leaderboard", run: go },
    { t: "Research: start an autoresearch campaign…", run: () => { go(); rsNew(); } },
    q.length > 14 && { t: `Research campaign: “${q.slice(0, 60)}”`, echo: true, run: () => { go(); rsNew({ goal: q }); } },
  ];
}

$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "discover" || S.disc.tab !== "research") return;
  const t = e.target;
  if (t.closest("[data-rsnew]")) return rsNew();
  const pre = t.closest("[data-rspreset]")?.dataset.rspreset;
  if (pre) return rsNew({ goal: S.rs.st?.presets.find((p) => p.id === pre)?.goal });
  const kill = t.closest("[data-rskill]")?.dataset.rskill;
  if (kill) return rsKill(kill === "1");
  const sel = t.closest("[data-rssel]")?.dataset.rssel;
  if (sel) { S.rs.sel = sel; store("rsSel", sel); return rsPatch(); }
  const op = t.closest("[data-rsop]")?.dataset.rsop;
  if (op) return rsControl(op);
  const sess = t.closest("[data-rssess]")?.dataset.rssess;
  if (sess) { setMode(null); return select(sess, { scroll: true, open: true }); }
  const c = rsCamp();
  const nEl = t.closest("[data-rsniche]");
  const n = nEl && c?.board.find((x) => x.id === nEl.dataset.rsniche);
  if (n && t.closest("[data-rsplan]")) return rsPlan(c, n);
  if (n && t.closest("[data-rsleads]")) return leadsFor(n.audience ? `${n.name} for ${n.audience}` : n.name, "idea");
  if (n && t.closest("[data-rsplay]")) {
    const text = `${n.name}${n.summary ? `: ${n.summary}` : ""}`;
    return typeof startRun === "function" ? startRun({ title: n.name, pitch: n.summary, idea: text, source: "research", evidence: n.evidence }) : ideaResearch(text);
  }
  const rEl = t.closest("[data-rsrun]");
  if (rEl && c && t.closest("[data-rsread]")) {
    const k = `${c.id}:${rEl.dataset.rsrun}`;
    if (S.rs.open.has(k)) S.rs.open.delete(k); else S.rs.open.add(k);
    rsPatch();
    if (S.rs.open.has(k) && !S.rs.reports.has(k)) {
      try { S.rs.reports.set(k, await api("/api/research/report", { id: c.id, n: Number(rEl.dataset.rsrun) })); } catch (err) { S.rs.open.delete(k); toast(err.message, true); }
      rsPatch();
    }
  }
});
// A research push opens here.
if (new URLSearchParams(location.search).has("research")) setTimeout(() => { S.disc.tab = "research"; store("discTab", "research"); setMode("discover"); }, 400);
deckPlugins.register("research", { palette: (q) => rsPalette(q).map((c) => ({ ...c, order: 40 })) });
// ══ end Autoresearch ═════════════════════════════════════════════════════════
