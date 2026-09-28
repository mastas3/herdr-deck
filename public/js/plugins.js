// ══ Plugins ══════════════════════════════════════════════════════════════════
// Integrations and business packs anyone can share. They're data only: the server validates them, and the trust
// screen shows exactly what one may do, built from its grants rather than its description, before it's installed.
// Server side: src/plugins.ts. Code plugins (the "Built in" tab and adding one from a folder or git) are in
// plugins-code.js, server side src/plugin-host.ts and src/plugin-code-api.ts.
ICON.puzzle = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.8 5.6h2.4a1.7 1.7 0 1 1 3.2 0h2.4V8a1.7 1.7 0 1 1 0 3.2v2.4H8.4a1.7 1.7 0 1 0-3.2 0H2.8v-2.4a1.7 1.7 0 1 0 0-3.2z"/></svg>';
S.plug = { data: null, code: null, loading: false, tab: load("plugTab", "installed"), review: null, creview: null, busy: false, tick: false };
const PTABS = [["installed", "Installed"], ["catalog", "Catalog"], ["code", "Built in"], ["add", "Add"]];
const PSTATE = { on: ["On", "pon"], off: ["Off", "poff"], changed: ["Files changed", "pwarn"] };

async function loadPlugins() {
  if (S.plug.loading) return;
  S.plug.loading = true;
  try { [S.plug.data, S.plug.code] = await Promise.all([api("/api/plugins", {}), api("/api/plugins/code", {})]); } catch (e) { toast(e.message, true); }
  S.plug.loading = false;
  if (S.mode === "plugins") renderPlugins();
}
function plugTab(t) { S.plug.tab = t; S.plug.review = null; S.plug.creview = null; store("plugTab", t); renderPlugins(); $("dbody").scrollTop = 0; }
/** The plugin's badge. The colour comes from a stranger, so it's checked again here before it goes into a style. */
function plugIcon(name, icon) {
  const color = /^#[0-9a-f]{6}$/i.test(icon?.color ?? "") ? icon.color : "var(--accent)";
  return `<span class="cbadge pbadge" style="background:${color}">${esc(icon?.glyph || initials(name))}</span>`;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function renderPlugins() {
  const d = S.plug.data;
  const count = (id) => (id === "installed" ? d?.plugins?.length : id === "code" ? S.plug.code?.plugins?.length : 0);
  const tabs = PTABS.map(([id, label]) => `<button data-ptab="${id}" aria-pressed="${S.plug.tab === id && !S.plug.review && !S.plug.creview}">${label}${count(id) ? ` <span class="n">${count(id)}</span>` : ""}</button>`).join("");
  const head = `<header class="vh"><h2>${ICON.puzzle}Plugins</h2><p>Turn parts of the deck on and off, and add integrations and whole working setups. Shared plugins are data only, and you see exactly what one may do before it’s installed.</p><nav class="seg dtabs">${tabs}</nav></header>`;
  let body;
  if (S.plug.review) body = plugReview(S.plug.review);
  else if (S.plug.creview) body = codeReview(S.plug.creview);
  else if (!d) body = `<p class="hint">Loading plugins…</p>`;
  else if (S.plug.tab === "catalog") body = plugCatalog(d);
  else if (S.plug.tab === "code") body = codeList(S.plug.code);
  else if (S.plug.tab === "add") body = plugAdd() + codeAdd();
  else body = plugInstalled(d);
  modeHTML(head + body);
}

function plugInstalled(d) {
  if (!d.plugins.length) return `<div class="pempty"><p>No plugins yet.</p><button class="btn primary" data-ptab="catalog">Browse the catalog</button></div>`;
  return `<div class="plist">${d.plugins.map((p) => {
    const [label, cls] = PSTATE[p.state] ?? PSTATE.off;
    const t = p.trust;
    const from = p.from?.catalog ? "from the catalog" : p.from?.file ? `from ${p.from.file}` : "";
    return `<article class="pcard" data-pid="${esc(p.id)}">
      <div class="ptop">${plugIcon(p.name, t?.icon)}<div class="pid"><b>${esc(p.name)}</b><small>${esc(p.version)}${from ? ` · ${esc(from)}` : ""}</small></div><span class="pstate ${cls}">${label}</span></div>
      ${p.state === "changed" ? `<p class="derr">${ICON.warn}Its files changed on disk since you approved them, so it’s off until you review it again.</p>` : t ? `<p class="phead">${esc(t.headline)}</p>` : ""}
      ${t?.adds.sources.length ? `<p class="hint">Its views fill in once plugin runs are available in the deck.</p>` : ""}
      <div class="pacts">${p.state === "changed" ? `<button class="btn primary" data-preview>Review again</button>` : `<button class="btn ghost" data-penable="${p.enabled ? "off" : "on"}">${p.enabled ? "Turn off" : "Turn on"}</button><button class="btn ghost" data-preview>Details</button>`}<span class="spacer"></span><button class="btn ghost danger" data-premove>Remove</button></div>
    </article>`;
  }).join("")}</div>`;
}

function plugCatalog(d) {
  if (!d.catalog.length) return `<p class="hint">The catalog is empty.</p>`;
  return `<div class="plist">${d.catalog.map((c) => `<article class="pcard">
      <div class="ptop">${plugIcon(c.name, c.icon)}<div class="pid"><b>${esc(c.name)}</b><small>${c.kind === "business" ? "Business pack" : "Integration"} · ${esc(c.version)}</small></div>${c.installed ? `<span class="pstate pon">Installed</span>` : ""}</div>
      ${c.description ? `<p>${esc(c.description)}</p>` : ""}
      <div class="pacts"><button class="btn ${c.installed ? "ghost" : "primary"}" data-pcat="${esc(c.id)}">${c.installed ? (c.installed === c.version ? "Review" : `Update to ${esc(c.version)}`) : "Review & install"}</button></div>
    </article>`).join("")}</div>`;
}

function plugAdd() {
  return `<div class="padd">
    <label class="pdrop${S.plug.busy ? " busy" : ""}" data-pdrop>
      <input type="file" accept=".json,.zip,application/json,application/zip" data-pfile hidden>
      <b>${S.plug.busy ? "Checking it…" : "Drop a plugin.json or a .zip here"}</b>
      <span>or tap to choose a file. Nothing is installed until you’ve reviewed it.</span>
    </label>
    <p class="hint">A .zip can be a plugin’s folder or a GitHub “Download ZIP” of a repo with plugin.json at its top.</p>
  </div>`;
}
async function plugUpload(file) {
  if (!file || S.plug.busy) return;
  if (file.size > 5 * 1024 * 1024) return toast("That file is over 5 MB. A plugin is a plugin.json and a few prompt files.", true);
  S.plug.busy = true; renderPlugins();
  try {
    const res = await fetch(`/api/plugins/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "x-deck-token": S.token }, body: file });
    if (res.status === 403) { reconnectSoon(200); throw new Error("Reconnecting to the deck…"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    S.plug.busy = false;
    return plugShow(data);
  } catch (e) { toast(e.message, true); }
  S.plug.busy = false; renderPlugins();
}

/** The trust screen: what the plugin may do, from its grants, repos, roles and schedules. */
function plugReview(r) {
  if (!r.ok) return `<section class="ptrust"><button class="link" data-pback>← Back</button><h3>This plugin can’t be installed</h3>
    <p>The deck checked it and found ${plural(r.problems.length, "problem")}:</p>
    <ul class="pprob">${r.problems.map((x) => `<li>${x.path ? `<code>${esc(x.path)}</code> ` : ""}${esc(x.message)}</li>`).join("")}</ul></section>`;
  const t = r.trust;
  const installed = S.plug.data?.plugins?.find((p) => p.id === t.id);
  const sameAsInstalled = installed && installed.state !== "changed" && installed.hash === r.hash; // identical bytes: nothing to approve
  const sec = (title, items) => (items.length ? `<h4>${title}</h4><ul>${items.join("")}</ul>` : "");
  const grants = t.grants.length
    ? `<ul class="pgrants">${t.grants.map((g) => `<li class="${g.writes ? "pw" : ""}"><b>${esc(g.sentence)}</b>${g.bash ? '<span class="ptag">runs commands on this machine</span>' : g.machine ? '<span class="ptag">uses files on this machine</span>' : ""}${g.web ? '<span class="ptag">reaches the web</span>' : ""}${g.writes ? '<span class="ptag pw">can change things</span>' : ""}<details><summary>Exact tools</summary><code>${g.tools.map(esc).join("<br>")}</code></details></li>`).join("")}</ul>`
    : `<p class="hint">It asks for no tools.</p>`;
  const diff = r.update ? `<div class="pdiff"><b>Update from ${esc(r.update.fromVersion)} to ${esc(t.version)}</b>${r.update.diff.changes.length ? `<ul>${r.update.diff.changes.map((c) => `<li class="${c.approve ? "pw" : ""}">${esc(c.text)}${c.approve ? "" : ' <span class="hint">(no approval needed)</span>'}</li>`).join("")}</ul>` : `<p class="hint">Nothing that needs your approval changed.</p>`}</div>` : "";
  const blocked = r.missing?.length ? `<p class="derr">${ICON.warn}Install ${r.missing.map(esc).join(", ")} first.</p>` : "";
  const can = !r.missing?.length && (!t.needsTick || S.plug.tick) && !S.plug.busy && !sameAsInstalled;
  return `<section class="ptrust">
    <button class="link" data-pback>← Back</button>
    <div class="ptop">${plugIcon(t.name, t.icon)}<div class="pid"><h3>${esc(t.name)} <small>${esc(t.version)}</small></h3><small>${t.kind === "business" ? "Business pack" : "Integration"}${t.author ? ` · by ${esc(t.author)}` : ""}${r.from?.catalog ? " · from the catalog" : r.from?.file ? ` · from ${esc(r.from.file)}` : ""}</small></div></div>
    ${t.description ? `<p class="pauthor"><span>The author says:</span> ${esc(t.description)}</p>` : ""}
    <p class="phead">${esc(t.headline)}</p>
    ${diff}
    <h4>What its agents may do</h4>${grants}
    ${sec("Repos it will clone", t.repos.map((x) => `<li>${esc(x.project)}: <code>${esc(x.url)}</code> at <code>${esc(x.ref.slice(0, 12))}</code></li>`))}
    ${sec("Agents it can start (only when you press Start)", t.roles.map((x) => `<li><b>${esc(x.title)}</b> · ${esc(x.agent)}${x.model ? ` ${esc(x.model)}` : ""} · in ${esc(x.project)}${x.machine === "other" ? " · on your other machine" : ""}</li>`))}
    ${sec("Schedules", t.schedules.map((x) => `<li>${esc(x.role)} gets a prompt ${esc(x.when)}</li>`))}
    ${sec("Plugins it needs", t.requires.plugins.map((x) => `<li>${esc(x)}</li>`))}
    ${sec("Connections it needs", t.requires.connections.map((x) => `<li>${esc(x)}</li>`))}
    ${sec("What it adds", [...t.adds.sources.map((x) => `<li>Data source: ${esc(x)}</li>`), ...t.adds.views.map((x) => `<li>View: ${esc(x)}</li>`), ...t.adds.actions.map((x) => `<li>Action: ${esc(x)}</li>`), ...t.adds.recipes.map((x) => `<li>Recipe: ${esc(x)}</li>`), ...t.adds.projects.map((x) => `<li>Project: ${esc(x)}</li>`)])}
    ${t.prompts.length ? `<details class="pprompts"><summary>Read every prompt (${t.prompts.length})</summary>${t.prompts.map((x) => `<h5>${esc(x.where)}</h5><pre>${esc(x.text)}</pre>`).join("")}</details>` : ""}
    ${blocked}
    ${t.needsTick ? `<label class="ptick"><input type="checkbox" data-ptick ${S.plug.tick ? "checked" : ""}> Let it run the commands listed above on this machine</label>` : ""}
    <div class="pacts">${sameAsInstalled ? `<span class="hint">This is what you have installed.</span>` : `<button class="btn primary" data-pinstall ${can ? "" : "disabled"}>${r.update || installed ? "Update" : "Install"}</button>`}<button class="btn ghost" data-pback>${sameAsInstalled ? "Back" : "Cancel"}</button></div>
  </section>`;
}

function plugShow(preview) { S.plug.review = preview; S.plug.tick = false; renderPlugins(); $("dbody").scrollTop = 0; }
async function plugInspect(body) {
  if (S.plug.busy) return;
  S.plug.busy = true;
  try { const pv = await api("/api/plugins/inspect", body); S.plug.busy = false; plugShow(pv); }
  catch (e) { S.plug.busy = false; toast(e.message, true); }
}
async function plugInstall() {
  const r = S.plug.review;
  if (!r?.ok || S.plug.busy) return;
  S.plug.busy = true; renderPlugins();
  try {
    S.plug.data = await api("/api/plugins/install", { staged: r.staged, approve: r.hash, bash: S.plug.tick });
    S.plug.review = null; S.plug.tab = "installed"; store("plugTab", "installed");
    toast(`${r.trust.name} installed`);
  } catch (e) { toast(e.message, true); }
  S.plug.busy = false; renderPlugins();
}
async function plugDo(path, body) {
  try { S.plug.data = await api(path, body); } catch (e) { toast(e.message, true); }
  renderPlugins();
}

$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "plugins") return;
  const t = e.target;
  const tab = t.closest("[data-ptab]")?.dataset.ptab;
  if (tab) return plugTab(tab);
  if (t.closest("[data-pback]")) { S.plug.review = null; return renderPlugins(); }
  const cat = t.closest("[data-pcat]")?.dataset.pcat;
  if (cat) return plugInspect({ catalog: cat });
  if (t.closest("[data-pinstall]")) return plugInstall();
  const id = t.closest("[data-pid]")?.dataset.pid;
  if (!id) return;
  const p = S.plug.data?.plugins?.find((x) => x.id === id);
  if (t.closest("[data-preview]")) return plugInspect({ review: id });
  const en = t.closest("[data-penable]")?.dataset.penable;
  if (en) return plugDo("/api/plugins/enable", { id, on: en === "on" });
  if (t.closest("[data-premove]") && (await askDialog({ title: `Remove ${p?.name ?? id}?`, text: "Its files are deleted from this machine. You can install it again later.", ok: "Remove", danger: true }))) return plugDo("/api/plugins/remove", { id });
});
$("dbody").addEventListener("change", (e) => {
  if (S.mode !== "plugins") return;
  if (e.target.matches("[data-ptick]")) { S.plug.tick = e.target.checked; renderPlugins(); }
  if (e.target.matches("[data-pfile]")) {
    const file = e.target.files?.[0];
    e.target.value = ""; // so picking the same file again (after fixing it) still fires change
    plugUpload(file);
  }
});
$("dbody").addEventListener("dragover", (e) => { if (S.mode === "plugins" && e.target.closest("[data-pdrop]")) { e.preventDefault(); e.target.closest("[data-pdrop]").classList.add("over"); } });
$("dbody").addEventListener("dragleave", (e) => { e.target.closest?.("[data-pdrop]")?.classList.remove("over"); });
$("dbody").addEventListener("drop", (e) => {
  if (S.mode !== "plugins" || !e.target.closest("[data-pdrop]")) return;
  e.preventDefault(); e.stopPropagation();
  plugUpload(e.dataTransfer?.files?.[0]);
});
