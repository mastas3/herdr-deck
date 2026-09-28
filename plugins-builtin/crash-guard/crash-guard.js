"use strict";
// Crash guard's page side (server: server.ts beside this file): the banner above the session list when herdr lost
// sessions ("herdr restarted: 37 sessions were open 2 min ago · Restore…"), a line while a restore runs, ⌘K "Restore a
// snapshot…", and a toast with Retry when some couldn't be reopened. The dialogs are crash-guard-dialog.js.
S.crashGuard = S.crashGuard ?? null;
const cgSeen = new Map(); // machine → the job we last saw running (to say once when it ends)

const cgMachines = () => Object.values(S.crashGuard?.machines ?? {});
const cgLocal = (m) => !m || m === S.crashGuard?.self;
function cgCrashes() {
  return cgMachines().flatMap((m) => (m.crashes ?? []).filter((c) => !c.dismissed && c.lost > 0).map((c) => ({ ...c, machine: m.machine })));
}
const cgJobs = () => cgMachines().map((m) => m.job && { ...m.job, machine: m.machine }).filter(Boolean);
const cgPlural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const CG_WHAT = { restarted: "herdr restarted", vanished: "Sessions vanished", fewer: "herdr has fewer sessions than before" };

/** Calls the plugin's API on the deck that owns that machine's herdr (the hub forwards). */
async function cgApi(machine, body) {
  return api("/api/crash-guard", cgLocal(machine) ? body : { ...body, machine });
}

function cgBanner() {
  const crashes = cgCrashes();
  const jobs = cgJobs().filter((j) => j.running || j.items.some((x) => x.state === "failed"));
  let el = document.getElementById("cgBanner");
  if (!crashes.length && !jobs.length) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "cgBanner"; el.className = "cgbar"; el.setAttribute("role", "status");
    const live = document.getElementById("live");
    if (live) live.after(el); else document.getElementById("rows")?.before(el);
    el.addEventListener("click", cgBannerClick);
  }
  el.hidden = false;
  const where = (m) => (multiMachine() ? ` on ${esc(machineLabel(m))}` : "");
  const lines = crashes.filter((c) => !jobs.some((j) => j.machine === c.machine && j.snapshotId === c.snapshotId)).map((c) =>
    `<div class="cg-row" data-cgm="${esc(c.machine)}" data-cgs="${esc(c.snapshotId)}" data-cgc="${esc(c.id)}"><span class="cg-ic">${ICON.warn}</span>
      <span class="cg-t"><b>${CG_WHAT[c.reason] ?? CG_WHAT.restarted}${where(c.machine)}</b>: ${cgPlural(c.lost, "session")} ${c.lost === 1 ? "was" : "were"} open <span data-t="${c.snapshotAt}" data-fmt="long">${esc(agoText(c.snapshotAt))}</span></span>
      <button class="btn primary" data-cgact="restore">Restore…</button><button class="ib" data-cgact="dismiss" aria-label="Hide this" title="Hide this (⌘K → Restore a snapshot… still has it)">${ICON.x}</button></div>`);
  for (const j of jobs) {
    const done = j.items.filter((x) => x.state === "done").length, failed = j.items.filter((x) => x.state === "failed").length;
    lines.push(`<div class="cg-row job" data-cgm="${esc(j.machine)}" data-cgs="${esc(j.snapshotId)}" data-cgj="${esc(j.id)}">${j.running ? '<span class="spin"></span>' : `<span class="cg-ic">${ICON.warn}</span>`}
      <span class="cg-t">${j.running ? `Restoring sessions${where(j.machine)}: <b>${done} of ${j.items.length}</b> open` : `Restored ${done} of ${j.items.length}${where(j.machine)}. <b>${failed} couldn’t open.</b>`}</span>
      <button class="btn" data-cgact="show">Show</button>${!j.running && failed ? `<button class="btn primary" data-cgact="retry">Retry ${failed}</button><button class="ib" data-cgact="clearjob" aria-label="Hide this">${ICON.x}</button>` : ""}</div>`);
  }
  setHTML(el, lines.join(""));
}

async function cgBannerClick(e) {
  const b = e.target.closest("[data-cgact]");
  const row = b?.closest(".cg-row");
  if (!b || !row) return;
  const { cgm: machine, cgs: snap, cgc: crash, cgj: job } = row.dataset;
  const act = b.dataset.cgact;
  try {
    if (act === "restore") return cgOpenRestore(machine, snap);
    if (act === "show") return cgOpenRestore(machine, snap, job);
    if (act === "retry") return cgRetry(machine, job);
    if (act === "dismiss") { await cgApi(machine, { op: "dismiss", crash }); toast("Hidden. ⌘K → Restore a snapshot… still has it."); }
    if (act === "clearjob") await cgApi(machine, { op: "clear-job" });
  } catch (x) { toast(x.message, true); }
}

async function cgRetry(machine, job) {
  try { await cgApi(machine, { op: "retry", job }); toast("Trying those again…"); }
  catch (x) { toast(x.message, true, { label: "Retry", run: () => cgRetry(machine, job) }); }
}

/** A restore that just ended says how it went, once, with Retry for the ones that failed. */
function cgWatchJobs() {
  for (const j of cgJobs()) {
    const was = cgSeen.get(j.machine);
    if (j.running) { cgSeen.set(j.machine, j.id); continue; }
    if (was !== j.id) continue;
    cgSeen.delete(j.machine);
    const done = j.items.filter((x) => x.state === "done").length, failed = j.items.length - done;
    if (!failed) toast(`Restored ${cgPlural(done, "session")}`);
    else toast(`Restored ${done} of ${j.items.length}. ${failed} couldn’t open.`, true, { label: "Retry", run: () => cgRetry(j.machine, j.id) });
  }
}

function cgChanged() {
  cgBanner();
  cgWatchJobs();
  if (typeof cgDialogUpdate === "function") cgDialogUpdate();
}

deckPlugins.register("crash-guard", {
  palette: (q) => [
    { t: "Restore a snapshot… (sessions open before herdr crashed)", slot: "more", order: 60, run: () => cgPickSnapshot() },
    ...cgCrashes().map((c) => ({ t: `Restore ${cgPlural(c.lost, "session")} lost when herdr restarted${multiMachine() ? ` on ${machineLabel(c.machine)}` : ""}`, slot: "more", order: 59, run: () => cgOpenRestore(c.machine, c.snapshotId) })),
  ],
  state: (data) => { S.crashGuard = data.crashGuard ?? S.crashGuard; for (const j of cgJobs()) if (j.running) cgSeen.set(j.machine, j.id); cgBanner(); },
  events: { "crash-guard": (data) => { S.crashGuard = data; cgChanged(); } },
});
