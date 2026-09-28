"use strict";
// Ship tracker in the page: the Shipped view. Projects by days since they last shipped (newest release tag, or the
// wiki page saying launched), with the busy-but-not-shipping ones on top. Read-only.
// Server: plugins-builtin/ship-tracker/server.ts. Top-level names start with ship.
const shipS = { data: null, filter: load("stFilter", "all"), loading: false };
ICON.ship = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8c2.2 1.6 3.2 4 3 7.2l-1.6 1.6H6.6L5 9c-.2-3.2.8-5.6 3-7.2Z"/><circle cx="8" cy="6.2" r="1.2"/><path d="M5.4 9.6 3.5 11.2l.6 2.3 2.3-1.3M10.6 9.6l1.9 1.6-.6 2.3-2.3-1.3M8 12.4v2"/></svg>';
const SHIP_STATUS = { active: "working", launched: "idle", stale: "empty", legacy: "empty", archived: "empty", prototype: "done" };

async function shipLoad(force = false) {
  if (shipS.loading) return;
  shipS.loading = true;
  if (S.mode === "shipped") shipRender();
  try { shipS.data = await api("/api/ship-tracker", { force }, 120_000); } catch (e) { toast(e.message, true, { label: "Retry", run: () => shipLoad(force) }); }
  shipS.loading = false;
  if (S.mode === "shipped") shipRender();
}
const shipDays = (r) => (r.daysSince === undefined ? "never" : r.daysSince === 0 ? "today" : `${r.daysSince} day${r.daysSince === 1 ? "" : "s"} ago`);

function shipRow(r, i) {
  const shipped = r.lastShipped ? `${r.shippedBy === "tag" ? `<code>${esc(r.tag)}</code>` : "marked launched"} · ${shipDays(r)}` : "never shipped";
  const kind = SHIP_STATUS[r.status] ?? "unknown";
  return `<li class="shprow ${r.busy ? "busy" : ""}" style="--i:${Math.min(i, 12)}">
    <div class="shpname"><b>${esc(r.name)}</b><span class="shppill" style="--c:${statusVar(kind)}">${esc(r.status)}</span>${r.busy ? `<span class="shpflag">busy, not shipping</span>` : ""}</div>
    <div class="shpfacts"><span title="Last release tag, or the wiki page's launched status">${shipped}</span>
      <span title="Agent sessions in the last 14 days, on every machine">${r.sessions14 ?? 0} session${r.sessions14 === 1 ? "" : "s"} / 14 d${r.live ? ` · ${r.live} live` : ""}</span>
      ${r.commits14 == null ? "" : `<span title="Commits in the last 14 days">${r.commits14} commit${r.commits14 === 1 ? "" : "s"} / 14 d</span>`}
      <span class="hint">${r.lastCommit ? `last commit ${esc(agoText(r.lastCommit))}` : r.path ? "no git here" : "no path on its page"}</span></div></li>`;
}
function shipRender() {
  const d = shipS.data;
  const head = `<header class="vh"><h2>${ICON.ship}Shipped</h2><p>Started versus shipped. Last shipped is the newest release tag in the repo, or the wiki page marked launched. Busy means 5 or more agent sessions in 14 days and nothing shipped in 30.</p></header>`;
  if (!d) { modeHTML(head + `<p class="hint">${shipS.loading ? "Reading the wiki pages and git…" : "Nothing yet."}</p>`); return; }
  if (!d.rows.length) { modeHTML(head + `<p class="hint">No project pages found in ${esc(home(d.wiki))}/projects.</p>`); return; }
  const statuses = ["all", "busy", ...Object.keys(d.counts).sort((a, b) => d.counts[b] - d.counts[a])];
  const n = (s) => (s === "all" ? d.rows.length : s === "busy" ? d.rows.filter((r) => r.busy).length : d.counts[s]);
  const rows = d.rows.filter((r) => shipS.filter === "all" || (shipS.filter === "busy" ? r.busy : r.status === shipS.filter));
  modeHTML(head + `<p class="shpweek">${esc(d.week)}</p>
    <div class="shpbar"><div class="seg small shpfilter">${statuses.map((s) => `<button data-stf="${esc(s)}" aria-pressed="${shipS.filter === s}">${esc(s === "busy" ? "Busy, not shipping" : s === "all" ? "All" : s)} <span class="n">${n(s)}</span></button>`).join("")}</div>
      <button class="btn ghost" data-streload>${shipS.loading ? "Reading…" : "Refresh"}</button><span class="hint">as of ${esc(agoText(d.at))}</span></div>
    <ol class="shplist">${rows.map(shipRow).join("")}</ol>`);
}
$("dbody").addEventListener("click", (e) => {
  if (S.mode !== "shipped") return;
  const t = e.target.closest("[data-stf],[data-streload]");
  if (!t) return;
  if (t.dataset.stf) { shipS.filter = t.dataset.stf; store("stFilter", shipS.filter); shipRender(); }
  else shipLoad(true);
});

deckPlugins.register("ship-tracker", {
  views: { shipped: { load: () => shipLoad(), render: shipRender } },
  tabs: [{ view: "shipped", label: "Shipped", icon: () => ICON.ship, order: 63 }],
  palette: () => [{ t: "Shipped: started versus shipped, per project", slot: "views", order: 28, run: () => setMode("shipped") }],
}).extend("notify.prefs", { title: "Shipping", prefs: [{ key: "shipDigest", label: "A shipping line in Monday's digest", hint: "What shipped last week and what is busy but not shipping", default: true }] });
