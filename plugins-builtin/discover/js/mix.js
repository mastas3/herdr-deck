"use strict";
// Discover → Studio: its state and the Mixer's ingredients (Studio page: studio.js, studio-actions.js).
// ── Studio: a chat that assembles builds out of everything you have ──────────────────────────
// Server side: src/studio.ts (conversations, jobs, block parsing) and src/studio-prompts.ts (the assembler prompt,
// the starter deck, Dice). The tray of picked ingredients is the Mixer's selection (S.disc.mix.sel), so "Mix this" on
// a gem, "Mix these" in Connections and "Open in Studio" on a mix all land here. The model sees names and one-liners.
S.disc.mix = { sel: load("mixSel", []), q: "", all: false, ings: null, engines: null, connLoading: false, loading: false, open: new Set(), seen: new Set(), more: new Set() };
const MIX_KINDS = [["project", "Your projects"], ["repo", "Gems & trending"], ["conn", "Connections & services"], ["tool", "Tools & skills"], ["interest", "Interests"]];
const MIX_PREFIX = { p: "project", r: "repo", c: "conn", t: "tool", i: "interest" };
const mixKindOf = (id) => MIX_PREFIX[String(id)[0]] ?? "conn";
const MIX_DIFF = { weekend: "Weekend", week: "A week", month: "A month" };
const MIX_TOOL_CATS = new Set(["ai", "mcp", "skills"]);
const ingLite = (x) => ({ id: String(x.id), kind: x.kind, name: String(x.name), desc: String(x.desc ?? "").slice(0, 140) });
const mixIsSel = (id) => S.disc.mix.sel.some((x) => x.id === id);
function mixSetSel(sel) { S.disc.mix.sel = sel.slice(0, 16); store("mixSel", S.disc.mix.sel); }
function mixEngineLabel(engine, model) { return engine === "ollama" ? `Ollama · ${model ?? "local"}` : engine === "template" ? "templates" : `Claude${model ? ` ${model[0].toUpperCase()}${model.slice(1)}` : ""}`; }

Object.assign(ICON, {
  dice: TI2('<rect x="2.5" y="2.5" width="11" height="11" rx="2.6"/><circle cx="5.6" cy="5.6" r=".55" fill="currentColor"/><circle cx="8" cy="8" r=".55" fill="currentColor"/><circle cx="10.4" cy="10.4" r=".55" fill="currentColor"/>'),
  wild: TI2('<path d="M8 1.8 9.3 6.7 14.2 8 9.3 9.3 8 14.2 6.7 9.3 1.8 8 6.7 6.7z"/><path d="M13 1.8v2.4M11.8 3h2.4"/>'),
  send: TI2('<path d="M8 13.2V3M3.6 7.4 8 3l4.4 4.4"/>'),
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.6"/></svg>',
  shuffle: TI2('<path d="M2 4.6h2.3c3.6 0 3.8 6.8 7.4 6.8H14M2 11.4h2.3c1.3 0 2.1-.9 2.8-2.1M9 6.7c.7-1.2 1.5-2.1 2.8-2.1H14M12.2 2.8 14 4.6l-1.8 1.8M12.2 9.6l1.8 1.8-1.8 1.8"/>'),
  chat: TI2('<path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  pencil: TI2('<path d="m10.2 2.8 3 3-7.7 7.7H2.5v-3z"/>'),
  trash: TI2('<path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.2 4.3l.6 9h6.4l.6-9"/>'),
  copy: TI2('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.2a1.4 1.4 0 0 0 1.4 1.4h1.6"/>'),
  coin: TI2('<circle cx="8" cy="8" r="5.8"/><path d="M9.9 6.1c-.3-.7-1-1.1-1.9-1.1-1.1 0-1.9.6-1.9 1.5 0 2.1 3.9 1.1 3.9 3.1 0 .9-.9 1.5-2 1.5-.9 0-1.7-.4-2-1.2M8 4v1M8 11v1"/>'),
});
S.studio = {
  home: load("studioHome", null), cur: load("studioConvo", null), job: null, engine: load("studioEngine", "claude:haiku"),
  intent: load("studioIntent", "all"), seed: load("studioSeed", 0), dk: load("studioKind", "project"),
  drawer: false, menu: false, more: false, wide: false, savedIds: new Map(), t: {}, homeLoading: false,
};
const ST_SHORT = { project: "Projects", repo: "Gems", conn: "Services", tool: "Tools", interest: "Interests" };
const stEngineParts = () => { const e = S.studio.engine; const i = e.indexOf(":"); return i < 0 ? [e, undefined] : [e.slice(0, i), e.slice(i + 1)]; };
const stView = () => $("dbody").querySelector(":scope > .view");
const stReduce = () => reduceMotion.matches;
const stSaved = (id) => (S.studio.savedIds.has(id) ? S.studio.savedIds.get(id) : mixSaved(id));

/** Studio is patched region by region once on screen, so the message box and the drawer's search are never rebuilt under your fingers. */
function mixPatch(...ids) {
  if (S.mode !== "discover" || S.disc.tab !== "mix") return;
  const view = stView();
  const root = view?.querySelector("#studio");
  if (!root) return renderDiscover();
  stSizes(root);
  const all = !ids.length, has = (k) => all || ids.includes(k);
  if (has("bar")) setHTML(root.querySelector("#stbar"), stBarHTML());
  if (has("log")) stRenderLog(root.querySelector("#stlog"));
  if (has("tray")) setHTML(root.querySelector("#sttray"), stTrayHTML());
  if (has("act")) setHTML(root.querySelector("#stact"), stActHTML());
  if (has("drawer")) stRenderDrawer(root);
  view._h = null; // the whole-view cache no longer matches what's on screen
}
/** The chat fills the visible height (the composer sits at the bottom even when the log is short); the rail is as tall as the view. */
function stSizes(root) {
  const box = $("dbody");
  const top = root.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  root.style.setProperty("--stmin", `${Math.max(320, Math.round(box.clientHeight - top))}px`);
  root.style.setProperty("--dbh", `${box.clientHeight}px`);
}
function mixEnter() {
  const m = S.disc.mix;
  if (!m.ings && !m.loading) loadMixIngs();
  loadStudioHome();
  const cur = S.studio.cur;
  if (cur?.id && !S.studio.job) stOpen(cur.id, { quiet: true });
}
async function loadMixIngs(wait) {
  const m = S.disc.mix;
  if (m.loading) return;
  m.loading = true;
  try {
    const r = await api("/api/discover/mix-ingredients", wait ? { wait } : {}, 20_000);
    m.ings = r.ingredients; m.engines = r.engines; m.connLoading = r.connLoading;
    // Fresher descriptions for what's already picked.
    const by = new Map(m.ings.map((x) => [x.id, x]));
    mixSetSel(m.sel.map((x) => (by.has(x.id) ? ingLite(by.get(x.id)) : x)));
  } catch (e) { toast(e.message, true); }
  m.loading = false;
  mixPatch("drawer", "bar");
  // The connections scan wasn't done yet: ask once more, waiting longer.
  if (m.connLoading && !wait) setTimeout(() => { if (S.mode === "discover") { m.ings && (m.connLoading = false); loadMixIngs(9000); } }, 800);
}
async function loadStudioHome(wait) {
  const st = S.studio;
  if (st.homeLoading) return;
  st.homeLoading = true;
  let again = false;
  try {
    const r = await api("/api/discover/studio", { seed: st.seed || undefined, wait }, 25_000);
    // The connections scan wasn't done: keep the cached deck on screen and ask once more, waiting longer.
    if (!r.partial || !st.home || st.home.partial) { st.home = r; store("studioHome", r); } else if (st.home) st.home.convos = r.convos;
    again = r.partial && !wait;
  } catch (e) { if (!st.home) toast(e.message, true); }
  st.homeLoading = false;
  stView()?.querySelector(".stdeck.shuf")?.classList.remove("shuf");
  mixPatch("bar", "log");
  if (again) loadStudioHome(12_000);
}
/** Put ingredients in the Studio's tray (added to, or instead of, what's there) and open it; optionally with a message ready to send. */
function mixOpenWith(xs, { add = false, toastText, text } = {}) {
  const m = S.disc.mix;
  const cur = add ? [...m.sel] : [];
  for (const x of xs) if (!cur.some((y) => y.id === x.id)) cur.push(ingLite(x));
  mixSetSel(cur);
  if (!add && S.studio.cur?.messages?.length) { S.studio.cur = null; S.studio.job = null; store("studioConvo", null); }
  if (text != null) stSetDraft(text);
  S.disc.tab = "mix"; store("discTab", "mix");
  if (S.mode !== "discover") setMode("discover"); else { renderDiscover(); $("dbody").scrollTop = 0; }
  mixEnter();
  if (toastText) toast(toastText);
}
const mixFromCard = (x) => x.ids.map((id, i) => { const k = S.disc.mix.ings?.find((y) => y.id === id); return k ? ingLite(k) : { id, kind: mixKindOf(id), name: x.ingredients[i] ?? id, desc: "" }; });
function mixText(x) {
  const plan = [x.customer ? `Customer: ${x.customer}` : "", x.problem ? `Problem: ${x.problem}` : "", x.offer ? `Offer: ${x.offer}` : "", x.price ? `Pricing: ${[x.price, x.model].filter(Boolean).join(" · ")}` : "", x.cost ? `Cost to run: ${x.cost}` : "", x.first_dollar ? `First dollar: ${x.first_dollar}` : "",
    x.mvp?.length ? `MVP:\n${x.mvp.map((s) => `- ${s}`).join("\n")}` : "", x.launch?.length ? `First 10 customers:\n${x.launch.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "", x.week?.length ? `First week:\n${x.week.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "", x.risks?.length ? `Risks:\n${x.risks.map((s) => `- ${s}`).join("\n")}` : ""].filter(Boolean);
  if (plan.length) return [`${x.title}: ${x.pitch}`, "", ...plan, "", `Stack: ${[...x.ingredients, ...(x.extra ?? []).map((e) => `${e} (new)`)].join(" + ")}`, ...(x.how ?? []).map((h) => `- ${h.name}: ${h.role}`)].join("\n");
  return [`${x.title}: ${x.pitch}`, "", `Ingredients: ${[...x.ingredients, ...(x.extra ?? []).map((e) => `${e} (new)`)].join(" + ")}`, ...(x.how ?? []).map((h) => `- ${h.name}: ${h.role}`), x.why_novel ? `Why it’s worth it: ${x.why_novel}` : "", x.money ? `How it earns: ${x.money}` : "", x.first_steps?.length ? `First steps:\n${x.first_steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "", `Size: ${MIX_DIFF[x.difficulty] ?? x.difficulty} · wow ${x.wow}/5`].filter(Boolean).join("\n");
}
/** "Research & plan it": the same research flow as the Idea lab, with the build as the idea (the dialog opens prefilled; nothing starts before you confirm). */
function mixResearch(x) {
  const how = (x.how ?? []).length ? x.how.map((h) => `${h.name} (${h.role})`).join("; ") : x.ingredients.join(", ");
  const text = `${x.title}: ${x.pitch}${x.customer ? ` For: ${x.customer}.` : ""}${x.price ? ` Pricing: ${x.price}.` : ""}${x.mvp?.length ? ` MVP: ${x.mvp.join("; ")}.` : ""} Combine ${how}.${x.extra?.length ? ` New pieces: ${x.extra.join(", ")}.` : ""}${x.why_novel ? ` Why it’s worth it: ${x.why_novel}` : ""}${x.money ? ` How it earns: ${x.money}.` : ""}${x.direction?.trim() ? ` Direction: ${x.direction.trim()}.` : ""}${x.first_steps?.length ? ` First steps I have in mind: ${x.first_steps.join("; ")}.` : ""}`;
  const repos = x.ids.filter((id) => id.startsWith("r:")).map((id) => gemBy(id.slice(2)) ?? { full: id.slice(2), stars: "?" });
  const projects = x.ids.filter((id) => id.startsWith("p:")).map((id) => id.slice(2));
  return discStart("research", { text, slug: x.title, repos, projects }, "Research & plan this");
}
const allMixes = () => [...(S.disc.data?.mixes?.forYou?.mixes ?? []), ...(S.disc.data?.mixes?.saved ?? [])];
const mixSaved = (id) => (S.disc.data?.mixes?.saved ?? []).some((x) => x.id === id);
async function mixSave(x) {
  const op = stSaved(x.id) ? "unsave" : "save";
  try {
    const r = await api("/api/discover/mix-save", { op, mix: x, direction: x.direction });
    if (S.disc.data) S.disc.data.mixes = { ...(S.disc.data.mixes ?? {}), saved: r.mixes };
    S.studio.savedIds.set(x.id, op === "save");
    toast(op === "save" ? `Saved “${x.title}”` : `Removed “${x.title}” from Saved`);
  } catch (e) { toast(e.message, true); }
}
function mixCard(x, i, ctx) {
  const m = S.disc.mix;
  const seenKey = `${ctx}:${x.id}`;
  const fresh = !m.seen.has(seenKey);
  m.seen.add(seenKey);
  const saved = stSaved(x.id);
  const acts = ctx === "fy" ? `<button class="btn primary" data-mplan>Research &amp; plan it</button><button class="btn ghost" data-mopen>Open in Studio</button><button class="btn ghost" data-msave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button>`
    : `${x.customer ? '<button class="btn primary" data-mview>Open plan</button><button class="btn ghost" data-mplan>Research &amp; plan it</button>' : '<button class="btn primary" data-mplan>Research &amp; plan it</button>'}<button class="btn ghost" data-mopen>Open in Studio</button><button class="btn ghost" data-mcopy>Copy</button><button class="btn ghost" data-msave aria-pressed="true">Remove</button>`;
  return `<article class="mixcard${fresh ? "" : " still"}" data-mix="${esc(x.id)}" style="--h:${dHue(x.title)};--i:${Math.min(i, 8)}">
    <h4>${esc(x.title)}</h4>
    <div class="mbadges"><span class="mdiff d-${esc(x.difficulty)}">${esc(MIX_DIFF[x.difficulty] ?? x.difficulty)}</span><span class="mwow" role="img" aria-label="Wow ${x.wow} of 5" title="Wow ${x.wow} of 5">${"★".repeat(x.wow)}<i>${"★".repeat(5 - x.wow)}</i></span>${x.source === "template" ? '<span class="msrc" title="From the quick template combiner, not a model">template</span>' : ""}</div>
    ${x.pitch ? `<p class="mpitch">${esc(x.pitch)}</p>` : ""}
    <div class="mings">${x.ids.map((id, j) => `<span class="ming k-${mixKindOf(id)}">${esc(x.ingredients[j] ?? id)}</span>`).join("")}</div>
    <details class="mmore" data-mdet="${esc(seenKey)}"${m.open.has(seenKey) ? " open" : ""}><summary>How, why &amp; first steps</summary>
      <ul class="mhow">${(x.how ?? []).map((h) => `<li><span class="ming k-${mixKindOf(x.ids[x.ingredients.indexOf(h.name)] ?? "")}">${esc(h.name)}</span> ${esc(h.role)}</li>`).join("")}</ul>
      ${x.why_novel ? `<p class="mwhy"><b>Why it’s new</b> ${esc(x.why_novel)}</p>` : ""}
      ${x.first_steps?.length ? `<ol class="msteps">${x.first_steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    </details>
    <div class="gacts">${acts}</div>
  </article>`;
}
