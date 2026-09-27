// Gallery: getting around. Taps and clicks, the keyboard (arrows move between cards and lanes, Enter opens, Home/End),
// the desktop lane arrows, and lanes that render their first cards and add more as you scroll toward the end
// (so a hundred-card day stays light). Swiping is the strips' own scrolling, snapped to cards.
function galWire(n) {
  n.addEventListener("toggle", e => { if (e.target.matches?.("[data-galarchive]")) S.gal.archiveOpen = e.target.open; }, true);
  n.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-galretry]")) return galLoad();
    if (t.closest("[data-galfind]")) return galFindProblems(t.closest("[data-galsearch]"));
    const more = t.closest("[data-galmore]");
    if (more) return galMore(more.dataset.galmore);
    const sc = t.closest("[data-galscroll]");
    if (sc) { const s = sc.closest(".gallane").querySelector(".galstrip"); return s.scrollBy({ left: Number(sc.dataset.galscroll) * s.clientWidth * 0.85, behavior: reduceMotion.matches ? "auto" : "smooth" }); }
    const proj = t.closest("[data-galproject]");
    if (proj) return openJourney(proj.dataset.galproject);
    const hero = t.closest(".galhero[data-gid]");
    if (hero) {
      const id = hero.dataset.gid;
      if (t.closest("[data-galplay]")) return galPlayFlow(id);
      if (t.closest("[data-galsave]")) return galSave(id);
      if (t.closest("[data-galopen], .galhcov")) return galOpen(id);
      return;
    }
    const card = t.closest(".galcard[data-gid]");
    if (card) return galOpen(card.dataset.gid, card.closest("[data-lane]")?.dataset.lane);
    const fc = t.closest(".galcard[data-fid]");
    if (fc) { const x = feedIdeas().find((y) => y.id === fc.dataset.fid); if (x) openPlan(x); }
  });
  n.addEventListener("keydown", (e) => {
    const card = e.target.closest?.(".galcard");
    const inHero = e.target.closest?.(".galhero");
    if (!card && !inHero) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (card && (k === "Enter" || k === " ")) { e.preventDefault(); e.stopPropagation(); return card.click(); }
    const strip = card?.closest(".galstrip");
    const cards = strip ? [...strip.querySelectorAll(".galcard:not(.skel)")] : [];
    const i = cards.indexOf(card);
    let to;
    if (card && (k === "ArrowRight" || k === "ArrowLeft")) {
      if (k === "ArrowRight" && i === cards.length - 1 && galGrow(strip)) { e.preventDefault(); e.stopPropagation(); return requestAnimationFrame(() => galFocus(strip.querySelectorAll(".galcard:not(.skel)")[i + 1])); }
      to = cards[Math.max(0, Math.min(cards.length - 1, i + (k === "ArrowRight" ? 1 : -1)))];
    } else if (card && (k === "Home" || k === "End")) to = k === "Home" ? cards[0] : cards[cards.length - 1];
    else if (k === "ArrowDown" || k === "ArrowUp") {
      const strips = [...n.querySelectorAll(".galstrip")];
      const si = strip ? strips.indexOf(strip) : -1;
      const next = k === "ArrowDown" ? strips[si + 1] : si > 0 ? strips[si - 1] : null;
      if (!next && k === "ArrowUp" && card) to = n.querySelector(".galhero [data-galopen].btn");
      else if (next) {
        // The card in the next lane that sits under this one.
        const x = (card ?? e.target).getBoundingClientRect().left;
        to = [...next.querySelectorAll(".galcard:not(.skel)")].reduce((b, c) => (!b || Math.abs(c.getBoundingClientRect().left - x) < Math.abs(b.getBoundingClientRect().left - x) ? c : b), null);
      }
    } else return;
    e.preventDefault(); e.stopPropagation();
    if (to) galFocus(to);
  });
  // Scroll doesn't bubble: listen in the capture phase for every strip at once.
  n.addEventListener("scroll", (e) => { const s = e.target; if (s.classList?.contains("galstrip") && s.scrollLeft + s.clientWidth > s.scrollWidth - s.clientWidth * 0.6) galGrow(s); }, { capture: true, passive: true });
}
/** Render the next batch of a lane's cards; false when they're all there. */
function galGrow(strip) {
  const lane = strip.dataset.lane, total = Number(strip.dataset.total) || 0;
  const n = S.gal.shown.get(lane) ?? GAL_FIRST_LANE;
  if (n >= total) return false;
  S.gal.shown.set(lane, n + 12);
  galPaint();
  return true;
}
function galFocus(el) {
  if (!el) return;
  S.gal.node.querySelectorAll('.galcard[tabindex="0"]').forEach((c) => c !== el && c.setAttribute("tabindex", "-1"));
  if (el.matches(".galcard")) el.setAttribute("tabindex", "0");
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
}
/** After each paint: exactly one card is in the tab order (the focused one, else the first), so Tab enters the gallery once. */
function galObserve(n) {
  if (n.querySelector('.galcard[tabindex="0"]')) return;
  n.querySelector(".galcard:not(.skel)")?.setAttribute("tabindex", "0");
}
