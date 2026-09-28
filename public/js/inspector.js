"use strict";
// The inspector: a column on the right for the open session (on the phone, the screen behind the top bar's second tab).
// Its tabs come from the "inspector.tabs" extension point: the core's Terminal (10), Subagents (40) and Servers (50),
// in inspector-tabs.js, and any plugin's, from its page script:
//   deckPlugins.register(id).extend("inspector.tabs", { key, label, icon, order, when?(row), badge?(row),
//                                                       render(el, row), patch?(el, row), leave?() })
//   when(row)        the tab shows for this session (default: always)
//   badge(row)       a short count after its label, or "" (optional)
//   render(el, row)  fill el (a fresh, empty element) when the tab opens, or another session is opened
//   patch(el, row)   the session's row or its loaded detail changed: update el, cheaply (it runs often while an agent
//                    works; optional)
//   leave()          the tab went away: another tab, another session, the inspector closed (optional)
// The Terminal tab's element is static (#tpane); every other tab renders into #ipane.

/** The core's own tabs (inspector-tabs.js adds them). */
const CORE_ITABS = [];
const INSP = { key: null, sel: null, row: null, d: null, tab: null };
/** The tab showing now (or the one the inspector will open on). */
const inspTab = () => INSP.key ?? S.insp.tab;
/** Every tab this session gets, in order. A plugin's tab that throws or clashes with a core key is left out. */
function inspTabs(r) {
  if (!r || S.simple) return [];
  const seen = new Set(), out = [];
  const list = [...CORE_ITABS.map((c) => ({ id: "core", c })), ...deckPlugins.entries("inspector.tabs")];
  for (const { id, c } of list) {
    const bad = !c || typeof c.key !== "string" ? "needs a key" : seen.has(c.key) ? "that key is taken" : c.key !== "term" && typeof c.render !== "function" ? "needs render(el, row)" : "";
    if (bad) { if (id !== "core") deckPlugins.note(id, `inspector tab ${c?.key ?? "?"}: ${bad}`); continue; }
    let ok = true;
    try { ok = !c.when || !!c.when(r); } catch (e) { ok = false; deckPlugins.note(id, `inspector.tabs ${c.key}: ${e?.message ?? e}`); }
    if (ok) { seen.add(c.key); out.push({ ...c, id }); }
  }
  return out.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}
function inspCall(t, fn, ...args) {
  try { return t[fn]?.(...args); } catch (e) { console.error(`inspector tab ${t.key}.${fn}:`, e); if (t.id !== "core") deckPlugins.note(t.id, `inspector.tabs ${t.key}.${fn}: ${e?.message ?? e}`); }
}
function inspLeave() {
  const t = INSP.tab;
  INSP.key = INSP.sel = INSP.row = INSP.d = INSP.tab = null;
  if (t && t.key !== "term") { inspCall(t, "leave"); $("ipane").replaceChildren(); }
}
/** Brings the inspector in line with the page: its column (desktop), its tab bar and the tab's content. Runs after
 *  every renderDetail, so it only touches what changed. */
function renderInspector() {
  const r = !S.mode && !S.board ? rowOf(S.sel) : null;
  const tabs = inspTabs(r);
  const want = tabs.find((t) => t.key === S.insp.tab) ?? tabs[0];
  const col = !isPhone() && !!want && S.insp.open;
  if (app.classList.contains("insp-on") !== col) { app.classList.toggle("insp-on", col); requestAnimationFrame(() => { fitTerm(); pollTerm(); }); }
  if ($("mInsp").textContent !== (want?.label ?? "Terminal")) $("mInsp").textContent = want?.label ?? "Terminal";
  $("mInsp").parentElement.hidden = !want;
  const pressed = document.querySelector('#dh [data-dact="insp"]');
  if (pressed) pressed.setAttribute("aria-pressed", col);
  if (!want) return inspLeave();
  setHTML($("itabs"), tabs.map((t) => {
    let n = "";
    try { n = t.badge?.(r) ?? ""; } catch {}
    const ic = typeof t.icon === "function" ? t.icon() : t.icon ?? "";
    return `<button role="tab" data-itab="${esc(t.key)}" aria-selected="${t === want}" title="${esc(t.label)}${t.hint ? ` · ${esc(t.hint)}` : ""}">${ic}<span>${esc(t.label)}</span>${n !== "" && n != null ? `<span class="n">${esc(String(n))}</span>` : ""}</button>`;
  }).join(""));
  if (!(col || (isPhone() && app.dataset.mview === "term"))) return inspLeave();
  const d = S.details.get(r.key)?.data ?? null;
  if (INSP.key !== want.key || INSP.sel !== r.key) {
    inspLeave();
    Object.assign(INSP, { key: want.key, sel: r.key, row: r, d, tab: want });
    const term = want.key === "term";
    $("tpane").hidden = !term; $("ipane").hidden = term;
    if (term) { pollTerm(true); requestAnimationFrame(fitTerm); return; }
    const el = document.createElement("div");
    el.className = "ipbody"; el.dataset.itab = want.key;
    $("ipane").replaceChildren(el);
    inspCall(want, "render", el, r);
  } else if ((INSP.row !== r || INSP.d !== d) && want.key !== "term") {
    INSP.row = r; INSP.d = d;
    const el = $("ipane").firstElementChild;
    if (el) inspCall(want, "patch", el, r);
  }
}
// Every change to the session pane passes through renderDetail; the inspector follows it.
renderDetail = ((f) => function (...a) { const out = f.apply(this, a); renderInspector(); syncDock(); return out; })(renderDetail);

/** Opens the inspector (on a tab), from a key, the header, a chip or a menu. On the phone: its screen. */
function openInspector(tab) {
  if (tab) S.insp.tab = tab;
  S.insp.open = true; store("insp", S.insp);
  headSig = "";
  if (isPhone()) { renderInspector(); if (app.dataset.mview !== "term") setMView("term"); else renderInspector(); return; }
  renderDetail();
  if (!app.classList.contains("insp-on")) toast("Open a session first: the inspector shows its terminal, subagents and servers");
}
/** ] and \: show or hide the inspector. On the phone: chat ⇄ the inspector's screen. */
function toggleInspector(open) {
  if (isPhone()) return app.dataset.mview === "list" ? undefined : setMView(app.dataset.mview === "term" ? "detail" : "term");
  open = open ?? !app.classList.contains("insp-on");
  if (open) return openInspector();
  S.insp.open = false; store("insp", S.insp);
  headSig = ""; renderDetail();
}
/** `: the next tab (opening the inspector if it's closed). */
function inspNextTab() {
  const r = !S.mode && !S.board ? rowOf(S.sel) : null;
  const tabs = inspTabs(r);
  if (!tabs.length) return toast("Open a session first");
  const shown = isPhone() ? app.dataset.mview === "term" : app.classList.contains("insp-on");
  const i = tabs.findIndex((t) => t.key === inspTab());
  openInspector(shown ? tabs[(i + 1) % tabs.length].key : tabs[Math.max(0, i)].key);
}
$("itabs").addEventListener("click", (e) => {
  const k = e.target.closest("[data-itab]")?.dataset.itab;
  if (!k || k === INSP.key) return;
  S.insp.tab = k; store("insp", S.insp);
  renderInspector();
});
$("inspClose").onclick = () => toggleInspector(false);

// ── resizing the column: drag the line, arrow keys on it, double-click resets ──
let iw = load("iw", 460);
const setIw = (v) => { iw = Math.round(Math.max(300, Math.min(innerWidth - lw - 420, v))); app.style.setProperty("--iw-open", iw + "px"); };
drag($("splitH"), () => "x", (e) => setIw(innerWidth - e.clientX), () => { store("iw", iw); fitTerm(); });
$("splitH").ondblclick = () => { setIw(460); store("iw", iw); fitTerm(); };
$("splitH").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault(); setIw(iw + (e.key === "ArrowLeft" ? 1 : -1) * (e.shiftKey ? 60 : 20)); store("iw", iw); fitTerm();
});

// ── the dock under the chat: status line, queue, attachments and the message box, in one frame ──
/** The frame hides when nothing in it shows (the board, a view, a past session). */
function syncDock() {
  const off = ["nowbar", "statusline", "qbar", "cAtt", "composer"].every((id) => $(id).hidden);
  if ($("dock").hidden !== off) $("dock").hidden = off;
}
// The jump-to-latest button floats just above the frame, whatever its height (a long draft grows it).
new ResizeObserver(([e]) => $("detail").style.setProperty("--dock-h", Math.round(e.target.offsetHeight) + "px")).observe($("dock"));

// ── the installed app's title bar: the deck draws into it (manifest: window-controls-overlay) ──
// The window's own buttons keep their corners: the list's top row starts after them, the right-most column's top
// row ends before them, and those rows drag the window.
const wco = navigator.windowControlsOverlay;
function wcoSync() {
  const root = document.documentElement, on = !!wco?.visible;
  root.classList.toggle("wco", on);
  if (!on) return;
  const b = wco.getTitlebarAreaRect();
  root.style.setProperty("--tb-l", Math.round(b.x) + "px");
  root.style.setProperty("--tb-r", Math.max(0, Math.round(innerWidth - b.x - b.width)) + "px");
  root.style.setProperty("--tb-h", Math.round(b.height) + "px");
}
wco?.addEventListener("geometrychange", wcoSync);
wcoSync();
