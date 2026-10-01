"use strict";
// Fleet workers in the list. A worker is a session another session dispatched (a row with `parent`, from
// src/dispatch-links.ts): it sits right under its dispatcher, one level in on a thin guide, with its brief (⚡ #PS1);
// the dispatcher's row says how its workers are doing and folds them away. Workers whose dispatcher isn't open sit
// together under a dimmed line that names it. Claude's in-process subagents are something else (the "N subagents"
// badge and the Subagents tab) and stay as they are.
/* @pure:tree-begin: no globals in here; test/list-tree.test.ts evaluates this block on its own. */
/** The live row a worker hangs under, or null: its resolved parent, when that row is open and isn't itself. */
function treeParent(r, all) {
  const k = r?.parent?.key;
  return k && k !== r.key && all.has(k) ? k : null;
}
/** One dimmed header per dispatcher that isn't open (per machine). */
const orphanKey = (r) => `o:${r.machine ?? ""}|${String(r.parent?.srcName ?? "").toLowerCase()}`;
/** The list's rows plus the dispatchers they lack (a filter that matched only the worker), which come along as context. */
function treeWithContext(rows, all) {
  const have = new Set(rows.map((r) => r.key)), ctx = new Set(), out = rows.slice();
  for (const r of rows) {
    for (let cur = r, i = 0; i < 8; i++) {
      const pk = treeParent(cur, all);
      if (!pk || have.has(pk)) break;
      have.add(pk); ctx.add(pk);
      cur = all.get(pk); out.push(cur);
    }
  }
  return { rows: out, ctx };
}
/** Families in list order. Each is a root (a session, or a header for a dispatcher that isn't open) with its workers
 *  nested under it. A family sits where its first row is, so a worker that needs you lifts its dispatcher; workers keep
 *  their own order. `closed` folds a node by key: its workers are hidden, except those `keep` says must stay in sight
 *  (with the workers above them). Every family: { key, root, orphan, node, kids, closed, count, members, shown, depth, lead }. */
function treeFamilies(rows, all, closed = {}, keep = () => false) {
  const pos = new Map(rows.map((r, i) => [r.key, i]));
  const up = new Map();
  for (const r of rows) {
    let pk = treeParent(r, all);
    if (pk && !pos.has(pk)) pk = null;
    // A link that loops back (two sessions naming each other) is dropped.
    for (let k = pk, n = 0; k && n < 64; k = up.get(k), n++) if (k === r.key) { pk = null; break; }
    if (pk) up.set(r.key, pk);
  }
  const node = new Map(rows.map((r) => [r.key, { r, all: [], kids: [], depth: 0, closed: false, count: 0 }]));
  for (const r of rows) if (up.has(r.key)) node.get(up.get(r.key)).all.push(node.get(r.key));
  const mustShow = (n) => keep(n.r) || n.all.some(mustShow);
  const build = (n, depth) => {
    n.depth = depth;
    n.closed = !!closed[n.r.key] && n.all.length > 0;
    n.kids = n.all.filter((k) => !n.closed || mustShow(k));
    n.count = n.all.reduce((s, k) => s + 1 + build(k, depth + 1), 0);
    return n.count;
  };
  const topOf = (k) => { while (up.has(k)) k = up.get(k); return node.get(k); };
  const fams = new Map(), out = [];
  for (const r of rows) {
    const top = topOf(r.key);
    const orphan = !!top.r.parent && !treeParent(top.r, all);
    const key = orphan ? orphanKey(top.r) : top.r.key;
    let f = fams.get(key);
    if (!f) { f = { key, root: orphan ? null : top.r, orphan: orphan ? { ...top.r.parent, machine: top.r.machine } : null, node: orphan ? null : top, tops: [], lead: r }; fams.set(key, f); out.push(f); }
    if (orphan && top.r === r) f.tops.push(top);
  }
  for (const f of out) {
    if (f.node) { build(f.node, 0); f.kids = f.node.kids; f.closed = f.node.closed; f.count = f.node.count; }
    else {
      f.count = f.tops.reduce((s, t) => s + 1 + build(t, 1), 0);
      f.closed = !!closed[f.key];
      f.kids = f.tops.filter((t) => !f.closed || mustShow(t));
    }
    // Every row of the family (folded ones too), and what the list shows, in order, with each row's depth (0: a root).
    const every = (n, acc) => { acc.push(n.r); n.all.forEach((c) => every(c, acc)); return acc; };
    f.members = f.node ? every(f.node, []) : f.tops.flatMap((t) => every(t, []));
    f.shown = []; f.depth = new Map();
    const walk = (n) => { f.shown.push(n.r); f.depth.set(n.r.key, n.depth); n.kids.forEach(walk); };
    if (f.node) walk(f.node); else f.kids.forEach(walk);
  }
  return out;
}
const treeShown = (fams) => fams.flatMap((f) => f.shown);
/** What the list compares to know the layout moved: every family, folded or not, and each row with its depth. */
const treeOrderSig = (fams) => fams.map((f) => `${f.key}${f.closed ? "x" : ""}(${f.shown.map((r) => r.key + "@" + f.depth.get(r.key)).join(",")})`).join(";");
/** "3 workers · 1 running · 2 done": how a dispatcher's workers are doing. */
function treeSummary(kids) {
  const n = { blocked: 0, working: 0, done: 0, idle: 0 };
  for (const r of kids) n[r.status === "blocked" || r.status === "working" || r.status === "done" ? r.status : "idle"]++;
  const parts = [`${kids.length} worker${kids.length === 1 ? "" : "s"}`];
  if (n.blocked) parts.push(`${n.blocked} waiting`);
  if (n.working) parts.push(`${n.working} running`);
  if (n.done) parts.push(`${n.done} done`);
  if (n.idle) parts.push(`${n.idle} idle`);
  return parts.join(" · ");
}
/* @pure:tree-end */

// ── the page's side ──────────────────────────────────────────────────────
S.treeClosed = load("treeClosed", {});
/** Each dispatcher's live workers (every one, whatever the filter shows), rebuilt once per list render. */
let TREE = { kids: new Map() };
function treeIndex() {
  const kids = new Map();
  for (const r of S.rows.values()) { const pk = treeParent(r, S.rows); if (pk) { if (!kids.has(pk)) kids.set(pk, []); kids.get(pk).push(r); } }
  TREE = { kids };
}
const treeKids = (key) => TREE.kids.get(key) ?? [];
/** A folded dispatcher still shows the workers that need you, and the one you have open. */
const treeKeep = (r) => needsYou(r) || r.key === S.sel;
const treeFams = (rows) => treeFamilies(rows, S.rows, S.treeClosed, treeKeep);
function toggleTree(key) {
  if (!key) return;
  const next = { ...S.treeClosed };
  if (next[key]) delete next[key]; else next[key] = true;
  // Folds of dispatchers long gone don't pile up.
  for (const k of Object.keys(next)) if (!k.startsWith("o:") && !S.rows.has(k) && Object.keys(next).length > 200) delete next[k];
  S.treeClosed = next; store("treeClosed", next);
  lastOrder = ""; render();
}
/** w: fold or unfold the selected session's workers (a worker folds its dispatcher's). */
function toggleTreeSel() {
  const r = rowOf(S.sel);
  if (!r) return;
  const key = treeKids(r.key).length ? r.key : treeParent(r, S.rows) ?? (r.parent ? orphanKey(r) : null);
  if (!key) return toast("This session has no workers");
  toggleTree(key);
}
/** p: open the session that dispatched the selected worker. */
function gotoTreeParent() {
  const r = rowOf(S.sel), pk = r && treeParent(r, S.rows);
  if (pk) return select(pk, { scroll: true });
  toast(r?.parent ? `Its dispatcher “${r.parent.srcName}” isn’t open` : "This session wasn’t dispatched by another one");
}
const treeName = (r) => r.title || r.agent;
/** A worker's chip: ⚡ and its brief ("#PS1"); who dispatched it on hover. */
function treeChip(r) {
  const p = r.parent;
  if (!p) return "";
  const pr = p.key ? rowOf(p.key) : null;
  const tip = `A worker${p.brief ? ` on brief #${p.brief}` : ""}, dispatched by “${pr ? treeName(pr) : p.srcName}”${pr ? "" : ` (${p.why ?? "not open"})`}`;
  return `<span class="wkc" title="${esc(tip)}">${ICON.bolt}<span>${p.brief ? "#" + esc(p.brief) : "worker"}</span></span>`;
}
/** Grouped by project, a worker in another project's folder says which (its dispatcher's project heads the group). */
function treeWhere(r) {
  const pr = r.parent?.key ? rowOf(r.parent.key) : null;
  return pr && r.project && r.project !== pr.project ? ` <span class="via">in ${esc(r.project)}</span>` : "";
}
/** A dispatcher's line under its row: the fold caret and how its workers are doing. */
function treeToggle(r) {
  const kids = treeKids(r.key);
  if (!kids.length) return "";
  const closed = !!S.treeClosed[r.key];
  return `<span class="tgl" data-tree="${esc(r.key)}" role="button" aria-expanded="${!closed}" title="${closed ? "Show" : "Hide"} the workers it dispatched (w)">${ICON.chev}${ICON.bolt}<span>${esc(treeSummary(kids))}</span></span>`;
}
/** What a row's look depends on beyond its own fields: its workers' summary and fold, its dispatcher's name. */
function treeCtx(r) {
  const kids = treeKids(r.key), pr = r.parent?.key ? rowOf(r.parent.key) : null;
  return (kids.length ? treeSummary(kids) + !!S.treeClosed[r.key] : "") + (pr ? treeName(pr) + pr.project : "");
}
const MISS_TEXT = { closed: "not open", ambiguous: "more than one session matches", unknown: "not found" };
/** The dimmed line over workers whose dispatcher isn't open: "← #QD6 · Stage to QA version (not open)". */
function orphanHead(f) {
  const o = f.orphan, one = f.count === 1 ? f.tops[0]?.r.parent?.brief : "";
  const tip = `${f.count} worker${f.count === 1 ? "" : "s"} dispatched by “${o.srcName}”, which ${o.miss === "ambiguous" ? "can’t be told apart from another open session" : "isn’t open"}${o.machine && multiMachine() ? ` on ${machineLabel(o.machine)}` : ""}.${o.why ? "\n" + o.why : ""}`;
  const el = document.createElement("button");
  el.className = "torph"; el.dataset.tree = f.key; el.title = tip;
  el.setAttribute("aria-expanded", String(!f.closed));
  el.innerHTML = `${ICON.chev}<span class="tl2">← ${one ? `#${esc(one)} · ` : ""}${esc(o.srcName)}</span><span class="tst">(${MISS_TEXT[o.miss] ?? "not open"})</span>${f.count > 1 ? `<span class="n">${f.count}</span>` : ""}`;
  return el;
}
/** A section's families into its body: each root's row, its workers in a box one level in (a box per level). */
function treeAppend(body, fams) {
  const kids = (into, nodes) => {
    if (!nodes.length) return;
    const box = document.createElement("div");
    box.className = "tkids";
    for (const n of nodes) { box.append(rowCache.get(n.r.key).el); kids(box, n.kids); }
    into.append(box);
  };
  for (const f of fams) {
    if (f.node) { body.append(rowCache.get(f.root.key).el); kids(body, f.node.kids); }
    else { body.append(orphanHead(f)); kids(body, f.kids); }
  }
}
// The fold caret on a dispatcher's row, and an orphan header, fold without opening the session.
$("rows").addEventListener("click", (e) => {
  const t = e.target.closest("[data-tree]");
  if (!t) return;
  e.stopPropagation(); e.preventDefault();
  toggleTree(t.dataset.tree);
}, true);

// ── the session pane and the live board ──────────────────────────────────
const treeDot = (r) => `<span class="dot" style="--c:${statusVar(r.status === "done" && r.seen ? "idle" : r.status)}"></span>`;
/** What the header and Info depend on: the link, the dispatcher's name, its workers and how they're doing. */
const treeHeadSig = (r) => JSON.stringify(r.parent ?? null) + treeCtx(r) + treeKids(r.key).map((k) => k.key + k.status + treeName(k)).join();
/** The header's chip: "⚡ Dispatched by <dispatcher> · #PS1" (opens it), or a dispatcher's "⚡ 3 workers · …" (Info). */
function treeHeadChip(r) {
  const p = r.parent, kids = treeKids(r.key);
  if (p) {
    const pr = p.key ? rowOf(p.key) : null;
    const label = `${ICON.bolt}<span>Dispatched by <b>${esc(pr ? treeName(pr) : p.srcName)}</b>${p.brief ? ` · #${esc(p.brief)}` : ""}${pr ? "" : ` (${MISS_TEXT[p.miss] ?? "not open"})`}</span>`;
    return pr ? `<button class="fleetc" data-card="${esc(pr.key)}" title="Open the session that dispatched this worker (p)">${label}</button>`
      : `<span class="fleetc off" title="${esc(p.why ?? "Its dispatcher isn’t open")}">${label}</span>`;
  }
  return kids.length ? `<button class="fleetc" data-tab="info" title="Its workers are listed under Info">${ICON.bolt}<span>${esc(treeSummary(kids))}</span></button>` : "";
}
/** Info: who dispatched it, and a dispatcher's workers, each a link. */
function treeFacts(r) {
  const out = [], p = r.parent;
  if (p) {
    const pr = p.key ? rowOf(p.key) : null;
    out.push(["Dispatched by", `<span class="tone">${pr ? `<button class="tlink" data-card="${esc(pr.key)}">${treeDot(pr)}${esc(treeName(pr))}</button>` : `<span>${esc(p.srcName)} <span class="hint">(${esc(p.why ?? "not open")})</span></span>`}`
      + `${p.brief ? `<span class="hint">· brief #${esc(p.brief)}</span>` : ""}</span>`]);
  }
  const kids = treeKids(r.key).slice().sort((a, b) => rank(a) - rank(b) || act(b) - act(a));
  if (kids.length) out.push(["Workers", `<span class="hint">${esc(treeSummary(kids))}</span>${kids.map((k) => `<button class="tlink" data-card="${esc(k.key)}">${treeDot(k)}${k.parent?.brief ? `<b>#${esc(k.parent.brief)}</b> ` : ""}${esc(treeName(k))}</button>`).join("")}`]);
  return out;
}
/** A board card's fleet line: a worker's brief and dispatcher, or a dispatcher's workers. */
function treeBoardLine(r) {
  const p = r.parent, kids = treeKids(r.key);
  if (p) { const pr = p.key ? rowOf(p.key) : null; return `<div class="wkline">${ICON.bolt}${p.brief ? `<b>#${esc(p.brief)}</b> ` : ""}← ${esc(pr ? treeName(pr) : p.srcName)}${pr ? "" : " (not open)"}</div>`; }
  return kids.length ? `<div class="wkline">${ICON.bolt}${esc(treeSummary(kids))}</div>` : "";
}
