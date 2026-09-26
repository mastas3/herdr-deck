"use strict";
// ── covers:start ── Painted covers on idea cards (server: src/covers.ts). One block: its CSS, a watcher that adds a
// cover (or its category's halftone placeholder) to feed cards, saved builds and Studio builds, the plan dialog's
// Generate / Regenerate, and the "Covers: …" line on Ideas for you. Nothing else in the page needs to know about it.
S.covers = { st: null, at: 0, want: null };
{
  const css = document.createElement("style");
  css.textContent = `
.cov { position: relative; aspect-ratio: 16 / 9; overflow: hidden; flex: none; border-bottom: 1px solid var(--line); --c1: var(--line-2); --c2: var(--line);
  background: radial-gradient(color-mix(in srgb, var(--c1) 42%, transparent) 1.1px, transparent 1.7px) 0 0 / 10px 10px,
    radial-gradient(color-mix(in srgb, var(--c2) 34%, transparent) 1.1px, transparent 1.7px) 5px 5px / 10px 10px,
    color-mix(in srgb, var(--c1) 9%, var(--raise)); }
.cov img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .35s var(--ease, ease); }
.cov img.on { opacity: 1; }
.fcard > .cov { margin: -14px -14px 2px; border-radius: 15px 15px 0 0; }
.mixcard > .cov { margin: -13px -14px 2px; border-radius: 13px 13px 0 0; }
.stbuild > .cov { margin: -16px -16px 2px; border-radius: 17px 17px 0 0; max-height: 200px; }
.stbuild > .cov:not(.has) { aspect-ratio: auto; height: 46px; }
.plandlg > .cov { max-height: 230px; border-radius: 19px 19px 0 0; }
.stbuild > .cov img, .plandlg > .cov img { object-fit: contain; }
.cov .covgo { position: absolute; right: 10px; bottom: 10px; font-size: 12.5px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line-2);
  background: color-mix(in srgb, var(--raise) 88%, transparent); color: var(--ink); cursor: pointer; backdrop-filter: blur(6px); }
.cov .covgo:hover { border-color: var(--accent); } .cov .covgo[disabled] { cursor: default; opacity: .85; }
.covst { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: -4px 0 12px; font-size: 12.5px; color: var(--ink-3); }
.covst img { width: 22px; height: 22px; border-radius: 5px; object-fit: cover; }
.covst .link { font-size: 12.5px; }
@media (max-width: 700px) { .stbuild > .cov { margin: -14px -14px 2px; border-radius: 15px 15px 0 0; } .plandlg > .cov { max-height: 170px; } }
@media (prefers-reduced-motion: reduce) { .cov img { transition: none; } }`;
  document.head.append(css);
}
const covIdea = (el) => el.matches(".fcard") ? feedIdeas().find((y) => y.id === el.dataset.fid)
  : el.matches(".mixcard") ? allMixes().find((y) => y.id === el.dataset.mix) : el.matches(".stbuild") ? stBuildAt(el.dataset.sb) : undefined;
function covOf(x) {
  const st = S.covers.st, v = st?.have?.[x.id];
  const cat = x.coverCat || x.row || "money";
  const pal = st?.palettes?.[cat];
  return { url: v ? `/covers/${encodeURIComponent(x.id)}.webp?v=${v}` : x.coverUrl, thumb: v ? `/covers/${encodeURIComponent(x.id)}_thumb.webp?v=${v}` : x.thumbUrl, c1: pal?.[0], c2: pal?.[1] };
}
const covBusy = (id) => S.covers.st?.running?.id === id || (S.covers.st?.queue ?? []).includes(id);
/** Puts (or updates) the cover at the top of a card or dialog; `go` adds the Generate / Regenerate button. */
function covPut(host, x, go) {
  const c = covOf(x);
  let el = host.querySelector(":scope > .cov");
  if (!el) { el = document.createElement("div"); el.className = "cov"; el.setAttribute("aria-hidden", go ? "false" : "true"); host.prepend(el); }
  if (c.c1 && el.style.getPropertyValue("--c1") !== c.c1) { el.style.setProperty("--c1", c.c1); el.style.setProperty("--c2", c.c2); }
  let img = el.querySelector("img");
  el.classList.toggle("has", !!c.url);
  if (c.url && img?.getAttribute("src") !== c.url) {
    img?.remove();
    img = new Image(); img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    // The box takes the painting's own paper colour, so a letterboxed cover (dialog, Studio) has no visible edges.
    img.onload = () => { img.classList.add("on"); try { const g = document.createElement("canvas").getContext("2d"); g.drawImage(img, 0, 0, 12, 12, 0, 0, 1, 1); const [r, gg, b] = g.getImageData(0, 0, 1, 1).data; el.style.background = `rgb(${r} ${gg} ${b})`; } catch {} };
    img.src = c.url;
    el.prepend(img);
  }
  if (go && S.covers.st?.enabled) {
    const busy = covBusy(x.id), label = S.covers.st?.running?.id === x.id ? "Painting…" : busy ? "Queued…" : c.url ? "Regenerate cover" : "Generate cover";
    let b = el.querySelector(".covgo");
    if (!b) { b = document.createElement("button"); b.className = "covgo"; b.type = "button"; el.append(b); b.onclick = (e) => { e.stopPropagation(); covGenerate(x, !!covOf(x).url); }; }
    if (b.textContent !== label) { b.textContent = label; b.disabled = busy; }
  }
}
function covStatusHTML(st) {
  if (!st?.enabled) return "";
  const mins = (t) => Math.max(1, Math.round((t - Date.now()) / 60_000));
  const n = st.next ?? {};
  const next = st.running ? `painting “${esc(st.running.title)}”… ${clock(st.running.elapsed + (Date.now() - S.covers.at))}`
    : st.stopped ? esc(st.stopped) : st.paused ? "paused" : !st.auto ? "automatic painting is off (covers.json)"
    : n.why === "cap" ? "next tomorrow" : n.why === "busy" ? "waiting for Codex to be free" : n.why === "none" ? "every top idea has one"
    : n.at && n.at > Date.now() ? `next in ${mins(n.at)} min` : "next soon";
  const last = st.last?.ok && st.have?.[st.last.id] ? `<img src="/covers/${encodeURIComponent(st.last.id)}_thumb.webp?v=${st.have[st.last.id]}" alt="" title="Latest: ${esc(st.last.title)}">` : "";
  const act = st.stopped || st.paused ? '<button class="link" data-covpause="resume">Resume</button>' : st.auto ? '<button class="link" data-covpause="pause">Pause</button>' : "";
  return `${last}<span>Covers: ${st.today} today · ${next}</span>${act}`;
}
/** Every card on screen gets its cover or placeholder; the feed gets the status line. Cheap and idempotent (it runs on every DOM change). */
function coversPaint() {
  S.covers.want = null;
  for (const d of document.querySelectorAll("dialog.plandlg[data-covid]")) if (d._covIdea) covPut(d, d._covIdea, true);
  const body = $("dbody");
  if (S.mode !== "discover" || !body) return;
  for (const el of body.querySelectorAll(".fcard[data-fid], .mixcard[data-mix], .stbuild[data-sb]:not(.skel)")) { const x = covIdea(el); if (x?.id) covPut(el, x, el.matches(".stbuild") && !covOf(x).url); }
  const fdh = body.querySelector("#feed > .fdh");
  if (fdh) {
    let line = fdh.nextElementSibling?.matches(".covst") ? fdh.nextElementSibling : null;
    const html = covStatusHTML(S.covers.st);
    if (!line && html) { line = document.createElement("div"); line.className = "covst"; fdh.after(line); }
    if (line && line._h !== html) { line.innerHTML = html; line._h = html; }
  }
}
const covSoon = () => { if (!S.covers.want) S.covers.want = requestAnimationFrame(coversPaint); };
new MutationObserver((ms) => { if (ms.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.matches?.(".cov, .cov *, .covst")))) covSoon(); }).observe($("dbody"), { childList: true, subtree: true });
async function coversLoad(op = "status", extra = {}) {
  try { S.covers.st = await api("/api/covers", { op, ...extra }, 15_000); S.covers.at = Date.now(); if (S.covers.st.note) toast(S.covers.st.note); }
  catch (e) { if (op !== "status") toast(e.message, true); }
  coversPaint();
}
function covGenerate(x, force) {
  const idea = { title: x.title, pitch: x.pitch, row: x.row, customer: x.customer, problem: x.problem, offer: x.offer, how: x.how };
  coversLoad("generate", { id: x.id, force, idea }).then(() => { if (covBusy(x.id)) toast(`Painting a cover for “${x.title}”. About a minute.`); });
}
// The plan dialog shows the cover on top, with Generate / Regenerate.
{
  const open0 = openPlan;
  openPlan = function (x, from) {
    const r = open0(x, from);
    const d = [...document.querySelectorAll("dialog.plandlg")].pop();
    if (d && x?.id) { d.dataset.covid = x.id; d._covIdea = x; covPut(d, x, true); if (!S.covers.st) coversLoad(); }
    return r;
  };
}
document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-covpause]"); if (b) coversLoad(b.dataset.covpause); });
// Status: every 30 s on Discover, every 4 s while a cover is being painted (the clock in the line ticks each second).
setInterval(() => {
  if (document.hidden || (S.mode !== "discover" && !document.querySelector("dialog.plandlg[open]"))) return;
  const st = S.covers.st, age = Date.now() - S.covers.at;
  if (!st || age > (st.running || st.queue?.length ? 4000 : 30_000)) coversLoad();
  else if (st.running) coversPaint();
}, 1000);
// ── covers:end ──
