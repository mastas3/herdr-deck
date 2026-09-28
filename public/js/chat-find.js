"use strict";
// Search in the open chat: the search button in the Chat tab, or ⌘F / Ctrl+F while the chat has focus, opens a small
// box over the chat. The server finds the words in the whole conversation (older history, folded tool calls); the ones
// on screen are highlighted in place (CSS highlights, so nothing moves), and stepping to one that isn't loaded fetches
// the messages around it first.
const FIND = { open: false, q: "", id: null, list: [], cur: -1, total: -1, seq: 0, timer: 0, busy: false, focus: false };
const FIND_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';

/* @pure:find-begin: no globals in here; test/chat-find.test.ts evaluates this block on its own. */
/** Lower case that keeps every character's length, so offsets in the lowered text are offsets in the original. */
const findFold = (s) => { const l = String(s).toLowerCase(); return l.length === String(s).length ? l : [...String(s)].map((c) => { const x = c.toLowerCase(); return x.length === c.length ? x : c; }).join(""); };
/** Where the phrase is in a text: [start, end) pairs, any case. Text with accents or niqqud can come composed or
 *  decomposed, so both forms of the phrase are looked for (offsets stay the text's own). */
function findSpans(text, phrase) {
  const t = findFold(text), out = [];
  for (const w of new Set([findFold(phrase.normalize("NFC")).trim(), findFold(phrase.normalize("NFD")).trim()])) {
    if (!w) continue;
    for (let at = t.indexOf(w); at >= 0 && out.length < 500; at = t.indexOf(w, at + w.length)) out.push([at, at + w.length]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
/** The server's [message index, count] pairs as one list of matches, oldest first. */
const findList = (hits) => hits.flatMap(([i, n]) => Array.from({ length: n }, (_, k) => ({ i, k })));
/** Where to start: the last match in or above the newest message in view, else the first after it. */
function findStart(list, newest) {
  let at = -1;
  for (let j = 0; j < list.length; j++) if (list[j].i <= newest) at = j;
  return at >= 0 ? at : list.length ? 0 : -1;
}
/* @pure:find-end */

const findEl = () => $("cfind");
/** The chat has focus: the last click or focus was in the session pane, and the chat is what it shows. */
addEventListener("pointerdown", (e) => { FIND.focus = !!e.target.closest?.("#detail"); }, true);
addEventListener("focusin", (e) => { FIND.focus = !!e.target.closest?.("#detail"); }, true);
const findKeyOn = () => chatOn() && FIND.focus && !!rowOf(S.sel)?.sessionId;

function openFind() {
  const r = rowOf(S.sel);
  if (!r?.sessionId) return;
  if (isPhone() && app.dataset.mview !== "detail") setMView("detail");
  if (!chatOn()) { S.tab = "chat"; store("tab2", S.tab); renderDetail(); }
  const el = findEl(), input = el.querySelector("input");
  el.style.top = $("dbody").offsetTop + 8 + "px";
  if (!FIND.open) {
    FIND.open = true; FIND.id = chatId(S.sel, S.sub);
    motion.show(el, true, "drop");
    if (input.value.trim()) runFind(0);
  }
  input.focus(); input.select();
}
function closeFind() {
  if (!FIND.open) return;
  FIND.open = false; FIND.seq++; clearTimeout(FIND.timer);
  FIND.list = []; FIND.cur = -1; FIND.total = -1;
  const el = findEl();
  el.querySelector("input").value = ""; FIND.q = "";
  CSS.highlights?.delete("chatfind"); CSS.highlights?.delete("chatfind-cur");
  for (const x of document.querySelectorAll("#dbody .cf-on")) x.classList.remove("cf-on");
  if (el.contains(document.activeElement)) document.activeElement.blur();
  motion.show(el, false, "drop");
}
/** The box follows its chat: another session, subagent or tab closes it. Runs on every detail render. */
function syncFind() {
  if (FIND.open && (!chatOn() || FIND.id !== chatId(S.sel, S.sub))) closeFind();
}

/** Ask the server where the words are (the whole conversation); an older deck on another machine answers with a plain
 *  window of messages instead, so fall back to what's loaded. */
function runFind(wait = 160) {
  clearTimeout(FIND.timer);
  const q = FIND.q, key = S.sel, sub = S.sub, id = chatId(key, sub), seq = ++FIND.seq;
  const keep = FIND.list[FIND.cur];
  if (!q.trim()) { FIND.list = []; FIND.cur = -1; paintFind(); return; }
  FIND.busy = true; findCount();
  FIND.timer = setTimeout(async () => {
    let res = null;
    try { res = await api("/api/chat", { key, sub, find: q }); } catch {}
    if (seq !== FIND.seq || !FIND.open) return;
    const c = chatOf(id);
    const hits = Array.isArray(res?.hits) ? res.hits : [...c.msgs.values()].sort((a, b) => a.i - b.i)
      .map((m) => [m.i, findSpans(m.role === "tool" ? m.summary ?? "" : m.text ?? "", q).length]).filter(([, n]) => n);
    FIND.busy = false;
    FIND.total = res?.total ?? c.total;
    FIND.list = findList(hits);
    const again = keep && FIND.list.findIndex((m) => m.i === keep.i && m.k === keep.k);
    if (again >= 0) { FIND.cur = again; paintFind(); return; } // new messages came in: stay on the same match
    FIND.cur = findStart(FIND.list, newestInView());
    if (FIND.cur >= 0) goFind(FIND.cur); else paintFind();
  }, wait);
}
/** The newest message whose block starts above the bottom of the chat's viewport. */
function newestInView() {
  const bottom = $("dbody").getBoundingClientRect().bottom;
  let i = -1;
  for (const b of chatDom.blocks ?? []) if (b.el.getBoundingClientRect().top < bottom) { const d = (chatDom.data ?? []).find((x) => x.key === b.key); for (const m of d?.ms ?? []) if (m.i != null && m.i > i && d.kind !== "pending") i = m.i; }
  return i < 0 ? Infinity : i;
}

/** Text nodes of a block that show the conversation (not its buttons, times or hints), joined, with where each starts. */
const FIND_SKIP = ".mt, .t, .fold, .cs, .chint, .sr, .shine, .spin, .thumbs, .gapbtn";
function textOf(root) {
  const nodes = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest(FIND_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  let text = "";
  for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({ n, at: text.length }); text += n.data; }
  return { nodes, text };
}
function rangesIn(root, q) {
  const { nodes, text } = textOf(root);
  const where = (off) => { let j = nodes.length - 1; while (j > 0 && nodes[j].at > off) j--; return [nodes[j].n, off - nodes[j].at]; };
  return findSpans(text, q).map(([a, b]) => { const r = document.createRange(); r.setStart(...where(a)); r.setEnd(...where(b - 1)); r.setEnd(r.endContainer, r.endOffset + 1); return r; });
}
/** The element that shows message i: its block, or its line in a group of tool calls. */
function findRoot(i) {
  const b = (chatDom.data ?? []).find((x) => x.kind !== "pending" && x.ms.some((m) => m.i === i));
  const el = b && chatDom.blocks.find((o) => o.key === b.key)?.el;
  if (!el || b.kind !== "tools") return { b, el };
  const shown = expanded.has(b.key) || b.ms.length <= 4 ? b.ms : b.ms.slice(-3);
  const at = shown.findIndex((m) => m.i === i);
  return { b, el: at >= 0 ? el.querySelectorAll(".tool")[at] ?? el : null, folded: at < 0 };
}

/** Highlight every match on screen and the current one; runs after each chat render while the box is open. */
function paintFind() {
  if (!FIND.open) return;
  findCount();
  const q = FIND.q.trim();
  if (!CSS.highlights) return;
  if (!q || !chatOn() || !chatDom.el) { CSS.highlights.delete("chatfind"); CSS.highlights.delete("chatfind-cur"); return; }
  const all = [];
  for (const b of chatDom.blocks ?? []) all.push(...rangesIn(b.el, q));
  CSS.highlights.set("chatfind", new Highlight(...all));
  const cur = curRange();
  if (cur) CSS.highlights.set("chatfind-cur", new Highlight(cur)); else CSS.highlights.delete("chatfind-cur");
  // New messages arrived since the search: look again (the current match stays current).
  const c = chats.get(FIND.id);
  if (c && FIND.total >= 0 && c.total !== FIND.total && !FIND.busy) { FIND.total = c.total; runFind(900); }
}
function curRange() {
  const m = FIND.list[FIND.cur];
  if (!m) return null;
  const { el } = findRoot(m.i);
  if (!el) return null;
  const rs = rangesIn(el, FIND.q.trim());
  return rs[Math.min(m.k, rs.length - 1)] ?? null;
}
function findCount() {
  const n = FIND.list.length, el = findEl().querySelector(".cf-n");
  const text = !FIND.q.trim() ? "" : FIND.busy && !n ? "…" : n ? `${FIND.cur + 1} of ${n}` : "No matches";
  if (el.textContent !== text) el.textContent = text;
  for (const b of findEl().querySelectorAll("[data-cfstep]")) b.disabled = n < 2 && !(n === 1 && FIND.cur < 0);
}

/** Step to match n (wrapping): load the messages around it if they aren't here, unfold its tool calls or long
 *  message, then bring it into view (only if it isn't already). */
async function goFind(n) {
  const len = FIND.list.length;
  if (!len) return;
  FIND.cur = ((n % len) + len) % len;
  const m = FIND.list[FIND.cur], id = FIND.id, seq = FIND.seq;
  findCount();
  if (!chatOf(id).msgs.has(m.i)) {
    scrollPin.stick = false;
    try { mergeChat(S.sel, await api("/api/chat", { key: S.sel, sub: S.sub, around: m.i }), S.sub); } catch (e) { return toast(e.message, true); }
    if (seq !== FIND.seq || FIND.list[FIND.cur] !== m) return;
  }
  let at = findRoot(m.i);
  if (at.folded) { expanded.add(at.b.key); chatDom.v = -1; renderChat(); at = findRoot(m.i); }
  at.el?.closest(".body.clamp")?.classList.remove("clamp");
  at.el?.querySelector(".body.clamp")?.classList.remove("clamp");
  // Blocks off screen skip rendering (content-visibility): this one renders now, so its match can be measured.
  for (const x of document.querySelectorAll("#dbody .cf-on")) x.classList.remove("cf-on");
  at.el?.closest(".msg")?.classList.add("cf-on");
  // Let the render settle (the chat keeps its place on resizes) before measuring where to go.
  await frames(2);
  if (seq !== FIND.seq || FIND.list[FIND.cur] !== m) return;
  paintFind();
  if (await flyToFind()) return;
  // The blocks passed on the way are laid out as they come into view and can grow: look again once it lands.
  const cur = FIND.cur, body = $("dbody");
  const land = async () => { body.removeEventListener("scrollend", land); clearTimeout(t); if (seq === FIND.seq && cur === FIND.cur) await flyToFind(); };
  const t = setTimeout(land, 1500);
  body.addEventListener("scrollend", land);
}
const frames = (n) => new Promise((ok) => { const f = () => (--n ? requestAnimationFrame(f) : ok()); requestAnimationFrame(f); });
/** Scroll the current match to 40% down the chat, smoothly; true when it was already in view. */
async function flyToFind() {
  const m = FIND.list[FIND.cur], target = curRange() ?? (m && findRoot(m.i).el);
  if (!target) return true;
  const body = $("dbody"), view = body.getBoundingClientRect();
  const dist = () => target.getBoundingClientRect().top - view.top - body.clientHeight * 0.4;
  const box = target.getBoundingClientRect(), top = view.top + findEl().offsetHeight + 16;
  if (box.top >= top && box.bottom <= view.bottom - 12) return true;
  // Mine, not yours: the pinning and scrollback loading stand aside while it flies (chat-scroll.js).
  scrollPin.stick = false; scrollPin.anchor = null; scrollPin.flying = Date.now() + 1500;
  if (motion.reduced()) { body.scrollTop += dist(); return false; }
  // A long way: most of it at once, and the last screenful glides (the blocks there render first, so it lands true).
  const d = dist();
  if (Math.abs(d) > body.clientHeight * 2) { body.scrollTop += d - Math.sign(d) * body.clientHeight; await frames(2); }
  body.scrollTo({ top: body.scrollTop + dist(), behavior: "smooth" });
  return false;
}

// ── the box ──
{
  const el = findEl(), input = el.querySelector("input");
  input.addEventListener("input", () => { FIND.q = input.value; runFind(); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); if (!isPhone()) $("cText")?.focus({ preventScroll: true }); return; }
    const step = e.key === "Enter" ? (e.shiftKey ? -1 : 1) : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    if (FIND.busy) return;
    goFind(FIND.cur < 0 ? 0 : FIND.cur + step);
  });
  el.addEventListener("click", (e) => {
    const s = e.target.closest("[data-cfstep]");
    if (s) { goFind(FIND.cur < 0 ? 0 : FIND.cur + Number(s.dataset.cfstep)); return input.focus({ preventScroll: true }); }
    if (e.target.closest("[data-cfclose]")) closeFind();
  });
  $("dh").addEventListener("click", (e) => { if (e.target.closest("[data-cfopen]")) { e.stopPropagation(); FIND.open ? closeFind() : openFind(); } });
}
