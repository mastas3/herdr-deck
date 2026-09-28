"use strict";
// Code plugins in the Plugins view: the parts of the deck that ship with it (Covers, Discover…) with an on/off switch,
// and adding one from a local folder or a git repo pinned to a commit, behind a red trust screen. Server side:
// src/plugin-host.ts (running them) and src/plugin-code-api.ts (/api/plugins/code/*). Turning one on or off reloads
// the page, because its scripts join or leave it.
const CSTATE = { on: ["On", "pon"], off: ["Off", "poff"], failed: ["Failed", "pwarn"], "hub-only": ["Hub only", "poff"], changed: ["Files changed", "pwarn"], invalid: ["Broken", "pwarn"] };

/** What a plugin adds, in words: from its plugin.json, so it reads the same before and after it runs. */
function codeOffers(p) {
  const o = p.offers;
  if (!o) return [];
  return [
    ...o.provides.map((s) => `the ${s} service`),
    ...o.routes.map((r) => (r.startsWith("/") ? `files at ${r}` : `/api/${r}`)),
    ...o.pages.map((x) => `pages at ${x}`),
    ...o.extends.map((x) => `adds to ${x}`),
    ...(o.client.length || o.styles.length ? [`${plural(o.client.length + o.styles.length, "page file")}`] : []),
  ];
}
function codeCard(p) {
  const [label, cls] = CSTATE[p.state] ?? CSTATE.off;
  const from = p.builtin ? "built in" : p.from?.git ? `from ${p.from.git} at ${String(p.from.commit ?? "").slice(0, 10)}` : p.from?.folder ? `from ${p.from.folder}` : "installed";
  const needs = [p.requires.length && `Needs ${p.requires.join(", ")}`, p.uses.length && `works with ${p.uses.join(", ")}`, p.machine === "any" ? "runs on every machine" : "runs on the hub"].filter(Boolean).join(" · ");
  const offers = codeOffers(p);
  const on = p.state !== "off" && p.state !== "invalid";
  const settings = p.state === "on" && p.settings.length ? `<div class="csets">${p.settings.map((s) => `<label>${esc(s.label)} ${s.type === "boolean" ? `<input type="checkbox" data-cset="${esc(s.key)}" ${s.value ? "checked" : ""}>` : `<input data-cset="${esc(s.key)}" data-ctype="${s.type}" value="${esc(String(s.value))}">`}</label>`).join("")}</div>` : "";
  return `<article class="pcard" data-cid="${esc(p.id)}">
    <div class="ptop">${plugIcon(p.name)}<div class="pid"><b>${esc(p.name)}</b><small>${esc(p.version)} · ${esc(from)}</small></div><span class="pstate ${cls}">${label}</span></div>
    ${p.description ? `<p>${esc(p.description)}</p>` : ""}
    ${p.error && p.state !== "off" ? `<p class="derr">${ICON.warn}${esc(p.error)}</p>` : ""}
    ${p.state === "hub-only" ? `<p class="hint">It runs on the hub only, so it’s off on this machine.</p>` : ""}
    ${offers.length ? `<p class="hint">Offers ${esc(offers.join(" · "))}${p.timers ? ` · ${plural(p.timers, "timer")} running` : ""}</p>` : ""}
    <p class="hint">${esc(needs)}</p>${settings}
    <div class="pacts">${p.state === "changed" ? `<button class="btn primary" data-creview>Review again</button>` : p.state === "invalid" ? "" : `<button class="btn ghost" data-cenable="${on ? "off" : "on"}">${on ? "Turn off" : "Turn on"}</button>`}<span class="spacer"></span>${p.builtin ? "" : `<button class="btn ghost danger" data-cremove>Remove</button>`}</div>
  </article>`;
}
function codeList(c) {
  if (!c) return `<p class="hint">Loading…</p>`;
  if (!c.plugins.length) return `<p class="hint">No parts to switch.</p>`;
  return `<p class="hint">Parts of the deck. Turn off what you don’t use: it stops running and leaves the page.</p><div class="plist">${c.plugins.map(codeCard).join("")}</div>`;
}
function codeAdd() {
  return `<section class="padd cadd">
    <h3>Add a code plugin</h3>
    <p class="hint">Code plugins run on this machine with your full permissions. Add one only from a folder you have or a git repo you trust, pinned to a commit.</p>
    <label>Folder <input data-cfolder placeholder="/Users/you/deck-plugins/my-plugin"></label>
    <div class="crow"><label>Git repo <input data-cgit placeholder="https://github.com/someone/deck-plugin.git"></label><label>Commit <input data-ccommit placeholder="40-character commit" maxlength="40"></label></div>
    <div class="pacts"><button class="btn ghost" data-cinspect>${S.plug.busy ? "Checking it…" : "Review it"}</button></div>
  </section>`;
}

/** The red trust screen: every file, and everything its plugin.json asks for, before any of its code runs. */
function codeReview(r) {
  const back = `<button class="link" data-cback>← Back</button>`;
  if (!r.ok) return `<section class="ptrust">${back}<h3>This plugin can’t be installed</h3><ul class="pprob">${r.problems.map((x) => `<li>${x.path ? `<code>${esc(x.path)}</code> ` : ""}${esc(x.message)}</li>`).join("")}</ul></section>`;
  const m = r.manifest;
  const src = r.from.git ? `${esc(r.from.git)} at <code>${esc(r.from.commit)}</code>` : `<code>${esc(r.from.folder ?? "")}</code>`;
  const sec = (title, items) => (items.length ? `<h4>${title}</h4><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>` : "");
  const code = (xs) => xs.map((x) => `<code>${esc(x)}</code>`);
  const can = !r.missing.length && S.plug.tick && !S.plug.busy;
  return `<section class="ptrust ccode">${back}
    <div class="ptop">${plugIcon(m.name)}<div class="pid"><h3>${esc(m.name)} <small>${esc(m.version)}</small></h3><small>from ${src}</small></div></div>
    <p class="cdanger">${ICON.warn}<b>${esc(r.trust)}</b> It can read and change your files, use your logins and reach the network, like any program you run. Install it only if you trust whoever wrote it.</p>
    ${m.description ? `<p class="pauthor"><span>The author says:</span> ${esc(m.description)}</p>` : ""}
    ${r.update ? `<p class="phead">Update from ${esc(r.update.fromVersion)} to ${esc(m.version)}</p>` : ""}
    ${sec("Code that runs", [...(m.server ? [`On this machine: <code>${esc(m.server)}</code>${m.machine === "any" ? " (on every machine)" : " (on the hub)"}`] : []), ...m.client.map((f) => `In the page: <code>${esc(f)}</code>`)])}
    ${sec("What it asks for", [...m.routes.map((x) => (x.startsWith("/") ? `Serves files at <code>${esc(x)}</code>` : `Answers <code>/api/${esc(x)}</code>`)), ...m.pages.map((x) => `Opens the deck at <code>${esc(x)}</code>`), ...m.provides.map((x) => `Offers the <b>${esc(x)}</b> service`), ...m.extends.map((x) => `Adds to <code>${esc(x)}</code>`)])}
    ${sec("Plugins it needs", [...code(m.requires), ...m.uses.map((x) => `<code>${esc(x)}</code> (if it’s on)`)])}
    <details class="pprompts" open><summary>Every file (${r.files.length})</summary><ul>${r.files.map((f) => `<li><code>${esc(f.path)}</code> <span class="hint">${Math.max(1, Math.round(f.bytes / 1024))} KB</span></li>`).join("")}</ul></details>
    ${r.missing.length ? `<p class="derr">${ICON.warn}Install ${r.missing.map(esc).join(", ")} first.</p>` : ""}
    <label class="ptick"><input type="checkbox" data-ctick ${S.plug.tick ? "checked" : ""}> I trust this code to run on this machine with my permissions</label>
    <div class="pacts"><button class="btn primary danger" data-cinstall ${can ? "" : "disabled"}>${r.update ? "Update" : "Install"}</button><button class="btn ghost" data-cback>Cancel</button></div>
  </section>`;
}

/** After a switch: the page reloads when the set of running plugins changed (their files join or leave it). */
async function codeDo(path, body) {
  if (S.plug.busy) return;
  S.plug.busy = true;
  try {
    S.plug.code = await api(path, body);
    const now = S.plug.code.plugins.filter((p) => p.state === "on").map((p) => p.id);
    if (now.join() !== (S.plugins?.active ?? []).join()) { toast("Reloading with the change…"); return setTimeout(() => location.reload(), 300); }
  } catch (e) { toast(e.message, true); }
  S.plug.busy = false; renderPlugins();
}
async function codeInspect(body) {
  if (S.plug.busy) return;
  S.plug.busy = true; renderPlugins();
  try { S.plug.creview = await api("/api/plugins/code/inspect", body, 120_000); S.plug.tick = false; $("dbody").scrollTop = 0; }
  catch (e) { toast(e.message, true); }
  S.plug.busy = false; renderPlugins();
}

$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "plugins") return;
  const t = e.target;
  if (t.closest("[data-cback]")) { S.plug.creview = null; return renderPlugins(); }
  if (t.closest("[data-cinspect]")) {
    const v = (a) => $("dbody").querySelector(`[data-${a}]`)?.value.trim() ?? "";
    return codeInspect(v("cgit") ? { git: v("cgit"), commit: v("ccommit") } : { folder: v("cfolder") });
  }
  if (t.closest("[data-cinstall]")) { const r = S.plug.creview; S.plug.creview = null; return codeDo("/api/plugins/code/install", { staged: r.staged, approve: r.hash }); }
  const id = t.closest("[data-cid]")?.dataset.cid;
  if (!id) return;
  const en = t.closest("[data-cenable]")?.dataset.cenable;
  if (en) return codeDo("/api/plugins/code/enable", { id, on: en === "on" });
  if (t.closest("[data-creview]")) return codeInspect({ review: id });
  if (t.closest("[data-cremove]") && (await askDialog({ title: `Remove ${id}?`, text: "Its files are deleted from this machine.", ok: "Remove", danger: true }))) return codeDo("/api/plugins/code/remove", { id });
});
$("dbody").addEventListener("change", (e) => {
  if (S.mode !== "plugins") return;
  if (e.target.matches("[data-ctick]")) { S.plug.tick = e.target.checked; return renderPlugins(); }
  const k = e.target.dataset?.cset, id = e.target.closest("[data-cid]")?.dataset.cid;
  if (!k || !id) return;
  const value = e.target.type === "checkbox" ? e.target.checked : e.target.dataset.ctype === "number" ? Number(e.target.value) : e.target.value;
  codeDo("/api/plugins/code/setting", { id, key: k, value });
});
