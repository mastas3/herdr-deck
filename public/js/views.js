"use strict";
// Views that take over the session pane: the core's (Inbox, History, Tools, Usage, Plugins) and the ones plugins register
// (deckPlugins, public/js/registry.js): switching between them.
function setMode(m) {
  const prev = deckPlugins.view(S.mode);
  if (prev && S.mode !== m) prev.leave?.();
  if (m === "inbox" && S.mode !== "inbox") { S.ifocus = null; S.ifocusIdx = 0; } // the first card has the focus ring on open
  S.mode = m;
  S.board = false;
  headSig = ""; bodySig = ""; chatDom.key = null;
  if (m === "history" && !S.histRes) loadHistory();
  if (m === "plugins") loadPlugins();
  const v = deckPlugins.view(m);
  if (v?.load) { try { v.load(); } catch (e) { console.error(e); } }
  if (m === "inbox" && S.jevOpen) loadJevStats(true);
  if (isPhone() && m) setMView("detail", true);
  render();
  renderDetail();
  renderViews();
  if (v?.path || prev?.path) syncUrl(); // a view with its own link (/p/<project>, ?view=…): the address bar follows
}
function renderViews() {
  const el = $("views");
  if (!el) return;
  const n = (S.decisions ?? []).filter((d) => !answered(d)).length;
  const core = [{ view: "inbox", label: "Inbox", icon: ICON.inbox, key: "i", count: n, order: 10 }, { view: "history", label: "History", icon: ICON.history, key: "h", order: 20 }, { view: "plugins", label: "Plugins", icon: ICON.puzzle, order: 90 }];
  const tabs = [...core, ...deckPlugins.contributions("view.tabs")].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  setHTML(el, tabs.map(({ view, label, icon, key, count }) => {
    const ic = typeof icon === "function" ? icon() : icon ?? "", c = typeof count === "function" ? count() : count;
    return `<button data-view="${esc(view)}" aria-pressed="${S.mode === view}" aria-label="${esc(label)}" title="${esc(label)}${key ? ` (${esc(key)})` : ""}">${ic}<span>${esc(label)}</span>${c ? `<b>${c}</b>` : ""}</button>`;
  }).join(""));
}
function renderMode() {
  $("dh").hidden = true; $("nowbar").hidden = true; $("askbox").hidden = true; $("composer").hidden = true; $("subcrumb").hidden = true; $("appbar").hidden = true;
  $("statusline").hidden = true; $("jumpBottom").hidden = true;
  chatDom.key = null;
  if (S.mode === "inbox") renderInbox();
  else if (S.mode === "history") renderHistory();
  else if (S.mode === "tools") renderTools();
  else if (S.mode === "usage") renderUsage();
  else if (S.mode === "plugins") renderPlugins();
  else deckPlugins.view(S.mode)?.render();
}
function modeHTML(html) {
  const box = $("dbody");
  if (box._mode !== S.mode || !box.querySelector(":scope > .view")) { box.innerHTML = `<button class="vclose" data-vclose title="Close (Esc)" aria-label="Close">${ICON.x}</button><div class="view" data-view="${S.mode}"></div>`; box._mode = S.mode; box._board = ""; box.scrollTop = 0; }
  setHTML(box.querySelector(".view"), html);
}
$("dbody").addEventListener("click", (e) => { if (e.target.closest("[data-vclose]")) { e.stopPropagation(); setMode(null); } }, true);

// Inbox ────────────────────────────────────────────────────────────────────
