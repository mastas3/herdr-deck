"use strict";
// Motion: the JS half of the motion system (tokens and CSS rules are css/motion.css). Each helper makes its change at
// once and only decorates it: transform and opacity through the Web Animations API, exits faster than entrances, at
// most 8 things moving at a time. Nothing moves when motion is reduced: the system setting, or Settings → Reduce
// motion (localStorage "deck.motion" = "reduce", shared by every part of the page; it sets <html data-motion>).
const motion = (() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const KEY = "deck.motion";
  const pref = () => { try { return localStorage.getItem(KEY) ?? JSON.parse(localStorage.getItem("deck:motion") ?? "null") ?? ""; } catch { return ""; } };
  const sync = () => { if (pref() === "reduce") root.dataset.motion = "reduce"; else delete root.dataset.motion; };
  sync();
  addEventListener("storage", (e) => { if (e.key === KEY) sync(); });
  // Read each time, so a switch written straight to localStorage (another part of the page) applies at once.
  const reduced = () => { const r = pref() === "reduce"; if (r !== (root.dataset.motion === "reduce")) sync(); return media.matches || r; };
  function setReduced(on) { try { if (on) localStorage.setItem(KEY, "reduce"); else localStorage.removeItem(KEY); } catch {} sync(); }
  // Tokens, read once they're needed (the stylesheet is certainly applied by then).
  let T = null;
  const tok = () => {
    if (T) return T;
    const c = getComputedStyle(root), v = (n, d) => c.getPropertyValue(n).trim() || d;
    T = { d: [0, 90, 160, 240, 360].map((d, i) => (i ? parseFloat(v(`--dur-${i}`, "")) || d : 0)), out: v("--ease-out", "cubic-bezier(.2,.8,.2,1)"),
      io: v("--ease-in-out", "cubic-bezier(.65,0,.35,1)"), spring: v("--ease-spring", "cubic-bezier(.34,1.4,.64,1)") };
    return T;
  };
  /** ms for a token step (1–4), or a plain number of ms. */
  const ms = (d) => (d <= 4 ? tok().d[d] : d);
  function run(el, frames, o = {}) {
    if (!el?.animate || reduced()) return null;
    const t = tok();
    return el.animate(frames, { duration: ms(o.dur ?? 2), easing: o.ease ? t[o.ease] ?? o.ease : t.out, delay: o.delay ?? 0, fill: o.fill ?? "backwards" });
  }
  // Where each kind of thing comes from; leaving goes back there, faster.
  const FROM = {
    rise: { opacity: 0, transform: "translateY(6px)" }, drop: { opacity: 0, transform: "translateY(-4px)" }, pop: { opacity: 0, transform: "scale(.96)" },
    chip: { opacity: 0, transform: "scale(.88)" }, popup: { opacity: 0, transform: "translateY(6px) scale(.98)" }, fade: { opacity: 0 }, slide: { opacity: 0, transform: "translateX(24px)" },
  };
  /** Ease something new in. The i-th of a batch waits a little; from the 8th on, nothing moves at all. */
  function enter(el, kind = "rise", i = 0) {
    if (i >= 8) return null;
    return run(el, [FROM[kind] ?? FROM.rise, { opacity: 1, transform: "none" }], { dur: kind === "chip" ? 3 : 2, ease: kind === "chip" ? "spring" : "out", delay: i * 24 });
  }
  /** Take something away: it stops taking input now, fades back where it came from, then `done` runs (at once if reduced). */
  function leave(el, kind = "fade", done = () => el.remove()) {
    el.style.pointerEvents = "none";
    const a = run(el, [{}, FROM[kind] ?? FROM.fade], { dur: 1, ease: "io", fill: "forwards" });
    if (!a) return done();
    a.onfinish = () => { done(); a.cancel(); };
  }
  /** Show or hide a [hidden] element with an entrance and a quicker exit; showing again mid-exit takes it back. */
  function show(el, on, kind = "pop") {
    if (!el) return;
    if (on) {
      if (el._leaving) { el._leaving.cancel(); el._leaving = null; el.style.pointerEvents = ""; return; }
      if (el.hidden) { el.hidden = false; enter(el, kind); }
      return;
    }
    if (el.hidden || el._leaving) return;
    const a = run(el, [{}, FROM[kind] ?? FROM.fade], { dur: 1, ease: "io", fill: "forwards" });
    if (!a) { el.hidden = true; return; }
    el._leaving = a; el.style.pointerEvents = "none";
    a.onfinish = () => { el._leaving = null; el.hidden = true; el.style.pointerEvents = ""; a.cancel(); };
  }
  /** Where things are now (call before the DOM change), for flip(). */
  function rects(els) { const m = new Map(); if (!reduced()) for (const el of els) { const r = el.getBoundingClientRect(); if (r.height) m.set(el, r); } return m; }
  /** FLIP: whatever moved starts where it was and glides to its new place. `clamp` keeps a far move within that many px. */
  function flip(before, clamp = Infinity) {
    let n = 0;
    for (const [el, was] of before) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const dx = was.left - r.left, dy = Math.max(-clamp, Math.min(clamp, was.top - r.top));
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      run(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { dur: 3 });
      if (++n >= 40) break;
    }
  }
  /** A stand-in for elements about to be removed: measure now, call the returned function after the DOM change and
   *  each one fades out where it was, inside `host` (which must be position: relative). Off-screen ones are skipped. */
  function ghost(els, host) {
    if (reduced() || !host) return () => {};
    const hr = host.getBoundingClientRect(), out = [];
    for (const el of els) {
      if (out.length >= 8) break;
      const r = el.getBoundingClientRect();
      if (!r.height || r.bottom < hr.top || r.top > hr.bottom) continue;
      const g = el.cloneNode(true);
      for (const x of [g, ...g.querySelectorAll("[id], [data-key]")]) { x.removeAttribute("id"); x.removeAttribute("data-key"); }
      g.classList.remove("born", "sel", "flash");
      g.classList.add("ghost");
      g.setAttribute("aria-hidden", "true"); g.inert = true;
      Object.assign(g.style, { position: "absolute", margin: "0", pointerEvents: "none", left: `${r.left - hr.left + host.scrollLeft}px`, top: `${r.top - hr.top + host.scrollTop}px`, width: `${r.width}px`, height: `${r.height}px` });
      out.push(g);
    }
    return () => { for (const g of out) { host.append(g); leave(g, "pop"); } };
  }
  /** The selection highlight glides from where it was (a rect from before the change) to `to`, inside `host`. */
  let glider = null;
  function glide(from, to, host) {
    glider?.getAnimations().forEach((a) => a.cancel()); glider?.remove(); glider = null;
    if (reduced() || !from || !to?.isConnected) return;
    const hr = host.getBoundingClientRect(), r = to.getBoundingClientRect();
    if (!r.height || Math.abs(from.top - r.top) > hr.height) return;
    const g = document.createElement("div");
    g.className = "selglide";
    Object.assign(g.style, { left: `${r.left - hr.left + host.scrollLeft}px`, top: `${r.top - hr.top + host.scrollTop}px`, width: `${r.width}px`, height: `${r.height}px` });
    host.append(g); glider = g;
    to.classList.add("gliding");
    const a = run(g, [{ transform: `translateY(${from.top - r.top}px) scaleY(${from.height / r.height})` }, { transform: "none" }], { dur: 3 });
    const end = () => { to.classList.remove("gliding"); g.remove(); if (glider === g) glider = null; };
    if (a) a.onfinish = a.oncancel = end; else end();
  }
  /** A number that counts to its new value instead of jumping. */
  function count(el, from, to, fmt = (n) => String(Math.round(n))) {
    if (reduced() || from === to || !Number.isFinite(from)) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), D = ms(4);
    const step = (now) => { const k = Math.min(1, (now - t0) / D); el.textContent = fmt(from + (to - from) * (1 - (1 - k) ** 3)); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
    el.textContent = fmt(from);
    requestAnimationFrame(step);
  }
  /** Meter bars (.mb i, width set inline) rebuilt by innerHTML: each grows from its last value (or from 0 when `grow`), with its % label. */
  function bars(box, grow) {
    const prev = box._bars, next = new Map();
    let i = 0;
    for (const bar of box.querySelectorAll(".mb i")) {
      const m = bar.closest(".meter, .uwin, [data-bar]") ?? bar.parentElement;
      const key = `${i++}|${m.querySelector(".ml")?.textContent ?? ""}`;
      const w = parseFloat(bar.style.width) || 0;
      next.set(key, w);
      const was = prev?.has(key) ? prev.get(key) : grow ? 0 : w;
      if (was === w || !w) continue;
      run(bar, [{ transform: `scaleX(${was / w})` }, { transform: "none" }], { dur: 4, delay: grow ? Math.min(i, 8) * 30 : 0 });
      const b = m.querySelector("b");
      if (b && /^\d+%$/.test(b.textContent)) count(b, was, w, (n) => `${Math.round(n)}%`);
    }
    box._bars = next;
  }
  /** A little pop on something that just changed (a counter, a chip). */
  const bump = (el) => run(el, [{ transform: "scale(1)" }, { transform: "scale(1.18)", offset: 0.4 }, { transform: "scale(1)" }], { dur: 3, ease: "io" });
  /** Counters inside `box` that `write()` re-renders: each one whose number changed pops. */
  function counts(box, sel, keyOf, write) {
    const was = new Map([...box.querySelectorAll(sel)].map((el) => [keyOf(el), el.textContent]));
    write();
    if (was.size && !reduced()) for (const el of box.querySelectorAll(sel)) { const w = was.get(keyOf(el)); if (w != null && w !== el.textContent) bump(el); }
  }
  /** Keyed children of `box` re-rendered by `write()`: new ones ease in, gone ones fade where they were, the rest glide. */
  function keyed(box, attr, write, kind = "chip") {
    const old = new Map([...box.querySelectorAll(`[${attr}]`)].map((el) => [el.getAttribute(attr), el]));
    const moved = old.size ? rects(old.values()) : new Map();
    const olds = [...old];
    write();
    const now = new Map([...box.querySelectorAll(`[${attr}]`)].map((el) => [el.getAttribute(attr), el]));
    const gone = olds.filter(([k]) => !now.has(k)).map(([, el]) => el);
    if (gone.length) ghost(gone, box)();
    let i = 0;
    for (const [k, el] of now) {
      const was = old.get(k) && moved.get(old.get(k));
      if (!old.has(k)) { if (box._keyed) enter(el, kind, i++); }
      else if (was) flip(new Map([[el, was]]));
    }
    box._keyed = true;
  }
  /** A button confirms what it did: its icon swaps (to a tick) and pops, then comes back. */
  function confirm(btn, html, ms_ = 1200) {
    if (!btn || btn._conf) return;
    const was = btn.innerHTML;
    btn._conf = setTimeout(() => { btn.innerHTML = was; btn._conf = 0; btn.classList.remove("done"); }, ms_);
    btn.innerHTML = html; btn.classList.add("done");
    run(btn, [{ transform: "scale(.6)", opacity: 0.4 }, { transform: "none", opacity: 1 }], { dur: 3, ease: "spring" });
  }
  /** `el` arrives from `from` (a rect from before, e.g. the box you typed in): a copy travels there above any
   *  scrolling clip (position: fixed, kept in el's parent for its styles) while el itself waits, invisible. */
  function travel(el, from) {
    el.style.contentVisibility = "visible"; // a new chat message (content-visibility: auto) has no real size until painted
    const r = el.getBoundingClientRect();
    if (reduced() || !r.height || !from?.height) return;
    const g = el.cloneNode(true);
    for (const x of [g, ...g.querySelectorAll("[id]")]) x.removeAttribute("id");
    g.setAttribute("aria-hidden", "true"); g.inert = true;
    Object.assign(g.style, { position: "fixed", left: "0px", top: "0px", width: `${Math.ceil(r.width) + 1}px`, height: `${r.height}px`, margin: "0", maxWidth: "none", contentVisibility: "visible", zIndex: "40", pointerEvents: "none", animation: "none" });
    el.parentElement.append(g);
    const o = g.getBoundingClientRect(); // a transformed ancestor (the phone's sliding pane) moves fixed's origin
    g.style.left = `${r.left - o.left}px`; g.style.top = `${r.top - o.top}px`;
    const dy = Math.min(320, from.top + from.height / 2 - (r.top + r.height / 2));
    const a = run(g, [{ transform: `translateY(${dy}px) scale(.97)`, opacity: 0.4 }, { transform: "none", opacity: 1 }], { dur: 4 });
    run(el, [{ opacity: 0 }, { opacity: 0 }], { dur: 4 });
    if (a) a.onfinish = () => g.remove(); else g.remove();
  }
  /** Cross-fade the whole page through a change (theme, Simple mode). */
  function swap(fn) {
    if (reduced() || !document.startViewTransition) return fn();
    root.classList.add("vt-swap");
    document.startViewTransition(fn).finished.finally(() => root.classList.remove("vt-swap"));
  }
  /** Remove a closed <dialog> once its exit transition (css/motion.css) has played. */
  const drop = (d) => (reduced() ? d.remove() : setTimeout(() => d.remove(), ms(1) + 40));
  return { reduced, setReduced, run, enter, leave, show, rects, flip, ghost, glide, count, bars, bump, counts, keyed, confirm, travel, swap, drop, ms };
})();
/** The older switch plugins read (`reduceMotion.matches`), now also following Settings → Reduce motion. */
const reduceMotion = { get matches() { return motion.reduced(); } };
