"use strict";
const qt = { machines: [], lists: new Map(), active: null, docked: false, busy: false, timer: null, run: 0, pending: null, send: Promise.resolve(), ops: [], inputTimer: null };
const qtIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m5 6 5 6-5 6m8 0h6"/></svg>';
// Polling and typing have feedback inside the terminal, without flashing the deck's global activity bar.
async function qtCall(op, machine, fields = {}) {
  const r = await fetch("/api/terminals", { method: "POST", headers: { "content-type": "application/json", "x-deck-token": S.token }, body: JSON.stringify({ op, machine, ...fields }), signal: AbortSignal.timeout(20000) });
  if (r.status === 403) reconnectSoon(200);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || (r.status === 403 ? "Reconnecting to the deck…" : "Terminal unavailable.")), { status: r.status });
  return data;
}
const qtMachine = id => qt.machines.find(m => m.id === id);
function qtRender() {
  if (!qt.docked && S.mode !== "terminals") return;
  if (qt.docked && !$("qtDock")) {
    const dock = document.createElement("section"); dock.id = "qtDock"; dock.className = "qt-dock";
    dock.setAttribute("aria-label", "Terminal panel");
    dock.innerHTML = '<div id="qtRoot"><div id="qtWorkspace"></div></div>';
    document.body.append(dock); motion.run(dock, [{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { dur: 3 }); $("qtRoot").addEventListener("click", qtClick);
  }
  if (!$("qtRoot")) {
    modeHTML(`<section id="qtRoot" class="qt-root"><header class="qt-intro"><h2>Terminals</h2><p class="hint">A quick shell on any machine. Keep it if you want to come back.</p></header><div id="qtMachines" class="qt-machines"></div><div id="qtWorkspace"></div></section>`);
    $("qtRoot").addEventListener("click", qtClick);
  }
  if (!qt.docked) setHTML($("qtMachines"), qt.machines.map(m => {
    const data = qt.lists.get(m.id);
    return `<section class="qt-machine"><div class="qt-machine-head"><span class="dot" style="--c:var(--${m.online ? "idle" : "blocked"})"></span><b>${esc(m.label)}</b><span class="hint">${m.local ? "This machine" : m.online ? "Connected" : "Offline"}</span><span class="spacer"></span><button class="btn" data-qt-new="${esc(m.id)}" ${qt.busy ? "disabled" : ""}>${qtIcon}Open terminal</button></div>
      ${data?.error ? `<p class="qt-error">${esc(data.error)} <button class="link" data-qt-refresh="${esc(m.id)}">Retry</button></p>` : !data ? `<p class="hint">Checking terminals…</p>` : data.terminals.length ? `<div class="qt-saved">${data.terminals.map(t => `<div><button class="link" data-qt-resume="${esc(t.id)}" data-qt-machine="${esc(m.id)}">${esc(t.title)}</button><small>${t.exited ? "Exited" : t.kept ? "Kept" : "Temporary"}</small><button class="btn ghost" data-qt-end="${esc(t.id)}" data-qt-machine="${esc(m.id)}" aria-label="End ${esc(t.title)}">End</button></div>`).join("")}</div>` : `<p class="hint">No kept terminals yet.</p>`}</section>`;
  }).join(""));
  const a = qt.active;
  if (!a) {
    if (qt.docked && !qt.busy) { qtRemoveDock(); return; }
    setHTML($("qtWorkspace"), qt.busy ? '<div class="qt-opening"><p class="hint" role="status">Opening terminal…</p><button class="btn ghost" data-qt-close>Cancel</button></div>' : '<p class="hint qt-note">Temporary terminals close when you leave this view. If the connection drops, you have five minutes to reconnect.</p>'); return;
  }
  if ($("qtWorkspace").dataset.id !== a.id || !$("qtScreen")) {
    $("qtWorkspace").dataset.id = a.id;
    $("qtWorkspace").innerHTML = `<section class="qt-shell"><header class="qt-shell-head"><div><strong id="qtTitle"></strong><small id="qtState"></small></div><span class="spacer"></span><button class="btn" data-qt-keep>Keep terminal</button><button class="btn ghost" data-qt-rename hidden>Rename</button><button class="btn ghost" data-qt-close>Close terminal</button></header>
      <p id="qtStatus" class="qt-status" role="status"></p><pre id="qtScreen" class="qt-screen" tabindex="0" aria-label="Terminal output; click to type" spellcheck="false"></pre>
      <div class="qt-keys" aria-label="Terminal keys">${["ctrl+c", "esc", "tab", "up", "down", "left", "right", "enter"].map(k => `<button class="btn ghost" data-qt-key="${k}" aria-label="Send ${k}">${esc(k === "ctrl+c" ? "Ctrl+C" : k)}</button>`).join("")}</div>
      <form id="qtForm" class="qt-input"><label class="sr-only" for="qtCommand">Command or terminal input</label><input id="qtCommand" class="inp" placeholder="Type a command…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button class="btn primary" type="submit">Send ↵</button></form><p class="hint qt-tip">Click the output to type directly, or use the command box. Ctrl+C stops a running command.</p></section>`;
    $("qtScreen").addEventListener("keydown", qtKeydown);
    $("qtScreen").addEventListener("paste", e => { const text = e.clipboardData?.getData("text/plain"); if (text) { e.preventDefault(); qtQueue({ text }); } });
    $("qtForm").addEventListener("submit", async e => {
      e.preventDefault(); const input = $("qtCommand"), value = input.value, a = qt.active;
      if (!a || !value || input.disabled) return;
      qtFlush(); // A shortcut pressed just before Send must reach the shell first.
      input.disabled = true;
      try { await qtInput(a, [{ text: value }, { key: "enter" }]); if (qt.active === a && input.value === value) input.value = ""; }
      catch (err) { qtStatus(err.message + " Input may have arrived; check the terminal before sending again."); }
      finally { input.disabled = false; if (qt.active === a) input.focus(); }
    });
  }
  $("qtTitle").textContent = `${a.title === "Terminal" && a.cwd && a.cwd !== "~" ? a.cwd.split("/").filter(Boolean).pop() || "/" : a.title} · ${qtMachine(a.machine)?.label || a.machine}`;
  $("qtState").textContent = a.exited ? "Shell exited" : a.kept ? "Kept · reconnect here anytime while the machine stays on" : qt.docked ? "Temporary · closes with this panel" : "Temporary · closes when you leave";
  $("qtRoot").querySelector("[data-qt-keep]").hidden = a.kept;
  $("qtRoot").querySelector("[data-qt-rename]").hidden = !a.kept;
  $("qtRoot").querySelector("[data-qt-close]").textContent = a.kept ? "Detach" : "Close terminal";
}
function qtStatus(text) { if ($("qtStatus")) $("qtStatus").textContent = text; }
async function qtList(machine) {
  try { qt.lists.set(machine, await qtCall("list", machine)); }
  catch (e) { qt.lists.set(machine, { error: e.message }); }
  qtRender();
}
async function qtLoad() {
  try { qt.machines = (await qtCall("machines")).machines; qtRender(); await Promise.all(qt.machines.map(m => qtList(m.id))); }
  catch (e) { toast(e.message, true, { label: "Retry", run: qtLoad }); }
}
function qtSize() {
  const el = $("qtScreen");
  return { cols: Math.max(30, Math.min(240, Math.floor(((el?.clientWidth || $("dbody").clientWidth) - 32) / 7.8))), rows: 30 };
}
async function qtPoll() {
  const a = qt.active, run = ++qt.run; clearTimeout(qt.timer);
  if (!a || !qt.docked && S.mode !== "terminals") return;
  if (!document.hidden) {
    try {
      const r = await qtCall("read", a.machine, { id: a.id, ...qtSize() });
      if (a !== qt.active || run !== qt.run) return;
      Object.assign(a, r.terminal); qtRender();
      const el = $("qtScreen"); if (!el) return;
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 45;
      const html = ansi(r.text.replace(/\s+$/, ""));
      if (el.innerHTML !== html) { el.innerHTML = html; if (atEnd) el.scrollTop = el.scrollHeight; }
      qtStatus(a.exited ? "The shell has exited. Close this terminal and open another." : "");
    } catch (e) {
      if (a === qt.active) qtStatus(e.message + (e.status === 410 ? " Open another terminal to continue." : " Reconnecting…"));
      if (e.status === 410) return;
    }
  }
  if (a === qt.active && run === qt.run) qt.timer = setTimeout(qtPoll, document.hidden ? 15000 : 1000);
}
function qtInput(a, ops) {
  const next = qt.send.catch(() => {}).then(() => qtCall("input", a.machine, { id: a.id, ops }));
  qt.send = next; next.then(() => { if (a === qt.active) qtPoll(); }, () => {}); return next;
}
function qtQueue(op) {
  if (!qt.active) return;
  const last = qt.ops.at(-1);
  if (op.text && last?.text) last.text += op.text; else qt.ops.push(op);
  if (!qt.inputTimer) qt.inputTimer = setTimeout(qtFlush, 40);
}
function qtFlush() {
  clearTimeout(qt.inputTimer); qt.inputTimer = null;
  const ops = qt.ops; qt.ops = []; const a = qt.active;
  if (a && ops.length) qtInput(a, ops).catch(e => { if (a === qt.active) qtStatus(e.message + " Check before typing again."); });
}
function qtKeydown(e) {
  if (e.metaKey || e.isComposing) return;
  const keys = { Enter: "enter", Escape: "esc", Tab: e.shiftKey ? "shift+tab" : "tab", Backspace: "backspace", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end", Delete: "delete" };
  const key = keys[e.key] || (e.ctrlKey && /^[a-z]$/i.test(e.key) ? "ctrl+" + e.key.toLowerCase() : "");
  if (key) { e.preventDefault(); e.stopPropagation(); qtQueue({ key }); }
  else if (!e.ctrlKey && !e.altKey && e.key.length === 1) { e.preventDefault(); e.stopPropagation(); qtQueue({ text: e.key }); }
}
async function qtRelease() {
  qtFlush(); const a = qt.active; qt.active = null; ++qt.run; clearTimeout(qt.timer);
  if (!a) return;
  await qt.send.catch(() => {});
  try { await qtCall("release", a.machine, { id: a.id }); }
  catch (e) { toast(a.kept ? e.message : "Connection lost. The temporary terminal will expire within five minutes.", true); }
  qtList(a.machine);
}
async function qtOpen(machine, id, cwd) {
  if (qt.busy) return;
  const docked = qt.docked;
  qt.busy = true; qtRender();
  try {
    await qtRelease();
    if (id) {
      const r = await qtCall("read", machine, { id }); qt.active = { ...r.terminal, machine };
    } else {
      const pending = qt.pending?.machine === machine && qt.pending.cwd === cwd ? qt.pending : { machine, cwd, id: "deck-" + crypto.randomUUID() }; qt.pending = pending;
      const r = await qtCall("open", machine, { id: pending.id, cwd, ...qtSize() }); qt.pending = null;
      qt.active = { ...r.terminal, machine, cwd };
    }
    // A slow connection may finish after the user navigated away.
    if (docked ? !qt.docked : S.mode !== "terminals") { await qtRelease(); return; }
    qtRender(); qtPoll(); qtList(machine); $("qtWorkspace").scrollIntoView({ block: "nearest" });
    if (!isPhone()) $("qtScreen").focus({ preventScroll: true });
  } catch (e) { toast(e.message, true, { label: "Retry", run: () => docked ? qtOpenDock(machine, id, cwd) : qtOpen(machine, id, cwd) }); }
  finally { qt.busy = false; qtRender(); }
}
async function qtClick(e) {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.qtNew) return qtOpen(b.dataset.qtNew);
  if (b.dataset.qtRefresh) return qtList(b.dataset.qtRefresh);
  if (b.dataset.qtResume) return qtOpen(b.dataset.qtMachine, b.dataset.qtResume);
  if (b.dataset.qtKey) return qtQueue({ key: b.dataset.qtKey });
  if (b.hasAttribute("data-qt-close")) return qtClosePanel();
  const a = qt.active;
  try {
    if (b.hasAttribute("data-qt-keep") && a) {
      b.disabled = true;
      const r = await qtCall("keep", a.machine, { id: a.id, kept: true, title: `${qtMachine(a.machine)?.label || "Machine"} terminal` });
      Object.assign(a, r.terminal); qtRender(); qtList(a.machine);
      toast("Terminal kept. Detach and come back anytime.", false, { label: "Undo", run: async () => {
        try { const r = await qtCall("keep", a.machine, { id: a.id, kept: false }); Object.assign(a, r.terminal); qtRender(); qtList(a.machine); }
        catch (err) { toast(err.message, true); }
      } });
    } else if (b.hasAttribute("data-qt-rename") && a) {
      const title = await askDialog({ title: "Name this terminal", input: a.title, ok: "Save" });
      if (title) { const r = await qtCall("keep", a.machine, { id: a.id, kept: true, title }); Object.assign(a, r.terminal); qtRender(); qtList(a.machine); }
    } else if (b.dataset.qtEnd) {
      const machine = b.dataset.qtMachine, id = b.dataset.qtEnd;
      if (!(await askDialog({ title: "End this terminal?", text: "Stops its shell and running commands. Its terminal history cannot be restored.", ok: "End terminal", danger: true }))) return;
      await qtCall("close", machine, { id });
      if (qt.active?.id === id && qt.active.machine === machine) { qt.active = null; ++qt.run; clearTimeout(qt.timer); }
      qtList(machine); qtRender();
    }
  } catch (err) { toast(err.message, true); }
  finally { b.disabled = false; }
}
addEventListener("pagehide", () => {
  const a = qt.active;
  if (a && !a.kept) fetch("/api/terminals", { method: "POST", headers: { "content-type": "application/json", "x-deck-token": S.token }, body: JSON.stringify({ op: "release", machine: a.machine, id: a.id }), keepalive: true }).catch(() => {});
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && qt.active && (qt.docked || S.mode === "terminals")) qtPoll(); });
const qtRegistration = deckPlugins.register("terminals", {
  views: { terminals: { render: qtRender, load: qtLoad, leave: () => { if (!qt.docked) qtRelease(); }, path: () => "/terminals" } },
  palette: () => [
    { t: "Open terminal", run: qtQuickTerminal, slot: "quick", order: 0 },
    { t: "Terminals: saved terminals", run: qtManage, slot: "more", order: 22 },
  ],
  settings: [{ html: "Saved terminals<small>Reconnect to a terminal you kept</small>", run: () => qtManage() }],
  links: url => { if (url.pathname !== "/terminals") return false; qtManage(); return true; },
});

qtRegistration.extend("folder.terminal", { open: ({ machine, cwd }) => { qt.machines = (S.summary.machines || []).filter(m => m.kind !== "app"); qtOpenDock(machine, undefined, cwd); } });
