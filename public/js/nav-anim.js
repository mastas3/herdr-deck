"use strict";
// Screen motion. The phone's stack slides (a new screen comes in from the right over the one it leaves, which drifts
// left and dims; going back reverses it, and the swipe drives the same pose with a finger), the slide between tabs,
// and the quick fade when the session pane changes on a desktop. Transform and opacity only; the action has already
// happened when a slide starts, and reduced motion means none.
const NAV_EASE = "cubic-bezier(.2, .8, .2, 1)";
const NAV_PAR = 0.28, NAV_DIM = 0.3;
const navReduced = () => motion.reduced();
// The screen's width, kept current: reading innerWidth mid-change forces a layout, pulling the next frame's work into
// the tap.
let navW = innerWidth;
addEventListener("resize", () => { navW = innerWidth; }, { passive: true });

// ── ghosts: a still copy of a screen, for what a slide reveals or leaves behind ──
// The session pane is one element, so the screen you left can't stay live under the new one. A copy (ids stripped,
// inert) stands in: under the new screen while it slides in and while you swipe back to it, or over the old one
// while it slides away.
const NAV_SCROLLS = ".dbody, .screen, .dh-meta";
function navGhost() {
  const src = app.dataset.mview === "term" ? $("insp") : $("detail");
  const g = document.createElement("div");
  g.className = "navghost";
  g.inert = true;
  g.setAttribute("aria-hidden", "true");
  for (const el of [src, $("mbar")]) {
    const c = el.cloneNode(true);
    c.removeAttribute("id");
    for (const x of c.querySelectorAll("[id]")) x.removeAttribute("id");
    g.append(c);
  }
  g._sc = [...src.querySelectorAll(NAV_SCROLLS)].map((el) => [el.scrollTop, el.scrollLeft]);
  if (src === $("detail") && chatOn()) { g._anchor = takeAnchor(); navPrune(g); }
  return g;
}
/** A long chat's copy keeps only the messages around the screen, with spacers for the rest: it lays out in a blink,
 *  and (messages off screen being sized lazily) its place is set by the message you were reading, not a pixel count. */
function navPrune(g) {
  const live = chatDom.el, copy = g.querySelector(".dbody > .chat");
  if (!live || !copy || live.children.length < 30 || copy.children.length !== live.children.length) return;
  const rs = [...live.children].map((k) => k.getBoundingClientRect()), h = innerHeight, n = rs.length;
  let i0 = rs.findIndex((r) => r.bottom > -h), i1 = rs.findLastIndex((r) => r.top < 2 * h);
  if (i0 < 0 || i1 < i0) return;
  const pad = (px) => Object.assign(document.createElement("div"), { style: `height:${Math.max(0, px)}px;flex:none` });
  const kids = [...copy.children];
  for (let i = n - 1; i > i1; i--) kids[i].remove();
  for (let i = 0; i < i0; i++) kids[i].remove();
  if (i0 > 0) copy.prepend(pad(rs[i0].top - rs[0].top));
  if (i1 < n - 1) copy.append(pad(rs[n - 1].bottom - rs[i1].bottom));
}
/** Puts a ghost on the page (its scroll positions come back with it): `over` the live screen, or under it. */
function navGhostShow(g, over) {
  g.classList.toggle("over", !!over);
  g.classList.remove("rest");
  if (!g.isConnected) app.append(g);
  [...g.querySelectorAll(NAV_SCROLLS)].forEach((el, i) => { const s = g._sc[i]; if (s) { el.scrollTop = s[0]; el.scrollLeft = s[1]; } });
  const a = g._anchor, body = g.querySelector(".dbody"), el = a && body?.querySelector(`:scope > .chat > [data-b="${CSS.escape(a.key)}"]`);
  if (el) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - a.off;
  return g;
}
function navShade(cls) {
  let s = document.querySelector(".navshade");
  if (!s) { s = document.createElement("div"); s.className = "navshade"; s.hidden = true; app.append(s); }
  s.className = "navshade " + cls;
  return s;
}

// ── the stack slide ──
/** The live screen on top: the pane showing (chat or terminal) and the top bar. */
const navLive = (mv = app.dataset.mview) => [mv === "term" ? $("insp") : $("detail"), $("mbar")];
let navMove = null;
/** Readies a slide: `top` covers `under` by p (1: all the way in, 0: gone off to the right). */
function navStage(top, under, shadeCls = "") {
  navSettle();
  const m = { top, under, shade: navShade(shadeCls), anims: [], p: 1, then: null };
  for (const el of [...top, ...under]) el.style.visibility = "visible";
  for (const el of under) el.style.pointerEvents = "none";
  m.shade.hidden = false;
  navMove = m;
  return m;
}
function navPose(m, p) {
  const w = navW;
  m.p = p;
  for (const el of m.top) el.style.transform = `translate3d(${(1 - p) * w}px,0,0)`;
  for (const el of m.under) el.style.transform = `translate3d(${-NAV_PAR * w * p}px,0,0)`;
  m.shade.style.opacity = NAV_DIM * p;
}
/** Animates the pose from p0 to p1, then settles (and runs `then` first, while everything is still in place). */
function navTween(m, p0, p1, dur, then) {
  const w = navW, o = { duration: dur, easing: NAV_EASE, fill: "forwards" };
  const x = (a, b) => [{ transform: `translate3d(${a}px,0,0)` }, { transform: `translate3d(${b}px,0,0)` }];
  m.then = then;
  m.anims = [
    ...m.top.map((el) => el.animate(x((1 - p0) * w, (1 - p1) * w), o)),
    ...m.under.map((el) => el.animate(x(-NAV_PAR * w * p0, -NAV_PAR * w * p1), o)),
    m.shade.animate([{ opacity: NAV_DIM * p0 }, { opacity: NAV_DIM * p1 }], o),
  ];
  m.anims[0].onfinish = () => { if (navMove === m) navSettle(); };
  setTimeout(() => { if (navMove === m) navSettle(); }, dur + 400); // a busy page never leaves a slide half done
}
/** Ends the running slide now, in its end state: a tap during a slide never waits for it or finds it half done. */
function navSettle() {
  const m = navMove;
  if (!m) return;
  navMove = null;
  try { m.then?.(); } finally {
    for (const a of m.anims) a.cancel();
    for (const el of [...m.top, ...m.under]) { el.style.transform = ""; el.style.visibility = ""; el.style.pointerEvents = ""; }
    m.shade.hidden = true;
    m.shade.style.opacity = "";
    for (const el of [...m.top, ...m.under]) if (el.classList.contains("navghost")) el.classList.contains("over") ? el.remove() : el.classList.add("rest");
  }
}
/** A new screen slides in over `under` (the list, or the ghost of the screen you left). */
function navSlideIn(under) {
  if (navReduced() || !isPhone()) return navSettle();
  const m = navStage(navLive(), under);
  navPose(m, 0);
  navTween(m, 0, 1, 340);
}
/** Going back: `out` (the live pane on its way to the list, or a ghost over the screen you're back on) slides away. */
function navSlideOut(out, under) {
  if (navReduced() || !isPhone()) { for (const el of out) if (el.classList.contains("navghost")) el.remove(); return navSettle(); }
  const over = out[0]?.classList.contains("navghost");
  const m = navStage(out, under, over ? "over" : "");
  navPose(m, 1);
  navTween(m, 1, 0, 280);
}
/** Chat ⇄ terminal on the phone: the terminal comes in over the chat, or leaves it. */
function navSwapPane(toTerm) {
  if (navReduced() || !isPhone()) return navSettle();
  const m = navStage([$("insp")], [$("detail")], "mid");
  navPose(m, toTerm ? 0 : 1);
  navTween(m, toTerm ? 0 : 1, toTerm ? 1 : 0, toTerm ? 300 : 240);
}

// ── the finger: the swipe back drives the same pose ──
/** Stages a swipe back from the current screen, over the screen below it; null when there's nowhere to go. */
function navDragStart() {
  navSettle();
  if (app.dataset.mview === "list") return null;
  const st = navTop();
  const below = st.d > 0 ? st.below ?? NAV_LIST : NAV_LIST;
  const g = below.k !== "list" ? NAV.ghosts.get(st.d - 1) : null;
  const under = below.k === "list" ? [$("list")] : g ? [navGhostShow(g)] : [];
  const m = navStage(navLive(), under);
  navPose(m, 1);
  return m;
}
const navDragTo = (m, x) => navPose(m, 1 - Math.max(0, x) / navW);
/** Lets go: all the way back (a quick spring whose speed follows the flick) or back into place. */
function navDragEnd(m, go, v) {
  if (navMove !== m) return;
  const p0 = m.p, p1 = go ? 0 : 1;
  const dist = Math.abs(p1 - p0) * navW;
  const dur = Math.round(Math.max(120, Math.min(300, dist / Math.max(Math.abs(v), 1.2))));
  navTween(m, p0, p1, dur, go ? () => navBack({ moved: true }) : null);
}

// ── tabs and the desktop's session pane ──
/** The new content slides in from the side it came from (dir 1: from the right), and fades up. */
function navEnter(els, dir, px = 24) {
  if (navReduced()) return;
  for (const el of els) el?.animate([{ transform: `translate3d(${dir * px}px,0,0)`, opacity: 0.25 }, { transform: "none", opacity: 1 }], { duration: 240, easing: NAV_EASE });
}
// Tabs: Chat / Subagents / About… on a session, and Discover's. The panel re-renders in the click; the slide starts on
// the next frame, from the side of the tab you picked.
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("#detail [data-tab][role=tab], #detail [data-dtab]");
  if (!b?.parentElement) return;
  const sel = b.dataset.tab != null ? "[data-tab]" : "[data-dtab]";
  const tabs = [...b.parentElement.querySelectorAll(sel)];
  const was = tabs.findIndex((x) => x.getAttribute("aria-selected") === "true" || x.getAttribute("aria-pressed") === "true");
  const now = tabs.indexOf(b);
  if (was < 0 || now < 0 || was === now) return;
  requestAnimationFrame(() => {
    const view = $("dbody").querySelector(":scope > .view");
    navEnter(sel === "[data-tab]" ? [$("dbody").firstElementChild] : view ? [...view.children].filter((x) => !x.matches(".vh")) : [], now > was ? 1 : -1);
  });
}, true);
/** Desktop: the session pane fades to what it shows now; views slide in from their side of the view bar. */
function navFade(from, to) {
  if (navReduced()) return;
  const order = (s) => (s.mode ? [...document.querySelectorAll("#views [data-view]")].findIndex((b) => b.dataset.view === s.mode) : -1);
  const a = order(from), b = order(to);
  const dir = a >= 0 && b >= 0 ? Math.sign(b - a) : 0;
  requestAnimationFrame(() => {
    const els = [$("dh"), $("dbody")].filter((el) => !el.hidden);
    if (dir) return navEnter(els, dir, 14);
    for (const el of els) el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: NAV_EASE });
  });
}
// A dialog that is removed as it closes would skip its exit slide (nav.css): the removal waits for it, the close
// itself (and whatever it resolves) doesn't.
document.addEventListener("close", (e) => {
  const d = e.target;
  if (d instanceof HTMLDialogElement && !navReduced() && !Object.hasOwn(d, "remove")) d.remove = () => setTimeout(() => Element.prototype.remove.call(d), 260);
}, true);
