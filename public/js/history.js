"use strict";
// History: every past conversation, searchable, opened as a read-only session or resumed.
S.hq = { q: "", machine: "all", agent: "", project: "" };
let histSeq = 0, histTimer = null;
async function loadHistory(more) {
  const seq = ++histSeq;
  const q = S.hq;
  try {
    const before = more ? S.histRes?.sessions?.[S.histRes.sessions.length - 1]?.last : undefined;
    const res = await api("/api/history", { q: q.q, machine: q.machine, agent: q.agent || undefined, project: q.project || undefined, limit: 80, before: q.q ? undefined : before });
    if (seq !== histSeq) return;
    if (more && S.histRes) res.sessions = [...S.histRes.sessions, ...res.sessions.filter((x) => !S.histRes.sessions.some((y) => y.key === x.key))];
    S.histRes = res;
    if (S.mode === "history") renderHistory();
  } catch (e) { toast(e.message, true); }
}
function renderHistStatus() {
  const el = document.getElementById("histStatus");
  if (!el) return;
  const h = S.hist ?? {};
  el.textContent = h.building ? `Indexing ${h.done ?? 0} of ${h.total ?? "?"} changed sessions…` : `${(h.indexed ?? 0).toLocaleString()} past sessions indexed on ${S.self ? machineLabel(S.self) : "this machine"}${multiMachine() ? " (other machines index their own)" : ""}`;
}
function hlite(snip) { return esc(snip).replace(/\u0002/g, "<mark>").replace(/\u0003/g, "</mark>"); }
function renderHistory() {
  const res = S.histRes;
  const q = S.hq;
  const projects = res?.projects ?? [];
  const mach = realMachines();
  const box = $("dbody");
  const html = `<header class="vh"><h2>${ICON.history}History</h2><p id="histStatus"></p>
    <div class="hfilters"><label class="find"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><input id="hq" type="search" placeholder="Search everything you’ve ever done with an agent" value="${esc(q.q)}" autocomplete="off" spellcheck="false"></label>
    ${mach.length > 1 ? `<select id="hmach"><option value="all">All machines</option>${mach.map((m) => `<option value="${esc(m.id)}" ${q.machine === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>` : ""}
    <select id="hagent"><option value="">Claude + Codex</option><option value="claude" ${q.agent === "claude" ? "selected" : ""}>Claude Code</option><option value="codex" ${q.agent === "codex" ? "selected" : ""}>Codex</option></select>
    <select id="hproj"><option value="">All projects</option>${projects.map((p) => `<option value="${esc(p.project)}" ${q.project === p.project ? "selected" : ""}>${esc(p.project)} (${p.n})</option>`).join("")}</select></div></header>
    <div class="hlist">${!res ? `<p class="hint">Loading…</p>` : res.sessions.length ? res.sessions.map((h) => `<button class="hitem" data-hkey="${esc(h.key)}" ${h.hit ? `data-hi="${h.hit.i}"` : ""} style="--pc:${pc(h.project)}">
        <span class="ht">${esc(h.title || "(untitled)")}</span>
        <span class="hm"><span class="pj" style="--pc:${pc(h.project)}">${esc(h.project || "no project")}</span><span>${h.agent === "claude" ? "Claude" : "Codex"}</span>${multiMachine() ? `<span>${esc(machineLabel(h.machine))}</span>` : ""}<span title="${esc(abs(h.last))}">${esc(h.last ? DF.format(new Date(h.last)) : "")}</span>${h.asks ? `<span>${h.asks} request${h.asks === 1 ? "" : "s"}</span>` : ""}${h.hits > 1 ? `<span>${h.hits} matches</span>` : ""}</span>
        ${h.hit ? `<span class="hs">${hlite(h.hit.snippet)}</span>` : h.first && h.first !== h.title ? `<span class="hs dim">${esc(h.first.slice(0, 220))}</span>` : ""}
      </button>`).join("") + (!q.q && res.sessions.length >= 80 ? `<button class="btn ghost more" data-hmore>Older sessions</button>` : "") : `<p class="hint">${q.q ? "No past session mentions that." : "No past sessions yet."}</p>`}</div>`;
  const focused = document.activeElement?.id === "hq";
  const caret = focused ? document.activeElement.selectionStart : null;
  modeHTML(html);
  renderHistStatus();
  if (focused) { const i = $("hq"); i.focus(); i.setSelectionRange(caret, caret); }
}
$("dbody").addEventListener("input", (e) => {
  if (e.target.id !== "hq") return;
  S.hq.q = e.target.value;
  clearTimeout(histTimer);
  histTimer = setTimeout(() => loadHistory(), 180);
});
$("dbody").addEventListener("change", (e) => {
  const id = e.target.id;
  if (id === "hmach") S.hq.machine = e.target.value;
  else if (id === "hagent") S.hq.agent = e.target.value;
  else if (id === "hproj") S.hq.project = e.target.value;
  else return;
  loadHistory();
});
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "history") return;
  if (e.target.closest("[data-hmore]")) return loadHistory(true);
  const b = e.target.closest("[data-hkey]");
  if (b) openHist(b.dataset.hkey, b.dataset.hi != null ? Number(b.dataset.hi) : undefined);
});
async function openHist(key, i) {
  try {
    let row = S.hrows.get(key);
    if (!row) {
      const { row: r } = await api("/api/history-row", { key });
      if (!r) return toast("That session is no longer in the index", true);
      const machine = key.includes("|") ? key.split("|")[0] : S.self;
      row = { ...r, key, machine };
      S.hrows.set(key, row);
    }
    S.tab = "chat";
    if (i != null) return jumpTo(key, i);
    select(key, { open: true });
  } catch (e) { toast(e.message, true); }
}
async function resumeHist(r) {
  try {
    const res = await api("/api/history-resume", { key: r.key });
    toast("Resuming in a new herdr tab…");
    if (res.key) pendingSelect = res.key;
  } catch (e) { toast(e.message, true); }
}
// Keyboard: ↓ from the search goes into the results, ↑ ↓ (or j k) move between them, Enter opens one, ↑ from the first
// goes back to the search.
$("dbody").addEventListener("keydown", (e) => {
  if (S.mode !== "history" || e.metaKey || e.ctrlKey || e.altKey) return;
  const items = [...$("dbody").querySelectorAll(".hitem")], i = items.indexOf(e.target);
  const down = e.key === "ArrowDown" || (i >= 0 && e.key === "j"), up = e.key === "ArrowUp" || (i >= 0 && e.key === "k");
  if (e.target.id === "hq" && down && items.length) { e.preventDefault(); items[0].focus(); }
  else if (i >= 0 && (down || up)) { e.preventDefault(); (up && i === 0 ? $("hq") : items[Math.max(0, Math.min(items.length - 1, i + (down ? 1 : -1)))])?.focus(); }
});
