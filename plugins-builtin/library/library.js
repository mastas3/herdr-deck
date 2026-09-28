// ══ Library ══════════════════════════════════════════════════════════════════
// Discover → Library: how real builders built and got customers, from YouTube channels (Starter Story and similar)
// and pages you add. Ask it a question, browse founder cards, read the playbooks, and manage the sources and the
// background worker. Server: library.ts beside this file (the library plugin). Loaded after the deck's own files,
// sharing their globals.
// Every claim on screen links to the moment in the video where it was said; numbers are marked as claims.
ICON.book = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 3.2c1.8-.8 3.8-.8 5.5.5v9.6c-1.7-1.3-3.7-1.3-5.5-.5zM13.5 3.2c-1.8-.8-3.8-.8-5.5.5v9.6c1.7-1.3 3.7-1.3 5.5-.5z"/></svg>';
S.lib = { view: load("libView", "ask"), ask: load("libAsk", {}), q: load("libQ", ""), res: null, busy: false, st: null, stAt: 0, cards: null, cardsBusy: false, f: load("libF", {}), pbs: null, pb: null, pbMd: "", adding: false, tok: 0, err: "" };
const LVIEWS = [["ask", "Ask"], ["founders", "Founders"], ["playbooks", "Playbooks"], ["sources", "Sources"]];
const LEXAMPLES = ["How did people get first customers for a Telegram bot?", "Pricing for a mobile app subscription", "Cold email that got the first clients", "What do founders regret building?", "Selling software to local businesses", "Getting users from Reddit without getting banned"];
const LCH = { reddit: "Reddit", x_twitter: "X", tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram", linkedin: "LinkedIn", facebook_groups: "Facebook groups", product_hunt: "Product Hunt", hacker_news: "Hacker News", seo: "SEO", content_blog: "Blog", newsletter: "Newsletter", cold_email: "Cold email", cold_calls: "Cold calls", door_to_door: "Door to door", in_person: "In person", friends_network: "Network", existing_audience: "Own audience", communities: "Communities", paid_ads: "Paid ads", partnerships: "Partners", affiliates: "Affiliates", app_store: "App store", marketplace: "Marketplace", word_of_mouth: "Word of mouth", press: "Press", influencers: "Influencers", cold_dms: "Cold DMs", other: "Other" };
const LBT = { saas: "SaaS", mobile_app: "Mobile app", ecommerce: "E-commerce", service_agency: "Service / agency", info_product: "Course / info", marketplace: "Marketplace", content_media: "Content / media", local_business: "Local business", newsletter: "Newsletter", community: "Community", hardware: "Hardware", other: "Other" };
const lOn = () => S.mode === "discover" && S.disc.tab === "lib" && !!$("dbody").querySelector(":scope > .view #libroot");
const lFmt = (t) => { t = Math.floor(t || 0); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; };
const lAt = (url, t) => (t ? `${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(t)}s` : url);
// When each video came out: "Published Mar 2024 · 18 min", and "older (2021)" past three years (src/library-card.ts).
const LMON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lPub = (d) => { const m = String(d ?? "").match(/^(\d{4})-(\d\d)/); return m ? `${LMON[Number(m[2]) - 1]} ${m[1]}` : ""; };
const lDur = (s) => (!s ? "" : s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min`);
const lOld = (d) => { const t = Date.parse(d ?? ""); return Number.isFinite(t) && Date.now() - t > 3 * 365.25 * 864e5 ? `older (${String(d).slice(0, 4)})` : ""; };
const lWhen = (d, dur) => { const p = lPub(d), old = lOld(d), bits = [p && `Published ${p}`, lDur(dur)].filter(Boolean); return bits.length ? `<span class="lwhen${old ? " old" : ""}" title="${esc(d ?? "")}">${esc(bits.join(" · "))}${old ? ` <i>${esc(old)}</i>` : ""}</span>` : ""; };
const lSince = () => new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
const lTime = (url, t, label) => `<a class="ltime" href="${esc(lAt(url, t))}" target="_blank" rel="noopener" title="Watch from ${t ? lFmt(t) : "the start"}">${ICON.play}${esc(label ?? (t ? lFmt(t) : "video"))}</a>`;

function libSetView(v) { S.lib.view = v; store("libView", v); if (lOn()) libRender(true); else renderDiscover(); libLoadFor(v); }
function libLoadFor(v) {
  if (v === "sources" || !S.lib.st) libStatus();
  if (v === "founders" && !S.lib.cards) libCards();
  if (v === "playbooks" && !S.lib.pbs) libPlaybooks();
}
/** The tab's shell. The head (inputs) is rebuilt only when the view changes, so typing is never interrupted. */
function discLibrary() {
  setTimeout(() => libLoadFor(S.lib.view), 0);
  return `<section id="libroot" class="lib" data-libview="${esc(S.lib.view)}">
    <nav class="seg lviews" aria-label="Library views">${libNav()}</nav>
    <div id="libhead">${libHead()}</div>
    <div id="libres">${libRes()}</div></section>`;
}
function libNav() { return LVIEWS.map(([id, label]) => `<button data-lview="${id}" aria-pressed="${S.lib.view === id}">${label}</button>`).join(""); }
function libRender(viewChanged) {
  const root = $("dbody").querySelector("#libroot");
  if (!root) return;
  setHTML(root.querySelector(".lviews"), libNav());
  if (viewChanged || root.dataset.libview !== S.lib.view) { root.dataset.libview = S.lib.view; setHTML(root.querySelector("#libhead"), libHead()); }
  setHTML(root.querySelector("#libres"), libRes());
}
function libPatch() { if (lOn()) libRender(false); }

function libHead() {
  const L = S.lib, v = L.view;
  if (v === "ask") return `<div class="lx"><textarea class="dbig" data-libq rows="2" placeholder="Ask the library. “How did people get first customers for a Telegram bot?”" aria-label="Your question">${esc(L.q)}</textarea>
    <div class="dlabacts"><button class="btn primary" data-libgo>${ICON.book}Search the library</button><span class="hint">Searches what founders said in the videos (by meaning) and the founder cards (by words). Runs on this Mac.</span></div>
    <div class="lchips lwhenchips">${libChip("recent", "Last 12 months", L.ask?.recent)}${libChip("newest", "Newest first", L.ask?.newest)}</div></div>`;
  if (v === "founders") {
    const f = L.f;
    const opt = (map, cur, any) => `<option value="">${any}</option>` + Object.entries(map).map(([k, l]) => `<option value="${esc(k)}"${cur === k ? " selected" : ""}>${esc(l)}</option>`).join("");
    const srcs = (L.st?.sources ?? []).filter((s) => s.cards);
    return `<div class="lfilters">
      <input type="search" data-libfq placeholder="Filter: business, tactic, lesson…" value="${esc(f.q ?? "")}" aria-label="Filter founder cards">
      <select data-libf="btype" aria-label="Business type">${opt(LBT, f.btype, "Any business")}</select>
      <select data-libf="channel" aria-label="First-customer or growth channel">${opt(LCH, f.channel, "Any channel")}</select>
      <select data-libf="minRevenue" aria-label="Claimed revenue">${[["", "Any revenue"], ["1000", "≥ $1K / month"], ["10000", "≥ $10K / month"], ["50000", "≥ $50K / month"], ["100000", "≥ $100K / month"]].map(([k, l]) => `<option value="${k}"${String(f.minRevenue ?? "") === k ? " selected" : ""}>${l}</option>`).join("")}</select>
      <select data-libf="source" aria-label="Source">${`<option value="">All sources</option>` + srcs.map((s) => `<option value="${esc(s.id)}"${f.source === s.id ? " selected" : ""}>${esc(s.title)}</option>`).join("")}</select>
      ${libChip("frecent", "Last 12 months", !!f.since)}
      <select data-libf="sort" aria-label="Sort">${[["revenue", "Highest claimed revenue"], ["published", "Newest videos"], ["views", "Most viewed"], ["recent", "Newest cards"]].map(([k, l]) => `<option value="${k}"${(f.sort ?? "revenue") === k ? " selected" : ""}>${l}</option>`).join("")}</select>
    </div>`;
  }
  if (v === "sources") return `<div class="lx"><div class="laddrow"><input type="url" data-liburl placeholder="Research any channel or page: paste a YouTube channel, playlist or video, or a web page" aria-label="Link to add"><button class="btn primary" data-libadd>${ICON.plus}Add</button></div>
    <p class="hint">YouTube: captions are fetched and indexed in the background. Web pages: fetched once, only if the site's robots.txt allows it; nothing behind a login.</p></div>`;
  return "";
}
const libChip = (k, label, on) => `<button class="lchip2" data-libchip="${k}" aria-pressed="${!!on}">${esc(label)}</button>`;
function libRes() {
  const v = S.lib.view;
  if (v === "ask") return libAsk();
  if (v === "founders") return libFounders();
  if (v === "playbooks") return libPlaybooksView();
  return libSources();
}

// ── Ask ─────────────────────────────────────────────────────────────────────
async function libSearch(q) {
  q = String(q ?? "").trim();
  if (q.length < 3) { toast("Ask a question first", true); return; }
  const L = S.lib, tok = ++L.tok;
  L.q = q; store("libQ", q); L.busy = true; L.err = "";
  const ta = $("dbody").querySelector("[data-libq]"); if (ta && ta.value.trim() !== q) ta.value = q;
  libPatch();
  const a = L.ask ?? {};
  const filter = { ...(a.recent ? { since: lSince() } : {}), ...(a.newest ? { sort: "published" } : {}) };
  try { const r = await api("/api/library/search", { q, k: 8, filter }, 20_000); if (tok === L.tok) L.res = { ...r, q }; }
  catch (e) { if (tok === L.tok) L.err = e.message; }
  if (tok === L.tok) { L.busy = false; libPatch(); }
}
function libAsk() {
  const L = S.lib, r = L.res;
  const empty = L.st && !L.st.cards?.cards && !L.st.sources?.some((s) => s.counts.ingested);
  const ex = `<div class="lchips lexamples">${LEXAMPLES.map((t, i) => `<button class="lstart" data-libex="${esc(t)}" style="--i:${i}">${esc(t)}</button>`).join("")}</div>`;
  if (L.busy && !r) return `<div class="lanswers">${Array.from({ length: 3 }, () => '<div class="gcard skel lskel"></div>').join("")}</div>`;
  if (L.err) return `<p class="derr">${ICON.warn}${esc(L.err)}</p>${ex}`;
  if (!r) return `${empty ? `<p class="hint lnote">The library is empty so far. Open <button class="link" data-lview="sources">Sources</button> and start the worker: Starter Story comes first.</p>` : ""}${ex}`;
  if (!r.answers.length) return `<p class="hint lnote">Nothing in the library answers “${esc(r.q)}”${L.ask?.recent ? " from the last 12 months" : ""} yet.</p>${ex}`;
  return `<p class="hint lmeta">${r.answers.length} videos and pages · ${r.passages} passages searched · ${r.ms} ms${r.error ? ` · <span class="derr">${esc(r.error)}</span>` : ""}${L.busy ? ' · <span class="spin"></span>' : ""}</p>
    <div class="lanswers">${r.answers.map((a, i) => libAnswer(a, i)).join("")}</div>`;
}
function libAnswer(a, i) {
  const c = a.card;
  const clips = a.clips.map((x) => `<blockquote class="lq"><p>“${esc(x.text)}”</p><footer>${a.kind === "web" ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(a.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60))}</a>` : lTime(a.url, x.t)}</footer></blockquote>`).join("");
  return `<article class="gcard lans" style="--i:${Math.min(i, 10)}">
    <div class="lanshead"><a class="gname" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a><span class="hint">${a.kind === "web" ? "web page" : esc(libSourceTitle(a.source ?? c?.source))}</span></div>
    ${a.kind === "web" ? "" : lWhen(a.date ?? c?.date, a.duration ?? c?.duration)}
    ${c ? libCardSummary(c) : ""}
    ${clips}
  </article>`;
}
function libSourceTitle(id) { const s = S.lib.st?.sources?.find((x) => x.id === id || x.channelId === id); return s?.title ?? id ?? ""; }
/** The facts of a founder card, each with its moment in the video. Revenue and price are shown as claims. */
function libCardSummary(c, full) {
  const claim = (label, x) => (x ? `<span class="lclaim"><b>${label}</b> “${esc(x.quote || x.text)}”${x.src === "title" ? ' <i title="Only the video title says this">title</i>' : ""} ${lTime(c.url, x.t)}</span>` : "");
  const first = (full ? c.first : c.first.slice(0, 2)).map((x) => `<li><span class="dtag">${esc(LCH[x.channel] ?? "Other")}</span> ${esc(x.text)} ${lTime(c.url, x.t)}</li>`).join("");
  const more = full ? [
    c.growth.length ? `<h4>Growth</h4><ul>${c.growth.map((x) => `<li><span class="dtag">${esc(LCH[x.channel] ?? "Other")}</span> ${esc(x.text)} ${lTime(c.url, x.t)}</li>`).join("")}</ul>` : "",
    c.failed.length ? `<h4>What failed or they regret</h4><ul>${c.failed.map((x) => `<li>${esc(x.text)} ${lTime(c.url, x.t)}</li>`).join("")}</ul>` : "",
    c.lessons.length ? `<h4>Lessons</h4><ul>${c.lessons.map((x) => `<li>${esc(x.text)} ${lTime(c.url, x.t)}</li>`).join("")}</ul>` : "",
    c.stack.length ? `<p class="lstack">${c.stack.map((s) => `<span>${esc(s)}</span>`).join("")}</p>` : "",
  ].join("") : (c.lessons[0] ? `<p class="llesson">${esc(c.lessons[0].text)} ${lTime(c.url, c.lessons[0].t)}</p>` : "");
  return `<div class="lcard" data-libcard="${esc(c.id)}">
    <p class="lbiz"><b>${esc(c.business ?? "Unnamed business")}</b>${c.sells ? ` — ${esc(c.sells)}` : ""}</p>
    <p class="gmeta">${esc(LBT[c.btype] ?? c.btype)}${c.customer ? ` · for ${esc(c.customer)}` : ""}${c.founder ? ` · ${esc(c.founder)}` : ""}${c.team ? ` · team: ${esc(c.team.text)}` : ""}</p>
    <div class="lclaims">${claim("Claimed revenue", c.revenue)}${claim("Price", c.price)}${claim("First revenue", c.ttfr)}</div>
    ${first ? `<h4>First customers</h4><ul>${first}</ul>` : ""}${more}
    <div class="gacts"><button class="btn ghost" data-libstudio title="Open the Studio with this founder's story as the starting point">Build on this in Studio</button></div>
  </div>`;
}

// ── Founders ──────────────────────────────────────────────────────────────────
async function libCards(more) {
  const L = S.lib;
  if (L.cardsBusy) return;
  L.cardsBusy = true; libPatch();
  const f = L.f, offset = more && L.cards ? L.cards.cards.length : 0;
  try {
    const r = await api("/api/library/cards", { q: f.q || undefined, btype: f.btype || undefined, channel: f.channel || undefined, source: f.source || undefined, minRevenue: Number(f.minRevenue) || undefined, since: f.since ? lSince() : undefined, sort: f.sort || "revenue", limit: 30, offset });
    L.cards = more && L.cards ? { ...r, cards: [...L.cards.cards, ...r.cards] } : r;
  } catch (e) { toast(e.message, true); }
  L.cardsBusy = false; libPatch();
}
function libFounders() {
  const L = S.lib, r = L.cards;
  if (!r) return `<div class="dgrid">${Array.from({ length: 4 }, () => '<div class="gcard skel"></div>').join("")}</div>`;
  if (!r.cards.length) return `<p class="hint lnote">${L.st?.cards?.cards ? `No founder cards match these filters${L.f.since ? " (only videos with a known date from the last 12 months count)" : ""}.` : "No founder cards yet: they are written by a local model as videos are ingested."}</p>`;
  return `<p class="hint lmeta">${r.total} founder card${r.total === 1 ? "" : "s"}${L.cardsBusy ? ' · <span class="spin"></span>' : ""}</p>
    <div class="dgrid lcards">${r.cards.map((c, i) => `<article class="gcard lfc" style="--i:${Math.min(i, 10)}"><a class="gname" href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.title)}">${esc(c.title)}</a>
      <p class="gmeta">${esc(libSourceTitle(c.source))}${c.views ? ` · ${kfmt(c.views)} views` : ""}</p>${lWhen(c.date, c.duration)}${libCardSummary(c, true)}</article>`).join("")}</div>
    ${r.cards.length < r.total ? `<div class="lmore"><button class="btn" data-libmore>Show more</button></div>` : ""}`;
}

// ── Playbooks ─────────────────────────────────────────────────────────────────
async function libPlaybooks(op) {
  try { const r = await api("/api/library/playbooks", op ? { op } : {}); S.lib.pbs = r.playbooks; } catch (e) { toast(e.message, true); }
  libPatch();
}
async function libOpenPlaybook(name) {
  S.lib.pb = name; S.lib.pbMd = ""; libPatch();
  try { const r = await api("/api/library/playbooks", { name }); if (S.lib.pb === name) S.lib.pbMd = r.markdown; } catch (e) { toast(e.message, true); }
  libPatch();
  $("dbody").scrollTop = 0;
}
function libPlaybooksView() {
  const L = S.lib, n = L.st?.cards?.cards ?? 0;
  if (L.pb) return `<div class="lpbbar"><button class="btn ghost" data-libpbback>← All playbooks</button><span class="hint">${esc(L.st?.dir ?? "")}/playbooks/${esc(L.pb)}.md</span></div>
    <article class="lpb md">${L.pbMd ? md(L.pbMd) : '<div class="gcard skel"></div>'}</article>`;
  const list = L.pbs ?? [];
  return `<div class="lpbbar"><button class="btn" data-libpbwrite ${n ? "" : "disabled"}>Rewrite from ${n} card${n === 1 ? "" : "s"}</button><span class="hint">Written by counting the cards, not by a model: patterns with counts and examples, every example linked to its moment. To keep them in your wiki, ask an agent to file them as synthesis pages.</span></div>
    ${list.length ? `<div class="dgrid lpbs">${list.map((p, i) => `<button class="gcard lpbcard" data-libpb="${esc(p.name)}" style="--i:${i}"><b>${esc(p.title)}</b><span class="hint">from ${p.cards} cards · ${esc(agoText(p.at))}</span></button>`).join("")}</div>` : `<p class="hint lnote">No playbooks yet. They need founder cards first.</p>`}`;
}

// ── Sources ───────────────────────────────────────────────────────────────────
async function libStatus() {
  try { S.lib.st = await api("/api/library/status", {}); S.lib.stAt = Date.now(); } catch (e) { if (S.lib.view === "sources") toast(e.message, true); }
  libPatch();
  clearTimeout(libStatus.t);
  if (lOn() && S.lib.st?.runner?.running || lOn() && S.lib.st?.runner?.owner) libStatus.t = setTimeout(() => { if (lOn()) libStatus(); }, 4000);
}
async function libChannels(body, msg) {
  try { const r = await api("/api/library/channels", body, 60_000); S.lib.st = r.status ?? r; if (msg) toast(msg); } catch (e) { toast(e.message, true); }
  libPatch();
  if (S.lib.st?.runner?.running) libStatus();
}
function libSources() {
  const st = S.lib.st;
  if (!st) return `<div class="gcard skel"></div>`;
  const run = st.runner ?? {}, on = st.ingest?.running;
  const cur = !on ? "Paused" : run.current ? `Ingesting “${esc(run.current.title)}”` : run.enumerating ? `Listing ${esc(run.enumerating)}…` : run.extracting ? "Writing a founder card" : run.running || run.owner ? "Waiting for work" : "Starting…";
  const who = !run.running && run.owner ? ` (in another process, pid ${run.owner})` : "";
  const tog = (key, label, hint) => `<label class="ltog" title="${esc(hint)}"><input type="checkbox" data-libuse="${key}" ${st.use?.[key] ? "checked" : ""}> ${label}</label>`;
  const rows = st.sources.map((s) => {
    const c = s.counts, planned = c.total - c.skipped, pctDone = planned ? Math.round((100 * c.ingested) / planned) : 0;
    return `<div class="lsrc${s.enabled ? "" : " off"}">
      <div class="lsrctop"><label class="ltog"><input type="checkbox" data-libsrc="${esc(s.id)}" ${s.enabled ? "checked" : ""} aria-label="Ingest ${esc(s.title)}"></label>
        <a class="gname" href="${esc(s.url || "#")}" target="_blank" rel="noopener">${esc(s.title)}</a>
        <span class="hint">${c.ingested}/${planned || "?"} videos · ${s.cards} cards${c.failed ? ` · ${c.failed} failed` : ""}${c.no_captions ? ` · ${c.no_captions} without captions` : ""}${s.limit ? ` · best ${s.limit}` : ""}</span>
        <button class="dx lrm" data-librm="${esc(s.id)}" title="Remove from the list (what was ingested stays searchable)" aria-label="Remove ${esc(s.title)}">${ICON.x}</button></div>
      <div class="lbar" role="progressbar" aria-valuenow="${pctDone}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pctDone}%"></i></div>
      ${s.note ? `<p class="hint">${esc(s.note)}</p>` : ""}${s.error ? `<p class="derr">${ICON.warn}${esc(s.error)}</p>` : ""}
    </div>`;
  }).join("");
  const pages = st.cards?.pages ? `<p class="hint">${st.cards.pages} web page${st.cards.pages === 1 ? "" : "s"} added.</p>` : "";
  return `${st.available?.ok ? "" : `<p class="derr">${ICON.warn}${esc(st.available?.why ?? "The library can't run on this machine")}</p>`}
    <div class="dstatus lrun">${on && run.running ? '<span class="spin"></span>' : ""}<span><b>${cur}</b>${who} · this run: ${run.run?.ingested ?? 0} videos, ${run.run?.cards ?? 0} cards${run.lastError ? ` · <span class="derr" title="${esc(run.lastError)}">last error</span>` : ""}</span><span class="spacer"></span>
      <button class="btn ${on ? "" : "primary"}" data-librun="${on ? "pause" : "start"}" ${st.available?.ok ? "" : "disabled"}>${on ? "Pause" : "Start"}</button></div>
    <p class="hint">${st.cards?.cards ?? 0} founder cards (${st.cards?.withRevenue ?? 0} with a revenue claim) from ${st.sources.reduce((n, s) => n + s.counts.ingested, 0)} videos. Cards are written by ${esc(st.extract?.model ?? "a local model")} on this Mac.</p>
    <div class="luse"><span class="hint">Use as context in</span>${tog("studio", "Studio", "Studio chats get 3–5 relevant founder cards with links")}${tog("ideas", "Ideas feed", "The daily ideas feed gets founder evidence for prices and launch channels")}${tog("research", "Research agents", "Agents can ask it through the deck_library MCP tool")}</div>
    <div class="lsrcs">${rows}</div>${pages}`;
}

// ── events ────────────────────────────────────────────────────────────────────
$("dbody").addEventListener("click", async (e) => {
  const t = e.target;
  if (!t.closest?.("#libroot")) return;
  const v = t.closest("button[data-lview]")?.dataset.lview;
  if (v) return libSetView(v);
  if (t.closest("[data-libgo]")) return libSearch($("dbody").querySelector("[data-libq]")?.value);
  const ex = t.closest("[data-libex]")?.dataset.libex;
  if (ex) return libSearch(ex);
  if (t.closest("[data-libmore]")) return libCards(true);
  const chip = t.closest("[data-libchip]")?.dataset.libchip;
  if (chip) return libChipToggle(chip);
  const pb = t.closest("[data-libpb]")?.dataset.libpb;
  if (pb) return libOpenPlaybook(pb);
  if (t.closest("[data-libpbback]")) { S.lib.pb = null; return libPatch(); }
  if (t.closest("[data-libpbwrite]")) { await libPlaybooks("write"); return toast("Playbooks rewritten from the current cards"); }
  const run = t.closest("[data-librun]")?.dataset.librun;
  if (run) return libChannels({ op: run }, run === "start" ? "Library worker started" : "Paused after the current video");
  const rm = t.closest("[data-librm]")?.dataset.librm;
  if (rm) { if (confirm(`Remove ${rm} from the list? What was already ingested stays searchable.`)) libChannels({ op: "remove", id: rm }); return; }
  if (t.closest("[data-libadd]")) return libAdd();
  if (t.closest("[data-libstudio]")) {
    const id = t.closest("[data-libcard]")?.dataset.libcard;
    const c = [...(S.lib.res?.answers ?? []).map((a) => a.card), ...(S.lib.cards?.cards ?? [])].find((x) => x?.id === id);
    if (c) mixOpenWith([], { text: libStudioText(c), toastText: "Opened the Studio with this founder's story" });
  }
});
function libChipToggle(k) {
  const L = S.lib;
  if (k === "frecent") { L.f = { ...L.f, since: L.f.since ? undefined : "12m" }; store("libF", L.f); setHTML($("dbody").querySelector("#libhead"), libHead()); return libCards(); }
  L.ask = { ...L.ask, [k]: !L.ask?.[k] }; store("libAsk", L.ask);
  setHTML($("dbody").querySelector("#libhead"), libHead());
  if (L.res?.q) libSearch(L.res.q);
}
/** A Studio message from a founder card: what worked for them, to adapt (the Studio adds library evidence itself). */
function libStudioText(c) {
  const how = c.first.slice(0, 2).map((x) => x.text).join("; ");
  return `Something that worked for a real founder: ${c.business ?? c.title}${c.sells ? `, ${c.sells}` : ""}${c.customer ? ` for ${c.customer}` : ""}.${how ? ` First customers: ${how}.` : ""}${c.revenue ? ` They claim ${c.revenue.quote || c.revenue.text}.` : ""} Give me builds in the same spirit that fit what I have, with a different customer or angle.`;
}
async function libAdd() {
  const inp = $("dbody").querySelector("[data-liburl]");
  const url = inp?.value.trim();
  if (!url) return toast("Paste a link first", true);
  if (S.lib.adding) return;
  S.lib.adding = true;
  toast("Adding…");
  try {
    const r = await api("/api/library/add", { url }, 90_000);
    S.lib.st = r.status ?? S.lib.st;
    if (inp) inp.value = "";
    toast(r.added === "page" ? `Added “${r.title}” (${Math.round(r.chars / 1000)}k characters)` : `Added ${r.id}: its videos go to the front of the queue`);
  } catch (e) { toast(e.message, true); }
  S.lib.adding = false;
  libPatch();
}
$("dbody").addEventListener("change", (e) => {
  const t = e.target;
  if (!t.closest?.("#libroot")) return;
  const k = t.dataset.libf;
  if (k) { S.lib.f = { ...S.lib.f, [k]: t.value || undefined }; store("libF", S.lib.f); return libCards(); }
  if (t.dataset.libsrc) return libChannels({ op: t.checked ? "enable" : "disable", id: t.dataset.libsrc });
  if (t.dataset.libuse) return libChannels({ op: "use", what: t.dataset.libuse, on: t.checked });
});
$("dbody").addEventListener("input", (e) => {
  const t = e.target;
  if (t.matches?.("[data-libq]")) { S.lib.q = t.value; store("libQ", t.value); }
  if (t.matches?.("[data-libfq]")) { clearTimeout(libCards.t); libCards.t = setTimeout(() => { S.lib.f = { ...S.lib.f, q: t.value.trim() || undefined }; store("libF", S.lib.f); libCards(); }, 280); }
});
$("dbody").addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.matches?.("[data-libq]") && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); libSearch(t.value); }
  if (t.matches?.("[data-liburl]") && e.key === "Enter") { e.preventDefault(); libAdd(); }
});
// The Library's tab in Discover (the only place it shows; Discover reads the point).
deckPlugins.register("library", {}).extend("discover.tabs", { key: "lib", label: "Library", order: 70, render: () => discLibrary(), patch: () => lOn() && (libPatch(), true) });
