"use strict";
// Discover → Leads: clicks, typing and deep dives.
// A deep dive that actually started shows under Reports right away, as "Researching".
$("newDlg").addEventListener("close", () => {
  const p = S.leads.pendingReport;
  S.leads.pendingReport = null;
  if (!p || $("newDlg").returnValue !== "ok" || !$("nPrompt").value.includes(`leads/${p.slug}.md`)) return;
  api("/api/leads/report-started", p).then((r) => { if (S.leads.st) S.leads.st.reports = r.reports; leadsPatch(); }).catch(() => {});
});
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "discover" || S.disc.tab !== "leads") return;
  const t = e.target, L = S.leads;
  const d = t.closest("[data-ldir]")?.dataset.ldir;
  if (d) {
    L.dir = d; store("leadsDir", d);
    const ta = $("dbody").querySelector("[data-lq]"); if (ta) ta.placeholder = LDIR[d].ph;
    const gl = $("dbody").querySelector("[data-lgolabel]"); if (gl) gl.textContent = LDIR[d].go;
    return leadsPatch();
  }
  if (t.closest("[data-lgo]")) return leadsSearch($("dbody").querySelector("[data-lq]")?.value, L.dir);
  if (t.closest("[data-ldeep]")) return leadsDeep();
  if (t.closest("[data-lrefresh]")) return leadsSearch(L.res?.text ?? L.text, L.res?.dir ?? L.dir, true);
  if (t.closest("[data-lmore]")) { L.more = true; return leadsPatch(); }
  if (t.closest("[data-lshuffle]")) { L.seed++; return leadsLoad(); }
  if (t.closest("[data-lsurprise]")) {
    try {
      const r = await api("/api/leads/surprise", { seed: Date.now() % 100000 });
      const ta = $("dbody").querySelector("[data-lq]"); if (ta) ta.value = r.text;
      L.dir = r.dir; store("leadsDir", r.dir);
      const gl = $("dbody").querySelector("[data-lgolabel]"); if (gl) gl.textContent = LDIR[r.dir].go;
      if (ta) ta.placeholder = LDIR[r.dir].ph;
      return leadsSearch(r.text, r.dir);
    } catch (err) { return toast(err.message, true); }
  }
  const st = t.closest("[data-lstart]");
  if (st) {
    const dir = st.dataset.sdir === "audience" ? "audience" : "idea";
    const ta = $("dbody").querySelector("[data-lq]"); if (ta) { ta.value = st.dataset.lstart; ta.placeholder = LDIR[dir].ph; }
    const gl = $("dbody").querySelector("[data-lgolabel]"); if (gl) gl.textContent = LDIR[dir].go;
    $("dbody").scrollTo?.({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return leadsSearch(st.dataset.lstart, dir);
  }
  const th = t.closest("[data-lth]");
  if (th && L.res) {
    const theme = (L.res.themes ?? []).find((x) => x.id === th.dataset.lth);
    if (!theme) return;
    const quotes = lThemeQuotes(theme);
    if (t.closest("[data-lthopen]")) { if (L.open.has(theme.id)) L.open.delete(theme.id); else L.open.add(theme.id); return leadsPatch(); }
    if (t.closest("[data-lplan]")) {
      const places = [...new Set(quotes.map((q) => q.where?.label).filter(Boolean))];
      return leadsPlan({ label: theme.title, idea: theme.idea, catLabel: theme.catLabel, n: theme.n, quotes }, L.res.text, L.res.dir, places);
    }
    if (t.closest("[data-lresearch]")) {
      const idea = L.res.dir === "audience" ? theme.idea : `${L.res.text}: ${theme.idea}`;
      // The Idea lab searches on the way; as soon as its dialog is up, Leads comes back underneath it.
      const back = () => { if (S.disc.tab !== "leads") { S.disc.tab = "leads"; store("discTab", "leads"); renderDiscover(); } };
      const watch = setInterval(() => { if ($("newDlg").open) { clearInterval(watch); back(); } }, 80);
      try { await ideaResearch(idea); } finally { clearInterval(watch); back(); }
      return;
    }
    if (t.closest("[data-lsave]")) {
      const id = lSaveId(theme);
      const on = (L.st?.saved ?? []).some((x) => x.id === id);
      await leadsSaveOp(on ? "unsave" : "save", { id, label: theme.title, cat: theme.cat, catLabel: theme.catLabel, idea: theme.idea, text: L.res.text, dir: L.res.dir, n: theme.n, quotes: quotes.slice(0, 5).map((q) => ({ snippet: q.snippet, url: q.url, source: q.source, author: q.author, at: q.at })) });
      return toast(on ? "Removed from saved leads" : "Saved under Saved leads");
    }
    if (t.closest("[data-lcopy]")) return copy(lEvidenceText(theme.title, theme.idea, quotes, `${L.res.dir === "audience" ? "Audience" : "Idea"}: ${L.res.text}`), "evidence");
    return;
  }
  const sv = t.closest("[data-lsv]");
  if (sv) {
    const x = (L.st?.saved ?? []).find((y) => y.id === sv.dataset.lsv);
    if (!x) return;
    if (t.closest("[data-lsvdel]")) return leadsSaveOp("unsave", { id: x.id });
    if (t.closest("[data-lsvcopy]")) return copy(lEvidenceText(x.label, x.idea, x.quotes, `${x.dir === "audience" ? "Audience" : "Idea"}: ${x.text}`), "evidence");
    if (t.closest("[data-lsvopen]")) { const ta = $("dbody").querySelector("[data-lq]"); if (ta) ta.value = x.text; return leadsSearch(x.text, x.dir); }
    if (t.closest("[data-lsvplan]")) return leadsPlan({ label: x.label, idea: x.idea, catLabel: x.catLabel, n: x.n, quotes: x.quotes }, x.text, x.dir, []);
    return;
  }
  const rp = t.closest("[data-lrep]");
  if (rp) {
    const slug = rp.dataset.lrep;
    const sess = t.closest("[data-lrepsess]")?.dataset.lrepsess;
    if (sess) { setMode(null); return select(sess, { scroll: true, open: true }); }
    if (t.closest("[data-lrepcopy]")) return copy(`~/.config/herdr-deck/leads/${slug}.md`, "path");
    if (t.closest("[data-lrepforget]")) { try { const r = await api("/api/leads/report-forget", { slug }); if (L.st) L.st.reports = r.reports; leadsPatch(); } catch (err) { toast(err.message, true); } return; }
    if (t.closest("[data-lrepopen]")) {
      L.report = L.report === slug ? null : slug;
      leadsPatch();
      if (L.report && !L.reports.has(slug)) {
        try { L.reports.set(slug, await api("/api/leads/report", { slug })); } catch (err) { toast(err.message, true); L.report = null; }
        leadsPatch();
      }
      $("dbody").querySelector(`[data-lrep="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }
});
$("dbody").addEventListener("input", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-lq]")) return;
  S.leads.text = e.target.value;
  clearTimeout(S.leads.saveT);
  S.leads.saveT = setTimeout(() => store("leadsText", S.leads.text), 300);
});
$("dbody").addEventListener("keydown", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-lq]") || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (e.metaKey || e.ctrlKey) leadsDeep(); else leadsSearch(e.target.value, S.leads.dir);
});
// ══ end Leads ════════════════════════════════════════════════════════════════
