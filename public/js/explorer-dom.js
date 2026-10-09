"use strict";
// Keep the same folder, controls and focus while live session state changes around them.
const exDomKey = el => el.nodeType === 1 ? el.dataset.exNode || el.dataset.exFocus || (el.dataset.exAction ? "action:" + el.dataset.exAction : el.dataset.exGlobal ? "tool:" + el.dataset.exGlobal : el.classList[0] ? "part:" + el.classList[0] : "") : "";
const exSameElement = (a, b) => a?.nodeType === b.nodeType && a?.nodeName === b.nodeName;
function exPatchChildren(parent, next) {
  const old = [...parent.childNodes], keyed = new Map(old.filter(exDomKey).map(el => [exDomKey(el), el]));
  const kept = new Set(); let cursor = parent.firstChild;
  for (const [i, fresh] of [...next.childNodes].entries()) {
    const key = exDomKey(fresh), candidate = key ? keyed.get(key) : old[i];
    let el = candidate && !kept.has(candidate) && (key || !exDomKey(candidate)) && exSameElement(candidate, fresh) ? candidate : null;
    if (!el) el = fresh.cloneNode(true);
    else if (el.nodeType === 3) { if (el.data !== fresh.data) el.data = fresh.data; }
    else if (el.nodeType === 1) {
      for (const a of [...el.attributes]) if (!fresh.hasAttribute(a.name)) el.removeAttribute(a.name);
      for (const a of fresh.attributes) if (el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
      exPatchChildren(el, fresh);
    }
    if (el !== cursor) parent.insertBefore(el, cursor);
    kept.add(el); cursor = el.nextSibling;
  }
  for (const el of old) if (!kept.has(el)) el.remove();
}
function exRove(id) {
  const items = [...$("rows").querySelectorAll('.ex-tree [role="treeitem"]')];
  const target = items.find(el => el.dataset.exFocus === id) || items[0];
  for (const el of items) el.tabIndex = el === target ? 0 : -1;
  explorer.focus = target?.dataset.exFocus || "";
  return target;
}
function exPaint(box, html, first) {
  if (motion.reduced()) for (const animation of box.getAnimations({ subtree: true })) animation.cancel();
  const active = box.contains(document.activeElement) ? document.activeElement : null;
  const before = !first && !motion.reduced() ? motion.rects(box.querySelectorAll('[data-ex-focus]')) : new Map();
  const rects = new Map([...before].map(([el, r]) => [el.dataset.exFocus, r]));
  const next = document.createElement("div"); next.innerHTML = html;
  const incoming = new Set([...next.querySelectorAll('[data-ex-focus]')].map(el => el.dataset.exFocus));
  const exits = [...before.keys()].filter(el => !incoming.has(el.dataset.exFocus));
  const leave = exits.length ? motion.ghost(exits, box) : null;
  exPatchChildren(box, next); leave?.();
  const focus = exRove(explorer.focus);
  if (active && !active.isConnected) focus?.focus({ preventScroll: true });
  else if (active && document.activeElement !== active) active.focus({ preventScroll: true });
  if (first) return motion.enter(box.querySelector(".ex-tree"), "fade");
  let entering = 0, moving = 0;
  const bounds = box.getBoundingClientRect();
  for (const el of box.querySelectorAll('[data-ex-focus]')) {
    const was = rects.get(el.dataset.exFocus), now = el.getBoundingClientRect();
    if (!now.height || now.bottom < bounds.top || now.top > bounds.bottom) continue;
    if (was && Math.abs(was.top - now.top) > 1 && moving++ < 40) motion.run(el, [{ transform: `translateY(${was.top - now.top}px)` }, { transform: "none" }], { dur: 3 });
    else if (!was && entering++ < 10) motion.run(el, [{ opacity: 0, transform: "translateY(-5px)" }, { opacity: 1, transform: "none" }], { dur: 3, delay: Math.min(entering, 6) * 16 });
  }
}
