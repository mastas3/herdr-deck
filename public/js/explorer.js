"use strict";
const explorer = { open: load("explorerOpen", {}), listings: new Map(), homes: new Map(), nodes: new Map(), selected: "", focus: "", all: true, hidden: false, go: false, goBusy: false, goRequest: 0, sig: "", search: "", searchOpen: {}, scope: "" };
const EX_FOLDER = '<svg class="ex-folder" viewBox="0 0 32 28" fill="none" aria-hidden="true"><path class="ex-folder-back" d="M2 7a3 3 0 0 1 3-3h7l3 3h12a3 3 0 0 1 3 3v13H2Z"/><path class="ex-folder-paper" d="M5 9h22v12H5z"/><path class="ex-folder-front" d="M2 12a2 2 0 0 1 2-2h24a2 2 0 0 1 2 2l-2 11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/></svg>';
const EX_MACHINE = '<svg viewBox="0 0 32 28" fill="none" aria-hidden="true"><rect x="4" y="3" width="24" height="17" rx="3" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-width="1.5"/><path d="M2 24h28M12 20v4m8-4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="m10 9 3 3-3 3m7 0h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EX_TERM = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="3"/><path d="m6 7 3 3-3 3m6 0h2"/></svg>';
const exTerminalProvider = () => deckPlugins.contributions("folder.terminal")[0];
function exExpanded(n) {
  if (S.q) return explorer.searchOpen[n.id] !== false;
  if (!Object.hasOwn(explorer.open, n.id)) explorer.open[n.id] = n.root || (!n.rows.length && n.all.length > 0) || n.attention > 0 || n.rows.some(r => r.key === S.sel);
  return !!explorer.open[n.id];
}
function exContext() {
  const node = explorer.nodes.get(explorer.selected);
  const scope = S.summary.machines?.find(m => m.id === S.machine)?.kind === "app" ? S.self : S.machine;
  return node && (scope === "all" || node.machine === scope) ? node : null;
}
const exListingKey = n => exId(n.machine, n.root ? "~" : n.path);
function exSessionHTML(r, depth) {
  const status = ["failed", "unknown"].includes(r.startup?.state) ? "Check launch" : r.status === "blocked" ? "Needs you" : r.status === "working" ? "Working" : r.status === "done" && !r.seen ? "Ready" : "";
  const sub = r.parent ? ` · Worker of ${rowOf(r.parent.key)?.title || r.parent.srcName || "another session"}` : "";
  return `<div class="row ex-session${S.sel === r.key && !S.board && !S.mode ? " sel" : ""}${S.picked.has(r.key) ? " picked" : ""}" role="treeitem" aria-level="${depth + 1}" aria-selected="${S.sel === r.key && !S.board && !S.mode}" tabindex="-1" data-key="${esc(r.key)}" data-status="${esc(r.status)}" data-ex-focus="s:${esc(r.key)}" style="--depth:${depth}" title="${esc((r.now || r.title || r.agent) + sub)}"><span class="ex-session-mark" style="--c:${statusVar(r.status)}">${r.agent === "shell" ? EX_TERM : '<span class="dot"></span>'}</span><span class="ex-session-copy"><b>${esc(r.title || "Untitled session")}</b><small>${esc(r.app ? "Codex app" : r.agent || "Session")}${sub ? esc(sub) : ""}</small></span>${status ? `<span class="ex-status" data-status="${esc(r.status)}">${status}</span>` : ""}</div>`;
}
function exNodeHTML(n, depth) {
  if (!n.matches) return "";
  const open = exExpanded(n), listing = explorer.listings.get(exListingKey(n));
  const ready = n.info?.online !== false;
  const status = n.attention ? `<span class="ex-count attention" title="${n.attention} sessions need your attention">${n.attention}<span class="sr"> need attention</span></span>` : n.working ? `<span class="ex-count working" title="${n.working} working"><i></i>${n.working}</span>` : n.all.length ? `<span class="ex-count">${n.all.length}</span>` : "";
  const selected = explorer.selected === n.id;
  const groupId = "ex-children-" + encodeURIComponent(n.id);
  const childHtml = open ? n.children.map(child => exNodeHTML(child, depth + 1)).join("") : "";
  return `<div class="ex-branch${n.root ? " ex-machine" : ""}${n.root && !ready ? " offline" : ""}${open ? " expanded" : ""}" data-ex-node="${esc(n.id)}"><div class="ex-line${selected ? " chosen" : ""}" role="treeitem" aria-label="${esc(n.name)}"${open ? ` aria-owns="${esc(groupId)}"` : ""} aria-level="${depth + 1}" aria-expanded="${open}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-ex-focus="${esc(n.id)}" style="--depth:${depth}" title="${esc(n.root ? n.info.error || n.name : n.path)}"><span class="ex-chevron">${ICON.chev}</span><span class="ex-icon${n.root ? " machine" : ""}">${n.root ? EX_MACHINE : EX_FOLDER}</span><span class="ex-name"><b>${esc(n.name)}</b>${n.root ? `<small><i class="ex-connection${ready ? " online" : ""}"></i>${n.info.local ? "This machine" : ready ? "Connected" : "Offline"}</small>` : ""}</span>${status}<span class="ex-actions">${exTerminalProvider() ? `<button class="ex-action" data-ex-action="terminal" aria-label="Terminal in ${esc(n.name)}" title="Terminal here">${EX_TERM}</button>` : ""}<button class="ex-action" data-ex-action="menu" aria-label="Actions for ${esc(n.name)}" title="Folder actions">•••</button></span></div>${open ? `<div id="${esc(groupId)}" role="group" class="ex-contents">${n.rows.map(r => exSessionHTML(r, depth + 1)).join("")}${childHtml}${listing?.loading ? '<div class="ex-note" role="status"><span class="spin"></span> Reading folders…</div>' : listing?.error ? `<div class="ex-note error">${esc(listing.error)} <button class="link" data-ex-action="retry">Retry</button></div>` : listing?.data?.truncated ? '<div class="ex-note">Showing 500 folders. Use Go to folder for a specific path.</div>' : !n.children.length && !n.rows.length ? `<div class="ex-note">${listing?.data ? "No folders here." : "No sessions here yet."}</div>` : ""}${!listing?.data && !listing?.loading && (n.root || !n.children.length && !n.rows.length) ? '<button class="ex-browse" data-ex-action="browse">Browse folders<span aria-hidden="true"> ↗</span></button>' : ""}</div>` : ""}</div>`;
}
function renderExplorer() {
  const box = $("rows");
  if (explorer.search !== S.q) { explorer.search = S.q; explorer.searchOpen = {}; }
  $("foldAll").hidden = true;
  const machines = S.summary.machines || [];
  const rows = visibleRows();
  const forest = exForest(machines, rows, S.self, explorer.listings, explorer.homes);
  const scope = JSON.stringify([S.machine, S.q]);
  if (box.dataset.view === "explorer" && explorer.scope === scope && orderFrozen()) exFreezeOrder(forest, explorer.nodes);
  explorer.scope = scope;
  exSearch(forest, S.q);
  explorer.nodes = forest.nodes;
  const tree = forest.roots.filter(n => S.machine === "all" || n.machine === S.machine || n.machine === S.self && machines.find(m => m.id === S.machine)?.kind === "app").map(n => exNodeHTML(n, 0)).join("");
  const chosen = exContext();
  const location = chosen ? (chosen.path === forest.roots.find(n => n.machine === chosen.machine)?.path ? "~" : chosen.path.replace(forest.roots.find(n => n.machine === chosen.machine)?.path + "/", "~/")) : "";
  const foot = chosen ? `<span class="ex-foot-machine">${esc(chosen.info.label)}</span><bdi title="${esc(chosen.path)}">${esc(location)}</bdi>` : "Open a folder to explore its sessions.";
  const html = `<header class="ex-toolbar"><span>Explorer</span><span class="spacer"></span><button class="ex-tool" data-ex-global="go" aria-label="Go to folder" title="Go to a folder path">↗</button><button class="ex-tool" data-ex-global="collapse" aria-label="Collapse all folders" title="Collapse all folders">${ICON.chev}</button><button class="ex-tool" data-ex-global="options" aria-label="Explorer options" title="Explorer options">•••</button></header><form class="ex-location"${explorer.go ? "" : " hidden"}><input aria-label="Folder path" placeholder="~/Projects or /any/folder" autocomplete="off" spellcheck="false"><select aria-label="Machine for folder">${forest.roots.map(n => `<option value="${esc(n.machine)}">${esc(n.name)}</option>`).join("")}</select><button class="btn" type="submit"${explorer.goBusy ? " disabled" : ""}>Go</button></form><div class="ex-tree" role="tree" aria-label="Machines, folders and sessions">${tree || `<div class="ex-empty">${S.q ? "No matching sessions or loaded folders." : "Your machines will appear here when connected."}</div>`}</div><footer class="ex-foot">${S.q ? "Matching sessions and loaded folders" : foot}</footer>`;
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
  explorer.selected = n.id; explorer.focus = n.id; (S.q ? explorer.searchOpen : explorer.open)[n.id] = value; store("explorerOpen", explorer.open);
  renderExplorer();
  if (value && explorer.all && !explorer.listings.get(exListingKey(n))?.data) exLoad(n);
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
    { html: exExpanded(n) ? "Close folder" : "Open folder", run: () => exToggle(n) },
    exTerminalProvider() && { html: `${EX_TERM} Terminal here`, run: () => exTerminal(n) },
    { html: "New session here…", run: () => openNew({ machine: n.machine, cwd: n.root ? explorer.homes.get(n.machine) || "~" : n.path, project: n.name }) },
    "-", { html: "Browse folders", run: () => { exToggle(n, true); exLoad(n); } },
    { html: "Refresh folder", run: () => exLoad(n) },
    { html: "Copy path", run: () => copy(n.root ? explorer.homes.get(n.machine) || "~" : n.path, "folder path") },
  ].filter(Boolean), n.name);
}

/** Palette/deep-link selection reveals its ancestors without closing another branch. */
function exReveal(key) {
  const forest = exForest(S.summary.machines || [], [...S.rows.values()], S.self, explorer.listings, explorer.homes);
  let n = [...forest.nodes.values()].find(n => n.rows.some(r => r.key === key));
  if (n) explorer.selected = n.id;
  while (n) { explorer.open[n.id] = true; n = forest.nodes.get(n.parent); }
  store("explorerOpen", explorer.open);
}
