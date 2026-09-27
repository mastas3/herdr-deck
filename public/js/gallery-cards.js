// Gallery: the hero, lanes and cards as HTML (gallery-core.js decides what to show). Covers come from the covers job
// (src/covers.ts) by each idea's coverId; until one is painted a card gets a typographic cover in its category's
// print colours. Cards show recorded evidence stages; model confidence is never presented as demand.
const GAL_PAL = { money: ["#00A95C", "#F15060", "#F4EEE2"], saas: ["#0078BF", "#FFD400", "#F4EEE2"], automations: ["#00838A", "#FF6C2F", "#F4EEE2"], content: ["#F15060", "#3D5588", "#F4EEE2"], projects: ["#A75154", "#5EC8E5", "#F4EEE2"], gem: ["#3255A4", "#82D8D5", "#F4EEE2"], weekend: ["#FFB511", "#2E2E2E", "#F4EEE2"], wild: ["#FF48B0", "#00A95C", "#F4EEE2"] };
const GAL_FIRST_LANE = 10;
const galHash = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
/** "$15/month (10 shorts) or $3 per short" → "$15/month" for a card; the sheet shows all of it. */
const galPriceShort = (p) => String(p ?? "").split(/\s+(?:or|\+)\s+|\s*[(;,]\s*/)[0].trim();
/** A word for the typographic cover: the name's longest word (a later one on ties), so "Agent Cost Dashboard" and
 * "Agent Session Archive" don't both read "Agent". */
const galMarkWord = (name) => (String(name ?? "").replace(/[—–:(].*$/, "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).reduce((b, w) => (w.length >= b.length ? w : b), "") || "Idea";
/** The cover: the painted image when there is one (lazy), else the placeholder. `big` uses the full image. */
function galCoverHTML(x, big = false, extra = "") {
  const st = S.covers?.st, v = x.coverId && st?.have?.[x.coverId];
  const url = v ? `/covers/${encodeURIComponent(x.coverId)}${big ? "" : "_thumb"}.webp?v=${v}` : big ? x.coverUrl : x.thumbUrl ?? x.coverUrl;
  // A painted cover keeps its category's colours; a stand-in varies its print colours and layout by the idea, so a lane
  // of stand-ins doesn't read as one card repeated.
  const h = galHash(x.id ?? x.name ?? "");
  const pals = Object.keys(GAL_PAL);
  const [i1, i2, pp] = url ? st?.palettes?.[x.coverCat] ?? GAL_PAL[x.coverCat] ?? GAL_PAL.money : st?.palettes?.[pals[h % pals.length]] ?? GAL_PAL[pals[h % pals.length]];
  const lum = (c) => { const n = parseInt(String(c).slice(1), 16); return ((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11; };
  // The word takes the darker ink (readable on the paper), the shape the other.
  const [mk, sh] = lum(i1) <= lum(i2) ? [i1, i2] : [i2, i1];
  const style = `--i1:${i1};--i2:${i2};--pp:${pp};--mk:${mk};--sh:${sh}`;
  if (url) return `<div class="galcov has" style="${style}"><img src="${esc(url)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('on')">${extra}</div>`;
  return `<div class="galcov ph v${(h >> 3) % 4}" style="${style}" aria-hidden="true"><span class="galmark">${esc(galMarkWord(x.name ?? x.title))}</span>${extra}</div>`;
}
function galBadges(x) {
  const p = galPlaying(x.id), kit = !p && galHasKit(x.id);
  return p ? '<span class="galbadge play">Playing</span>' : kit ? '<span class="galbadge">Kit ready</span>' : "";
}
function galCardHTML(x, i) {
  return `<article class="galcard galrecord" data-gid="${esc(x.id)}" tabindex="-1" role="listitem" aria-label="${esc(x.name)}">
    <div class="galtxt">${galProofBadge(x)}<h4>${esc(x.name)}</h4>
      ${x.sourceExcerpt ? `<p class="galexcerpt">${esc(x.sourceExcerpt)}</p><span class="hint">Collected excerpt · relevance unreviewed</span>` : `<p class="galhk">${esc(x.hook)}</p>`}
      <p class="galfor">${esc(x.buyer || "Buyer still to define")}</p>
      ${galProofLine(x)}<span class="galread">Review evidence &amp; next test →</span>
    </div></article>`;
}
/** A card from the older feed ("Fresh from Studio"): opens its plan dialog, as before. */
function galFeedCardHTML(x, i) {
  const c = typeof covOf === "function" ? covOf(x) : {};
  const y = { name: x.title, coverId: undefined, coverCat: x.coverCat || x.row, coverUrl: c.url, thumbUrl: c.thumb };
  return `<article class="galcard feed" data-fid="${esc(x.id)}" tabindex="-1" role="listitem" aria-label="${esc(x.title)}" style="--i:${Math.min(i, 8)}">
    ${galCoverHTML(y)}
    <div class="galtxt"><h4>${esc(x.title)}</h4><p class="galhk">${esc(x.pitch)}</p>
      <div class="galchips"><span class="galsc">Untested idea</span></div>
    </div></article>`;
}
function galLaneHTML(l) {
  const n = S.gal.shown.get(l.id) ?? GAL_FIRST_LANE;
  const items = l.items.slice(0, n);
  const busy = l.id === "fresh" ? !!S.feed?.data?.running?.length : S.gal.more.has(l.id);
  const more = false;
  const cards = items.map((x, i) => (l.kind === "feed" ? galFeedCardHTML(x, i) : galCardHTML(x, i))).join("");
  const skel = busy ? '<div class="galcard skel" aria-hidden="true"><div class="galcov"></div><div class="galtxt"><span class="stsk w70"></span><span class="stsk w40"></span></div></div>'.repeat(items.length ? 1 : 3) : "";
  return `<section class="gallane" data-lane="${esc(l.id)}" aria-label="${esc(l.title)}">
    <div class="gallh"><h3>${esc(l.title)} <span class="n">${l.items.length}</span></h3><span class="hint gallsub">${esc(l.subtitle ?? "")}</span><span class="spacer"></span>
      ${more ? `<button class="btn ghost sm" data-galmore="${esc(l.id)}" ${busy ? "disabled" : ""}>${busy ? '<span class="spin"></span>Writing…' : "More"}</button>` : ""}
      <span class="galarrows"><button class="ib" data-galscroll="-1" aria-label="Scroll ${esc(l.title)} left" tabindex="-1">${ICON.chev}</button><button class="ib" data-galscroll="1" aria-label="Scroll ${esc(l.title)} right" tabindex="-1">${ICON.chev}</button></span></div>
    <div class="galstrip" data-lane="${esc(l.id)}" role="list" data-total="${l.items.length}">${cards}${skel}</div></section>`;
}
function galHeroHTML(x) {
  const d = S.gal.data, p = galPlaying(x.id);
  const kick = d?.source === "today" ? "Idea to investigate" : d?.source === "lab" ? "Earlier untested idea" : "Idea to investigate";
  const stat = (k, v, t) => (v ? `<div${t ? ` title="${esc(t)}"` : ""}><dt>${k}</dt><dd>${v}</dd></div>` : "");
  return `<div class="galhero" data-gid="${esc(x.id)}">
    <div class="galhtxt">
      <p class="galkick">${kick}${x.pivoted ? ' <span title="Rewritten after a pre-mortem">· revised after a pre-mortem</span>' : ""}</p>
      <h2><button class="galhname" data-galopen>${esc(x.name)}</button></h2>
      <p class="galhook">${esc(x.hook)}</p>
      ${x.buyer ? `<p class="galfor"><span>For</span> ${esc(x.buyer)}</p>` : ""}
      ${galProofBadge(x)}${galProofLine(x)}
      <div class="galhacts"><button class="btn primary" data-galplay>${p ? "Playing" : "Play"}</button><button class="btn" data-galopen>Open</button><button class="btn ghost" data-galsave aria-pressed="${galSaved(x.id)}">${galSaved(x.id) ? "Saved" : "Save"}</button>
        ${p ? `<button class="link" data-galproject="${esc(p.slug)}">Project page</button>` : ""}</div>
    </div>
    <div class="galhcov">${galCoverHTML(x, true)}</div></div>`;
}
