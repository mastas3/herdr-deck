"use strict";
// Page events: the list, the session pane's buttons, the selection bar, search, the file viewer and the lightbox.
// ── events ───────────────────────────────────────────────────────────────
function setMachine(id) { S.machine = id; store("machine", id); S.picked.clear(); lastOrder = ""; render(); }
$("machines").addEventListener("click", (e) => { const b = e.target.closest("[data-machine]"); if (b) setMachine(b.dataset.machine); });
$("groupSeg").addEventListener("click", (e) => { const g = e.target.closest("[data-group]")?.dataset.group; if (g) setGroup(g); });
$("live").onclick = () => setBoard(!S.board);
$("rows").addEventListener("click", async (e) => {
  const newin = e.target.closest('[data-secact="newin"]');
  if (newin) { e.stopPropagation(); return openNew(projectHome(newin.dataset.proj)); }
  const jour = e.target.closest('[data-secact="journey"]');
  if (jour) { e.stopPropagation(); return projectLink()?.open(jour.dataset.proj); }
  if (e.target.closest("[data-secact]")?.dataset.secact === "closeEmpty") { e.stopPropagation(); return askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)); }
  const sec = e.target.closest("[data-sec]");
  if (sec) {
    const k = sec.dataset.sec;
    if (k.startsWith("p:")) { const p = k.slice(2); S.closedProj = { ...S.closedProj, [p]: !S.closedProj[p] }; store("closedProj", S.closedProj); }
    else { const closed = k === "old" ? S.closedSecs.old !== false : k === "empty" && S.group === "project" ? S.closedSecs.empty !== false : !!S.closedSecs[k]; S.closedSecs = { ...S.closedSecs, [k]: !closed }; store("closedSecs", S.closedSecs); }
    lastOrder = ""; return render();
  }
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
  const hit = S.q && S.deep?.q === S.q ? S.deep.byKey.get(row.dataset.key) : null;
  if (hit) return jumpTo(row.dataset.key, hit.i);
  select(row.dataset.key, { open: true });
});
// Order freeze: the pointer (or a finger) on the list holds the order still; see renderList.
$("rows").addEventListener("pointerenter", () => { listHold.over = true; });
$("rows").addEventListener("pointermove", () => { listHold.over = true; }, { passive: true });
$("rows").addEventListener("pointerleave", () => { listHold.over = false; releaseSoon(); });
$("rows").addEventListener("touchstart", () => { listHold.touch = true; }, { passive: true });
for (const ev of ["touchend", "touchcancel"]) $("rows").addEventListener(ev, () => { listHold.touch = false; releaseSoon(); }, { passive: true });
// Switching away with the pointer resting on the list shouldn't pin a stale order forever.
addEventListener("blur", () => { if (listHold.over || listHold.touch) { listHold.over = listHold.touch = false; releaseSoon(); } });
let hoverTimer = null;
$("rows").addEventListener("pointerover", (e) => {
  const row = e.target.closest(".row[data-key]");
  if (!row || row._warm) return;
  row._warm = true;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => prefetch(row.dataset.key), 70);
  row.addEventListener("pointerleave", () => { row._warm = false; clearTimeout(hoverTimer); }, { once: true });
});
$("rows").addEventListener("touchstart", (e) => { const row = e.target.closest(".row[data-key]"); if (row) prefetch(row.dataset.key); }, { passive: true });
$("mini").addEventListener("click", (e) => {
  if (e.target.closest("[data-railmore]")) return $("listToggle").click();
  const b = e.target.closest("[data-key]");
  if (b) select(b.dataset.key);
});
$("detail").addEventListener("click", (e) => {
  if (e.target.closest("#appbar")) return;
  const fp = e.target.closest("[data-path]");
  if (fp && !chatSel.size) { e.preventDefault(); e.stopPropagation(); return openFile(fp.dataset.path); }
  const blockEl = e.target.closest("[data-b]");
  if (e.target.closest("[data-copy]") && blockEl) { motion.confirm(e.target.closest("[data-copy]"), ICON.check); return copyBlocks([blockEl.dataset.b]); }
  if (e.target.closest("[data-pick]") && blockEl) return pickBlock(blockEl.dataset.b, e.shiftKey);
  if (e.target.closest("[data-codex-fork-point]") && blockEl) return forkCodexReply(rowOf(S.sel), chatDom.data?.find((b) => b.key === blockEl.dataset.b)?.ms[0]);
  if (chatSel.size && blockEl && !e.target.closest("a, button, [data-toggle]")) return pickBlock(blockEl.dataset.b, e.shiftKey);
  if (e.target.closest("[data-selcopy]")) { copyBlocks([...chatSel]); return clearPicks(); }
  if (e.target.closest("[data-selall]")) { for (const b of chatDom.data ?? []) chatSel.add(b.key); return renderSelBar(); }
  if (e.target.closest("[data-selclear]")) return clearPicks();
  const choose = e.target.closest("[data-choose]");
  if (choose && choose.closest(".choices.pickable")) { const c = choose.closest("[data-choice]"); return sendMessage(`(${c.dataset.choice}) ${c.dataset.title}`, $("cText")); }
  const choice = e.target.closest(".choices.can [data-choice]");
  if (choice) {
    for (const x of choice.parentElement.children) x.classList.toggle("on", x === choice);
    $("cText").value = `(${choice.dataset.choice}) ${choice.dataset.title}${$("cText").value.trim() ? "" : ". "}`;
    autosize($("cText")); $("cText").focus();
    return;
  }
  const quick = e.target.closest("[data-quick]");
  if (quick) return sendMessage(quick.dataset.quick, $("cText"));
  const fold = e.target.closest("[data-fold]");
  if (fold) {
    const k = fold.dataset.fold, opening = !expanded.has(k);
    opening ? expanded.add(k) : expanded.delete(k); chatDom.v = -1; renderChat();
    // The calls that were hidden drop in one after another (a height animation would relayout a long chat every frame).
    const lines = opening ? [...(chatDom.blocks.find((o) => o.key === k)?.el.querySelectorAll(".tool") ?? [])].slice(0, -3) : [];
    lines.forEach((el, i) => motion.enter(el, "drop", i));
    return;
  }
  const t = e.target.closest("[data-toggle]");
  if (t) return t.classList.toggle("clamp");
  if (e.target.closest("[data-earlier]")) return loadEarlier();
  const gap = e.target.closest("[data-gap]");
  if (gap) return loadGap(Number(gap.dataset.gap), Number(gap.dataset.gapto));
  const sub = e.target.closest("[data-sub]");
  if (sub) return openSub(sub.dataset.sub);
  const card = e.target.closest("[data-card]");
  if (card) return select(card.dataset.card, { scroll: true, open: true });
  const cimg = e.target.closest("[data-cimg]");
  if (cimg) {
    const all = [...$("dbody").querySelectorAll("[data-cimg]")].map((b) => ({ id: b.dataset.cimg, sub: S.sub }));
    S.gallery = all;
    return openLightbox(all.findIndex((x) => x.id === cimg.dataset.cimg));
  }
  const img = e.target.closest("[data-img]");
  if (img) return openLightbox(Number(img.dataset.img));
  const main = e.target.closest("button[data-main]");
  if (main) return setMain(main.dataset.main);
  const tab = e.target.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; store("tab2", S.tab); if (S.tab !== "chat") S.sub = null; headSig = ""; bodySig = ""; renderDetail(); if (S.tab === "chat") chatTick(true); return; }
  const b = e.target.closest("[data-dact]");
  if (!b) return;
  const act = b.dataset.dact;
  if (act === "new") return openNew();
  if (act === "home") return goHome();
  const r = rowOf(S.sel);
  if (!r) return;
  if (act === "journey") return projectLink()?.open(r.project);
  if (act === "tools") openToolMenu(b);
  if (act === "share") shareRow(r, Number(b.dataset.port));
  if (act === "unshare") unshareRow(r, Number(b.dataset.port));
  if (act === "histresume") resumeHist(r);
  if (act === "backhist") setMode("history");
  if (act === "check") checkMenu(b, r);
  if (act === "showterm") showTerminal();
  if (act === "link") copy(linkUrl(r), "link");
  if (act === "codexopen") codexAct("codex-open", r);
  if (act === "codexresume") codexAct("codex-resume", r);
  if (act === "codexhide") codexAct("codex-hide", r);
  if (act === "focus") focusPane(r.key);
  if (act === "more") moreMenu(b);
  if (act === "brief") writeBrief(r.key);
  if (act === "unsub") { S.sub = null; headSig = ""; bodySig = ""; chatDom.key = null; renderDetail(); chatTick(true); }
  if (act === "expand") { const el = $(b.dataset.target); el?.classList.toggle("clamp"); b.textContent = el?.classList.contains("clamp") ? "Show all" : "Show less"; }
});
$("lf").addEventListener("click", (e) => {
  const a = e.target.closest("[data-lf]")?.dataset.lf;
  if (a === "closed") { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); }
  if (a === "menu") settingsMenu(e.target.closest("[data-lf]"));
});
$("selRecipe").onclick = (e) => openToolMenu(e.currentTarget);
$("selClose").onclick = () => askClose([...S.picked]);
$("selClear").onclick = () => { S.picked.clear(); render(); };
let deepTimer = null, deepSeq = 0;
/** Searches inside every conversation (server-side), so a word said once, weeks ago, still finds its session. */
function deepSearch() {
  clearTimeout(deepTimer);
  const q = S.q.trim();
  const words = parseQuery(q).inc;
  if (q.length < 3 || !words.length) { if (S.deep) { S.deep = null; lastOrder = ""; render(); } return; }
  deepTimer = setTimeout(async () => {
    const seq = ++deepSeq;
    try {
      const { hits } = await api("/api/search", { q: words.join(" ") });
      if (seq !== deepSeq || S.q.trim() !== q) return;
      S.deep = { q: S.q, byKey: new Map(hits.map((h) => [h.key, h])) };
      lastOrder = ""; render();
    } catch {}
  }, 160);
}
$("q").addEventListener("input", (e) => { S.q = e.target.value; render(); deepSearch(); });
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; S.q = ""; S.deep = null; e.target.blur(); render(); }
  if (e.key === "Enter") { const first = S.visible?.[0]; if (first) { select(first.key, { open: true }); e.target.blur(); } }
});
$("paletteBtn").onclick = (e) => { e.preventDefault(); openPalette(); };
$("paletteMini").onclick = () => openPalette();
$("newBtn").onclick = openNew;
$("fitBtn").onclick = () => { S.fit = !S.fit; store("fit", S.fit); fitTerm(); toast(S.fit ? "Fitting the pane’s width" : "Fixed font size"); };
$("listToggle").onclick = () => { app.classList.toggle("list-off"); store("listOff", app.classList.contains("list-off")); lastOrder = ""; $("mini")._h = ""; render(); setTimeout(fitTerm, 0); };
$("termToggle").onclick = () => {
  app.classList.toggle("term-off"); store("termOff", app.classList.contains("term-off")); pollTerm();
  headSig = ""; renderDetail();
  if (app.classList.contains("term-off") && S.tpos === "right") toast("Terminal collapsed. Bring it back with the Terminal button at the top, or ]");
};

let fileCtx = null;
async function openFile(path, key = S.sel) {
  const r = rowOf(key);
  try {
    const f = await api("/api/file", { key, path });
    fileCtx = { key, path: f.path, raw: path };
    $("fTitle").textContent = home(f.path);
    const mac = r && (r.machine === S.self || r.machine === "codex-app");
    $("fOpen").hidden = !mac; $("fReveal").hidden = !mac;
    const body = $("fBody");
    if (f.kind === "dir") body.innerHTML = `<ul class="dirlist">${f.entries.map((n) => `<li><a class="fpath" data-path="${esc(f.path + "/" + n)}">${esc(n)}</a></li>`).join("") || "<li class=hint>Empty folder</li>"}</ul>`;
    else if (f.kind === "image") body.innerHTML = `<img class="fimg" alt="" src="/api/file-raw?key=${encodeURIComponent(key)}&path=${encodeURIComponent(f.path)}&t=${encodeURIComponent(S.token)}">`;
    else if (f.kind === "binary") body.innerHTML = `<p class="hint">A binary file (${mem(f.size / 1024)}). Open it on the Mac instead.</p>`;
    else if (f.kind === "markdown") body.innerHTML = `<div class="md fmd">${md(f.content)}</div>`;
    else body.innerHTML = `<pre class="fcode">${f.content.split("\n").map((l, n) => `<span class="ln${f.line === n + 1 ? " at" : ""}" data-n="${n + 1}">${esc(l) || " "}</span>`).join("\n")}</pre>`;
    $("fMeta").textContent = f.size != null ? `${mem(f.size / 1024)} · changed ${agoText(f.mtime)}` : `${f.entries?.length ?? 0} items`;
    if (!$("fileDlg").open) $("fileDlg").showModal();
    if (f.line) requestAnimationFrame(() => body.querySelector(".ln.at")?.scrollIntoView({ block: "center" }));
    else body.scrollTop = 0;
  } catch (e) { toast(e.message, true); }
}
$("fileDlg").addEventListener("click", (e) => {
  const fp = e.target.closest("[data-path]");
  if (fp) { e.preventDefault(); return openFile(fp.dataset.path, fileCtx?.key); }
  if (e.target === $("fileDlg")) $("fileDlg").close();
});
$("fOpen").onclick = () => fileCtx && api("/api/file-open", { key: fileCtx.key, path: fileCtx.path }).then(() => toast("Opened on the Mac")).catch((x) => toast(x.message, true));
$("fReveal").onclick = () => fileCtx && api("/api/file-open", { key: fileCtx.key, path: fileCtx.path, reveal: true }).then(() => toast("Shown in Finder")).catch((x) => toast(x.message, true));
$("fCopy").onclick = () => fileCtx && copy(fileCtx.path, "path");

function openLightbox(i) {
  const g = S.gallery ?? [];
  if (!g[i]) return;
  S.lb = i;
  $("lbImg").src = imgUrl(S.sel, g[i].id, g[i].sub);
  $("lbCap").textContent = `${i + 1} of ${g.length}${g[i].source ? ` · ${g[i].source === "pasted" ? "you pasted this" : "the agent looked at this"}` : ""}${g[i].at ? " · " + abs(g[i].at) : ""}`;
  if (!$("lightbox").open) $("lightbox").showModal();
}
$("lbPrev").onclick = () => openLightbox(Math.max(0, S.lb - 1));
$("lbNext").onclick = () => openLightbox(Math.min((S.gallery?.length ?? 1) - 1, S.lb + 1));
$("lightbox").addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") $("lbPrev").click(); if (e.key === "ArrowRight") $("lbNext").click(); });
