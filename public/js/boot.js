"use strict";
// Live data (SSE) and startup: the last of the deck's own files, so everything it calls is defined by now. The
// Gallery and Library files load after it (public/assets.json) and hook into what they need.
// ── live data ────────────────────────────────────────────────────────────
function notifyTransitions(prev, next) {
  if (!S.notify || PUSH.on || !prev || prev.status === next.status) return;
  const done = next.status === "done" && prev.status === "working";
  const blocked = next.status === "blocked";
  if (!done && !blocked) return;
  try {
    const n = new Notification(blocked ? `${next.title || next.agent} needs input` : `${next.title || next.agent} finished`, { body: `${next.project}${multiMachine() ? " · " + machineLabel(next.machine) : ""}`, tag: next.key });
    n.onclick = () => { window.focus(); select(next.key, { scroll: true, open: true }); };
  } catch {}
}
function applyFull(data) {
  S.token = data.token;
  S.self = data.self;
  S.rows = new Map(data.rows.map((r) => [r.key, r]));
  S.summary = data.summary;
  S.graveyard = data.graveyard ?? [];
  S.tools = data.tools ?? [];
  S.queue = data.queue ?? {};
  S.toolGroups = data.toolGroups ?? {};
  S.usage = data.usage ?? {};
  S.hist = data.history ?? {};
  S.decisions = data.decisions ?? [];
  S.radar = data.radar ?? [];
  S.jev = data.jev ?? {};
  S.canShare = !!data.canShare;
  S.publicUrl = data.publicUrl ?? "";
  S.auto = data.auto ?? S.auto;
  S.push = data.push ?? S.push;
  S.game = data.game ?? S.game; renderQChip(); // quests: the header chip
  if (!S.linkDone && (location.pathname === "/p" || location.pathname.startsWith("/p/"))) { // journey: a project page link
    S.linkDone = true; S.board = true; lastOrder = ""; render();
    const n = decodeURIComponent(location.pathname.slice(3));
    return n ? openJourney(n) : openProjects();
  }
  if (!S.linkDone && location.pathname.startsWith("/s/")) {
    S.linkDone = true;
    const hit = resolveLink(location.pathname);
    if (hit?.key) { S.sel = null; S.machine = "all"; lastOrder = ""; render(); select(hit.key, { scroll: true, open: true }); return; }
    toast(hit?.grave ? `“${hit.grave.title}” was closed. Reopen it from Closed.` : "That session isn’t open anymore.", true);
    if (hit?.grave) S.view = "closed";
    history.replaceState(history.state, "", "/");
  }
  S.linkDone = true;
  if (S.machine !== "all" && !S.summary.machines?.some((m) => m.id === S.machine)) S.machine = "all";
  lastOrder = "";
  // No deep link: open on home, the live board (the phone opens on the list).
  if (!S.sel || !rowOf(S.sel)) { S.sel = null; S.board = true; }
  render();
}
let es = null, reconnectTimer = null;
function reconnectSoon(ms = 1500) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { es?.close(); connect(); }, ms);
}
function connect() {
  es = new EventSource("/events");
  es.addEventListener("full", (e) => { $("conn").classList.remove("off"); applyFull(JSON.parse(e.data)); });
  es.addEventListener("patch", (e) => {
    const p = JSON.parse(e.data);
    for (const r of p.upsert) { notifyTransitions(rowOf(r.key), r); S.rows.set(r.key, r); }
    for (const k of p.remove) { S.rows.delete(k); S.details.delete(k); }
    S.summary = p.summary;
    if (pendingSelect && rowOf(pendingSelect)) { const k = pendingSelect; pendingSelect = null; select(k, { scroll: true, open: true }); return; }
    if (S.sel && !rowOf(S.sel) && S.board) S.sel = null;
    if (S.sel && !rowOf(S.sel)) { S.sel = null; const next = S.visible?.find((r) => S.rows.has(r.key))?.key; if (next && !isPhone()) return select(next); }
    if (S.sel && p.upsert.some((r) => r.key === S.sel)) chatTick();
    render();
  });
  es.addEventListener("queue", (e) => { S.queue = JSON.parse(e.data); const r = rowOf(S.sel); if (r) renderQueue(r); render(); });
  es.addEventListener("graveyard", (e) => { S.graveyard = JSON.parse(e.data); render(); });
  es.addEventListener("history", (e) => { S.hist = JSON.parse(e.data); if (S.mode === "history") renderHistStatus(); });
  es.addEventListener("usage", (e) => { S.usage = JSON.parse(e.data); const r = rowOf(S.sel); if (r && !S.mode) renderStatusLine(r); });
  es.addEventListener("jev", (e) => { S.jev = JSON.parse(e.data); if (S.mode === "inbox") { if (S.jevOpen) loadJevStats(); else renderInbox(); } });
  es.addEventListener("radar", (e) => { S.radar = JSON.parse(e.data); render(); });
  es.addEventListener("decisions", (e) => { S.decisions = JSON.parse(e.data); renderViews(); if (S.mode === "inbox") { renderInbox(); if (S.jevOpen) loadJevStats(); } render(); });
  es.addEventListener("game", (e) => questsLive(JSON.parse(e.data)));
  es.addEventListener("auto", (e) => { S.auto = JSON.parse(e.data); if (S.board) { bodySig = ""; render(); } });
  es.addEventListener("audit", (e) => { S.audit = JSON.parse(e.data); if (S.mode === "connections") renderConnections(); });
  es.addEventListener("notice", (e) => { const n = JSON.parse(e.data); toast(n.message, !n.ok); if (n.key && n.key === S.sel) loadDetail(n.key); });
  es.onopen = () => $("conn").classList.remove("off");
  es.onerror = () => {
    $("conn").classList.add("off");
    if (es.readyState === EventSource.CLOSED) reconnectSoon(2000);
  };
}
setTpos(S.tpos);
setMain(S.main);
if (window.__BOOT__) applyFull(window.__BOOT__);
connect();
if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").then(() => pushSync()).catch(() => {});
{
  const params = new URLSearchParams(location.search);
  if (params.get("status") === "blocked") { S.q = "is:blocked"; $("q").value = S.q; render(); }
  if (params.get("new")) setTimeout(openNew, 50);
  if (params.get("digest")) { S.sel = null; setBoard(true); }
  if (params.get("quests")) setMode("quests");
  if (params.get("view") === "opportunities") setMode("opportunities");
  if ([...params.keys()].length) history.replaceState(history.state, "", S.mode === "opportunities" ? "/?view=opportunities" : "/");
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollTerm(); chatTick(true); } });
