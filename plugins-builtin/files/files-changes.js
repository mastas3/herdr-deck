"use strict";
// The Changes tab: the session folder's git diff, read-only. "Uncommitted" is the working tree against HEAD (staged or
// not, new files included); "This session" starts from the commit HEAD was at when the session began, so commits the
// agent made count too. One block per file with +/− counts; small diffs open at once, big ones on a click and a page at
// a time. The only action is asking the agent to commit, which just fills the message box.
const filesC = { el: null, row: null, data: null, since: load("filesSince", ""), diffs: new Map(), shut: new Set(), seq: 0, pacer: null };
const FILES_AUTO_OPEN = 6, FILES_AUTO_LINES = 400;

function filesChangesRender(el, row) {
  filesC.el = el; filesC.row = row; filesC.data = null; filesC.diffs = new Map(); filesC.shut = new Set();
  filesC.pacer?.stop();
  filesC.pacer = filesPacer(8000, () => filesChangesLoad(true));
  el.innerHTML = `<div class="cx">
    <div class="fx-top"><div class="seg2 cx-seg" role="tablist" aria-label="Compare with"><button role="tab" data-cxs="">Uncommitted</button><button role="tab" data-cxs="start" title="Everything since the commit this session started from, its own commits included">This session</button></div>
      <span class="spacer"></span><button class="ib fx-re" title="Refresh" aria-label="Refresh"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5"/></svg></button></div>
    <div class="fx-meta hint cx-sum"></div>
    <div class="cx-body"><p class="hint fx-wait">Reading the changes…</p></div>
  </div>`;
  filesChangesSeg();
  el.onclick = (e) => filesChangesClick(e);
  filesChangesLoad(false);
}
function filesChangesSeg() {
  for (const b of filesC.el?.querySelectorAll("[data-cxs]") ?? []) b.setAttribute("aria-selected", String(b.dataset.cxs === filesC.since));
}

async function filesChangesLoad(quiet) {
  const row = filesC.row, seq = ++filesC.seq;
  filesC.pacer?.mark();
  try {
    const data = await filesApi(row, { op: "changes", since: filesC.since || undefined });
    if (seq !== filesC.seq) return;
    const fresh = !filesC.data || filesC.data.base !== data.base;
    filesC.data = data;
    // Reloading keeps what you opened; a different base (or first load) opens the first few small diffs again.
    const keep = fresh ? new Set() : new Set([...filesC.diffs.keys()]);
    filesC.diffs = new Map();
    if (fresh) filesC.shut = new Set();
    let auto = 0;
    for (const f of data.files ?? []) {
      const small = !f.secret && !f.bin && !f.big && (f.add ?? 0) + (f.del ?? 0) <= FILES_AUTO_LINES;
      if (keep.has(f.path) || (fresh && small && auto++ < FILES_AUTO_OPEN && !filesC.shut.has(f.path))) filesC.diffs.set(f.path, { lines: [], total: 0, loading: true });
    }
    filesChangesDraw();
    await Promise.all([...filesC.diffs.keys()].map((p) => filesDiffPage(p, 0)));
  } catch (e) {
    if (seq !== filesC.seq || quiet) return;
    const b = filesC.el?.querySelector(".cx-body");
    if (b) b.innerHTML = `<div class="fx-err"><p>${esc(e.message)}</p><button class="btn" data-cx="retry">Try again</button></div>`;
  }
}

async function filesDiffPage(path, from) {
  const f = filesC.data?.files.find((x) => x.path === path);
  const d = filesC.diffs.get(path);
  if (!f || !d) return;
  const seq = filesC.seq;
  d.loading = true;
  try {
    const r = await filesApi(filesC.row, { op: "diff", path, old: f.old, base: filesC.data.base ?? undefined, untracked: f.st === "?" || undefined, from });
    if (seq !== filesC.seq || filesC.diffs.get(path) !== d) return;
    d.lines = from ? [...d.lines, ...r.lines] : r.lines;
    d.total = r.total;
  } catch (e) { d.error = e.message; }
  d.loading = false;
  filesDiffDraw(path);
}

function filesChangesDraw() {
  const el = filesC.el, data = filesC.data;
  if (!el || !data) return;
  const sum = el.querySelector(".cx-sum"), body = el.querySelector(".cx-body");
  if (!data.repo) { sum.textContent = ""; body.innerHTML = `<p class="hint fx-none">This folder isn’t a git repo, so there are no changes to show. The Files tab still lists what’s in it.</p>`; return; }
  const n = data.files.length + (data.more ?? 0);
  const from = data.from ? ` · from <span class="mono" title="${esc(data.from.subject)}">${esc(data.from.sha.slice(0, 7))}</span>, ${esc(agoText(data.from.at))}` : "";
  sum.title = data.label ?? "";
  sum.innerHTML = n ? `${filesC.since && !data.unknown ? `${esc(data.from ? "Since it started" : "Since it started (no commits then)")} · ` : ""}${n} file${n === 1 ? "" : "s"} · <span class="cx-a">+${data.add}</span> <span class="cx-d">−${data.del}</span>${from}${data.unknown ? " · the session’s start isn’t known, so this is uncommitted work" : ""}` : `${esc(data.label)}: nothing${from}`;
  const canAsk = !$("composer").hidden && S.sel === filesC.row.key && n > 0;
  body.innerHTML = (n ? "" : `<p class="hint fx-none">${filesC.since ? "No changes since this session started." : "No uncommitted changes. Try “This session” to include commits the agent made."}</p>`)
    + data.files.map((f) => filesFileHtml(f)).join("")
    + (data.more ? `<p class="hint fx-none">${data.more} more files not listed.</p>` : "")
    + (canAsk ? `<div class="cx-foot"><button class="btn" data-cx="commit" title="Fills the message box; you review and send it">Ask the agent to commit</button></div>` : "");
  for (const p of filesC.diffs.keys()) filesDiffDraw(p);
}

function filesFileHtml(f) {
  const i = f.path.lastIndexOf("/");
  const open = filesC.diffs.has(f.path);
  const stats = f.secret ? `<span class="hint">secret: not shown</span>` : f.bin ? `<span class="hint">binary</span>` : f.big ? `<span class="hint">large</span>` : `<span class="cx-a">+${f.add ?? 0}</span><span class="cx-d">−${f.del ?? 0}</span>`;
  return `<section class="cx-f" data-p="${esc(f.path)}">
    <div class="cx-hd"><button class="cx-h" aria-expanded="${open}"${f.secret ? " disabled" : ""} title="${esc(f.old ? `${f.old} → ${f.path}` : f.path)}">${FILES_CHEV}${filesBadge(f.st)}<span class="cx-p"><span class="hint">${esc(i > 0 ? f.path.slice(0, i + 1) : "")}</span>${esc(f.path.slice(i + 1))}</span><span class="cx-n">${stats}</span></button>
    ${f.secret ? "" : `<button class="ib fx-m" data-m aria-label="More for ${esc(f.path)}">${FILES_MORE}</button>`}</div>
    <div class="cx-dd"${open ? "" : " hidden"}></div></section>`;
}

function filesDiffDraw(path) {
  const sec = filesC.el?.querySelector(`.cx-f[data-p="${CSS.escape(path)}"]`);
  const d = filesC.diffs.get(path);
  if (!sec || !d) return;
  const box = sec.querySelector(".cx-dd");
  box.hidden = false;
  sec.querySelector(".cx-h").setAttribute("aria-expanded", "true");
  if (d.error) { box.innerHTML = `<p class="hint fx-none">${esc(d.error)}</p>`; return; }
  if (!d.lines.length) { box.innerHTML = `<p class="hint fx-none">${d.loading ? "Loading…" : "No line changes (only the mode or the name)."}</p>`; return; }
  const rows = d.lines.map(([k, t, a, b]) => k === "@" ? `<div class="dl dhunk"><span class="dt">${esc(t)}</span></div>`
    : k === "!" ? `<div class="dl dnote"><span class="dt">${esc(t)}</span></div>`
    : `<div class="dl" data-k="${k === "+" ? "a" : k === "-" ? "d" : "c"}"><span class="dn">${a ?? ""}</span><span class="dn">${b ?? ""}</span><span class="dt">${filesHi(t) || " "}</span></div>`).join("");
  const left = d.total - d.lines.length;
  box.innerHTML = `<div class="cx-lines">${rows}</div>` + (left > 0 ? `<button class="fx-more" data-cx="more"${d.loading ? " disabled" : ""}>${d.loading ? "Loading…" : `Show ${Math.min(left, 400)} more lines (${left} left)`}</button>` : "");
}

function filesChangesClick(e) {
  if (e.target.closest("[data-cx=retry]")) return filesChangesLoad(false);
  const seg = e.target.closest("[data-cxs]");
  if (seg) { filesC.since = seg.dataset.cxs; store("filesSince", filesC.since); filesChangesSeg(); filesC.data = null; return filesChangesLoad(false); }
  if (e.target.closest(".fx-re")) return filesChangesLoad(false);
  if (e.target.closest("[data-cx=commit]")) return filesMention(filesC.row, filesC.since ? "Commit the work from this session that isn't committed yet, with a clear message. Don't push." : "Commit these changes with a clear message. Don't push.");
  const sec = e.target.closest(".cx-f");
  if (!sec) return;
  const path = sec.dataset.p;
  if (e.target.closest("[data-m]")) return filesMenu(e.target.closest("[data-m]"), filesC.row, filesC.data, `${filesC.data.root}/${path}`, false);
  if (e.target.closest("[data-cx=more]")) { const d = filesC.diffs.get(path); if (d && !d.loading) { d.loading = true; filesDiffDraw(path); filesDiffPage(path, d.lines.length); } return; }
  if (e.target.closest(".cx-h")) {
    if (filesC.diffs.has(path)) {
      filesC.diffs.delete(path); filesC.shut.add(path);
      sec.querySelector(".cx-dd").hidden = true;
      sec.querySelector(".cx-h").setAttribute("aria-expanded", "false");
      return;
    }
    filesC.shut.delete(path);
    filesC.diffs.set(path, { lines: [], total: 0, loading: true });
    filesDiffDraw(path);
    filesDiffPage(path, 0);
  }
}

filesReg.extend("inspector.tabs", {
  key: "changes", label: "Changes", icon: FILES_ICONS.changes, order: 30,
  badge: (row) => (row?.dirty ? String(row.dirty) : ""), // the deck's own count of uncommitted files
  when: (row) => !!row?.cwd && !row.hist,
  render: filesChangesRender,
  patch: (el, row) => { if (row.key !== filesC.row?.key) return; const poke = filesSig(row) !== filesSig(filesC.row); filesC.row = row; if (poke) filesC.pacer?.poke(); },
  leave: () => { filesC.pacer?.stop(); filesC.seq++; filesC.el = null; },
});
