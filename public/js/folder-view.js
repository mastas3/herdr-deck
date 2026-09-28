"use strict";
// The quick folder window: a project's folder at a glance, opened from its header in the Projects list. A floating
// panel on a desktop (drag it by its title, resize it from the corner), a bottom sheet on a phone. It only reads:
// /api/dir lists one folder (on the machine the project lives on), and a file opens in the deck's file viewer.
// The listing itself (kinds, icons, rows) is folder-items.js; this file is the window and its state.
const folderWin = {
  el: null, scrim: null, key: "", root: "", name: "", path: "", abs: "", entries: [], total: 0, truncated: false,
  q: "", hidden: load("fvHidden", true), sel: 0, seq: 0, loading: false, error: "", rect: load("fvRect", null),
};
const fvOpen = () => !!folderWin.el && !folderWin.el.hidden && !folderWin.el._closing;
/** What the list shows right now (after the filter and the hidden switch). */
const fvList = () => fvShown(folderWin.entries, folderWin.q, folderWin.hidden);
const FV_UP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/></svg>';
const FV_EYE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';

/** `d`: a folder button's data (data-proj, and for a worktree data-root / data-key / data-name). */
function openFolderView(d) {
  const h = d.root ? { cwd: d.root, key: d.key } : projectHome(d.proj);
  if (!h?.cwd || !h.key) return toast("This project’s folder isn’t known yet.", true);
  const el = fvBuild(), same = folderWin.root === h.cwd && fvOpen();
  Object.assign(folderWin, { key: h.key, root: h.cwd, name: d.name || d.proj || h.cwd.split("/").pop() });
  el.setAttribute("aria-label", `Folder: ${folderWin.name}`);
  if (!fvOpen()) {
    el._leave?.cancel(); el._leave = null; // reopened while it was leaving: it stays
    el._closing = false; el.hidden = false; el.style.pointerEvents = "";
    folderWin.scrim.hidden = false;
    fvPlace(folderWin.rect ?? fvDefaultRect());
    if (isPhone()) motion.run(el, [{ transform: "translateY(100%)" }, { transform: "none" }], { dur: 3 });
    else motion.enter(el, "popup");
  }
  if (!same) { Object.assign(folderWin, { path: "", abs: "", entries: [], total: 0, q: "", sel: 0, error: "" }); el.querySelector(".fv-q").value = ""; fvLoad(""); }
  (isPhone() ? el : el.querySelector(".fv-list")).focus({ preventScroll: true });
}
function closeFolderView() {
  const el = folderWin.el;
  if (!fvOpen()) return;
  el._closing = true; folderWin.scrim.hidden = true; el.style.pointerEvents = "none";
  // Leaves the way it came, quicker: the sheet slides down, the panel shrinks back a little.
  const a = motion.run(el, [{}, isPhone() ? { transform: "translateY(100%)" } : { opacity: 0, transform: "translateY(6px) scale(.98)" }], { dur: isPhone() ? 2 : 1, ease: "io", fill: "forwards" });
  const done = () => { el.hidden = true; el._closing = false; el.style.pointerEvents = ""; };
  if (!a) done(); else { el._leave = a; a.onfinish = () => { el._leave = null; done(); a.cancel(); }; }
}
/** Lists `path` (relative to the project's folder). Coming back up highlights the folder you came from. */
async function fvLoad(path, from) {
  const seq = ++folderWin.seq;
  folderWin.loading = true; fvPaint();
  try {
    const r = await api("/api/dir", { key: folderWin.key, root: folderWin.root, path });
    if (seq !== folderWin.seq) return;
    Object.assign(folderWin, { path: r.path, abs: r.abs, entries: r.entries, total: r.total, truncated: r.truncated, error: "", q: "" });
    folderWin.el.querySelector(".fv-q").value = "";
    folderWin.sel = Math.max(0, from ? fvList().findIndex((e) => e.name === from) : 0);
  } catch (e) {
    if (seq !== folderWin.seq) return;
    folderWin.error = e.message;
  }
  folderWin.loading = false;
  fvPaint();
  fvScrollSel();
}
const fvJoin = (a, b) => (a ? `${a}/${b}` : b);
function fvUp() {
  if (!folderWin.path) return;
  const parts = folderWin.path.split("/");
  const from = parts.pop();
  fvLoad(parts.join("/"), from);
}
/** Enter / double-click: a folder opens in place, a file in the deck's file viewer. */
function fvActivate(i = folderWin.sel) {
  const e = fvList()[i];
  if (!e) return;
  if (e.kind === "link" && e.out) return toast("That link leads outside the project, so it isn’t opened here.", true);
  if (e.kind === "dir" || (e.kind === "link" && e.to === "dir")) return fvLoad(fvJoin(folderWin.path, e.name));
  if (e.kind === "link" && !e.to) return toast("That link points to something that no longer exists.", true);
  openFile(`${folderWin.abs}/${e.name}`, folderWin.key);
}
function fvSelect(i) {
  const n = fvList().length;
  if (!n) return;
  folderWin.sel = Math.max(0, Math.min(n - 1, i));
  const list = folderWin.el.querySelector(".fv-list");
  for (const x of list.querySelectorAll('[aria-selected="true"]')) x.setAttribute("aria-selected", "false");
  list.querySelector(`#fv-e${folderWin.sel}`)?.setAttribute("aria-selected", "true");
  list.setAttribute("aria-activedescendant", `fv-e${folderWin.sel}`);
  fvScrollSel();
}
const fvScrollSel = () => folderWin.el?.querySelector(`#fv-e${folderWin.sel}`)?.scrollIntoView({ block: "nearest" });

// ── painting ──
function fvPaint() {
  const el = folderWin.el, w = folderWin;
  el.classList.toggle("loading", w.loading);
  el.querySelector(".fv-crumbs").innerHTML = fvCrumbs(w.name, w.path).map((c, i, all) => `${i ? '<span class="fv-sep" aria-hidden="true">/</span>' : ""}<button type="button" class="fv-c${i === all.length - 1 ? " cur" : ""}" data-p="${esc(c.path)}"${i ? "" : ` title="${esc(home(w.root))}"`}>${esc(c.label)}</button>`).join("");
  const crumbs = el.querySelector(".fv-crumbs");
  crumbs.scrollLeft = crumbs.scrollWidth; // the folder you're in stays in view
  el.querySelector(".fv-up").disabled = !w.path;
  const hb = el.querySelector(".fv-hid");
  hb.setAttribute("aria-pressed", String(w.hidden));
  fvPaintList();
}
function fvPaintList() {
  const el = folderWin.el, w = folderWin, list = el.querySelector(".fv-list"), shown = fvList(), now = Date.now();
  if (w.sel >= shown.length) w.sel = Math.max(0, shown.length - 1);
  if (w.error && !w.entries.length) list.innerHTML = `<div class="fv-msg err">${esc(w.error)}</div>`;
  else if (!shown.length) list.innerHTML = `<div class="fv-msg">${w.loading && !w.abs ? "Reading the folder…" : w.q ? "Nothing here matches that filter." : w.entries.length ? "Only hidden items here. Turn on “Show hidden” to see them." : "This folder is empty."}</div>`;
  else list.innerHTML = shown.map((e, i) => fvRowHTML(e, i, w.sel, w.q, now)).join("");
  list.setAttribute("aria-activedescendant", shown.length ? `fv-e${w.sel}` : "");
  const dirs = shown.filter((e) => fvKind(e) === "dir").length, hid = w.entries.filter((e) => e.hidden).length;
  const bits = [w.q ? `${shown.length} of ${w.entries.length} match` : `${dirs} folder${dirs === 1 ? "" : "s"}, ${shown.length - dirs} file${shown.length - dirs === 1 ? "" : "s"}`];
  if (hid && !w.hidden) bits.push(`${hid} hidden`);
  if (w.truncated) bits.push(`showing the first ${w.entries.length.toLocaleString()} of ${w.total.toLocaleString()}`);
  if (w.error && w.entries.length) bits.push(w.error);
  el.querySelector(".fv-foot").textContent = w.abs ? bits.join(" · ") : "";
}

// ── the window: built once, placed on screen, dragged and resized ──
function fvDefaultRect() {
  const width = Math.min(640, innerWidth - 32), height = Math.min(560, innerHeight - 120);
  return { width, height, left: Math.round((innerWidth - width) / 2 + Math.min(120, innerWidth / 10)), top: Math.round(Math.max(56, (innerHeight - height) / 2 - 24)) };
}
function fvPlace(r) {
  const el = folderWin.el;
  if (isPhone()) { el.style.cssText = ""; return; } // the sheet's place is CSS
  const c = fvClamp(r, innerWidth, innerHeight);
  folderWin.rect = c;
  Object.assign(el.style, { left: c.left + "px", top: c.top + "px", width: c.width + "px", height: c.height + "px" });
}
/** Drag the title bar to move it, the corner to resize it; either way it stays inside the window. */
function fvDrag(e, resize) {
  if (isPhone() || e.button !== 0 || (!resize && e.target.closest("button, input"))) return;
  e.preventDefault();
  const r0 = { ...folderWin.rect }, x0 = e.clientX, y0 = e.clientY, el = folderWin.el;
  el.classList.add(resize ? "sizing" : "moving");
  const move = (ev) => { const dx = ev.clientX - x0, dy = ev.clientY - y0; fvPlace(resize ? { ...r0, width: r0.width + dx, height: r0.height + dy } : { ...r0, left: r0.left + dx, top: r0.top + dy }); };
  const up = () => { el.classList.remove("moving", "sizing"); store("fvRect", folderWin.rect); removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); };
  addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
}
function fvBuild() {
  if (folderWin.el) return folderWin.el;
  const scrim = document.createElement("div");
  scrim.className = "fv-scrim"; scrim.hidden = true;
  const el = document.createElement("div");
  el.className = "fv"; el.hidden = true; el.tabIndex = -1; el.setAttribute("role", "dialog");
  el.innerHTML = `<div class="fv-bar"><span class="fv-ic">${ICON.folder}</span><nav class="fv-crumbs" aria-label="Path"></nav><span class="spin" aria-hidden="true"></span>
      <button type="button" class="ib fv-up" title="Up one folder (Backspace)" aria-label="Up one folder">${FV_UP}</button><button type="button" class="ib fv-x" title="Close (Esc)" aria-label="Close">${ICON.x}</button></div>
    <div class="fv-tools"><label class="fv-find"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><input class="fv-q" type="search" placeholder="Filter this folder" autocomplete="off" spellcheck="false" aria-label="Filter this folder"></label>
      <button type="button" class="fv-hid" aria-pressed="true" title="Show files and folders whose names start with a dot">${FV_EYE}Show hidden</button></div>
    <div class="fv-head" aria-hidden="true"><span></span><span>Name</span><span>Size</span><span>Changed</span></div>
    <div class="fv-list" role="listbox" tabindex="0" aria-label="Folder contents"></div>
    <div class="fv-foot" aria-live="polite"></div><span class="fv-grip" aria-hidden="true"></span>`;
  document.body.append(scrim, el);
  folderWin.el = el; folderWin.scrim = scrim;
  const list = el.querySelector(".fv-list"), q = el.querySelector(".fv-q");
  scrim.onclick = closeFolderView;
  el.querySelector(".fv-x").onclick = closeFolderView;
  el.querySelector(".fv-up").onclick = fvUp;
  el.querySelector(".fv-hid").onclick = () => { folderWin.hidden = !folderWin.hidden; store("fvHidden", folderWin.hidden); folderWin.sel = 0; fvPaint(); };
  el.querySelector(".fv-crumbs").onclick = (e) => { const c = e.target.closest("[data-p]"); if (c && !c.classList.contains("cur")) fvLoad(c.dataset.p); };
  el.querySelector(".fv-bar").addEventListener("pointerdown", (e) => fvDrag(e, false));
  el.querySelector(".fv-grip").addEventListener("pointerdown", (e) => fvDrag(e, true));
  q.oninput = () => { folderWin.q = q.value; folderWin.sel = 0; fvPaintList(); };
  // A tap opens on a touch screen; with a mouse, a click highlights and a double-click opens.
  list.addEventListener("click", (e) => { const r = e.target.closest("[data-i]"); if (!r) return; fvSelect(+r.dataset.i); if (matchMedia("(hover: none)").matches) fvActivate(+r.dataset.i); });
  list.addEventListener("dblclick", (e) => { const r = e.target.closest("[data-i]"); if (r) fvActivate(+r.dataset.i); });
  el.addEventListener("keydown", fvKeydown);
  addEventListener("resize", () => { if (fvOpen()) fvPlace(folderWin.rect ?? fvDefaultRect()); });
  // Esc closes the window from anywhere, unless something above it (a dialog, a menu) or a text box has it.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !fvOpen() || el.contains(e.target) || document.querySelector("dialog[open]") || menuEl || e.target.matches("input, textarea, select, [contenteditable]")) return;
    e.preventDefault(); e.stopPropagation(); closeFolderView();
  }, true);
  return el;
}
/** Keys inside the window are its own: the deck's shortcuts wait until focus leaves it. */
function fvKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const inQ = e.target.classList.contains("fv-q"), n = fvList().length;
  e.stopPropagation();
  if (e.key === "Escape") { e.preventDefault(); if (inQ && folderWin.q) { e.target.value = ""; e.target.dispatchEvent(new Event("input")); } else closeFolderView(); return; }
  if (e.key === "Enter") { e.preventDefault(); return fvActivate(); }
  const page = Math.max(1, Math.floor(folderWin.el.querySelector(".fv-list").clientHeight / 34) - 1);
  const to = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key];
  if (to != null) { e.preventDefault(); if (inQ && e.key === "ArrowDown") folderWin.el.querySelector(".fv-list").focus(); return fvSelect(folderWin.sel + to); }
  if (inQ) return;
  if (e.key === "Home" || e.key === "End") { e.preventDefault(); return fvSelect(e.key === "Home" ? 0 : n - 1); }
  if (e.key === "Backspace" || e.key === "ArrowLeft") { e.preventDefault(); return fvUp(); }
  if (e.key === "ArrowRight") { const x = fvList()[folderWin.sel]; if (x && fvKind(x) === "dir") { e.preventDefault(); fvActivate(); } return; }
  // Typing starts filtering.
  if (e.key.length === 1 && e.key !== " ") folderWin.el.querySelector(".fv-q").focus();
}
