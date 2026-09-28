"use strict";
// STAND-IN, DROP AT MERGE: a minimal host for the "inspector.tabs" extension point, so the Files and Changes tabs can be
// used and tested in this branch before the layout agent's inspector lands. When merging, remove this file (and its
// entry in plugin.json "client", and the .fstub rules at the end of files.css); the real inspector reads the same
// contributions: { key, label, icon, order, when?(row), render(el, row), patch?(el, row), leave?() }.
// It stays out of the way when the real one is there (the layout branch defines renderInspector()).
const filesStub = (() => {
  let el = null, cur = null, key = null, rowSig = "";
  const real = () => typeof renderInspector === "function";
  const tabsFor = (row) => deckPlugins.contributions("inspector.tabs").filter((t) => t && typeof t.render === "function" && (!t.when || t.when(row))).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  function build() {
    el = document.createElement("aside");
    el.className = "fstub";
    el.hidden = true;
    el.setAttribute("aria-label", "Inspector");
    el.innerHTML = `<div class="fstub-h"><div class="fstub-tabs" role="tablist"></div><span class="spacer"></span><button class="ib" data-fstub="close" title="Close" aria-label="Close the inspector"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div><div class="fstub-b"></div>`;
    document.body.append(el);
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-fstub=close]")) return close();
      const t = e.target.closest("[data-ftab]");
      if (t) open(t.dataset.ftab);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.target.closest("input, textarea")) { e.stopPropagation(); close(); } });
  }
  function open(tab) {
    const row = rowOf(S.sel);
    if (!row) return toast("Pick a session first", true);
    if (!el) build();
    const tabs = tabsFor(row);
    const t = tabs.find((x) => x.key === tab) ?? tabs[0];
    if (!t) return;
    if (cur && (cur.key !== t.key || key !== row.key)) cur.leave?.();
    const again = cur?.key === t.key && key === row.key && !el.hidden;
    cur = t; key = row.key; rowSig = filesSig(row);
    const badge = (x) => { try { return x.badge?.(row) || ""; } catch { return ""; } };
    el.querySelector(".fstub-tabs").innerHTML = tabs.map((x) => `<button role="tab" data-ftab="${esc(x.key)}" aria-selected="${x.key === t.key}">${typeof x.icon === "string" ? x.icon : ""}<span>${esc(x.label)}</span>${badge(x) ? `<span class="n">${esc(badge(x))}</span>` : ""}</button>`).join("");
    const body = el.querySelector(".fstub-b");
    if (!again) { body.replaceChildren(); body.dataset.tab = t.key; t.render(body, row); }
    motion.show(el, true, "slide"); // also takes back a close that is still animating out
    document.body.classList.add("fstub-on");
  }
  function close() {
    if (!el || el.hidden) return;
    cur?.leave?.();
    cur = null; key = null;
    document.body.classList.remove("fstub-on");
    motion.show(el, false, "slide");
  }
  /** The selected session changed or updated: re-render for a new one, patch for the same one. */
  function sync() {
    if (!el || el.hidden || !cur) return;
    const row = rowOf(S.sel);
    if (!row) return close();
    if (row.key !== key) return open(cur.key);
    const s = filesSig(row);
    if (s !== rowSig) { rowSig = s; cur.patch?.(el.querySelector(".fstub-b"), row); }
  }
  if (!real()) {
    const before = renderDetail;
    renderDetail = function (...a) { const out = before.apply(this, a); try { sync(); } catch (e) { console.error(e); } return out; };
  }
  return { open, close, isOpen: () => !!el && !el.hidden, tab: () => cur?.key, real };
})();
