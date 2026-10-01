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
  treeIndex(); // each dispatcher's workers, for the list, the header, Info and the board
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
/** The machine picker: one compact button in the filter row (1–9 switch too); its menu has the counts. */
function renderMachines() {
  const ms = S.summary.machines ?? [], el = $("machines");
  el.hidden = ms.length < 2;
  const cur = ms.find((m) => m.id === S.machine), off = ms.some((m) => !m.online);
  if (!el.hidden) setHTML(el, `${cur ? SRC_ICON[cur.kind === "app" ? "app" : cur.local ? "mac" : "remote"] : SRC_ICON.all}<span>${esc(cur?.label ?? "All")}</span>${off ? '<span class="off" title="A machine is offline"></span>' : ""}${ICON.chev}`);
  el.setAttribute("aria-label", `Machine: ${cur?.label ?? "all"}`);
  for (const b of $("groupSeg").children) b.setAttribute("aria-selected", b.dataset.group === S.group);
}
function machineMenu(anchor) {
  const ms = S.summary.machines ?? [];
  const count = (id) => [...S.rows.values()].filter((r) => id === "all" || r.machine === id).length;
  openMenu(anchor, [["all", "All machines"], ...ms.map((m) => [m.id, m.label, m])].map(([id, label, m], i) => ({
    html: `${esc(label)}<small>${count(id)} session${count(id) === 1 ? "" : "s"}${m && !m.online ? ` · ${m.kind === "app" ? "not running" : "offline"}` : ""}${i < 9 ? ` · ${i + 1}` : ""}</small>`,
    on: S.machine === id, title: m && !m.online ? (m.error ?? "") : "", run: () => setMachine(id),
  })), "Show sessions from");
}
function renderLive() {
  const rows = [...S.rows.values()].filter(inScope);
  const working = rows.filter((r) => r.status === "working");
  const blocked = rows.filter((r) => r.status === "blocked");
  const subs = rows.reduce((n, r) => n + (r.subagents ?? []).filter((x) => x.running).length, 0);
  // The list's title while anything runs: "Running 3 · 1 waiting · 1 subagent"; it opens the live board.
  const el = $("live");
  el.hidden = !working.length && !blocked.length;
  el.setAttribute("aria-pressed", S.board);
  const head = working.length ? `<span class="spin"></span>Running <b>${working.length}</b>${blocked.length ? `<span class="lvx"> · ${blocked.length} waiting</span>` : ""}` : `<span class="dot" style="--c:var(--blocked)"></span>Waiting <b>${blocked.length}</b>`;
  setHTML(el, `<span class="lt">${head}${subs ? `<span class="lvx"> · ${subs} subagent${subs === 1 ? "" : "s"}</span>` : ""}</span><span class="spacer"></span><span class="dim">${S.board && !(isPhone() && app.dataset.mview === "list") ? "Close board" : "Live board"}${ICON.chev}</span>`);
}
/** Sections of the list. Each holds families (list-tree.js): a session and the workers it dispatched, which go
 *  wherever it goes (its project, its worktree, its place in the queue). `rows` counts every row, `open` is what shows. */
function listGroups(rows) {
  const fams = treeFams(rows);
  if (S.group === "project") {
    const lone = (f) => f.members.every((r) => r.empty && !fresh(r));
    const empty = treeFams(fams.filter(lone).flatMap((f) => f.members));
    const by = new Map(), head = new Map();
    for (const f of fams) {
      if (lone(f)) continue;
      const h = f.root ?? f.lead;
      for (const r of f.members) head.set(r.key, h);
      by.set(h.project, [...(by.get(h.project) ?? []), ...f.members]);
    }
    const rank = (rs) => (rs.some((r) => r.status === "blocked" || r.status === "done") ? 0 : rs.some((r) => r.status === "working") ? 1 : 2);
    const latest = (rs) => Math.max(...rs.map(act));
    const groups = [...by.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || latest(b[1]) - latest(a[1]))
      .map(([p, rs]) => {
        rs.sort((a, b) => ["blocked", "done", "working"].indexOf(b.status) - ["blocked", "done", "working"].indexOf(a.status) || act(b) - act(a));
        // The main checkout's sessions sit right under the project, each linked worktree's in a sub-section after them.
        const w = splitWorktrees(p, rs, S.closedProj, (r) => head.get(r.key) ?? r);
        const main = treeFams(w.main), trees = w.trees.map((t) => ({ ...t, fams: treeFams(t.rows) }));
        const open = treeShown(main).concat(...trees.map((t) => (t.closed ? [] : treeShown(t.fams))));
        return { key: "p:" + p, label: p, proj: p, rows: w.rows, open, fams: main, trees, branch: w.branch, dir: projectHome(p)?.cwd, closed: !!S.closedProj[p] };
      });
    if (empty.length) groups.push({ key: "empty", label: "Empty", rows: empty.flatMap((f) => f.members), open: treeShown(empty), fams: empty, closed: S.closedSecs.empty !== false });
    return groups;
  }
  // Priority: one attention-ordered list; old and empty sessions fold away at the bottom. A family goes by its most
  // urgent row (its first).
  const main = fams.filter((f) => rank(f.lead) < 5), tail = fams.filter((f) => rank(f.lead) >= 5);
  const sec = (fs, o) => ({ rows: fs.flatMap((f) => f.members), open: treeShown(fs), fams: fs, ...o });
  const out = [sec(main, { key: "all", label: "", closed: false, flat: true })];
  if (tail.length) out.push(sec(tail, { key: "old", label: `Stale & empty`, closed: S.closedSecs.old !== false, tail: true }));
  return out.filter((x) => x.rows.length);
}
/** The rows a section shows (what keyboard navigation walks): none while folded, and not a folded worktree's. */
const shownRows = (g) => (g.closed ? [] : g.open ?? g.rows);
const branchChip = (b) => (b ? `<span class="brc" title="Branch ${esc(b)}">${ICON.branch}<span>${esc(b)}</span></span>` : "");
/** The folder a project (or worktree) lives in, shortened to ~; it loses its start first, so the folder's own name stays. Click copies it. */
const pathChip = (p) => (p ? `<span class="pthc" data-secact="copypath" data-path="${esc(p)}" role="button" title="${esc(p)} (click to copy)"><bdi>${esc(home(p))}</bdi></span>` : "");
/** Branch and folder on a quiet second line under the name, so neither crowds the name or the buttons. */
const metaLine = (b, p) => (b || p ? `<span class="smeta">${branchChip(b)}${pathChip(p)}</span>` : "");
/** Projects view: fold every project shown, or unfold them all (and their worktrees) when all are folded. */
function foldAllProjects() {
  if (S.group !== "project") return;
  const gs = listGroups(visibleRows()).filter((g) => g.proj);
  const fold = gs.some((g) => !g.closed), next = { ...S.closedProj };
  for (const g of gs) {
    if (fold) next[g.proj] = true;
    else { delete next[g.proj]; for (const t of g.trees ?? []) delete next[t.key]; }
  }
  S.closedProj = next; store("closedProj", S.closedProj);
  lastOrder = ""; render();
}
$("foldAll").onclick = foldAllProjects;
/** The header button reads what it would do now. */
function renderFoldAll(groups) {
  const b = $("foldAll"), gs = S.group === "project" && S.view !== "closed" ? groups.filter((g) => g.proj) : [];
  b.hidden = !gs.length;
  const fold = gs.some((g) => !g.closed), label = fold ? "Collapse all projects" : "Expand all projects";
  if (b.dataset.fold !== String(fold)) { b.dataset.fold = String(fold); b.innerHTML = fold ? ICON.foldIn : ICON.foldOut; b.title = label + " (G)"; b.setAttribute("aria-label", label); }
}
/** A project's folder button: the quick folder window (folder-view.js), on the machine the project lives on. */
const folderBtn = (proj, where, root, key) => `<span class="padd pfold" data-secact="folder" data-proj="${esc(proj)}"${root ? ` data-root="${esc(root)}" data-key="${esc(key)}" data-name="${esc(where)}"` : ""} role="button" title="Browse ${esc(where)}’s folder" aria-label="Browse ${esc(where)}’s folder">${ICON.folder}</span>`;
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
/** FLIP: every on-screen row that moved starts where it was and glides to its new place (new rows slide in via CSS).
 *  A row that was out of sight fades in where it lands; a reshuffle of more than 8 rows just fades the list in. */
function flipRows(box, before) {
  const b = box.getBoundingClientRect();
  const moves = [], appear = [];
  for (const el of box.querySelectorAll(".row[data-key]")) {
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom < b.top || r.top > b.bottom || el.classList.contains("born")) continue;
    const was = before.get(el.dataset.key);
    if (was == null || was + r.height < b.top || was > b.bottom) appear.push(el);
    else if (Math.abs(was - r.top) >= 1) moves.push([el, was - r.top]);
  }
  if (moves.length > 8) return motion.enter(box, "fade");
  for (const [el, dy] of moves) motion.run(el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], { dur: 3 });
  for (const el of appear) motion.enter(el, "fade");
}
/** The rows about to leave the list fade out where they were (motion.ghost), measured before the DOM changes. */
const leavingRows = (box, keep) => motion.ghost([...box.querySelectorAll(".row[data-key]")].filter((el) => !keep.has(el.dataset.key)), box);
const LIGHTS = [["blocked", "waiting on you"], ["done", "finished, not opened yet"], ["working", "working"]];
const lightsHTML = (rows) => { const n = projLights(rows); return LIGHTS.map(([k, what]) => n[k] ? `<span class="dot" style="--c:var(--${k})" title="${n[k]} ${what}"></span>` : "").join(""); };
let selWas = null;
let lastView = "";
function renderList() {
  const box = $("rows");
  // A worker the filter matched brings its dispatcher along (dimmed), so it never shows out of context.
  const { rows, ctx: ctxKeys } = treeWithContext(visibleRows(), S.rows);
  treeIndex();
  const byProject = S.group === "project";
  const groups = listGroups(rows);
  const order = S.group + groups.map((g) => g.key + ":" + (g.closed ? "x" : "") + (g.branch ?? "") + (g.dir ?? "") + treeOrderSig(g.fams)
    + (g.trees ?? []).map((t) => `/${t.key}${t.closed ? "x" : ""}:${t.branch}:${treeOrderSig(t.fams)}`).join("")).join("|");
  // Anything you changed yourself (filter, grouping, machine, a folded section) applies at once, even under the pointer.
  const view = [S.group, S.machine, S.q, S.deep?.q ?? "", JSON.stringify(S.closedSecs), JSON.stringify(S.closedProj), JSON.stringify(S.treeClosed)].join("\u0001");
  const selHidden = !!S.sel && rows.some((r) => r.key === S.sel) && !rowCache.get(S.sel)?.el.isConnected;
  const force = !lastOrder || box.dataset.view !== "list" || view !== lastView || selHidden || !rows.length || !box.querySelector(".row[data-key]");
  const apply = order !== lastOrder && (force || !orderFrozen());
  const animate = !motion.reduced() && !!box.querySelector(".row[data-key]");
  const before = apply && !force && animate ? rowTops(box) : null;
  const ghosts = before ? leavingRows(box, new Set(rows.map((r) => r.key))) : null;
  // The selection glides from the row it was on (measured only when it moves).
  const oldSel = animate && selWas !== S.sel ? box.querySelector(".row.sel")?.getBoundingClientRect() : null;
  // Status colours, read once before any DOM write (a read between writes would recalculate styles for every row).
  const rootCss = animate ? getComputedStyle(document.documentElement) : null, colorOf = (st) => rootCss.getPropertyValue(`--${st in STATUS_NAME ? st : "unknown"}`);
  const colors = rootCss && Object.fromEntries(Object.keys(STATUS_NAME).concat("unknown").map((st) => [st, colorOf(st)]));
  for (const k of rowCache.keys()) if (!S.rows.has(k)) rowCache.delete(k);
  const now = Date.now();
  const deepOn = S.q && S.deep?.q === S.q;
  let bornN = 0, flashN = 0, morphN = 0;
  for (const r of rows) {
    let c = rowCache.get(r.key);
    if (!c) {
      const el = document.createElement("div");
      // New rows slide in, but not on first paint (the list fades in as a whole) and at most 8 at once.
      el.className = animate && ++bornN <= 8 ? "row born" : "row"; el.dataset.key = r.key; el.setAttribute("role", "button");
      // Drop the flash once it has played, or re-inserting the row on a reorder would replay it.
      el.addEventListener("animationend", (e) => { if (e.animationName === "flash") el.classList.remove("flash"); });
      c = { el, sig: "", stable: "", at: 0 };
      rowCache.set(r.key, c);
    }
    const ask = pendingAsk(r);
    const why = reasonOf(r, ask?.kind, now);
    const ctx = JSON.stringify(ask ?? "") + radarChip(r) + rowChips(r, "list") + why.k + !!S.simple + S.machine + multiMachine() + byProject + treeCtx(r) + (deepOn ? JSON.stringify(S.deep.byKey.get(r.key) ?? "") + S.q : "");
    // Memory, CPU and process counts aren't in a row: a new reading (the `procs` event) doesn't rebuild it.
    const { rssKB, cpu, procs, ...shown } = r;
    const sig = JSON.stringify(shown) + ctx;
    c.el.classList.toggle("unseen", needsYou(r));
    if (c.sig !== sig) {
      const stable = stableSig(r) + ctx;
      // Only the live bits moved (tool line, todos, tail, subagents, memory): at most one repaint a second per row.
      if (c.sig && c.stable === stable && now - c.at < 1000) renderLater(1000 - (now - c.at) + 16);
      else {
        const was = c.el.dataset.status, wasWhy = animate && c.el.querySelector(".why")?.dataset.k;
        // A status change morphs the dot's colour.
        const dotWas = colors && was && was !== r.status && morphN++ < 12 ? colors[was] ?? colors.unknown : null;
        c.el.innerHTML = rowHTML(r, byProject, why); c.el.dataset.status = r.status; c.sig = sig; c.stable = stable; c.at = now;
        if (dotWas) { const d = c.el.querySelector(".dot"); if (d) motion.run(d, [{ backgroundColor: dotWas }, {}], { dur: 3 }); }
        if (wasWhy && wasWhy !== why.k) c.el.querySelector(".why")?.classList.add("chg");
        // One flash per row that starts needing you; a burst of them (a reconnect, a reshuffle) flashes the first 8 only.
        if (was && was !== r.status && (r.status === "blocked" || r.status === "done") && flashN++ < 8) { c.el.classList.remove("flash"); void c.el.offsetWidth; c.el.classList.add("flash"); }
      }
    }
    // Selected means "this is the session on the right": not while the board or a view (Inbox, History…) is showing.
    c.el.classList.toggle("sel", S.sel === r.key && !S.board && !S.mode);
    c.el.classList.toggle("picked", S.picked.has(r.key));
    c.el.classList.toggle("stale", !!r.stale && r.status !== "working" && r.status !== "blocked");
    c.el.classList.toggle("ctx", ctxKeys.has(r.key));
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
      const dots = g.proj ? `<span class="dots">${lightsHTML(g.rows)}</span>` : "";
      const extra = g.key === "empty" || g.tail ? `<span class="act link" data-secact="closeEmpty" role="button">Close empty</span>`
        : g.proj && projectHome(g.proj) ? `<span class="padd" data-secact="newin" data-proj="${esc(g.proj)}" role="button" title="New session in ${esc(g.proj)}" aria-label="New session in ${esc(g.proj)}">${ICON.plus}</span>` : "";
      const jour = g.proj && projectLink() ? `<span class="padd pjour" data-secact="journey" data-proj="${esc(g.proj)}" role="button" title="${esc(g.proj)}: project page" aria-label="${esc(g.proj)} project page">${projectLink().icon}</span>` : "";
      const fold = g.proj && projectHome(g.proj) ? folderBtn(g.proj, g.proj) : "";
      if (g.flat) { sec.className = "sec flat"; sec.innerHTML = `<div class="sec-b"></div>`; treeAppend(sec.lastChild, g.fams); frag.append(sec); continue; }
      sec.innerHTML = `<button class="sec-h${g.branch || g.dir ? " has-meta" : ""}" data-sec="${esc(g.key)}" aria-expanded="${!g.closed}">${ICON.chev}<span class="sl">${esc(g.label)}</span> <span class="n">${g.rows.length}</span>${metaLine(g.branch, g.dir)}${dots}${fold}${jour}${extra}</button><div class="sec-b"></div>`;
      const body = sec.lastChild;
      treeAppend(body, g.fams);
      // Each worktree: a sub-header one level in (⎇, its folder name, branch, count), its sessions one level further.
      for (const t of g.trees ?? []) {
        const wt = document.createElement("div");
        wt.className = "wt" + (t.closed ? " closed" : "");
        const k = t.rows.find((r) => r.projectRoot === t.root)?.key;
        wt.innerHTML = `<button class="sec-h wt-h${t.branch || t.root ? " has-meta" : ""}" data-sec="${esc(t.key)}" aria-expanded="${!t.closed}">${ICON.chev}<span class="wti">${ICON.tree}</span><span class="sl">${esc(t.name)}</span> <span class="n">${t.rows.length}</span>${metaLine(t.branch, t.root)}${t.root && k ? folderBtn(g.proj, t.name, t.root, k) : ""}</button><div class="sec-b"></div>`;
        treeAppend(wt.lastChild, t.fams);
        body.append(wt);
      }
      frag.append(sec);
    }
    // A live reorder glides (FLIP below); only a change you made replays the sections' entrance.
    box.classList.toggle("settled", !force);
    motion.counts(box, ".sec-h .n", (el) => el.parentElement.dataset.sec, () => box.replaceChildren(frag));
    if (!rows.length) box.innerHTML = `<div class="empty-state">${S.rows.size ? "Nothing matches. Press Esc to clear the filter." : noHerdr() ? "herdr isn’t running on this machine yet. Open a terminal and run <code>herdr</code>, then start your agents inside it; they’ll show up here by themselves. New to herdr? See <a href=\"https://herdr.dev\" target=\"_blank\" rel=\"noopener\">herdr.dev</a>." : "No sessions yet. Press n to start one."}</div>`;
    if (before) { flipRows(box, before); ghosts(); }
    else if (!animate && rows.length && !motion.reduced()) motion.enter(box, "fade");
    const born = box.querySelectorAll(".row.born");
    if (born.length) requestAnimationFrame(() => requestAnimationFrame(() => { for (const el of born) el.classList.remove("born"); }));
    S.visible = groups.flatMap(shownRows);
  } else if (order !== lastOrder) {
    // Frozen: rows that went away leave, everything else holds its place, newcomers wait for the release.
    const shown = [...box.querySelectorAll(".row[data-key]")].map((el) => el.dataset.key);
    const { keys } = frozenOrder(shown, rows.map((r) => r.key));
    const keep = new Set(keys);
    if (shown.some((k) => !keep.has(k))) {
      // Rows that went away fade out where they were, and the ones below close the gap smoothly.
      const tops = animate ? rowTops(box) : null, out = animate ? leavingRows(box, keep) : null;
      for (const k of shown) if (!keep.has(k)) { box.querySelector(`.row[data-key="${CSS.escape(k)}"]`)?.remove(); lastOrder = "~" + lastOrder; }
      if (tops) { flipRows(box, tops); out(); }
    }
    // Shown = not inside a folded project or a folded worktree.
    const open = new Set([...box.querySelectorAll(".row[data-key]")].filter((el) => !el.closest(".closed")).map((el) => el.dataset.key));
    S.visible = keys.filter((k) => open.has(k)).map((k) => S.rows.get(k)).filter(Boolean);
  } else S.visible = groups.flatMap(shownRows);
  // Headers are rebuilt only when the order changes; their lights follow every status change and every session you open.
  if (byProject) for (const g of groups) {
    const el = g.proj && box.querySelector(`.sec-h[data-sec="${CSS.escape(g.key)}"] > .dots`), html = el && lightsHTML(g.rows);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }
  if (selWas !== S.sel) { const to = rowCache.get(S.sel)?.el; if (oldSel && to?.classList.contains("sel")) motion.glide(oldSel, to, box); selWas = S.sel; }
  if (app.classList.contains("list-off")) renderRail(rows);
  renderFoldAll(groups); // after the list's measurements, so it never forces an extra layout
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
  // A worker's tile follows its dispatcher's when both are in the same group.
  for (const [k, g] of Object.entries(groups)) groups[k] = treeShown(treeFamilies(g.sort((a, b) => rank(a) - rank(b) || act(b) - act(a)), S.rows));
  const tile = (r) => {
    const subs = (r.subagents ?? []).filter((x) => x.running).length;
    const since = r.status === "working" && r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
    const tm = since ? `<span class="tm" data-since="${since}">${clock(Date.now() - since)}</span>` : r.status === "blocked" ? `<span class="tm">waiting</span>` : `<span class="tm" data-t="${r.lastActiveAt ?? ""}">${ago(r.lastActiveAt)}</span>`;
    const kids = treeKids(r.key), pr = r.parent?.key ? rowOf(r.parent.key) : null;
    const fleet = r.parent ? `\nWorker${r.parent.brief ? " #" + r.parent.brief : ""} of “${pr ? treeName(pr) : r.parent.srcName}”` : kids.length ? `\n${treeSummary(kids)}` : "";
    const tip = `${r.title || r.agent}\n${r.project}${r.launch ? " (via " + r.launch + ")" : ""} · ${paneName(r)}${multiMachine() ? " · " + machineLabel(r.machine) : ""}\n${STATUS_NAME[r.status] ?? r.status}${r.now ? " · " + r.now : ""}${subs ? `\n${subs} subagent${subs === 1 ? "" : "s"} running` : ""}${fleet}`;
    return `<button class="tile${S.sel === r.key && !S.board && !S.mode ? " sel" : ""}${r.parent ? " kid" : ""}" data-key="${esc(r.key)}" data-status="${r.status}" style="--pc:${pc(r.project)};--c:${statusVar(r.status)}" title="${esc(tip)}"><span class="ab">${esc(initials(r.project))}</span>${r.status !== "idle" ? '<span class="sd"></span>' : ""}${subs ? `<span class="sb">+${subs}</span>` : ""}${r.parent ? `<span class="wk">${ICON.bolt}</span>` : ""}<span class="tt">${esc(shortTitle(r.title))}</span>${tm}</button>`;
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
  motion.counts($("lf"), ".lfn b", () => "n", () => setHTML($("lf"), `<span class="lfn" title="${esc(tip)}">${count} · agents use ${mem(kb(shown))}</span>${off.length ? `<span class="warn" title="${esc(off.map((m) => m.label + ": " + (m.error ?? "")).join("\n"))}">${off.length} offline</span>` : ""}<span class="spacer"></span><button class="link" data-lf="closed">${S.view === "closed" ? "Sessions" : `Closed ${S.graveyard.length}`}</button><button class="link" data-lf="menu">Settings</button>`));
}
function renderClosed() {
  const box = $("rows");
  box.dataset.view = "closed";
  lastOrder = "";
  renderFoldAll([]);
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
  // Only labels whose text changed are written: an unchanged write still costs every row a relayout.
  for (const el of document.querySelectorAll("[data-t]")) { const t = Number(el.dataset.t); if (!t) continue; const v = el.dataset.why ? reasonLabel(el.dataset.why, t, now) : el.dataset.fmt === "long" ? agoText(t) : ago(t); if (el.textContent !== v) el.textContent = v; }
}, 20000);
// Time moves some states by itself ("new" turns "empty"): once a minute, redraw the list if one did. renderList
// rebuilds only the rows whose state or label changed, and nothing when none did.
let lastTimeSig = "";
setInterval(() => {
  if (document.hidden || S.view === "closed") return;
  const sig = timeSig(S.rows.values(), (r) => pendingAsk(r)?.kind, Date.now());
  if (sig !== lastTimeSig) { const first = !lastTimeSig; lastTimeSig = sig; if (!first) renderList(); }
}, 60_000);
setInterval(() => { for (const el of document.querySelectorAll("[data-since]")) el.textContent = clock(Date.now() - Number(el.dataset.since)); }, 1000);
