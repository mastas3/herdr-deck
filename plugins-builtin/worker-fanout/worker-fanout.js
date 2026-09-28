"use strict";
// Worker fan-out in the page: the Workers board (each run's workers: running / done / failed, their reports) and
// "collect", which merges the reports into one message for a session you pick. New runs: worker-fanout-new.js.
// Server: plugins-builtin/worker-fanout/server.ts. Top-level names start with fo.
const foS = { runs: null, sel: load("foSel", null), open: new Set(), reports: new Map(), loading: false };
const FO_STATE = { running: ["Running", "working"], done: ["Done", "idle"], failed: ["Failed", "blocked"], stopped: ["Stopped, no report", "blocked"] };
ICON.fanout = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="8" r="1.8"/><circle cx="13" cy="3" r="1.6"/><circle cx="13" cy="8" r="1.6"/><circle cx="13" cy="13" r="1.6"/><path d="M4.8 8h6.6M4.6 7l6.8-3.6M4.6 9l6.8 3.6"/></svg>';

async function foLoad() {
  if (foS.loading) return;
  foS.loading = true;
  try {
    foS.runs = (await api("/api/worker-fanout", { op: "list" })).runs;
    if (!foS.runs.some((r) => r.id === foS.sel)) foS.sel = foS.runs[0]?.id ?? null;
  } catch (e) { toast(e.message, true); }
  foS.loading = false;
  if (S.mode === "workers") foRender();
}
const foRun = () => foS.runs?.find((r) => r.id === foS.sel);
const foTally = (r) => ["done", "running", "failed", "stopped"].map((s) => [s, r.workers.filter((w) => w.state === s).length]).filter(([, n]) => n);

function foWorker(r, w) {
  const [word, kind] = FO_STATE[w.state] ?? ["?", "unknown"];
  const open = foS.open.has(`${r.id}:${w.n}`), rep = foS.reports.get(`${r.id}:${w.n}`);
  const live = w.key && rowOf(w.key);
  return `<li class="fow" style="--c:${statusVar(kind)}">
    <div class="fowh"><span class="dot" style="--c:${statusVar(kind)}"></span><b>${w.n}. ${esc(w.label || w.cwd.split("/").pop())}</b>
      <span class="hint">${esc(w.kind)}${w.model ? ` · ${esc(w.model)}` : ""} · <span class="mono">${esc(home(w.cwd))}</span></span>
      <span class="fostate">${esc(word)}</span></div>
    ${w.error ? `<p class="derr">${esc(w.error)}</p>` : ""}
    <div class="foacts">${w.hasReport ? `<button class="btn ghost" data-foreport="${w.n}">${open ? "Hide report" : "Report"}</button>` : `<span class="hint">No report yet</span>`}
      ${live ? `<button class="btn ghost" data-foopen="${esc(w.key)}">Open session</button>` : ""}</div>
    ${open ? `<pre class="forep">${rep == null ? "Loading…" : esc(rep || "(empty)")}</pre>` : ""}</li>`;
}
function foRender() {
  const head = `<header class="vh"><h2>${ICON.fanout}Workers</h2><p>One brief, several workers. Each writes a report and a done marker when it finishes, so you don’t have to ask for status.</p>
    <p><button class="btn primary" data-fonew>${ICON.plus}New fan-out</button></p></header>`;
  if (!foS.runs) { modeHTML(head + `<p class="hint">Loading…</p>`); return; }
  if (!foS.runs.length) { modeHTML(head + `<p class="hint">No runs yet.</p>`); return; }
  const list = `<nav class="folist">${foS.runs.map((r) => `<button class="focard" data-fosel="${esc(r.id)}" aria-pressed="${r.id === foS.sel}"><b>${esc(r.title)}</b>
    <span class="hint">${foTally(r).map(([s, n]) => `${n} ${FO_STATE[s][0].toLowerCase()}`).join(" · ")} · ${esc(agoText(r.createdAt))}</span></button>`).join("")}</nav>`;
  const r = foRun();
  const done = r.workers.filter((w) => w.state === "done").length;
  const body = `<section class="forun"><h3>${esc(r.title)}</h3>
    <div class="foprog" title="${done} of ${r.workers.length} done"><i style="transform:scaleX(${done / r.workers.length})"></i></div>
    <details class="fobrief"><summary class="hint">The brief</summary><pre class="forep">${esc(r.brief)}</pre></details>
    <ol class="fows">${r.workers.map((w) => foWorker(r, w)).join("")}</ol>
    <div class="fobar"><button class="btn primary" data-focollect>Collect reports…</button>${r.collected.length ? `<span class="hint">Collected ${esc(agoText(r.collected[r.collected.length - 1].at))}</span>` : ""}<span class="spacer"></span><button class="btn ghost" data-fodelete>Delete run</button></div></section>`;
  modeHTML(head + list + body);
}

async function foToggleReport(n) {
  const r = foRun(), k = `${r.id}:${n}`;
  if (foS.open.has(k)) { foS.open.delete(k); foRender(); return; }
  foS.open.add(k); foRender();
  try { foS.reports.set(k, (await api("/api/worker-fanout", { op: "report", id: r.id, n })).text); } catch (e) { foS.reports.set(k, e.message); }
  foRender();
}
/** Collect: pick the session, see the whole message, confirm, send. */
async function foCollect() {
  const r = foRun();
  if (!r) return;
  const mine = new Set(r.workers.map((w) => w.key));
  const rows = [...S.rows.values()].filter((x) => x.agent !== "shell" && !mine.has(x.key)).sort((a, b) => (b.key === S.sel) - (a.key === S.sel) || act(b) - act(a)).slice(0, 40);
  if (!rows.length) { toast("Open the session that should get the reports first", true); return; }
  let text;
  try { text = (await api("/api/worker-fanout", { op: "collect", id: r.id })).text; } catch (e) { toast(e.message, true); return; }
  const d = document.createElement("dialog");
  d.className = "ask wide";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Send the reports as one message?</h3>
    <label class="field"><span>To</span><select name="to">${rows.map((x) => `<option value="${esc(x.key)}">${esc(x.project || "")}: ${esc(x.title || x.agent)}</option>`).join("")}</select></label>
    <div class="field"><span>Message <span class="hint">(${text.length.toLocaleString()} characters)</span></span><pre class="forep">${esc(text)}</pre></div></div>
    <div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn ghost" value="copy" type="submit">Copy instead</button><button class="btn primary" value="ok">Send</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    const v = d.returnValue, key = d.querySelector("select").value;
    motion.drop(d);
    if (v === "copy") return copy(text, "the reports");
    if (v !== "ok") return;
    try { await api("/api/worker-fanout", { op: "collect", id: r.id, send: true, key, confirmed: true }); toast(`Sent to ${rowOf(key)?.title || "the session"}`); foLoad(); }
    catch (e) { toast(e.message, true, { label: "Retry", run: foCollect }); }
  });
  d.showModal();
}
async function foDelete() {
  const r = foRun();
  if (!r || !await askDialog({ title: "Delete this run?", text: "Removes its reports and markers from the deck’s data folder. Worker sessions stay open.", ok: "Delete", danger: true })) return;
  try { await api("/api/worker-fanout", { op: "delete", id: r.id }); foS.sel = null; foLoad(); } catch (e) { toast(e.message, true); }
}

$("dbody").addEventListener("click", (e) => {
  if (S.mode !== "workers") return;
  const t = e.target.closest("[data-fosel],[data-foreport],[data-foopen],[data-focollect],[data-fodelete],[data-fonew]");
  if (!t) return;
  const d = t.dataset;
  if (d.fosel) { foS.sel = d.fosel; store("foSel", d.fosel); foRender(); }
  else if (d.foreport) foToggleReport(Number(d.foreport));
  else if (d.foopen) select(d.foopen, { scroll: true, open: true });
  else if (d.focollect != null) foCollect();
  else if (d.fodelete != null) foDelete();
  else if (d.fonew != null) foOpenNew();
});

deckPlugins.register("worker-fanout", {
  views: { workers: { load: foLoad, render: foRender } },
  tabs: [{ view: "workers", label: "Workers", icon: () => ICON.fanout, order: 61 }],
  palette: () => [
    { t: "Workers: send one brief to several workers", slot: "views", order: 23, run: () => foOpenNew() },
    { t: "Workers: the board (reports, done markers)", slot: "views", order: 24, run: () => setMode("workers") },
  ],
  events: { "worker-fanout": () => { if (S.mode === "workers") foLoad(); } },
});
