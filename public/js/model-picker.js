"use strict";
// The model picker: a Provider button and a Model button that each open a searchable list. Screens rebuild their markup
// with innerHTML, so a picker is a registry entry (modelPickerSet) plus a string (modelPickerHTML); one delegated
// listener on document opens the list. The list is a top-layer popover inside the closest <dialog>: a modal dialog
// makes everything outside it inert, and a scrolling dialog would clip it. Search, marks and badges: model-search.js.
const mpState = new Map(); // id -> the picker's config and state (see modelPickerSet)
let mpPop = null; // the open list: { id, kind, pid, el, uid, input, list, foot, rows, active }
let mpSeq = 0;
const MP_CHEV = '<svg class="mp-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MP_X = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/** Register or update a picker. `filter` (the provider being browsed) and `last` survive an update. */
function modelPickerSet(id, cfg) {
  const prev = mpState.get(id) ?? {};
  const st = { providers: [], value: "", label: "Model", onChange: null, allowCustom: false, allowDefault: false, defaultLabel: "Default", compact: false, recentKey: "", hint: "", filter: null, last: "", ...prev, ...cfg };
  mpState.set(id, st);
  return st;
}
const modelPickerValue = (id) => mpState.get(id)?.value ?? "";
function modelPickerDrop(id) { if (mpPop?.id === id) mpClose(false); mpState.delete(id); }
/** Choose `v` as if the user had: the buttons update, the open list closes, `onChange` runs. */
function modelPickerPick(id, v) {
  const st = mpState.get(id);
  if (!st) return;
  const at = modelFind(st.providers, v);
  if (at) st.last = at.p.id;
  if (v && st.recentKey) store("recent:" + st.recentKey, modelRecent(load("recent:" + st.recentKey, []), v));
  st.value = v; st.filter = null;
  if (mpPop?.id === id) mpClose(); else mpRefresh(id);
  st.onChange?.(v);
}
const mpRecents = (st) => (st.recentKey ? load("recent:" + st.recentKey, []) : []);
const modelPickerHTML = (id) => (mpState.has(id) ? `<div class="mp" data-mp-root="${esc(id)}">${mpInner(id, mpState.get(id))}</div>` : "");
/** Draw a picker into a screen's slot; if it is already there, redraw in place so keyboard focus stays on its button. */
function modelPickerMount(el, id) {
  if (el.firstElementChild?.dataset.mpRoot === id) mpRefresh(id); else el.innerHTML = modelPickerHTML(id);
}

/** The provider the buttons show and the model list is filtered to: the one being browsed, else the value's own, else the last used. */
function mpProvider(st) {
  if (st.filter === "*") return { id: "*", label: "All providers", models: st.providers.flatMap((p) => p.models) };
  const id = st.filter ?? modelFind(st.providers, st.value)?.p.id ?? st.last;
  return st.providers.find((p) => p.id === id) ?? st.providers[0];
}
function mpInner(id, st) {
  const cur = modelFind(st.providers, st.value), prov = mpProvider(st);
  let name = cur ? cur.m.l ?? cur.m.v : st.value || (st.allowDefault ? st.defaultLabel : "Choose…");
  if (st.compact && cur && !name.toLowerCase().startsWith(cur.p.label.toLowerCase())) name = `${cur.p.label} · ${name}`;
  const btn = (kind, cls, label, body) => `<button type="button" class="mp-btn ${cls}" data-mp="${esc(id)}" data-mp-open="${kind}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}">${body}${MP_CHEV}</button>`;
  const model = btn("model", "mp-model", st.label, `<span class="mp-v${st.value && !cur ? " mp-custom" : ""}">${esc(name)}</span>`);
  if (st.compact) return model;
  const provider = st.providers.length > 1 ? btn("provider", "mp-prov", `${st.label} provider`, `<span class="mp-k">Provider</span><span class="mp-v">${esc(prov.label)}</span><span class="mp-n">${prov.models.length}</span>`)
    : st.providers[0] ? `<span class="mp-fixed" title="Provider">${esc(st.providers[0].label)}</span>` : "";
  return `${provider}${model}${!st.providers.length && st.hint ? `<span class="hint mp-hint">${esc(st.hint)}</span>` : ""}`;
}
const mpRoots = (id) => [...document.querySelectorAll("[data-mp-root]")].filter((r) => r.dataset.mpRoot === id);
const mpTrigger = (id, kind) => mpRoots(id).map((r) => r.querySelector(`[data-mp-open="${kind}"]`)).find(Boolean);
/** Redraw a picker's buttons in place, keeping keyboard focus on the button it was on. */
function mpRefresh(id) {
  const st = mpState.get(id);
  if (!st) return;
  for (const root of mpRoots(id)) {
    const at = root.contains(document.activeElement) ? document.activeElement.dataset.mpOpen : "";
    root.innerHTML = mpInner(id, st);
    if (at) root.querySelector(`[data-mp-open="${at}"]`)?.focus();
  }
}

// ── the open list ──
const mpSelectable = (r) => (r.t === "model" || r.t === "provider" || r.t === "custom") && !r.off;
function mpOpen(id, kind, trigger) {
  const st = mpState.get(id);
  if (!st || !trigger) return;
  const again = mpPop && mpPop.id === id && mpPop.kind === kind;
  mpClose(false);
  if (again) return; // the button toggles its own list
  const uid = `mp${++mpSeq}`, provider = kind === "model" ? mpProvider(st) : null;
  const what = kind === "provider" ? "provider" : st.label.toLowerCase();
  const chips = kind === "model" && st.compact && st.providers.length > 1
    ? `<div class="mp-chips" role="group" aria-label="Provider">${[{ id: "*", label: "All" }, ...st.providers].map((p) => `<button type="button" class="mp-chip" data-mp-chip="${esc(p.id)}" aria-pressed="${p.id === provider?.id}">${esc(p.label)}</button>`).join("")}</div>` : "";
  const el = document.createElement("div");
  el.className = "mp-pop"; el.setAttribute("popover", "manual");
  el.innerHTML = `<div class="mp-head"><input class="mp-q" type="text" role="combobox" aria-expanded="true" aria-controls="${uid}l" aria-autocomplete="list" aria-label="Search ${esc(what)}" placeholder="Search ${esc(what)}…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"><button type="button" class="mp-x" aria-label="Close">${MP_X}</button></div>${chips}<div class="mp-list" id="${uid}l" role="listbox" aria-label="${esc(what)} list"></div><div class="mp-foot" hidden></div>`;
  el.addEventListener("input", (e) => { if (e.target === mpPop?.input) mpRender(true); });
  el.addEventListener("keydown", mpKey);
  el.addEventListener("mousedown", (e) => { if (!e.target.closest(".mp-q")) e.preventDefault(); }); // keep focus in the search box
  el.addEventListener("click", (e) => {
    const o = e.target.closest(".mp-opt"), c = e.target.closest("[data-mp-chip]");
    if (o) mpChoose(+o.dataset.i);
    else if (c) { mpPop.pid = c.dataset.mpChip; for (const x of el.querySelectorAll("[data-mp-chip]")) x.setAttribute("aria-pressed", x === c); mpRender(true); }
    else if (e.target.closest(".mp-x")) mpClose();
  });
  el.addEventListener("mousemove", (e) => { const o = e.target.closest(".mp-opt:not(.off)"); if (o && mpPop && +o.dataset.i !== mpPop.active) mpActive(+o.dataset.i); });
  const host = trigger.closest("dialog") ?? document.body;
  let scrim = null;
  if (isPhone()) { // a popover's ::backdrop is transparent to hit-testing, so a tap on it would land on the form beneath: the sheet gets a scrim of its own
    scrim = document.createElement("div");
    scrim.className = "mp-scrim"; scrim.setAttribute("popover", "manual");
    scrim.addEventListener("click", () => mpClose());
    host.append(scrim);
  }
  host.append(el);
  mpPop = { id, kind, pid: provider?.id, el, scrim, uid, input: el.querySelector(".mp-q"), list: el.querySelector(".mp-list"), foot: el.querySelector(".mp-foot"), rows: [], active: -1 };
  trigger.setAttribute("aria-expanded", "true");
  scrim?.showPopover(); // shown first, so the sheet stacks above it
  el.showPopover();
  mpPlace(); mpViewport(); mpRender(true);
  mpPop.input.focus({ preventScroll: true });
  window.visualViewport?.addEventListener("resize", mpViewport);
  window.visualViewport?.addEventListener("scroll", mpViewport);
}
function mpClose(focus = true) {
  const pop = mpPop;
  if (!pop) return;
  mpPop = null;
  window.visualViewport?.removeEventListener("resize", mpViewport);
  window.visualViewport?.removeEventListener("scroll", mpViewport);
  try { pop.el.hidePopover(); pop.scrim?.hidePopover(); } catch {}
  pop.el.remove(); pop.scrim?.remove();
  const st = mpState.get(pop.id);
  if (st && pop.kind === "model") st.filter = null; // browsing a provider ends with the list
  mpRefresh(pop.id);
  if (focus) mpTrigger(pop.id, pop.kind)?.focus();
}
/** Under the button on a desktop (above it when there's no room); a bottom sheet on a phone, which the CSS positions. */
function mpPlace() {
  const pop = mpPop, s = pop.el.style;
  if (isPhone()) { for (const k of ["left", "top", "bottom", "width", "max-height"]) s.removeProperty(k); return; }
  const r = mpTrigger(pop.id, pop.kind)?.getBoundingClientRect();
  if (!r) return;
  const w = Math.min(Math.max(r.width, 340), innerWidth - 16), below = innerHeight - r.bottom - 12, above = r.top - 12, up = below < 260 && above > below;
  s.width = `${w}px`; s.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  s.maxHeight = `${Math.min(440, up ? above : below)}px`;
  if (up) { s.bottom = `${innerHeight - r.top + 4}px`; s.top = "auto"; } else { s.top = `${r.bottom + 4}px`; s.bottom = "auto"; }
}
/** A phone's keyboard shrinks the visual viewport but not the layout one: keep the sheet above it. */
function mpViewport() {
  const v = window.visualViewport;
  if (!v || !mpPop) return;
  mpPop.el.style.setProperty("--mp-kb", `${Math.max(0, Math.round(innerHeight - v.height - v.offsetTop))}px`);
  mpPop.el.style.setProperty("--mp-vh", `${Math.round(v.height)}px`);
}

/** The rows for the open list: a provider list, or the models of one provider (or all) with Default, Recent and "Use 'x'". */
function mpRows(st, pop) {
  const q = pop.input.value.trim(), ql = q.toLowerCase(), rows = [];
  if (pop.kind === "provider") {
    if (st.providers.length > 1 && (!q || "all providers".includes(ql))) rows.push({ t: "provider", v: "*", label: "All providers", n: st.providers.reduce((n, p) => n + p.models.length, 0) });
    for (const p of st.providers) if (!q || p.label.toLowerCase().includes(ql) || p.id.includes(ql)) rows.push({ t: "provider", v: p.id, label: p.label, n: p.models.length, off: p.off || (p.models.length ? "" : "No models") });
    return { rows, shown: rows.length, total: rows.length };
  }
  const scoped = st.providers.filter((p) => pop.pid === "*" || p.id === pop.pid).flatMap((p) => p.models.map((m) => ({ ...m, _p: p })));
  if (st.allowDefault && (!q || "default".includes(ql) || st.defaultLabel.toLowerCase().includes(ql))) rows.push({ t: "model", v: "", m: { v: "", l: st.defaultLabel }, def: true });
  const seen = new Set();
  if (!q) {
    const recent = mpRecents(st).map((v) => scoped.find((m) => m.v === v)).filter(Boolean);
    if (recent.length) { rows.push({ t: "head", label: "Recent" }); for (const m of recent) { seen.add(m.v); rows.push({ t: "model", v: m.v, m, off: m._p.off }); } rows.push({ t: "head", label: "All models" }); }
  }
  const found = modelSearch(scoped.filter((m) => !seen.has(m.v)), q);
  for (const m of found.rows) rows.push({ t: "model", v: m.v, m, off: m._p.off }); // an unavailable provider's models are listed but can't be chosen
  if (st.allowCustom && q && !scoped.some((m) => m.v === q)) rows.push({ t: "custom", v: q });
  return { rows, shown: found.rows.length, total: found.total };
}
function mpRowHTML(st, pop, r, i) {
  if (r.t === "head") return `<div class="mp-h" role="presentation">${esc(r.label)}</div>`;
  const id = `id="${pop.uid}o${i}" data-i="${i}"`, cls = `mp-opt${i === pop.active ? " on" : ""}${r.off ? " off" : ""}`, dis = r.off ? ' aria-disabled="true"' : "";
  if (r.t === "provider") return `<div class="${cls}" role="option" ${id} aria-selected="${r.v === pop.pid}"${dis}><div class="mp-l1"><span class="mp-name">${esc(r.label)}</span><span class="mp-n">${r.off ? esc(r.off) : `${r.n} model${r.n === 1 ? "" : "s"}`}</span></div></div>`;
  if (r.t === "custom") return `<div class="${cls}" role="option" ${id} aria-selected="false"><div class="mp-l1"><span class="mp-name">Use “${esc(r.v)}”</span><span class="mp-n">custom ID</span></div></div>`;
  const m = r.m, q = pop.input.value.trim(), off = m._p?.off, name = m.l ?? m.v;
  const badges = r.def || off ? [] : modelBadges(m);
  return `<div class="${cls}" role="option" ${id} aria-selected="${r.v === st.value}"${off ? ' aria-disabled="true"' : ""}><div class="mp-l1"><span class="mp-name">${modelMarks(name, q)}</span>${pop.pid === "*" && m._p ? `<span class="mp-pv">${esc(m._p.label)}</span>` : ""}</div>${m.l && m.l !== m.v && !r.def ? `<div class="mp-id">${modelMarks(m.v, q)}</div>` : ""}${off ? `<div class="mp-badges"><span class="mp-b">${esc(off)}</span></div>` : badges.length ? `<div class="mp-badges">${badges.map((b) => `<span class="mp-b ${b.k}"${b.title ? ` title="${esc(b.title)}"` : ""}>${esc(b.t)}</span>`).join("")}</div>` : ""}</div>`;
}
function mpRender(reset) {
  const pop = mpPop, st = mpState.get(pop.id), { rows, shown, total } = mpRows(st, pop);
  pop.rows = rows;
  if (reset) {
    const i = pop.input.value.trim() ? -1 : rows.findIndex((r) => mpSelectable(r) && (pop.kind === "provider" ? r.v === pop.pid : r.t === "model" && r.v === st.value));
    pop.active = i >= 0 ? i : rows.findIndex(mpSelectable);
  }
  pop.list.innerHTML = rows.length ? rows.map((r, i) => mpRowHTML(st, pop, r, i)).join("") : `<div class="mp-empty">${esc(pop.kind === "model" && !st.providers.length ? st.hint || "No models" : "Nothing matches")}</div>`;
  pop.foot.hidden = shown >= total;
  pop.foot.textContent = shown < total ? `Showing ${shown} of ${total}. Keep typing to narrow it down.` : "";
  pop.input.setAttribute("aria-activedescendant", pop.active >= 0 ? `${pop.uid}o${pop.active}` : "");
  pop.list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function mpActive(i) {
  const pop = mpPop;
  pop.list.querySelector(".on")?.classList.remove("on");
  pop.active = i;
  const el = pop.list.querySelector(`[data-i="${i}"]`);
  el?.classList.add("on");
  el?.scrollIntoView({ block: "nearest" });
  pop.input.setAttribute("aria-activedescendant", el ? el.id : "");
}
function mpStep(d) {
  const sel = mpPop.rows.map((r, i) => (mpSelectable(r) ? i : -1)).filter((i) => i >= 0);
  if (sel.length) mpActive(sel[Math.max(0, Math.min(sel.length - 1, Math.max(0, sel.indexOf(mpPop.active)) + d))]);
}
function mpKey(e) {
  const pop = mpPop;
  if (!pop) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mpStep(e.key === "ArrowDown" ? 1 : -1); }
  else if (e.key === "PageDown" || e.key === "PageUp") { e.preventDefault(); mpStep(e.key === "PageDown" ? 8 : -8); }
  else if ((e.key === "Home" || e.key === "End") && (!pop.input.value || e.ctrlKey || e.metaKey)) { e.preventDefault(); mpStep(e.key === "Home" ? -1e9 : 1e9); } // otherwise they move the caret
  else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); mpChoose(pop.active); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); mpClose(); } // closes the list, not the dialog under it
}
function mpChoose(i) {
  const pop = mpPop, r = pop?.rows[i], st = pop && mpState.get(pop.id);
  if (!r || !mpSelectable(r)) return;
  if (r.t === "provider") { const id = pop.id; st.filter = r.v; mpClose(false); mpOpen(id, "model", mpTrigger(id, "model")); return; } // choosing a provider goes straight to its models
  modelPickerPick(pop.id, r.v);
}

document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-mp-open]"); if (b) { e.preventDefault(); mpOpen(b.dataset.mp, b.dataset.mpOpen, b); } });
document.addEventListener("keydown", (e) => { const b = e.target.closest?.("[data-mp-open]"); if (b && e.key === "ArrowDown") { e.preventDefault(); mpOpen(b.dataset.mp, b.dataset.mpOpen, b); } });
document.addEventListener("pointerdown", (e) => { if (mpPop && !mpPop.el.contains(e.target) && !e.target.closest?.("[data-mp-open], .mp-scrim")) mpClose(false); }, true); // the scrim closes on its own click, so the tap never reaches what's beneath
window.addEventListener("resize", () => { if (mpPop) mpPlace(); });
document.addEventListener("scroll", (e) => { if (mpPop && !mpPop.el.contains(e.target)) mpPlace(); }, true);
