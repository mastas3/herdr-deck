"use strict";
// ══ Discover ═════════════════════════════════════════════════════════════════
// Repos worth forking, matched to what you build; an idea lab that searches GitHub for building blocks; the
// plans agents write for your ideas; and "what if" sparks. Server side: src/discover.ts.
// Nothing here starts a session on its own: every action opens the New session dialog, prefilled.
ICON.compass = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="m10.7 5.3-1.6 3.8-3.8 1.6 1.6-3.8z"/></svg>';
ICON.bulb = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12.4h4M6.6 14.4h2.8M8 1.7a4.4 4.4 0 0 0-2.6 8c.4.3.6.8.6 1.3v.4h4V11c0-.5.2-1 .6-1.3A4.4 4.4 0 0 0 8 1.7z"/></svg>';
S.disc = { data: null, loading: false, tab: load("discTab", "you"), filter: null, idea: load("discIdea", ""), ideaRes: null, ideaBusy: false, open: null, plans: new Map(), shuffle: 0, pending: null, more: false };
const DTABS = [["you", "For you"], ["mix", "Studio"], ["lab", "Idea lab"], ["leads", "Leads"], ["research", "Research"], ["lib", "Library"], ["ideas", "Ideas"], ["saved", "Saved"]];
const kfmt = (n) => (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(n)));
function dHue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

async function loadDiscover(opts = {}) {
  clearTimeout(loadDiscover.t);
  if (S.disc.loading && !opts.refresh) return;
  S.disc.loading = true;
  if (opts.refresh && S.disc.data) { S.disc.data.refreshing = true; if (S.mode === "discover") renderDiscover(); }
  try { S.disc.data = await api("/api/discover", { refresh: !!opts.refresh, shuffle: S.disc.shuffle }); }
  catch (e) { toast(e.message, true); }
  S.disc.loading = false;
  if (S.mode !== "discover") return;
  // The mixer keeps its own regions up to date; a background refresh doesn't rebuild it (and the phone keyboard) mid-typing.
  if (S.disc.tab !== "mix" || !$("dbody").querySelector("#studio")) renderDiscover();
  // While GitHub is being searched, or today's mixes are being made, check back every few seconds.
  const fy = S.disc.data?.mixes?.forYou;
  if (S.disc.data?.refreshing || fy?.running || fy?.waiting) loadDiscover.t = setTimeout(() => { if (S.mode === "discover") loadDiscover(); }, 3000);
}
function discTab(t) { S.disc.tab = t; store("discTab", t); renderDiscover(); $("dbody").scrollTop = 0; if (t === "mix") mixEnter(); }
function gemBy(full) {
  const d = S.disc.data ?? {};
  const all = [...(d.gems ?? []), ...(d.trending ?? []), ...(d.saved ?? []), ...(S.disc.ideaRes?.groups ?? []).flatMap((g) => g.repos)];
  return all.find((g) => g.full === full);
}
const isSaved = (full) => (S.disc.data?.saved ?? []).some((x) => x.full === full);

function gemCard(g, i, opts = {}) {
  const projs = [...new Set((g.why ?? []).flatMap((w) => w.projects))].slice(0, 3);
  const saved = isSaved(g.full);
  const areas = (g.why ?? []).map((w) => w.label).slice(0, 2);
  return `<article class="gcard${opts.mini ? " gmini" : ""}" data-gfull="${esc(g.full)}" style="--h:${dHue(g.full)};--i:${Math.min(i, 10)}">
    <div class="gtop"><span class="cbadge">${esc(initials(g.name))}</span><div class="gid">
      <a class="gname" href="${esc(g.url)}" target="_blank" rel="noopener" title="Open ${esc(g.full)} on GitHub"><span class="gown">${esc(g.owner)}/</span>${esc(g.name)}</a>
      <div class="gmeta"><span title="${g.stars} stars">★ ${kfmt(g.stars)}</span>${g.lang ? `<span>${esc(g.lang)}</span>` : ""}${g.pushed ? `<span title="Last push ${esc(g.pushed.slice(0, 10))}">${esc(agoText(Date.parse(g.pushed)))}</span>` : ""}${g.license ? `<span>${esc(g.license)}</span>` : ""}${g.spm >= 25 ? `<span class="ghot" title="About ${kfmt(g.spm)} stars a month since it started">↑ ${kfmt(g.spm)}/mo</span>` : ""}</div>
    </div></div>
    ${g.desc ? `<p class="gdesc">${esc(g.desc)}</p>` : ""}
    ${g.topics?.length && !opts.mini ? `<div class="gtopics">${g.topics.slice(0, 5).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    ${areas.length ? `<div class="gwhy">${ICON.star}<span>Fits <b>${esc(areas.join(" + "))}</b>${projs.length ? ` · like your ${projs.map((p) => `<i>${esc(p)}</i>`).join(", ")}` : ""}</span></div>` : ""}
    <div class="gacts"><button class="btn primary" data-gfork>Fork &amp; explore</button><a class="btn ghost" href="${esc(g.url)}" target="_blank" rel="noopener">GitHub</a><button class="btn ghost" data-gsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button><button class="btn ghost" data-gmix title="Add it to the mixer and combine it with your other things">Mix this</button>${opts.saved ? "" : `<button class="btn ghost" data-gdis title="Don’t show it again">Dismiss</button>`}</div>
  </article>`;
}
function discStatus(d) {
  const n = d.profile.interests.length;
  if (!d.gh) return `<span class="derr">${ICON.warn}The GitHub CLI (<code>gh</code>) isn’t installed here, so there’s nothing to search with.</span>`;
  const when = d.fetchedAt ? `found ${esc(agoText(d.fetchedAt))}` : "";
  return `${d.refreshing ? `<span class="spin"></span><span>Searching GitHub${d.progress?.total ? ` · ${Math.min(d.progress.done, d.progress.total)} of ${d.progress.total}` : ` in ${n} areas`}… cached results stay up meanwhile</span>` : `<span>${d.stale && d.fetchedAt ? `<b class="dstale">Stale</b> · ` : ""}${when ? `Gems ${when}` : "No gems fetched yet"}</span>`}
    ${d.error ? `<span class="derr" title="${esc(d.error)}">${ICON.warn}${esc(d.error.slice(0, 90))}</span>` : ""}<span class="spacer"></span><button class="btn ghost" data-drefresh ${d.refreshing ? "disabled" : ""}>Refresh</button>`;
}
function renderDiscover() {
  const d = S.disc.data;
  const tab = S.disc.tab;
  const nIdeas = d?.ideas?.length ?? 0, nSaved = (d?.saved?.length ?? 0) + (d?.mixes?.saved?.length ?? 0);
  const tabs = DTABS.map(([id, label]) => `<button data-dtab="${id}" aria-pressed="${tab === id}">${label}${id === "ideas" && nIdeas ? ` <span class="n">${nIdeas}</span>` : id === "saved" && nSaved ? ` <span class="n">${nSaved}</span>` : ""}</button>`).join("");
  // The Studio, once on screen, is only ever patched region by region: its inputs are never rebuilt under your fingers.
  if (tab === "mix" && $("dbody")._mode === "discover" && $("dbody").querySelector(":scope > .view #studio")) {
    const nav = $("dbody").querySelector(".dtabs");
    if (nav) setHTML(nav, tabs);
    return mixPatch();
  }
  // Leads (its own block below) patches its results under the input, never the input itself.
  if (tab === "leads" && $("dbody")._mode === "discover" && $("dbody").querySelector(":scope > .view #leadsres")) { const nav = $("dbody").querySelector(".dtabs"); if (nav) setHTML(nav, tabs); return leadsPatch(); }
  if (tab === "research" && $("dbody")._mode === "discover" && $("dbody").querySelector(":scope > .view #rsbody")) { const nav = $("dbody").querySelector(".dtabs"); if (nav) setHTML(nav, tabs); return rsPatch(); }
  // The Library (public/library.js) patches under its inputs, like Leads.
  if (tab === "lib" && $("dbody")._mode === "discover" && $("dbody").querySelector(":scope > .view #libroot")) { const nav = $("dbody").querySelector(".dtabs"); if (nav) setHTML(nav, tabs); return libPatch(); }
  const head = `<header class="vh"><h2>${ICON.compass}Discover</h2><p>Ideas worth building and repos worth forking, picked for what you have. Any idea, searched against what already exists and planned by an agent.</p>
    <nav class="seg dtabs">${tabs}</nav></header>`;
  let body = "";
  if (tab === "leads") body = discLeads();
  else if (tab === "research") body = discResearch();
  else if (tab === "lib") body = discLibrary();
  else if (tab === "mix") body = discMix(); // the Studio paints at once from its own cache; it doesn't wait for Discover's data
  else if (!d) body = `<div class="dgrid">${Array.from({ length: 6 }, () => '<div class="gcard skel"></div>').join("")}</div><p class="hint">Reading your wiki and repos…</p>`;
  else if (tab === "lab") body = discLab(d);
  else if (tab === "ideas") body = discIdeas(d);
  else if (tab === "saved") body = discSaved(d, nSaved);
  else body = discForYou(d);
  if (tab === "you" && typeof galleryHTML === "function") body = galleryHTML() + body; // the gallery (public/js/gallery-*.js)
  const ta = document.activeElement?.matches?.("[data-didea], [data-stq], [data-stdq]") ? document.activeElement : null;
  const taSel = ta ? [...["didea", "stq", "stdq"].filter((k) => k in ta.dataset).map((k) => `[data-${k}]`), ta.selectionStart, ta.selectionEnd] : null;
  // Cards animate in when a tab (or a new idea result) first appears, not on every background update.
  const animKey = `${tab}|${S.disc.ideaRes?.text ?? ""}|${!!d}`;
  const calm = S.disc.animKey === animKey && $("dbody")._mode === "discover";
  S.disc.animKey = animKey;
  // The flag lives on the persistent .view element, so flipping it never rebuilds the cards.
  $("dbody").querySelector(":scope > .view")?.classList.toggle("calm", calm);
  // Background redraws keep where you swiped the horizontal rows to.
  const strips = [...$("dbody").querySelectorAll(".dstrip")].map((x) => x.scrollLeft);
  modeHTML(head + body);
  $("dbody").querySelectorAll(".dstrip").forEach((x, i) => { if (strips[i]) x.scrollLeft = strips[i]; });
  $("dbody").querySelector(":scope > .view")?.classList.toggle("calm", calm);
  if (taSel) { const t = $("dbody").querySelector(taSel[0]); t?.focus(); try { t?.setSelectionRange(taSel[1], taSel[2]); } catch {} }
  if (tab === "mix") { mixPatch("log", "drawer"); if (!S.disc.mix.ings && !S.disc.mix.loading) mixEnter(); }
}
function discForYou(d) {
  const p = d.profile;
  const f = S.disc.filter && p.interests.some((i) => i.id === S.disc.filter) ? S.disc.filter : null;
  const gems = f ? d.gems.filter((g) => g.why.some((w) => w.id === f)) : d.gems;
  const shown = gems.slice(0, S.disc.more || f ? 48 : 18);
  const langs = p.languages.slice(0, 3).map((l) => l.name);
  const chip = (i) => `<span class="dchip${f === i.id ? " on" : ""}${i.source === "you" ? " you" : ""}" title="${esc(i.projects.length ? `From ${i.projects.join(", ")}` : i.source === "you" ? "You added this" : "")}"><button data-dfilter="${esc(i.id)}" aria-pressed="${f === i.id}">${esc(i.label)}</button><button class="dx" data-dremove="${esc(i.id)}" aria-label="Remove ${esc(i.label)}">${ICON.x}</button></span>`;
  return `<section class="dprof"><h3 class="dsub">What you’re into</h3>
      <div class="dchips">${p.interests.map(chip).join("")}<button class="dchip add" data-dadd>${ICON.plus}Add</button></div>
      <p class="hint">From ${p.counts.wiki} wiki projects, ${p.counts.concepts} concepts, ${p.counts.log} recent log entries and ${p.counts.repos} local repos${p.connections.length ? `, plus ${p.connections.length} connections` : ""}.${langs.length ? ` Mostly ${esc(langs.join(", "))}.` : ""} Only these keywords are sent to GitHub search.${p.removed.length ? ` <button class="link" data-drestore>Restore ${p.removed.length} removed</button>` : ""}</p></section>
    ${f || typeof galleryHTML === "function" ? "" : mixesForYou(d)}
    <div class="dstatus">${discStatus(d)}</div>
    ${d.trending.length && !f ? `<h3 class="dsub">Trending in your areas <span class="hint">new this season, climbing fast</span></h3><div class="dstrip">${d.trending.map((g, i) => gemCard(g, i, { mini: true })).join("")}</div>` : ""}
    <h3 class="dsub">Hidden gems ${f ? `<span class="hint">in ${esc(p.interests.find((i) => i.id === f)?.label)}</span> <button class="link" data-dfilter="">Show all</button>` : `<span class="hint">30–5,000 stars, active this half-year, licensed</span>`}</h3>
    ${shown.length ? `<div class="dgrid">${shown.map((g, i) => gemCard(g, i)).join("")}</div>${gems.length > shown.length ? `<p style="text-align:center;margin-top:14px"><button class="btn" data-dmore>Show ${gems.length - shown.length} more</button></p>` : ""}`
      : d.refreshing || !d.fetchedAt ? `<div class="dgrid">${Array.from({ length: 6 }, () => '<div class="gcard skel"></div>').join("")}</div>` : `<div class="empty-state">No gems ${f ? "in this area" : "yet"}. Try Refresh, or add an interest.</div>`}
    ${d.dismissed ? `<p class="hint" style="margin-top:18px">${d.dismissed} dismissed. <button class="link" data-dundis>Bring them back</button></p>` : ""}`;
}
function repoRow(r) {
  const saved = isSaved(r.full);
  return `<div class="drow" data-gfull="${esc(r.full)}"><div class="drt"><a href="${esc(r.url)}" target="_blank" rel="noopener"><span class="gown">${esc(r.owner)}/</span>${esc(r.name)}</a><span class="gmeta"><span>★ ${kfmt(r.stars)}</span>${r.lang ? `<span>${esc(r.lang)}</span>` : ""}${r.pushed ? `<span>${esc(agoText(Date.parse(r.pushed)))}</span>` : ""}${r.license ? `<span>${esc(r.license)}</span>` : ""}</span></div>
    ${r.desc ? `<p>${esc(r.desc)}</p>` : ""}<div class="dracts"><button class="btn ghost" data-gfork>Fork &amp; explore</button><button class="btn ghost" data-gsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button></div></div>`;
}
function discLab(d) {
  const r = S.disc.ideaRes;
  const chips = (xs, cls = "") => xs.map((x) => `<span class="dtag ${cls}">${esc(x)}</span>`).join("");
  return `<section class="dlab">
      <textarea class="dbig" data-didea rows="3" placeholder="Describe any idea, however ambitious. “A voice that tells me each morning what today’s transits mean for my chart”, “a map of every drone show on Earth”…" aria-label="Your idea">${esc(S.disc.idea)}</textarea>
      <div class="dlabacts"><button class="btn" data-dsearch ${S.disc.ideaBusy ? "disabled" : ""}>${S.disc.ideaBusy ? '<span class="spin"></span>Searching…' : `${ICON.compass}Find building blocks`}</button><button class="btn primary" data-dresearch ${S.disc.ideaBusy ? "disabled" : ""}>${ICON.bulb}Research &amp; plan it</button>
        <span class="hint">Enter searches GitHub (only the idea’s keywords are sent). Research opens a new Claude Code session prefilled; you confirm it.</span></div>
    </section>
    ${r ? `<section class="dres">
      <p class="dkw"><span class="hint">Searched for</span> ${chips(r.keywords)}${r.cachedAt && Date.now() - r.cachedAt > 60_000 ? ` <span class="hint">· cached ${esc(agoText(r.cachedAt))}</span>` : ""}</p>
      ${r.related.length ? `<p class="dkw"><span class="hint">Your own work</span> ${chips(r.related, "dmine")}</p>` : ""}
      ${r.connections.length ? `<p class="dkw"><span class="hint">Your connections</span> ${chips(r.connections, "dconn")}</p>` : ""}
      ${r.groups.length ? r.groups.map((g) => `<h4 class="drole">${esc(g.role)} <span class="n">${g.repos.length}</span></h4><div class="dblocks">${g.repos.map(repoRow).join("")}</div>`).join("") : `<div class="empty-state">GitHub has nothing matching those words yet. That can be a good sign: research it to find the services and APIs that could do it.</div>`}
      ${r.topics.length ? `<p class="dkw dtopics"><span class="hint">GitHub topics</span> ${r.topics.map((t) => `<a class="dtag" href="https://github.com/topics/${encodeURIComponent(t.name)}" target="_blank" rel="noopener" title="${esc(t.desc)}">#${esc(t.name)}</a>`).join("")}</p>` : ""}
    </section>` : ""}
    <h3 class="dsub">Sparks <span class="hint">“what if” ideas from your projects, interests and connections</span> <button class="link" data-dshuffle>Shuffle</button></h3>
    <div class="dsparks">${d.sparks.map((s, i) => `<article class="spark" data-spark="${esc(s.id)}" style="--h:${dHue(s.id)};--i:${i}"><h4>${esc(s.title)}</h4><p>${esc(s.pitch)}</p><div class="suses">${chips(s.uses)}</div><div class="gacts"><button class="btn ghost" data-sparktry>Find building blocks</button><button class="btn primary" data-sparkplan>Research &amp; plan it</button></div></article>`).join("")}</div>`;
}
function discIdeas(d) {
  const ideas = d.ideas ?? [];
  if (!ideas.length) return `<div class="empty-state">No plans yet. Describe an idea in the <button class="link" data-dtab="lab">Idea lab</button> and press <b>Research &amp; plan it</b>: the agent writes its plan to <code>~/.config/herdr-deck/ideas/</code> and it shows up here.</div>`;
  return `<p class="hint dlead">Plans your agents wrote. Read one, then start building from it.</p><div class="dideas">${ideas.map((x, i) => {
    const open = S.disc.open === x.slug;
    const plan = S.disc.plans.get(x.slug);
    const live = x.session && rowOf(x.session.key);
    return `<article class="icard${open ? " open" : ""}" data-islug="${esc(x.slug)}" style="--i:${Math.min(i, 8)}">
      <div class="itop" ${x.pending ? "" : "data-iopen"}><span class="ist ${x.pending ? "busy" : esc(x.status)}">${x.pending ? '<span class="spin"></span>Researching' : esc(x.status)}</span><h4>${esc(x.title)}</h4><span class="hint">${esc(agoText(x.mtime))}</span></div>
      ${x.idea && x.idea !== x.title ? `<p class="iidea">“${esc(x.idea)}”</p>` : ""}
      ${x.summary && !open ? `<p class="isum">${esc(x.summary)}</p>` : ""}
      ${open ? `<div class="iplan md">${plan ? md(plan.text) : '<span class="spin"></span>'}</div>` : ""}
      <div class="gacts">${live ? `<button class="btn ghost" data-isess="${esc(x.session.key)}"><span class="dot" style="--c:${statusVar(live.status)}"></span>Open the session</button>` : ""}
        ${x.pending ? `<button class="btn ghost" data-iforget>Forget</button>` : `<button class="btn ghost" data-iopen>${open ? "Close" : "Read the plan"}</button><button class="btn primary" data-ibuild>Start building</button><button class="btn ghost" data-icopy>Copy path</button>`}</div>
    </article>`;
  }).join("")}</div>`;
}

/** Opens the New session dialog with a Discover prompt. The user reviews and confirms; nothing runs before that. */
async function discStart(kind, extra, title) {
  try {
    const r = await api("/api/discover/prompt", { kind, ...extra });
    S.disc.pending = r.slug ? { slug: r.slug, text: extra.text } : null;
    await openNew({ machine: S.self, ...ownFolder(r, r.slug || extra.repo?.name || extra.title || r.label), project: "Discover", prompt: r.prompt, kind: "claude", label: r.label, title });
    promptTop();
  } catch (e) { toast(e.message, true); }
}
/** Show a long prefilled prompt from its first line, not its last. */
function promptTop() { const t = $("nPrompt"); t.scrollTop = 0; t.setSelectionRange?.(0, 0); }
async function ideaSearch(text) {
  text = String(text ?? S.disc.idea).trim();
  if (text.length < 4) { toast("Describe the idea first", true); return null; }
  S.disc.idea = text; store("discIdea", text);
  S.disc.ideaBusy = true; S.disc.tab = "lab"; store("discTab", "lab");
  renderDiscover();
  try { S.disc.ideaRes = { ...(await api("/api/discover/idea", { text }, 25_000)), text }; }
  catch (e) { toast(e.message, true); }
  S.disc.ideaBusy = false;
  if (S.mode === "discover") renderDiscover();
  return S.disc.ideaRes?.text === text ? S.disc.ideaRes : null;
}
async function ideaResearch(text) {
  text = String(text ?? S.disc.idea).trim();
  let r = S.disc.ideaRes?.text === text ? S.disc.ideaRes : await ideaSearch(text);
  // GitHub slow or rate-limited: plan it anyway; the research agent does its own searching.
  if (!r && text.length >= 4) { try { r = await api("/api/discover/prompt", { kind: "research", text }, 10_000); } catch (e) { toast(e.message, true); } }
  if (!r) return;
  S.disc.pending = { slug: r.slug, text };
  await openNew({ machine: S.self, ...ownFolder(r, r.slug || text), project: "Idea lab", prompt: r.prompt, kind: "claude", label: `Plan: ${text.slice(0, 28)}`, title: "Research & plan this idea" });
  promptTop();
}
// A research session that actually started gets listed under Ideas right away (as "Researching").
$("newDlg").addEventListener("close", () => {
  const p = S.disc.pending;
  S.disc.pending = null;
  if (!p || $("newDlg").returnValue !== "ok" || !$("nPrompt").value.includes(`ideas/${p.slug}.md`)) return;
  api("/api/discover/idea-started", p).then((r) => { if (S.disc.data) S.disc.data.ideas = r.ideas; if (S.mode === "discover") renderDiscover(); }).catch(() => {});
});
async function discRepo(op, g) {
  try {
    const r = await api("/api/discover/repo", { op, repo: g, full: g.full });
    if (S.disc.data) { S.disc.data.saved = r.saved; S.disc.data.dismissed = r.dismissed; }
  } catch (e) { toast(e.message, true); }
}
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "discover") return;
  const t = e.target;
  const tab = t.closest("[data-dtab]")?.dataset.dtab;
  if (tab) return discTab(tab);
  if (t.closest("[data-drefresh]")) return loadDiscover({ refresh: true });
  const fl = t.closest("[data-dfilter]");
  if (fl) { S.disc.filter = fl.dataset.dfilter && S.disc.filter !== fl.dataset.dfilter ? fl.dataset.dfilter : null; return renderDiscover(); }
  const rm = t.closest("[data-dremove]")?.dataset.dremove;
  if (rm) { try { S.disc.data = await api("/api/discover/interest", { op: "remove", id: rm }); if (S.disc.filter === rm) S.disc.filter = null; renderDiscover(); } catch (err) { toast(err.message, true); } return; }
  if (t.closest("[data-dadd]")) {
    const label = await askDialog({ title: "Add an interest", text: "A few words GitHub can search for, like “procedural music” or “home robotics”. Gems for it appear after the next search.", input: "", ok: "Add" });
    if (!label?.trim()) return;
    try { S.disc.data = await api("/api/discover/interest", { op: "add", label }); renderDiscover(); if (S.disc.data.refreshing) loadDiscover.t = setTimeout(() => loadDiscover(), 3000); } catch (err) { toast(err.message, true); }
    return;
  }
  if (t.closest("[data-drestore]")) { try { S.disc.data = await api("/api/discover/interest", { op: "restore" }); renderDiscover(); } catch (err) { toast(err.message, true); } return; }
  if (t.closest("[data-dmore]")) { S.disc.more = true; return renderDiscover(); }
  if (t.closest("[data-dundis]")) { await discRepo("undismiss", { full: "*/*" }); return loadDiscover(); }
  if (t.closest("[data-dshuffle]")) { S.disc.shuffle++; return loadDiscover(); }
  if (t.closest("[data-dsearch]")) return ideaSearch($("dbody").querySelector("[data-didea]")?.value);
  if (t.closest("[data-dresearch]")) return ideaResearch($("dbody").querySelector("[data-didea]")?.value);
  const sp = t.closest("[data-spark]");
  if (sp) {
    const s = S.disc.data?.sparks?.find((x) => x.id === sp.dataset.spark);
    if (!s) return;
    if (t.closest("[data-sparktry]")) { $("dbody").scrollTop = 0; return ideaSearch(s.idea); }
    if (t.closest("[data-sparkplan]")) { S.disc.idea = s.idea; store("discIdea", s.idea); return ideaResearch(s.idea); }
    return;
  }
  if (mixClick(t)) return;
  const ic = t.closest("[data-islug]");
  if (ic) {
    const slug = ic.dataset.islug;
    const x = S.disc.data?.ideas?.find((i) => i.slug === slug);
    const sess = t.closest("[data-isess]")?.dataset.isess;
    if (sess) { setMode(null); return select(sess, { scroll: true, open: true }); }
    if (t.closest("[data-iforget]")) { try { const r = await api("/api/discover/idea-forget", { slug }); S.disc.data.ideas = r.ideas; renderDiscover(); } catch (err) { toast(err.message, true); } return; }
    if (t.closest("[data-icopy]")) return copy(`~/.config/herdr-deck/ideas/${slug}.md`, "path");
    if (t.closest("[data-ibuild]")) return discStart("build", { slug, title: x?.title ?? slug }, `Start building: ${(x?.title ?? slug).slice(0, 40)}`);
    if (t.closest("[data-iopen]")) {
      S.disc.open = S.disc.open === slug ? null : slug;
      renderDiscover();
      if (S.disc.open && !S.disc.plans.has(slug)) {
        try { S.disc.plans.set(slug, await api("/api/discover/idea-file", { slug })); } catch (err) { toast(err.message, true); S.disc.open = null; }
        renderDiscover();
      }
      $("dbody").querySelector(`[data-islug="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    return;
  }
  const card = t.closest("[data-gfull]");
  if (!card) return;
  const g = gemBy(card.dataset.gfull);
  if (!g) return;
  if (t.closest("[data-gfork]")) return discStart("fork", { repo: g }, `Fork & explore ${g.full}`);
  if (t.closest("[data-gmix]")) return mixOpenWith([{ id: `r:${g.full}`, kind: "repo", name: g.full, desc: g.desc ?? "" }], { add: true, toastText: `Added ${g.full} to your Studio picks` });
  if (t.closest("[data-gsave]")) { await discRepo(isSaved(g.full) ? "unsave" : "save", g); toast(isSaved(g.full) ? `Saved ${g.full}` : `Removed ${g.full} from Saved`); return renderDiscover(); }
  if (t.closest("[data-gdis]")) {
    card.classList.add("gone");
    await discRepo("dismiss", g);
    for (const k of ["gems", "trending"]) if (S.disc.data?.[k]) S.disc.data[k] = S.disc.data[k].filter((x) => x.full !== g.full);
    setTimeout(renderDiscover, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  }
});
$("dbody").addEventListener("input", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-didea]")) return;
  S.disc.idea = e.target.value;
  clearTimeout(S.disc.saveT);
  S.disc.saveT = setTimeout(() => store("discIdea", S.disc.idea), 300);
});
$("dbody").addEventListener("keydown", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-didea]")) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ideaResearch(e.target.value); }
  else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ideaSearch(e.target.value); }
});
