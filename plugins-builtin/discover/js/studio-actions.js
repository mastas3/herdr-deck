"use strict";
// Discover → Studio: sending, polling builds, the dice, and the page's events.
// ── actions ────────────────────────────────────────────────────────────────────────
const stTa = () => stView()?.querySelector("[data-stq]");
function stSetDraft(text) {
  store("studioDraft", text);
  const ta = stTa();
  if (ta) { ta.value = text; stGrow(ta); }
}
function stGrow(ta) { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`; }
function stCache() {
  const c = S.studio.cur;
  store("studioConvo", c ? { ...c, messages: c.messages.slice(-40) } : null);
}
async function stSend(text, use) {
  const st = S.studio, m = S.disc.mix;
  if (st.job) { toast("Still answering: Stop it first, or wait a moment"); return; }
  text = String(text ?? "").trim();
  const fromTray = use === undefined;
  use = (use ?? m.sel).map((x) => ({ id: x.id, kind: x.kind, name: x.name }));
  if (!text && !use.length) { stTa()?.focus(); toast("Say what you want to make, or roll the dice"); return; }
  const [engine, model] = stEngineParts();
  const cur = st.cur ?? { id: null, title: "", messages: [] };
  const draft = stTa()?.value ?? "", tray = [...m.sel];
  cur.messages.push({ role: "user", text, use, at: Date.now() });
  st.cur = cur;
  st.job = { status: "running", stage: "Sending…", blocks: [], refs: {}, t0: Date.now() };
  if (fromTray || draft.trim() === text) { stSetDraft(""); if (fromTray) mixSetSel([]); }
  st.menu = false;
  mixPatch("log", "tray", "act", "bar", "drawer");
  const ta = stTa();
  if (isPhone()) ta?.blur();
  stScrollTo(`u${cur.messages.length - 1}`);
  try {
    const r = await api("/api/discover/studio/send", { id: cur.id, text, use, engine, model }, 20_000);
    cur.id = r.convo.id; cur.title = r.convo.title;
    st.job = { ...r.job, t0: st.job.t0 };
    stCache();
    stPoll();
  } catch (e) {
    cur.messages.pop();
    st.job = null;
    if (!cur.messages.length) st.cur = cur.id ? cur : null;
    if (fromTray) mixSetSel(tray);
    if (!stTa()?.value) stSetDraft(draft || text);
    toast(e.message, true);
  }
  mixPatch("log", "tray", "act", "bar");
}
async function stPoll() {
  const st = S.studio;
  clearTimeout(st.t.poll);
  const id = st.job?.id;
  if (!id) return;
  try {
    const j = await api("/api/discover/studio/status", { job: id }, 8000);
    if (st.job?.id !== id) return;
    if (j.status === "running") st.job = { ...j, t0: st.job.t0 };
    else {
      st.job = null;
      if (j.message && st.cur?.id === j.convo) st.cur.messages.push(j.message);
      stCache();
      loadStudioHome();
    }
  } catch (e) { if (st.job?.id === id) { st.job = null; toast(e.message, true); if (st.cur?.id) stOpen(st.cur.id, { quiet: true }); } }
  mixPatch("log", "act");
  if (st.job) st.t.poll = setTimeout(stPoll, 250);
}
async function stStop() {
  const id = S.studio.job?.id;
  if (!id) return;
  try { await api("/api/discover/studio/stop", { job: id }, 5000); } catch {}
  stPoll();
}
async function stOpen(id, { quiet = false } = {}) {
  const st = S.studio;
  try {
    const r = await api("/api/discover/studio/convo", { id }, 10_000);
    if (quiet && st.cur?.id && st.cur.id !== id) return; // you moved on meanwhile
    const same = st.cur?.id === id && st.cur.messages.length === r.messages.length;
    st.cur = { id: r.id, title: r.title, messages: r.messages };
    if (r.job && !st.job) { st.job = { ...r.job, t0: Date.now() - (r.job.elapsed ?? 0) }; stPoll(); }
    st.menu = false;
    stCache();
    if (!same) st.calm = true;
    mixPatch("log", "bar", "act");
    if (!quiet && !same) requestAnimationFrame(() => { const log = stView()?.querySelector("#stlog"); log?.lastElementChild?.scrollIntoView({ block: "end" }); });
  } catch (e) {
    if (st.cur?.id === id) { st.cur = null; stCache(); mixPatch("log", "bar"); }
    if (!quiet) toast(e.message, true);
  }
}
function stNew() {
  const st = S.studio;
  st.cur = null; st.job = null; st.menu = false;
  clearTimeout(st.t.poll);
  stCache();
  mixPatch("log", "bar", "act");
  $("dbody").scrollTop = 0;
  if (!isPhone()) stTa()?.focus();
}
function stScrollTo(k) {
  requestAnimationFrame(() => {
    const el = stView()?.querySelector(`#stlog > [data-k="${k}"]`);
    if (!el) return;
    const box = $("dbody");
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
    box.scrollTo({ top, behavior: stReduce() ? "auto" : "smooth" });
  });
}
async function stDice(wild, btn) {
  btn?.classList.remove("rolling"); void btn?.offsetWidth; btn?.classList.add("rolling");
  try {
    const d = await api("/api/discover/studio/dice", { seed: Math.floor(Math.random() * 1e9), wild }, 10_000);
    const by = new Map((S.disc.mix.ings ?? []).map((x) => [x.id, x]));
    mixSetSel(d.parts.filter((p) => p.ing).map((p) => ingLite(by.get(p.ing.id) ?? p.ing)));
    stSetDraft(d.text);
    mixPatch("tray", "drawer");
    const send = stView()?.querySelector("[data-stsend]");
    send?.classList.remove("nudge"); void send?.offsetWidth; send?.classList.add("nudge");
    if (!isPhone()) stTa()?.focus();
  } catch (e) { toast(e.message, true); }
}
function stBuildAt(key) {
  const [i, j] = String(key).split(":").map(Number);
  const msgs = S.studio.cur?.messages ?? [];
  const m = i < msgs.length ? msgs[i] : S.studio.job;
  return m?.blocks?.[j]?.b;
}
async function stBuildNow(b) {
  try {
    const r = await api("/api/discover/studio/build-prompt", { build: b }, 10_000);
    await openNew({ machine: S.self, ...ownFolder(r, b.title), project: "Studio", prompt: r.prompt, kind: "claude", label: r.label, title: `Build it now: ${b.title.slice(0, 40)}` });
    promptTop();
  } catch (e) { toast(e.message, true); }
}
function stFindUsers(b) {
  const text = `${b.title}: ${b.pitch}`;
  if (typeof leadsFor === "function") return leadsFor(text);
  S.disc.idea = text; store("discIdea", text);
  S.disc.tab = "lab"; store("discTab", "lab");
  renderDiscover(); $("dbody").scrollTop = 0;
  ideaSearch(text);
}
function stAddIng(id, name) {
  const m = S.disc.mix;
  if (mixIsSel(id)) { toast(`${name} is already picked`); return; }
  const x = m.ings?.find((y) => y.id === id) ?? { id, kind: mixKindOf(id), name, desc: "" };
  mixSetSel([...m.sel, ingLite(x)]); m.justAdded = id;
  mixPatch("tray", "drawer");
  toast(`Added ${name}: it goes with your next message`);
}
async function stRename(id) {
  const c = S.studio.home?.convos?.find((x) => x.id === id);
  const t = await askDialog({ title: "Rename conversation", input: c?.title ?? S.studio.cur?.title ?? "", ok: "Rename" });
  if (!t?.trim()) return;
  try {
    const r = await api("/api/discover/studio/rename", { id, title: t });
    if (S.studio.home) S.studio.home.convos = r.convos;
    if (S.studio.cur?.id === id) { S.studio.cur.title = t.trim(); stCache(); }
    mixPatch("bar", "log");
  } catch (e) { toast(e.message, true); }
}
async function stDelete(id) {
  const c = S.studio.home?.convos?.find((x) => x.id === id);
  if (!(await askDialog({ title: `Delete “${c?.title ?? "this conversation"}”?`, text: "Its messages are removed from this machine. Saved builds stay saved.", ok: "Delete", danger: true }))) return;
  try {
    const r = await api("/api/discover/studio/delete", { id });
    if (S.studio.home) S.studio.home.convos = r.convos;
    if (S.studio.cur?.id === id) stNew(); else mixPatch("bar", "log");
  } catch (e) { toast(e.message, true); }
}

/** Clicks in the Studio and on mix cards. Returns true when it handled the click. */
function mixClick(t) {
  const m = S.disc.mix, st = S.studio;
  if (st.menu && !t.closest(".stconv")) { st.menu = false; mixPatch("bar"); }
  const ing = t.closest("[data-ing]")?.dataset.ing;
  if (ing) {
    const x = m.ings?.find((y) => y.id === ing);
    if (!x) return true;
    if (mixIsSel(ing)) mixSetSel(m.sel.filter((y) => y.id !== ing));
    else if (m.sel.length >= 16) { toast("That’s plenty: 16 at most", true); return true; }
    else { mixSetSel([...m.sel, ingLite(x)]); m.justAdded = x.id; }
    mixPatch("tray", "drawer");
    stView()?.querySelector(`[data-ing="${CSS.escape(ing)}"]`)?.focus({ preventScroll: true });
    return true;
  }
  const rm = t.closest("[data-mixrm]")?.dataset.mixrm;
  if (rm) { mixSetSel(m.sel.filter((y) => y.id !== rm)); mixPatch("tray", "drawer"); return true; }
  if (t.closest("[data-mixclear]")) { mixSetSel([]); mixPatch("tray", "drawer"); return true; }
  const more = t.closest("[data-mixmore]")?.dataset.mixmore;
  if (more) { m.more.add(more); mixPatch("drawer"); return true; }
  const sting = t.closest("[data-sting]");
  if (sting) { stAddIng(sting.dataset.sting, sting.textContent.trim()); return true; }
  const dk = t.closest("[data-stdk]")?.dataset.stdk;
  if (dk) { if (t.closest("[data-stadd]")) { stOpenDrawer(dk); return true; } st.dk = dk; store("studioKind", dk); m.q = ""; const s = stView()?.querySelector("[data-stdq]"); if (s) s.value = ""; mixPatch("drawer"); return true; }
  if (t.closest("[data-stadd]")) { stOpenDrawer(); return true; }
  if (t.closest("[data-stdone]")) { stCloseDrawer(); return true; }
  if (t.closest("[data-stdall]")) { m.all = !m.all; mixPatch("drawer"); return true; }
  if (t.closest("[data-stsend]")) { stSend(stTa()?.value ?? ""); return true; }
  if (t.closest("[data-ststop]")) { stStop(); return true; }
  if (t.closest("[data-stdice]")) { stDice(false, t.closest("[data-stdice]")); return true; }
  if (t.closest("[data-stwild]")) { stDice(true, t.closest("[data-stwild]")); return true; }
  const say = t.closest("[data-stsay]")?.dataset.stsay;
  if (say != null) { stSend(say, []); return true; }
  if (t.closest("[data-stfocus]")) { stTa()?.focus(); return true; }
  if (t.closest("[data-stretry]")) { const u = [...(st.cur?.messages ?? [])].reverse().find((x) => x.role === "user"); if (u) stSend(u.text, u.use ?? []); return true; }
  const start = t.closest("[data-ststart]")?.dataset.ststart;
  if (start) {
    const s = st.home?.starters?.find((x) => x.id === start);
    if (s) { const ings = s.parts.filter((p) => p.ing).map((p) => p.ing); stSend(s.text, [...ings, ...m.sel.filter((x) => !ings.some((y) => y.id === x.id))]); if (m.sel.length) { mixSetSel([]); mixPatch("tray", "drawer"); } }
    return true;
  }
  const intent = t.closest("[data-stint]")?.dataset.stint;
  if (intent) { st.intent = intent; st.more = false; store("studioIntent", intent); mixPatch("log"); return true; }
  if (t.closest("[data-stshuffle]")) { st.seed = Math.floor(Math.random() * 1e9); store("studioSeed", st.seed); t.closest(".sthome")?.querySelector(".stdeck")?.classList.add("shuf"); loadStudioHome(); return true; }
  if (t.closest("[data-stmoreideas]")) { st.more = true; mixPatch("log"); return true; }
  if (t.closest("[data-stmenu]")) { st.menu = !st.menu; mixPatch("bar"); return true; }
  if (t.closest("[data-stnew]")) { stNew(); return true; }
  const open = t.closest("[data-stopen]")?.dataset.stopen;
  if (open) { if (st.cur?.id !== open) { st.job = null; clearTimeout(st.t.poll); } stOpen(open); return true; }
  const ren = t.closest("[data-stren]")?.dataset.stren;
  if (ren) { st.menu = false; mixPatch("bar"); stRename(ren); return true; }
  const del = t.closest("[data-stdel]")?.dataset.stdel;
  if (del) { st.menu = false; mixPatch("bar"); stDelete(del); return true; }
  const sb = t.closest("[data-sb]");
  if (sb && !t.closest("summary")) {
    const b = stBuildAt(sb.dataset.sb);
    if (!b) return true;
    if (t.closest("[data-sbplan]")) mixResearch(b);
    else if (t.closest("[data-sbbuild]")) stBuildNow(b);
    else if (t.closest("[data-sbusers]")) stFindUsers(b);
    else if (t.closest("[data-sbriff]")) stSend(`Riff on “${b.title}”: three variations, one wilder, one cheaper, one I can ship this weekend.`, mixFromCard(b));
    else if (t.closest("[data-sbsave]")) mixSave(b).then(() => mixPatch("log"));
    else if (t.closest("[data-sbcopy]")) copy(mixText(b), "the build");
    return true;
  }
  const fc = t.closest("[data-fid]");
  if (fc) {
    const x = feedIdeas().find((y) => y.id === fc.dataset.fid);
    if (!x) return true;
    if (t.closest("[data-fbuild]")) stBuildNow(x);
    else if (t.closest("[data-fsave]")) mixSave(x).then(feedPatch);
    else if (!t.closest("a")) openPlan(x);
    return true;
  }
  const fm = t.closest("[data-fmore]");
  if (fm) { loadFeed("more", fm.dataset.fmore || undefined); return true; }
  if (t.closest("[data-frefresh]")) { loadFeed("refresh"); return true; }
  const card = t.closest("[data-mix]");
  if (!card || t.closest("summary")) return false;
  const x = allMixes().find((y) => y.id === card.dataset.mix);
  if (!x) return false;
  if (t.closest("[data-mplan]")) { mixResearch(x); return true; }
  if (t.closest("[data-mview]")) { openPlan(x, "saved"); return true; }
  if (t.closest("[data-mcopy]")) { copy(mixText(x), "the mix"); return true; }
  if (t.closest("[data-mopen]")) { mixOpenWith(mixFromCard(x), { text: `Take “${x.title}” further: ${x.pitch}`, toastText: "Opened in the Studio" }); return true; }
  if (t.closest("[data-msave]")) { mixSave(x).then(() => renderDiscover()); return true; }
  return false;
}
$("dbody").addEventListener("toggle", (e) => {
  const k = e.target.dataset?.mdet;
  if (!k) return;
  if (e.target.open) S.disc.mix.open.add(k); else S.disc.mix.open.delete(k);
  const item = e.target.closest(".stitem"); if (item) item._h = null; // its html now differs from what's cached
  const v = stView(); if (v) v._h = null;
}, true);
$("dbody").addEventListener("input", (e) => {
  if (S.mode !== "discover") return;
  const m = S.disc.mix;
  if (e.target.matches("[data-stq]")) { stGrow(e.target); clearTimeout(S.studio.t.draft); S.studio.t.draft = setTimeout(() => store("studioDraft", e.target.value), 300); }
  else if (e.target.matches("[data-stdq]")) { m.q = e.target.value; clearTimeout(S.studio.t.q); S.studio.t.q = setTimeout(() => mixPatch("drawer"), 60); }
});
$("dbody").addEventListener("keydown", (e) => {
  if (S.mode === "discover" && e.key === "Enter" && e.target.matches?.(".fcard")) { e.preventDefault(); const x = feedIdeas().find((y) => y.id === e.target.dataset.fid); if (x) openPlan(x); return; }
  if (S.mode !== "discover" || S.disc.tab !== "mix") return;
  if (e.key === "Escape" && (S.studio.drawer || S.studio.menu)) { e.preventDefault(); e.stopPropagation(); S.studio.menu = false; if (S.studio.drawer) stCloseDrawer(); else mixPatch("bar"); stTa()?.focus({ preventScroll: true }); return; }
  if (e.target.matches("[data-stq]") && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); stSend(e.target.value); }
  else if (e.target.matches("[data-stdq]") && e.key === "Enter") { e.preventDefault(); const first = stView()?.querySelector("#stdl [data-ing]"); first?.click(); }
});
// The layout follows the Studio's own width (the side rail needs room), not the window's.
new ResizeObserver(() => { const r = S.mode === "discover" && S.disc.tab === "mix" && stView()?.querySelector("#studio"); if (!r) return; if ((r.clientWidth >= 940) !== S.studio.wide) mixPatch("drawer"); else stSizes(r); }).observe($("dbody"));
// Connections → "Mix these": the picked store cards go to the mixer (key names stay out).
$("dbody").addEventListener("click", (e) => {
  if (S.mode !== "connections" || !e.target.closest("[data-cmix]")) return;
  const byId = new Map(connItems(S.conn.data.get(S.conn.machine ?? S.self)).map((i) => [i.id, i]));
  const xs = [...S.conn.pick].map((id) => byId.get(id)).filter((i) => i && i.cat !== "keys")
    .map((i) => { const tool = MIX_TOOL_CATS.has(i.cat) || ["agent", "sub", "skill", "mcp"].includes(i.kind); return { id: `${tool ? "t" : "c"}:${i.id}`, kind: tool ? "tool" : "conn", name: i.name, desc: i.detail ?? "" }; });
  if (!xs.length) return toast("Pick some connections first (API key names can’t be mixed)", true);
  S.conn.pick.clear();
  mixOpenWith(xs, { add: true, toastText: `Added ${xs.length} to the mixer` });
});
// ══ end Discover ═════════════════════════════════════════════════════════════
