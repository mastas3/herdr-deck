// Gallery: the hero, lanes and cards as HTML (gallery-core.js decides what to show). Covers come from the covers job
// (src/covers.ts) by each idea's coverId; until one is painted a card gets a typographic cover in its category's
// print colours. Numbers are the engine's: quality 0–100 after judging, Jev's chance of ≥10 paying customers in 60 days.
const GAL_PAL = { money: ["#00A95C", "#F15060", "#F4EEE2"], saas: ["#0078BF", "#FFD400", "#F4EEE2"], automations: ["#00838A", "#FF6C2F", "#F4EEE2"], content: ["#F15060", "#3D5588", "#F4EEE2"], projects: ["#A75154", "#5EC8E5", "#F4EEE2"], gem: ["#3255A4", "#82D8D5", "#F4EEE2"], weekend: ["#FFB511", "#2E2E2E", "#F4EEE2"], wild: ["#FF48B0", "#00A95C", "#F4EEE2"] };
const GAL_FIRST_LANE = 10;
const galHash = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const galPct = (p) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "–");
const galQ = (q) => (typeof q === "number" ? String(Math.round(q)) : "–");
/** "$15/month (10 shorts) or $3 per short" → "$15/month" for a card; the sheet shows all of it. */
const galPriceShort = (p) => String(p ?? "").split(/\s+(?:or|\+)\s+|\s*[(;,]\s*/)[0].trim();
const galDays = (n) => (n > 0 ? `First $ in ~${n} day${n === 1 ? "" : "s"}` : "");
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
  const own = (x.owned ?? []).slice(0, 2), more = Math.max(0, (x.owned ?? []).length - own.length);
  const miss = x.missing?.length ? `<span class="galmiss" title="Missing: ${esc(x.missing.join(", "))}">Needs ${x.missing.length === 1 ? esc(x.missing[0]) : `${x.missing.length} connectors`}</span>` : "";
  return `<article class="galcard" data-gid="${esc(x.id)}" tabindex="-1" role="listitem" aria-label="${esc(x.name)}" style="--i:${Math.min(i, 8)}">
    ${galCoverHTML(x, false, galBadges(x))}
    <div class="galtxt"><h4>${esc(x.name)}</h4><p class="galhk">${esc(x.hook)}</p>
      <div class="galmeta">${x.price ? `<span class="galprice">${esc(galPriceShort(x.price))}</span>` : ""}${x.timeToFirstDollarDays > 0 ? `<span>${esc(galDays(x.timeToFirstDollarDays))}</span>` : ""}</div>
      <div class="galchips"><span class="galsc" title="Quality after judging (0–100)"><b>${galQ(x.quality)}</b> quality</span>${typeof x.jevP10 === "number" ? `<span class="galsc" title="Jev: chance of 10 or more paying customers within 60 days"><b>${galPct(x.jevP10)}</b> Jev</span>` : ""}</div>
      ${own.length || miss ? `<div class="galown">${own.map((o) => `<span class="galo" title="You already have it">${esc(o)}</span>`).join("")}${more ? `<span class="galo more">+${more}</span>` : ""}${miss}</div>` : ""}
    </div></article>`;
}
/** A card from the older feed ("Fresh from Studio"): opens its plan dialog, as before. */
function galFeedCardHTML(x, i) {
  const c = typeof covOf === "function" ? covOf(x) : {};
  const y = { name: x.title, coverId: undefined, coverCat: x.coverCat || x.row, coverUrl: c.url, thumbUrl: c.thumb };
  return `<article class="galcard feed" data-fid="${esc(x.id)}" tabindex="-1" role="listitem" aria-label="${esc(x.title)}" style="--i:${Math.min(i, 8)}">
    ${galCoverHTML(y)}
    <div class="galtxt"><h4>${esc(x.title)}</h4><p class="galhk">${esc(x.pitch)}</p>
      <div class="galmeta">${x.price ? `<span class="galprice">${esc(galPriceShort(x.price))}</span>` : ""}${x.first_dollar ? `<span>First $ ${esc(x.first_dollar.replace(/^(in|within)\s+/i, "in "))}</span>` : ""}</div>
      ${typeof x.score === "number" ? `<div class="galchips"><span class="galsc" title="The feed critic's score (1–10)"><b>${x.score}</b>/10 critic</span></div>` : ""}
    </div></article>`;
}
function galLaneHTML(l) {
  const n = S.gal.shown.get(l.id) ?? GAL_FIRST_LANE;
  const items = l.items.slice(0, n);
  const busy = l.id === "fresh" ? !!S.feed?.data?.running?.length : S.gal.more.has(l.id);
  const more = l.more !== false && (l.id === "fresh" || S.gal.data?.source === "today");
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
  const kick = d?.source === "today" ? "Today's top pick" : d?.source === "lab" ? "Top pick from the idea lab" : "Top pick";
  const stat = (k, v, t) => (v ? `<div${t ? ` title="${esc(t)}"` : ""}><dt>${k}</dt><dd>${v}</dd></div>` : "");
  return `<div class="galhero" data-gid="${esc(x.id)}">
    <div class="galhtxt">
      <p class="galkick">${kick}${x.pivoted ? ' <span title="Rewritten after a pre-mortem">· revised after a pre-mortem</span>' : ""}</p>
      <h2><button class="galhname" data-galopen>${esc(x.name)}</button></h2>
      <p class="galhook">${esc(x.hook)}</p>
      ${x.buyer ? `<p class="galfor"><span>For</span> ${esc(x.buyer)}</p>` : ""}
      <dl class="galstats">${stat("Price", esc(galPriceShort(x.price)), x.price)}${stat("First $", x.timeToFirstDollarDays > 0 ? `~${x.timeToFirstDollarDays} days` : "")}${stat("≥10 paying in 60 days", typeof x.jevP10 === "number" ? galPct(x.jevP10) : "", "Jev's estimate")}${stat("Quality", galQ(x.quality), "After judging, 0–100")}</dl>
      <div class="galhacts"><button class="btn primary" data-galplay>${p ? "Playing" : "Play"}</button><button class="btn" data-galopen>Open</button><button class="btn ghost" data-galsave aria-pressed="${galSaved(x.id)}">${galSaved(x.id) ? "Saved" : "Save"}</button>
        ${p ? `<button class="link" data-galproject="${esc(p.slug)}">Project page</button>` : ""}</div>
    </div>
    <div class="galhcov">${galCoverHTML(x, true)}</div></div>`;
}
