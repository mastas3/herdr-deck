"use strict";
// Views that take over the session pane (Inbox, History, Discover, Quests…): switching between them.
// ── views: inbox, history, tools, connections ────────────────────────────
function setMode(m) {
  const wasOpportunities = S.mode === "opportunities";
  if (wasOpportunities && m !== "opportunities") setHTML($("mTitle"), "Live board");
  if (m === "inbox" && S.mode !== "inbox") { S.ifocus = null; S.ifocusIdx = 0; } // the first card has the focus ring on open
  S.mode = m;
  S.board = false;
  headSig = ""; bodySig = ""; chatDom.key = null;
  if (m === "history" && !S.histRes) loadHistory();
  if (m === "connections") loadConnections();
  if (m === "discover") loadDiscover();
  if (m === "opportunities") opportunitiesLoad();
  if (m === "plugins") loadPlugins();
  if (m === "project") loadJourney(S.jp.name, { force: true }); // journey: cached on the server, so this is instant
  if (m === "projects") loadProjects();
  if (m === "quests") loadQuests({ force: true }); // quests: the game board
  if (m === "inbox" && S.jevOpen) loadJevStats(true);
  if (isPhone() && m) setMView("detail", true);
  render();
  renderDetail();
  renderViews();
  if (m === "opportunities" || wasOpportunities || m === "project" || m === "projects" || location.pathname.startsWith("/p")) syncUrl(); // journey: /p/<project>
}
function renderViews() {
  const el = $("views");
  if (!el) return;
  const n = (S.decisions ?? []).filter((d) => !S.done.has(d.key)).length;
  const v = [["inbox", "Inbox", ICON.inbox, n], ["history", "History", ICON.history], ["discover", "Discover", ICON.compass], ["opportunities", "Opportunities", ICON.bulb], ["quests", "Quests", QI.quest], ["plugins", "Plugins", ICON.puzzle]];
  setHTML(el, v.map(([id, label, icon, count]) => `<button data-view="${id}" aria-pressed="${S.mode === id}" title="${label}${id === "inbox" ? " (i)" : id === "history" ? " (h)" : id === "discover" ? " (d)" : id === "quests" ? " (q)" : ""}">${icon}<span>${label}</span>${count ? `<b>${count}</b>` : ""}</button>`).join(""));
}
function renderMode() {
  $("dh").hidden = true; $("nowbar").hidden = true; $("askbox").hidden = true; $("composer").hidden = true; $("subcrumb").hidden = true; $("appbar").hidden = true;
  $("statusline").hidden = true; $("jumpBottom").hidden = true;
  chatDom.key = null;
  if (S.mode === "inbox") renderInbox();
  else if (S.mode === "history") renderHistory();
  else if (S.mode === "tools") renderTools();
  else if (S.mode === "connections") renderConnections();
  else if (S.mode === "discover") renderDiscover();
  else if (S.mode === "opportunities") renderOpportunities();
  else if (S.mode === "plugins") renderPlugins();
  else if (S.mode === "project") renderJourney();
  else if (S.mode === "projects") renderProjects();
  else if (S.mode === "quests") renderQuests();
}
function modeHTML(html) {
  const box = $("dbody");
  if (box._mode !== S.mode || !box.querySelector(":scope > .view")) { box.innerHTML = `<button class="vclose" data-vclose title="Close (Esc)" aria-label="Close">${ICON.x}</button><div class="view" data-view="${S.mode}"></div>`; box._mode = S.mode; box._board = ""; box.scrollTop = 0; }
  setHTML(box.querySelector(".view"), html);
}
$("dbody").addEventListener("click", (e) => { if (e.target.closest("[data-vclose]")) { e.stopPropagation(); setMode(null); } }, true);

// Inbox ────────────────────────────────────────────────────────────────────
