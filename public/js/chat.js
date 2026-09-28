"use strict";
// The chat engine: each conversation's messages by index, merged from /api/chat, rendered as keyed blocks.
// ── chat engine ──────────────────────────────────────────────────────────
// Per conversation (session, or session#subagent): messages by index, a gen that voids old cursors,
// and pending sends shown until the transcript echoes them.
const chats = new Map();
const chatId = (key, sub) => (sub ? `${key}#${sub}` : key);
function chatOf(id) {
  let c = chats.get(id);
  if (!c) { c = { gen: null, total: 0, msgs: new Map(), first: Infinity, last: -1, pending: [], busy: false, v: 0 }; chats.set(id, c); }
  return c;
}
function mergeChat(key, slice, sub) {
  const c = chatOf(chatId(key, sub));
  if (c.gen !== slice.gen || slice.reset) { c.msgs.clear(); c.first = Infinity; c.last = -1; c.gen = slice.gen; if (S.sel === key) chatDom.key = null; }
  c.total = slice.total;
  for (const m of slice.messages) {
    c.msgs.set(m.i, m);
    c.first = Math.min(c.first, m.i);
    c.last = Math.max(c.last, m.i);
    if (m.role === "user" && c.pending.length) c.pending = c.pending.filter((p) => p.text.trim() !== String(m.text ?? "").trim());
  }
  c.pending = c.pending.filter((p) => Date.now() - p.at < 90_000);
  c.v++;
  if (S.sel === key && S.sub === (sub ?? null)) renderChat();
}
let chatTimer = null;
async function chatTick(now) {
  clearTimeout(chatTimer);
  const key = S.sel, sub = S.sub;
  const r = rowOf(key);
  if (!r) return;
  const visible = chatOn() && (isPhone() ? app.dataset.mview === "detail" : !(S.tpos === "tab" && S.main === "term"));
  const c = chatOf(chatId(key, sub));
  const live = r.status === "working" || r.status === "blocked" || (r.subagents ?? []).some((x) => x.running) || c.pending.length;
  // Opening a session: its detail, already on the way, brings this chat's first window.
  const coming = !sub && c.gen == null && inflight.get(key)?.withChat;
  if (visible && !document.hidden && !c.busy && !coming && r.sessionId) {
    const due = now === true || live || c.stamp !== r.lastActiveAt;
    if (due) {
      c.busy = true;
      c.stamp = r.lastActiveAt;
      try {
        const q = c.gen == null ? { key, sub, limit: 150 } : { key, sub, gen: c.gen, after: c.last };
        mergeChat(key, await api("/api/chat", q), sub);
      } catch {}
      c.busy = false;
    }
  }
  chatTimer = setTimeout(chatTick, live ? 900 : 2500);
}
async function loadGap(from, to) {
  const c = chatOf(chatId(S.sel, S.sub));
  try { mergeChat(S.sel, await api("/api/chat", { key: S.sel, sub: S.sub, gen: c.gen, from, to: Math.min(to, from + 150) }), S.sub); } catch (e) { toast(e.message, true); }
}
/** Open a session's chat at one message (from a search hit), highlighted. */
async function jumpTo(key, i) {
  if (S.sel !== key) select(key, { open: true });
  S.tab = "chat"; S.sub = null;
  const c = chatOf(chatId(key));
  // Hold the jump for a moment: the refreshes that follow opening a session must not scroll away from it.
  S.jump = { key, i, until: Date.now() + 3000, flashed: false };
  if (!c.msgs.has(i)) { try { mergeChat(key, await api("/api/chat", { key, around: i })); } catch { return; } }
  headSig = ""; bodySig = ""; renderDetail();
  applyJump();
}
function applyJump() {
  const j = S.jump;
  if (!j || j.key !== S.sel || Date.now() > j.until) { S.jump = null; return false; }
  const b = (chatDom.data ?? []).find((x) => x.ms.some((m) => m.i === j.i));
  const el = b && chatDom.blocks.find((o) => o.key === b.key)?.el;
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  if (!el.classList.contains("hl")) el.classList.add("hl"); // a redraw replaced the element: mark the new one too
  j.flashed = true;
  return true;
}
async function loadEarlier() {
  const c = chatOf(chatId(S.sel, S.sub));
  if (c.busy || !(c.first > 0) || c.gen == null) return;
  c.busy = true;
  const body = $("dbody");
  const h = body.scrollHeight, top = body.scrollTop;
  try {
    mergeChat(S.sel, await api("/api/chat", { key: S.sel, sub: S.sub, gen: c.gen, before: c.first, limit: 150 }), S.sub);
    body.scrollTop = top + (body.scrollHeight - h);
  } catch {}
  c.busy = false;
}

/** Messages → blocks: consecutive tool calls fold into one group; subagent calls get their own card. */
function chatBlocks(c) {
  const ms = [...c.msgs.values()].sort((a, b) => a.i - b.i);
  const blocks = [];
  let group = null;
  let prevI = null;
  for (const m of ms) {
    if (prevI != null && m.i - prevI > 1) { group = null; blocks.push({ key: "gap" + prevI, kind: "gap", ms: [{ i: prevI + 1, to: m.i }] }); }
    prevI = m.i;
    const agent = m.role === "tool" && /^(agent|task)$/i.test(m.tool ?? "");
    if (m.role === "tool" && !agent) {
      if (!group) { group = { key: "t" + m.i, kind: "tools", ms: [] }; blocks.push(group); }
      group.ms.push(m);
      continue;
    }
    group = null;
    blocks.push({ key: "m" + m.i, kind: agent ? "agent" : m.role, ms: [m] });
  }
  for (const p of c.pending) blocks.push({ key: "p" + p.at, kind: "pending", ms: [p] });
  return blocks;
}
const expanded = new Set();
const MSG_TOOLS = `<span class="mt"><button class="ib" data-copy title="Copy" aria-label="Copy">${'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5"/></svg>'}</button><button class="ib" data-pick title="Select (for copying several)" aria-label="Select"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5.5 8 2 2 3-4"/></svg></button></span>`;
function blockHTML(b, key) {
  const m = b.ms[0];
  const imgs = (list) => (list?.length ? `<div class="thumbs">${list.map((id) => `<button data-cimg="${esc(id)}"><img loading="lazy" decoding="async" alt="" src="${imgUrl(key, id, S.sub)}" onerror="this.parentElement.hidden=true"></button>`).join("")}</div>` : "");
  if (b.kind === "gap") return `<button class="gapbtn" data-gap="${m.i}" data-gapto="${m.to}">⋯ ${m.to - m.i} more messages here · show them</button>`;
  if (b.kind === "user" || b.kind === "pending") {
    const long = (m.text ?? "").length > 900;
    return `<div class="msg user${b.kind === "pending" ? " pending" : ""}">${MSG_TOOLS}<div class="body${long ? " clamp" : ""}" ${long ? "data-toggle" : ""}>${esc(m.text)}</div>${imgs(m.images)}<div class="t">${b.kind === "pending" ? "sending…" : esc(when(m.at))}</div></div>`;
  }
  if (b.kind === "assistant") return `<div class="msg assistant">${MSG_TOOLS}<div class="md">${md(m.text)}</div>${imgs(m.images)}<div class="t">${esc(when(m.at))}</div></div>`;
  if (b.kind === "note") return `<div class="note${/^Recap:/.test(m.text) ? " recap" : ""}">${/^Recap:/.test(m.text) ? mdLite(m.text) : esc(m.text)}</div>`;
  if (b.kind === "agent") {
    const d = S.details.get(S.sel)?.data;
    const sub = (d?.subagents ?? []).find((x) => x.id === m.sub) ?? (d?.subagents ?? []).find((x) => x.description && m.summary?.startsWith(x.description));
    const running = sub ? sub.running : m.state === "running";
    return `<button class="agent-card msg" ${sub ? `data-sub="${esc(sub.id)}"` : "disabled"}><span class="ic">${ICON.bot}</span><span class="d">${esc(sub?.description ?? m.summary ?? "Subagent")}</span>
      <span class="s">${running ? '<span class="spin"></span>running' : m.state === "error" ? "failed" : "done"}${sub?.tools ? ` · ${sub.tools} tools` : ""}</span>
      <span class="m${running && sub?.now ? " mono" : ""}">${running && sub?.now ? esc(sub.now) : esc([sub?.type ?? m.subType, sub?.model].filter(Boolean).join(" · ") || "subagent")}${sub ? " · open ›" : ""}</span></button>`;
  }
  // tool group
  const all = b.ms;
  const open = expanded.has(b.key) || all.length <= 4;
  const shown = open ? all : all.slice(-3);
  const line = (t) => { const w = toolWords(t.tool); const run = t.state === "running"; return `<div class="tool${run ? " run" : ""}${t.state === "error" ? " err" : ""}" title="${esc(t.tool)}">${toolIcon(w.k)}<span class="nm">${esc(run ? w.doing : w.done)}</span><span class="sm">${esc(t.summary ?? "")}</span>${run ? '<span class="spin"></span>' : t.state === "error" ? '<span class="x">failed</span>' : ""}</div>`; };
  const allImgs = all.flatMap((t) => t.images ?? []);
  return `<div class="tools msg">${MSG_TOOLS}${!open ? `<button class="fold" data-fold="${b.key}">▸ ${all.length - 3} earlier tool calls</button>` : all.length > 4 ? `<button class="fold" data-fold="${b.key}">▾ hide</button>` : ""}${shown.map(line).join("")}${imgs(allImgs.slice(-6))}</div>`;
}
const chatDom = { key: null, blocks: [], el: null };
/** The chat is what the detail body shows (not a view, the board, or another tab; empty tabs count as chat). */
const chatOn = () => !!S.sel && !S.board && !S.mode && effTab(S.tab, S.details.get(S.sel)?.data, S.simple) === "chat";
function renderChat() {
  const body = $("dbody");
  const key = S.sel;
  if (!key || !chatOn()) return;
  const id = chatId(key, S.sub);
  const c = chatOf(id);
  const r = rowOf(key);
  if (c.gen == null && !c.msgs.size && !c.pending.length) {
    // No conversation (a shell, or an agent that hasn't been asked anything yet): show the live terminal here.
    const noConv = r && !r.sessionId;
    const tail = noConv ? (r.tail ?? []).slice(-24).join("\n") : "";
    const k = id + ":loading:" + (noConv ? tail.length + ":" + tail.slice(-80) + termHidden() : "");
    if (chatDom.key !== k) {
      chatDom.key = k;
      body.innerHTML = noConv
        ? `<div class="chat noconv"><p class="hint">${r.agent === "shell" ? "A shell. Type a command below and press Enter." : r.empty ? `${esc(r.agent === "opencode" ? "OpenCode" : r.agent === "codex" ? "Codex" : r.agent === "claude" ? "Claude" : r.agent)} is ready. Send it a message below.` : "No conversation found for this pane. Here’s its terminal."}</p><pre class="dterm live">${ansi(tail) || "…"}</pre>${termHidden() || app.classList.contains("term-off") ? `<button class="btn" data-dact="showterm">${ICON.term}Open the terminal</button>` : ""}</div>`
        : `<div class="chat loading" aria-busy="true"><p class="sr">Loading the conversation…</p><div class="sk u"></div><div class="sk"></div><div class="sk s"></div></div>`;
    }
    return;
  }
  const dref = S.details.get(key)?.data;
  const st = rowOf(key)?.status;
  if (chatDom.key === id && chatDom.v === c.v && chatDom.dref === dref && chatDom.st === st && chatDom.el && body.contains(chatDom.el)) return;
  chatDom.v = c.v; chatDom.dref = dref; chatDom.st = st;
  const blocks = chatBlocks(c);
  const nearBottom = scrollPin.stick;
  const rebuilt = chatDom.key !== id || !chatDom.el || !body.contains(chatDom.el);
  const anchor = !rebuilt && !nearBottom ? takeAnchor() : null;
  if (rebuilt) {
    const wasLoading = !!body.querySelector(".chat.loading");
    chatDom.key = id;
    chatDom.blocks = [];
    const wrap = document.createElement("div");
    wrap.className = "chat";
    wrap.innerHTML = `<button class="btn ghost more" data-earlier ${c.first > 0 ? "" : "hidden"}>Load earlier messages</button>`;
    body.replaceChildren(wrap);
    chatDom.el = wrap;
    chatSizeObs.disconnect();
    chatSizeObs.observe(wrap);
    if (wasLoading) motion.enter(wrap, "fade");
  }
  const wrap = chatDom.el;
  wrap.querySelector("[data-earlier]").hidden = !(c.first > 0);
  const old = new Map(chatDom.blocks.map((b) => [b.key, b]));
  const next = [];
  let prevEl = wrap.querySelector("[data-earlier]");
  // Your message, once the transcript echoes it, takes the pending bubble's place without a second entrance.
  const echoed = new Set((chatDom.data ?? []).filter((b) => b.kind === "pending" && !blocks.some((x) => x.key === b.key)).map((b) => String(b.ms[0].text ?? "").trim()));
  let entering = 0;
  for (const b of blocks) {
    const sig = JSON.stringify(b.ms) + (b.kind === "agent" ? JSON.stringify(S.details.get(key)?.data?.subagents?.map((x) => [x.id, x.running, x.now, x.tools])) : "") + expanded.has(b.key);
    let o = old.get(b.key);
    if (!o || o.sig !== sig) {
      const t = document.createElement("template");
      t.innerHTML = blockHTML(b, key).trim();
      const el = t.content.firstElementChild;
      el.dataset.b = b.key;
      if (o) o.el.replaceWith(el);
      else if (chatDom.fresh === id && !(b.kind === "user" && echoed.has(String(b.ms[0].text ?? "").trim())) && entering++ < 8) el.classList.add("enter"); // new while you watch: ease it in
      o = { key: b.key, sig, el };
    }
    o.el.classList.toggle("picked", chatSel.has(b.key));
    if (prevEl.nextElementSibling !== o.el) prevEl.after(o.el);
    prevEl = o.el;
    old.delete(b.key);
    next.push(o);
  }
  for (const o of old.values()) o.el.remove();
  chatDom.blocks = next;
  chatDom.data = blocks;
  decorateLatest(wrap, blocks, rowOf(key));
  const grew = next.length && next[next.length - 1].key !== chatDom.lastKey;
  chatDom.lastKey = next[next.length - 1]?.key;
  if (applyJump()) { chatDom.fresh = id; scrollPin.stick = false; }
  else if (chatDom.fresh !== id) { chatDom.fresh = id; toBottom(); }
  else if (nearBottom) toBottom();
  else { restoreAnchor(anchor); if (grew) scrollPin.unread++; }
  renderJumpBtn();
}
/** Only the newest agent message is actionable: its choices become buttons, a closing question gets quick replies. */
function decorateLatest(wrap, blocks, r) {
  // The quick replies and the thinking bubble stay put across redraws (re-adding them would replay their entrance).
  let quick = wrap.querySelector(".quick"), think = wrap.querySelector(".thinking");
  for (const el of wrap.querySelectorAll(".choices.pickable")) el.classList.remove("pickable");
  for (const el of wrap.querySelectorAll(".msg.live")) el.classList.remove("live");
  const done = () => { quick?.remove(); think?.remove(); };
  if (!r || S.sub) return done();
  for (const el of wrap.querySelectorAll(".choices")) el.classList.toggle("can", codexCanReply(r) && isAgent(r));
  const canSend = codexCanReply(r) && isAgent(r) && r.status !== "working";
  const lastAsst = [...blocks].reverse().find((b) => b.kind === "assistant");
  const tailBlock = blocks[blocks.length - 1];
  const lastEl = lastAsst && chatDom.blocks.find((o) => o.key === lastAsst.key)?.el;
  if (lastEl && canSend && tailBlock === lastAsst) {
    const ch = lastEl.querySelector(".choices");
    if (ch) ch.classList.add("pickable");
    else {
      const text = String(lastAsst.ms[0].text ?? "").trim();
      const q = text.split(/\n\s*\n/).pop() ?? "";
      if (/\?\s*\**\s*$/.test(q) && /\b(should|shall|want|do you|would you|can i|may i|ok to|okay to|go ahead|proceed|ready)\b/i.test(q)) {
        if (quick && quick.previousElementSibling === lastEl) quick = null;
        else {
          const d = document.createElement("div");
          d.className = "quick";
          d.innerHTML = ["Yes, go ahead", "No, not now", "Tell me more first"].map((t) => `<button class="btn" data-quick="${esc(t)}">${esc(t)}</button>`).join("");
          lastEl.after(d);
        }
      }
    }
  }
  // A turn is running but nothing has come back yet: say so, in the chat, where you're looking.
  if (r.status === "working" && tailBlock && (tailBlock.kind === "user" || tailBlock.kind === "pending")) {
    if (think) { if (think.nextElementSibling) { wrap.append(think); think.style.animation = "none"; } think = null; }
    else {
      const d = document.createElement("div");
      d.className = "thinking";
      d.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>${esc(r.agent === "claude" ? "Claude" : r.agent === "codex" ? "Codex" : r.agent)} is thinking`;
      wrap.append(d);
    }
  }
  // Still writing this message: a caret after its newest words.
  if (r.status === "working" && lastEl && tailBlock === lastAsst) lastEl.classList.add("live");
  done();
}
