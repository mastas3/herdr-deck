"use strict";
// Saved starts remain available after a browser reconnect, a failed launch, or a deck restart.
function startStateLabel(s) {
  return ({ creating: "Creating", starting: "Starting", sending: "Checking first message", failed: "Start failed", unknown: "Check delivery", ready: "Ready" })[s] || s;
}
function startActions(s, machine) {
  const attrs = `data-start-id="${esc(s.id)}" data-start-machine="${esc(machine)}"`;
  const open = s.key && rowOf(s.key) ? `<button type="button" class="btn" ${attrs} data-start-open="${esc(s.key)}">Open session</button>` : "";
  const active = ["creating", "starting", "sending"].includes(s.state);
  return `<div class="sugg">${open}${s.hasPrompt ? `<button type="button" class="btn" ${attrs} data-start-copy>Copy saved message</button>` : ""}${!active ? `<button type="button" class="btn" ${attrs} data-start-review>Review & start again</button><button type="button" class="btn ghost" ${attrs} data-start-dismiss>Dismiss</button>` : ""}</div>`;
}
function renderSavedStarts() {
  const el = $("nStarts"); if (!el) return;
  const list = newOpts?.starts ?? [];
  el.hidden = !list.length && !newOpts?.startError;
  el.innerHTML = `${newOpts?.startError ? `<p class="hint">${esc(newOpts.startError)}</p>` : ""}${list.length ? `<details open><summary>Saved starts · ${list.length}</summary><p class="hint">First messages are saved before startup. Check uncertain deliveries before starting another session.</p>${list.map(s => `<article class="saved-start"><strong>${esc(s.title)}</strong><p>${esc(startStateLabel(s.state))} · ${esc(abs(s.createdAt))}</p>${s.error ? `<p class="hint">${esc(s.error)}</p>` : ""}${startActions(s, newMachine)}</article>`).join("")}</details>` : ""}`;
}
function renderStartNotice(r) {
  let el = $("startNotice");
  if (!el) { el = document.createElement("div"); el.id = "startNotice"; el.className = "saved-start"; $("dh").after(el); }
  el.hidden = !r?.startup;
  if (!r?.startup) return;
  const s = { ...r.startup, key: r.key };
  setHTML(el, `<strong>${esc(startStateLabel(s.state))}</strong><p>${esc(s.error || "Your first message is saved while the session starts.")}</p>${startActions(s, r.machine ?? S.self)}`);
}
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-start-id]"); if (!b) return;
  const machine = b.dataset.startMachine, id = b.dataset.startId;
  try {
    if (b.dataset.startOpen) { if ($("newDlg").open) $("newDlg").close("cancel"); select(b.dataset.startOpen, { open: true, scroll: true }); openInspector("term"); return; }
    const r = await api("/api/start", { machine, id });
    if (b.hasAttribute("data-start-copy")) { await navigator.clipboard.writeText(r.body.prompt || ""); toast("Saved first message copied"); }
    if (b.hasAttribute("data-start-review")) {
      if ($("newDlg").open) $("newDlg").close("cancel");
      await openNew({ ...r.body, machine, title: "Review saved start" });
      toast("Review the first message and options, then Start. This creates another session.");
    }
    if (b.hasAttribute("data-start-dismiss")) {
      await api("/api/start", { machine, id, op: "dismiss" });
      if ($("newDlg").open) await loadNewOptions();
      toast("Start dismissed; its saved message is kept", false, { label: "Undo", run: async () => { await api("/api/start", { machine, id, op: "restore" }); if ($("newDlg").open) await loadNewOptions(); } });
    }
  } catch (err) { toast(err.message, true); }
});
