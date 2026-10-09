"use strict";
const explorer = { view: load("explorerView", "projects") === "folders" ? "folders" : "projects", open: load(load("explorerView", "projects") === "folders" ? "explorerOpen" : "explorerProjectsOpen", {}), listings: new Map(), homes: new Map(), nodes: new Map(), selected: "", focus: "", all: true, hidden: false, go: false, goBusy: false, goRequest: 0, sig: "", search: "", searchOpen: {}, scope: "" };
const EX_FOLDER = '<svg class="ex-folder" viewBox="0 0 32 28" fill="none" aria-hidden="true"><path class="ex-folder-back" d="M2 7a3 3 0 0 1 3-3h7l3 3h12a3 3 0 0 1 3 3v13H2Z"/><path class="ex-folder-paper" d="M5 9h22v12H5z"/><path class="ex-folder-front" d="M2 12a2 2 0 0 1 2-2h24a2 2 0 0 1 2 2l-2 11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/></svg>';
const EX_MACHINE = '<svg viewBox="0 0 32 28" fill="none" aria-hidden="true"><rect x="4" y="3" width="24" height="17" rx="3" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-width="1.5"/><path d="M2 24h28M12 20v4m8-4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="m10 9 3 3-3 3m7 0h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EX_TERM = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="3"/><path d="m6 7 3 3-3 3m6 0h2"/></svg>';
const exTerminalProvider = () => deckPlugins.contributions("folder.terminal")[0];
function exExpanded(n) {
  if (S.q) return explorer.searchOpen[n.id] !== false;
  if (!Object.hasOwn(explorer.open, n.id)) explorer.open[n.id] = n.root || (n.projectNode ? n.all.some(r => r.key === S.sel) : (!n.rows.length && n.all.length > 0) || n.attention > 0 || n.rows.some(r => r.key === S.sel));
  return !!explorer.open[n.id];
}
function exContext() {
  const node = explorer.nodes.get(explorer.selected);
  const scope = S.summary.machines?.find(m => m.id === S.machine)?.kind === "app" ? S.self : S.machine;
  return node && (scope === "all" || node.machine === scope) ? node : null;
}
const exListingKey = n => exId(n.machine, n.root ? "~" : n.path);
function exNodeHTML(n, depth) {
  if (!n.matches) return "";
  const open = exExpanded(n), folders = explorer.view === "folders", listing = folders ? explorer.listings.get(exListingKey(n)) : null;
  const ready = n.info?.online !== false;
  const status = n.attention ? `<span class="ex-count attention" title="${n.attention} sessions need your attention">${n.attention}<span class="sr"> need attention</span></span>` : n.working ? `<span class="ex-count working" title="${n.working} working"><i></i>${n.working}</span>` : n.all.length ? `<span class="ex-count">${n.all.length}</span>` : "";
  const selected = explorer.selected === n.id;
  const groupId = "ex-children-" + encodeURIComponent(n.id);
  const childHtml = open ? n.children.map(child => exNodeHTML(child, depth + 1)).join("") : "";
  return `<div class="ex-branch${n.root ? " ex-machine" : n.projectNode ? " ex-project" : ""}${n.root && !ready ? " offline" : ""}${open ? " expanded" : ""}" data-ex-node="${esc(n.id)}"><div class="ex-line${selected ? " chosen" : ""}" role="treeitem" aria-label="${esc(n.name)}"${open ? ` aria-owns="${esc(groupId)}"` : ""} aria-level="${depth + 1}" aria-expanded="${open}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-ex-focus="${esc(n.id)}" style="--depth:${depth}" title="${esc(n.root ? n.info.error || n.name : n.path)}"><span class="ex-chevron">${ICON.chev}</span><span class="ex-icon${n.root ? " machine" : ""}">${n.root ? EX_MACHINE : EX_FOLDER}</span><span class="ex-name"><b>${esc(n.name)}</b>${n.root ? `<small><i class="ex-connection${ready ? " online" : ""}"></i>${n.info.local ? "This machine" : ready ? "Connected" : "Offline"}${!folders ? ` · ${n.children.length} project${n.children.length === 1 ? "" : "s"}` : ""}</small>` : n.projectNode ? `<small>${n.all.length} session${n.all.length === 1 ? "" : "s"}${n.working ? ` · ${n.working} working` : ""}</small>` : ""}</span>${status}<span class="ex-actions">${exTerminalProvider() ? `<button class="ex-action" data-ex-action="terminal" aria-label="Terminal in ${esc(n.name)}" title="Terminal here">${EX_TERM}</button>` : ""}<button class="ex-action" data-ex-action="menu" aria-label="Actions for ${esc(n.name)}" title="Folder actions">•••</button></span></div>${open ? `<div id="${esc(groupId)}" role="group" class="ex-contents">${n.rows.map(r => exSessionHTML(r, depth + 1)).join("")}${childHtml}${listing?.loading ? '<div class="ex-note" role="status"><span class="spin"></span> Reading folders…</div>' : listing?.error ? `<div class="ex-note error">${esc(listing.error)} <button class="link" data-ex-action="retry">Retry</button></div>` : listing?.data?.truncated ? '<div class="ex-note">Showing 500 folders. Use Go to folder for a specific path.</div>' : !n.children.length && !n.rows.length ? `<div class="ex-note">${listing?.data ? "No folders here." : "No project sessions here yet."}</div>` : ""}${folders && !listing?.data && !listing?.loading && (n.root || !n.children.length && !n.rows.length) ? '<button class="ex-browse" data-ex-action="browse">Browse folders<span aria-hidden="true"> ↗</span></button>' : ""}</div>` : ""}</div>`;
}
function renderExplorer() {
  const box = $("rows");
  if (explorer.search !== S.q) { explorer.search = S.q; explorer.searchOpen = {}; }
  $("foldAll").hidden = true;
  const machines = S.summary.machines || [];
  const rows = visibleRows();
  const forest = exBuildForest(rows);
  explorer.sessionTree = forest.sessionTree;
  const scope = JSON.stringify([explorer.view, S.machine, S.q]);
  if (box.dataset.view === "explorer" && explorer.scope === scope && orderFrozen()) exFreezeOrder(forest, explorer.nodes);
  explorer.scope = scope;
  exSearch(forest, S.q);
  explorer.nodes = forest.nodes;
  const tree = forest.roots.filter(n => S.machine === "all" || n.machine === S.machine || n.machine === S.self && machines.find(m => m.id === S.machine)?.kind === "app").map(n => exNodeHTML(n, 0)).join("");
  const chosen = exContext();
  const location = chosen ? (chosen.path === forest.roots.find(n => n.machine === chosen.machine)?.path ? "~" : chosen.path.replace(forest.roots.find(n => n.machine === chosen.machine)?.path + "/", "~/")) : "";
  const foot = chosen ? `<span class="ex-foot-machine">${esc(chosen.info.label)}</span><bdi title="${esc(chosen.path)}">${esc(location)}</bdi>` : "Projects with sessions. Everything else stays out of the way.";
  const html = `<header class="ex-toolbar"><div class="ex-view-switch" role="group" aria-label="Explorer view"><button data-ex-global="projects" aria-pressed="${explorer.view === "projects"}">Projects</button><button data-ex-global="folders" aria-pressed="${explorer.view === "folders"}">All folders</button></div><span class="spacer"></span><button class="ex-tool" data-ex-global="go" aria-label="Go to folder" title="Go to a folder path">↗</button><button class="ex-tool" data-ex-global="collapse" aria-label="Collapse all folders" title="Collapse all folders">${ICON.chev}</button><button class="ex-tool" data-ex-global="options" aria-label="Explorer options" title="Explorer options">•••</button></header><form class="ex-location"${explorer.go ? "" : " hidden"}><input aria-label="Folder path" placeholder="~/Projects or /any/folder" autocomplete="off" spellcheck="false"><select aria-label="Machine for folder">${forest.roots.map(n => `<option value="${esc(n.machine)}">${esc(n.name)}</option>`).join("")}</select><button class="btn" type="submit"${explorer.goBusy ? " disabled" : ""}>Go</button></form><div class="ex-tree" role="tree" aria-label="Machines, folders and sessions">${tree || `<div class="ex-empty">${S.q ? "No matching sessions or loaded folders." : "Your machines will appear here when connected."}</div>`}</div><footer class="ex-foot">${S.q ? "Matching sessions and loaded folders" : foot}</footer>`;
  if (box.dataset.view !== "explorer" || explorer.sig !== html) {
    const top = box.scrollTop, first = box.dataset.view !== "explorer";
    box.dataset.view = "explorer"; box._h = "";
    exPaint(box, html, first); explorer.sig = html; box.scrollTop = top;
    for (const k of rowCache.keys()) if (!S.rows.has(k) || !rowCache.get(k).el.isConnected) rowCache.delete(k);
    for (const el of box.querySelectorAll(".row[data-key]")) rowCache.set(el.dataset.key, { el, sig: "", stable: "", at: 0 });
  }
  // Keyboard next/previous follows the exact on-screen order, including sessions in parent folders.
  S.visible = [...box.querySelectorAll(".row[data-key]")].map(el => rowOf(el.dataset.key)).filter(Boolean);
  $("selbar").hidden = !S.picked.size;
  if (S.picked.size) $("selInfo").textContent = `${S.picked.size} selected`;
  if (app.classList.contains("list-off")) renderRail(rows);
}
async function exLoad(n, raw) {
  if (explorer.view !== "folders") { exSwitchView("folders", n); n = explorer.nodes.get(exId(n.machine, n.root ? "" : n.path)) || n; exToggle(n, true); }
  const key = exListingKey(n), old = explorer.listings.get(key);
  if (old?.loading) return;
  const state = { ...old, loading: true, error: "" }; explorer.listings.set(key, state); render();
  try {
    const data = await api("/api/browse-folders", { machine: n.machine, path: raw || (n.root ? "~" : n.path), hidden: explorer.hidden });
    if (explorer.listings.get(key) !== state) return;
    state.data = data; explorer.homes.set(n.machine, data.home);
  } catch (e) { state.error = e.message; }
  state.loading = false; render();
}
function exToggle(n, value = !exExpanded(n)) {
  explorer.selected = n.id; explorer.focus = n.id; (S.q ? explorer.searchOpen : explorer.open)[n.id] = value; exSaveOpen();
  renderExplorer();
  if (value && explorer.view === "folders" && explorer.all && !explorer.listings.get(exListingKey(n))?.data) exLoad(n);
}
function exTerminal(n) {
  const provider = exTerminalProvider();
  if (!provider) return toast("Enable Terminals in Plugins to open a shell.", true);
  explorer.selected = n.id; render();
  provider.open({ machine: n.machine, cwd: n.root ? explorer.homes.get(n.machine) || "~" : n.path });
}
function exMenu(n, anchor) {
  explorer.selected = n.id; render();
  openMenu(anchor, [
    { html: exExpanded(n) ? n.projectNode ? "Close project" : "Close folder" : n.projectNode ? "Open project" : "Open folder", run: () => exToggle(n) },
    exTerminalProvider() && { html: `${EX_TERM} Terminal here`, run: () => exTerminal(n) },
    { html: "New session here…", run: () => openNew({ machine: n.machine, cwd: n.root ? explorer.homes.get(n.machine) || "~" : n.path, project: n.name }) },
    "-", { html: "Browse folders", run: () => { exToggle(n, true); exLoad(n); } },
    { html: "Refresh folder", run: () => exLoad(n) },
    { html: "Copy path", run: () => copy(n.root ? explorer.homes.get(n.machine) || "~" : n.path, "folder path") },
  ].filter(Boolean), n.name);
}

/** Palette/deep-link selection reveals its ancestors without closing another branch. */
function exReveal(key) {
  const forest = exBuildForest([...S.rows.values()]);
  let n = [...forest.nodes.values()].find(n => !n.root && n.all.some(r => r.key === key) && (n.projectNode || n.rows.some(r => r.key === key)));
  let parent = rowOf(key)?.parent?.key; const seen = new Set();
  while (parent && !seen.has(parent)) { seen.add(parent); exTeamOpen[parent] = true; parent = rowOf(parent)?.parent?.key; }
  if (n) explorer.selected = n.id;
  while (n) { explorer.open[n.id] = true; n = forest.nodes.get(n.parent); }
  exSaveOpen();
}

function exBuildForest(rows) {
  return explorer.view === "projects" ? exProjectForest(S.summary.machines || [], rows, S.self, [...S.rows.values()]) : exForest(S.summary.machines || [], rows, S.self, explorer.listings, explorer.homes);
}
function exSaveOpen() { store(explorer.view === "projects" ? "explorerProjectsOpen" : "explorerOpen", explorer.open); }
function exSwitchView(view, selected = exContext()) {
  if (view === explorer.view) return;
  exSaveOpen(); explorer.view = view; store("explorerView", view);
  explorer.open = load(view === "projects" ? "explorerProjectsOpen" : "explorerOpen", {});
  explorer.go = false; explorer.goBusy = false; explorer.goRequest++; explorer.sig = "";
  const forest = exBuildForest(visibleRows());
  const next = selected && ([...forest.nodes.values()].find(n => n.machine === selected.machine && n.path === selected.path && !!n.root === !!selected.root) || forest.roots.find(n => n.machine === selected.machine));
  explorer.selected = next?.id || ""; explorer.focus = next?.id || "";
  renderExplorer();
  if (view === "folders" && explorer.all) for (const n of explorer.nodes.values()) if (n.root && exExpanded(n) && !explorer.listings.has(exListingKey(n))) exLoad(n);
}
