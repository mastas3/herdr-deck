"use strict";
// Writing a plugin: what went wrong and where, on its Plugins card, and plugin dev mode's reloads (src/plugin-dev.ts).
// Loads before any plugin's page files, so an error one throws while loading is caught here too.
/** Errors thrown by a plugin's page files, by plugin id: the first one, and where in its files. */
const plugPageErrs = new Map();
addEventListener("error", (e) => {
  const m = String(e.filename ?? "").match(/\/plugins\/([a-z0-9][a-z0-9-]*)\/([^?#]+)/);
  if (m && !plugPageErrs.has(m[1])) plugPageErrs.set(m[1], { message: e.message, where: `${m[2]}:${e.lineno}:${e.colno}` });
});
const plugWhere = (w) => (w ? ` <code class="pwhere">${esc(w)}</code>` : "");
/** A card's problems: why it can't run, its last server error (starting, a route, a timer) and the page's. */
function codeFaults(p) {
  const out = [];
  const f = p.fault;
  if (p.error && p.state !== "off" && !(f && f.message === p.error)) out.push(`${esc(p.error)}`);
  if (f) out.push(`${f.what === "starting" ? "Starting" : `On the server (${esc(f.what)})`}: ${esc(f.message)}${plugWhere(f.where?.[0])} <span class="hint">${esc(agoText(f.at))}</span>${f.where?.length > 1 ? `<small class="pstack">${f.where.slice(1).map(esc).join(" ← ")}</small>` : ""}`);
  const pe = plugPageErrs.get(p.id);
  if (pe) out.push(`In the page: ${esc(pe.message)}${plugWhere(pe.where)}`);
  for (const x of deckPlugins.problems(p.id)) out.push(`In the page: ${esc(x)}`);
  return out.map((x) => `<p class="derr">${ICON.warn}<span>${x}</span></p>`).join("");
}
/** Dev mode: a plugin's files changed and it was reloaded; reload the page, then say how it went. */
function devReloaded(d) {
  try { sessionStorage.setItem("deck:devReload", JSON.stringify(d)); } catch {}
  location.reload();
}
{
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem("deck:devReload") ?? "null"); sessionStorage.removeItem("deck:devReload"); } catch {}
  if (d) setTimeout(() => {
    if (d.state === "failed" || d.state === "invalid") toast(`${d.id} didn’t start: ${d.error ?? "see Plugins"}${d.where?.[0] ? ` (${d.where[0]})` : ""}`, true, { label: "Show", ms: 12000, run: () => { setMode("plugins"); plugTab("code"); } });
    else toast(`Reloaded ${d.id}${d.server ? "" : " (page files)"}`);
  }, 0);
}
