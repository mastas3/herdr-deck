"use strict";
// Crash guard's dialogs: pick a saved snapshot (⌘K), then a checklist of its sessions grouped by machine and
// workspace (agent sessions that aren't open now are ticked; plain processes are not; empty shells are left out), and
// the same dialog shows the restore as it runs, with Retry for the ones that failed.
let cgDlg = null; // { el, machine, snap, job }
const CG_AGENTS = new Set(["claude", "codex", "opencode"]); // an agent pane without a conversation has nothing to resume

function cgDialog(cls) {
  cgDlg?.el.close();
  const el = document.createElement("dialog");
  el.className = `cgdlg ${cls}`;
  document.body.append(el);
  el.addEventListener("close", () => { el.remove(); if (cgDlg?.el === el) cgDlg = null; });
  el.addEventListener("click", (e) => { if (e.target === el) el.close(); }); // a click on the backdrop
  return el;
}

/** Every saved snapshot on every machine, newest first; the one from before a crash says so. */
function cgPickSnapshot() {
  const ms = cgMachines().filter((m) => m.snapshots?.length);
  if (!ms.length) return toast("No snapshots yet. Crash guard saves one when your panes change, and once a minute.");
  const el = cgDialog("pick");
  cgDlg = { el, job: null };
  const crashOf = (m, id) => (m.crashes ?? []).find((c) => c.snapshotId === id);
  el.innerHTML = `<div class="dlg-b"><h3>Restore a snapshot</h3><p>Crash guard saves your open panes when they change. Pick one to see its sessions.</p>
    ${ms.map((m) => `${multiMachine() ? `<h4 class="cg-h">${esc(machineLabel(m.machine))}</h4>` : ""}<div class="cg-snaps">${m.snapshots.slice(0, 20).map((s) => { const c = crashOf(m, s.id); return `<button class="cg-snap" data-cgm="${esc(m.machine)}" data-cgs="${esc(s.id)}">
      <b>${esc(DF.format(new Date(s.seenAt)))}</b><span>${cgPlural(s.agents, "agent session")} · ${cgPlural(s.count, "pane")}</span>${c ? `<span class="cg-tag">before herdr ${c.reason === "restarted" ? "restarted" : "lost them"}</span>` : ""}<small>${esc(agoText(s.seenAt))}</small></button>`; }).join("")}</div>`).join("")}</div>
    <div class="dlg-f"><button class="btn" data-cgclose>Close</button></div>`;
  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-cgclose]")) return el.close();
    const b = e.target.closest(".cg-snap");
    if (b) cgOpenRestore(b.dataset.cgm, b.dataset.cgs);
  });
  el.showModal();
}

const cgWhere = (p) => `${esc(p.agent)} · ${esc(p.project)} · <span class="mono">${esc(home(p.cwd))}</span>`;
function cgItemHTML(p, on) {
  const agent = !!p.resume;
  const why = p.open ? "open now" : agent ? "" : "opens a shell in its folder";
  return `<label class="cg-item${p.open ? " open" : ""}"><input type="checkbox" value="${esc(p.key)}"${on ? " checked" : ""}${p.open ? " disabled" : ""}>
    <span class="cg-it"><b>${esc(p.title || p.agent)}</b><small>${cgWhere(p)}${why ? ` · <i>${why}</i>` : ""}</small>${p.cmd ? `<code>${esc(p.cmd)}</code>` : ""}</span></label>${
    p.risky?.length && !p.open ? `<label class="cg-risky"><input type="checkbox" data-cgrisky value="${esc(p.key)}"> It ran with <code>${esc(p.risky.join(" "))}</code>. Add it back</label>` : ""}`;
}

/** The checklist for one snapshot; with a job id it opens on that restore's progress. */
async function cgOpenRestore(machine, snapId, jobId) {
  let snap;
  try { snap = await cgApi(machine, { op: "snapshot", id: snapId }); } catch (x) { return toast(x.message, true); }
  const el = cgDialog("restore");
  cgDlg = { el, machine, snap, job: jobId ?? null };
  const panes = snap.panes.filter((p) => p.resume || (!p.empty && p.agent !== "shell" && !CG_AGENTS.has(p.agent)));
  const skipped = snap.panes.length - panes.length;
  const groups = new Map();
  for (const p of panes) groups.set(p.workspace, [...(groups.get(p.workspace) ?? []), p]);
  const pre = (p) => !!p.resume && !p.open;
  el.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Restore sessions</h3>
    <p>From ${esc(DF.format(new Date(snap.seenAt)))}${multiMachine() ? ` on ${esc(machineLabel(machine))}` : ""} (${esc(agoText(snap.seenAt))}). Each opens in a new tab in its workspace and folder, then resumes.</p>
    <div class="cg-list">${[...groups].map(([ws, ps]) => `<fieldset class="cg-ws"><legend><label><input type="checkbox" data-cgall${ps.some(pre) ? " checked" : ""}> Workspace ${esc(ws)}</label> <span class="hint">${cgPlural(ps.length, "session")}</span></legend>
      ${ps.map((p) => cgItemHTML(p, pre(p))).join("")}</fieldset>`).join("")}</div>
    ${skipped ? `<p class="hint">${cgPlural(skipped, "pane")} left out: empty shells and agents that hadn't started a conversation.</p>` : ""}
    <p class="hint cg-rate">Opens ${S.crashGuard?.machines?.[machine]?.atOnce ?? 2} at a time: each waits for its shell before the resume command is typed.</p></div>
    <div class="cg-prog" hidden></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok" data-cgok></button></div></form>`;
  const form = el.querySelector("form");
  const picked = () => [...form.querySelectorAll(".cg-item input:checked")].map((x) => x.value);
  const sync = () => {
    const n = picked().length, ok = form.querySelector("[data-cgok]");
    ok.textContent = n ? `Restore ${cgPlural(n, "session")}` : "Pick sessions";
    ok.disabled = !n;
    for (const fs of form.querySelectorAll(".cg-ws")) {
      const boxes = [...fs.querySelectorAll(".cg-item input:not(:disabled)")], all = fs.querySelector("[data-cgall]");
      all.checked = boxes.length > 0 && boxes.every((b) => b.checked); all.indeterminate = !all.checked && boxes.some((b) => b.checked);
    }
  };
  form.addEventListener("change", (e) => {
    if (e.target.matches("[data-cgall]")) for (const b of e.target.closest(".cg-ws").querySelectorAll(".cg-item input:not(:disabled)")) b.checked = e.target.checked;
    sync();
  });
  form.addEventListener("submit", async (e) => {
    const ok = e.submitter?.hasAttribute("data-cgok");
    if (!ok || cgDlg?.job) return; // Cancel / Close closes
    e.preventDefault();
    const keys = picked();
    const unsafe = [...form.querySelectorAll("[data-cgrisky]:checked")].map((x) => x.value).filter((k) => keys.includes(k));
    form.querySelector("[data-cgok]").disabled = true;
    try { const { job } = await cgApi(machine, { op: "restore", id: snap.id, keys, unsafe }); cgDlg.job = job.id; cgSeen.set(machine, job.id); cgShowJob(job); }
    catch (x) { toast(x.message, true); sync(); }
  });
  sync();
  el.showModal();
  if (jobId) cgDialogUpdate();
}

const CG_STATE = { waiting: "waiting", opening: "opening…", done: "open", failed: "couldn’t open" };
/** Switches the restore dialog to its progress: one line per session, and Retry once it's over. */
function cgShowJob(job) {
  const el = cgDlg?.el;
  if (!el || !job) return;
  const done = job.items.filter((x) => x.state === "done").length, failed = job.items.filter((x) => x.state === "failed");
  el.querySelector(".dlg-b").hidden = true;
  const prog = el.querySelector(".cg-prog");
  prog.hidden = false;
  setHTML(prog, `<div class="dlg-b"><h3>${job.running ? "Restoring…" : failed.length ? "Some couldn’t open" : "Restored"}</h3>
    <p>${done} of ${job.items.length} open${failed.length ? `, ${failed.length} failed` : ""}.${job.running ? ` ${job.atOnce} at a time; each waits for its shell.` : ""}</p>
    <ol class="cg-steps">${job.items.map((x) => `<li data-st="${x.state}"><span class="cg-st">${x.state === "opening" ? '<span class="spin"></span>' : ""}${CG_STATE[x.state]}</span><span class="cg-it"><b>${esc(x.title || x.agent)}</b><small>${esc(x.workspace)} · <span class="mono">${esc(home(x.cwd))}</span></small>${x.error ? `<small class="cg-err">${esc(x.error)}</small>` : ""}</span></li>`).join("")}</ol></div>`);
  const ok = el.querySelector("[data-cgok]"), cancel = el.querySelector('[value="cancel"]');
  cancel.textContent = job.running ? "Hide" : "Close";
  ok.hidden = job.running || !failed.length;
  ok.disabled = false;
  ok.textContent = `Retry ${cgPlural(failed.length, "session")}`;
  ok.onclick = (e) => { e.preventDefault(); cgRetry(cgDlg.machine, job.id); };
}

/** Live progress in the open dialog, from the plugin's broadcasts. */
function cgDialogUpdate() {
  if (!cgDlg?.job) return;
  const m = S.crashGuard?.machines?.[cgDlg.machine];
  if (m?.job?.id === cgDlg.job) cgShowJob(m.job);
}
