"use strict";
// The Files tab: the session's folder as a tree that opens a folder at a time (git's view in a repo: nothing ignored),
// git status on each file and a count on each folder, the files the agent touched in this session at the top, and a
// filter over every file. Click a file to view it; ⋯ for copy path, mention in message, open on the Mac.
const filesT = { el: null, row: null, info: null, dirs: new Map(), opened: new Map(), seq: 0, q: "", found: null, showAll: false, touchedOpen: true, pacer: null };
const FILES_CHEV = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
const FILES_MORE = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
const filesOpenSet = (key) => { if (!filesT.opened.has(key)) filesT.opened.set(key, new Set()); return filesT.opened.get(key); };

function filesTreeRender(el, row) {
  filesT.el = el; filesT.row = row; filesT.info = null; filesT.dirs = new Map(); filesT.found = null; filesT.q = ""; filesT.showAll = false;
  filesT.pacer?.stop();
  filesT.pacer = filesPacer(5000, () => filesTreeLoad(true));
  el.innerHTML = `<div class="fx">
    <div class="fx-top"><label class="find fx-find"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><input type="search" class="fx-q" placeholder="Filter files" autocomplete="off" spellcheck="false" aria-label="Filter files"></label>
      <button class="ib fx-re" title="Refresh" aria-label="Refresh"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5"/></svg></button></div>
    <div class="fx-meta hint"></div>
    <div class="fx-body" role="tree" aria-label="Files"><p class="hint fx-wait">Loading the folder…</p></div>
  </div>`;
  const q = el.querySelector(".fx-q");
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => filesFind(q.value), 150); };
  q.onkeydown = (e) => {
    if (e.key === "Escape" && q.value) { e.preventDefault(); e.stopPropagation(); q.value = ""; filesFind(""); }
    if (e.key === "ArrowDown") { e.preventDefault(); el.querySelector(".fx-r")?.focus(); }
  };
  el.querySelector(".fx-re").onclick = () => filesTreeLoad(false);
  el.onclick = (e) => filesTreeClick(e);
  el.onkeydown = (e) => filesTreeKey(e);
  filesTreeLoad(false);
}

async function filesTreeLoad(quiet) {
  const row = filesT.row, seq = ++filesT.seq;
  filesT.pacer?.mark();
  try {
    const info = await filesApi(row, { op: "summary" });
    const opened = filesOpenSet(row.key);
    const dirs = new Map([["", { entries: info.entries, more: info.more }]]);
    const kids = await Promise.all([...opened].map((d) => filesApi(row, { op: "tree", dir: d }).catch(() => null)));
    [...opened].forEach((d, i) => (kids[i] ? dirs.set(d, kids[i]) : opened.delete(d)));
    if (seq !== filesT.seq) return;
    filesT.info = info; filesT.dirs = dirs;
    if (filesT.q) await filesFind(filesT.q, true);
    filesTreeDraw();
  } catch (e) {
    if (seq !== filesT.seq || quiet) return;
    const b = filesT.el?.querySelector(".fx-body");
    if (b) b.innerHTML = `<div class="fx-err"><p>${esc(e.message)}</p><button class="btn" data-fx="retry">Try again</button></div>`;
  }
}

async function filesFind(q, keep) {
  filesT.q = q.trim();
  if (!filesT.q) { filesT.found = null; return keep || filesTreeDraw(); }
  const seq = filesT.seq;
  try {
    const r = await filesApi(filesT.row, { op: "find", q: filesT.q });
    if (seq !== filesT.seq || r.q !== filesT.q) return;
    filesT.found = r;
  } catch (e) { filesT.found = { error: e.message, paths: [] }; }
  if (!keep) filesTreeDraw();
}

function filesRowHtml({ rel, name, dir, depth, e = {}, open, touched, at, sub }) {
  const cls = ["fx-r", dir ? "dir" : "", e.blocked ? "blocked" : "", e.gone ? "gone" : "", touched ? "touched" : ""].filter(Boolean).join(" ");
  const title = e.blocked ? "A secret, or a link out of this folder: the deck won’t open it" : e.gone ? "Deleted" : sub ?? rel;
  return `<div class="${cls}" role="treeitem" tabindex="-1" data-p="${esc(rel)}"${dir ? ` aria-expanded="${!!open}"` : ""} style="--d:${depth}" title="${esc(title)}">
    <span class="fx-tw">${dir ? FILES_CHEV : ""}</span><span class="fx-n">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ""}</span>
    ${e.n ? `<span class="fx-c" title="${e.n} changed inside">${e.n}</span>` : ""}${at ? `<span class="fx-at">${esc(ago(at))}</span>` : ""}${filesBadge(e.st)}
    ${e.blocked ? "" : `<button class="ib fx-m" data-m aria-label="More for ${esc(name)}">${FILES_MORE}</button>`}</div>`;
}

function filesTreeDraw() {
  const el = filesT.el, info = filesT.info;
  if (!el || !info) return;
  const scroll = el.querySelector(".fx-body")?.scrollTop ?? 0;
  const meta = el.querySelector(".fx-meta");
  meta.title = home(info.root) + (info.cwd ? ` (the session runs in ${info.cwd})` : "");
  meta.innerHTML = `<span class="mono">${esc(info.root.split("/").pop() || "/")}</span>${info.repo ? ` · ${esc(info.branch ?? "detached")} · ${info.changed ? `${info.changed} changed${info.statusTruncated ? "+" : ""}` : "nothing changed"}` : " · not a git repo"}`;
  const words = filesT.q.toLowerCase().split(/\s+/).filter(Boolean);
  const touched = info.touched.filter((t) => words.every((w) => (t.rel ?? t.path).toLowerCase().includes(w)));
  let h = "";
  if (info.touched.length) {
    const shown = filesT.showAll ? touched : touched.slice(0, 12);
    h += `<div class="fx-sec"><button class="fx-h" data-fx="touched" aria-expanded="${filesT.touchedOpen}">${FILES_CHEV}Touched: ${info.touched.length}<span class="hint">by the agent in this session</span></button></div>`;
    if (filesT.touchedOpen) {
      h += shown.map((t) => { const name = (t.rel ?? home(t.path)).split("/").pop(); const dir = (t.rel ?? home(t.path)).split("/").slice(0, -1).join("/"); return filesRowHtml({ rel: t.rel ?? t.path, name, depth: 0, e: { st: t.st, gone: t.gone }, touched: true, at: t.at, sub: dir || undefined }).replace('data-p="', `data-abs="${esc(t.path)}" data-p="`); }).join("");
      if (touched.length > shown.length) h += `<button class="fx-more" data-fx="all">Show all ${touched.length}</button>`;
      if (!touched.length) h += `<p class="hint fx-none">No touched file matches.</p>`;
    }
  } else h += `<p class="hint fx-none">The agent hasn’t changed any files in this session yet.</p>`;
  h += `<div class="fx-sec"><span class="fx-h">${filesT.q ? "Matching files" : "All files"}</span></div>`;
  if (filesT.q) {
    const f = filesT.found;
    if (!f) h += `<p class="hint fx-none">Looking…</p>`;
    else if (f.error) h += `<p class="hint fx-none">${esc(f.error)}</p>`;
    else {
      h += f.paths.map((x) => filesRowHtml({ rel: x.p, name: x.p.split("/").pop(), depth: 0, e: { st: x.st }, sub: x.p.split("/").slice(0, -1).join("/") || undefined })).join("");
      h += f.total > f.paths.length ? `<p class="hint fx-none">${f.total - f.paths.length} more: type more of the name.</p>` : !f.total ? `<p class="hint fx-none">No file matches “${esc(filesT.q)}”.</p>` : "";
    }
  } else h += filesDirHtml("", 0);
  const body = el.querySelector(".fx-body");
  body.innerHTML = h;
  body.scrollTop = scroll;
}

function filesDirHtml(rel, depth) {
  const d = filesT.dirs.get(rel);
  if (!d) return `<p class="hint fx-none" style="--d:${depth}">Loading…</p>`;
  const opened = filesOpenSet(filesT.row.key);
  let h = d.entries.map((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    const open = e.dir && opened.has(p) && !e.blocked;
    return filesRowHtml({ rel: p, name: e.name, dir: e.dir, depth, e, open }) + (open ? filesDirHtml(p, depth + 1) : "");
  }).join("");
  if (d.more) h += `<p class="hint fx-none" style="--d:${depth}">${d.more} more here: use the filter to find them.</p>`;
  if (!d.entries.length && !d.more) h += `<p class="hint fx-none" style="--d:${depth}">Empty</p>`;
  return h;
}

async function filesToggle(rel, open) {
  const opened = filesOpenSet(filesT.row.key);
  if (!open) { for (const d of [...opened]) if (d === rel || d.startsWith(rel + "/")) opened.delete(d); return filesTreeDraw(); }
  opened.add(rel);
  if (!filesT.dirs.has(rel)) {
    filesTreeDraw();
    try { filesT.dirs.set(rel, await filesApi(filesT.row, { op: "tree", dir: rel })); }
    catch (e) { opened.delete(rel); toast(e.message, true); }
  }
  filesTreeDraw();
  filesT.el.querySelector(`.fx-r[data-p="${CSS.escape(rel)}"]`)?.focus();
}

function filesTreeClick(e) {
  const row = filesT.row, info = filesT.info;
  if (e.target.closest("[data-fx=retry]")) return filesTreeLoad(false);
  if (e.target.closest("[data-fx=touched]")) { filesT.touchedOpen = !filesT.touchedOpen; return filesTreeDraw(); }
  if (e.target.closest("[data-fx=all]")) { filesT.showAll = true; return filesTreeDraw(); }
  const r = e.target.closest(".fx-r");
  if (!r || !info) return;
  const abs = r.dataset.abs ?? `${info.root}/${r.dataset.p}`;
  const dir = r.classList.contains("dir");
  if (e.target.closest("[data-m]")) return filesMenu(e.target.closest("[data-m]"), row, info, abs, dir);
  if (r.classList.contains("blocked")) return toast("The deck won’t open that: it’s a secret, or a link out of this folder.", true);
  if (dir) return filesToggle(r.dataset.p, r.getAttribute("aria-expanded") !== "true");
  if (r.classList.contains("gone")) return toast("That file was deleted. The Changes tab shows what it held.");
  openFile(abs, row.key);
}

/** Arrow keys walk the rows; → opens a folder, ← closes it (or goes to its folder); Enter opens. */
function filesTreeKey(e) {
  const r = e.target.closest?.(".fx-r");
  if (!r) return;
  const rows = [...filesT.el.querySelectorAll(".fx-r")];
  const i = rows.indexOf(r);
  const go = (j) => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus(); };
  if (e.key === "ArrowDown") return go(i + 1);
  if (e.key === "ArrowUp") return i === 0 ? (e.preventDefault(), filesT.el.querySelector(".fx-q").focus()) : go(i - 1);
  if (e.key === "Enter") { e.preventDefault(); return r.click(); }
  const dir = r.classList.contains("dir"), open = r.getAttribute("aria-expanded") === "true";
  if (e.key === "ArrowRight" && dir && !open) { e.preventDefault(); return filesToggle(r.dataset.p, true); }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (dir && open) return filesToggle(r.dataset.p, false);
    const parent = r.dataset.p.split("/").slice(0, -1).join("/");
    if (parent) rows.find((x) => x.dataset.p === parent)?.focus();
  }
}

filesReg.extend("inspector.tabs", {
  key: "files", label: "Files", icon: FILES_ICONS.files, order: 20,
  when: (row) => !!row?.cwd && !row.hist,
  render: filesTreeRender,
  patch: (el, row) => { if (row.key !== filesT.row?.key) return; const poke = filesSig(row) !== filesSig(filesT.row); filesT.row = row; if (poke) filesT.pacer?.poke(); },
  leave: () => { filesT.pacer?.stop(); filesT.seq++; filesT.el = null; },
});
