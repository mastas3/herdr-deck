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
  const is = (x) => x.sessionId === id || x.movedFrom?.includes(id); // a link from before Claude Code moved the session
  const r = [...S.rows.values()].find((x) => is(x) && (x.machine === machine || !machine)) ?? [...S.rows.values()].find(is);
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
  if (S.group === "folders") exReveal(key);
  const changed = S.sel !== key;
  S.tab = tabAfterSelect(S.sel, key, S.tab);
  if (S.mode) deckPlugins.view(S.mode)?.leave?.();
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
  // A detail from the last minute that the session hasn't moved on from is still good: reopening doesn't fetch it again.
  let loaded = null;
  if (detailFresh(key)) maybeAutoBrief(key); else loaded = loadDetail(key);
  pollTerm(true);
  chatTick(true);
  prefetchNeighbours(key, loaded);
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
/** One request per open: the detail brings the newest chat too, unless the page already holds that chat (then
 *  /api/chat keeps it fresh). The turns stay on the server: the page only needs their count. */
async function loadDetail(key) {
  if (inflight.has(key)) return inflight.get(key);
  const c = chats.get(chatId(key));
  const withChat = !c || c.gen == null;
  const asked = rowOf(key)?.lastActiveAt;
  const p = (async () => {
    try {
      const data = await api("/api/detail", withChat ? { key, lite: true, limit: 150 } : { key, lite: true, chat: false });
      S.details.set(key, { data, stamp: rowOf(key)?.lastActiveAt, at: Date.now() });
      if (data.chat) { mergeChat(key, data.chat); chatOf(chatId(key)).stamp = asked; } // as fresh as a chatTick fetch
      if (S.sel === key) { headSig = ""; bodySig = ""; renderDetail(); maybeAutoBrief(key); }
    } catch {}
    inflight.delete(key);
    // It came back without the chat (no conversation yet, or it failed): the chat asks for itself, as it waited to.
    if (withChat && S.sel === key && chatOf(chatId(key)).gen == null) chatTick(true);
  })();
  p.withChat = withChat;
  inflight.set(key, p);
  return p;
}
/** A detail loaded in the last minute that the session hasn't moved on from. */
function detailFresh(key) {
  const c = S.details.get(key), r = rowOf(key);
  return !!r && !!c && c.stamp === r.lastActiveAt && Date.now() - c.at < 60_000;
}
/** Hovering or moving next to a session warms its detail, so opening it is instant. */
function prefetch(key) {
  if (rowOf(key) && !detailFresh(key)) loadDetail(key);
}
/** On a desktop, the sessions next to the one you opened, once its own detail is in. A phone's link is too thin to
 *  share with guesses. */
function prefetchNeighbours(key, loaded) {
  if (isPhone()) return;
  const v = S.visible ?? [];
  const i = v.findIndex((r) => r.key === key);
  Promise.resolve(loaded).then(() => setTimeout(() => { for (const r of [v[i + 1], v[i - 1]]) if (r) prefetch(r.key); }, 250));
}
function maybeAutoBrief(key) {
  clearTimeout(briefTimer);
  const d = S.details.get(key)?.data;
  if (!S.autoBrief || !d || d.brief || !(d.turnsCount ?? d.turns?.length) || (d.asks ?? 0) < 2 || briefBusy.has(key)) return;
  briefTimer = setTimeout(() => { if (S.sel === key) writeBrief(key, true); }, 1400);
}
