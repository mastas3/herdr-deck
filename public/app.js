"use strict";
// herdr deck client. State arrives inlined in the page (window.__BOOT__), then as row patches over SSE.

// ── state ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function store(k, v) { try { localStorage.setItem("deck:" + k, JSON.stringify(v)); } catch {} }
function load(k, d) { try { const v = localStorage.getItem("deck:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
const S = {
  token: "", self: "", rows: new Map(), summary: { herdr: [], machines: [] }, graveyard: [], recipes: [],
  machine: load("machine", "all"), q: "", sel: null, picked: new Set(), view: "inbox",
  tab: load("tab", "story"), closedSecs: load("closedSecs", { stale: true, empty: true }),
  notify: false, fit: load("fit", true), autoBrief: load("autoBrief", true), oldestFirst: load("oldestFirst", true),
  details: new Map(),
};
S.notify = load("notify", false) && "Notification" in window && Notification.permission === "granted";
const theme = load("theme", ""); if (theme) document.documentElement.dataset.theme = theme;
const app = $("app");
app.style.setProperty("--lw-open", load("lw", 380) + "px");
app.style.setProperty("--th-open", load("th", Math.round(innerHeight * 0.36)) + "px");
app.classList.toggle("list-off", load("listOff", false));
app.classList.toggle("term-off", load("termOff", false));
const phone = matchMedia("(max-width: 760px)");
const isPhone = () => phone.matches;

// ── formatting ───────────────────────────────────────────────────────────
function ago(t) {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 60) return Math.round(s / 86400) + "d";
  return Math.round(s / 86400 / 30) + "mo";
}
const agoText = (t) => (!t ? "" : ago(t) === "now" ? "just now" : ago(t) + " ago");
const DTF = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const DF = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const abs = (t) => (t ? DTF.format(new Date(t)) : "—");
const mem = (kb) => (kb >= 1048576 ? (kb / 1048576).toFixed(1) + " GB" : Math.round(kb / 1024) + " MB");
const tok = (n) => (n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
function hue(name) { let h = 2166136261; for (const c of name) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h) % 360; }
const pc = (p) => `oklch(var(--pc-l) var(--pc-c) ${hue(p || "?")})`;
const STATUS_NAME = { working: "Working", blocked: "Needs input", done: "Finished", idle: "Idle", empty: "Empty", unknown: "Unknown" };
const statusVar = (s) => `var(--${s in STATUS_NAME ? s : "unknown"})`;
const machineOf = (id) => S.summary.machines?.find((m) => m.id === id);
const machineLabel = (id) => machineOf(id)?.label ?? id ?? "";
const multiMachine = () => (S.summary.machines?.length ?? 0) > 1;
/** One-line plain text for list snippets: no markdown markers or leading timestamps. */
const plain = (t) => String(t ?? "").replace(/^\s*\[\d{4}-\d\d-\d\d[^\]]*\]\s*/, "").replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/, "").replace(/\s+/g, " ").trim();
/** Light, safe markdown for prose: escape first, then bold, inline code, headings. */
const md = (t) => esc(t)
  .replace(/`([^`\n]+)`/g, '<code class="mono" style="font-size:.86em">$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
  .replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
const home = (p) => String(p ?? "").replace(/^\/(Users|home)\/[^/]+/, "~");
const ICON = {
  chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 6 4 4 4-4"/></svg>',
  back: '<svg class="chev" style="transform:rotate(90deg)" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 6 4 4 4-4"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  jump: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2 7.5 8.5"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.8 9.5 6l4.3.2-3.4 2.7 1.2 4.2L8 10.7l-3.6 2.4 1.2-4.2L2.2 6.2 6.5 6z"/></svg>',
  reply: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4 2 8l4 4M2 8h8a4 4 0 0 1 4 4v1"/></svg>',
};

// ── inbox ────────────────────────────────────────────────────────────────
const SECTIONS = [["needs", "Needs you"], ["running", "Running"], ["quiet", "Quiet"], ["stale", "Stale"], ["empty", "Empty"]];
function sectionOf(r) {
  if (r.status === "blocked" || r.status === "done") return "needs";
  if (r.status === "working") return "running";
  if (r.empty) return "empty";
  if (r.stale) return "stale";
  return "quiet";
}
function parseQuery(q) {
  const inc = [], exc = [], is = [], agent = [];
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w.startsWith("is:")) is.push(w.slice(3));
    else if (w.startsWith("agent:")) agent.push(w.slice(6));
    else if (w.startsWith("-") && w.length > 1) exc.push(w.slice(1));
    else inc.push(w);
  }
  return { inc, exc, is, agent };
}
function hay(r) {
  return (r._hay ??= [r.title, r.project, r.branch, r.cwd, r.agent, r.status, r.model, r.tab, machineLabel(r.machine), r.firstPrompt, r.lastMessage, r.tail.join(" ")].filter(Boolean).join(" \u0001 ").toLowerCase());
}
const inScope = (r) => S.machine === "all" || r.machine === S.machine;
function visibleRows() {
  const q = parseQuery(S.q);
  const out = [];
  for (const r of S.rows.values()) {
    if (!inScope(r)) continue;
    if (q.is.length && !q.is.every((f) => (f === "stale" ? r.stale : f === "dup" ? r.duplicate : f === "empty" ? r.empty : r.status === f))) continue;
    if (q.agent.length && !q.agent.some((a) => r.agent.startsWith(a))) continue;
    if (q.inc.length || q.exc.length) {
      const h = hay(r);
      if (!q.inc.every((w) => h.includes(w)) || q.exc.some((w) => h.includes(w))) continue;
    }
    out.push(r);
  }
  const act = (r) => r.lastActiveAt ?? r.startedAt ?? 0;
  out.sort((a, b) => (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1) || act(b) - act(a));
  return out;
}
function snippet(r) {
  const tail = r.tail?.length ? r.tail[r.tail.length - 1].trim() : "";
  if (r.status === "blocked") return [plain(tail) || "waiting for you", "ask"];
  if (r.status === "working") return [tail, "mono"];
  if (r.empty) return [r.agent === "shell" ? "empty shell" : "no conversation yet", ""];
  return [plain(r.lastMessage || tail), ""];
}

// ── list rendering (keyed; only changed rows touch the DOM) ──────────────
const rowCache = new Map();
function rowHTML(r) {
  const [snip, cls] = snippet(r);
  const live = r.status === "working";
  return `<span class="dot" style="--c:${statusVar(r.status)}"></span>
<span class="title">${esc(r.title || "(untitled)")}</span>
<span class="ago${live ? " live" : ""}" ${live ? "" : `data-t="${r.lastActiveAt ?? ""}"`} title="Last active ${esc(abs(r.lastActiveAt))}">${live ? "working" : ago(r.lastActiveAt)}</span>
<span class="meta"><span class="proj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>${multiMachine() && S.machine === "all" ? `<span class="mach">${esc(machineLabel(r.machine))}</span>` : ""}${snip ? `<span class="snip ${cls}">${esc(snip)}</span>` : ""}</span>`;
}
let lastOrder = "", queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; renderNow(); });
}
function renderNow() {
  renderMachines();
  if (S.view === "closed") renderClosed(); else renderInbox();
  renderFooter();
  renderDetail();
  const n = [...S.rows.values()].filter((r) => r.status === "blocked" || r.status === "done").length;
  document.title = (n ? `(${n}) ` : "") + "herdr deck";
}
function renderMachines() {
  const ms = S.summary.machines ?? [];
  const count = (id) => [...S.rows.values()].filter((r) => id === "all" || r.machine === id).length;
  const html = ms.length > 1 ? [["all", "All"], ...ms.map((m) => [m.id, m.label, m])].map(([id, label, m]) =>
    `<button role="tab" data-machine="${esc(id)}" aria-selected="${S.machine === id}" title="${m && !m.online ? esc("Offline: " + (m.error ?? "")) : ""}">${esc(label)} <span class="n">${count(id)}</span>${m && !m.online ? '<span class="off"></span>' : ""}</button>`).join("") : "";
  setHTML($("machines"), html);
  $("machines").hidden = ms.length <= 1;
}
function renderInbox() {
  const box = $("rows");
  const rows = visibleRows();
  const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  for (const r of rows) groups[sectionOf(r)].push(r);
  S.visible = SECTIONS.flatMap(([k]) => (S.closedSecs[k] ? [] : groups[k]));
  for (const k of rowCache.keys()) if (!S.rows.has(k)) rowCache.delete(k);
  for (const r of rows) {
    let c = rowCache.get(r.key);
    if (!c) {
      const el = document.createElement("div");
      el.className = "row"; el.dataset.key = r.key; el.setAttribute("role", "button");
      c = { el, sig: "" };
      rowCache.set(r.key, c);
    }
    const sig = JSON.stringify(r) + S.machine + multiMachine();
    if (c.sig !== sig) { c.el.innerHTML = rowHTML(r); c.el.dataset.status = r.status; c.sig = sig; }
    c.el.classList.toggle("sel", S.sel === r.key);
    c.el.classList.toggle("picked", S.picked.has(r.key));
    c.el.classList.toggle("stale", sectionOf(r) === "stale");
  }
  const order = SECTIONS.map(([k]) => k + ":" + (S.closedSecs[k] ? "x" : "") + groups[k].map((r) => r.key).join(",")).join("|");
  if (order !== lastOrder || box.dataset.view !== "inbox") {
    lastOrder = order;
    box.dataset.view = "inbox";
    box._h = "";
    const frag = document.createDocumentFragment();
    for (const [k, label] of SECTIONS) {
      if (!groups[k].length) continue;
      const sec = document.createElement("section");
      sec.className = "sec" + (S.closedSecs[k] ? " closed" : "");
      const extra = k === "empty" ? `<span class="act link" data-secact="closeEmpty" role="button">Close all</span>` : "";
      sec.innerHTML = `<button class="sec-h" data-sec="${k}" aria-expanded="${!S.closedSecs[k]}">${ICON.chev}${label} <span class="n">${groups[k].length}</span>${extra}</button><div class="sec-b"></div>`;
      const body = sec.lastChild;
      for (const r of groups[k]) body.append(rowCache.get(r.key).el);
      frag.append(sec);
    }
    box.replaceChildren(frag);
    if (!rows.length) box.innerHTML = `<div class="empty-state">${S.rows.size ? "Nothing matches. Press Esc to clear the filter." : "No sessions yet. Press n to start one."}</div>`;
  }
  setHTML($("mini"), rows.filter((r) => sectionOf(r) !== "empty").map((r) => `<button data-key="${esc(r.key)}" class="${S.sel === r.key ? "sel" : ""}" style="--c:${statusVar(r.status)}" title="${esc(r.title)} · ${esc(r.project)}"></button>`).join(""));
  for (const k of S.picked) if (!S.rows.has(k)) S.picked.delete(k);
  $("selbar").hidden = !S.picked.size;
  if (S.picked.size) $("selInfo").textContent = `${S.picked.size} selected`;
}
function renderFooter() {
  const all = [...S.rows.values()].filter(inScope);
  const off = (S.summary.machines ?? []).filter((m) => !m.online);
  setHTML($("lf"), `<span><b>${all.length}</b> sessions · ${mem(all.reduce((s, r) => s + r.rssKB, 0))}</span>${off.length ? `<span class="warn" title="${esc(off.map((m) => m.label + ": " + (m.error ?? "")).join("\n"))}">${off.length} offline</span>` : ""}<span class="spacer"></span><button class="link" data-lf="closed">${S.view === "closed" ? "Sessions" : `Closed ${S.graveyard.length}`}</button><button class="link" data-lf="menu">Settings</button>`);
}
function renderClosed() {
  const box = $("rows");
  box.dataset.view = "closed";
  lastOrder = "";
  const q = S.q.toLowerCase();
  const list = S.graveyard.filter((g) => (S.machine === "all" || g.machine === S.machine) && (!q || [g.title, g.project, g.cwd].join(" ").toLowerCase().includes(q)));
  setHTML(box, `<div class="sec"><button class="sec-h" data-lf="inbox">${ICON.back}Back to sessions</button></div>` +
    (list.length ? list.map((g) => `<div class="row" data-grave="${esc(g.id)}"><span class="dot" style="--c:var(--empty)"></span><span class="title">${esc(g.title || "(untitled)")}</span><span class="ago">${ago(g.closedAt)}</span>
      <span class="meta"><span class="proj" style="--pc:${pc(g.project)}">${esc(g.project)}</span>${multiMachine() ? `<span class="mach">${esc(machineLabel(g.machine))}</span>` : ""}<span class="snip">closed ${esc(abs(g.closedAt))}</span></span>
      <span class="meta" style="margin-top:6px;gap:4px">${g.resume ? `<button class="btn" data-gact="reopen">Reopen</button><button class="btn ghost" data-gact="copy">Copy resume</button>` : `<button class="btn" data-gact="reopen">New tab here</button>`}<button class="btn ghost" data-gact="forget">Remove</button></span></div>`).join("")
      : `<div class="empty-state">Sessions you close are kept here so you can reopen them.</div>`));
  $("selbar").hidden = true;
  setHTML($("mini"), "");
}
function setHTML(el, html) { if (el._h !== html) { el.innerHTML = html; el._h = html; } }
setInterval(() => { for (const el of document.querySelectorAll("[data-t]")) { const t = Number(el.dataset.t); if (t) el.textContent = el.dataset.fmt === "long" ? agoText(t) : ago(t); } }, 20000);

// ── detail ───────────────────────────────────────────────────────────────
let detailSig = "", detailTimer = null, briefTimer = null;
function select(key, opts = {}) {
  if (!key || !S.rows.has(key)) return;
  const changed = S.sel !== key;
  S.sel = key;
  store("sel", key);
  if (changed) { termText = ""; $("screen").innerHTML = ""; detailSig = ""; $("detail").scrollTop = 0; $("replyText").value = ""; }
  render();
  loadDetail(key);
  pollTerm(true);
  if (opts.scroll) requestAnimationFrame(() => rowCache.get(key)?.el.scrollIntoView({ block: "nearest" }));
  if (opts.open && isPhone()) setMView("detail", true);
}
async function loadDetail(key) {
  try {
    const data = await api("/api/detail", { key });
    S.details.set(key, { data, stamp: S.rows.get(key)?.lastActiveAt });
    if (S.sel === key) { detailSig = ""; renderDetail(); maybeAutoBrief(key); }
  } catch {}
}
function maybeAutoBrief(key) {
  clearTimeout(briefTimer);
  const d = S.details.get(key)?.data;
  if (!S.autoBrief || !d || d.brief || !d.turns?.length || (d.asks ?? 0) < 2 || briefBusy.has(key)) return;
  // Only for sessions you stay on: skimming with j/k shouldn't spin up the model.
  briefTimer = setTimeout(() => { if (S.sel === key) writeBrief(key, true); }, 1400);
}
function renderDetail() {
  const r = S.rows.get(S.sel);
  const d = S.details.get(S.sel)?.data;
  const sig = JSON.stringify([r, d, S.tab, S.oldestFirst, briefBusy.has(S.sel), S.summary.machines?.length]);
  if (sig === detailSig) return;
  detailSig = sig;
  const box = $("detail");
  if (!r) {
    const n = [...S.rows.values()].filter((x) => x.status === "blocked" || x.status === "done").length;
    box.innerHTML = `<div class="d-empty"><div><h2>${n ? `${n} ${n === 1 ? "session needs" : "sessions need"} you` : "All quiet"}</h2><p>Pick a session, or press <kbd>⌘K</kbd> to find anything.</p><p><button class="btn primary" data-dact="new">New session</button></p></div></div>`;
    $("tTitle").textContent = "Terminal";
    return;
  }
  const cached = S.details.get(S.sel);
  if (cached && cached.stamp !== r.lastActiveAt) { clearTimeout(detailTimer); detailTimer = setTimeout(() => loadDetail(r.key), 800); }
  $("tTitle").textContent = r.title || r.agent;
  $("replyText").placeholder = r.agent === "shell" ? "Run a command" : `Reply to ${r.title || r.agent}`;
  $("mTitle").innerHTML = `<span class="dot" style="--c:${statusVar(r.status)}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(r.title || r.agent)}</span>`;
  box.style.setProperty("--pc", pc(r.project));
  const scroll = box.scrollTop;
  box.innerHTML = detailHTML(r, d);
  box.scrollTop = scroll;
}
function detailHTML(r, d) {
  const created = d?.startedAt ?? r.createdAt;
  const where = [
    `<span class="proj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>`,
    r.branch ? `<span>${esc(r.branch)}${r.dirty ? ` · ${r.dirty} uncommitted` : ""}</span>` : "",
    multiMachine() ? `<span>${esc(machineLabel(r.machine))}</span>` : "",
    `<span>tab ${esc(r.tab || r.tabNumber)}</span>`,
    r.duplicate ? `<span class="warn">another pane has this conversation</span>` : "",
  ].join("");
  const meta = [
    `<span class="pill" style="--c:${statusVar(r.status)}">${STATUS_NAME[r.status] ?? esc(r.status)}</span>`,
    `<span>${esc(r.agent)}${r.model ? ` · ${esc(r.model.replace(/^claude-/, ""))}` : ""}</span>`,
    created ? `<span>started <b>${esc(DF.format(new Date(created)))}</b></span>` : "",
    r.lastActiveAt ? `<span>active <b data-t="${r.lastActiveAt}" data-fmt="long">${agoText(r.lastActiveAt)}</b></span>` : "",
    d?.asks ? `<span><b>${d.asks}</b> ${d.asks === 1 ? "request" : "requests"}</span>` : "",
    r.ctxTokens != null ? `<span><b>${tok(r.ctxTokens)}</b> context</span>` : "",
  ].filter(Boolean).join("");
  const tab = S.tab === "images" && !d?.imagesTotal ? "story" : S.tab;
  const tabs = [["story", "Story"], ["history", "History", d?.asks], ["images", "Images", d?.imagesTotal], ["details", "Details"]]
    .filter(([k, , n]) => k !== "images" || n)
    .map(([k, label, n]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${n ? ` <span class="n">${n}</span>` : ""}</button>`).join("");
  return `<div class="d-wrap"><header>
    <div class="d-where">${where}</div>
    <h1 class="d-title">${esc(r.title || "(untitled)")}</h1>
    <div class="d-meta">${meta}</div>
    <div class="d-acts">
      <button class="btn primary" data-dact="reply" title="Reply (r)">${ICON.reply}Reply</button>
      <button class="btn" data-dact="recipes" title="Recipes (.)">${ICON.star}Recipes</button>
      <button class="btn" data-dact="focus" title="Switch herdr to this pane (f)">${ICON.jump}Jump</button>
      <button class="ib" data-dact="more" aria-label="More actions" title="More">${ICON.more}</button>
    </div></header>
    <nav class="tabsbar" role="tablist">${tabs}</nav>
    ${!d ? `<p class="hint">Reading the conversation…</p>` : tab === "history" ? historyHTML(d) : tab === "images" ? imagesHTML(r, d) : tab === "details" ? factsHTML(r, d) : storyHTML(r, d)}
  </div>`;
}
function storyHTML(r, d) {
  const out = [];
  const busy = briefBusy.has(r.key);
  if (d.turns?.length) {
    const b = d.brief;
    if (b) out.push(`<div class="brief"><p class="about">${esc(b.about)}</p><div class="cols"><div><h4>How it started</h4><p>${esc(b.started)}</p></div><div><h4>Where it stands</h4><p>${esc(b.now)}</p></div></div>
      <div class="foot">Brief by ${esc(b.model)}, ${agoText(b.at)}${d.briefStale ? " · the session has moved on since" : ""}<button class="link" data-dact="brief" ${busy ? "disabled" : ""}>${busy ? "Writing…" : "Rewrite"}</button></div></div>`);
    else out.push(`<div class="brief pending"><p class="about">${busy ? "Writing a short brief…" : "No brief yet."}</p><div class="foot">${busy ? "A local model is reading the conversation; nothing leaves your machines." : `<button class="btn" data-dact="brief">Write brief</button><span>Runs locally with Ollama.</span>`}</div></div>`);
  }
  const last = d.turns?.[d.turns.length - 1];
  const recap = d.recap ?? (last?.reply ? { text: last.reply, at: last.at, source: "Latest reply" } : null);
  if (recap) out.push(`<div class="blk"><h4>${esc(recap.source)} <button class="link" data-dact="expand" data-target="recapText">Show all</button></h4><p class="prose clamp" id="recapText">${md(recap.text)}</p>${recap.at ? `<div class="when">${esc(abs(recap.at))}</div>` : ""}</div>`);
  if (d.started) out.push(`<div class="blk"><h4>Your first message <button class="link" data-dact="expand" data-target="startedText">Show all</button></h4><p class="prose clamp" id="startedText">${esc(d.started)}</p><div class="when">${esc(abs(d.startedAt))}</div></div>`);
  if (!out.length) out.push(`<p class="hint">${r.empty ? "Nothing has happened in this pane yet." : "No conversation found for this pane. The terminal below shows what it’s doing."}</p>`);
  return out.join("");
}
function historyHTML(d) {
  if (!d.turns?.length) return `<p class="hint">No requests yet.</p>`;
  const turns = S.oldestFirst ? d.turns : [...d.turns].reverse();
  return `<p class="hint" style="margin:0 0 8px">${d.asks} ${d.asks === 1 ? "request" : "requests"}${d.compactions ? ` · compacted ${d.compactions}×` : ""}${d.workMs ? ` · ${dur(d.workMs)} of agent work` : ""}${d.turnsOmitted ? ` · latest ${d.turns.length} shown` : ""} · <button class="link" data-dact="order">${S.oldestFirst ? "Newest first" : "Oldest first"}</button></p>
    <ol class="history">${turns.map((t) => `<li><div class="t">${t.at ? esc(DF.format(new Date(t.at))) : ""}</div><div class="ask clamp" data-toggle>${esc(t.ask)}${t.images?.length ? ` <span class="hint">· ${t.images.length} ${t.images.length === 1 ? "image" : "images"}</span>` : ""}</div>${t.reply ? `<div class="rep clamp" data-toggle>${md(t.reply)}</div>` : ""}</li>`).join("")}</ol>`;
}
function imagesHTML(r, d) {
  const imgs = [...(d.images ?? [])].reverse();
  S.gallery = imgs;
  return `<p class="hint" style="margin:0 0 10px">${d.imagesTotal} ${d.imagesTotal === 1 ? "image" : "images"}${d.imagesTotal > imgs.length ? `, newest ${imgs.length} shown` : ""}: screenshots you pasted and images the agent looked at.</p>
    <div class="gallery">${imgs.map((im, i) => `<button data-img="${i}"><img loading="lazy" decoding="async" alt="" src="${imgUrl(r.key, im.id)}" onerror="this.parentElement.hidden=true"><span>${im.source === "pasted" ? "you" : "agent"}${im.at ? " · " + esc(DF.format(new Date(im.at))) : ""}</span></button>`).join("")}</div>`;
}
function factsHTML(r, d) {
  const f = [];
  const fact = (k, v, mono) => v != null && v !== "" && f.push(`<dt>${k}</dt><dd${mono ? ' class="mono"' : ""}>${v}</dd>`);
  fact("Folder", esc(r.cwd), true);
  fact("Command", esc(r.command), true);
  fact("Resume with", esc(r.resume), true);
  fact("Model", esc(r.model));
  fact("Context", r.ctxTokens != null ? `${tok(r.ctxTokens)} tokens${r.ctxWindow ? ` of ${tok(r.ctxWindow)}` : ""}` : "");
  fact("Agent work", d?.workMs ? dur(d.workMs) : "");
  fact("Spend", r.cost ? `$${r.cost.toFixed(2)}` : "");
  fact("Memory", `${mem(r.rssKB)} across ${r.procs} processes · CPU ${r.cpu}%`);
  fact("Process started", r.startedAt ? esc(abs(r.startedAt)) : "");
  fact("Where", `${esc(machineLabel(r.machine))} · herdr ${esc(r.herdr)} · ${esc(r.workspace)} · ${esc(r.paneId)}`);
  if (r.approx) fact("Note", "Matched to its OpenCode session by folder, so its dates may belong to a neighbour.");
  return `<dl class="facts">${f.join("")}</dl>`;
}
const imgUrl = (key, id) => `/api/image?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}&t=${encodeURIComponent(S.token)}`;

const briefBusy = new Set();
async function writeBrief(key = S.sel, auto = false) {
  if (!key || briefBusy.has(key)) return;
  briefBusy.add(key);
  detailSig = ""; renderDetail();
  try {
    const { brief } = await api("/api/brief", { key });
    const c = S.details.get(key);
    if (c) c.data = { ...c.data, brief, briefStale: false };
  } catch (e) { if (!auto) toast("Brief failed: " + e.message, true); }
  briefBusy.delete(key);
  detailSig = ""; renderDetail();
}

// ── terminal & reply ─────────────────────────────────────────────────────
let termTimer = null, termText = "", typing = false;
async function pollTerm(first) {
  clearTimeout(termTimer);
  const key = S.sel;
  if (!key || !S.rows.has(key)) return;
  const r = S.rows.get(key);
  const visible = isPhone() ? app.dataset.mview === "term" : !app.classList.contains("term-off");
  if (!document.hidden && visible) {
    try {
      const res = await api("/api/read", { key, lines: 400 });
      if (S.sel !== key) return;
      if (res.text !== termText) {
        termText = res.text;
        const el = $("screen");
        const atBottom = first === true || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        let text = res.text.replace(/\s+$/, "");
        if (isPhone()) { const cols = Math.max(20, Math.floor((el.clientWidth - 24) / 6.9)); text = text.replace(/[─━═▀▄_]{24,}/g, (m) => m.slice(0, cols)); }
        el.innerHTML = ansi(text);
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
    } catch {}
  }
  fitTerm();
  termTimer = setTimeout(pollTerm, typing ? 150 : r.status === "working" ? 500 : 1400);
}
function fitTerm() {
  const r = S.rows.get(S.sel);
  const el = $("screen");
  if (isPhone()) { el.style.fontSize = ""; return; }
  let size = 12.5;
  if (S.fit && r?.cols) size = Math.max(8, Math.min(13.5, (el.clientWidth - 26) / (r.cols * 0.6)));
  const v = size.toFixed(2) + "px";
  if (el.style.fontSize !== v) el.style.fontSize = v;
}
const KEYMAP = { Enter: "enter", Escape: "esc", Backspace: "backspace", Tab: "tab", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
let typeOps = [], typeTimer = null;
function queueType(op) {
  const last = typeOps[typeOps.length - 1];
  if (op.text && last?.text !== undefined) last.text += op.text; else typeOps.push(op);
  if (!typeTimer) typeTimer = setTimeout(flushType, 25);
}
async function flushType() {
  typeTimer = null;
  const ops = typeOps; typeOps = [];
  if (!ops.length || !S.sel) return;
  try { await api("/api/type", { key: S.sel, ops }); } catch (e) { toast("Typing failed: " + e.message, true); }
  setTimeout(pollTerm, 40);
}
$("screen").addEventListener("focus", () => { if (isPhone()) return; typing = true; $("term").classList.add("typing"); $("tMode").textContent = "· typing into the pane, Ctrl+] to stop"; pollTerm(); });
$("screen").addEventListener("blur", () => { typing = false; $("term").classList.remove("typing"); $("tMode").textContent = "· click the output to type into it"; });
$("screen").addEventListener("keydown", (e) => {
  if (e.metaKey || isPhone()) return;
  if (e.ctrlKey && e.key === "]") { e.preventDefault(); $("screen").blur(); return; }
  let op = null;
  if (KEYMAP[e.key]) op = { keys: [(e.shiftKey && e.key === "Tab" ? "shift+" : "") + KEYMAP[e.key]] };
  else if (/^F\d{1,2}$/.test(e.key)) op = { keys: [e.key.toLowerCase()] };
  else if (e.ctrlKey && e.key.length === 1) op = { keys: ["ctrl+" + e.key.toLowerCase()] };
  else if (e.altKey && e.code?.startsWith("Key")) op = { keys: ["alt+" + e.code.slice(3).toLowerCase()] };
  else if (e.key.length === 1) op = { text: e.key };
  if (!op) return;
  e.preventDefault();
  queueType(op);
});
$("screen").addEventListener("paste", (e) => { if (isPhone()) return; const t = e.clipboardData?.getData("text/plain"); if (t) { e.preventDefault(); queueType({ text: t }); } });
$("keys").innerHTML = ["esc", "enter", "ctrl+c", "up", "down", "tab", "1", "2", "3", "y", "n"].map((k) => `<button data-key="${k}" title="Send ${k}">${k}</button>`).join("");
$("keys").addEventListener("click", (e) => {
  const k = e.target.closest("[data-key]")?.dataset.key;
  if (k && S.sel) api("/api/keys", { key: S.sel, keys: [k] }).then(() => setTimeout(pollTerm, 60)).catch((x) => toast(x.message, true));
});
$("keysBtn").onclick = () => { const on = $("keys").hidden; $("keys").hidden = !on; $("keysBtn").setAttribute("aria-expanded", on); };
$("reply").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("replyText").value.trim();
  if (!text || !S.sel) return;
  try {
    await api("/api/send", { key: S.sel, text });
    $("replyText").value = ""; $("replyText").style.height = "";
    toast("Sent");
    setTimeout(pollTerm, 150);
  } catch (x) { toast("Send failed: " + x.message, true); }
});
$("replyText").addEventListener("input", (e) => { e.target.style.height = ""; e.target.style.height = Math.min(e.target.scrollHeight, innerHeight * 0.3) + "px"; });
$("replyText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("reply").requestSubmit(); }
  if (e.key === "Escape") e.target.blur();
});
$("replyRecipe").onclick = (e) => openRecipeMenu(e.currentTarget);
function focusReply() {
  if (isPhone()) { history.replaceState({ mview: "term" }, ""); setMView("term", false); }
  else if (app.classList.contains("term-off")) { app.classList.remove("term-off"); store("termOff", false); pollTerm(); }
  $("replyText").focus();
}

const PAL16 = ["#1c1f24", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#c8ccd4", "#5c6370", "#ff7b86", "#b5e890", "#ffd580", "#82c4ff", "#dd9cf0", "#7bd6e0", "#ffffff"];
function c256(n) {
  if (n < 16) return PAL16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const s = [0, 95, 135, 175, 215, 255];
  return `rgb(${s[Math.floor(n / 36)]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`;
}
function ansi(text) {
  let out = "", st = {}, open = false, last = 0, m;
  const re = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;
  const style = () => {
    const css = [];
    let fg = st.fg, bg = st.bg;
    if (st.inv) [fg, bg] = [bg ?? "var(--term-bg)", fg ?? "var(--term-ink)"];
    if (fg) css.push("color:" + fg);
    if (bg) css.push("background:" + bg);
    if (st.b) css.push("font-weight:600");
    if (st.d) css.push("opacity:.6");
    if (st.i) css.push("font-style:italic");
    if (st.u) css.push("text-decoration:underline");
    return css.join(";");
  };
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    const p = (m[1] || "0").split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) st = {};
      else if (c === 1) st.b = 1; else if (c === 2) st.d = 1; else if (c === 3) st.i = 1; else if (c === 4) st.u = 1; else if (c === 7) st.inv = 1;
      else if (c === 22) { st.b = 0; st.d = 0; } else if (c === 23) st.i = 0; else if (c === 24) st.u = 0; else if (c === 27) st.inv = 0;
      else if (c >= 30 && c <= 37) st.fg = PAL16[c - 30]; else if (c >= 90 && c <= 97) st.fg = PAL16[c - 82];
      else if (c >= 40 && c <= 47) st.bg = PAL16[c - 40]; else if (c >= 100 && c <= 107) st.bg = PAL16[c - 92];
      else if (c === 39) st.fg = null; else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && p[i + 1] === 5) { st[c === 38 ? "fg" : "bg"] = c256(p[i + 2]); i += 2; }
      else if ((c === 38 || c === 48) && p[i + 1] === 2) { st[c === 38 ? "fg" : "bg"] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
    }
    if (open) out += "</span>";
    const css = style();
    open = !!css;
    if (css) out += `<span style="${css}">`;
  }
  out += esc(text.slice(last));
  if (open) out += "</span>";
  return out;
}

// ── actions ──────────────────────────────────────────────────────────────
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-deck-token": S.token }, body: JSON.stringify(body) });
  if (res.status === 403) { reconnectSoon(200); throw new Error("Reconnecting to the deck…"); } // server restarted: fetch a fresh token
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
let toastTimer;
function toast(msg, err) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.setAttribute("role", "status"); document.body.append(t); }
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), err ? 7000 : 2600);
}
async function copy(text, what) { try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`); } catch { toast("The browser blocked clipboard access", true); } }
const targets = () => (S.picked.size ? [...S.picked] : S.sel ? [S.sel] : []);

function askClose(keys) {
  const rows = keys.map((k) => S.rows.get(k)).filter(Boolean);
  if (!rows.length) return toast("Nothing to close");
  const d = $("confirm");
  const busy = rows.filter((r) => r.status === "working" || r.status === "blocked");
  const dirty = rows.filter((r) => r.dirty);
  const noResume = rows.filter((r) => !r.resume && !r.empty);
  $("cTitle").textContent = rows.length === 1 ? `Close “${rows[0].title || rows[0].agent}”?` : `Close ${rows.length} sessions?`;
  $("cWarn").innerHTML = [
    busy.length ? `<span class="warn">${busy.length === 1 && rows.length === 1 ? "It is" : busy.length + " are"} working or waiting for you right now.</span>` : "",
    dirty.length ? `<span class="warn">${dirty.length === 1 && rows.length === 1 ? "Its folder has" : dirty.length + " have folders with"} uncommitted changes (they stay on disk).</span>` : "",
  ].filter(Boolean).join(" ");
  $("cList").innerHTML = rows.map((r) => `<div><span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.title || r.agent)}</span><span class="m">${esc(r.project)}${multiMachine() ? " · " + esc(machineLabel(r.machine)) : ""} · ${r.lastActiveAt ? agoText(r.lastActiveAt) : "no activity"} · ${mem(r.rssKB)}</span></div>`).join("");
  $("cNote").innerHTML = `Frees about <b>${mem(rows.reduce((s, r) => s + r.rssKB, 0))}</b>. ` + (noResume.length ? `<span class="warn">${noResume.length} can’t be resumed.</span> ` : "") + `Closed agent sessions can be reopened from Closed.`;
  $("cWholeWrap").hidden = !rows.some((r) => r.tabPanes > 1);
  $("cWhole").checked = false;
  $("cOk").textContent = rows.length === 1 ? "Close" : `Close ${rows.length}`;
  d.returnValue = "";
  d.onclose = async () => {
    if (d.returnValue !== "ok") return;
    try {
      const { results } = await api("/api/close", { keys: rows.map((r) => r.key), wholeTab: $("cWhole").checked });
      const failed = results.filter((x) => !x.ok);
      for (const x of results) if (x.ok) S.picked.delete(x.key);
      toast(failed.length ? `Closed ${results.length - failed.length}; ${failed.length} failed: ${failed[0].error}` : `Closed ${results.length}`, !!failed.length);
      render();
    } catch (e) { toast("Close failed: " + e.message, true); }
  };
  d.showModal();
  $("cOk").focus();
}
async function focusPane(key) { try { await api("/api/focus", { key, raise: true }); toast("Switched herdr to this pane"); } catch (e) { toast("Couldn’t switch: " + e.message, true); } }
function togglePick(key) { S.picked.has(key) ? S.picked.delete(key) : S.picked.add(key); render(); }
function moveSel(d) {
  const rows = S.visible ?? [];
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.key === S.sel);
  i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + d));
  select(rows[i].key, { scroll: true });
}

// Recipes: send to the current session, or to everything selected.
async function sendRecipe(recipe, keys = targets()) {
  const rows = keys.map((k) => S.rows.get(k)).filter((r) => r && r.agent !== "shell" && (!recipe.agents || recipe.agents.includes(r.agent)));
  if (!rows.length) return toast("No agent session to send that to", true);
  if (rows.length > 1 && !confirm(`Send “${recipe.label}” to ${rows.length} sessions?`)) return;
  try {
    const { results } = await api("/api/recipe", { keys: rows.map((r) => r.key), prompt: recipe.prompt });
    const bad = results.filter((x) => !x.ok);
    toast(bad.length ? `Sent to ${results.length - bad.length}; ${bad.length} failed: ${bad[0].error}` : rows.length === 1 ? `Sent “${recipe.label}”` : `Sent “${recipe.label}” to ${rows.length} sessions`, !!bad.length);
    setTimeout(pollTerm, 200);
  } catch (e) { toast(e.message, true); }
}
function openRecipeMenu(anchor) {
  const n = targets().length;
  if (!n) return toast("Pick a session first");
  const items = S.recipes.map((r) => ({ html: `${esc(r.label)}${r.hint ? `<small>${esc(r.hint)}</small>` : ""}`, run: () => sendRecipe(r) }));
  items.push("-", { html: "Edit recipes…", run: openRecipesEditor });
  openMenu(anchor, items, n > 1 ? `Send to ${n} selected sessions` : "Send to this session");
}
function openRecipesEditor() {
  const list = $("recList");
  const row = (r = {}) => `<div class="r"><input placeholder="Name" value="${esc(r.label ?? "")}" data-f="label"><button type="button" class="btn ghost" data-del>Remove</button><textarea placeholder="Prompt" data-f="prompt">${esc(r.prompt ?? "")}</textarea><input placeholder="One-line hint (optional)" value="${esc(r.hint ?? "")}" data-f="hint" style="grid-column:1/-1"><input type="hidden" value="${esc(r.id ?? "")}" data-f="id"><input type="hidden" value="${esc((r.agents ?? []).join(","))}" data-f="agents"></div>`;
  list.innerHTML = S.recipes.map(row).join("");
  $("recAdd").onclick = () => { list.insertAdjacentHTML("beforeend", row()); list.lastElementChild.querySelector("input").focus(); };
  list.onclick = (e) => { if (e.target.closest("[data-del]")) e.target.closest(".r").remove(); };
  const d = $("recipesDlg");
  d.returnValue = "";
  d.onclose = async () => {
    if (d.returnValue !== "ok") return;
    const recipes = [...list.querySelectorAll(".r")].map((el) => {
      const v = (f) => el.querySelector(`[data-f="${f}"]`).value.trim();
      return { id: v("id") || undefined, label: v("label"), prompt: v("prompt"), hint: v("hint") || undefined, agents: v("agents") ? v("agents").split(",") : undefined };
    });
    try { S.recipes = (await api("/api/recipes", { recipes })).recipes; toast("Recipes saved"); } catch (e) { toast(e.message, true); }
  };
  d.showModal();
}

// Small anchored menus.
let menuEl = null;
function openMenu(anchor, items, heading) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "menu";
  menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = (heading ? `<div class="mh">${esc(heading)}</div>` : "") + items.map((it, i) => it === "-" ? "<hr>" : `<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}">${it.html}</button>`).join("");
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const h = menuEl.offsetHeight, w = menuEl.offsetWidth;
  menuEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
  menuEl.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  menuEl.onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b) return; const it = items[Number(b.dataset.i)]; closeMenu(); it.run(); };
  menuEl.querySelector("button")?.focus();
  menuEl.addEventListener("keydown", (e) => {
    const bs = [...menuEl.querySelectorAll("button")];
    const i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    if (e.key === "Escape") { closeMenu(); anchor.focus?.(); }
  });
}
function closeMenu() { menuEl?.remove(); menuEl = null; }
addEventListener("pointerdown", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
function moreMenu(anchor) {
  const r = S.rows.get(S.sel);
  if (!r) return;
  openMenu(anchor, [
    r.resume && { html: "Copy resume command", run: () => copy(r.resume, "resume command") },
    { html: "Copy folder path", run: () => copy(r.cwd, "path") },
    { html: "Rename tab…", run: () => { const label = prompt("New tab name", r.tab || r.title); if (label != null) api("/api/rename", { key: r.key, label }).then(() => toast("Renamed")).catch((x) => toast(x.message, true)); } },
    { html: briefBusy.has(r.key) ? "Writing brief…" : "Rewrite brief", run: () => writeBrief(r.key) },
    !isPhone() && { html: "Type into the terminal", run: () => { app.classList.remove("term-off"); $("screen").focus(); } },
    "-",
    { html: "Close session…", danger: true, run: () => askClose([r.key]) },
  ].filter(Boolean));
}
function settingsMenu(anchor) {
  openMenu(anchor, [
    { html: `Theme: ${document.documentElement.dataset.theme || "system"}<small>Switch light / dark</small>`, run: toggleTheme },
    { html: `Alerts: ${S.notify ? "on" : "off"}<small>When an agent finishes or needs input</small>`, run: toggleAlerts },
    { html: `Auto briefs: ${S.autoBrief ? "on" : "off"}<small>Write a brief when you open a session</small>`, run: () => { S.autoBrief = !S.autoBrief; store("autoBrief", S.autoBrief); toast(`Auto briefs ${S.autoBrief ? "on" : "off"}`); } },
    { html: "Close candidates<small>Select empty, duplicate and week-old sessions</small>", run: suggestClose },
    { html: "Edit recipes…", run: openRecipesEditor },
    !isPhone() && { html: "Keyboard shortcuts", run: () => $("help").showModal() },
  ].filter(Boolean));
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = cur === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  store("theme", next);
}
async function toggleAlerts() {
  if (!("Notification" in window)) return toast("This browser can’t show notifications", true);
  if (!S.notify && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return toast("Notifications are blocked for this page", true);
  S.notify = !S.notify; store("notify", S.notify); toast(`Alerts ${S.notify ? "on" : "off"}`);
}
function suggestClose() {
  const WEEK = 7 * 86400000;
  const old = (r) => r.lastActiveAt && Date.now() - r.lastActiveAt > WEEK;
  const c = [...S.rows.values()].filter(inScope).filter((r) => (r.empty || r.duplicate || old(r)) && r.status !== "working" && r.status !== "blocked");
  const seen = new Set(), pick = [];
  for (const r of c.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))) {
    const id = r.duplicate && `${r.machine}:${r.agent}:${r.sessionId}`;
    if (id && !seen.has(id) && !old(r) && !r.empty) { seen.add(id); continue; } // keep the newest copy
    pick.push(r.key);
  }
  S.picked = new Set(pick);
  S.closedSecs = { ...S.closedSecs, stale: false, empty: false };
  lastOrder = "";
  toast(pick.length ? `Selected ${pick.length}. Review them, then Close.` : "Nothing looks safe to close");
  render();
}
async function standup() {
  const rows = [...S.rows.values()].filter(inScope).filter((r) => ["claude", "codex", "opencode"].includes(r.agent) && (r.status === "idle" || r.status === "done") && !r.empty && !r.stale);
  if (!rows.length) return toast("No idle agents to ask");
  const rc = S.recipes.find((x) => x.id === "status") ?? { label: "Status", prompt: "In one line: what are you working on, and what's left?" };
  await sendRecipe(rc, rows.map((r) => r.key));
}

// ── command palette ──────────────────────────────────────────────────────
let palItems = [], palIndex = 0;
function openPalette(initial = "") {
  const d = $("palette");
  $("palQ").value = initial;
  if (!d.open) d.showModal();
  renderPalette();
  $("palQ").focus();
}
function fuzzy(text, q) {
  if (!q) return 1;
  const t = text.toLowerCase();
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = t.indexOf(w);
    if (i < 0) return 0;
    score += i === 0 || t[i - 1] === " " ? 3 : 1;
  }
  return score;
}
function paletteItems(q) {
  const out = [];
  const cur = S.rows.get(S.sel);
  const n = targets().length;
  const sessions = [...S.rows.values()].map((r) => ({ r, s: fuzzy(`${r.title} ${r.project} ${machineLabel(r.machine)} ${r.agent} ${r.branch ?? ""}`, q) }))
    .filter((x) => x.s).sort((a, b) => b.s - a.s || (b.r.lastActiveAt ?? 0) - (a.r.lastActiveAt ?? 0)).slice(0, q ? 8 : 5);
  if (sessions.length) out.push({ head: q ? "Sessions" : "Recent sessions" }, ...sessions.map(({ r }) => ({
    html: `<span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.title || r.agent)}</span><small>${esc(r.project)}${multiMachine() ? " · " + esc(machineLabel(r.machine)) : ""} · ${esc(ago(r.lastActiveAt) || STATUS_NAME[r.status])}</small>`,
    run: () => { if (!inScope(r)) setMachine("all"); S.view = "inbox"; select(r.key, { scroll: true, open: true }); },
  })));
  if (n) {
    const recipes = S.recipes.map((rc) => ({ rc, s: fuzzy(`${rc.label} ${rc.hint ?? ""} recipe send`, q) })).filter((x) => x.s).slice(0, q ? 6 : 4);
    if (recipes.length) out.push({ head: n > 1 ? `Send to ${n} selected` : `Send to “${cur?.title ?? "session"}”` }, ...recipes.map(({ rc }) => ({ html: `<span>${esc(rc.label)}</span><small>${esc(rc.hint ?? "")}</small>`, run: () => sendRecipe(rc) })));
  }
  const cmds = [
    { t: "New session", k: "n", run: openNew },
    cur && { t: "Reply to this session", k: "r", run: focusReply },
    cur && { t: "Jump to this pane in herdr", k: "f", run: () => focusPane(cur.key) },
    cur && { t: "Write or rewrite the brief", k: "b", run: () => writeBrief(cur.key) },
    cur && { t: "Close this session…", k: "x", run: () => askClose([cur.key]) },
    n > 1 && { t: `Close ${n} selected sessions…`, run: () => askClose(targets()) },
    { t: "Standup: ask every idle agent for a status line", run: standup },
    { t: "Select close candidates", run: suggestClose },
    { t: "Close all empty sessions…", run: () => askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)) },
    { t: "Show closed sessions", k: "c", run: () => { S.view = "closed"; render(); } },
    { t: "Edit recipes", run: openRecipesEditor },
    { t: `Turn alerts ${S.notify ? "off" : "on"}`, run: toggleAlerts },
    { t: "Toggle light / dark", run: toggleTheme },
    !isPhone() && { t: "Keyboard shortcuts", k: "?", run: () => $("help").showModal() },
    ...(multiMachine() ? [["all", "all machines"], ...S.summary.machines.map((m) => [m.id, m.label])].map(([id, label]) => ({ t: `Show ${label}`, run: () => setMachine(id) })) : []),
  ].filter(Boolean).map((c) => ({ ...c, s: fuzzy(c.t, q) })).filter((c) => c.s).slice(0, q ? 8 : 6);
  if (cmds.length) out.push({ head: "Commands" }, ...cmds.map((c) => ({ html: `<span>${esc(c.t)}</span>${c.k && !isPhone() ? `<small><kbd>${esc(c.k)}</kbd></small>` : ""}`, run: c.run })));
  if (q) {
    const projects = [...new Set([...S.rows.values()].map((r) => r.project))].map((p) => ({ p, s: fuzzy(p, q) })).filter((x) => x.s).slice(0, 4);
    if (projects.length) out.push({ head: "Projects" }, ...projects.map(({ p }) => ({ html: `<span class="dot" style="--c:${pc(p)}"></span><span>Only show ${esc(p)}</span>`, run: () => { $("q").value = p; S.q = p; S.view = "inbox"; render(); } })));
  }
  return out;
}
function renderPalette() {
  palItems = paletteItems($("palQ").value.trim());
  palIndex = palItems.findIndex((x) => !x.head);
  $("palList").innerHTML = palItems.map((it, idx) => it.head ? `<div class="mh">${esc(it.head)}</div>` : `<button role="option" data-p="${idx}" class="${idx === palIndex ? "on" : ""}">${it.html}</button>`).join("") || `<div class="empty-state">Nothing found</div>`;
}
function palMove(d) {
  const idxs = palItems.map((x, i) => (x.head ? -1 : i)).filter((i) => i >= 0);
  if (!idxs.length) return;
  palIndex = idxs[(idxs.indexOf(palIndex) + d + idxs.length) % idxs.length];
  for (const b of $("palList").querySelectorAll("[data-p]")) b.classList.toggle("on", Number(b.dataset.p) === palIndex);
  $("palList").querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function palRun(i = palIndex) { const it = palItems[i]; if (!it || it.head) return; $("palette").close(); it.run(); }
$("palQ").addEventListener("input", renderPalette);
$("palQ").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
  else if (e.key === "Enter") { e.preventDefault(); palRun(); }
});
$("palList").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) palRun(Number(b.dataset.p)); });
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) $("palette").close(); });

// ── new session ──────────────────────────────────────────────────────────
const KINDS = [["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["shell", "Shell"]];
let newOpts = null, newKind = load("newKind", "claude"), newMachine = null, pendingSelect = null;
async function loadNewOptions() {
  try { newOpts = await api("/api/new-options", { machine: newMachine }); } catch (e) { newOpts = { recent: [], projects: [], argHints: {} }; toast(e.message, true); }
  const cur = S.rows.get(S.sel);
  const saved = load("newCwd:" + newMachine, "");
  $("nCwd").value = saved || (cur && cur.machine === newMachine ? home(cur.cwd) : "") || home(newOpts.recent[0] ?? "");
  $("nCwdList").innerHTML = [...new Set([...newOpts.recent, ...newOpts.projects])].map((p) => `<option value="${esc(home(p))}">`).join("");
  $("nCwdSugg").innerHTML = newOpts.recent.length ? `<span class="hint">Recent:</span>` + newOpts.recent.slice(0, 6).map((p) => `<button type="button" data-cwd="${esc(home(p))}" title="${esc(p)}">${esc(p.split("/").pop())}</button>`).join("") : "";
  renderKinds();
}
async function openNew() {
  const cur = S.rows.get(S.sel);
  newMachine = (S.machine !== "all" ? S.machine : cur?.machine) ?? S.self;
  const ms = S.summary.machines ?? [];
  $("nMachineWrap").hidden = ms.length <= 1;
  $("nMachine").innerHTML = ms.map((m) => `<button type="button" data-m="${esc(m.id)}" aria-pressed="${m.id === newMachine}" ${m.online ? "" : "disabled"}>${esc(m.label)}</button>`).join("");
  $("nPrompt").value = ""; $("nLabel").value = "";
  $("nFocus").checked = load("newFocus", false);
  $("newDlg").showModal();
  await loadNewOptions();
  if (!isPhone()) (newKind === "shell" ? $("nCwd") : $("nPrompt")).focus();
}
function renderKinds() {
  $("nKind").innerHTML = KINDS.map(([k, label]) => `<button type="button" data-kind="${k}" aria-pressed="${newKind === k}">${label}</button>`).join("");
  $("nPromptWrap").hidden = newKind === "shell"; $("nArgsWrap").hidden = newKind === "shell";
  $("nArgs").value = load("args:" + newKind, "");
  const hints = newOpts?.argHints?.[newKind] ?? [];
  $("nArgsSugg").innerHTML = hints.length ? `<span class="hint">Your other ${esc(newKind)} sessions use:</span>` + hints.map((h) => `<button type="button" data-args="${esc(h)}">${esc(h)}</button>`).join("") : "";
}
$("nMachine").addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (!b || b.disabled) return; newMachine = b.dataset.m; for (const x of $("nMachine").children) x.setAttribute("aria-pressed", x.dataset.m === newMachine); loadNewOptions(); });
$("nKind").addEventListener("click", (e) => { const b = e.target.closest("[data-kind]"); if (b) { newKind = b.dataset.kind; store("newKind", newKind); renderKinds(); } });
$("nArgsSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-args]"); if (b) $("nArgs").value = b.dataset.args; });
$("nCwdSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-cwd]"); if (b) $("nCwd").value = b.dataset.cwd; });
$("nPrompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("nOk").click(); } });
$("newDlg").addEventListener("close", async () => {
  if ($("newDlg").returnValue !== "ok") return;
  const body = { machine: newMachine, kind: newKind, cwd: $("nCwd").value.trim(), args: $("nArgs").value.trim(), prompt: newKind === "shell" ? "" : $("nPrompt").value, label: $("nLabel").value.trim(), focus: $("nFocus").checked };
  store("newCwd:" + newMachine, body.cwd); store("args:" + newKind, body.args); store("newFocus", body.focus);
  try {
    const { key } = await api("/api/new", body);
    pendingSelect = key;
    if (S.rows.has(key)) { pendingSelect = null; select(key, { scroll: true, open: true }); }
    toast(newKind === "shell" ? "Opened a shell" : `Starting ${newKind}…`);
  } catch (e) { toast("Couldn’t start: " + e.message, true); }
});

// ── events ───────────────────────────────────────────────────────────────
function setMachine(id) { S.machine = id; store("machine", id); S.picked.clear(); lastOrder = ""; render(); }
$("machines").addEventListener("click", (e) => { const b = e.target.closest("[data-machine]"); if (b) setMachine(b.dataset.machine); });
$("rows").addEventListener("click", async (e) => {
  if (e.target.closest("[data-secact]")?.dataset.secact === "closeEmpty") { e.stopPropagation(); return askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)); }
  const sec = e.target.closest("[data-sec]");
  if (sec) { const k = sec.dataset.sec; S.closedSecs = { ...S.closedSecs, [k]: !S.closedSecs[k] }; store("closedSecs", S.closedSecs); lastOrder = ""; return render(); }
  if (e.target.closest("[data-lf]")?.dataset.lf === "inbox") { S.view = "inbox"; lastOrder = ""; return render(); }
  const grave = e.target.closest("[data-grave]");
  if (grave) {
    const g = S.graveyard.find((x) => x.id === grave.dataset.grave);
    const act = e.target.closest("[data-gact]")?.dataset.gact;
    if (!g || !act) return;
    try {
      if (act === "copy") return copy(g.resume, "resume command");
      if (act === "forget") return api("/api/forget", { id: g.id });
      if (act === "reopen") { toast(`Reopening “${g.title}”…`); await api("/api/reopen", { id: g.id }); toast(`Reopened “${g.title}”`); }
    } catch (x) { toast(x.message, true); }
    return;
  }
  const row = e.target.closest(".row[data-key]");
  if (!row) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); return togglePick(row.dataset.key); }
  select(row.dataset.key, { open: true });
});
$("mini").addEventListener("click", (e) => { const b = e.target.closest("[data-key]"); if (b) select(b.dataset.key); });
$("detail").addEventListener("click", (e) => {
  const t = e.target.closest("[data-toggle]");
  if (t) return t.classList.toggle("clamp");
  const img = e.target.closest("[data-img]");
  if (img) return openLightbox(Number(img.dataset.img));
  const tab = e.target.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; store("tab", S.tab); detailSig = ""; return renderDetail(); }
  const b = e.target.closest("[data-dact]");
  if (!b) return;
  const act = b.dataset.dact;
  if (act === "new") return openNew();
  const r = S.rows.get(S.sel);
  if (!r) return;
  if (act === "reply") focusReply();
  if (act === "recipes") openRecipeMenu(b);
  if (act === "focus") focusPane(r.key);
  if (act === "more") moreMenu(b);
  if (act === "brief") writeBrief(r.key);
  if (act === "order") { S.oldestFirst = !S.oldestFirst; store("oldestFirst", S.oldestFirst); detailSig = ""; renderDetail(); }
  if (act === "expand") { const el = $(b.dataset.target); el?.classList.toggle("clamp"); b.textContent = el?.classList.contains("clamp") ? "Show all" : "Show less"; }
});
$("lf").addEventListener("click", (e) => {
  const a = e.target.closest("[data-lf]")?.dataset.lf;
  if (a === "closed") { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); }
  if (a === "menu") settingsMenu(e.target.closest("[data-lf]"));
});
$("selRecipe").onclick = (e) => openRecipeMenu(e.currentTarget);
$("selClose").onclick = () => askClose([...S.picked]);
$("selClear").onclick = () => { S.picked.clear(); render(); };
$("q").addEventListener("input", (e) => { S.q = e.target.value; render(); });
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; S.q = ""; e.target.blur(); render(); }
  if (e.key === "Enter") { const first = S.visible?.[0]; if (first) { select(first.key, { open: true }); e.target.blur(); } }
});
$("paletteBtn").onclick = (e) => { e.preventDefault(); openPalette(); };
$("paletteMini").onclick = () => openPalette();
$("newBtn").onclick = openNew;
$("fitBtn").onclick = () => { S.fit = !S.fit; store("fit", S.fit); fitTerm(); toast(S.fit ? "Fitting the pane’s width" : "Fixed font size"); };
$("listToggle").onclick = () => { app.classList.toggle("list-off"); store("listOff", app.classList.contains("list-off")); setTimeout(fitTerm, 0); };
$("termToggle").onclick = () => { app.classList.toggle("term-off"); store("termOff", app.classList.contains("term-off")); pollTerm(); };

function openLightbox(i) {
  const g = S.gallery ?? [];
  if (!g[i]) return;
  S.lb = i;
  $("lbImg").src = imgUrl(S.sel, g[i].id);
  $("lbCap").textContent = `${i + 1} of ${g.length} · ${g[i].source === "pasted" ? "you pasted this" : "the agent looked at this"}${g[i].at ? " · " + abs(g[i].at) : ""}`;
  if (!$("lightbox").open) $("lightbox").showModal();
}
$("lbPrev").onclick = () => openLightbox(Math.max(0, S.lb - 1));
$("lbNext").onclick = () => openLightbox(Math.min((S.gallery?.length ?? 1) - 1, S.lb + 1));
$("lightbox").addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") $("lbPrev").click(); if (e.key === "ArrowRight") $("lbNext").click(); });

// Splitters: window-level listeners so fast drags over other panels never drop.
function drag(el, axis, onMove, onEnd) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.classList.add("drag");
    document.body.classList.add("dragging", axis === "x" ? "col" : "row");
    const move = (ev) => { ev.preventDefault(); onMove(ev); };
    const up = () => { el.classList.remove("drag"); document.body.classList.remove("dragging", "col", "row"); removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); onEnd(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  });
}
let lw = load("lw", 380), th = load("th", Math.round(innerHeight * 0.36));
const setLw = (v) => { lw = Math.round(Math.max(260, Math.min(innerWidth * 0.6, v))); app.style.setProperty("--lw-open", lw + "px"); };
const setTh = (v) => { th = Math.round(Math.max(90, Math.min(innerHeight - 180, v))); app.style.setProperty("--th-open", th + "px"); };
drag($("splitV"), "x", (e) => setLw(e.clientX), () => { store("lw", lw); fitTerm(); });
drag($("splitH"), "y", (e) => { setTh(innerHeight - e.clientY); if (app.classList.contains("term-off")) { app.classList.remove("term-off"); store("termOff", false); } }, () => { store("th", th); fitTerm(); });
$("splitV").ondblclick = () => { setLw(380); store("lw", lw); fitTerm(); };
$("splitH").ondblclick = () => { setTh(Math.round(innerHeight * 0.36)); store("th", th); fitTerm(); };
for (const [el, axis] of [[$("splitV"), "x"], [$("splitH"), "y"]]) {
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 60 : 20;
    if (axis === "x" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); setLw(lw + (e.key === "ArrowRight" ? step : -step)); store("lw", lw); fitTerm(); }
    if (axis === "y" && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); setTh(th + (e.key === "ArrowUp" ? step : -step)); store("th", th); fitTerm(); }
  });
}
new ResizeObserver(() => fitTerm()).observe($("screen"));

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return $("palette").open ? $("palette").close() : openPalette(); }
  if (e.target.matches("input, textarea, select, #screen") || document.querySelector("dialog[open]") || menuEl) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key, cur = S.sel && S.rows.has(S.sel) ? S.sel : null;
  if (k === "/") { e.preventDefault(); if (app.classList.contains("list-off")) $("listToggle").click(); $("q").focus(); $("q").select(); }
  else if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveSel(1); }
  else if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveSel(-1); }
  else if (k === "r" && cur) { e.preventDefault(); focusReply(); }
  else if (k === "." && (cur || S.picked.size)) { e.preventDefault(); openRecipeMenu(document.querySelector('[data-dact="recipes"]') ?? $("replyRecipe")); }
  else if (k === "t" && cur) { e.preventDefault(); app.classList.remove("term-off"); $("screen").focus(); }
  else if (k === "n") { e.preventDefault(); openNew(); }
  else if (k === "f" && cur) focusPane(cur);
  else if (k === "x" && (S.picked.size || cur)) askClose(targets());
  else if (k === "s" && cur) togglePick(cur);
  else if (k === "b" && cur) writeBrief(cur);
  else if (k === "[") $("listToggle").click();
  else if (k === "]") $("termToggle").click();
  else if (k === "c") { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); }
  else if (k === "?") $("help").showModal();
  else if (/^[1-9]$/.test(k)) { const ids = ["all", ...(S.summary.machines ?? []).map((m) => m.id)]; if (ids[k - 1] && ids.length > 2) setMachine(ids[k - 1]); }
  else if (k === "Escape") { if (S.q) { S.q = ""; $("q").value = ""; } else if (S.picked.size) S.picked.clear(); render(); }
});

// ── phone navigation: list screen ⇄ session screen (story | terminal) ─────
function setMView(v, push) {
  if (app.dataset.mview === v) return;
  const from = app.dataset.mview;
  app.dataset.mview = v;
  for (const b of document.querySelectorAll(".mbar [data-mv]")) b.setAttribute("aria-selected", b.dataset.mv === v);
  if (push && isPhone()) history.pushState({ mview: v }, "");
  if (v === "term") pollTerm(true);
  if (v === "list" && from !== "list") requestAnimationFrame(() => rowCache.get(S.sel)?.el.scrollIntoView({ block: "nearest" }));
}
addEventListener("popstate", (e) => setMView(e.state?.mview ?? "list", false));
$("mBack").onclick = () => (history.state?.mview ? history.back() : setMView("list", false));
document.querySelector(".mbar .seg2").addEventListener("click", (e) => {
  const v = e.target.closest("[data-mv]")?.dataset.mv;
  if (!v || v === app.dataset.mview) return;
  if (isPhone()) history.replaceState({ mview: v }, "");
  setMView(v, false);
});

// ── live data ────────────────────────────────────────────────────────────
function notifyTransitions(prev, next) {
  if (!S.notify || !prev || prev.status === next.status) return;
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
  S.recipes = data.recipes ?? [];
  if (S.machine !== "all" && !S.summary.machines?.some((m) => m.id === S.machine)) S.machine = "all";
  lastOrder = "";
  if (!S.sel || !S.rows.has(S.sel)) {
    S.sel = null;
    const saved = load("sel", null);
    if (saved && S.rows.has(saved)) return select(saved);
    const rows = visibleRows();
    const first = rows.find((r) => sectionOf(r) === "needs") ?? rows[0];
    if (first && !isPhone()) return select(first.key);
  }
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
    for (const r of p.upsert) { notifyTransitions(S.rows.get(r.key), r); S.rows.set(r.key, r); }
    for (const k of p.remove) { S.rows.delete(k); S.details.delete(k); }
    S.summary = p.summary;
    if (pendingSelect && S.rows.has(pendingSelect)) { const k = pendingSelect; pendingSelect = null; select(k, { scroll: true }); if (isPhone()) setMView("term", true); return; }
    if (S.sel && !S.rows.has(S.sel)) { S.sel = null; const next = S.visible?.find((r) => S.rows.has(r.key))?.key; if (next && !isPhone()) return select(next); }
    render();
  });
  es.addEventListener("graveyard", (e) => { S.graveyard = JSON.parse(e.data); render(); });
  es.addEventListener("notice", (e) => { const n = JSON.parse(e.data); toast(n.message, !n.ok); if (n.key && n.key === S.sel) loadDetail(n.key); });
  es.onopen = () => $("conn").classList.remove("off");
  es.onerror = () => {
    $("conn").classList.add("off");
    // Browsers give up for good after an HTTP error; keep trying ourselves.
    if (es.readyState === EventSource.CLOSED) reconnectSoon(2000);
  };
}
if (window.__BOOT__) applyFull(window.__BOOT__);
connect();
if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
{
  const params = new URLSearchParams(location.search);
  if (params.get("status") === "blocked") { S.q = "is:blocked"; $("q").value = S.q; render(); }
  if (params.get("new")) setTimeout(openNew, 50);
  if ([...params.keys()].length) history.replaceState(history.state, "", "/");
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollTerm(); });
