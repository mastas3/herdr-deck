// Gallery: an idea, opened. A side panel on a desktop, a bottom sheet on a phone (swipe it down to close). Everything
// on the card: who buys and where they gather, their pain in their words with the posts, the offer, the stack mapped
// to what you own, the pre-mortem, trend signals, missing connectors with one-tap actions, the scores, and the kit.
S.gal.sheet = null;
function galOpen(id, lane) {
  const x = galIdea(id);
  if (!x) return;
  S.gal.sheet?.dlg.close();
  const dlg = document.createElement("dialog");
  dlg.className = "galdlg";
  dlg.setAttribute("aria-label", x.name);
  dlg.innerHTML = `<div class="galsh" tabindex="-1"><div class="galgrab" aria-hidden="true"></div><button class="ib galx" data-galx aria-label="Close">${ICON.x}</button><div class="galshb"></div></div>`;
  document.body.append(dlg);
  S.gal.sheet = { id, lane, dlg };
  dlg.addEventListener("close", () => { dlg.remove(); if (S.gal.sheet?.dlg === dlg) S.gal.sheet = null; S.gal.node?.querySelector(`[data-gid="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); });
  dlg.addEventListener("click", (e) => galSheetClick(e, dlg));
  galSwipeClose(dlg);
  galSheetRefresh();
  dlg.showModal();
  dlg.querySelector(".galsh").focus({ preventScroll: true });
  galFull(id).then(() => galSheetRefresh()).catch((e) => toast(e.message, true));
  if (galHasKit(id) && !S.gal.kits.has(id)) galKitLoad(id);
}
function galSheetRefresh() {
  const s = S.gal.sheet;
  if (!s) return;
  const c = S.gal.full.get(s.id) ?? galIdea(s.id);
  const body = s.dlg.querySelector(".galshb");
  const html = galSheetHTML(c, !S.gal.full.has(s.id));
  if (body._h !== html) { body.innerHTML = html; body._h = html; }
}
const galSec = (title, inner, cls = "") => (inner ? `<section class="galsec ${cls}"><h3>${title}</h3>${inner}</section>` : "");
const galHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
function galSheetHTML(c, partial) {
  const p = galPlaying(c.id);
  const lane = S.gal.data?.lanes?.find((l) => l.id === S.gal.sheet?.lane);
  const stat = (k, v, t) => (v ? `<div${t ? ` title="${esc(t)}"` : ""}><dt>${k}</dt><dd>${v}</dd></div>` : "");
  const head = `${galCoverHTML(c, true, galBadges(c))}
    <header class="galshh"><p class="galkick">${esc(lane?.title ?? "Idea")}${c.premortem?.pivotedFrom || c.pivoted ? " · revised after a pre-mortem" : ""}</p>
      <h2>${esc(c.name)}</h2><p class="galhook">${esc(c.hook)}</p>
      <dl class="galstats">${stat("Price", esc(galPriceShort(c.price)), c.price)}${stat("First $", c.timeToFirstDollarDays > 0 ? `~${c.timeToFirstDollarDays} days` : "")}${stat("≥10 paying in 60 days", typeof c.jevP10 === "number" ? galPct(c.jevP10) : "", "Jev's estimate")}${stat("Quality", galQ(c.quality), "After judging, 0–100")}</dl>
      <div class="galhacts"><button class="btn primary" data-galplay>${p ? "Playing" : "Play this idea"}</button><button class="btn" data-galkitgo>${galHasKit(c.id) ? "Starter kit" : "Build the kit"}</button><button class="btn ghost" data-galsave aria-pressed="${galSaved(c.id)}">${galSaved(c.id) ? "Saved" : "Save"}</button><button class="btn ghost" data-galcopy>${ICON.copy ?? ""}Copy</button></div>
      ${p ? `<p class="galplaying"><span class="galbadge play">Playing</span> since ${esc(agoText(p.at))} in <code>${esc(p.dir.replace(/^\/(?:Users|home)\/[^/]+/, "~"))}</code> · <button class="link" data-galproject="${esc(p.slug)}">Project page</button> · <button class="link" data-galquests>Quest board</button></p>` : ""}
    </header>`;
  if (partial) return `${head}<div class="galsec"><span class="stsk w70"></span><span class="stsk w40"></span></div>`;
  const ev = (c.evidence ?? []).map((e) => `<li><a class="galev" href="${esc(e.url)}" target="_blank" rel="noopener"><q>${esc(String(e.snippet).replace(/^…\s*|\s*…$/g, ""))}</q><span>${esc(e.source)} · ${esc(galHost(e.url))}</span></a></li>`).join("");
  const stack = (c.stack ?? []).map((s) => `<li><span class="galo${s.owned ? "" : " new"}">${esc(s.name)}</span><span>${esc(s.role)}</span>${s.owned ? "" : '<span class="hint">to add</span>'}</li>`).join("");
  const pm = c.premortem;
  const pmHTML = pm ? `${pm.pivotedFrom ? `<p class="galpiv">Rewritten from <b>${esc(pm.pivotedFrom.name)}</b>: ${esc(pm.pivotedFrom.hook)}</p>` : ""}
    <ol class="galfail">${pm.failures.map((f) => `<li><p>${esc(f.reason)}</p>${f.pattern ? `<span class="galpat">${esc(f.pattern)}</span>` : ""}</li>`).join("")}</ol>
    <p class="galfix"><b>How this version fixes it</b> ${esc(pm.fix)}</p>` : "";
  const tr = c.trend ? `<p><b>${esc(c.trend.label)}</b>${c.trend.whyNow ? ` · ${esc(c.trend.whyNow)}` : ""}</p><ul class="galsig">${c.trend.signals.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="hint">${esc(s.source)}</span></li>`).join("")}</ul>` : "";
  const r = c.rubric;
  const scores = `<dl class="galscores">${stat("Quality", galQ(c.quality))}${stat("Jev, ≥10 paying", typeof c.jevP10 === "number" ? galPct(c.jevP10) : "")}${stat("Evidence", typeof c.evidenceScore === "number" ? galPct(c.evidenceScore) : "")}${stat("Success patterns", typeof c.patterns === "number" ? `${Math.round(c.patterns * 8)} of 8` : "", "How many of the eight success patterns Jev sees in it")}${r ? ["spec", "feasible", "buyer", "distribution", "novelty"].map((k) => stat(k[0].toUpperCase() + k.slice(1), `${r[k]}/5`)).join("") : ""}</dl>${r?.flaw ? `<p class="hint">Biggest flaw the rubric saw: ${esc(r.flaw)}</p>` : ""}`;
  return `${head}
    ${galSec("Who buys it", `<p>${esc(c.buyer)}</p>${c.channel ? `<p class="galwhere"><b>First customers</b> ${esc(c.channel)}</p>` : ""}`)}
    ${galSec("In their words", `${c.pain ? `<p>${esc(c.pain.replace(/\s*\((?:[a-z]+:[^)]*)\)/gi, ""))}</p>` : ""}${ev ? `<ul class="galevs">${ev}</ul>` : ""}`)}
    ${galSec("The offer", `<p>${esc(c.offer)}</p><dl class="galkv"><div><dt>Price</dt><dd>${esc(c.price)}</dd></div><div><dt>MVP</dt><dd>${esc(c.mvp)}</dd></div></dl>`)}
    ${galSec("Built on what you have", stack ? `<ul class="galstack">${stack}</ul>` : "")}
    ${galSec("Why this could fail → how this version fixes it", pmHTML)}
    ${galSec("Why now", tr)}
    ${galSec("Connectors", galConnHTML(c))}
    ${galSec("Scores", scores, "galsc2")}
    <section class="galsec galkit" id="galkit">${galKitHTML(c)}</section>`;
}
/** Each capability: what you have, or what's missing with one-tap actions. */
function galConnHTML(c) {
  // What's missing first: that's where the one-tap actions are.
  const rows = [...(c.connectors ?? [])].sort((a, b) => Number(b.missing) - Number(a.missing)).map((x) => {
    if (!x.missing) return `<li class="have"><b>${esc(x.label)}</b><span>${x.have.slice(0, 3).map((h) => `<span class="galo">${esc(h.name)}</span>`).join("")}</span></li>`;
    const sug = x.suggestions.slice(0, 3).map((s, i) => `<div class="galsug"><p><b>${esc(s.name)}</b> <span class="hint">${esc(s.type)}${s.free ? ` · ${esc(s.free)}` : ""}</span><br>${esc(s.why)}</p>
      <div class="galsuga">${s.type === "repo" && s.url ? `<a class="btn sm" href="${esc(s.url)}" target="_blank" rel="noopener">Open on GitHub</a>` : ""}${s.type === "service" ? `<button class="btn sm" data-galconn="${esc(s.name)}">Open in Connections</button>${s.url ? `<a class="btn ghost sm" href="${esc(s.url)}" target="_blank" rel="noopener">Site</a>` : ""}` : ""}<button class="btn ghost sm" data-galtray="${esc(x.cap)}|${i}">Add to Studio tray</button></div></div>`).join("");
    return `<li class="miss"><b>${esc(x.label)}</b><span class="galmiss">missing</span>${sug}</li>`;
  }).join("");
  return rows ? `<ul class="galconn">${rows}</ul>` : "";
}
function galText(c) {
  return [`${c.name}: ${c.hook}`, "", `Buyer: ${c.buyer}`, `Pain: ${c.pain}`, `Offer: ${c.offer}`, `Price: ${c.price}`, `First channel: ${c.channel}`, `MVP: ${c.mvp}`,
    `Stack: ${(c.stack ?? []).map((s) => `${s.name}${s.owned ? "" : " (new)"}`).join(", ")}`, ...(c.evidence ?? []).map((e) => `Evidence: ${e.url}`)].join("\n");
}
function galSheetClick(e, dlg) {
  const t = e.target, s = S.gal.sheet;
  if (!s) return;
  if (t === dlg || t.closest("[data-galx]")) return dlg.close();
  const c = S.gal.full.get(s.id) ?? galIdea(s.id);
  if (t.closest("[data-galplay]")) return galPlayFlow(s.id);
  if (t.closest("[data-galsave]")) return galSave(s.id);
  if (t.closest("[data-galcopy]")) return copy(galText(c), "the idea");
  if (t.closest("[data-galkitgo]")) { dlg.querySelector("#galkit")?.scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "auto" : "smooth" }); if (!galHasKit(s.id)) galKitBuild(s.id); return; }
  const proj = t.closest("[data-galproject]");
  if (proj) { dlg.close(); return openJourney(proj.dataset.galproject); }
  if (t.closest("[data-galquests]")) { dlg.close(); return openQuests(); }
  const conn = t.closest("[data-galconn]");
  if (conn) { dlg.close(); S.conn.cat = "recommended"; S.conn.q = conn.dataset.galconn; S.conn.open = null; return openConnections(); }
  const tray = t.closest("[data-galtray]");
  if (tray) {
    const [cap, i] = tray.dataset.galtray.split("|");
    const sg = c.connectors?.find((x) => x.cap === cap)?.suggestions[Number(i)];
    if (!sg) return;
    const ing = { id: `gal:${cap}:${galKitId(sg.name)}`, kind: sg.type === "repo" ? "repo" : "conn", name: sg.name, desc: sg.why };
    if (!S.disc.mix.sel.some((y) => y.name === ing.name)) mixSetSel([...S.disc.mix.sel, ing]);
    return toast(`Added “${sg.name}” to the Studio tray`);
  }
  if (typeof galKitClick === "function") galKitClick(e, s.id);
}
/** Phone: drag the sheet's top edge down to close it. */
function galSwipeClose(dlg) {
  let y0 = null, dy = 0;
  const sh = dlg.querySelector(".galsh");
  dlg.addEventListener("touchstart", (e) => { y0 = sh.scrollTop <= 0 && e.target.closest(".galgrab, .galcov, .galshh") ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  dlg.addEventListener("touchmove", (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = dy ? `translateY(${dy}px)` : ""; }, { passive: true });
  dlg.addEventListener("touchend", () => { if (y0 == null) return; sh.style.transform = ""; if (dy > 110) dlg.close(); y0 = null; });
}
