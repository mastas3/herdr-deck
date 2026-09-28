"use strict";
// Input: the splitters, keyboard shortcuts, and right-click / long-press on a session.
// Splitters: window-level listeners so fast drags over other panels never drop.
function drag(el, axisOf, onMove, onEnd) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const axis = axisOf();
    el.classList.add("drag");
    document.body.classList.add("dragging", axis === "x" ? "col" : "row");
    const move = (ev) => { ev.preventDefault(); onMove(ev); };
    const up = () => { el.classList.remove("drag"); document.body.classList.remove("dragging", "col", "row"); removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); onEnd(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  });
}
let lw = load("lw", 380), th = load("th", Math.round(innerHeight * 0.34)), tw = load("tw", Math.round(innerWidth * 0.4));
const setLw = (v) => { lw = Math.round(Math.max(260, Math.min(innerWidth * 0.6, v))); app.style.setProperty("--lw-open", lw + "px"); };
const setTh = (v) => { th = Math.round(Math.max(90, Math.min(innerHeight - 180, v))); app.style.setProperty("--th-open", th + "px"); };
const setTw = (v) => { tw = Math.round(Math.max(280, Math.min(innerWidth - lw - 320, v))); app.style.setProperty("--tw-open", tw + "px"); };
const unCollapse = () => { if (app.classList.contains("term-off")) { app.classList.remove("term-off"); store("termOff", false); } };
drag($("splitV"), () => "x", (e) => setLw(e.clientX), () => { store("lw", lw); fitTerm(); });
drag($("splitH"), () => (S.tpos === "right" ? "x" : "y"), (e) => {
  if (S.tpos === "right") setTw(innerWidth - e.clientX);
  else setTh(S.tpos === "top" ? e.clientY : innerHeight - e.clientY);
  unCollapse();
}, () => { store("th", th); store("tw", tw); fitTerm(); });
$("splitV").ondblclick = () => { setLw(380); store("lw", lw); fitTerm(); };
$("splitH").ondblclick = () => { if (S.tpos === "right") { setTw(Math.round(innerWidth * 0.4)); store("tw", tw); } else { setTh(Math.round(innerHeight * 0.34)); store("th", th); } fitTerm(); };
$("splitV").addEventListener("keydown", (e) => { const step = e.shiftKey ? 60 : 20; if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setLw(lw + (e.key === "ArrowRight" ? step : -step)); store("lw", lw); fitTerm(); } });
$("splitH").addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 60 : 20;
  if (S.tpos === "right" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); setTw(tw + (e.key === "ArrowLeft" ? step : -step)); store("tw", tw); fitTerm(); }
  if (S.tpos !== "right" && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); setTh(th + ((e.key === "ArrowUp") === (S.tpos === "bottom") ? step : -step)); store("th", th); fitTerm(); }
});
new ResizeObserver(() => fitTerm()).observe($("screen"));

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && chatSel.size && !getSelection()?.toString()) { e.preventDefault(); copyBlocks([...chatSel]); return clearPicks(); }
  // ⌘Z outside a text field: the Undo on the toast showing now (a close, a rename, a skip).
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !e.target.matches("input, textarea, select, [contenteditable]") && toastUndo()) { e.preventDefault(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return !$("palette").open ? openPalette() : palRoute ? routeBack() : $("palette").close(); } // in the route view: back, like Esc
  if (e.defaultPrevented || e.target.matches("input, textarea, select, #screen") || document.querySelector("dialog[open]") || menuEl) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.mode === "inbox" && inboxKeydown(e)) return;
  // The bindings are data (keymap.js): the "?" sheet and ⌘K's hints read the same table.
  const b = keyBinding(e.key);
  if (b) { e.preventDefault(); b.run(e); }
  else if (deckPlugins.key(e.key)) deckPlugins.key(e.key)(e);
});

// ── right-click (or long-press) a session ────────────────────────────────
function rowMenu(r, x, y) {
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), focus() {} };
  const live = !r.app && !r.hist;
  const items = [
    { html: `Open`, run: () => { select(r.key, { scroll: true, open: true }); } },
    live && { html: "Rename…<small>The pane, the tab and the agent’s own name</small>", run: () => renameSession(r) },
    live && isAgent(r) && { html: "Message it…", run: () => { select(r.key, { open: true }); focusReply(); } },
    live && !isPhone() && { html: "Jump to it in herdr", run: () => focusPane(r.key) },
    r.app && { html: "Open in the Codex app", run: () => codexAct("codex-open", r) },
    r.app && { html: "Continue in herdr", run: () => codexAct("codex-resume", r) },
    projectHome(r.project) && { html: `New session in ${esc(r.project)}`, run: () => openNew(projectHome(r.project)) },
    { html: "Copy link", run: () => copy(linkUrl(r), "link") },
    live && { html: S.picked.has(r.key) ? "Unselect" : "Select<small>To act on several at once</small>", run: () => togglePick(r.key) },
    "-",
    live && { html: "Close session…", danger: true, run: () => askClose([r.key]) },
    r.app && { html: "Hide from the deck", danger: true, run: () => codexAct("codex-hide", r) },
  ].filter(Boolean);
  openMenu(anchor, items, r.title || r.agent);
}
$("rows").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-rask]");
  if (!card) return;
  e.stopPropagation();
  const key = card.dataset.rask, d = (S.decisions ?? []).find((x) => x.key === key);
  if (!d) return;
  const b = e.target.closest("[data-ropt]");
  if (b) {
    const o = d.options.find((x) => String(x.id) === b.dataset.ropt);
    if (!o) return;
    card.classList.add("sending");
    try { await answerOption(d, o); toast(`Answered: ${plain(o.title).slice(0, 60)}`); render(); if (S.mode === "inbox") renderInbox(); renderViews(); }
    catch (x) { card.classList.remove("sending"); toast(x.message, true); }
    return;
  }
  if (e.target.closest("[data-rreply], [data-ropen]")) { select(key, { scroll: true, open: true }); if (e.target.closest("[data-rreply]")) focusReply(); return; }
  select(key, { scroll: true, open: true });
}, true);
$("rows").addEventListener("contextmenu", (e) => {
  const el = e.target.closest(".row[data-key]");
  const r = el && rowOf(el.dataset.key);
  if (!r) return;
  e.preventDefault();
  rowMenu(r, e.clientX, e.clientY);
});
// Touch: hold a row for half a second (iOS has no contextmenu event).
{
  let t = 0, sx = 0, sy = 0, fired = false;
  $("rows").addEventListener("touchstart", (e) => {
    const el = e.target.closest(".row[data-key]");
    if (!el || e.touches.length > 1) return;
    fired = false; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    clearTimeout(t);
    t = setTimeout(() => { const r = rowOf(el.dataset.key); if (r) { fired = true; navigator.vibrate?.(8); rowMenu(r, sx, sy); } }, 480);
  }, { passive: true });
  $("rows").addEventListener("touchmove", (e) => { if (Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 8) clearTimeout(t); }, { passive: true });
  $("rows").addEventListener("touchend", (e) => { clearTimeout(t); if (fired) { e.preventDefault(); fired = false; } });
}
// Phone navigation (the screen stack, back, swipes) is nav.js, nav-anim.js and swipe.js.
