"use strict";
// ══ Leads ════════════════════════════════════════════════════════════════════
// Discover → Leads: find the people who need an idea (Idea → people), or the ideas an audience needs (People →
// ideas), from public posts on Hacker News, Reddit, GitHub issues, Stack Exchange and App Store reviews. Results
// stream in per source; a deep dive hands the question to an agent with the last30days skill. Server: src/leads.ts.
// Nothing here contacts anyone or starts a session on its own: every action opens the New session dialog, prefilled.
ICON.target = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3.2"/><circle cx="8" cy="8" r=".8" fill="currentColor"/></svg>';
ICON.dice = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="10.4" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>';
ICON.dive = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6M5 7h4M7 5v4"/></svg>';
ICON.ext = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h3.2"/></svg>';
S.leads = { dir: load("leadsDir", "idea"), text: load("leadsText", ""), res: null, job: null, busy: false, st: null, stLoading: false, seed: 0, open: new Set(), more: false, report: null, reports: new Map(), pendingReport: null, token: 0 };
const LSRC = { hn: ["HN", "Hacker News"], reddit: ["r/", "Reddit"], github: ["GH", "GitHub"], se: ["SE", "Stack Exchange"], appstore: ["App", "App Store"] };
const LCAT_HUE = { price: 35, bugs: 5, find: 200, manual: 150, confusing: 280, privacy: 250, trust: 95, missing: 320, signal: 220 };
const LDIR = { idea: { label: "Idea → people", ph: "Describe an app or feature. “A voice note that explains today’s transits for my chart”, “chat with everything a YouTuber ever said”…", go: "Find the people" },
  audience: { label: "People → ideas", ph: "Describe an audience or niche. “Human Design readers”, “indie game devs on phones”, “podcasters who clip to TikTok”…", go: "Find their pains" } };
const lOnScreen = () => S.mode === "discover" && S.disc.tab === "leads" && !!$("dbody").querySelector(":scope > .view #leadsres");

/** Opens Discover → Leads and searches for this idea (the Studio's build cards call it too). */
function leadsFor(text, dir = "idea") {
  text = String(text ?? "").trim();
  S.leads.dir = dir === "audience" ? "audience" : "idea"; store("leadsDir", S.leads.dir);
  if (text) { S.leads.text = text; store("leadsText", text); }
  S.disc.tab = "leads"; store("discTab", "leads");
  if (S.mode !== "discover") setMode("discover"); else renderDiscover();
  lSyncInput();
  if (text) leadsSearch(text, S.leads.dir);
}
/** The box, its placeholder, the button and the direction switch follow S.leads (a starter, Surprise me, leadsFor…). */
function lSyncInput() {
  const L = S.leads, ta = $("dbody").querySelector("[data-lq]");
  if (ta && ta.value.trim() !== L.text) ta.value = L.text;
  if (ta) ta.placeholder = LDIR[L.dir].ph;
  const gl = $("dbody").querySelector("[data-lgolabel]"); if (gl) gl.textContent = LDIR[L.dir].go;
  const bar = $("dbody").querySelector(".lxbar"); if (bar) setHTML(bar, leadsBar());
}
async function leadsLoad() {
  if (S.leads.stLoading) return;
  S.leads.stLoading = true;
  try { S.leads.st = await api("/api/leads", { seed: S.leads.seed }); } catch (e) { toast(e.message, true); }
  S.leads.stLoading = false;
  leadsPatch();
}
function leadsPatch() {
  if (!lOnScreen()) return;
  const box = $("dbody").querySelector("#leadsres");
  setHTML(box, leadsBody());
  const v = $("dbody").querySelector(":scope > .view"); if (v) v._h = null; // the next full render must not think nothing changed
  const bar = $("dbody").querySelector(".lxbar");
  if (bar) setHTML(bar, leadsBar());
}
async function leadsSearch(text, dir = S.leads.dir, force = false) {
  text = String(text ?? "").trim();
  if (text.length < 3) { toast(dir === "audience" ? "Describe the audience first" : "Describe the idea first", true); return; }
  const L = S.leads;
  L.text = text; L.dir = dir; store("leadsText", text); store("leadsDir", dir);
  lSyncInput();
  const tok = ++L.token;
  L.busy = true; L.open.clear(); L.more = false;
  if (!L.res || L.res.text !== text || L.res.dir !== dir) L.res = null;
  if (lOnScreen()) leadsPatch(); else renderDiscover();
  try {
    const r = await api("/api/leads/search", { text, dir, force }, 15_000);
    if (tok !== L.token) return;
    L.res = r.result; L.job = r.done ? null : r.id;
    if (!r.done) return leadsPoll(tok);
  } catch (e) { if (tok === L.token) toast(e.message, true); }
  if (tok === L.token) { L.busy = false; leadsPatch(); if (!L.st) leadsLoad(); }
}
async function leadsPoll(tok) {
  const L = S.leads;
  leadsPatch();
  await new Promise((r) => setTimeout(r, 450));
  if (tok !== L.token || !L.job) return;
  try {
    const r = await api("/api/leads/status", { id: L.job }, 10_000);
    if (tok !== L.token) return;
    L.res = r.result;
    if (!r.done) return leadsPoll(tok);
    L.job = null;
  } catch (e) { if (tok === L.token) { L.job = null; toast(e.message, true); } }
  if (tok !== L.token) return;
  L.busy = false;
  leadsPatch();
  if (S.mode === "discover" && S.disc.tab === "leads") api("/api/leads", { seed: L.seed }).then((st) => { L.st = st; leadsPatch(); }).catch(() => {});
}

function lAgo(t) { return t ? agoText(t) : ""; }
function lSrcBadge(src) { const [short, name] = LSRC[src] ?? ["?", src]; return `<span class="lsb s-${esc(src)}" title="${esc(name)}">${esc(short)}</span>`; }
function leadsBar() {
  const L = S.leads;
  return `<div class="seg ldir" role="group" aria-label="Direction">${["idea", "audience"].map((d) => `<button data-ldir="${d}" aria-pressed="${L.dir === d}">${d === "idea" ? ICON.bulb : ICON.target}${esc(LDIR[d].label)}</button>`).join("")}</div>`;
}
function discLeads() {
  const L = S.leads;
  if (!L.st && !L.stLoading) setTimeout(leadsLoad, 0);
  return `<section class="lx">
      <div class="lxbar">${leadsBar()}</div>
      <textarea class="dbig" data-lq rows="2" placeholder="${esc(LDIR[L.dir].ph)}" aria-label="An idea or an audience">${esc(L.text)}</textarea>
      <div class="dlabacts"><button class="btn primary" data-lgo>${ICON.compass}<span data-lgolabel>${esc(LDIR[L.dir].go)}</span></button><button class="btn" data-ldeep title="Open a research session that runs your last30days skill: Reddit, X, YouTube, TikTok, HN, Polymarket and the web">${ICON.dive}Deep dive with last30days</button><button class="btn ghost" data-lsurprise title="Pick an audience from your interests and find what they need">${ICON.dice}Surprise me</button></div>
      <p class="hint lpriv">Only the words you type go to Hacker News, Reddit, GitHub, Stack Exchange and the App Store. It reads public posts: nothing is posted, nobody is contacted, and emails and phone numbers are stripped.</p>
    </section>
    <div id="leadsres">${leadsBody()}</div>`;
}
function leadsBody() {
  const L = S.leads, r = L.res;
  const parts = [];
  if (r) parts.push(leadsResult(r));
  else if (L.busy) parts.push(`<div class="lsrcs">${Object.keys(LSRC).map((s) => `<span class="lchip">${lSrcBadge(s)}<span class="spin"></span></span>`).join("")}</div><div class="lthemes">${Array.from({ length: 4 }, () => '<div class="gcard skel"></div>').join("")}</div>`);
  else parts.push(leadsEmpty());
  parts.push(leadsSaved(), leadsReports());
  if (r || L.busy) parts.push(leadsMore());
  return parts.join("");
}
function leadsStarterChips(xs, dir) { return xs.map((t, i) => `<button class="lstart" data-lstart="${esc(t)}" data-sdir="${dir}" style="--i:${i}">${esc(t)}</button>`).join(""); }
function leadsEmpty() {
  const st = S.leads.st;
  const s = st?.starters ?? { idea: [], audience: [] };
  return `<section class="lempty">
      <h3 class="lhero">Somebody out there already wants what you could build.</h3>
      <p class="hint">Start from an idea and find the people complaining about the problem it solves, or start from people and find what they keep asking for. Every pain comes with the post it came from.</p>
      <div class="lstarts">
        <div class="lcol"><h4>${ICON.bulb}Idea → people</h4><div class="lchips">${leadsStarterChips(s.idea, "idea")}</div></div>
        <div class="lcol"><h4>${ICON.target}People → ideas</h4><div class="lchips">${leadsStarterChips(s.audience, "audience")}</div></div>
      </div>
      <div class="lemptyacts"><button class="btn ghost" data-lshuffle>${ICON.dice}Shuffle</button><button class="btn" data-lsurprise>${ICON.target}Surprise me: find an underserved niche</button></div>
      ${st?.recent?.length ? `<p class="dkw lrecent"><span class="hint">Recent</span> ${st.recent.map((x) => `<button class="dtag" data-lstart="${esc(x.text)}" data-sdir="${esc(x.dir)}">${esc(x.text.length > 48 ? x.text.slice(0, 47) + "…" : x.text)}</button>`).join("")}</p>` : ""}
    </section>`;
}
function leadsMore() {
  const st = S.leads.st;
  if (!st) return "";
  const other = S.leads.dir === "idea" ? "audience" : "idea";
  const xs = (st.starters?.[other] ?? []).slice(0, 4);
  return `<section class="lnext"><h3 class="dsub">Keep exploring <button class="link" data-lshuffle>Shuffle</button> <button class="link" data-lsurprise>Surprise me</button></h3>
    <div class="lchips">${leadsStarterChips(xs, other)}${(st.recent ?? []).filter((x) => x.text !== S.leads.text).slice(0, 3).map((x) => `<button class="lstart lrec" data-lstart="${esc(x.text)}" data-sdir="${esc(x.dir)}">${esc(x.text)}</button>`).join("")}</div></section>`;
}
function leadsSources(r) {
  const chip = (id) => {
    const s = r.sources?.[id] ?? { state: "pending", n: 0 };
    const mark = s.state === "pending" ? `<span class="spin"></span>${s.error ? "<i>waiting</i>" : ""}` : s.state === "ok" ? `<b>${s.n}</b>` : s.state === "skipped" ? "<i>skipped</i>" : `${ICON.warn}`;
    const tip = s.state === "ok" ? `${LSRC[id][1]}: ${s.n} relevant posts in ${((s.ms ?? 0) / 1000).toFixed(1)}s` : s.error ? `${LSRC[id][1]}: ${s.error}` : `${LSRC[id][1]}: searching…`;
    return `<span class="lchip st-${esc(s.state)}" title="${esc(tip)}">${lSrcBadge(id)}${s.state === "ok" ? ICON.check : ""}${mark}</span>`;
  };
  return `<div class="lsrcs">${Object.keys(LSRC).map(chip).join("")}<span class="lchip ldeepchip" title="X, YouTube, TikTok and the web come in with the deep dive">X · YouTube · TikTok → <button class="link" data-ldeep>deep dive</button></span></div>`;
}
function leadsQuote(e, opts = {}) {
  const where = e.where ? `<a href="${esc(e.where.url || e.url)}" target="_blank" rel="noopener">${esc(e.where.label.length > 42 ? e.where.label.slice(0, 41) + "…" : e.where.label)}</a>` : esc(LSRC[e.source]?.[1] ?? e.source);
  return `<blockquote class="lq"><p>“${esc(e.snippet || e.title)}”</p><footer>${lSrcBadge(e.source)}${where}${e.author && !opts.noAuthor ? `<span>${esc(e.author)}</span>` : ""}${e.at ? `<span>${esc(lAgo(e.at))}</span>` : ""}<a class="lopen" href="${esc(e.url)}" target="_blank" rel="noopener" aria-label="Open the post">${ICON.ext}</a></footer></blockquote>`;
}
function leadsResult(r) {
  const L = S.leads;
  const done = r.done && !L.busy;
  const byId = new Map((r.evidence ?? []).map((e) => [e.id, e]));
  const kw = (r.keywords ?? []).map((k) => `<span class="dtag">${esc(k)}</span>`).join("");
  const head = `${leadsSources(r)}
    <p class="lsum">${done ? "" : '<span class="spin"></span>'}${r.counts?.posts ? `<span><b>${r.counts.pains}</b> pain signals in <b>${r.counts.posts}</b> public posts from <b>${r.counts.places}</b> places</span>` : `<span>${done ? "Nothing matched yet." : "Searching…"}</span>`}
      <span class="dkw"><span class="hint">searched for</span> ${kw}</span>${done && r.at && Date.now() - r.at > 60_000 ? `<span class="hint">· from ${esc(lAgo(r.at))}</span>` : ""}<span class="spacer"></span>${done ? `<button class="btn ghost" data-lrefresh>Refresh</button>` : ""}</p>`;
  const themes = (r.themes ?? []).map((t, i) => leadsTheme(t, i, byId)).join("");
  const audience = r.dir === "audience";
  const apps = (r.apps ?? []).map((a) => `<a class="lbuild" href="${esc(a.url)}" target="_blank" rel="noopener"><span class="lsb s-appstore">App</span><span class="lbt">${esc(a.name)}</span><span class="hint">${a.rating ? `★ ${a.rating} · ${kfmt(a.ratings ?? 0)} ratings` : "new"}${a.price ? ` · ${esc(a.price)}` : ""}</span></a>`);
  const builders = (r.builders ?? []).map((b) => `<a class="lbuild" href="${esc(b.url)}" target="_blank" rel="noopener"><span class="lsb s-hn">HN</span><span class="lbt">${esc(b.title.replace(/^(Show|Launch) HN:\s*/i, ""))}</span><span class="hint">▲ ${b.points} · ${esc(lAgo(b.at))}</span></a>`);
  const places = (r.places ?? []).filter((p) => p.kind !== "app").slice(0, 12);
  const maxN = Math.max(1, ...places.map((p) => p.n));
  const ev = r.evidence ?? [];
  const shown = L.more ? ev.slice(0, 60) : ev.slice(0, 10);
  const noThemes = done && !r.themes?.length;
  return `${head}
    <h3 class="dsub">${audience ? "What they need" : "The pains it answers"} <span class="hint">${audience ? "recurring pains, each with an app idea and the posts behind it" : "clustered from what people wrote, strongest first"}</span></h3>
    ${themes ? `<div class="lthemes">${themes}</div>` : noThemes ? `<div class="empty-state">No recurring pain yet in these sources${ev.length ? ", but the posts below are a start" : ""}. Try fewer or plainer words, flip the direction, or take the <button class="link" data-ldeep>deep dive</button>: X, YouTube and TikTok often say more.</div>` : `<div class="lthemes">${Array.from({ length: 3 }, () => '<div class="gcard skel"></div>').join("")}</div>`}
    ${places.length ? `<h3 class="dsub">Where they hang out <span class="hint">communities, threads and repos, by activity</span></h3><div class="lplaces">${places.map((p, i) => `<a class="lpl" href="${esc(p.url)}" target="_blank" rel="noopener" style="--i:${Math.min(i, 10)}">${lSrcBadge(p.source)}<span class="lpn">${esc(p.label)}</span><span class="lbar"><i style="transform:scaleX(${Math.max(0.06, p.n / maxN).toFixed(2)})"></i></span><span class="hint">${p.n ? `${p.n} post${p.n === 1 ? "" : "s"}${p.last ? ` · ${esc(lAgo(p.last))}` : ""}` : "community"}</span></a>`).join("")}</div>` : ""}
    ${apps.length || builders.length ? `<h3 class="dsub">Already out there <span class="hint">apps people review and makers who launched</span></h3><div class="lbuilds">${[...apps, ...builders].join("")}</div>` : ""}
    ${ev.length ? `<h3 class="dsub">The evidence <span class="hint">public posts, pain × engagement × recency</span></h3><div class="levs">${shown.map((e, i) => leadsEv(e, i)).join("")}</div>${ev.length > shown.length ? `<p style="text-align:center;margin-top:12px"><button class="btn" data-lmore>Show ${Math.min(60, ev.length) - shown.length} more</button></p>` : ""}` : ""}
    ${done ? `<div class="ldeep"><div><h4>${ICON.dive}Go deeper</h4><p>An agent runs your <b>last30days</b> skill (Reddit, X, YouTube, TikTok, HN, Polymarket, the web), reads app reviews and forums, sizes demand and competitors${audience ? ", and ranks five app ideas, each with a one-week MVP" : ", and gives a verdict with three adjacent ideas"}. The report lands under Reports below.</p></div><button class="btn primary" data-ldeep>Deep dive with last30days</button></div>` : ""}`;
}
function leadsTheme(t, i, byId) {
  const L = S.leads;
  const open = L.open.has(t.id);
  const saved = (L.st?.saved ?? []).some((x) => x.id === lSaveId(t));
  const audience = L.res?.dir === "audience";
  const quotes = open ? t.ids.map((id) => byId.get(id)).filter(Boolean) : t.quotes.slice(0, 2);
  const srcNames = t.sources.map((s) => LSRC[s]?.[1] ?? s).join(", ");
  return `<article class="lth" data-lth="${esc(t.id)}" style="--h:${LCAT_HUE[t.cat] ?? 220};--i:${Math.min(i, 8)}">
    <div class="lthtop"><span class="lcat">${esc(t.catLabel)}</span><span class="lheat" title="How strongly people put it: ${t.heat} of 7"><i style="transform:scaleX(${Math.min(1, t.heat / 6).toFixed(2)})"></i></span></div>
    ${audience ? `<h4 class="lidea-h">${esc(t.idea)}</h4><p class="lmeta">The pain: <b>${esc(t.title)}</b> · ${t.n} posts · ${esc(srcNames)}</p>` : `<h4>${esc(t.title)}</h4><p class="lmeta">${t.n} posts · ${esc(srcNames)} · <span class="lterms">${t.terms.map(esc).join(" · ")}</span></p>`}
    <div class="lqs">${quotes.map((e) => leadsQuote(e)).join("")}</div>
    ${t.n > 2 ? `<button class="link lall" data-lthopen>${open ? "Fewer posts" : `All ${t.n} posts`}</button>` : ""}
    ${audience ? "" : `<p class="lidea">${ICON.bulb}<span>${esc(t.idea)}</span></p>`}
    <div class="gacts"><button class="btn primary" data-lplan>Plan the app for them</button><button class="btn ghost" data-lresearch>Research &amp; plan it</button><button class="btn ghost" data-lsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button><button class="btn ghost" data-lcopy>Copy evidence</button></div>
  </article>`;
}
function leadsEv(e, i) {
  return `<article class="lev" style="--i:${Math.min(i, 10)}">
    ${e.title && e.title !== e.snippet ? `<p class="levt"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a></p>` : ""}
    ${leadsQuote(e)}
    <div class="levm">${e.signals.slice(0, 4).map((s) => `<span class="lsig">${esc(s)}</span>`).join("")}${e.points ? `<span class="hint">▲ ${kfmt(e.points)}</span>` : ""}${e.comments ? `<span class="hint">${kfmt(e.comments)} replies</span>` : ""}${e.rating ? `<span class="hint">${e.rating}★</span>` : ""}<span class="lscore" title="Pain ${e.pain} × relevance × engagement × recency">${e.score.toFixed(1)}</span></div>
  </article>`;
}
function leadsSaved() {
  const xs = S.leads.st?.saved ?? [];
  if (!xs.length) return "";
  return `<h3 class="dsub">Saved leads <span class="n hint">${xs.length}</span></h3><div class="lsaved">${xs.map((x) => `<article class="lsv" data-lsv="${esc(x.id)}">
      <div class="lsvt"><span class="lcat" style="--h:${LCAT_HUE[x.cat] ?? 220}">${esc(x.catLabel ?? "Lead")}</span><h4>${esc(x.dir === "audience" && x.idea ? x.idea : x.label)}</h4></div>
      <p class="hint">${esc(x.dir === "audience" ? "People → ideas" : "Idea → people")}: “${esc(x.text)}” · ${x.quotes.length} quotes · saved ${esc(lAgo(x.savedAt))}</p>
      <div class="gacts"><button class="btn ghost" data-lsvplan>Plan the app for them</button><button class="btn ghost" data-lsvopen>Search again</button><button class="btn ghost" data-lsvcopy>Copy evidence</button><button class="btn ghost" data-lsvdel>Remove</button></div>
    </article>`).join("")}</div>`;
}
function leadsReports() {
  const xs = S.leads.st?.reports ?? [];
  if (!xs.length) return S.leads.st ? `<h3 class="dsub">Reports</h3><p class="hint">Deep dives land here as <code>~/.config/herdr-deck/leads/&lt;name&gt;.md</code>, with the session that wrote them.</p>` : "";
  return `<h3 class="dsub">Reports <span class="hint">deep dives your agents wrote</span></h3><div class="dideas">${xs.map((x, i) => {
    const open = S.leads.report === x.slug;
    const rep = S.leads.reports.get(x.slug);
    const live = x.session && rowOf(x.session.key);
    return `<article class="icard${open ? " open" : ""}" data-lrep="${esc(x.slug)}" style="--i:${Math.min(i, 8)}">
      <div class="itop" ${x.pending ? "" : "data-lrepopen"}><span class="ist ${x.pending ? "busy" : ""}">${x.pending ? '<span class="spin"></span>Researching' : x.kind === "audience" ? "People → ideas" : "Idea → people"}</span><h4>${esc(x.title)}</h4><span class="hint">${esc(lAgo(x.mtime))}</span></div>
      ${x.query && x.query !== x.title ? `<p class="iidea">“${esc(x.query)}”</p>` : ""}
      ${x.summary && !open ? `<p class="isum">${esc(x.summary)}</p>` : ""}
      ${open ? `<div class="iplan md">${rep ? md(rep.text) : '<span class="spin"></span>'}</div>` : ""}
      <div class="gacts">${live ? `<button class="btn ghost" data-lrepsess="${esc(x.session.key)}"><span class="dot" style="--c:${statusVar(live.status)}"></span>Open the session</button>` : ""}
        ${x.pending ? `<button class="btn ghost" data-lrepforget>Forget</button>` : `<button class="btn ghost" data-lrepopen>${open ? "Close" : "Read the report"}</button><button class="btn ghost" data-lrepcopy>Copy path</button>`}</div>
    </article>`;
  }).join("")}</div>`;
}

const lSaveId = (t) => `${S.leads.res?.dir ?? S.leads.dir}|${S.leads.res?.text ?? ""}|${t.id}`.slice(0, 120);
function lThemeQuotes(t) {
  const byId = new Map((S.leads.res?.evidence ?? []).map((e) => [e.id, e]));
  const all = t.ids.map((id) => byId.get(id)).filter(Boolean);
  return (all.length ? all : t.quotes).slice(0, 8);
}
function lEvidenceText(label, idea, quotes, head) {
  return [`${head}`, `Pain: ${label}`, idea ? `Idea: ${idea}` : "", "", ...quotes.map((q) => `- “${q.snippet}” (${LSRC[q.source]?.[1] ?? q.source}${q.where?.label ? `, ${q.where.label}` : ""}${q.at ? `, ${new Date(q.at).toISOString().slice(0, 10)}` : ""}) ${q.url}`)].filter((x, i) => x !== "" || i > 2).join("\n");
}
async function leadsDeep() {
  const L = S.leads;
  const ta = $("dbody").querySelector("[data-lq]");
  const text = String(ta?.value ?? L.text).trim();
  if (text.length < 3) return toast(L.dir === "audience" ? "Describe the audience first" : "Describe the idea first", true);
  L.text = text; store("leadsText", text);
  try {
    const r = await api("/api/leads/prompt", { kind: "deep", text, dir: L.dir }, 10_000);
    L.pendingReport = { slug: r.slug, text, dir: L.dir };
    await openNew({ machine: S.self, ...ownFolder(r, `leads ${text}`), project: "Leads", prompt: r.prompt, kind: "claude", label: r.label, title: L.dir === "audience" ? "Deep dive: what this audience needs" : "Deep dive: who needs this" });
    promptTop();
  } catch (e) { toast(e.message, true); }
}
async function leadsPlan(item, text, dir, places) {
  try {
    const r = await api("/api/leads/prompt", { kind: "plan", text, dir, item, places }, 10_000);
    S.disc.pending = { slug: r.slug, text: r.ideaText }; // the plan is written to Ideas; Discover lists it there once it starts
    await openNew({ machine: S.self, ...ownFolder(r, item?.idea || item?.label || text), project: "Leads", prompt: r.prompt, kind: "claude", label: r.label, title: "Plan the app for them" });
    promptTop();
  } catch (e) { toast(e.message, true); }
}
async function leadsSaveOp(op, lead) {
  try { const r = await api("/api/leads/save", { op, lead, id: lead.id }); if (S.leads.st) S.leads.st.saved = r.saved; leadsPatch(); }
  catch (e) { toast(e.message, true); }
}
