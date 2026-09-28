"use strict";
// Phone navigation: one stack of screens, mirrored in the browser history, so the Android back gesture, the back
// button, the swipe (swipe.js) and a view's ✕ all go exactly one level back, and the root is the list.
// A screen is the list, or what the session pane shows (a session and its subagent, a view, the live board) plus
// which half is up (chat or terminal). The calls that change screens (select, setMode, setBoard, openSub, setMView)
// are wrapped at the end of this file: once the current task is done, the new screen is compared with the history's
// top entry and pushed, replaced (chat ⇄ terminal, another tab), or taken as a step back to the screen below.
// Each entry is { nav: screen, d: depth, below: the screen under it }.

// ── pure (test/nav.test.ts evaluates this block on its own) ──
const NAV_LIST = { k: "list", mv: "list" };
/** What a change of screen does to the history: nothing, replace the top entry, push, step back, or rewind to the list. */
function navStep(cur, top, below, depth) {
  if (cur.k === top.k) return cur.mv === top.mv && cur.tab === top.tab && cur.sub === top.sub ? "none" : "replace";
  if (cur.k === "list") return depth > 0 ? "root" : "replace";
  if (below && depth > 0 && cur.k === below.k) return "back";
  return "push";
}
/** A screen's identity: the list, a view (and its own link: a project page), the board, or a session (and subagent). */
function navKey(s) {
  if (s.mv === "list") return "list";
  if (s.mode) return `m:${s.mode}:${s.path ?? ""}`;
  if (s.board) return "board";
  return `s:${s.sel}:${s.sub ?? ""}`;
}
// ── end pure

const NAV = { pending: null, restoring: 0, skip: 0, ghosts: new Map(), saved: new Map(), d: 0, stack: [NAV_LIST] };
function navNow() {
  const mv = isPhone() ? app.dataset.mview : "detail";
  if (mv === "list") return NAV_LIST;
  const s = { mv };
  if (S.mode) { s.mode = S.mode; s.path = deckPlugins.view(S.mode)?.path?.() ?? null; }
  else if (S.board || !rowOf(S.sel)) s.board = true;
  else { s.sel = S.sel; s.sub = S.sub ?? null; s.tab = S.tab; }
  s.k = navKey(s);
  return s;
}
// The stack as we've moved it. history.state lags behind a back that is still on its way (history moves are async),
// so two quick taps on Back must see the first one: each step updates this mirror at once.
// A reload (the deck updated, a plugin switched on) keeps the whole stack: this tab's copy is in sessionStorage.
function navKeep() { try { sessionStorage.setItem("deck:nav", JSON.stringify(NAV.stack.slice(0, NAV.d + 1))); } catch {} }
{
  const st = history.state;
  let kept = null;
  try { kept = JSON.parse(sessionStorage.getItem("deck:nav") ?? "null"); } catch {}
  if (st?.nav) {
    NAV.d = st.d;
    if (Array.isArray(kept) && kept[st.d]?.k === st.nav.k) NAV.stack = kept;
    NAV.stack[st.d] = st.nav;
    if (st.below) NAV.stack[st.d - 1] = st.below;
  }
}
const navTop = () => ({ nav: NAV.stack[NAV.d] ?? NAV_LIST, d: NAV.d, below: NAV.d > 0 ? NAV.stack[NAV.d - 1] ?? NAV_LIST : null });
function navReplace(nav, url) {
  NAV.stack[NAV.d] = nav;
  history.replaceState({ nav, d: NAV.d, below: navTop().below }, "", url);
  navKeep();
}
function navPush(nav, url) {
  NAV.stack.length = NAV.d + 1;
  NAV.stack.push(nav);
  NAV.d++;
  history.pushState({ nav, d: NAV.d, below: NAV.stack[NAV.d - 1] }, "", url);
  navKeep();
}
/** Steps back n entries; the popstate it causes finds the screen already there. */
function navPop(n) {
  if (n <= 0 || NAV.d <= 0) return;
  n = Math.min(n, NAV.d);
  NAV.d -= n;
  NAV.skip++;
  history.go(-n);
  navKeep();
}
/** Where you were on a screen: the list, the pane's scroll, and in a chat the message at the top and whether it was at the end. */
function navScroll() {
  const b = $("dbody"), chat = chatOn();
  // Measured, not the pin's last word: a scroll this frame hasn't told the pin yet.
  const stick = chat && b.scrollHeight - b.scrollTop - b.clientHeight < 40;
  return { list: $("rows").scrollTop, top: b.scrollTop, chat, stick, anchor: chat && !stick ? takeAnchor() : null };
}
function navUnscroll(sc) {
  if (!sc) return;
  if (sc.chat && chatOn()) {
    if (sc.stick || !sc.anchor) return;
    NAV.hold = { id: chatDom.key, anchor: sc.anchor, until: performance.now() + 1500 };
    navHold();
    return;
  }
  // A view that loads (History, Discover) may not be tall enough yet: keep trying for half a second.
  const b = $("dbody"), until = performance.now() + 500;
  const go = () => { b.scrollTop = sc.top; if (Math.abs(b.scrollTop - sc.top) > 2 && performance.now() < until) requestAnimationFrame(go); };
  go();
}

// Opening a chat lands at its end, and the detail that loads right after lands it there again: a chat you come back
// to holds the message you were reading instead, until you scroll it or a moment has passed.
function navHold() {
  const h = NAV.hold;
  if (!h || h.id !== chatDom.key || performance.now() > h.until) { NAV.hold = null; return; }
  scrollPin.stick = false; scrollPin.anchor = h.anchor; restoreAnchor(h.anchor); renderJumpBtn();
}
for (const ev of ["touchstart", "wheel"]) $("dbody").addEventListener(ev, () => { NAV.hold = null; }, { passive: true });

// ── recording changes ──
/** Before a screen change: what you're leaving (a ghost of it on the phone, for the slide and a later swipe back). */
function navWill(later) {
  if (NAV.restoring || NAV.pending) return;
  const from = navNow();
  NAV.pending = { from, url: location.pathname + location.search, sc: navScroll(), ghost: isPhone() && from.mv !== "list" ? navGhost() : null };
  // Called from a wrapped function: its caller finishes in this task. `later`: from a listener that runs before the
  // one that makes the change (microtasks run between an event's listeners).
  later ? setTimeout(navSync) : queueMicrotask(navSync);
}
function navSync() {
  const p = NAV.pending;
  NAV.pending = null;
  if (!p) return;
  const cur = navNow();
  if (cur.k !== p.from.k) NAV.saved.set(p.from.k, p.sc);
  if (!isPhone()) { if (cur.k !== p.from.k) navFade(p.from, cur); return; }
  const st = navTop();
  const step = navStep(cur, st.nav, st.below, st.d);
  if (step === "none") return;
  if (step === "replace") {
    navReplace(cur);
    if (cur.k === st.nav.k && cur.mv !== st.nav.mv) navSwapPane(cur.mv === "term");
    return;
  }
  if (step === "root" || step === "back") {
    navPop(step === "root" ? st.d : 1);
    navGhosts(step === "root" ? 0 : st.d - 1);
    navUnscroll(NAV.saved.get(cur.k));
    return cur.k === "list" ? navSlideOut(navLive(p.from.mv), [$("list")]) : navSlideOut(p.ghost ? [navGhostShow(p.ghost, true)] : [], navLive());
  }
  // push: the entry you leave keeps its own screen and address, the new one gets the new address
  const url = location.pathname + location.search;
  navReplace(p.from, st.d === 0 ? "/" : p.url);
  navPush(cur, url);
  if (p.ghost) NAV.ghosts.set(st.d, p.ghost);
  navGhosts(st.d + 1);
  navSlideIn(p.from.mv === "list" ? [$("list")] : p.ghost ? [navGhostShow(p.ghost)] : []);
}
/** Keeps the ghost of the screen right under depth d on the page (hidden, laid out, ready for a swipe); forgets the
 *  ones above it and all but a few below. */
function navGhosts(d) {
  for (const [k, g] of NAV.ghosts) {
    if (k >= d || k < d - 6) { g.remove(); NAV.ghosts.delete(k); }
    else if (k === d - 1) { if (!g.isConnected) navGhostShow(g); if (!g.classList.contains("over") && navMove?.under.includes(g) !== true) g.classList.add("rest"); }
    else g.remove();
  }
}

// ── going back ──
/** Shows a screen from the history as it was (no new entry): the view, session, subagent, tab and scroll. */
function navRestore(t) {
  NAV.restoring++;
  try {
    if (t.k === "list") {
      const v = deckPlugins.view(S.mode);
      if (S.mode) { v?.leave?.(); S.mode = null; headSig = ""; bodySig = ""; chatDom.key = null; renderViews(); }
      setMView("list");
      return;
    }
    if (t.mode) {
      if (t.path && deckPlugins.view(t.mode)?.path?.() !== t.path) deckPlugins.each("links", new URL(t.path, location.origin));
      if (S.mode !== t.mode) setMode(t.mode);
    } else if (t.board || !rowOf(t.sel)) setBoard(true);
    else {
      if (S.mode) deckPlugins.view(S.mode)?.leave?.();
      S.mode = null;
      select(t.sel);
      S.sub = t.sub ?? null; S.tab = t.tab ?? S.tab;
      headSig = ""; bodySig = ""; chatDom.key = null;
      renderViews();
    }
    setMView(t.mv === "term" ? "term" : "detail");
    renderDetail();
    if (!t.mode) chatTick(true);
    navUnscroll(NAV.saved.get(t.k));
  } finally { NAV.restoring--; }
}
/** One level back, from the back button, a view's ✕ or a finished swipe (`moved`: the swipe already slid it). */
function navBack(o = {}) {
  if (!isPhone()) return;
  navSettle();
  const st = navTop(), from = navNow();
  const t = st.d > 0 && st.below ? st.below : NAV_LIST;
  const ghost = !o.moved && from.mv !== "list" && t.k !== "list" ? navGhost() : null;
  NAV.saved.set(from.k, navScroll());
  navRestore(t);
  if (st.d > 0) navPop(1); else navReplace(NAV_LIST);
  navGhosts(Math.max(0, st.d - 1));
  if (o.moved) return;
  if (t.k === "list") navSlideOut(navLive(from.mv), [$("list")]);
  else navSlideOut(ghost ? [navGhostShow(ghost, true)] : [], navLive());
}
// The system back (Android's gesture or button, or the browser's): the entry below is already current.
addEventListener("popstate", (e) => {
  if (NAV.skip) { NAV.skip--; return; }
  if (!isPhone()) return;
  if (menuEl) closeMenu();
  navSettle();
  const t = e.state?.nav ?? NAV_LIST, from = navNow();
  const d = e.state?.d ?? 0;
  NAV.d = d; NAV.stack[d] = t;
  if (e.state?.below) NAV.stack[d - 1] = e.state.below;
  navKeep();
  if (t.k === from.k && t.mv === from.mv) return;
  const ghost = !e.hasUAVisualTransition && from.mv !== "list" && t.k !== "list" && t.k !== from.k ? navGhost() : null;
  NAV.saved.set(from.k, navScroll());
  navRestore(t);
  navGhosts(d);
  // Chrome's own back animation (predictive back) already showed this: don't play a second one.
  if (e.hasUAVisualTransition) return;
  if (t.k === "list") navSlideOut(navLive(from.mv), [$("list")]);
  else if (t.k === from.k) navSwapPane(t.mv === "term");
  else navSlideOut(ghost ? [navGhostShow(ghost, true)] : [], navLive());
});

// ── the phone's screens: list → session (chat ⇄ terminal) ──
function setMView(v) {
  if (app.dataset.mview === v) return;
  navWill();
  const from = app.dataset.mview;
  app.dataset.mview = v;
  for (const b of document.querySelectorAll(".mbar [data-mv]")) b.setAttribute("aria-selected", b.dataset.mv === v);
  if (v === "term") pollTerm(true);
  if (v === "detail") { chatTick(true); renderDetail(); }
  // Back on the list: exactly where you left it (opening a session scrolls the hidden list to its row).
  if (v === "list" && from !== "list") {
    S.board = false;
    const top = NAV.saved.get("list")?.list;
    requestAnimationFrame(() => (top != null ? ($("rows").scrollTop = top) : rowCache.get(S.sel)?.el.scrollIntoView({ block: "nearest" })));
  }
}
$("mBack").onclick = () => navBack();
// The live bar opens the board. (On the phone the board is "on" behind the list at startup, so a toggle would close it.)
$("live").onclick = () => setBoard(isPhone() && app.dataset.mview === "list" ? true : !S.board);
document.querySelector(".mbar .seg2").addEventListener("click", (e) => {
  const v = e.target.closest("[data-mv]")?.dataset.mv;
  if (v && v !== app.dataset.mview) setMView(v);
});
// On the phone a view's ✕ and a subagent's "Main conversation" are back steps (before views.js / events.js see them).
$("detail").addEventListener("click", (e) => {
  if (!isPhone()) return;
  const unsub = e.target.closest('[data-dact="unsub"]');
  if (unsub && navTop().below?.k !== `s:${S.sel}:`) return navWill(true); // reached some other way: a plain change
  if (!e.target.closest("[data-vclose]") && !unsub) return;
  e.stopPropagation();
  navBack();
}, true);

// ── wiring ──
select = ((f) => function (...a) { navWill(); return f.apply(this, a); })(select);
setMode = ((f) => function (...a) { navWill(); return f.apply(this, a); })(setMode);
setBoard = ((f) => function (...a) { navWill(); return f.apply(this, a); })(setBoard);
openSub = ((f) => function (...a) { navWill(); return f.apply(this, a); })(openSub);
renderChat = ((f) => function () { const r = f(); if (NAV.hold) navHold(); return r; })(renderChat);
// Android's back closes an open menu first (a close watcher), like it closes a dialog.
openMenu = ((f) => function (...a) {
  const r = f.apply(this, a);
  if (menuEl && isPhone()) { sheetSwipe(menuEl, () => menuEl, closeMenu); if (window.CloseWatcher) { try { const w = new CloseWatcher(); w.onclose = closeMenu; menuEl._cw = w; } catch {} } }
  return r;
})(openMenu);
closeMenu = ((f) => function () { const w = menuEl?._cw; if (menuEl) menuEl._cw = null; w?.destroy(); return f(); })(closeMenu);
// A reload (the deck updated, a plugin switched on) comes back to the screen you were on: the entry's own screen,
// not its address read as a fresh link (that would open it on top of itself).
if (isPhone() && history.state?.nav && history.state.nav.k !== "list") {
  const st = history.state;
  history.replaceState(st, "", "/");
  addEventListener("DOMContentLoaded", () => setTimeout(() => { if (app.dataset.mview === "list") navRestore(st.nav); }), { once: true });
}
