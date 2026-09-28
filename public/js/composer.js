"use strict";
// The composer: sending, queued messages, long pastes as chips, the "/" menu and file uploads.
// ── sending ──────────────────────────────────────────────────────────────
const codexSendReceipts = new Map();
function autosize(el) { el.style.height = ""; el.style.height = Math.min(el.scrollHeight, innerHeight * 0.34) + "px"; }
async function sendMessage(text, fromEl, how) {
  const key = S.sel;
  const r = rowOf(key);
  if (!r || r.hist || (!text && !pasteList(key).length)) return;
  if (!r.app) return sendReadyMessage(r, text, fromEl, how);
  if (codexSending.has(key)) return;
  const draft = fromEl.value, pastes = pasteList(key).map((p) => p.id).join();
  codexSending.add(key); renderDetail();
  try {
    if (!codexCanReply(r)) {
      const state = await connectCodex(r);
      if (!state.ready) throw new Error(state.error ?? "Could not connect to Codex. Your draft stays here.");
      // Connecting can take seconds. Never send an edited draft or clear another chat's composer.
      if (S.sel !== key || fromEl.value !== draft || pasteList(key).map((p) => p.id).join() !== pastes) return toast("Connected to Codex. Your draft is ready when you are.");
    }
    await sendReadyMessage(r, text, fromEl, how);
  } catch (x) { toast(x.message, true, { label: "Retry", run: () => { if (S.sel === key) sendMessage(fromEl.value.trim(), fromEl, how); } }); }
  finally { codexSending.delete(key); renderDetail(); }
}
async function sendReadyMessage(r, text, fromEl, how) {
  const key = r.key, working = r.app ? codexView(r)?.status === "working" : r.status === "working";
  if (r.app && working && how !== "steer") how = "later";
  const pastes = fromEl === $("cText") ? takePastes(key) : [];
  if (!text && !pastes.length) return;
  // Long text travels as a file: pasted blocks, and anything too big to type into a terminal.
  if (pastes.length || text.length > LONG_SEND) {
    try { text = await fileLongText(r, text, pastes); }
    catch (x) { restorePastes(key, pastes); toast("Couldn’t save the long text: " + x.message, true); return; }
  }
  if (how === "later" && working && isAgent(r)) {
    fromEl.value = ""; autosize(fromEl); S.drafts.delete(key); closeSlash();
    try { await api("/api/queue", { op: "add", key, text }); toast("Queued. It goes when the agent finishes this turn."); }
    catch (x) { fromEl.value = text; toast("Couldn’t queue: " + x.message, true, { label: "Retry", run: () => { if (S.sel === key) sendMessage(fromEl.value.trim() || text, fromEl, how); } }); }
    return;
  }
  closeSlash();
  const c = chatOf(chatId(key));
  const p = { role: "user", text, at: Date.now() };
  if (isAgent(r)) {
    const from = fromEl.getBoundingClientRect();
    c.pending.push(p); c.v++; S.sub = null; if (S.tab !== "chat") { S.tab = "chat"; store("tab2", S.tab); } renderDetail(); $("dbody").scrollTop = $("dbody").scrollHeight;
    // What you typed lifts out of the box into the chat.
    const el = [...$("dbody").querySelectorAll(".msg.user.pending")].pop();
    if (el) motion.travel(el, from);
  }
  fromEl.value = ""; autosize(fromEl); S.drafts.delete(key);
  try {
    const previous = codexSendReceipts.get(key);
    const receipt = r.app && previous?.text === text ? previous : { text, id: crypto.randomUUID() };
    if (r.app) codexSendReceipts.set(key, receipt);
    await api("/api/send", { key, text, requestId: receipt.id });
    codexSendReceipts.delete(key);
    setTimeout(() => chatTick(true), 250);
    setTimeout(pollTerm, 150);
  } catch (x) {
    if (x.code && x.code !== "CODEX_DELIVERY_UNKNOWN") codexSendReceipts.delete(key);
    c.pending = c.pending.filter((q) => q !== p);
    c.v++;
    fromEl.value = text;
    renderChat();
    toast("Send failed: " + x.message, true, { label: "Retry", run: () => { if (S.sel === key) sendMessage(fromEl.value.trim() || text, fromEl, how); } });
  }
}
$("composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage($("cText").value.trim(), $("cText"), e.submitter?.id === "cSteer" ? "steer" : undefined); });
$("reply").addEventListener("submit", (e) => { e.preventDefault(); sendMessage($("replyText").value.trim(), $("replyText")); });
for (const [id, form] of [["cText", "composer"], ["replyText", "reply"]]) {
  $(id).addEventListener("input", (e) => { autosize(e.target); if (S.sel) S.drafts.set(S.sel, e.target.value); });
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.altKey && !e.isComposing) { e.preventDefault(); return sendMessage(e.target.value.trim(), e.target, "later"); }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isPhone()) { e.preventDefault(); $(form).requestSubmit(); }
    if (e.key === "Escape") e.target.blur();
  });
}
$("cRecipe").onclick = (e) => openToolMenu(e.currentTarget, true);
$("cSteer").onclick = () => sendMessage($("cText").value.trim(), $("cText"), "steer");
$("cStop").onclick = () => rowOf(S.sel)?.app ? stopCodex(rowOf(S.sel)) : S.sel && api("/api/keys", { key: S.sel, keys: ["esc"] }).then(() => toast("Sent Esc to interrupt")).catch((x) => toast(x.message, true));
function focusReply() {
  if (isPhone()) setMView("detail"); // from the terminal: the same session, so the history entry is replaced (nav.js)
  else if (S.tpos === "tab" && S.main === "term") setMain("chat");
  if (S.tab !== "chat") { S.tab = "chat"; store("tab2", S.tab); renderDetail(); }
  S.board = false;
  $("cText").focus();
}

// A chat image that won't load usually means its transcript was rewritten under us: the server has
// dropped the stale parse, so reload the conversation once to get fresh image ids.
let imgRetry = 0;
document.addEventListener("error", (e) => {
  const el = e.target;
  if (el?.tagName !== "IMG" || !String(el.src).includes("/api/image") || Date.now() - imgRetry < 15_000) return;
  imgRetry = Date.now();
  const id = chatId(S.sel, S.sub);
  chats.delete?.(id);
  chatDom.key = null;
  setTimeout(() => chatTick(true), 300);
}, true);

// ── queued messages ──────────────────────────────────────────────────────
// While an agent works, Enter queues (the hub sends it when the turn ends); Steer (⌘Enter) sends now.
function renderQueue(r) {
  const q = (S.queue ?? {})[r?.key] ?? [];
  const native = r?.app && codexView(r)?.ready ? codexView(r)?.nativeQueue?.messages ?? [] : [];
  const el = $("qbar");
  if ((!q.length && !native.length) || !r || S.mode || S.sub) { el.hidden = true; el._h = ""; return; }
  el.hidden = false;
  const nativeHelp = native.length ? '<div class="native-queue-help" data-qid="codex:help"><span>Codex sends these messages. Edit or remove them in the app.</span><button type="button" class="btn ghost sm" data-native-queue-open>Open in Codex</button></div>' : "";
  const html = nativeHelp + native.map((x) => `<div class="qi" data-qid="codex:${esc(x.id)}"><span class="qn">In Codex${x.pausedReason ? " · paused" : ""}</span><span class="qt" title="${esc(x.pausedReason ? `${x.pausedReason} · ${x.text}` : x.text)}">${esc(x.text.replace(/\s+/g, " ").slice(0, 160))}</span></div>`).join("") + q.map((x, i) => `<div class="qi" data-qid="${esc(x.id)}"><span class="qn">${r.app ? "Deck · " : ""}${x.error ? "Paused" : i === 0 ? (r.status === "working" ? "Next" : "Sending…") : i + 1}</span><span class="qt" title="${esc(x.error ?? x.text.slice(0, 600))}">${esc(x.error ? `${x.error} · ${x.text.slice(0, 100)}` : x.text.replace(/\s+/g, " ").slice(0, 160))}</span><button class="ib" data-qact="edit" title="Edit">${ICON.note}</button><button class="btn ghost sm" data-qact="now" title="Send it now (steer)">Send now</button><button class="ib" data-qact="remove" title="Remove">${ICON.x}</button></div>`).join("");
  if (el._h !== html) motion.keyed(el, "data-qid", () => setHTML(el, html), "rise");
}
$("qbar").addEventListener("click", async (e) => {
  if (e.target.closest("[data-native-queue-open]")) return codexAct("codex-open", rowOf(S.sel));
  const b = e.target.closest("[data-qact]");
  if (!b) return;
  const id = b.closest("[data-qid]").dataset.qid, key = S.sel, act = b.dataset.qact;
  const it = (S.queue[key] ?? []).find((x) => x.id === id);
  try {
    if (act === "edit") {
      const text = await askDialog({ title: "Edit queued message", input: it?.text ?? "", ok: "Save", multiline: true });
      if (text != null) await api("/api/queue", { op: "update", key, id, text });
    } else await api("/api/queue", { op: act, key, id });
    if (act === "now") toast("Sent");
  } catch (x) { toast(x.message, true); }
});

// ── long pastes: a chip, not a wall of text ──────────────────────────────
// Big pastes become chips; on send each one is saved as a file on the session's machine and the
// agent gets the path (the way Claude Code itself handles long pastes). Anything else over the limit too.
const LONG_PASTE_CHARS = 4000, LONG_PASTE_LINES = 40, LONG_SEND = 12000, MAX_PASTE = 20 * 1024 * 1024;
S.pastes = new Map(); // session key → [{ id, text, name }]
const pasteList = (key = S.sel) => S.pastes.get(key) ?? [];
function takePastes(key) { const l = pasteList(key); S.pastes.delete(key); renderPastes(); return l; }
function restorePastes(key, l) { if (l.length) { S.pastes.set(key, [...l, ...pasteList(key)]); renderPastes(); } }
function pasteKind(t) {
  const s = t.trimStart();
  if (/^[\[{]/.test(s)) { try { JSON.parse(t); return "json"; } catch {} }
  if (/^(diff --git|--- a\/|@@ )/m.test(s.slice(0, 400))) return "diff";
  if (/^(\s*at |Traceback|\w+Error:|\[\d{2}:\d{2}|\d{4}-\d{2}-\d{2}[ T]\d{2}:)/m.test(s.slice(0, 2000))) return "log";
  if (/^#{1,3} |\n#{1,3} |\*\*|^- /m.test(s.slice(0, 3000))) return "md";
  return "txt";
}
function addPaste(text) {
  if (text.length > MAX_PASTE) return toast("That’s over 20 MB; attach it as a file instead", true);
  const l = pasteList();
  const kind = pasteKind(text);
  l.push({ id: Math.random().toString(36).slice(2, 8), text, name: `pasted-${l.length + 1}.${kind}`, kind });
  S.pastes.set(S.sel, l);
  renderPastes();
}
function renderPastes() {
  const el = $("cAtt");
  const l = S.sel ? pasteList() : [];
  el.hidden = !l.length;
  const html = l.map((p) => { const lines = p.text.split("\n").length; return `<span class="pchip" data-pid="${p.id}"><span class="pk">${esc(p.kind.toUpperCase())}</span><button class="pl" data-pact="view" title="Preview">Pasted text · ${lines.toLocaleString()} lines · ${p.text.length < 1024 * 1024 ? Math.max(1, Math.round(p.text.length / 1024)) + " KB" : (p.text.length / 1048576).toFixed(1) + " MB"}</button><button class="ib" data-pact="inline" title="Put the text in the message instead">${ICON.note}</button><button class="ib" data-pact="remove" title="Remove">${ICON.x}</button></span>`; }).join("") + (l.length ? `<span class="hint">Sent as ${l.length > 1 ? "files" : "a file"} the agent reads</span>` : "");
  if (el._h !== html) motion.keyed(el, "data-pid", () => setHTML(el, html));
}
$("cAtt").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pact]");
  if (!b) return;
  const id = b.closest("[data-pid]").dataset.pid, l = pasteList(), p = l.find((x) => x.id === id);
  if (!p) return;
  if (b.dataset.pact === "remove") S.pastes.set(S.sel, l.filter((x) => x !== p));
  if (b.dataset.pact === "inline") { S.pastes.set(S.sel, l.filter((x) => x !== p)); const ta = $("cText"); ta.value = ta.value ? `${ta.value}\n${p.text}` : p.text; autosize(ta); }
  if (b.dataset.pact === "view") {
    const d = document.createElement("dialog"); d.className = "ask wide";
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${esc(p.name)} <span class="hint">${p.text.split("\n").length.toLocaleString()} lines</span></h3><pre class="pview">${esc(p.text.slice(0, 200_000))}${p.text.length > 200_000 ? "\n…" : ""}</pre></div><div class="dlg-f"><button class="btn primary" value="ok">Done</button></div></form>`;
    document.body.append(d); d.addEventListener("close", () => motion.drop(d)); d.showModal();
  }
  renderPastes();
});
/** Saves pasted blocks (and a too-long message) next to the session and returns the message the agent gets. */
async function fileLongText(r, text, pastes) {
  const blocks = [...pastes];
  if (text.length > LONG_SEND) { blocks.unshift({ text, name: "message.md", kind: "md" }); text = ""; }
  const refs = [];
  for (const [i, p] of blocks.entries()) {
    const res = await fetch(`/api/upload?key=${encodeURIComponent(r.key)}&name=${encodeURIComponent(p.name)}`, { method: "POST", headers: { "x-deck-token": S.token, "content-type": "text/plain;charset=utf-8" }, body: new Blob([p.text], { type: "text/plain" }) });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error ?? res.statusText);
    const lines = p.text.split("\n").length;
    refs.push(p.name === "message.md" ? `[My full message is in ${j.path} (${lines} lines). Read it first.]` : `[Pasted text #${i + 1}: ${lines} lines, saved at ${j.path}. Read it.]`);
  }
  return [text, ...refs].filter(Boolean).join("\n\n");
}

// ── "/" menu: the agent's own commands, plus deck tools ──────────────────
const slash = { cache: new Map(), open: false, idx: 0, items: [] };
function closeSlash() { slash.open = false; motion.show($("slashPop"), false, "popup"); }
async function slashFor(r) {
  const k = `${r.machine}|${r.agent}|${r.projectRoot ?? r.cwd}`;
  if (!slash.cache.has(k)) slash.cache.set(k, api("/api/slash", { key: r.key }).then((x) => x.commands ?? []).catch(() => []));
  return slash.cache.get(k);
}
async function updateSlash() {
  const ta = $("cText"), r = rowOf(S.sel);
  const m = ta.value.match(/^\/([\w:.\-]*)$/);
  if (!m || !r || !isAgent(r) || r.app) return closeSlash();
  const q = m[1].toLowerCase();
  const cmds = await slashFor(r);
  if (ta.value.match(/^\/([\w:.\-]*)$/)?.[1].toLowerCase() !== q) return;
  const score = (c) => { const n = c.cmd.slice(1).toLowerCase(); if (!q) return 1; if (n === q) return 100; if (n.startsWith(q)) return 60 - n.length / 10; const seg = n.split(/[:\-]/); if (seg.some((x) => x.startsWith(q))) return 40; if (n.includes(q)) return 20; return (c.desc ?? "").toLowerCase().includes(q) ? 5 : 0; };
  const srcRank = { project: 0, yours: 1, "built-in": 2, prompt: 2, skill: 3, plugin: 4 };
  const agentItems = cmds.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || srcRank[a.c.src] - srcRank[b.c.src] || a.c.cmd.localeCompare(b.c.cmd)).slice(0, 40).map((x) => ({ ...x.c, type: "cmd" }));
  const tools = S.tools.filter((t) => t.action !== "upload" && (!q || fuzzy(`${t.label} ${t.hint ?? ""}`, q))).slice(0, q ? 4 : 3).map((t) => ({ type: "tool", tool: t, cmd: t.label, desc: t.hint }));
  slash.items = [...agentItems, ...tools];
  slash.idx = 0;
  slash.open = slash.items.length > 0;
  renderSlash(r);
}
function renderSlash(r) {
  const el = $("slashPop");
  if (!slash.open) return motion.show(el, false, "popup");
  motion.show(el, true, "popup");
  const who = r.agent === "claude" ? "Claude Code" : r.agent === "codex" ? "Codex" : "OpenCode";
  let lastType = "";
  el.innerHTML = slash.items.map((it, i) => {
    const head = it.type !== lastType ? `<div class="sh">${it.type === "cmd" ? `${who} commands` : "Deck tools"}</div>` : "";
    lastType = it.type;
    return `${head}<button type="button" role="option" class="si${i === slash.idx ? " on" : ""}" data-si="${i}" aria-selected="${i === slash.idx}">${it.type === "tool" ? `<span class="sg">${toolGlyph(it.tool)}</span>` : ""}<b>${esc(it.cmd)}</b>${it.hint ? `<span class="shint">${esc(it.hint)}</span>` : ""}<span class="sd">${esc(it.desc ?? "")}</span>${it.src && it.src !== "built-in" ? `<span class="ssrc">${esc(it.src)}</span>` : ""}</button>`;
  }).join("");
  el.querySelector(".si.on")?.scrollIntoView({ block: "nearest" });
}
function chooseSlash(i, send) {
  const it = slash.items[i];
  if (!it) return;
  const ta = $("cText");
  closeSlash();
  if (it.type === "tool") { ta.value = ""; autosize(ta); return runTool(it.tool); }
  ta.value = it.cmd + " ";
  autosize(ta);
  ta.focus();
  if (send && !it.hint) sendMessage(it.cmd, ta);
}
$("cText").addEventListener("input", () => { renderPastes(); updateSlash(); });
$("cText").addEventListener("keydown", (e) => {
  if (!slash.open) return;
  const n = slash.items.length;
  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { slash.idx = (slash.idx + 1) % n; renderSlash(rowOf(S.sel)); }
  else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { slash.idx = (slash.idx - 1 + n) % n; renderSlash(rowOf(S.sel)); }
  else if (e.key === "Tab") chooseSlash(slash.idx, false);
  else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) chooseSlash(slash.idx, true);
  else if (e.key === "Escape") closeSlash();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
$("slashPop").addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the box
$("slashPop").addEventListener("click", (e) => { const b = e.target.closest("[data-si]"); if (b) chooseSlash(Number(b.dataset.si), true); });
$("cText").addEventListener("blur", () => setTimeout(closeSlash, 120));

// ── uploads: attach button, drag and drop, paste ─────────────────────────────
function pickFiles() {
  const r = rowOf(S.sel);
  if (!r || r.hist) return toast("Open a live session to attach files", true);
  $("fileIn").value = "";
  $("fileIn").click();
}
async function uploadFiles(files) {
  const r = rowOf(S.sel);
  if (!r || r.hist) return toast("Open a live session to attach files", true);
  const list = [...files].slice(0, 20);
  if (!list.length) return;
  const ta = $("cText");
  toast(`Uploading ${list.length} file${list.length > 1 ? "s" : ""}…`);
  const paths = [];
  for (const f of list) {
    try {
      const res = await fetch(`/api/upload?key=${encodeURIComponent(r.key)}&name=${encodeURIComponent(f.name || "pasted.png")}`, { method: "POST", headers: { "x-deck-token": S.token, "content-type": "application/octet-stream" }, body: f });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? res.statusText);
      paths.push(j.path);
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  if (!paths.length) return;
  const block = paths.map((p) => `[Attached: ${p}]`).join("\n");
  ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${block}\n` : `${block}\n`;
  autosize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  toast(`Attached ${paths.length}. Add a note and send.`);
}
$("fileIn").addEventListener("change", (e) => uploadFiles(e.target.files));
// The paperclip is a <label for="fileIn">: the browser opens the picker itself, which works everywhere
// (a script-triggered click on a hidden input is ignored by some phones and installed apps).
$("cAttach").addEventListener("click", (e) => {
  const r = rowOf(S.sel);
  if (!r || r.hist) { e.preventDefault(); return toast("Open a live session to attach files", true); }
  $("fileIn").value = "";
});
$("cAttach").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("cAttach").click(); } });
{
  let depth = 0;
  const det = $("detail");
  const canDrop = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files") && !S.mode && rowOf(S.sel) && !rowOf(S.sel).hist;
  det.addEventListener("dragenter", (e) => { if (!canDrop(e)) return; e.preventDefault(); depth++; det.classList.add("dropping"); });
  det.addEventListener("dragover", (e) => { if (canDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  det.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) det.classList.remove("dropping"); });
  det.addEventListener("drop", (e) => { if (!canDrop(e)) return; e.preventDefault(); depth = 0; det.classList.remove("dropping"); uploadFiles(e.dataTransfer.files); });
  $("cText").addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files ?? [])];
    if (fs.length) { e.preventDefault(); return uploadFiles(fs); }
    const t = e.clipboardData?.getData("text/plain") ?? "";
    if (t.length > LONG_PASTE_CHARS || t.split("\n").length > LONG_PASTE_LINES) { e.preventDefault(); addPaste(t); }
  });
}
