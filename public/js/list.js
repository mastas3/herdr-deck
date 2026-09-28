"use strict";
// Rendering the session list: keyed rows, a frozen order under the pointer, the collapsed rail, the footer and Closed.
let lastOrder = "", queued = false;
/** Where a project's name leads: a plugin's project page (the "project.link" point: { icon, open(name) }, filled by the
 *  projects plugin), or nowhere while none is on. */
const projectLink = () => deckPlugins.contributions("project.link")[0];
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; renderNow(); });
}
function renderNow() {
  renderMachines();
  if (S.view === "closed") renderClosed(); else renderList();
  renderLive();
  renderFooter();
  renderDetail();
  renderViews();
  const n = [...S.rows.values()].filter(needsYou).length;
  document.title = (n ? `(${n}) ` : "") + "herdr deck";
  reportPresence();
}
function renderMachines() {
  const ms = S.summary.machines ?? [];
  const count = (id) => [...S.rows.values()].filter((r) => id === "all" || r.machine === id).length;
  const html = ms.length > 1 ? [["all", "All"], ...ms.map((m) => [m.id, m.label, m])].map(([id, label, m]) =>
    `<button role="tab" data-machine="${esc(id)}" aria-selected="${S.machine === id}" title="${m && !m.online ? esc(m.kind === "app" ? "The Codex app isn’t running" : "Offline: " + (m.error ?? "")) : ""}">${esc(label)} <span class="n">${count(id)}</span>${m && !m.online ? '<span class="off"></span>' : ""}</button>`).join("") : "";
  setHTML($("machines"), html);
  for (const b of $("groupSeg").children) b.setAttribute("aria-selected", b.dataset.group === S.group);
}
function renderLive() {
  const rows = [...S.rows.values()].filter(inScope);
  const working = rows.filter((r) => r.status === "working");
  const blocked = rows.filter((r) => r.status === "blocked");
  const subs = rows.reduce((n, r) => n + (r.subagents ?? []).filter((x) => x.running).length, 0);
  const el = $("live");
  el.hidden = !working.length && !blocked.length;
  el.setAttribute("aria-pressed", S.board);
  setHTML(el, `${working.length ? '<span class="spin"></span>' : '<span class="dot" style="--c:var(--blocked)"></span>'}<span><b>${working.length}</b> working${blocked.length ? ` · <b>${blocked.length}</b> waiting` : ""}${subs ? ` · <b>${subs}</b> subagent${subs === 1 ? "" : "s"}` : ""}</span><span class="spacer"></span><span class="dim">${S.board ? "Close board" : "Live board"}</span>`);
}
function listGroups(rows) {
  if (S.group === "project") {
    const empty = rows.filter((r) => r.empty && !fresh(r));
    const by = new Map();
    for (const r of rows) if (!r.empty || fresh(r)) by.set(r.project, [...(by.get(r.project) ?? []), r]);
    const rank = (rs) => (rs.some((r) => r.status === "blocked" || r.status === "done") ? 0 : rs.some((r) => r.status === "working") ? 1 : 2);
    const latest = (rs) => Math.max(...rs.map(act));
    const groups = [...by.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || latest(b[1]) - latest(a[1]))
      .map(([p, rs]) => ({ key: "p:" + p, label: p, proj: p, rows: rs.sort((a, b) => ["blocked", "done", "working"].indexOf(b.status) - ["blocked", "done", "working"].indexOf(a.status) || act(b) - act(a)), closed: !!S.closedProj[p] }));
    if (empty.length) groups.push({ key: "empty", label: "Empty", rows: empty, closed: S.closedSecs.empty !== false });
    return groups;
  }
  // Priority: one attention-ordered list; old and empty sessions fold away at the bottom.
  const main = rows.filter((r) => rank(r) < 5), tail = rows.filter((r) => rank(r) >= 5);
  const out = [{ key: "all", label: "", rows: main, closed: false, flat: true }];
  if (tail.length) out.push({ key: "old", label: `Stale & empty`, rows: tail, closed: S.closedSecs.old !== false, tail: true });
  return out.filter((x) => x.rows.length);
}
// The order never changes under the pointer: it is frozen while the pointer is over the list, while a touch is
// in progress, and for FREEZE_MS after it leaves. Row contents keep updating; moves are applied (FLIP) on release.
const FREEZE_MS = 1200;
const listHold = { over: false, touch: false, until: 0, timer: 0 };
const orderFrozen = () => listHold.over || listHold.touch || Date.now() < listHold.until;
function releaseSoon() {
  listHold.until = Date.now() + FREEZE_MS;
  clearTimeout(listHold.timer);
  listHold.timer = setTimeout(() => { listHold.timer = 0; if (!orderFrozen()) render(); }, FREEZE_MS + 20);
}
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const EASE = getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "cubic-bezier(.2, .8, .2, 1)";
/** A row whose volatile fields changed within the last second waits; this brings the list back to it. */
let volTimer = 0, volDue = 0;
function renderLater(ms) {
  const due = Date.now() + ms;
  if (volTimer && volDue <= due) return;
  clearTimeout(volTimer); volDue = due;
  volTimer = setTimeout(() => { volTimer = 0; render(); }, ms);
}
/** Where each row is, before a reorder (read before any DOM write, so it costs no extra layout). */
function rowTops(box) {
  const out = new Map();
  for (const el of box.querySelectorAll(".row[data-key]")) { const r = el.getBoundingClientRect(); if (r.height) out.set(el.dataset.key, r.top); }
  return out;
}
/** FLIP: every on-screen row that moved starts where it was and glides to its new place (new rows slide in via CSS). */
function flipRows(box, before) {
  const b = box.getBoundingClientRect();
  const moves = [];
  for (const el of box.querySelectorAll(".row[data-key]")) {
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom < b.top || r.top > b.bottom) continue;
    const was = before.get(el.dataset.key);
    // A row coming from far away enters from the nearest edge instead of flying across the whole list.
    if (was != null && Math.abs(was - r.top) >= 1) moves.push([el, Math.max(-b.height, Math.min(b.height, was - r.top))]);
  }
  for (const [el, dy] of moves) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: EASE });
}
let lastView = "";
function renderList() {
  const box = $("rows");
  const rows = visibleRows();
  const byProject = S.group === "project";
  const groups = listGroups(rows);
  const order = S.group + groups.map((g) => g.key + ":" + (g.closed ? "x" : "") + g.rows.map((r) => r.key).join(",")).join("|");
  // Anything you changed yourself (filter, grouping, machine, a folded section) applies at once, even under the pointer.
  const view = [S.group, S.machine, S.q, S.deep?.q ?? "", JSON.stringify(S.closedSecs), JSON.stringify(S.closedProj)].join("\u0001");
  const selHidden = !!S.sel && rows.some((r) => r.key === S.sel) && !rowCache.get(S.sel)?.el.isConnected;
  const force = !lastOrder || box.dataset.view !== "list" || view !== lastView || selHidden || !rows.length || !box.querySelector(".row[data-key]");
  const apply = order !== lastOrder && (force || !orderFrozen());
  const before = apply && !force && !reduceMotion.matches ? rowTops(box) : null;
  for (const k of rowCache.keys()) if (!S.rows.has(k)) rowCache.delete(k);
  const now = Date.now();
  const deepOn = S.q && S.deep?.q === S.q;
  for (const r of rows) {
    let c = rowCache.get(r.key);
    if (!c) {
      const el = document.createElement("div");
      el.className = "row born"; el.dataset.key = r.key; el.setAttribute("role", "button");
      // Drop the flash once it has played, or re-inserting the row on a reorder would replay it.
      el.addEventListener("animationend", (e) => { if (e.animationName === "flash") el.classList.remove("flash"); });
      c = { el, sig: "", stable: "", at: 0 };
      rowCache.set(r.key, c);
    }
    const ask = pendingAsk(r);
    const why = reasonOf(r, ask?.kind, now);
    const ctx = JSON.stringify(ask ?? "") + radarChip(r) + why.k + !!S.simple + S.machine + multiMachine() + byProject + (deepOn ? JSON.stringify(S.deep.byKey.get(r.key) ?? "") + S.q : "");
    const sig = JSON.stringify(r) + ctx;
    c.el.classList.toggle("unseen", needsYou(r));
    if (c.sig !== sig) {
      const stable = stableSig(r) + ctx;
      // Only the live bits moved (tool line, todos, tail, subagents, memory): at most one repaint a second per row.
      if (c.sig && c.stable === stable && now - c.at < 1000) renderLater(1000 - (now - c.at) + 16);
      else {
        const was = c.el.dataset.status;
        c.el.innerHTML = rowHTML(r, byProject, why); c.el.dataset.status = r.status; c.sig = sig; c.stable = stable; c.at = now;
        if (was && was !== r.status && (r.status === "blocked" || r.status === "done")) { c.el.classList.remove("flash"); void c.el.offsetWidth; c.el.classList.add("flash"); }
      }
    }
    // Selected means "this is the session on the right": not while the board or a view (Inbox, History…) is showing.
    c.el.classList.toggle("sel", S.sel === r.key && !S.board && !S.mode);
    c.el.classList.toggle("picked", S.picked.has(r.key));
    c.el.classList.toggle("stale", !!r.stale && r.status !== "working" && r.status !== "blocked");
  }
  if (apply) {
    lastOrder = order; lastView = view;
    box.dataset.view = "list";
    box._h = "";
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      const sec = document.createElement("section");
      sec.className = "sec" + (g.closed ? " closed" : "") + (g.proj ? " proj" : "");
      if (g.proj) sec.style.setProperty("--pc", pc(g.proj));
      const nb = g.rows.filter((r) => r.status === "blocked" || r.status === "done").length, nw = g.rows.filter((r) => r.status === "working").length;
      const dots = g.proj ? `<span class="dots">${nb ? `<span class="dot" style="--c:var(--blocked)" title="${nb} need you"></span>` : ""}${nw ? `<span class="dot" style="--c:var(--working)" title="${nw} working"></span>` : ""}</span>` : "";
      const extra = g.key === "empty" || g.tail ? `<span class="act link" data-secact="closeEmpty" role="button">Close empty</span>`
        : g.proj && projectHome(g.proj) ? `<span class="padd" data-secact="newin" data-proj="${esc(g.proj)}" role="button" title="New session in ${esc(g.proj)}" aria-label="New session in ${esc(g.proj)}">${ICON.plus}</span>` : "";
      const jour = g.proj && projectLink() ? `<span class="padd pjour" data-secact="journey" data-proj="${esc(g.proj)}" role="button" title="${esc(g.proj)}: project page" aria-label="${esc(g.proj)} project page">${projectLink().icon}</span>` : "";
      if (g.flat) { sec.className = "sec flat"; sec.innerHTML = `<div class="sec-b"></div>`; const body = sec.lastChild; for (const r of g.rows) body.append(rowCache.get(r.key).el); frag.append(sec); continue; }
      sec.innerHTML = `<button class="sec-h" data-sec="${esc(g.key)}" aria-expanded="${!g.closed}">${ICON.chev}${g.proj ? '<span class="sw"></span>' : ""}${esc(g.label)} <span class="n">${g.rows.length}</span>${dots}${jour}${extra}</button><div class="sec-b"></div>`;
      const body = sec.lastChild;
      for (const r of g.rows) body.append(rowCache.get(r.key).el);
      frag.append(sec);
    }
    // A live reorder glides (FLIP below); only a change you made replays the sections' entrance.
    box.classList.toggle("settled", !force);
    box.replaceChildren(frag);
    if (!rows.length) box.innerHTML = `<div class="empty-state">${S.rows.size ? "Nothing matches. Press Esc to clear the filter." : noHerdr() ? "herdr isn’t running on this machine yet. Open a terminal and run <code>herdr</code>, then start your agents inside it; they’ll show up here by themselves. New to herdr? See <a href=\"https://herdr.dev\" target=\"_blank\" rel=\"noopener\">herdr.dev</a>." : "No sessions yet. Press n to start one."}</div>`;
    if (before) flipRows(box, before);
    const born = box.querySelectorAll(".row.born");
    if (born.length) requestAnimationFrame(() => requestAnimationFrame(() => { for (const el of born) el.classList.remove("born"); }));
    S.visible = groups.flatMap((g) => (g.closed ? [] : g.rows));
  } else if (order !== lastOrder) {
    // Frozen: rows that went away leave, everything else holds its place, newcomers wait for the release.
    const shown = [...box.querySelectorAll(".row[data-key]")].map((el) => el.dataset.key);
    const { keys } = frozenOrder(shown, rows.map((r) => r.key));
    const keep = new Set(keys);
    for (const k of shown) if (!keep.has(k)) { box.querySelector(`.row[data-key="${CSS.escape(k)}"]`)?.remove(); lastOrder = "~" + lastOrder; }
    const open = new Set([...box.querySelectorAll(".sec:not(.closed) .row[data-key]")].map((el) => el.dataset.key));
    S.visible = keys.filter((k) => open.has(k)).map((k) => S.rows.get(k)).filter(Boolean);
  } else S.visible = groups.flatMap((g) => (g.closed ? [] : g.rows));
  if (app.classList.contains("list-off")) renderRail(rows);
  for (const k of S.picked) if (!S.rows.has(k)) S.picked.delete(k);
  $("selbar").hidden = !S.picked.size;
  if (S.picked.size) $("selInfo").textContent = `${S.picked.size} selected`;
}
/** Project initials for the rail: "herdr-deck" → "HD", "Conductor" → "Co". */
function initials(p) {
  const parts = String(p || "?").split(/[-_.\s]+/).filter(Boolean);
  return parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : parts[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}
function shortTitle(t) {
  const w = String(t || "").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((x) => x.length > 2 && !/^(the|and|for|with|from|into)$/i.test(x));
  return w.slice(0, 2).join(" ") || t || "";
}
/** Collapsed list: a tile per session (project badge, status, a word of title, time), grouped by what needs you. */
function renderRail(rows) {
  const groups = { needs: [], running: [], quiet: [] };
  let hidden = 0;
  for (const r of rows) { const s = sectionOf(r); if (groups[s]) groups[s].push(r); else hidden++; }
  for (const g of Object.values(groups)) g.sort((a, b) => rank(a) - rank(b) || act(b) - act(a));
  const tile = (r) => {
    const subs = (r.subagents ?? []).filter((x) => x.running).length;
    const since = r.status === "working" && r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
    const tm = since ? `<span class="tm" data-since="${since}">${clock(Date.now() - since)}</span>` : r.status === "blocked" ? `<span class="tm">waiting</span>` : `<span class="tm" data-t="${r.lastActiveAt ?? ""}">${ago(r.lastActiveAt)}</span>`;
    const tip = `${r.title || r.agent}\n${r.project}${r.launch ? " (via " + r.launch + ")" : ""} · ${paneName(r)}${multiMachine() ? " · " + machineLabel(r.machine) : ""}\n${STATUS_NAME[r.status] ?? r.status}${r.now ? " · " + r.now : ""}${subs ? `\n${subs} subagent${subs === 1 ? "" : "s"} running` : ""}`;
    return `<button class="tile${S.sel === r.key && !S.board && !S.mode ? " sel" : ""}" data-key="${esc(r.key)}" data-status="${r.status}" style="--pc:${pc(r.project)};--c:${statusVar(r.status)}" title="${esc(tip)}"><span class="ab">${esc(initials(r.project))}</span>${r.status !== "idle" ? '<span class="sd"></span>' : ""}${subs ? `<span class="sb">+${subs}</span>` : ""}<span class="tt">${esc(shortTitle(r.title))}</span>${tm}</button>`;
  };
  const html = [["needs", "Needs you"], ["running", "Running"], ["quiet", "Quiet"]].filter(([k]) => groups[k].length)
    .map(([k, label]) => `<div class="mh">${label.split(" ")[0]} <span class="n">${groups[k].length}</span></div>${groups[k].map(tile).join("")}`).join("")
    + (hidden ? `<button class="more" data-railmore>+${hidden} stale or empty</button>` : "");
  setHTML($("mini"), html);
}
function renderFooter() {
  // Counted by the same rules as the list (machine tab and search), so the two never disagree.
  const all = [...S.rows.values()].filter(inScope);
  const shown = S.q ? visibleRows() : all;
  const kb = (rs) => rs.reduce((s, r) => s + (r.rssKB || 0), 0);
  const per = new Map();
  for (const r of shown) { const m = per.get(r.machine) ?? { n: 0, kb: 0 }; m.n++; m.kb += r.rssKB || 0; per.set(r.machine, m); }
  const tip = [...per].sort((a, b) => b[1].kb - a[1].kb).map(([id, m]) => `${machineLabel(id)}: ${m.n} session${m.n === 1 ? "" : "s"}${m.kb ? ` · ${mem(m.kb)}` : ""}`).join("\n")
    + "\n\nMemory is what the agents’ process trees use right now: each agent plus the builds, tests and servers it started. It rises and falls as they start and stop. The deck itself isn’t counted.";
  const count = S.q ? `<b>${shown.length}</b> of ${all.length} sessions` : `<b>${all.length}</b> session${all.length === 1 ? "" : "s"}`;
  const off = (S.summary.machines ?? []).filter((m) => !m.online);
  setHTML($("lf"), `<span class="lfn" title="${esc(tip)}">${count} · agents use ${mem(kb(shown))}</span>${off.length ? `<span class="warn" title="${esc(off.map((m) => m.label + ": " + (m.error ?? "")).join("\n"))}">${off.length} offline</span>` : ""}<span class="spacer"></span><button class="link" data-lf="closed">${S.view === "closed" ? "Sessions" : `Closed ${S.graveyard.length}`}</button><button class="link" data-lf="menu">Settings</button>`);
}
function renderClosed() {
  const box = $("rows");
  box.dataset.view = "closed";
  lastOrder = "";
  const q = S.q.toLowerCase();
  const list = S.graveyard.filter((g) => (S.machine === "all" || g.machine === S.machine) && (!q || [g.title, g.project, g.cwd].join(" ").toLowerCase().includes(q)));
  setHTML(box, `<div class="sec"><button class="sec-h" data-lf="inbox">${ICON.back}Back to sessions</button></div>` +
    (list.length ? list.map((g) => `<div class="row" data-grave="${esc(g.id)}"><span class="dot" style="--c:var(--empty)"></span><span class="pl"><span class="pj" style="--pc:${pc(g.project)}">${esc(g.project)}</span>${multiMachine() ? `<span class="mach">${esc(machineLabel(g.machine))}</span>` : ""}</span><span class="ago">${ago(g.closedAt)}</span>
      <span class="tl"><b>${esc(g.title || "(untitled)")}</b></span><span class="ln">closed ${esc(abs(g.closedAt))}</span>
      <span class="ln" style="margin-top:6px;display:flex;gap:4px">${g.resume ? `<button class="btn" data-gact="reopen">Reopen</button><button class="btn ghost" data-gact="copy">Copy resume</button>` : `<button class="btn" data-gact="reopen">New tab here</button>`}<button class="btn ghost" data-gact="forget">Remove</button></span></div>`).join("")
      : `<div class="empty-state">Sessions you close are kept here so you can reopen them.</div>`));
  $("selbar").hidden = true;
  setHTML($("mini"), "");
}
function setHTML(el, html) { if (el._h !== html) { el.innerHTML = html; el._h = html; } }
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-t]")) { const t = Number(el.dataset.t); if (t) el.textContent = el.dataset.why ? reasonLabel(el.dataset.why, t, now) : el.dataset.fmt === "long" ? agoText(t) : ago(t); }
}, 20000);
setInterval(() => { for (const el of document.querySelectorAll("[data-since]")) el.textContent = clock(Date.now() - Number(el.dataset.since)); }, 1000);
