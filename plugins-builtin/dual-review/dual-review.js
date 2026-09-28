"use strict";
// Dual review in the page: the Review view (both reviewers' findings side by side, grouped when they match) and
// sending picked findings back to the session that made the change. Starting a review is dual-review-start.js.
// Server: plugins-builtin/dual-review/server.ts. Top-level names start with dr (one global scope with the deck).
const drS = { list: null, sel: load("drSel", null), cur: null, picks: new Set(), filter: "all", loading: false };
const DR_SIDE = { claude: "Claude", codex: "Codex" };
const DR_STATUS = { waiting: ["Reviewing", "working"], done: ["Done", "idle"], gone: ["Closed, no file", "blocked"], failed: ["Didn’t start", "blocked"] };
const DR_GROUP = { agree: "Both found", claude: "Only Claude", codex: "Only Codex" };
ICON.review = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="5.5" cy="8" r="3.5"/><circle cx="10.5" cy="8" r="3.5"/></svg>';

async function drLoad(id = drS.sel) {
  if (drS.loading) return;
  drS.loading = true;
  try {
    drS.list = (await api("/api/dual-review", { op: "list" })).reviews;
    if (!drS.list.some((r) => r.id === id)) id = drS.list[0]?.id ?? null;
    if (id !== drS.sel) drS.picks.clear();
    drS.sel = id; store("drSel", id);
    drS.cur = id ? await api("/api/dual-review", { op: "get", id }) : null;
  } catch (e) { toast(e.message, true); }
  drS.loading = false;
  if (S.mode === "review") drRender();
}

function drSideChip(side, s) {
  const [word, kind] = DR_STATUS[s.status] ?? ["?", "unknown"];
  const open = s.key && rowOf(s.key) ? `<button class="link" data-dropen="${esc(s.key)}">open</button>` : "";
  return `<span class="drchip" style="--c:${statusVar(kind)}" title="${esc(s.error ?? "")}"><b>${DR_SIDE[side]}</b>${esc(word)}${s.n != null ? ` · ${s.n} finding${s.n === 1 ? "" : "s"}` : ""}${s.model ? ` · ${esc(s.model)}` : ""} ${open}</span>`;
}
function drList() {
  if (!drS.list?.length) return "";
  return `<nav class="drlist">${drS.list.map((r) => `<button class="drcard" data-drsel="${esc(r.id)}" aria-pressed="${r.id === drS.sel}">
    <b>${esc(r.project)}</b><span class="hint">${esc(r.range || "uncommitted changes")} · ${esc(agoText(r.createdAt))}</span>
    <span class="drdots">${Object.entries(r.sides).map(([k, s]) => `<span class="dot" style="--c:${statusVar((DR_STATUS[s.status] ?? [0, "unknown"])[1])}" title="${DR_SIDE[k]}: ${esc((DR_STATUS[s.status] ?? ["?"])[0])}"></span>`).join("")}</span></button>`).join("")}</nav>`;
}
const drWhere = (f) => (f.file ? `${f.file}${f.line ? `:${f.line}${f.endLine && f.endLine !== f.line ? `–${f.endLine}` : ""}` : ""}` : "no file");
function drFinding(f, side) {
  if (!f) return `<div class="drf none"><span class="hint">${DR_SIDE[side]} didn’t flag this</span></div>`;
  return `<div class="drf"><span class="drsev ${esc(f.severity)}">${esc(f.severity)}</span><span class="drwho">${DR_SIDE[side]}</span><p class="drtitle">${esc(f.title)}</p>${f.detail ? `<p class="drd">${esc(f.detail)}</p>` : ""}</div>`;
}
function drGroups(c) {
  const shown = c.groups.map((g, i) => [g, i]).filter(([g]) => drS.filter === "all" || g.status === drS.filter);
  if (!c.groups.length) {
    const any = Object.values(c.sides).some((s) => s.status === "waiting");
    return `<p class="hint drempty">${any ? "Waiting for the reviewers to write their findings. This fills in by itself." : "No findings came back."}</p>`;
  }
  const n = (k) => c.groups.filter((g) => g.status === k).length;
  const seg = ["all", "agree", "claude", "codex"].map((k) => `<button data-drfilter="${k}" aria-pressed="${drS.filter === k}">${k === "all" ? "All" : DR_GROUP[k]} <span class="n">${k === "all" ? c.groups.length : n(k)}</span></button>`).join("");
  return `<div class="drbar"><div class="seg small">${seg}</div><button class="btn ghost" data-drpickall>${shown.every(([, i]) => drS.picks.has(i)) && shown.length ? "Unpick shown" : "Pick shown"}</button></div>
    <ol class="drgroups">${shown.map(([g, i]) => {
      const f = g.claude ?? g.codex;
      return `<li class="drg ${g.status}" style="--i:${Math.min(i, 10)}"><label class="drghead"><input type="checkbox" data-drpick="${i}" ${drS.picks.has(i) ? "checked" : ""}><span class="drtag ${g.status}">${DR_GROUP[g.status]}</span><code>${esc(drWhere(f))}</code></label>
        <div class="drcols">${drFinding(g.claude, "claude")}${drFinding(g.codex, "codex")}</div></li>`;
    }).join("")}</ol>`;
}
function drDetail(c) {
  const to = c.origin?.key && rowOf(c.origin.key);
  const sent = c.sent?.length ? `<span class="hint">Sent ${c.sent.map((x) => `${x.n} ${agoText(x.at)}`).join(", ")}</span>` : "";
  const actions = `<div class="drsend"><button class="btn primary" data-drsend ${drS.picks.size ? "" : "disabled"}>Send ${drS.picks.size || ""} to ${to ? esc(to.title || to.project || "the session") : "a session"}…</button>${sent}<span class="spacer"></span><button class="btn ghost" data-drdelete>Delete review</button></div>`;
  return `<section class="drcur"><header><h3>${esc(c.project)} <span class="hint">${esc(c.words.replace(/`/g, ""))}</span></h3>
    <p class="drsides">${Object.entries(c.sides).map(([k, s]) => drSideChip(k, s)).join("")}</p>
    ${c.origin ? `<p class="hint">From ${to ? `<button class="link" data-dropen="${esc(c.origin.key)}">${esc(to.title || c.origin.title || "its session")}</button>` : esc(c.origin.title || "a session that has closed")} · <span class="mono">${esc(home(c.cwd))}</span></p>` : `<p class="hint mono">${esc(home(c.cwd))}</p>`}</header>
    ${drGroups(c)}${c.groups.length ? actions : `<div class="drsend"><span class="spacer"></span><button class="btn ghost" data-drdelete>Delete review</button></div>`}</section>`;
}
function drRender() {
  const head = `<header class="vh"><h2>${ICON.review}Review</h2><p>Claude and Codex review the same change on their own. Findings they both made are the ones to trust first.</p>
    <p><button class="btn primary" data-drnew>${ICON.plus}New review</button></p></header>`;
  if (!drS.list) { modeHTML(head + `<p class="hint">Loading…</p>`); return; }
  if (!drS.list.length) { modeHTML(head + `<p class="hint drempty">No reviews yet. Pick a session with changes, then New review.</p>`); return; }
  modeHTML(head + drList() + (drS.cur ? drDetail(drS.cur) : ""));
}

async function drSend() {
  const c = drS.cur;
  if (!c || !drS.picks.size) return;
  let key = c.origin?.key && rowOf(c.origin.key) ? c.origin.key : null;
  if (!key) { toast("The session that made this change is gone. Open the session to send to, then use ⌘K → Review: send picked findings here.", true); return; }
  const picks = [...drS.picks].sort((a, b) => a - b);
  try {
    const { text } = await api("/api/dual-review", { op: "compose", id: c.id, picks });
    const r = rowOf(key);
    if (!await drConfirm({ title: `Send ${picks.length} finding${picks.length === 1 ? "" : "s"}?`, note: `One message to “${r.title || r.project}”.`, blocks: [{ label: "Message", text }], ok: "Send" })) return;
    await api("/api/dual-review", { op: "send", id: c.id, picks, key, confirmed: true });
    toast(`Sent ${picks.length} to ${r.title || r.project}`);
    drS.picks.clear(); drLoad(c.id);
  } catch (e) { toast(e.message, true, { label: "Retry", run: drSend }); }
}
/** From ⌘K while another session is open: send the picked findings there instead. */
async function drSendHere(key) {
  const c = drS.cur;
  if (!c || !drS.picks.size) { toast("Pick findings in the Review view first", true); return; }
  const picks = [...drS.picks].sort((a, b) => a - b), r = rowOf(key);
  const { text } = await api("/api/dual-review", { op: "compose", id: c.id, picks });
  if (!await drConfirm({ title: `Send ${picks.length} finding${picks.length === 1 ? "" : "s"} here?`, note: `One message to “${r.title || r.project}”.`, blocks: [{ label: "Message", text }], ok: "Send" })) return;
  try { await api("/api/dual-review", { op: "send", id: c.id, picks, key, confirmed: true }); toast("Sent"); drS.picks.clear(); } catch (e) { toast(e.message, true); }
}
async function drDelete() {
  const c = drS.cur;
  if (!c || !await askDialog({ title: "Delete this review?", text: "Removes its two findings files from the deck’s data folder. The sessions stay open.", ok: "Delete", danger: true })) return;
  try { await api("/api/dual-review", { op: "delete", id: c.id }); drS.sel = null; drLoad(); } catch (e) { toast(e.message, true); }
}

$("dbody").addEventListener("click", (e) => {
  if (S.mode !== "review") return;
  const t = e.target.closest("[data-drsel],[data-drfilter],[data-drpickall],[data-drsend],[data-drdelete],[data-drnew],[data-dropen]");
  if (!t) return;
  const d = t.dataset;
  if (d.drsel) drLoad(d.drsel);
  else if (d.drfilter) { drS.filter = d.drfilter; drRender(); }
  else if (d.drpickall != null) {
    const shown = drS.cur.groups.map((g, i) => [g, i]).filter(([g]) => drS.filter === "all" || g.status === drS.filter).map(([, i]) => i);
    const all = shown.every((i) => drS.picks.has(i));
    for (const i of shown) all ? drS.picks.delete(i) : drS.picks.add(i);
    drRender();
  } else if (d.drsend != null) drSend();
  else if (d.drdelete != null) drDelete();
  else if (d.drnew != null) drOpenStart(rowOf(S.sel));
  else if (d.dropen) select(d.dropen, { scroll: true, open: true });
});
$("dbody").addEventListener("change", (e) => {
  const t = e.target.closest?.("[data-drpick]");
  if (!t || S.mode !== "review") return;
  const i = Number(t.dataset.drpick);
  t.checked ? drS.picks.add(i) : drS.picks.delete(i);
  drRender();
});

deckPlugins.register("dual-review", {
  views: { review: { load: () => drLoad(), render: drRender } },
  tabs: [{ view: "review", label: "Review", icon: () => ICON.review, order: 60 }],
  palette: (q, cur) => [
    { t: "Review: Claude and Codex review a change", slot: "views", order: 20, run: () => drOpenStart(cur) },
    { t: "Review: open reviews", slot: "views", order: 21, run: () => setMode("review") },
    cur && drS.picks.size && { t: `Review: send ${drS.picks.size} picked finding${drS.picks.size === 1 ? "" : "s"} to this session`, order: 22, run: () => drSendHere(cur.key) },
  ].filter(Boolean),
  events: { "dual-review": () => { if (S.mode === "review") drLoad(); } },
});
