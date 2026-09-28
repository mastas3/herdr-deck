"use strict";
// Only completed reply boundaries supplied by the transcript can become a native fork point.
const codexPointReceipts = new Map(), codexPointPending = new Set();
function codexForkPointButton(message, key) {
  const row = rowOf(key);
  if (S.sub || !codexHasCapability(row, "forkPoint") || message.role !== "assistant" || !message.forkAfterTurnId || !message.forkReplyHash) return "";
  return '<button class="ib" data-codex-fork-point title="Fork after this reply" aria-label="Fork after this reply"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="3" r="1.5"/><circle cx="12" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><path d="M4 4.5v7M12 4.5v1a4 4 0 0 1-4 4H4"/></svg></button>';
}
async function forkCodexReply(row, message) {
  if (!row?.app || !message?.forkAfterTurnId || !message?.forkReplyHash) return;
  const identity = JSON.stringify([row.key, message.forkAfterTurnId, message.forkReplyHash]);
  if (codexPointPending.has(identity)) return;
  const receipt = codexPointReceipts.get(identity) ?? crypto.randomUUID();
  codexPointReceipts.set(identity, receipt); codexPointPending.add(identity);
  toast("Forking after this reply…");
  try {
    const result = await api("/api/codex-fork-point", { key: row.key, lastTurnId: message.forkAfterTurnId, replyHash: message.forkReplyHash, requestId: receipt });
    codexPointReceipts.delete(identity);
    if (result.key) { pendingSelect = result.key; if (S.rows.has(result.key)) { pendingSelect = null; select(result.key, { scroll: true, open: true }); } }
    toast("Created a Codex task through this reply. The original is unchanged.", false, { label: "Open original", run: () => select(row.key, { scroll: true, open: true }) });
  } catch (e) {
    if (e.code && e.code !== "CODEX_DELIVERY_UNKNOWN") codexPointReceipts.delete(identity);
    const reload = () => { chats.delete(chatId(row.key)); chatDom.key = null; select(row.key, { open: true }); void chatTick(true); };
    toast(e.message, true, e.code === "CODEX_STALE" ? { label: "Refresh chat", run: reload } : { label: "Retry", run: () => forkCodexReply(row, message) });
  } finally { codexPointPending.delete(identity); }
}
