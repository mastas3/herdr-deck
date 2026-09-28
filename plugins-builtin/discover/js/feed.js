"use strict";
// Discover → For you: "Ideas for you", the plan dialog and Saved.
// ── "Ideas for you": the feed of ready-to-execute ideas on For you (server: src/feed.ts) ──────────────
S.feed = { data: load("feedCache", null), loading: false, at: 0, auto: 0, t: null };
const feedIdeas = () => (S.feed.data?.rows ?? []).flatMap((r) => r.ideas);
async function loadFeed(op, row) {
  const f = S.feed;
  clearTimeout(f.t);
  if (f.loading && !op) return;
  f.loading = true;
  try {
    f.data = await api("/api/discover/feed", op ? { op, row } : {}, 20_000);
    f.at = Date.now();
    try { store("feedCache", f.data); } catch {}
  } catch (e) { if (op) toast(e.message, true); }
  f.loading = false;
  feedPatch();
  if (f.data?.running?.length) f.t = setTimeout(() => { if (S.mode === "discover") loadFeed(); }, 2500);
}
/** Only the feed's own region is redrawn while ideas stream in (the rest of For you, and where you swiped the rows to, stay put). */
function feedPatch() {
  if (S.mode !== "discover" || S.disc.tab !== "you") return;
  const el = $("dbody").querySelector("#feed");
  if (!el) return;
  const strips = [...el.querySelectorAll(".fstrip")].map((x) => [x.dataset.row, x.scrollLeft]);
  setHTML(el, feedInner());
  for (const [row, left] of strips) { const x = el.querySelector(`.fstrip[data-row="${row}"]`); if (x && left) x.scrollLeft = left; }
  const v = $("dbody").querySelector(":scope > .view"); if (v) v._h = null;
  feedWatchEnd(el);
}
function mixesForYou() {
  const f = S.feed;
  if (!f.loading && (!f.at || Date.now() - f.at > 60_000)) setTimeout(() => loadFeed(), 0);
  setTimeout(() => feedWatchEnd($("dbody").querySelector("#feed")), 0);
  return `<section class="feed" id="feed">${feedInner()}</section>`;
}
const feedKeys = (x) => `${x.price ? `<span class="fk price">${ICON.coin}${esc(x.price)}</span>` : ""}${x.first_dollar ? `<span class="fk first">First $ in ${esc(x.first_dollar.replace(/^(in|within)\s+/i, ""))}</span>` : ""}`;
function feedCard(x, i) {
  const saved = stSaved(x.id);
  return `<article class="fcard" data-fid="${esc(x.id)}" style="--h:${dHue(x.title)};--i:${Math.min(i, 8)}" tabindex="0">
    <h4>${esc(x.title)}</h4>
    <p class="fpitch">${esc(x.pitch)}</p>
    <div class="fkeys">${feedKeys(x)}${x.source === "template" ? '<span class="msrc">template</span>' : ""}</div>
    <div class="mings">${x.ids.slice(0, 4).map((id, k) => `<span class="ming k-${mixKindOf(id)}">${esc(x.ingredients[k] ?? id)}</span>`).join("")}${x.ids.length > 4 ? `<span class="ming new">+${x.ids.length - 4}</span>` : ""}</div>
    <div class="gacts"><button class="btn primary sm" data-fopen>Open plan</button><button class="btn ghost sm" data-fbuild>Build it now</button><button class="btn ghost sm" data-fsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button></div>
  </article>`;
}
function feedInner() {
  const d = S.feed.data;
  const running = d?.running?.length ?? 0;
  const skel = (n) => Array.from({ length: n }, () => '<div class="fcard skel"></div>').join("");
  const status = !d ? '<span class="spin"></span> Reading what you have…'
    : running ? `<span class="spin"></span> Writing ideas from new combinations… ${d.total} so far`
    : `${d.total} ready-to-build ideas${d.model ? ` · Claude ${esc(d.model[0].toUpperCase() + d.model.slice(1))}` : ""}${d.at ? ` · ${esc(agoText(d.at))}` : ""}${d.dropped ? ` · ${d.dropped} weak ones left out` : ""}`;
  const rows = (d?.rows ?? []).filter((r) => r.ideas.length || r.pending || running);
  return `<div class="fdh"><h3>Ideas for you</h3><span class="hint">${status}</span><span class="spacer"></span><button class="btn ghost sm" data-frefresh ${running ? "disabled" : ""} title="A fresh set of ideas from new combinations">${ICON.shuffle}Fresh set</button><button class="btn ghost sm" data-dtab="mix">${ICON.wild}Studio</button></div>
    ${d?.errors?.length && !d.total ? `<p class="mnote">${ICON.warn}${esc(d.errors[0])}</p>` : ""}
    ${!d ? Array.from({ length: 3 }, () => `<div class="frow"><div class="frh"><h4><span class="stsk w40"></span></h4></div><div class="dstrip fstrip">${skel(3)}</div></div>`).join("")
      : rows.map((r) => `<div class="frow" style="--rh:${r.hue}"><div class="frh"><h4><i></i>${esc(r.label)} <span class="n">${r.ideas.length}</span></h4><span class="spacer"></span><button class="btn ghost sm" data-fmore="${esc(r.id)}" ${r.pending || running >= 5 ? "disabled" : ""}>${r.pending ? '<span class="spin"></span>Writing…' : "More like this"}</button></div>
        <div class="dstrip fstrip" data-row="${esc(r.id)}">${r.ideas.map(feedCard).join("")}${r.pending ? skel(r.ideas.length ? 1 : 3) : ""}</div></div>`).join("")}
    ${d ? `<div class="fend" id="fend"><button class="btn" data-fmore="" ${running >= 5 ? "disabled" : ""}>${running ? '<span class="spin"></span>Writing more ideas…' : `${ICON.plus}More ideas`}</button><span class="hint">Every batch is about a dozen new ideas from new combinations of what you have.</span></div>` : ""}`;
}
/** Endless: reaching the end asks for the next batch (a few times per visit at most: each batch is a model call). */
let feedObs;
function feedWatchEnd(el) {
  const end = el?.querySelector("#fend");
  if (!end || !("IntersectionObserver" in window)) return;
  feedObs?.disconnect();
  feedObs = new IntersectionObserver((es) => {
    const f = S.feed;
    if (!es.some((e) => e.isIntersecting) || f.loading || f.data?.running?.length || f.auto >= 3 || (f.data?.total ?? 0) >= 250 || $("dbody").scrollTop < 200) return;
    f.auto++;
    loadFeed("more");
  }, { root: $("dbody"), rootMargin: "0px 0px 200px 0px" });
  feedObs.observe(end);
}
/** The full plan: who it's for, the offer and price, the MVP, the stack on your things, the first 10 customers, the first week, the risks. */
function planBodyHTML(x) {
  const fact = (k, v) => (v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : "");
  const list = (h, xs, ol) => (xs?.length ? `<h5>${h}</h5><${ol ? "ol" : "ul"} class="plist">${xs.map((s) => `<li>${esc(s)}</li>`).join("")}</${ol ? "ol" : "ul"}>` : "");
  const facts = [fact("Customer", x.customer), fact("Problem", x.problem), fact("Offer", x.offer), fact("Pricing", [x.price, x.model].filter(Boolean).join(" · ")), fact("Cost to run", x.cost), fact("First dollar", x.first_dollar), fact("How it earns", !x.price ? x.money : "")].join("");
  const stack = x.how?.length || x.extra?.length ? `<h5>Stack: what you already have</h5><ul class="mhow">${(x.how ?? []).map((h) => `<li><span class="ming k-${mixKindOf(x.ids[x.ingredients.indexOf(h.name)] ?? "")}">${esc(h.name)}</span> ${esc(h.role)}</li>`).join("")}${(x.extra ?? []).map((e) => `<li><span class="ming new">+ new</span> ${esc(e)}</li>`).join("")}</ul>` : "";
  return `<div class="plan">${facts ? `<dl class="pfacts">${facts}</dl>` : ""}
    ${list("MVP scope", x.mvp)}${stack}${list("First 10 customers", x.launch, true)}${list("First week", x.week?.length ? x.week : x.first_steps, true)}${list("Risks", x.risks)}
    ${x.why_novel ? `<p class="mwhy"><b>Why now</b> ${esc(x.why_novel)}</p>` : ""}</div>`;
}
function openPlan(x, from = "feed") {
  const saved = stSaved(x.id);
  const d = document.createElement("dialog");
  d.className = "plandlg";
  d.innerHTML = `<div class="pdh" style="--h:${dHue(x.title)}"><div class="pdt"><h3>${esc(x.title)}</h3><p>${esc(x.pitch)}</p><div class="fkeys">${feedKeys(x)}<span class="mdiff d-${esc(x.difficulty)}">${esc(MIX_DIFF[x.difficulty] ?? x.difficulty)}</span><span class="mwow" title="Wow ${x.wow} of 5">${"★".repeat(x.wow)}<i>${"★".repeat(5 - x.wow)}</i></span></div>
      <div class="mings">${x.ids.map((id, k) => `<span class="ming k-${mixKindOf(id)}">${esc(x.ingredients[k] ?? id)}</span>`).join("")}</div></div><button class="ib" data-plx aria-label="Close">${ICON.x}</button></div>
    <div class="pdb">${planBodyHTML(x)}</div>
    <div class="pdf"><button class="btn primary" data-plbuild>${ICON.bolt}Build it now</button><button class="btn" data-plplan>${ICON.bulb}Research &amp; plan it</button><button class="btn ghost" data-plusers>Find users for it</button>${from !== "studio" ? `<button class="btn ghost" data-plstudio>${ICON.wild}Open in Studio</button>` : ""}<button class="btn ghost" data-plsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button><button class="btn ghost" data-plcopy>${ICON.copy}Copy</button></div>`;
  document.body.append(d);
  d.addEventListener("close", () => motion.drop(d));
  d.addEventListener("click", (e) => {
    const t = e.target;
    if (t === d || t.closest("[data-plx]")) return d.close();
    if (t.closest("[data-plbuild]")) { d.close(); return stBuildNow(x); }
    if (t.closest("[data-plplan]")) { d.close(); return mixResearch(x); }
    if (t.closest("[data-plusers]")) { d.close(); return stFindUsers(x); }
    if (t.closest("[data-plstudio]")) { d.close(); return mixOpenWith(mixFromCard(x), { text: `Take “${x.title}” further: ${x.pitch}`, toastText: "Opened in the Studio" }); }
    if (t.closest("[data-plcopy]")) return copy(mixText(x), "the plan");
    const sv = t.closest("[data-plsave]");
    if (sv) mixSave(x).then(() => { const s = stSaved(x.id); sv.setAttribute("aria-pressed", String(s)); sv.textContent = s ? "Saved" : "Save"; feedPatch(); });
  });
  d.showModal();
  d.querySelector(".pdb").scrollTop = 0;
  deckPlugins.each("discover.plan", d, x, from); // other plugins add to the open dialog (covers paints its cover on top)
}
function discSaved(d, n) {
  if (!n) return `<div class="empty-state">Nothing saved yet. <b>Save</b> a gem, a mix or a Studio build to keep it here.</div>`;
  const mixes = d.mixes?.saved ?? [];
  return `${mixes.length ? `<h3 class="dsub">Builds &amp; mixes <span class="hint">ideas you kept from the Studio</span></h3><div class="mgrid">${mixes.map((x, i) => mixCard(x, i, "sv")).join("")}</div>` : ""}
    ${d.saved.length ? `<h3 class="dsub">Repos <span class="hint">they stay here until you remove them</span></h3><div class="dgrid">${d.saved.map((g, i) => gemCard(g, i, { saved: true })).join("")}</div>` : ""}`;
}
