"use strict";
// Session links (/s/…), selecting a session, and loading its detail.
// ── session links ────────────────────────────────────────────────────────
// /s/<machine>/<agent>/<session id> follows the conversation even if its pane moves; shells link to their pane.
function linkPath(r) {
  if (!r) return "/";
  return r.sessionId ? `/s/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.agent)}/${encodeURIComponent(r.sessionId)}` : `/s/${encodeURIComponent(r.machine)}/pane/${encodeURIComponent(r.key)}`;
}
const linkUrl = (r) => (S.publicUrl || location.origin) + linkPath(r);
function resolveLink(path) {
  const m = path.match(/^\/s\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [machine, agent, id] = m.slice(1).map(decodeURIComponent);
  if (agent === "pane") return S.rows.has(id) ? { key: id } : { missing: true };
  const r = [...S.rows.values()].find((x) => x.sessionId === id && (x.machine === machine || !machine)) ?? [...S.rows.values()].find((x) => x.sessionId === id);
  if (r) return { key: r.key };
  const g = S.graveyard.find((x) => x.resume && x.resume.includes(id));
  return { missing: true, grave: g };
}
function syncUrl() {
  const r = rowOf(S.sel);
  const own = deckPlugins.view(S.mode)?.path?.(); // a plugin view's link: /p/<project>, /?view=opportunities…
  const path = own ?? (S.board || !r ? "/" : linkPath(r));
  const current = location.pathname + (path.includes("?") || new URLSearchParams(location.search).has("view") ? location.search : "");
  if (current !== path) history.replaceState(history.state, "", path);
}

// ── selection & detail data ──────────────────────────────────────────────
let briefTimer = null;
function select(key, opts = {}) {
  if (!key || !rowOf(key)) return;
  const changed = S.sel !== key;
  S.tab = tabAfterSelect(S.sel, key, S.tab);
  S.sel = key;
  S.board = false;
  S.mode = null;
  store("sel", key);
  if (changed) {
    S.sub = null;
    termText = ""; termHash = ""; $("screen").innerHTML = ""; headSig = ""; bodySig = "";
    $("cText").value = S.drafts?.get(key) ?? ""; autosize($("cText"));
    chatDom.key = null;
    chatSel.clear(); lastPicked = null; $("msgbar")?.remove(); $("detail").classList.remove("selecting");
  }
  const row = rowOf(key);
  if (row && unseenDone(row)) { row.seen = true; api("/api/seen", { key }).catch(() => {}); }
  render();
  loadDetail(key);
  pollTerm(true);
  chatTick(true);
  prefetchNeighbours(key);
  if (opts.scroll) requestAnimationFrame(() => rowCache.get(key)?.el.scrollIntoView({ block: "nearest" }));
  if (opts.open && isPhone()) setMView("detail", true);
  // Opening a session puts you straight in its message box (desktop; on a phone it would pop the keyboard).
  // The pane renders a frame or two later, so try for up to half a second.
  if (opts.open && !isPhone()) {
    let tries = 0;
    const go = () => {
      const t = $("cText");
      if (S.sel !== key || S.mode || document.querySelector("dialog[open]") || !t || t.disabled) return;
      if (!t.offsetParent) { if (++tries < 12) setTimeout(go, 40); return; }
      if (document.activeElement === t) return;
      t.focus({ preventScroll: true });
      t.setSelectionRange?.(t.value.length, t.value.length);
    };
    requestAnimationFrame(go);
  }
  syncUrl();
}
S.drafts = new Map();
const inflight = new Map();
async function loadDetail(key) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await api("/api/detail", { key });
      S.details.set(key, { data, stamp: rowOf(key)?.lastActiveAt, at: Date.now() });
      if (data.chat) mergeChat(key, data.chat);
      if (S.sel === key) { headSig = ""; bodySig = ""; renderDetail(); maybeAutoBrief(key); }
    } catch {}
    inflight.delete(key);
  })();
  inflight.set(key, p);
  return p;
}
/** Hovering or moving next to a session warms its detail, so opening it is instant. */
function prefetch(key) {
  const c = S.details.get(key);
  const r = rowOf(key);
  if (!r || (c && c.stamp === r.lastActiveAt && Date.now() - c.at < 60_000)) return;
  loadDetail(key);
}
function prefetchNeighbours(key) {
  const v = S.visible ?? [];
  const i = v.findIndex((r) => r.key === key);
  setTimeout(() => { for (const r of [v[i + 1], v[i - 1]]) if (r) prefetch(r.key); }, 250);
}
function maybeAutoBrief(key) {
  clearTimeout(briefTimer);
  const d = S.details.get(key)?.data;
  if (!S.autoBrief || !d || d.brief || !d.turns?.length || (d.asks ?? 0) < 2 || briefBusy.has(key)) return;
  briefTimer = setTimeout(() => { if (S.sel === key) writeBrief(key, true); }, 1400);
}
