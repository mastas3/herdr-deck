"use strict";
// Connections, part 2: the store and recipes views, sending connections to an agent, adding your own.
function renderStore(inv, items, labels, q) {
  const order = (inv?.categories ?? []).map((c) => c.id);
  const cat = S.conn.cat;
  if (!inv) return `<div class="cgrid2">${Array.from({ length: 8 }, (_, n) => `<div class="ccard skel" style="--i:${n}"></div>`).join("")}</div><p class="hint">Looking around ${esc(machineLabel(S.conn.machine ?? S.self))}…</p>`;
  if (q) {
    const hits = connView(items, { q, labels }).sort((a, b) => Number(connState(a) === "off") - Number(connState(b) === "off") || order.indexOf(a.cat) - order.indexOf(b.cat));
    const shown = hits.slice(0, S.conn.more ? 600 : 120);
    return `${selBar(hits, "matches")}${hits.length ? `<div class="cgrid2">${shown.map((i, n) => connCard(i, n, inv, true)).join("")}</div>${hits.length > shown.length ? `<button class="link" data-cmore>Show all ${hits.length}</button>` : ""}` : `<p class="hint cempty">Nothing on ${esc(inv.machine)} matches “${esc(q)}”. <button class="link" data-cadd>Add it by hand</button></p>`}`;
  }
  if (cat === "home") {
    const feat = connFeatured(items, order), recent = connRecent(items, Date.now());
    const readyAll = items.filter((i) => connState(i) === "ready" && !i.hidden);
    const tiles = order.map((id) => ({ id, label: labels[id], n: items.filter((i) => connInCat(i, id) && !i.hidden) })).filter((t) => t.n.length || t.id === "yours");
    const recs = items.filter((i) => i.kind === "rec" && !i.hidden).slice(0, 10);
    return `<section class="cfeat"><div class="cfh"><h3>Ready to use</h3><span class="hint">${readyAll.length} ready on ${esc(machineLabel(S.conn.machine ?? S.self))}</span><span class="spacer"></span><button class="btn ghost" data-cseverything>${ICON.check}Select all ${readyAll.length} ready</button></div>
        <div class="cstrip">${feat.map((i) => connMini(i, inv)).join("")}</div></section>
      ${recs.length ? `<section class="cfeat"><div class="cfh"><h3>Recommended for you</h3><span class="hint">services you don't have yet, picked for your projects</span><span class="spacer"></span><button class="link" data-ccat="recommended">See all</button></div><div class="cstrip">${recs.map(recMini).join("")}</div></section>` : ""}
      ${recent.length ? `<section class="cfeat"><div class="cfh"><h3>Recently added</h3><span class="hint">new on ${esc(machineLabel(S.conn.machine ?? S.self))} in the last two weeks</span></div><div class="cstrip">${recent.map((i) => connMini(i, inv)).join("")}</div></section>` : ""}
      <section class="cfeat"><div class="cfh"><h3>Browse</h3></div><div class="ctiles">${tiles.map((t, n) => `<button class="ctile" data-ccat="${esc(t.id)}" style="--i:${Math.min(n, 14)}"><span class="cti">${CICON[t.id] ?? ""}</span><span class="ctl">${esc(t.label)}</span><span class="ctn">${t.n.length}</span><span class="ctg">${t.n.slice(0, 4).map((i) => connBadge(i)).join("")}</span></button>`).join("")}</div></section>`;
  }
  const SR = { ready: 0, "signed-out": 1, installed: 2, account: 2, offline: 3, off: 4 };
  const acctCat = cat === "social" || cat === "sites";
  // Recommendations keep their fit order; "Other sites" sits at the end of Sites & accounts.
  const view = connView(items, { cat, showHidden: S.conn.showHidden, labels }).sort((a, b) => cat === "recommended" ? 0 : Number(a.kind === "sites") - Number(b.kind === "sites") || SR[connState(a)] - SR[connState(b)]);
  const hid = cat === "off" ? 0 : items.filter((i) => connInCat(i, cat) && i.hidden).length;
  const off = cat === "off" || cat === "recommended" ? [] : items.filter((i) => i.cat === cat && connState(i) === "off" && !i.hidden);
  const hint = cat === "off" ? "Common services this machine can’t reach yet" : inv.categories?.find((c) => c.id === cat)?.hint ?? "";
  const elsewhere = cat === "sites" ? connLoginsElsewhere(items) : [];
  return `<div class="cch"><span class="cti big">${CICON[cat] ?? ""}</span><div><h3>${esc(catLabel(inv, cat))}</h3><p class="hint">${esc(hint)}</p></div>${acctCat ? `<span class="spacer"></span><button class="btn ghost" data-cacct>${ICON.plus}Add account</button>` : ""}</div>
    ${elsewhere.length ? `<div class="celse"><span class="hint">Your logins also added to:</span>${elsewhere.slice(0, S.conn.elseAll ? 99 : 10).map((i) => `<button class="chip" data-cjump="${esc(i.id)}" data-cjcat="${esc(i.cat)}">${esc(i.name)}</button>`).join("")}${elsewhere.length > 10 && !S.conn.elseAll ? `<button class="link" data-celseall>+${elsewhere.length - 10} more</button>` : ""}</div>` : ""}
    ${cat === "recommended" ? `<p class="hint crech">Picked from your wiki (projects and interests) and filtered to what ${esc(machineLabel(S.conn.machine ?? S.self))} doesn’t have yet. Free-tier notes are well-known facts; “check pricing” means look before you sign up. The deck never signs up for you.</p>` : selBar(view, "here")}
    ${view.length ? `<div class="cgrid2">${view.map((i, n) => connCard(i, n, inv, false)).join("")}</div>` : `<p class="hint cempty">${cat === "yours" ? "Nothing here yet. “Add your own” for anything the scan can’t see: a staging server, a team API, a login in your password manager…" : acctCat ? "No accounts found on this machine yet. <button class=\"link\" data-cacct>Add one</button> with your handle." : cat === "recommended" ? "You already have everything on the list." : "Nothing here on this machine."}</p>`}
    ${hid ? `<button class="link" data-cshowhid>${S.conn.showHidden ? "Hide" : "Show"} ${hid} hidden</button>` : ""}
    ${off.length ? `<h4 class="csub">Not set up here</h4><div class="cgrid2">${off.map((i, n) => connCard(i, n, inv, false)).join("")}</div>` : ""}`;
}
const RST = { ready: "ok", almost: "warn", missing: "off" };
function recipeCard(r, inv, n) {
  const rd = r.ready, open = S.conn.ropen === r.id;
  const mname = machineLabel(S.conn.machine ?? S.self);
  const st = rd.state === "ready" ? `Ready on ${mname}` : rd.state === "almost" ? "Needs a sign-in" : `Missing ${rd.missing}`;
  const chip = (x, opt) => `<span class="rneed ${x.state}${opt ? " opt" : ""}" title="${esc(x.state === "missing" ? `${x.label}: not found on ${mname}` : `${x.label}: ${x.name ?? ""}${x.state === "partial" ? " (signed out / not running)" : ""}`)}">${x.state === "ready" ? ICON.check : x.state === "partial" ? "!" : "–"} ${esc(x.label)}</span>`;
  return `<article class="rcard r-${rd.state}${open ? " open" : ""}" data-rid="${esc(r.id)}" style="--i:${Math.min(n, 14)}">
    <div class="rtop" data-ropen><span class="cti">${Object.hasOwn(CICON, r.cat) ? CICON[r.cat] : CICON.recipe}</span><span class="rtt"><span class="rname">${esc(r.title)}</span><span class="ccat">${esc(catLabel(inv, r.cat))}${r.custom ? " · yours" : ""}${r.plugin ? ` · from ${esc(r.plugin)}` : ""}${r.machine === "other" ? " · runs on your other machine" : ""}</span></span><span class="cst ${RST[rd.state]}">${esc(st)}</span></div>
    <p class="rpitch" data-ropen>${esc(r.pitch)}</p>
    <div class="rneeds">${rd.needs.map((x) => chip(x)).join("")}${rd.optional.map((x) => chip(x, true)).join("")}</div>
    ${open ? `<div class="rmore"><ol class="rsteps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      <div class="rmeta"><span>${ICON.bot} ${esc(KINDS.find(([k]) => k === (r.agent ?? "claude"))?.[1] ?? r.agent)}</span>${r.folder ? `<span><code>${esc(r.folder)}</code></span>` : ""}</div>
      <details class="rprompt"><summary>The prompt</summary><pre>${esc(r.prompt)}</pre></details></div>` : ""}
    <div class="racts"><button class="btn primary" data-rrun>${ICON.bolt}Run</button><button class="btn ghost" data-rcopy>Copy prompt</button><button class="btn ghost" data-rcustom>${CICON.sliders}Customize</button>${r.custom ? `<button class="btn ghost danger" data-rdel>Delete</button>` : ""}<span class="spacer"></span><button class="link" data-ropen>${open ? "Less" : "Steps"}</button></div>
  </article>`;
}
function renderRecipes(inv, labels, q) {
  const m = S.conn.machine ?? S.self;
  const rec = S.conn.recipes.get(m);
  if (!rec) return `<div class="rgrid">${Array.from({ length: 6 }, (_, n) => `<div class="rcard skel" style="--i:${n}"></div>`).join("")}</div>`;
  let list = rec.recipes;
  if (S.conn.rfor?.size) list = recipesFor(list, S.conn.rfor);
  const cats = [...new Set(rec.recipes.map((r) => r.cat))];
  const rc = S.conn.rcat;
  if (rc === "ready") list = list.filter((r) => r.ready.state === "ready");
  else if (rc === "mine") list = list.filter((r) => r.custom);
  else if (rc !== "all") list = list.filter((r) => r.cat === rc);
  if (q) list = list.filter((r) => connMatch({ name: r.title, detail: r.pitch, via: [...r.ready.needs, ...r.ready.optional].map((x) => x.label), group: r.steps.join(" ") }, q, labels[r.cat]));
  const nReady = rec.recipes.filter((r) => r.ready.state === "ready").length;
  const forNames = S.conn.rfor?.size ? [...S.conn.rfor].map((id) => connItems(inv).find((i) => i.id === id)?.name ?? id) : [];
  return `${forNames.length ? `<div class="rfor">${CICON.recipe}<span>Recipes that use <b>${esc(forNames.slice(0, 4).join(", "))}${forNames.length > 4 ? ` +${forNames.length - 4}` : ""}</b>. Run adds your picks to the prompt.</span><span class="spacer"></span><button class="btn ghost" data-rforclear>Show all recipes</button></div>` : ""}
    <nav class="rchips"><button data-rcat="all" aria-pressed="${rc === "all"}">All <span class="n">${rec.recipes.length}</span></button><button data-rcat="ready" aria-pressed="${rc === "ready"}">Ready now <span class="n">${nReady}</span></button>${rec.recipes.some((r) => r.custom) ? `<button data-rcat="mine" aria-pressed="${rc === "mine"}">Yours</button>` : ""}${cats.map((c) => `<button data-rcat="${esc(c)}" aria-pressed="${rc === c}">${esc(labels[c] ?? c)}</button>`).join("")}</nav>
    ${!rec.reachable ? `<p class="hint">${esc(machineLabel(m))} isn’t reachable, so readiness can’t be checked right now.</p>` : ""}
    ${list.length ? `<div class="rgrid">${list.map((r, n) => recipeCard(r, inv, n)).join("")}</div>` : `<p class="hint cempty">No recipes match.</p>`}
    <p class="hint" style="margin-top:18px">Ready recipes come first. <b>Run</b> opens the New session dialog with the prompt, folder and agent filled in; nothing starts until you press Start there. Your own recipes are saved on the hub in <code>~/.config/herdr-deck/recipes.json</code>.</p>`;
}
function renderConnections() {
  const m = S.conn.machine ?? S.self;
  const inv = S.conn.data.get(m);
  if (!inv && !S.conn.loading) loadConnections();
  if (S.conn.tab === "recipes" && !S.conn.recipes.has(m)) loadRecipes();
  const mach = realMachines();
  const target = rowOf(S.conn.target);
  const q = S.conn.q.trim();
  const items = connItems(inv);
  const labels = Object.fromEntries((inv?.categories ?? []).map((c) => [c.id, c.label]));
  const order = (inv?.categories ?? []).map((c) => c.id);
  const count = (id) => items.filter((i) => connInCat(i, id) && !i.hidden).length;
  const cats = ["home", ...order.filter((id) => count(id) || id === "yours"), ...(count("off") ? ["off"] : [])];
  if (!cats.includes(S.conn.cat) && inv) S.conn.cat = "home";
  const n = S.conn.pick.size;
  const tab = S.conn.tab;
  const nRec = S.conn.recipes.get(m)?.recipes.length;
  modeHTML(`<header class="vh cvh"><h2>${ICON.plug}Connections</h2>
      <p>${target ? `Pick what <b>${esc(target.title)}</b> should know about, then add it to its context.` : "What each machine can reach, how agents should use it, and recipes that put it all to work."}</p>
      <div class="ctoolbar"><span class="seg ctabs" role="tablist"><button role="tab" data-ctab="store" aria-pressed="${tab === "store"}">Store${inv ? ` <span class="n">${items.filter((i) => connState(i) !== "off").length}</span>` : ""}</button><button role="tab" data-ctab="recipes" aria-pressed="${tab === "recipes"}">Recipes${nRec ? ` <span class="n">${nRec}</span>` : ""}</button></span>
        ${mach.length > 1 ? `<span class="seg">${mach.map((x) => `<button data-cmach="${esc(x.id)}" aria-pressed="${x.id === m}" ${x.online ? "" : "disabled"}>${esc(x.label)}</button>`).join("")}</span>` : ""}
        <input class="inp csearch" data-csearch type="search" placeholder="${tab === "recipes" ? "Search recipes" : `Search ${esc(machineLabel(m))}`}" value="${esc(S.conn.q)}" autocomplete="off" aria-label="Search">
        <span class="spacer"></span><button class="btn ghost" data-cadd>${ICON.plus}Add your own</button><button class="btn ghost" data-crefresh title="Scan again">${S.conn.loading ? '<span class="spin"></span>' : "Rescan"}</button></div>
    </header>
    <div class="cstore${tab === "recipes" ? " rtab" : ""}">
      ${tab === "store" ? `<nav class="crail" aria-label="Categories">${cats.map((id) => `<button data-ccat="${esc(id)}" aria-pressed="${!q && id === S.conn.cat}">${CICON[id] ?? ""}<span class="crl">${esc(catLabel(inv, id))}</span>${id === "home" ? "" : `<span class="n">${count(id)}</span>`}</button>`).join("")}</nav>` : ""}
      <div class="cmain">${tab === "store" ? renderStore(inv, items, labels, q) : renderRecipes(inv, labels, q)}</div>
    </div>
    ${inv?.file && tab === "store" ? `<p class="hint cfile">Agents on ${esc(inv.machine)} can also read the whole list at <code>${esc(inv.file.replace(/^\/(Users|home)\/[^/]+/, "~"))}</code>, or ask the deck’s MCP server.</p>` : ""}
    <div class="cbar${n ? " on" : ""}"><b>${n}</b>&nbsp;selected<button class="btn ghost" data-cclear>Clear</button><span class="spacer"></span><button class="btn ghost" data-ccopy2>Copy</button><button class="btn ghost" data-cmix title="Open them in Discover’s mixer">Mix these</button><button class="btn" data-cuse>${CICON.recipe}Use in a recipe</button>${target ? `<button class="btn primary" data-csend>Add to “${esc(target.title.slice(0, 28))}${target.title.length > 28 ? "…" : ""}”</button>` : `<button class="btn primary" data-csendpick>Add to a session…</button>`}</div>`);
}
async function connText(ids) {
  const m = S.conn.machine ?? S.self;
  const { text } = await api("/api/connections-text", { machine: m, ids });
  return `Context from herdr deck: connections you can use for this work on ${machineLabel(m)}. Use them when they help.\n\n${text}`;
}
async function sendConnections(ids, key) {
  const r = rowOf(key);
  if (!r) return toast("Pick a session first", true);
  try {
    const text = await connText(ids);
    const busy = r.status === "working";
    if (text.length > LONG_SEND) { const withFile = await fileLongText(r, "Here are the connections you can use.", [{ text, name: "connections.md" }]); await api(busy ? "/api/queue" : "/api/send", busy ? { op: "add", key, text: withFile } : { key, text: withFile }); }
    else await api(busy ? "/api/queue" : "/api/send", busy ? { op: "add", key, text } : { key, text });
    toast(`${busy ? "Queued" : "Added"} ${ids.length} connection${ids.length === 1 ? "" : "s"} for “${r.title}”`);
    S.conn.pick.clear();
    setMode(null);
    select(key, { open: true });
  } catch (e) { toast(e.message, true); }
}
function pickSessionFor(anchor, run) {
  const rows = [...S.rows.values()].filter((r) => isAgent(r) && !r.app && inScope(r)).sort((a, b) => act(b) - act(a)).slice(0, 14);
  openMenu(anchor, rows.map((r) => ({ html: `<span class="dot" style="--c:${statusVar(r.status)}"></span> ${esc(r.title)}<small>${esc(r.project)}</small>`, run: () => run(r.key) })), "Add to which session?");
}
function connItem(id) { return connItems(S.conn.data.get(S.conn.machine ?? S.self)).find((x) => x.id === id); }
async function connConf(body) {
  try { const inv = await api("/api/connections-conf", { machine: S.conn.machine ?? S.self, ...body }); S.conn.data.set(S.conn.machine ?? S.self, inv); renderConnections(); }
  catch (e) { toast(e.message, true); }
}
function recipeOf(id) { return S.conn.recipes.get(S.conn.machine ?? S.self)?.recipes.find((r) => r.id === id); }
async function recipePrompt(id) { return api("/api/recipes", { op: "prompt", id, machine: S.conn.machine ?? S.self, picked: S.conn.rfor ? [...S.conn.rfor] : [] }); }
/** Run = the New session dialog, prefilled. Nothing starts until the user presses Start there. */
async function runRecipe(id) {
  const r = recipeOf(id);
  if (!r) return;
  let p;
  try { p = await recipePrompt(id); } catch (e) { return toast(e.message, true); }
  let m = S.conn.machine ?? S.self;
  if (p.machine === "other") m = realMachines().find((x) => x.id !== S.self && x.online)?.id ?? m;
  const tgt = rowOf(S.conn.target);
  const cwd = p.folder || (tgt && tgt.machine === m ? tgt.projectRoot ?? tgt.cwd : "") || "";
  await openNew(cwd ? { machine: m, cwd, project: r.title } : undefined);
  if (newMachine !== m && realMachines().some((x) => x.id === m && x.online)) {
    newMachine = m;
    for (const b of $("nMachine").children) b.setAttribute("aria-pressed", b.dataset.m === m);
    await loadNewOptions();
  }
  if (KINDS.some(([k]) => k === p.agent) && newKind !== p.agent) { newKind = p.agent; renderKinds(); }
  $("newDlg").querySelector("h3").textContent = `Run recipe: ${r.title}`;
  $("nPrompt").value = p.prompt;
  $("nLabel").value = r.title.slice(0, 40);
  renderCmd();
}
async function customizeRecipe(id) {
  const r = recipeOf(id);
  if (!r) return;
  const inv = S.conn.data.get(S.conn.machine ?? S.self);
  const picked = [...S.conn.pick].map((x) => connItems(inv).find((i) => i.id === x)).filter(Boolean);
  const d = document.createElement("dialog");
  d.className = "ask rdlg";
  const cats = (inv?.categories ?? []).filter((c) => !["keys", "skills", "yours"].includes(c.id));
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${r.custom ? "Edit your recipe" : `Customize “${esc(r.title)}”`}</h3><p class="hint">${r.custom ? "" : "Saved as your own copy; the built-in stays as it is. "}Stored on the hub in ~/.config/herdr-deck/recipes.json.</p>
    <label class="lab">Title</label><input class="inp" name="title" required maxlength="80" value="${esc(r.custom ? r.title : `${r.title} (mine)`)}">
    <label class="lab">One-line pitch</label><input class="inp" name="pitch" maxlength="240" value="${esc(r.pitch)}">
    <div class="rrow"><div><label class="lab">Category</label><select class="inp" name="cat">${cats.map((c) => `<option value="${esc(c.id)}"${c.id === r.cat ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></div>
      <div><label class="lab">Agent</label><select class="inp" name="agent">${KINDS.filter(([k]) => k !== "shell").map(([k, l]) => `<option value="${k}"${k === (r.agent ?? "claude") ? " selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label class="lab">Runs on</label><select class="inp" name="machine"><option value="hub">The machine you pick</option><option value="other"${r.machine === "other" ? " selected" : ""}>Your other machine</option></select></div></div>
    <label class="lab">Folder <span class="hint">(optional, e.g. ~/wiki)</span></label><input class="inp" name="folder" value="${esc(r.folder ?? "")}">
    <label class="lab">Steps <span class="hint">(one per line)</span></label><textarea class="inp" name="steps" rows="4">${esc(r.steps.join("\n"))}</textarea>
    <label class="lab">Prompt <span class="hint">({connections}, {machine}, {date} are filled in)</span></label><textarea class="inp rpt" name="prompt" rows="9" required>${esc(r.prompt)}</textarea>
    ${picked.length ? `<label class="chk-l"><input type="checkbox" name="addpicked"> Also require my ${picked.length} selected connection${picked.length === 1 ? "" : "s"} (${esc(picked.slice(0, 3).map((i) => i.name).join(", "))}${picked.length > 3 ? "…" : ""})</label>` : ""}</div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save recipe</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    if (d.returnValue === "ok") {
      const f = Object.fromEntries(new FormData(d.querySelector("form")));
      const needs = [...r.needs, ...(f.addpicked ? picked.map((i) => ({ label: i.name, any: [i.id] })) : [])];
      try {
        await api("/api/recipes", { op: "save", machine: S.conn.machine ?? S.self, recipe: { ...f, id: r.custom ? r.id : undefined, from: r.custom ? r.from : r.id, needs, optional: r.optional ?? [] } });
        S.conn.rcat = "mine"; await loadRecipes(true); toast("Saved your recipe");
      } catch (e) { toast(e.message, true); }
    }
    d.remove();
  });
  d.showModal();
}
function connRerender(fn) { fn(); renderConnections(); }
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "connections") return;
  const t = e.target;
  const tab = t.closest("[data-ctab]")?.dataset.ctab;
  if (tab) { S.conn.tab = tab; store("connTab", tab); if (tab === "recipes") loadRecipes(); $("dbody").scrollTop = 0; return renderConnections(); }
  const cm = t.closest("[data-cmach]")?.dataset.cmach;
  if (cm) { S.conn.machine = cm; S.conn.pick.clear(); S.conn.rfor = null; renderConnections(); loadConnections(); if (S.conn.tab === "recipes") loadRecipes(); return; }
  const cat = t.closest("[data-ccat]")?.dataset.ccat;
  if (cat) { S.conn.cat = cat; store("connCat2", cat); S.conn.open = null; S.conn.q = ""; S.conn.more = false; $("dbody").scrollTop = 0; return renderConnections(); }
  const jump = t.closest("[data-cjump]");
  if (jump) { S.conn.cat = jump.dataset.cjcat; store("connCat2", S.conn.cat); S.conn.open = jump.dataset.cjump; renderConnections(); $("dbody").querySelector(`[data-cid="${CSS.escape(jump.dataset.cjump)}"]`)?.scrollIntoView({ block: "center", behavior: reduceMotion.matches ? "auto" : "smooth" }); return; }
  const rcat = t.closest("[data-rcat]")?.dataset.rcat;
  if (rcat) return connRerender(() => { S.conn.rcat = rcat; S.conn.ropen = null; });
  const go = t.closest("[data-cgorecipe]")?.dataset.cgorecipe;
  if (go) return connRerender(() => { S.conn.tab = "recipes"; S.conn.rcat = "all"; S.conn.q = ""; S.conn.rfor = null; S.conn.ropen = go; });
  if (t.closest("[data-rforclear]")) return connRerender(() => { S.conn.rfor = null; });
  if (t.closest("[data-crefresh]")) return loadConnections(true);
  if (t.closest("[data-cshowhid]")) return connRerender(() => { S.conn.showHidden = !S.conn.showHidden; });
  if (t.closest("[data-cmore]")) return connRerender(() => { S.conn.more = true; });
  const inv = S.conn.data.get(S.conn.machine ?? S.self);
  const labels = Object.fromEntries((inv?.categories ?? []).map((c) => [c.id, c.label]));
  const inView = () => connView(connItems(inv), { cat: S.conn.cat, q: S.conn.q.trim(), showHidden: S.conn.showHidden, labels });
  if (t.closest("[data-csall]")) return connRerender(() => { S.conn.pick = connSelectAll(S.conn.pick, inView()); });
  if (t.closest("[data-csnone]")) return connRerender(() => { S.conn.pick = connSelectNone(S.conn.pick, inView()); });
  if (t.closest("[data-cseverything]")) return connRerender(() => { S.conn.pick = connSelectAll(S.conn.pick, connItems(inv).filter((i) => connState(i) === "ready" && !i.hidden)); });
  if (t.closest("[data-cclear]")) return connRerender(() => { S.conn.pick = connSelectNone(S.conn.pick); });
  if (t.closest("[data-ccopy2]")) return copy(await connText([...S.conn.pick]), "connections");
  if (t.closest("[data-cuse]")) { S.conn.rfor = new Set(S.conn.pick); S.conn.tab = "recipes"; S.conn.rcat = "all"; S.conn.q = ""; $("dbody").scrollTop = 0; loadRecipes(); return renderConnections(); }
  if (t.closest("[data-csend]")) return sendConnections([...S.conn.pick], S.conn.target);
  if (t.closest("[data-csendpick]")) return pickSessionFor(t.closest("[data-csendpick]"), (k) => sendConnections([...S.conn.pick], k));
  if (t.closest("[data-celseall]")) return connRerender(() => { S.conn.elseAll = true; });
  if (t.closest("[data-csitesopen]")) { S.conn.sitesOpen = !t.closest("details")?.open; return; }
  const acct = t.closest("[data-cacct]");
  if (acct) return addAccount(acct.dataset.cacct || "");
  const unacct = t.closest("[data-cunacct]")?.dataset.cunacct;
  if (unacct) { if (await askDialog({ title: "Forget this handle?", text: "Removes the handle, link and notes you added. The card stays if a saved login or an app shows you have the account.", ok: "Forget", danger: true })) connConf({ op: "unaccount", id: unacct }); return; }
  if (t.closest("[data-cadd]")) return addConnection();
  if (t.closest("[data-csuggest]")) return suggestProjects();
  const rc = t.closest("[data-rid]");
  if (rc) {
    const id = rc.dataset.rid;
    if (t.closest("[data-rrun]")) return runRecipe(id);
    if (t.closest("[data-rcopy]")) { try { copy((await recipePrompt(id)).prompt, "the recipe prompt"); } catch (err) { toast(err.message, true); } return; }
    if (t.closest("[data-rcustom]")) return customizeRecipe(id);
    if (t.closest("[data-rdel]")) { if (await askDialog({ title: `Delete “${recipeOf(id)?.title}”?`, ok: "Delete", danger: true })) { try { await api("/api/recipes", { op: "delete", id }); await loadRecipes(true); } catch (err) { toast(err.message, true); } } return; }
    if (t.closest("[data-ropen]") && !t.closest("details")) return connRerender(() => { S.conn.ropen = S.conn.ropen === id ? null : id; });
    return;
  }
  const card = t.closest("[data-cid]");
  if (!card) return;
  const id = card.dataset.cid;
  if (t.closest("[data-cpick]")) return connRerender(() => { S.conn.pick.has(id) ? S.conn.pick.delete(id) : S.conn.pick.add(id); });
  if (t.closest("[data-chide]")) return connConf({ op: connItem(id)?.hidden ? "unhide" : "hide", id });
  if (t.closest("[data-cremove]")) { if (await askDialog({ title: `Remove “${connItem(id)?.name}”?`, ok: "Remove", danger: true })) connConf({ op: "remove", id }); return; }
  if (t.closest("[data-cone]")) return S.conn.target ? sendConnections([id], S.conn.target) : pickSessionFor(t.closest("[data-cone]"), (k) => sendConnections([id], k));
  if (t.closest("[data-copen]")) { S.conn.open = S.conn.open === id ? null : id; if (S.conn.open) loadRecipes(); renderConnections(); $("dbody").querySelector(`[data-cid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" }); }
});
$("dbody").addEventListener("input", (e) => {
  if (S.mode !== "connections" || !e.target.matches("[data-csearch]")) return;
  S.conn.q = e.target.value;
  S.conn.more = false;
  clearTimeout(renderConnections.t);
  renderConnections.t = setTimeout(() => { const pos = e.target.selectionStart; renderConnections(); const el = $("dbody").querySelector("[data-csearch]"); el?.focus(); el?.setSelectionRange(pos, pos); }, 80);
});
$("dbody").addEventListener("focusout", (e) => {
  if (S.mode !== "connections" || !e.target.matches("[data-cnote]")) return;
  const id = e.target.closest("[data-cid]")?.dataset.cid;
  const it = connItem(id);
  if (it && e.target.value.trim() !== (it.use ?? "").trim()) connConf({ op: "note", id, text: e.target.value });
});
async function addConnection() {
  const d = document.createElement("dialog");
  d.className = "ask";
  const inv = S.conn.data.get(S.conn.machine ?? S.self);
  const cats = (inv?.categories ?? []).filter((c) => !["skills", "keys", "mcp"].includes(c.id));
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Add a connection</h3><p class="hint">Something agents on ${esc(machineLabel(S.conn.machine ?? S.self))} can use that the scan can’t see.</p>
    <label class="lab">Name</label><input class="inp" name="name" placeholder="Staging server" required>
    <label class="lab">What it’s for</label><input class="inp" name="detail" placeholder="Pre-production copy of the funnel">
    <label class="lab">Category</label><select class="inp" name="cat">${cats.map((c) => `<option value="${esc(c.id)}"${c.id === "yours" ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
    <label class="lab">How agents should use it</label><textarea class="inp" name="use" rows="3" placeholder="ssh staging, app in /srv/app, restart with pm2 restart app"></textarea>
    <label class="lab">Reached via <span class="hint">(comma separated, optional)</span></label><input class="inp" name="via" placeholder="ssh staging, key STAGING_TOKEN">
    <p class="hint" style="margin-top:12px">A social network or a site you have an account on? <button type="button" class="link" data-dacct>Add an account</button> instead, with your handle.</p></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Add</button></div></form>`;
  d.querySelector("[data-dacct]").addEventListener("click", () => { d.close("cancel"); addAccount(""); });
  document.body.append(d);
  d.addEventListener("close", () => {
    if (d.returnValue === "ok") { const f = Object.fromEntries(new FormData(d.querySelector("form"))); S.conn.cat = f.cat || "yours"; S.conn.q = ""; connConf({ op: "add", item: f }); }
    d.remove();
  });
  d.showModal();
}
/** Add (or edit) one of your accounts: a catalog service, your public handle or profile link, and how agents may use it. */
function addAccount(siteId) {
  const m = S.conn.machine ?? S.self;
  const inv = S.conn.data.get(m);
  const labels = Object.fromEntries((inv?.categories ?? []).map((c) => [c.id, c.label]));
  const groups = connCatalogGroups(inv?.accountCatalog, labels);
  const cur = connItems(inv).find((i) => i.site === siteId);
  const own = cur?.own ?? {};
  const d = document.createElement("dialog");
  d.className = "ask";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${cur?.own ? `Edit ${esc(cur.name)}` : "Add an account"}</h3><p class="hint">Your own public handle, so agents know which account is yours. Saved on ${esc(machineLabel(m))} in <code>~/.config/herdr-deck/connections.json</code> and listed in CONNECTIONS.md. Never a password.</p>
    <label class="lab">Service</label><select class="inp" name="id" required><option value="">Choose…</option>${groups.map((g) => `<optgroup label="${esc(g.label)}">${g.items.map((c) => `<option value="${esc(c.id)}"${c.id === siteId ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`).join("")}</select>
    <label class="lab">Handle <span class="hint">(optional)</span></label><input class="inp" name="handle" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="@yourname" value="${esc(own.handle ?? "")}">
    <label class="lab">Profile link <span class="hint">(optional)</span></label><input class="inp" name="url" type="url" maxlength="300" placeholder="https://…" value="${esc(own.url ?? "")}">
    <label class="lab">How agents may use it</label><textarea class="inp" name="notes" rows="3" maxlength="1000" placeholder="Draft posts for my approval; never DM, follow or buy anything.">${esc(own.notes ?? "")}</textarea></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save account</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    if (d.returnValue === "ok") {
      const f = Object.fromEntries(new FormData(d.querySelector("form")));
      try {
        const next = await api("/api/connections-conf", { machine: m, op: "account", account: f });
        S.conn.data.set(m, next);
        const card = connItems(next).find((i) => i.site === f.id);
        if (card) { S.conn.cat = card.cat; store("connCat2", card.cat); S.conn.open = card.id; S.conn.q = ""; }
        renderConnections();
        if (card) $("dbody").querySelector(`[data-cid="${CSS.escape(card.id)}"]`)?.scrollIntoView({ block: "center", behavior: reduceMotion.matches ? "auto" : "smooth" });
        toast(`Saved ${card?.name ?? "the account"}`);
      } catch (e) { toast(e.message, true); }
    }
    d.remove();
  });
  d.showModal();
}
async function suggestProjects() {
  if (!(await askDialog({ title: "Suggest mega projects?", text: "Starts a new Claude session (in ~/wiki if you have one, otherwise your home folder) with the list of everything your machines can reach (names only, no keys), and asks it to propose ambitious projects. It won’t build anything until you pick.", ok: "Start" }))) return;
  try { const r = await api("/api/suggest-projects", {}); toast("Starting a Claude session with your connections…"); if (r.key) pendingSelect = r.key; } catch (e) { toast(e.message, true); }
}
// The Connections view in the deck's registry (public/js/registry.js).
deckPlugins.register("connections", {
  views: { connections: { load: () => loadConnections(), render: () => renderConnections() } },
  palette: (q, cur) => [
    { t: "Connections: what agents can use", slot: "views", order: 30, run: () => openConnections(cur?.key) },
    { t: "Connections: everything this setup can reach", order: 10, run: () => setMode("connections") },
    { t: "Suggest mega projects from my connections", order: 11, run: suggestProjects },
  ],
  settings: [{ html: "Connections<small>Everything this setup can reach</small>", run: () => openConnections() }],
  events: { audit: (a) => { S.audit = a; if (S.mode === "connections") renderConnections(); } },
}).extend("tools.menu", { icon: ICON.plug, label: "Connections", hint: "Tell this agent what it can use: deploy targets, APIs, MCP servers…", run: (sel) => openConnections(sel) });
