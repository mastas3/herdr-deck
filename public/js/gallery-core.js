// ══ Gallery: Discover → For you ══════════════════════════════════════════════════════════════════════
// Today's top pick and Netflix-style lanes of ideas from the idea engine (server: src/gallery-server.ts,
// src/ideagen/). Loaded after app.js and shares its globals (S, $, api, esc, toast, openPlan, startRun…).
// This file: state, loading (today's run starts when Discover opens, with progress), the lanes model, and mounting.
// The gallery is one persistent element that For you re-attaches on every redraw, so images, scroll positions and
// focus survive Discover's background updates. Cards: gallery-cards.js; keys and lazy rows: gallery-nav.js;
// the idea sheet: gallery-detail.js; the starter kit: gallery-kit.js; Play: gallery-play.js.
S.gal = { data: load("galCache", null), loading: false, at: 0, t: null, node: null, html: "", full: new Map(), kits: new Map(), kitJobs: new Map(), more: new Set(), shown: new Map(), err: "" };
const galKitId = (id) => String(id).replace(/[^\w.-]+/g, "_");
const galOn = () => S.mode === "discover" && S.disc.tab === "you";

async function galLoad(opts = {}) {
  const g = S.gal;
  clearTimeout(g.t); g.t = null;
  if (g.loading && !opts.force) return;
  g.loading = true;
  try {
    g.data = await api("/api/ideas/state", { ensure: opts.ensure !== false }, 20_000);
    g.at = Date.now(); g.err = "";
    try { store("galCache", g.data); } catch {}
  } catch (e) { g.err = e.message; }
  g.loading = false;
  galPaint();
  // While today's ideas are being written, check back every few seconds (only while you're looking).
  if (g.data?.job?.running) g.t = setTimeout(() => { g.t = null; if (galOn() && !document.hidden) galLoad(); }, 3000);
}
/** An idea by id from what the page has: today's lanes, then Saved. */
const galIdea = (id) => S.gal.data?.ideas?.[id] ?? (S.gal.data?.saved ?? []).find((x) => x.id === id);
const galPlaying = (id) => S.gal.data?.playing?.[id];
const galHasKit = (id) => S.gal.kits.has(id) || (S.gal.data?.kits ?? []).includes(galKitId(id));
const galSaved = (id) => (S.gal.data?.saved ?? []).some((x) => x.id === id);

/** The lanes: the engine's, then "Fresh from Studio" (the older feed, kept working) and "Saved". */
function galLanes() {
  const d = S.gal.data;
  if (!d) return [];
  const hero = (d.lanes ?? []).find((l) => l.id === "top")?.ideas.find((id) => d.ideas[id]?.quality > 0);
  // The hero is today's top pick; its lane starts with the next one.
  const lanes = (d.lanes ?? []).map((l) => ({ ...l, kind: "idea", items: l.ideas.filter((id) => !(l.id === "top" && id === hero)).map((id) => d.ideas[id]).filter((x) => x && x.quality > 0) })).filter((l) => l.items.length);
  const feed = typeof feedIdeas === "function" ? feedIdeas().filter((x) => x.source !== "template").sort((a, b) => (b.score ?? 6.5) - (a.score ?? 6.5)) : [];
  if (feed.length || S.feed?.data?.running?.length) lanes.push({ id: "fresh", kind: "feed", title: "Fresh from Studio", subtitle: "Quick ideas from new combinations of what you have", items: feed, more: true });
  if (d.saved?.length) lanes.push({ id: "saved", kind: "idea", title: "Saved", subtitle: "Ideas you kept", items: d.saved, more: false });
  return lanes;
}
/** Today's top pick: the first card of "Top picks". */
const galHero = () => { const d = S.gal.data; const id = d?.lanes?.find((l) => l.id === "top")?.ideas.find((x) => d.ideas[x]?.quality > 0); return id ? d.ideas[id] : galLanes().find((l) => l.kind === "idea")?.items[0]; };

// ── the run's progress, in words ──
const GAL_PHASE = { inputs: "Reading what you have", evidence: "Collecting what people say they need", trends: "Checking what's trending this week", writing: "Writing ideas", judging: "Judging them", premortem: "Stress-testing the best ones", cards: "Mapping connectors" };
const GAL_WEIGHT = { inputs: [0, 4], evidence: [4, 30], trends: [30, 40], writing: [40, 70], judging: [70, 88], premortem: [88, 98], cards: [98, 100] };
function galProgress(j) {
  const [a, b] = GAL_WEIGHT[j.phase] ?? [0, 100];
  const f = j.total ? Math.min(1, j.done / j.total) : 0.3;
  return Math.round(a + (b - a) * f);
}
function galStatusHTML() {
  const d = S.gal.data, j = d?.job;
  const when = d?.galleryDay ? new Date(`${d.galleryDay}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : "";
  const src = d?.source === "lab" ? "the idea lab's picks are shown" : d?.source === "earlier" ? `${esc(when)}'s ideas are shown` : "";
  if (j?.running) {
    const step = `${GAL_PHASE[j.phase] ?? "Working"}${j.total ? ` (${Math.min(j.done, j.total)} of ${j.total})` : ""}${j.step ? `: ${esc(j.step)}` : ""}`;
    return `<div class="galrun" role="status"><div class="galbar"><i style="width:${galProgress(j)}%"></i></div>
      <p><b>Writing today's ideas.</b> ${step}. <span class="hint">Started ${esc(agoText(j.startedAt))}${src ? `; ${src} meanwhile` : ""}.</span></p></div>`;
  }
  if (j?.status === "error" && d?.source !== "today") return `<div class="galrun err" role="status"><p>${ICON.warn}<span><b>Today's run stopped:</b> ${esc(j.error ?? "")}${src ? `. For now ${src}.` : ""}</span></p><button class="btn sm" data-galretry>Try again</button></div>`;
  if (S.gal.err && !d) return `<div class="galrun err"><p>${ICON.warn}<span>${esc(S.gal.err)}</span></p><button class="btn sm" data-galretry>Try again</button></div>`;
  return "";
}

// ── mounting: For you gets a slot; the persistent gallery element goes into it ──
function galleryHTML() {
  if (!S.gal.loading && (!S.gal.at || Date.now() - S.gal.at > 60_000)) setTimeout(() => galLoad(), 0);
  // "Fresh from Studio" is the old feed: it still loads (and generates) the same way.
  if (typeof loadFeed === "function" && !S.feed.loading && (!S.feed.at || Date.now() - S.feed.at > 60_000)) setTimeout(() => loadFeed(), 0);
  return '<div id="galslot"></div>';
}
function galMount() {
  const slot = $("dbody").querySelector("#galslot");
  if (!slot) return;
  const n = galNode();
  const lefts = [...n.querySelectorAll(".galstrip")].map((x) => [x.dataset.lane, x.scrollLeft]);
  slot.replaceWith(n);
  for (const [lane, left] of lefts) { const x = n.querySelector(`.galstrip[data-lane="${lane}"]`); if (x && left) x.scrollLeft = left; }
  galPaint();
}
function galNode() {
  if (S.gal.node) return S.gal.node;
  const n = document.createElement("section");
  n.id = "gal"; n.className = "gal";
  n.setAttribute("aria-label", "Ideas for you");
  S.gal.node = n;
  if (typeof galWire === "function") galWire(n);
  return n;
}
/** Redraw the gallery when what it shows changed; keeps where each lane was swiped to and which card had focus. */
function galPaint() {
  const n = S.gal.node;
  if (!n || !n.isConnected) return;
  const lanes = galLanes();
  const hero = galHero();
  const d = S.gal.data;
  const html = !d && !S.gal.err ? galSkeleton()
    : `${hero ? galHeroHTML(hero) : ""}${galStatusHTML()}${lanes.map((l) => galLaneHTML(l)).join("")}${!lanes.length && d ? `<div class="empty-state">No ideas yet.${d.job?.running ? " Today's are being written." : ""}</div>` : ""}`;
  if (html === S.gal.html) return galAfterPaint(n);
  const lefts = new Map([...n.querySelectorAll(".galstrip")].map((x) => [x.dataset.lane, x.scrollLeft]));
  const focus = document.activeElement?.closest?.("#gal [data-gid], #gal [data-fid]");
  const fkey = focus && [focus.closest("[data-lane]")?.dataset.lane ?? "", focus.dataset.gid ?? focus.dataset.fid];
  n.innerHTML = html;
  S.gal.html = html;
  for (const [lane, left] of lefts) { const x = n.querySelector(`.galstrip[data-lane="${lane}"]`); if (x && left) x.scrollLeft = left; }
  if (fkey) n.querySelector(`[data-lane="${CSS.escape(fkey[0])}"] :is([data-gid="${CSS.escape(fkey[1])}"], [data-fid="${CSS.escape(fkey[1])}"])`)?.focus({ preventScroll: true });
  galAfterPaint(n);
}
function galAfterPaint(n) { if (typeof galObserve === "function") galObserve(n); }
function galSkeleton() {
  const card = '<div class="galcard skel"><div class="galcov"></div><div class="galtxt"><span class="stsk w70"></span><span class="stsk w40"></span></div></div>';
  return `<div class="galhero skel"><div class="galhtxt"><span class="stsk w40"></span><span class="stsk w70"></span></div><div class="galhcov"></div></div>${[1, 2].map(() => `<div class="gallane"><div class="gallh"><h3><span class="stsk w40"></span></h3></div><div class="galstrip">${card.repeat(4)}</div></div>`).join("")}`;
}

// ── actions shared by the cards, the hero and the sheet ──
async function galSave(id) {
  const op = galSaved(id) ? "unsave" : "save";
  try {
    const r = await api("/api/ideas/save", { id, op });
    S.gal.data.saved = r.saved;
    toast(op === "save" ? "Saved" : "Removed from Saved");
    galPaint(); if (typeof galSheetRefresh === "function") galSheetRefresh();
  } catch (e) { toast(e.message, true); }
}
async function galMore(laneId) {
  if (laneId === "fresh") return loadFeed("more");
  if (S.gal.more.has(laneId)) return;
  if (S.gal.data?.source !== "today") return toast(S.gal.data?.job?.running ? "More works once today's ideas are in." : "More needs today's ideas; they're written when Discover opens.", true);
  S.gal.more.add(laneId); galPaint();
  try { S.gal.data = await api("/api/ideas/more", { lane: laneId }, 300_000); toast("New ideas added to the lane"); }
  catch (e) { toast(e.message, true); }
  S.gal.more.delete(laneId); galPaint();
}
/** Full card (evidence, connectors, pre-mortem): fetched once per idea. */
async function galFull(id) {
  if (S.gal.full.has(id)) return S.gal.full.get(id);
  const c = await api("/api/ideas/card", { id }, 20_000);
  S.gal.full.set(id, c);
  return c;
}

// ── hooks: For you redraws re-attach the gallery; the old feed's updates redraw its lane ──
{
  const rd0 = renderDiscover;
  renderDiscover = function (...a) { const r = rd0.apply(this, a); if (S.mode === "discover") galMount(); return r; };
  const fp0 = feedPatch;
  feedPatch = function (...a) { const r = fp0.apply(this, a); if (galOn()) galPaint(); return r; };
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && galOn() && S.gal.data?.job?.running && !S.gal.t) galLoad(); });
