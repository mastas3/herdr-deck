"use strict";
// Discover → Studio: the page (the conversation log, the first screen, the ingredient drawer).
// ── Studio: the page ────────────────────────────────────────────────────────────
function discMix() {
  return `<div class="studio" id="studio">
    <div class="stmain">
      <div class="stbar" id="stbar">${stBarHTML()}</div>
      <div class="stlog" id="stlog" aria-live="polite"></div>
      <div class="stcomp" id="stcomp"><div class="stbox">
        <div class="sttray" id="sttray">${stTrayHTML()}</div>
        <textarea class="stq" data-stq rows="1" enterkeyhint="send" maxlength="4000" placeholder="Ask for anything, or roll the dice…" aria-label="Message the Studio">${esc(load("studioDraft", ""))}</textarea>
        <div class="strow">
          <button type="button" class="stpill" data-stadd title="Pick from everything you have">${ICON.plus}<span>Ingredients</span></button>
          <button type="button" class="stic" data-stdice title="Dice: a sensible random combo" aria-label="Dice">${ICON.dice}</button>
          <button type="button" class="stic" data-stwild title="Wildcard: somewhere unexpected" aria-label="Wildcard">${ICON.wild}</button>
          <span class="spacer"></span><span class="hint stkeys">Enter to send · Shift+Enter for a new line</span>
          <span id="stact">${stActHTML()}</span>
        </div>
      </div></div>
    </div>
    <aside class="strail" id="strail" aria-label="Ingredients"></aside>
    <div class="stsheet" id="stsheet" hidden><div class="stscrim" data-stdone></div><div class="stsp" role="dialog" aria-label="Ingredients"></div></div>
  </div>`;
}
function stBarHTML() {
  const st = S.studio, cur = st.cur;
  const convos = st.home?.convos ?? [];
  const title = cur?.messages?.length ? cur.title || "Untitled" : "New conversation";
  const e = S.disc.mix.engines ?? st.home?.engines;
  const off = e && !e.claude ? "Claude Code isn't installed here" : "";
  modelPickerSet("studio-engine", { label: "Engine", compact: true, value: st.engine, onChange: (v) => { S.studio.engine = v; store("studioEngine", v); }, providers: [
    { id: "claude", label: "Claude", off, models: [{ v: "claude:haiku", l: "Claude Haiku", note: "fast" }, { v: "claude:sonnet", l: "Claude Sonnet", note: "deeper" }] },
    ...(e?.ollama?.length ? [{ id: "ollama", label: "Ollama", models: e.ollama.map((x) => ({ v: `ollama:${x}`, l: x, note: "private" })) }] : []),
    { id: "template", label: "Templates", models: [{ v: "template", l: "Templates", note: "instant, offline" }] },
  ] });
  return `<div class="stconv"><button class="stconvb" data-stmenu aria-expanded="${st.menu}" aria-haspopup="menu" title="Your conversations">${ICON.chat}<span class="stct">${esc(title)}</span>${convos.length ? `<span class="n">${convos.length}</span>` : ""}${ICON.chev}</button>${st.menu ? stMenuHTML(convos) : ""}</div>
    <span class="spacer"></span>
    <div class="steng">${modelPickerHTML("studio-engine")}</div>
    <button class="btn sm stnew" data-stnew ${cur?.messages?.length ? "" : "disabled"} title="Start a new conversation">${ICON.plus}<span>New</span></button>`;
}
function stMenuHTML(convos) {
  const cur = S.studio.cur?.id;
  return `<div class="stmenu" role="menu"><button class="stmi new" data-stnew role="menuitem">${ICON.plus}New conversation</button>
    ${convos.length ? convos.slice(0, 40).map((c) => `<div class="stmi${c.id === cur ? " on" : ""}"><button class="stmo" data-stopen="${esc(c.id)}" role="menuitem"><span class="stmt">${esc(c.title || "Untitled")}</span><span class="hint">${c.turns} message${c.turns === 1 ? "" : "s"} · ${esc(agoText(c.updated))}${c.running ? " · answering…" : ""}</span></button><button class="ib" data-stren="${esc(c.id)}" title="Rename" aria-label="Rename ${esc(c.title)}">${ICON.pencil}</button><button class="ib" data-stdel="${esc(c.id)}" title="Delete" aria-label="Delete ${esc(c.title)}">${ICON.trash}</button></div>`).join("")
      : '<p class="hint stmh">Your conversations are kept here.</p>'}</div>`;
}
function stTrayHTML() {
  const m = S.disc.mix;
  const fresh = m.justAdded; m.justAdded = null;
  if (!m.sel.length) return "";
  return `<span class="sttl">Use</span>${m.sel.map((x) => `<span class="mpick k-${esc(x.kind)}${x.id === fresh ? " fresh" : ""}"><span>${esc(x.name)}</span><button type="button" data-mixrm="${esc(x.id)}" aria-label="Remove ${esc(x.name)}">${ICON.x}</button></span>`).join("")}<button type="button" class="link sttclear" data-mixclear>Clear</button>`;
}
const stActHTML = () => (S.studio.job ? `<span class="mclock stclock" data-since="${S.studio.job.t0}">${clock(Date.now() - S.studio.job.t0)}</span><button type="button" class="stsend stop" data-ststop title="Stop" aria-label="Stop">${ICON.stop}</button>` : `<button type="button" class="stsend" data-stsend title="Send (Enter)" aria-label="Send">${ICON.send}</button>`);

// ── the conversation log: keyed items, so streaming only touches what changed ─────────────
function stRenderLog(el) {
  if (!el) return;
  const items = stLogItems();
  const have = new Map([...el.children].map((c) => [c.dataset.k, c]));
  let prev = null;
  for (const it of items) {
    let c = have.get(it.k);
    if (!c) { c = document.createElement("div"); c.dataset.k = it.k; if (S.studio.calm) c.classList.add("calm"); }
    have.delete(it.k);
    const cls = `stitem ${it.cls ?? ""}${c.classList.contains("calm") ? " calm" : ""}`;
    if (c.className !== cls) c.className = cls;
    if (c._h !== it.html) { c.innerHTML = it.html; c._h = it.html; }
    const want = prev ? prev.nextSibling : el.firstChild;
    if (c !== want) el.insertBefore(c, want);
    prev = c;
  }
  for (const c of have.values()) c.remove();
  S.studio.calm = false;
}
function stLogItems() {
  const st = S.studio, msgs = st.cur?.messages ?? [];
  if (!msgs.length && !st.job) return [{ k: "home", cls: "sthomei", html: stHomeHTML() }];
  const items = [];
  let lastA = -1;
  msgs.forEach((m, i) => { if (m.role === "assistant") lastA = i; });
  msgs.forEach((m, i) => { if (m.role === "user") items.push({ k: `u${i}`, cls: "stu", html: stUserHTML(m) }); else stBotItems(m, i, i === lastA && !st.job, items); });
  if (st.job) stBotItems({ blocks: st.job.blocks ?? [], refs: st.job.refs ?? {}, live: true }, msgs.length, true, items);
  return items;
}
function stUserHTML(m) {
  return `<div class="stbubble">${esc(m.text || "Assemble something out of these.")}</div>${m.use?.length ? `<div class="stuse">${m.use.map((x) => `<button class="ming k-${esc(x.kind)}" data-sting="${esc(x.id)}" title="Add to your picks">${esc(x.name)}</button>`).join("")}</div>` : ""}`;
}
function stBotItems(m, i, last, items) {
  let nb = 0;
  (m.blocks ?? []).forEach((b, j) => {
    if (b.t === "next" && !last) return;
    items.push({ k: `a${i}b${j}`, cls: `sta t-${b.t}${j === 0 ? " first" : ""}`, html: stBlockHTML(b, m, i, j, b.t === "build" ? nb++ : 0, last) });
  });
  items.push({ k: `a${i}m`, cls: "sta t-meta", html: m.live ? stLiveHTML(!(m.blocks ?? []).length) : stMetaHTML(m, last) });
}
/** Markdown, with [[inventory names]] as chips you can tap to add (swapped out before md(), which reads [[x]] as a wiki link). */
function stMd(text, refs = {}) {
  const names = [];
  const src = String(text ?? "").replace(/\[\[([^\]\n]{1,80})\]\]/g, (_, n) => `STREF${names.push(n) - 1}Z`);
  return md(src).replace(/STREF(\d+)Z/g, (_, i) => { const n = names[+i], r = refs[n]; return r ? `<button class="ming k-${esc(r.kind)} stref" data-sting="${esc(r.id)}" title="Add to your picks">${esc(n)}</button>` : `<b>${esc(n)}</b>`; });
}
function stBlockHTML(b, m, i, j, nb, last) {
  const who = j === 0 ? `<div class="stwho">${ICON.wild}<span>Studio</span></div>` : "";
  if (b.t === "text") return `${who}<div class="sttext md">${stMd(b.md, m.refs)}</div>`;
  if (b.t === "build") return `${who}${stBuildHTML(b.b, `${i}:${j}`, nb)}`;
  if (b.t === "ask") return `${who}<div class="stask"><p>${esc(b.q)}</p><div class="stopts">${b.options.map((o) => `<button class="stopt" data-stsay="${esc(o)}"${last ? "" : " disabled"}>${esc(o)}</button>`).join("")}${last ? '<button class="stopt ghost" data-stfocus>Something else…</button>' : ""}</div></div>`;
  if (b.t === "next") return `<div class="stnext"><span class="stlbl">Keep going</span>${b.items.map((o) => `<button class="stchip" data-stsay="${esc(o)}">${esc(o)}</button>`).join("")}<button class="stchip dice" data-stdice>${ICON.dice}Roll the dice</button></div>`;
  if (b.t === "pending") return `${who}${b.kind === "build" ? `<div class="stbuild skel"><span class="stsk w60"></span><span class="stsk w90"></span><span class="stsk w40"></span><span class="hint stsk-l"><span class="spin"></span>Assembling a build…</span></div>` : '<div class="stsk w50"></div>'}`;
  return "";
}
function stBuildHTML(x, key, nb) {
  const saved = stSaved(x.id);
  const dkey = `st:${key}:${x.id}`;
  const open = S.disc.mix.open.has(dkey);
  return `<article class="stbuild" data-sb="${esc(key)}" style="--h:${dHue(x.title)};--i:${nb}">
    <div class="stbh"><h4>${esc(x.title)}</h4><div class="mbadges"><span class="mdiff d-${esc(x.difficulty)}">${esc(MIX_DIFF[x.difficulty] ?? x.difficulty)}</span><span class="mwow" role="img" aria-label="Wow ${x.wow} of 5" title="Wow ${x.wow} of 5">${"★".repeat(x.wow)}<i>${"★".repeat(5 - x.wow)}</i></span>${x.source === "template" ? '<span class="msrc" title="From the instant template combiner, not a model">template</span>' : ""}</div></div>
    ${x.pitch ? `<p class="mpitch">${esc(x.pitch)}</p>` : ""}
    <div class="mings">${x.ids.map((id, k) => `<button class="ming k-${mixKindOf(id)}" data-sting="${esc(id)}" title="Add to your picks">${esc(x.ingredients[k] ?? id)}</button>`).join("")}${(x.extra ?? []).map((e) => `<span class="ming new" title="${esc(e)}: not something you have yet">+ ${esc(e.replace(/\s*\(.*$/, ""))}</span>`).join("")}</div>
    ${x.price || x.first_dollar ? `<div class="fkeys">${feedKeys(x)}</div>` : x.money ? `<p class="stmoney">${ICON.coin}<span>${esc(x.money)}</span></p>` : ""}
    ${x.customer ? `<p class="stfor"><b>For</b> ${esc(x.customer)}</p>` : ""}
    <details class="mmore" data-mdet="${esc(dkey)}"${open ? " open" : ""}><summary>${x.customer ? "The full plan" : "How it fits &amp; first steps"}</summary>${planBodyHTML(x)}</details>
    <div class="stacts"><button class="btn primary" data-sbplan>${ICON.bulb}Research &amp; plan it</button><button class="btn" data-sbbuild>${ICON.bolt}Build it now</button>
      <span class="stacts2"><button class="btn ghost sm" data-sbusers>Find users</button><button class="btn ghost sm" data-sbriff>Riff on this</button><button class="btn ghost sm" data-sbsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button><button class="btn ghost sm" data-sbcopy title="Copy" aria-label="Copy">${ICON.copy}</button></span></div>
  </article>`;
}
function stLiveHTML(empty) {
  const j = S.studio.job;
  return `${empty ? `<div class="stwho">${ICON.wild}<span>Studio</span></div><div class="stthink"><span class="stsk w70"></span><span class="stsk w45"></span></div>` : ""}<div class="stlive" role="status"><span class="stdots" aria-hidden="true"><i></i><i></i><i></i></span><b>${esc(j?.stage && j.stage !== "Writing…" ? j.stage : j?.blocks?.length ? "Assembling" : "Thinking")}</b><span class="hint">${esc(mixEngineLabel(...stEngineParts()))}</span><span class="mclock" data-since="${j?.t0 ?? Date.now()}">${clock(Date.now() - (j?.t0 ?? Date.now()))}</span><span class="spacer"></span><button class="btn ghost sm" data-ststop>Stop</button></div>`;
}
function stMetaHTML(m, last) {
  const secs = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const bits = [mixEngineLabel(m.engine, m.model), m.ms ? secs(m.ms) : "", m.firstMs && m.engine !== "template" ? `first words in ${secs(m.firstMs)}` : ""].filter(Boolean);
  return `<div class="stmeta"><span>${esc(bits.join(" · "))}</span>${m.note ? `<span class="stnote">${ICON.warn}${esc(m.note)}</span>` : ""}${last && (m.error || m.note) ? '<button class="link" data-stretry>Try again</button>' : ""}</div>`;
}

// ── the first screen: what you have, the dice, the deck ───────────────────────────────────
function stHomeHTML() {
  const h = S.studio.home;
  const c = h?.counts;
  const total = c ? Object.values(c).reduce((a, b) => a + b, 0) : 0;
  const combos = total >= 3 ? Math.round((total * (total - 1) * (total - 2)) / 6) : 0;
  const stat = (k, n) => `<button class="ststat k-${k}" data-stdk="${k}" data-stadd><b>${n}</b>${esc(ST_SHORT[k].toLowerCase())}</button>`;
  const intents = h?.intents ?? [];
  const pick = S.studio.intent;
  const deck = stDeck(h?.starters ?? [], intents, pick);
  const recent = (h?.convos ?? []).slice(0, 3);
  return `<section class="sthome">
    <div class="sthero"><div class="sthl"><p class="steye">${ICON.wild}Studio</p><h3>What shall we build?</h3>
      <p class="stsub">${c ? `Everything you have, in one place.${combos ? ` That’s <b>${combos.toLocaleString()}</b> three-way combinations.` : ""}` : "Reading everything you have…"}</p>
      <div class="ststats">${c ? ["project", "repo", "conn", "tool", "interest"].map((k) => stat(k, c[k] ?? 0)).join("") : Array.from({ length: 5 }, () => '<span class="ststat skel"></span>').join("")}</div></div>
      <div class="stdice"><button class="stdie" data-stdice>${ICON.dice}<span><b>Dice</b><small>a sensible combo</small></span></button><button class="stdie wild" data-stwild>${ICON.wild}<span><b>Wildcard</b><small>somewhere nobody’s been</small></span></button></div></div>
    <div class="stdeckh"><nav class="stints" aria-label="What for">${[["all", "All ideas", 215], ...intents.map((x) => [x.id, x.label, x.hue])].map(([id, label, hue]) => `<button data-stint="${esc(id)}" aria-pressed="${pick === id}" style="--h:${hue}"><i></i>${esc(label)}</button>`).join("")}</nav>
      <button class="btn ghost sm stshuf" data-stshuffle title="New ideas from the same inventory">${ICON.shuffle}Shuffle</button></div>
    <div class="stdeck">${h ? deck.cards || '<p class="hint">Nothing to suggest yet: add some interests on For you.</p>' : Array.from({ length: 6 }, () => '<div class="ststart skel"></div>').join("")}</div>
    ${deck.more ? `<p class="stmore"><button class="btn" data-stmoreideas>Show ${deck.more} more ideas</button></p>` : ""}
    ${recent.length ? `<h4 class="stsec">Pick up where you left off</h4><div class="strecent">${recent.map((x) => `<button class="strec" data-stopen="${esc(x.id)}">${ICON.chat}<span>${esc(x.title || "Untitled")}</span><span class="hint">${esc(agoText(x.updated))}</span></button>`).join("")}</div>` : ""}
  </section>`;
}
/** The deck for an intent; "All" deals the intents round-robin so the first screen shows the whole range. */
function stDeck(starters, intents, pick) {
  const hue = Object.fromEntries(intents.map((x) => [x.id, x]));
  let list = pick === "all" ? [] : starters.filter((s) => s.intent === pick);
  if (pick === "all") {
    const by = intents.map((x) => starters.filter((s) => s.intent === x.id));
    for (let r = 0; by.some((xs) => xs[r]); r++) for (const xs of by) if (xs[r]) list.push(xs[r]);
  }
  const limit = S.studio.more || pick !== "all" ? list.length : isPhone() ? 6 : 9;
  const cards = list.slice(0, limit).map((s, n) => `<button class="ststart" data-ststart="${esc(s.id)}" style="--h:${hue[s.intent]?.hue ?? 215};--i:${Math.min(n, 12)}"><span class="stint"><i></i>${esc(hue[s.intent]?.label ?? "")}</span><span class="stpt">${s.parts.map((p) => (p.ing ? `<span class="ming k-${esc(p.ing.kind)}">${esc(p.ing.name)}</span>` : esc(p.text))).join("")}</span><span class="stgo" aria-hidden="true">${ICON.send}</span></button>`).join("");
  return { cards, more: Math.max(0, list.length - limit) };
}

// ── the ingredient drawer: a side rail when there's room, a bottom sheet when there isn't ─────
function stRenderDrawer(root) {
  const st = S.studio;
  const wide = root.clientWidth >= 940;
  if (wide !== st.wide) { st.wide = wide; root.classList.toggle("wide", wide); }
  const rail = root.querySelector("#strail"), sheet = root.querySelector("#stsheet"), sp = sheet.querySelector(".stsp");
  const open = wide || st.drawer;
  sheet.hidden = wide || !st.drawer;
  const host = wide ? rail : sp, other = wide ? sp : rail;
  if (other.firstChild) other.replaceChildren();
  if (!open) return;
  if (!host.querySelector(".stdrawer")) host.innerHTML = `<div class="stdrawer"><div class="stdhd" id="stdh"></div><div class="stdsearch"><input class="inp" type="search" data-stdq placeholder="Search everything you have" value="${esc(S.disc.mix.q)}" autocomplete="off" enterkeyhint="search" aria-label="Search ingredients"></div><nav class="stdtabs" id="stdt" aria-label="Kinds"></nav><div class="stdl" id="stdl"></div></div>`;
  setHTML(host.querySelector("#stdh"), stDrawerHead(!wide));
  setHTML(host.querySelector("#stdt"), stDrawerTabs());
  setHTML(host.querySelector("#stdl"), stDrawerList());
}
function stDrawerHead(sheet) {
  const n = S.disc.mix.sel.length;
  return `<b>Ingredients</b><span class="hint">${n ? `${n} picked` : "tap to pick"}</span><span class="spacer"></span><button class="link" data-stdall aria-pressed="${S.disc.mix.all}" title="Also list things that aren't set up on this machine">${S.disc.mix.all ? "Only ready ones" : "Show all"}</button>${sheet ? `<button class="btn primary sm" data-stdone>Done</button>` : ""}`;
}
const stNoise = (x) => /^(Background|Homebrew) service|SSH host|profile$/i.test(x.desc ?? "");
function stPool(k) {
  const m = S.disc.mix, q = m.q.trim().toLowerCase();
  const xs = (m.ings ?? []).filter((x) => x.kind === k && (m.all || x.ready) && (!q || `${x.name} ${x.desc} ${x.group ?? ""}`.toLowerCase().includes(q)));
  return [...xs.filter((x) => !stNoise(x)), ...xs.filter(stNoise)];
}
function stDrawerTabs() {
  const m = S.disc.mix, q = m.q.trim();
  return MIX_KINDS.map(([k]) => { const sel = m.sel.filter((x) => x.kind === k).length; return `<button class="k-${k}" data-stdk="${k}" aria-pressed="${!q && S.studio.dk === k}"><span class="kdot"></span>${ST_SHORT[k]} <span class="n">${m.ings ? stPool(k).length : "…"}</span>${sel ? `<b class="stdsel">${sel}</b>` : ""}</button>`; }).join("");
}
const stRow = (x) => `<button class="stdrow k-${esc(x.kind)}${x.ready ? "" : " off"}" data-ing="${esc(x.id)}" aria-pressed="${mixIsSel(x.id)}"><span class="kdot"></span><span class="stdt"><span class="stdn">${esc(x.name)}</span>${x.desc && !/^[>|]-?$/.test(x.desc.trim()) ? `<span class="stdd">${esc(x.desc)}</span>` : ""}</span><span class="stdck" aria-hidden="true">${ICON.check}</span></button>`;
function stDrawerList() {
  const m = S.disc.mix;
  if (!m.ings) return Array.from({ length: 8 }, () => '<div class="stdrow skel"></div>').join("");
  const q = m.q.trim();
  const more = (key, xs, n) => (m.more.has(key) || xs.length <= n + 2 ? xs : xs.slice(0, n));
  const moreBtn = (key, xs, shown) => (xs.length > shown.length ? `<button class="stdmore" data-mixmore="${esc(key)}">Show ${xs.length - shown.length} more</button>` : "");
  const flat = (key, xs, n) => { const s = more(key, xs, n); return s.map(stRow).join("") + moreBtn(key, xs, s); };
  const grouped = (k, xs, n) => { const g = new Map(); for (const x of xs) g.set(x.group ?? "Other", [...(g.get(x.group ?? "Other") ?? []), x]); return [...g].map(([name, ys]) => `<h5>${esc(name)} <span class="n">${ys.length}</span></h5>${flat(`${k}:${name}`, ys, n)}`).join(""); };
  if (q) {
    const out = MIX_KINDS.map(([k, label]) => { const xs = stPool(k); return xs.length ? `<h5 class="k-${k}"><span class="kdot"></span>${esc(label)} <span class="n">${xs.length}</span></h5>${flat(`q:${k}`, xs, 8)}` : ""; }).join("");
    return out || `<p class="hint stdempty">Nothing matches “${esc(q)}”.${m.all ? "" : ' <button class="link" data-stdall>Include things not set up</button>'}</p>`;
  }
  const k = S.studio.dk;
  const xs = stPool(k);
  if (!xs.length) return `<p class="hint stdempty">${k === "repo" ? "No gems found yet: open For you and let it search GitHub." : (k === "conn" || k === "tool") && (m.connLoading || m.loading) ? '<span class="spin"></span> Scanning your connections…' : "Nothing here yet."}</p>`;
  return k === "conn" || k === "tool" ? grouped(k, xs, 5) : flat(k, xs, 14);
}
function stOpenDrawer(kind) {
  const st = S.studio;
  if (kind) { st.dk = kind; store("studioKind", kind); S.disc.mix.q = ""; }
  const root = stView()?.querySelector("#studio");
  if (root && root.clientWidth >= 940) { mixPatch("drawer"); const s = root.querySelector("[data-stdq]"); if (kind && s) s.value = ""; s?.focus({ preventScroll: true }); return; }
  st.drawer = true;
  mixPatch("drawer");
  const s = root?.querySelector("#stsheet [data-stdq]");
  if (s && kind) s.value = "";
  if (s && !isPhone()) s.focus({ preventScroll: true });
}
function stCloseDrawer() { S.studio.drawer = false; mixPatch("drawer"); }
