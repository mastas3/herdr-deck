"use strict";
$("rows").addEventListener("click", e => {
  if (S.group !== "folders" || S.view === "closed") return;
  const global = e.target.closest("[data-ex-global]")?.dataset.exGlobal;
  if (global) {
    e.stopPropagation();
    if (global === "go") { explorer.go = !explorer.go; explorer.goRequest++; explorer.goBusy = false; renderExplorer(); if (explorer.go) $("rows").querySelector(".ex-location input").focus(); }
    if (global === "collapse") { for (const n of explorer.nodes.values()) (S.q ? explorer.searchOpen : explorer.open)[n.id] = false; store("explorerOpen", explorer.open); renderExplorer(); }
    if (global === "options") openMenu(e.target.closest("button"), [
      { html: "Show hidden folders", on: explorer.hidden, run: () => { explorer.hidden = !explorer.hidden; explorer.listings.clear(); renderExplorer(); for (const n of explorer.nodes.values()) if (n.root && exExpanded(n)) exLoad(n); } },
      { html: "Browse folders when opening", on: explorer.all, run: () => { explorer.all = !explorer.all; if (explorer.all) for (const n of explorer.nodes.values()) if (n.root && exExpanded(n)) exLoad(n); } },
      { html: "Show all machines", run: () => setMachine("all") },
    ], "Explorer");
    return;
  }
  const branch = e.target.closest("[data-ex-node]"), n = branch && explorer.nodes.get(branch.dataset.exNode);
  if (!n || e.target.closest(".row[data-key], .ex-location")) return;
  const action = e.target.closest("[data-ex-action]")?.dataset.exAction;
  if (action === "terminal") exTerminal(n);
  else if (action === "menu") exMenu(n, e.target.closest("button"));
  else if (action === "browse" || action === "retry") exLoad(n);
  else if (e.target.closest(".ex-line")) exToggle(n);
}, true);
$("rows").addEventListener("contextmenu", e => {
  if (S.group !== "folders") return;
  const line = e.target.closest(".ex-line"), n = line && explorer.nodes.get(line.closest("[data-ex-node]").dataset.exNode);
  if (!n) return;
  e.preventDefault();
  exMenu(n, { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }), focus() {} });
});
$("rows").addEventListener("keydown", e => {
  if (S.group !== "folders" || e.target.closest("input, select") || e.altKey || e.ctrlKey || e.metaKey) return;
  const item = e.target.closest('[role="treeitem"]');
  if (!item || e.target.closest("button")) return;
  const items = [...$("rows").querySelectorAll('.ex-tree [role="treeitem"]')], i = items.indexOf(item);
  const n = explorer.nodes.get(item.dataset.exFocus);
  let next;
  if (e.key === "ArrowDown") next = items[Math.min(items.length - 1, i + 1)];
  else if (e.key === "ArrowUp") next = items[Math.max(0, i - 1)];
  else if (e.key === "Home") next = items[0];
  else if (e.key === "End") next = items.at(-1);
  else if (e.key === "ArrowRight" && n) { if (!exExpanded(n)) exToggle(n, true); else next = item.parentElement.querySelector(':scope > .ex-contents [role="treeitem"]'); }
  else if (e.key === "ArrowLeft") {
    if (n && exExpanded(n)) exToggle(n, false);
    else next = item.closest(".ex-contents")?.parentElement.querySelector(":scope > .ex-line");
  } else if (e.key === "Enter" || e.key === " ") {
    if (n) exToggle(n); else if (item.dataset.key) select(item.dataset.key, { open: true });
  } else return;
  e.preventDefault(); e.stopPropagation();
  if (next) { exRove(next.dataset.exFocus); next.focus({ preventScroll: true }); next.scrollIntoView({ block: "nearest" }); }
});
$("rows").addEventListener("submit", async e => {
  if (!e.target.matches(".ex-location")) return;
  e.preventDefault();
  const form = e.target, raw = form.querySelector("input").value.trim() || "~", machine = form.querySelector("select").value;
  const request = ++explorer.goRequest; explorer.goBusy = true;
  const button = form.querySelector("button"); button.disabled = true;
  try {
    const data = await api("/api/browse-folders", { machine, path: raw, hidden: explorer.hidden });
    if (request !== explorer.goRequest || !explorer.go) return;
    explorer.homes.set(machine, data.home);
    explorer.listings.set(exId(machine, data.path === data.home ? "~" : data.path), { data });
    const f = exForest(S.summary.machines || [], [...S.rows.values()], S.self, explorer.listings, explorer.homes);
    let n = f.nodes.get(exId(machine, data.path)) || f.roots.find(n => n.machine === machine);
    explorer.selected = n.id;
    while (n) { explorer.open[n.id] = true; n = f.nodes.get(n.parent); }
    store("explorerOpen", explorer.open); explorer.go = false; S.q = ""; $("q").value = ""; S.deep = null; S.machine = "all"; store("machine", "all");
    renderNow();
    const line = [...$("rows").querySelectorAll(".ex-line")].find(el => el.dataset.exFocus === explorer.selected);
    line?.focus({ preventScroll: true }); line?.scrollIntoView({ block: "nearest", behavior: motion.reduced() ? "instant" : "smooth" });
  } catch (err) { if (request === explorer.goRequest && explorer.go) toast(err.message, true, { label: "Retry", run: () => form.requestSubmit() }); }
  finally { if (request === explorer.goRequest) { explorer.goBusy = false; render(); } }
});

$("rows").addEventListener("focusin", e => {
  const item = e.target.closest('[data-ex-focus]');
  if (S.group !== "folders" || !item) return;
  exRove(item.dataset.exFocus);
  if (explorer.nodes.has(item.dataset.exFocus) && explorer.selected !== item.dataset.exFocus) {
    explorer.selected = item.dataset.exFocus; render();
  }
});
