"use strict";
// Live data (SSE) and startup: the last of the deck's core files, so everything it calls is defined by now. A few
// core files and the running plugins' files load after it; startup waits for them (DOMContentLoaded), so a plugin's
// views, tabs, links, state and SSE events are registered before the first render and the first full state.
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
  S.seq = data.seq || null;
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
  S.plugins = data.plugins ?? S.plugins;
  deckPlugins.each("state", data);
  // A plugin's own link (a project page at /p/<name>…): the plugin opens it.
  if (!S.linkDone && location.pathname !== "/" && !location.pathname.startsWith("/s/") && deckPlugins.each("links", new URL(location.href)).some(Boolean)) { S.linkDone = true; return; }
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
  // What the page already has (the inlined state, or the last event applied): the deck sends only what came after.
  es = new EventSource(S.seq ? "/events?since=" + encodeURIComponent(S.seq) : "/events");
  const on = (name, fn) => es.addEventListener(name, (e) => liveEvent(fn, e));
  es.addEventListener("full", (e) => { $("conn").classList.remove("off"); applyFull(JSON.parse(e.data)); if (e.lastEventId) S.seq = e.lastEventId; });
  es.addEventListener("stale", () => resync());
  on("patch", (p) => {
    for (const r of p.upsert) { notifyTransitions(rowOf(r.key), r); S.rows.set(r.key, r); }
    for (const k of p.remove) { S.rows.delete(k); S.details.delete(k); }
    S.summary = p.summary;
    if (pendingSelect && rowOf(pendingSelect)) { const k = pendingSelect; pendingSelect = null; select(k, { scroll: true, open: true }); return; }
    if (S.sel && !rowOf(S.sel) && S.board) S.sel = null;
    if (S.sel && !rowOf(S.sel)) { S.sel = null; const next = S.visible?.find((r) => S.rows.has(r.key))?.key; if (next && !isPhone()) return select(next); }
    if (S.sel && p.upsert.some((r) => r.key === S.sel)) chatTick();
    render();
  });
  // Memory, CPU and process counts, apart from the rows: only the footer shows them live.
  on("procs", (u) => { for (const k in u) { const r = S.rows.get(k); if (r) [r.rssKB, r.cpu, r.procs] = u[k]; } renderFooter(); });
  on("queue", (q) => { S.queue = q; const r = rowOf(S.sel); if (r) renderQueue(r); render(); });
  on("graveyard", (g) => { S.graveyard = g; render(); });
  on("history", (h) => { S.hist = h; if (S.mode === "history") renderHistStatus(); });
  on("usage", (u) => { S.usage = u; const r = rowOf(S.sel); if (r && !S.mode) renderStatusLine(r); if (S.mode === "usage") renderUsage(); });
  on("jev", (j) => { S.jev = j; if (S.mode === "inbox") { if (S.jevOpen) loadJevStats(); else renderInbox(); } });
  on("radar", (r) => { S.radar = r; render(); });
  on("decisions", (d) => { S.decisions = d; renderViews(); if (S.mode === "inbox") { renderInbox(); if (S.jevOpen) loadJevStats(); } render(); const cur = S.sel && rowOf(S.sel); if (cur) renderAsk(cur); });
  on("auto", (a) => { S.auto = a; if (S.board) { bodySig = ""; render(); } });
  for (const { event, fn } of deckPlugins.contributions("sse.events")) on(event, (d) => { try { fn(d); } catch (err) { console.error(err); } });
  // A plugin was turned on or off: its files join or leave the page, so load it again.
  on("plugins", (d) => { if (d.dev) return devReloaded(d.dev); if ((d.active ?? []).join() !== (S.plugins?.active ?? []).join()) location.reload(); });
  // Notices aren't numbered (a toast of the moment): they skip the bookkeeping.
  es.addEventListener("notice", (e) => { const n = JSON.parse(e.data); toast(n.message, !n.ok); if (n.key && n.key === S.sel) loadDetail(n.key); });
  es.onopen = () => $("conn").classList.remove("off");
  es.onerror = () => {
    $("conn").classList.add("off");
    if (es.readyState === EventSource.CLOSED) reconnectSoon(2000);
  };
}
// Back from the back-forward cache: the stream was cut while the page was frozen; catch up on what it missed.
window.addEventListener("pageshow", (e) => { if (e.persisted) reconnectSoon(0); });
setTpos(S.tpos);
setMain(S.main);
// The first state, the live stream and the page's own link wait for every script, running plugins' included (they
// load after this file): their state hooks, SSE events and deep links (/p/<project>, ?quests=1) are registered by then.
function startPage() {
  if (window.__BOOT__) applyFull(window.__BOOT__);
  connect();
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").then(() => pushSync()).catch(() => {});
  const params = new URLSearchParams(location.search);
  if (params.get("status") === "blocked") { S.q = "is:blocked"; $("q").value = S.q; render(); }
  if (params.get("new")) setTimeout(openNew, 50);
  if (params.get("digest")) { S.sel = null; setBoard(true); }
  if (params.get("view") && deckPlugins.view(params.get("view"))) setMode(params.get("view"));
  else if ([...params.keys()].length) deckPlugins.each("links", new URL(location.href));
  if ([...params.keys()].length) history.replaceState(history.state, "", deckPlugins.view(S.mode)?.path?.() ?? "/");
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startPage, { once: true });
else startPage();
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollTerm(); chatTick(true); } });
