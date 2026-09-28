"use strict";
// Touch navigation on the phone: drag a screen to the right to go back, drag a sheet down to close it.
// Android's gesture navigation keeps a strip at each screen edge for its own back gesture: a page never sees touches
// that start there, and that gesture reaches the deck as the browser's back (popstate, nav.js), which Chrome may
// animate itself. So the in-app swipe doesn't wait for the edge: any mostly-horizontal drag to the right goes back,
// locked after 10px so vertical scrolls stay scrolls, and never one that starts in something that scrolls sideways
// (code blocks, the gallery's lanes, tables, the key bar), in a text field, or over selected text.
const SWIPE = { slop: 10, edge: 24, commit: 0.35, flick: 0.3 };
/** Finger speed (px/ms) over the last ~80ms of a drag (at least its last two samples), from [time, position] samples. */
function swipeSpeed(pts) {
  const n = pts.length, last = pts[n - 1];
  if (n < 2) return 0;
  const first = pts.find((p) => last[0] - p[0] <= 80) ?? last;
  const a = first === last ? pts[n - 2] : first;
  return last[0] > a[0] ? (last[1] - a[1]) / (last[0] - a[0]) : 0;
}
function swipeScrollsX(el, stop) {
  for (; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}
/** One-finger drags that start on `host`. begin(touchstart) returns { move(e), end(cancelled) } or null; move returns
 *  false to let the touch go. The rest of the touch reaches it even when a re-render removes the element under the
 *  finger: the browser keeps sending that element the touch, and a detached element no longer bubbles to `host`. */
function touchDrag(host, begin) {
  let h = null, el = null;
  const seen = new WeakSet();
  const move = (e) => { if (!h || seen.has(e)) return; seen.add(e); if (h.move(e) === false) stop(); };
  const up = (e) => { if (!h || seen.has(e)) return; seen.add(e); const x = h; stop(); x.end(e.type === "touchcancel"); };
  const wire = (x, on) => { for (const [t, f] of [["touchmove", move], ["touchend", up], ["touchcancel", up]]) on ? x.addEventListener(t, f, { passive: false }) : x.removeEventListener(t, f); };
  const stop = () => { if (el) wire(el, false); h = null; el = null; };
  host.addEventListener("touchstart", (e) => {
    stop();
    if (!isPhone() || e.touches.length !== 1) return;
    h = begin(e);
    if (h && e.target !== host) { el = e.target; wire(el, true); }
  }, { passive: true });
  wire(host, true); // blocking on the host, so a move can still be kept from scrolling once it's ours
}

// ── swipe back ──
function backDrag(e) {
  if (app.dataset.mview === "list" || document.querySelector("dialog[open]") || menuEl) return null;
  if (e.target.closest("input, textarea, select, [contenteditable], [data-noswipe], .stsheet") || !getSelection().isCollapsed) return null;
  const t0 = e.touches[0], el = e.target, pts = [];
  let m = null, xl = 0;
  return {
    move(e) {
      const t = e.touches[0], dx = t.clientX - t0.clientX, dy = t.clientY - t0.clientY;
      if (!m) {
        if (Math.hypot(dx, dy) < SWIPE.slop) return;
        // Right, clearly sideways, not selecting text (a long press that became a drag), nothing to scroll there.
        const ok = dx > 0 && dx > Math.abs(dy) * 1.3 && e.cancelable && getSelection().isCollapsed
          && (t0.clientX < SWIPE.edge || !swipeScrollsX(el, app));
        if (!ok || !(m = navDragStart())) return false;
        xl = t.clientX;
      }
      e.preventDefault();
      const x = t.clientX - xl;
      pts.push([e.timeStamp, x]);
      if (pts.length > 12) pts.shift();
      navDragTo(m, x);
    },
    end(cancel) {
      if (!m) return;
      const x = pts.length ? pts[pts.length - 1][1] : 0, v = swipeSpeed(pts);
      navDragEnd(m, !cancel && (x > innerWidth * SWIPE.commit ? v > -0.2 : v > SWIPE.flick && x > 16), v);
    },
  };
}
for (const host of [$("detail"), $("term"), $("mbar")]) touchDrag(host, backDrag);

// ── sheets: drag down to close ──
/** A bottom sheet (the panel `panelOf` finds under the finger) follows a drag down from its top, or from anywhere once
 *  its content is scrolled to the top; it closes past a third of its height or on a flick, else springs back. */
function sheetSwipe(host, panelOf, close) {
  if (host._sheet) return;
  host._sheet = true;
  touchDrag(host, (e) => {
    const panel = panelOf(e.target);
    if (!panel || e.target.closest("input, textarea, select, [contenteditable]")) return null;
    const r = panel.getBoundingClientRect();
    if (r.top < 40) return null; // full screen (the palette, New session): not a sheet
    let sc = e.target;
    while (sc && sc !== panel.parentElement && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (sc === panel.parentElement) sc = null;
    const t0 = e.touches[0], pts = [];
    let on = false, yl = 0;
    return {
      move(e) {
        const t = e.touches[0], dx = t.clientX - t0.clientX, dy = t.clientY - t0.clientY;
        if (!on) {
          if (Math.hypot(dx, dy) < SWIPE.slop) return;
          if (!(dy > 0 && dy > Math.abs(dx) * 1.2 && (!sc || sc.scrollTop <= 0) && e.cancelable)) return false;
          on = true; yl = t.clientY;
          panel.classList.add("sheet-drag");
        }
        e.preventDefault();
        const y = Math.max(0, t.clientY - yl);
        pts.push([e.timeStamp, y]);
        if (pts.length > 12) pts.shift();
        panel.style.transform = `translate3d(0,${y}px,0)`;
        panel.style.setProperty("--drag", Math.min(1, y / r.height).toFixed(3));
      },
      end(cancel) {
        if (!on) return;
        const y = pts.length ? pts[pts.length - 1][1] : 0, v = swipeSpeed(pts);
        const go = !cancel && (y > r.height * 0.3 ? v > -0.2 : v > 0.5 && y > 12);
        const to = go ? r.height + 24 : 0;
        const dur = navReduced() ? 0 : Math.round(Math.max(120, Math.min(280, Math.abs(to - y) / Math.max(Math.abs(v), 1.2))));
        const a = panel.animate([{ transform: `translate3d(0,${y}px,0)` }, { transform: `translate3d(0,${to}px,0)` }], { duration: dur, easing: NAV_EASE, fill: "forwards" });
        panel.style.transform = "";
        a.onfinish = () => {
          panel.style.removeProperty("--drag");
          if (go) close(panel);
          a.cancel();
          requestAnimationFrame(() => panel.classList.remove("sheet-drag")); // it closed without its exit slide: it had left
        };
      },
    };
  });
}
// Every dialog is a bottom sheet on the phone; the Studio's ingredient drawer is one inside Discover.
{
  const add = (d) => sheetSwipe(d, () => d, (x) => x.close());
  for (const d of document.querySelectorAll("dialog")) add(d);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeName === "DIALOG") add(n); }).observe(document.body, { childList: true });
  sheetSwipe($("detail"), (t) => t.closest(".stsp"), (p) => p.closest(".stsheet")?.querySelector(".stscrim")?.click());
}
