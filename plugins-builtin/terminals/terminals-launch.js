"use strict";
// Follow the machine filter, never the last selected agent row (which may be outside that filter).
function qtScopedMachine(scope, machines, self) {
  if (!scope || scope === "all") return null;
  const m = machines.find(m => m.id === scope);
  return m?.kind === "app" ? machines.find(m => m.id === self && m.kind !== "app") || null : m || null;
}
function qtQuickTerminal() {
  if (S.group === "folders" && typeof explorer !== "undefined") {
    const folder = exContext();
    if (folder) return exTerminal(folder);
  }
  const machines = S.summary.machines || [];
  qt.machines = machines.filter(m => m.kind !== "app");
  const target = qtScopedMachine(S.machine, machines, S.self);
  if (target) return qtOpenDock(target.id);
  qtPickMachine();
}
function qtPickMachine() {
  if ($("qtPicker")) return $("qtPicker").querySelector("input").focus();
  const d = document.createElement("dialog"); d.id = "qtPicker"; d.className = "palette qt-picker";
  d.setAttribute("aria-label", "Choose a machine for the terminal");
  d.innerHTML = '<div class="qt-pick-title"><span>Open terminal on…</span><button type="button" class="btn ghost" data-qt-cancel>Cancel</button></div><input aria-label="Find a machine" placeholder="Choose a machine…" autocomplete="off" spellcheck="false"><div class="pal-list" role="listbox" aria-label="Machines"></div><div class="pal-foot"><span>↑ ↓ choose</span><span>↵ open terminal</span><span>esc cancel</span></div>';
  let list = [], index = 0;
  const input = d.querySelector("input"), box = d.querySelector(".pal-list");
  function draw(reset = true) {
    list = qt.machines.filter(m => fuzzy(m.label, input.value.trim())); if (reset) index = 0;
    box.innerHTML = list.length ? list.map((m, i) => `<button type="button" role="option" data-qt-pick="${i}" aria-selected="${i === index}" class="${i === index ? "on" : ""}"><span class="dot" style="--c:var(--${m.online ? "idle" : "blocked"})"></span><span>${esc(m.label)}</span><small>${m.local ? "This machine" : m.online ? "Connected" : "Offline · try connecting"}</small></button>`).join("") : '<p class="hint">No matching machines.</p>';
  }
  function choose(i) { const m = list[i]; if (!m || !d.open) return; d.close(); d.remove(); qtOpenDock(m.id); }
  input.addEventListener("input", () => draw());
  d.addEventListener("click", e => { const b = e.target.closest("[data-qt-pick]"); if (b) choose(Number(b.dataset.qtPick)); else if (e.target === d || e.target.closest("[data-qt-cancel]")) d.close(); });
  d.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!list.length) return; index = (index + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length; draw(false); box.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && !e.target.closest("[data-qt-cancel]")) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) choose(Number(e.target.closest("[data-qt-pick]")?.dataset.qtPick ?? index)); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); d.close(); openPalette(); }
  });
  d.addEventListener("close", () => d.remove()); document.body.append(d); draw(); d.showModal(); input.focus();
}
function qtRemoveDock() { qt.docked = false; const el = $("qtDock"); if (!el) return; const leave = motion.ghost([el], document.body); el.remove(); leave(); }
async function qtClosePanel() {
  if (qt.docked) qtRemoveDock();
  await qtRelease(); qtRender();
}
function qtOpenDock(machine, id, cwd) {
  if (qt.busy) return;
  // Move off the management page before mounting the same terminal UI in the drawer.
  if (S.mode === "terminals") { setMode(null); $("qtRoot")?.remove(); }
  qt.docked = true; qtOpen(machine, id, cwd);
}
async function qtManage() {
  if (qt.docked) { qtRemoveDock(); await qtRelease(); }
  setMode("terminals");
}
