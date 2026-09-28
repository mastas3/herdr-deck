"use strict";
// Release train in the page: the Releases view. One board per repo: each stage (what it's at, tags, health), the
// commits waiting between stages, and Promote, which confirms and then starts an agent session with a deploy brief.
// Editing a project: release-train-edit.js. Server: plugins-builtin/release-train/server.ts. Names start with rt.
const rtS = { projects: null, sel: load("rtSel", null), board: null, open: new Set(), checks: new Map(), loading: false };
ICON.train = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="8" r="1.8"/><circle cx="8" cy="8" r="1.8"/><circle cx="13" cy="8" r="1.8"/><path d="M4.8 8h1.4M9.8 8h1.4"/></svg>';

async function rtLoad(fresh = true) {
  if (rtS.loading) return;
  rtS.loading = true;
  try {
    rtS.projects = (await api("/api/release-train", { op: "list" })).projects;
    if (!rtS.projects.some((p) => p.id === rtS.sel)) rtS.sel = rtS.projects[0]?.id ?? null;
    if (S.mode === "releases") rtRender();
    if (rtS.sel && fresh) { rtS.board = null; if (S.mode === "releases") rtRender(); rtS.board = await api("/api/release-train", { op: "board", id: rtS.sel }, 30_000); }
  } catch (e) { toast(e.message, true, { label: "Retry", run: () => rtLoad() }); }
  rtS.loading = false;
  if (S.mode === "releases") rtRender();
}

function rtHealth(s, i) {
  const c = rtS.checks.get(`${rtS.sel}:${i}`);
  const h = s.health;
  const chip = h ? `<span class="rthealth ${h.ok ? "ok" : "bad"}" title="${esc(h.url)}">${h.ok ? `Up · ${h.status} · ${h.ms} ms` : `Down · ${esc(h.error ?? h.status)}`}</span>` : "";
  const check = s.check ? `<button class="btn ghost" data-rtcheck="${i}" title="${esc(s.check)}">${c?.running ? "Checking…" : "Run check"}</button>` : "";
  const out = c && !c.running ? `<pre class="rtout ${c.ok ? "" : "bad"}">${esc(c.ok ? "Check passed" : `Check failed (exit ${c.code})`)}${c.out ? "\n" + esc(c.out) : ""}</pre>` : "";
  return chip || check || out ? `<div class="rthrow">${chip}${check}</div>${out}` : `<p class="hint">No health check set</p>`;
}
function rtStage(s, i) {
  const c = s.commit;
  return `<article class="rtstage" style="--i:${i}"><header><b>${esc(s.name)}</b><code>${esc(s.at && s.at !== s.ref ? `${s.ref} → ${s.at}` : s.ref)}</code></header>
    ${c ? `<p class="rtc"><code>${esc(c.short)}</code> ${esc(c.subject)}</p><p class="hint">${esc(c.author)} · ${esc(agoText(c.at))}${s.tags?.length ? ` · ${s.tags.map(esc).join(", ")}` : ""}</p>` : `<p class="hint">Can’t read ${esc(s.ref)} here${s.ref.includes("*") ? " (no matching tag)" : ""}</p>`}
    ${rtHealth(s, i)}</article>`;
}
function rtGap(b, i) {
  const g = b.gaps[i], next = b.stages[i + 1], k = `${b.id}:${i}`, open = rtS.open.has(k);
  const words = g.unknown ? "Can’t compare" : g.n ? `${g.n} commit${g.n === 1 ? "" : "s"} waiting` : "Nothing waiting";
  return `<div class="rtgap ${g.n ? "has" : ""}"><span class="rtarrow" aria-hidden="true"></span>
    <button class="link" data-rtgap="${i}" ${g.n ? "" : "disabled"}>${words}</button>${g.behind ? `<span class="hint" title="${esc(next.name)} has commits ${esc(b.stages[i].name)} doesn’t (a hotfix?)">${esc(next.name)} is ${g.behind} ahead</span>` : ""}
    ${g.n ? `<button class="btn" data-rtpromote="${i}">Promote to ${esc(next.name)}…</button>` : ""}
    ${open ? `<ol class="rtlog">${g.commits.map((c) => `<li><code>${esc(c.short)}</code> ${esc(c.subject)} <span class="hint">${esc(c.author)} · ${esc(agoText(c.at))}</span></li>`).join("")}${g.n > g.commits.length ? `<li class="hint">…and ${g.n - g.commits.length} more</li>` : ""}</ol>` : ""}</div>`;
}
function rtRender() {
  const head = `<header class="vh"><h2>${ICON.train}Releases</h2><p>What is on each stage, what is waiting to go out, and whether it answers. Promote starts an agent session with a deploy brief; the deck never deploys by itself.</p>
    <p class="rtacts"><button class="btn primary" data-rtadd>${ICON.plus}Add a project</button>${rtS.sel ? `<button class="btn ghost" data-rtedit>Edit stages</button><button class="btn ghost" data-rtreload>Refresh</button>` : ""}</p></header>`;
  if (!rtS.projects) { modeHTML(head + `<p class="hint">Loading…</p>`); return; }
  if (!rtS.projects.length) { modeHTML(head + `<p class="hint">No projects yet. Add one: a repo folder and its stages (for example QA on the qa branch, Staging on staging, Production on main or the newest v* tag).</p>`); return; }
  const tabs = rtS.projects.length > 1 ? `<div class="seg rtprojects">${rtS.projects.map((p) => `<button data-rtsel="${esc(p.id)}" aria-pressed="${p.id === rtS.sel}">${esc(p.name)}</button>`).join("")}</div>` : "";
  const b = rtS.board;
  const body = !b || b.id !== rtS.sel ? `<p class="hint">Reading git…</p>` : b.error ? `<p class="derr">${esc(b.error)}</p>`
    : `<p class="hint mono">${esc(home(b.repo))} · promote runs ${esc(b.agent)}${b.model ? ` ${esc(b.model)}` : ""}</p><div class="rttrain">${b.stages.map((s, i) => rtStage(s, i) + (i < b.gaps.length ? rtGap(b, i) : "")).join("")}</div>`;
  modeHTML(head + tabs + body);
}

async function rtCheck(i) {
  const s = rtS.board?.stages[i], k = `${rtS.sel}:${i}`;
  if (!s?.check || !await askDialog({ title: `Run the ${s.name} check?`, text: `In ${home(rtS.board.repo)}:\n$ ${s.check}\n\nIt should only read (curl, a status command). It runs once, now.`, ok: "Run it" })) return;
  rtS.checks.set(k, { running: true }); rtRender();
  try { rtS.checks.set(k, await api("/api/release-train", { op: "check", id: rtS.sel, stage: i, confirmed: true }, 40_000)); }
  catch (e) { rtS.checks.set(k, { ok: false, code: "?", out: e.message }); }
  rtRender();
}
async function rtPromote(i) {
  let p;
  try { p = await api("/api/release-train", { op: "plan", id: rtS.sel, from: i }, 30_000); } catch (e) { toast(e.message, true); return; }
  const d = document.createElement("dialog");
  d.className = "ask wide rtpromote";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3 tabindex="-1">Promote ${esc(p.from)} to ${esc(p.to)}?</h3>
    <p>${p.n} commit${p.n === 1 ? "" : "s"}. This starts an agent session in ${esc(home(p.cwd))} with the brief below. It asks you before anything risky; the deck itself runs nothing.</p>
    <div class="rtblock"><span class="hint">Runs</span><code class="rtcmd">${esc(p.cmd)}</code></div>
    <div class="rtblock"><span class="hint">The brief</span><pre class="rtout">${esc(p.brief)}</pre></div></div>
    <div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Start the session</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    const ok = d.returnValue === "ok";
    motion.drop(d);
    if (!ok) return;
    try { const r = await api("/api/release-train", { op: "promote", id: rtS.sel, from: i, confirmed: true }); toast(`Started ${p.kind} for ${p.to}`); if (r.key) pendingSelect = r.key; }
    catch (e) { toast("Couldn’t start: " + e.message, true); }
  });
  d.showModal();
  d.querySelector("h3").focus();
}

$("dbody").addEventListener("click", (e) => {
  if (S.mode !== "releases") return;
  const t = e.target.closest("[data-rtsel],[data-rtgap],[data-rtpromote],[data-rtcheck],[data-rtadd],[data-rtedit],[data-rtreload]");
  if (!t) return;
  const d = t.dataset;
  if (d.rtsel) { rtS.sel = d.rtsel; store("rtSel", d.rtsel); rtLoad(); }
  else if (d.rtgap) { const k = `${rtS.sel}:${d.rtgap}`; rtS.open.has(k) ? rtS.open.delete(k) : rtS.open.add(k); rtRender(); }
  else if (d.rtpromote) rtPromote(Number(d.rtpromote));
  else if (d.rtcheck) rtCheck(Number(d.rtcheck));
  else if (d.rtadd != null) rtEdit();
  else if (d.rtedit != null) rtEdit(rtS.projects.find((p) => p.id === rtS.sel));
  else if (d.rtreload != null) rtLoad();
});

deckPlugins.register("release-train", {
  views: { releases: { load: () => rtLoad(), render: rtRender } },
  tabs: [{ view: "releases", label: "Releases", icon: () => ICON.train, order: 62 }],
  palette: () => [{ t: "Releases: what is on QA, staging and production", slot: "views", order: 25, run: () => setMode("releases") }],
});
