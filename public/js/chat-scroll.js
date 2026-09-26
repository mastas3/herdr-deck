"use strict";
// Copying and selecting chat messages, and keeping your place while the chat updates.
// ── copy & select messages ───────────────────────────────────────────────
const chatSel = new Set();
function blockText(b, withHeader) {
  const r = rowOf(S.sel);
  const who = b.kind === "user" || b.kind === "pending" ? "You" : b.kind === "assistant" ? (r?.agent === "claude" ? "Claude" : r?.agent === "codex" ? "Codex" : r?.agent ?? "Agent") : b.kind === "tools" ? "Tools" : "Note";
  const body = b.kind === "tools" ? b.ms.map((t) => `${toolWords(t.tool).done} ${t.summary ?? ""}`.trim()).join("\n")
    : b.kind === "agent" ? `Subagent: ${b.ms[0].summary ?? ""}` : String(b.ms[0].text ?? "");
  return withHeader ? `**${who}**${b.ms[0].at ? ` (${when(b.ms[0].at)})` : ""}\n${body}` : body;
}
function copyBlocks(keys) {
  const blocks = (chatDom.data ?? []).filter((b) => keys.includes(b.key));
  if (!blocks.length) return;
  copy(blocks.length === 1 ? blockText(blocks[0], false) : blocks.map((b) => blockText(b, true)).join("\n\n"), blocks.length === 1 ? "message" : `${blocks.length} messages`);
}
let lastPicked = null;
function pickBlock(key, range) {
  const keys = (chatDom.data ?? []).map((b) => b.key);
  if (range && lastPicked && keys.includes(lastPicked)) {
    const [a, z] = [keys.indexOf(lastPicked), keys.indexOf(key)].sort((x, y) => x - y);
    for (const k of keys.slice(a, z + 1)) chatSel.add(k);
  } else chatSel.has(key) ? chatSel.delete(key) : chatSel.add(key);
  lastPicked = key;
  renderSelBar();
}
function renderSelBar() {
  for (const o of chatDom.blocks) o.el.classList.toggle("picked", chatSel.has(o.key));
  $("detail").classList.toggle("selecting", chatSel.size > 0);
  let bar = $("msgbar");
  if (!chatSel.size) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "msgbar"; bar.className = "msgbar"; $("composer").before(bar); }
  bar.innerHTML = `<b>${chatSel.size}</b> selected <span class="hint">· shift-click to select a range</span><span class="spacer"></span><button class="btn primary" data-selcopy>Copy</button><button class="btn ghost" data-selall>All</button><button class="btn ghost" data-selclear>Clear</button>`;
}
function clearPicks() { chatSel.clear(); lastPicked = null; renderSelBar(); }

// ── keeping your place ───────────────────────────────────────────────────
// At the bottom, the chat stays pinned there as messages arrive and images load. Scrolled up, the
// message you're reading stays exactly where it is, whatever changes above or below it.
const scrollPin = { stick: true, unread: 0, anchor: null, expect: null };
/** The deck's own scrolls are recorded, so the scroll handler can tell them from yours. */
function setScroll(top) { const b = $("dbody"); b.scrollTop = top; scrollPin.expect = b.scrollTop; }
function takeAnchor() {
  const body = $("dbody"), top = body.getBoundingClientRect().top;
  for (const o of chatDom.blocks ?? []) {
    const r = o.el.getBoundingClientRect();
    if (r.bottom > top + 8) return { key: o.key, off: r.top - top };
  }
  return null;
}
function restoreAnchor(a) {
  if (!a) return;
  const body = $("dbody");
  const el = chatDom.blocks?.find((o) => o.key === a.key)?.el;
  if (!el?.isConnected) return;
  const delta = el.getBoundingClientRect().top - body.getBoundingClientRect().top - a.off;
  if (Math.abs(delta) > 0.5) setScroll(body.scrollTop + delta);
}
function toBottom(smooth) {
  const body = $("dbody");
  scrollPin.stick = true; scrollPin.unread = 0;
  // While a smooth scroll is in flight its own scroll events mustn't unpin it (and redraws keep pinning).
  if (smooth) { scrollPin.expect = null; scrollPin.flying = Date.now() + 700; body.scrollTo({ top: body.scrollHeight, behavior: "smooth" }); } else setScroll(body.scrollHeight);
  renderJumpBtn();
}
function renderJumpBtn() {
  const btn = $("jumpBottom");
  if (!btn) return;
  const show = chatOn() && !scrollPin.stick && !!chatDom.el;
  btn.hidden = !show;
  if (show) btn.style.bottom = Math.max(14, $("detail").getBoundingClientRect().bottom - $("dbody").getBoundingClientRect().bottom + 14) + "px";
  btn.classList.toggle("has-new", scrollPin.unread > 0);
  btn.querySelector(".n").textContent = scrollPin.unread ? (scrollPin.unread > 9 ? "9+" : String(scrollPin.unread)) : "";
}
$("jumpBottom")?.addEventListener("click", () => toBottom(true));
$("dbody").addEventListener("scroll", () => {
  const body = $("dbody");
  const gap = body.scrollHeight - body.scrollTop - body.clientHeight;
  const mine = scrollPin.expect != null && Math.abs(body.scrollTop - scrollPin.expect) < 2;
  scrollPin.expect = null;
  if (scrollPin.flying && Date.now() < scrollPin.flying) { if (gap < 2) scrollPin.flying = 0; }
  else if (!mine) scrollPin.stick = gap < 40;
  scrollPin.anchor = scrollPin.stick ? null : takeAnchor();
  if (scrollPin.stick) scrollPin.unread = 0;
  if (chatOn() && body.scrollTop < 240) loadEarlier();
  renderJumpBtn();
}, { passive: true });
// Late layout (images, code blocks, fonts): stay pinned, or keep the anchor still.
new ResizeObserver(() => {
  if (!chatOn() || !chatDom.el) return;
  if (scrollPin.stick) setScroll($("dbody").scrollHeight);
  else if (scrollPin.anchor) restoreAnchor(scrollPin.anchor);
}).observe($("dbody"));
const chatSizeObs = new ResizeObserver(() => {
  if (!chatOn() || !chatDom.el) return;
  if (scrollPin.stick) setScroll($("dbody").scrollHeight);
  else if (scrollPin.anchor) restoreAnchor(scrollPin.anchor);
});
