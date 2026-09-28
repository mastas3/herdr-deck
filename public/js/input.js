"use strict";
// Input: the splitters, keyboard shortcuts, right-click / long-press on a session, and phone navigation.
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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return !$("palette").open ? openPalette() : palRoute ? routeBack() : $("palette").close(); } // in the route view: back, like Esc
  if (e.defaultPrevented || e.target.matches("input, textarea, select, #screen") || document.querySelector("dialog[open]") || menuEl) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.mode === "inbox" && inboxKeydown(e)) return;
  const k = e.key, cur = S.sel && S.rows.has(S.sel) ? S.sel : null;
  if (k === "/") { e.preventDefault(); if (app.classList.contains("list-off")) $("listToggle").click(); $("q").focus(); $("q").select(); }
  else if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveSel(1); }
  else if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveSel(-1); }
  else if (k === "r" && cur) { e.preventDefault(); focusReply(); }
  else if (k === "." && (cur || S.picked.size)) { e.preventDefault(); openToolMenu(document.querySelector('[data-dact="tools"]') ?? $("cRecipe")); }
  else if (k === "i") setMode(S.mode === "inbox" ? null : "inbox");
  else if (k === "h") setMode(S.mode === "history" ? null : "history");
  else if (deckPlugins.key(k)) deckPlugins.key(k)(e);
  else if (k === "t" && cur) { e.preventDefault(); focusTerminal(); }
  else if (k === "`" && S.tpos === "tab") { e.preventDefault(); setMain(S.main === "chat" ? "term" : "chat"); }
  else if (k === "\\") { e.preventDefault(); setTpos(TPOS[(TPOS.indexOf(S.tpos) + 1) % TPOS.length]); toast(`Terminal: ${TPOS_NAME[S.tpos].toLowerCase()}`); }
  else if (k === "g") setGroup(S.group === "project" ? "priority" : "project");
  else if (k === "l") setBoard(!S.board);
  else if (k === "n") { e.preventDefault(); openNew(); }
  else if (k === "f" && cur) rowOf(cur)?.app ? codexAct("codex-open", rowOf(cur)) : focusPane(cur);
  else if (k === "y" && cur) copy(linkUrl(rowOf(cur)), "link");
  else if (k === "x" && (S.picked.size || cur)) askClose(targets());
  else if (k === "s" && cur) togglePick(cur);
  else if (k === "b" && cur) writeBrief(cur);
  else if (k === "e" && cur && !rowOf(cur)?.app && !rowOf(cur)?.hist) { e.preventDefault(); renameSession(rowOf(cur)); }
  else if (k === "[") $("listToggle").click();
  else if (k === "]") $("termToggle").click();
  else if (k === "c") { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); }
  else if (k === "?") $("help").showModal();
  else if (/^[1-9]$/.test(k)) { const ids = ["all", ...(S.summary.machines ?? []).map((m) => m.id)]; if (ids[k - 1] && ids.length > 2) setMachine(ids[k - 1]); }
  else if (k === "Escape") {
    const a = escAction({ chatPicks: chatSel.size, mode: S.mode, sub: S.sub, q: S.q, picked: S.picked.size, sel: S.sel && rowOf(S.sel) ? S.sel : null, board: S.board });
    if (a === "picks") clearPicks();
    else if (a === "mode") setMode(null);
    else if (a === "sub") { S.sub = null; headSig = ""; chatDom.key = null; renderDetail(); chatTick(true); }
    else if (a === "search") { S.q = ""; S.deep = null; $("q").value = ""; render(); }
    else if (a === "picked") { S.picked.clear(); render(); }
    else if (a === "home") goHome();
  }
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

// ── phone navigation: a native-feeling stack (list → chat ⇄ terminal) ─────
function setMView(v, push) {
  if (app.dataset.mview === v) return;
  const from = app.dataset.mview;
  app.dataset.mview = v;
  for (const b of document.querySelectorAll(".mbar [data-mv]")) b.setAttribute("aria-selected", b.dataset.mv === v);
  if (push && isPhone()) history.pushState({ mview: v }, "");
  if (v === "term") pollTerm(true);
  if (v === "detail") { chatTick(true); renderDetail(); }
  if (v === "list" && from !== "list") { S.board = false; requestAnimationFrame(() => rowCache.get(S.sel)?.el.scrollIntoView({ block: "nearest" })); }
}
addEventListener("popstate", (e) => setMView(e.state?.mview ?? "list", false));
$("mBack").onclick = () => (history.state?.mview ? history.back() : setMView("list", false));
document.querySelector(".mbar .seg2").addEventListener("click", (e) => {
  const v = e.target.closest("[data-mv]")?.dataset.mv;
  if (!v || v === app.dataset.mview) return;
  if (isPhone()) history.replaceState({ mview: v }, "");
  setMView(v, false);
});
// Swipe from the left edge to go back, like iOS.
{
  let sx = 0, sy = 0, dx = 0, on = false, panels = [];
  addEventListener("touchstart", (e) => {
    if (!isPhone() || app.dataset.mview === "list") return;
    const t = e.touches[0];
    if (t.clientX > 28) return;
    sx = t.clientX; sy = t.clientY; dx = 0; on = true;
    panels = [app.dataset.mview === "term" ? $("term") : $("detail"), $("mbar")];
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (!on) return;
    const t = e.touches[0];
    dx = Math.max(0, t.clientX - sx);
    if (Math.abs(t.clientY - sy) > 40 && dx < 20) { on = false; return; }
    app.classList.add("swiping");
    for (const p of panels) p.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  addEventListener("touchend", () => {
    if (!on) return;
    on = false;
    app.classList.remove("swiping");
    for (const p of panels) p.style.transform = "";
    if (dx > 80) (history.state?.mview ? history.back() : setMView("list", false));
  });
}
