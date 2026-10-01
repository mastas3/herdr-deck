"use strict";
const aetherState = { target: load("aether-target", null), messages: [], fetched: 0, error: "", pending: false, epoch: 0, timer: null, picker: null };
const aetherIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 14 9 6 9-6-9-5-9 5Zm0 0 9 9 9-9M12 9V2m-4 5 4-5 4 5"/></svg>';
const aetherCurrent = () => { const r = S.rows.get(aetherState.target?.key); return aetherMatches(r, aetherState.target) ? r : null; };
const aetherConnected = () => navigator.onLine && !$("conn").classList.contains("off") && !aetherState.error && !!aetherState.fetched && Date.now() - aetherState.fetched < 16_000 && S.summary.machines?.find((m) => m.id === aetherState.target?.machine)?.online !== false;
function aetherPin(key) {
  const target = aetherIdentity(S.rows.get(key));
  if (!target) return;
  aetherState.epoch++; aetherState.pending = false;
  aetherState.target = target; aetherState.messages = []; aetherState.fetched = 0; aetherState.error = "";
  store("aether-target", target);
  if (S.mode === "aether") { aetherRender(); void aetherRefresh(); }
}
async function aetherRefresh() {
  if (S.mode !== "aether" || document.hidden || aetherState.pending || !navigator.onLine) return;
  const r = aetherCurrent();
  if (!r) return aetherRender();
  const epoch = aetherState.epoch;
  aetherState.pending = true;
  try {
    const data = await api("/api/chat", { key: r.key, limit: 40 }, 8000);
    if (epoch !== aetherState.epoch || !aetherMatches(aetherCurrent(), aetherIdentity(r))) return;
    aetherState.messages = aetherEntries(data.messages); aetherState.fetched = Date.now(); aetherState.error = "";
  } catch (e) {
    if (epoch === aetherState.epoch) aetherState.error = e.message || "Could not read this conversation.";
  } finally {
    if (epoch === aetherState.epoch) { aetherState.pending = false; if (S.mode === "aether") aetherRender(); }
  }
}
function aetherLoad() {
  if (window.__BOOT__?.aetherPreview?.target && !aetherState.target) aetherPin(window.__BOOT__.aetherPreview.target.key);
  clearInterval(aetherState.timer);
  aetherState.timer = setInterval(() => {
    if (S.mode !== "aether") return aetherLeave();
    aetherRender(); void aetherRefresh();
  }, 5000);
  void aetherRefresh();
}
function aetherLeave() {
  clearInterval(aetherState.timer); aetherState.timer = null;
  aetherState.epoch++; aetherState.pending = false;
  aetherState.picker?.close();
}
function aetherRender() {
  if (S.mode !== "aether") return;
  const r = aetherCurrent(), target = aetherState.target;
  const ready = !!r && aetherConnected(), status = aetherStatus(r, ready);
  const preview = window.__BOOT__?.aetherPreview;
  const historyOpen = $("dbody").querySelector(".aether-history")?.open;
  const latest = [...aetherState.messages].reverse().find((m) => m.role === "assistant");
  const title = r?.title || target?.project || "Choose your first companion";
  const connection = !navigator.onLine ? "You’re offline" : aetherState.error ? "Connection interrupted" : ready ? "Live from your deck" : aetherState.fetched ? "Reconnecting…" : r ? "Connecting…" : target ? "Session unavailable" : "Your world awaits";
  modeHTML(`<section class="aether-world" data-aether-status="${status.kind}">
    <header class="aether-heading"><div><p class="aether-eyebrow">AETHER · YOUR LIVING WORKSPACE</p><h2>${esc(target?.project || "A place for your work")}</h2></div><button class="aether-change" data-aether="choose" aria-label="${target ? "Change companion" : "Choose a session"}">${target ? 'Change<span class="aether-wide-label"> companion</span>' : "Choose a session"}</button></header>
    <div class="aether-connection" role="status"><i class="${ready ? "live" : ""}"></i><span>${esc(connection)}</span>${aetherState.fetched ? `<small>Checked ${esc(aetherTime(aetherState.fetched))}</small>` : ""}</div>
    <div class="aether-layout">
      <div class="aether-landscape" aria-label="A floating garden island reflecting your agent’s status">
        <div class="aether-stage">
        <img class="aether-garden" src="/aether-art/world.webp" width="1536" height="1024" alt="" decoding="async">
        <div class="aether-bloom" aria-hidden="true">✧ <span>✦</span> ✧</div>
        <button class="aether-companion" data-aether="journal" aria-label="Aether: ${esc(status.label)}. Read the latest update"><span class="aether-fox" aria-hidden="true"></span><span class="aether-companion-name">Aether</span></button>
        <div class="aether-workshop" aria-hidden="true"><span>${status.kind === "blocked" ? "z z z" : status.kind === "done" ? "✧ ✧ ✧" : ""}</span></div>
        </div>
        <div class="aether-island-caption"><span>ONE ISLAND · ONE COMPANION</span><p>${esc(status.story)}</p></div>
      </div>
      <div class="aether-journal" id="aetherJournal" tabindex="-1">
        <div class="aether-status"><i></i>${target ? esc(status.label) : "Begin here"}</div>
        <h3>${esc(title)}</h3>
        ${target ? `<p class="aether-target">${esc(r?.agent || target.agent)} · ${esc(machineLabel(target.machine))}<br><span>Session ${esc(target.sessionId)}</span></p>` : '<p class="aether-intro">Bring one real agent into this garden. Its work, pauses, and completed turns will give the island life.</p>'}
        ${target ? `<div class="aether-latest"><p class="aether-eyebrow">LATEST AGENT UPDATE${latest?.at ? ` · ${esc(aetherTime(latest.at))}` : ""}</p><p>${esc(latest?.text?.slice(0, 1100) || (aetherState.pending ? "Reading this conversation…" : aetherState.error ? "The conversation could not be refreshed. Your last update stays here." : "No written update yet. Open the conversation for more context."))}${latest?.text?.length > 1100 ? "…" : ""}</p></div>` : ""}
        ${aetherState.error ? `<p class="aether-error" role="alert">${esc(aetherState.error)}</p><button class="aether-change" data-aether="retry">Retry connection</button>` : ""}
        <button class="aether-reply" data-aether="${target ? "reply" : "choose"}" ${target && !ready ? "disabled" : ""}>${target ? preview ? "Open live session to reply ↗" : "Reply in this session →" : "Choose a session →"}</button>
        <p class="aether-note">${target ? "Opens the named conversation. Send, queue, and approval controls stay in the deck." : "Only the companion you choose appears here."}</p>
      </div>
    </div>
    ${target ? `<details class="aether-history" ${historyOpen ? "open" : ""}><summary>Recent conversation <span>${aetherState.messages.length} entries</span></summary><div>${aetherState.messages.map((m) => `<article><header>${m.role === "assistant" ? "Agent" : "You"}<time>${esc(aetherTime(m.at))}</time></header><p>${esc(m.text.slice(0, 2400))}${m.text.length > 2400 ? "…" : ""}</p></article>`).join("") || '<p class="aether-note">No recent messages available.</p>'}</div></details>` : ""}
    <footer class="aether-footer">A small world, connected to real work.${preview ? " · Local preview; replies open the running deck." : ""}</footer>
  </section>`);
}
function aetherChoose() {
  if (aetherState.picker?.open) return;
  const rows = [...S.rows.values()].filter(aetherIdentity).sort((a, b) => (a.project || "").localeCompare(b.project || "") || (a.title || "").localeCompare(b.title || ""));
  const d = document.createElement("dialog"); d.className = "ask aether-picker"; aetherState.picker = d;
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Choose a companion</h3><p class="hint">This island follows one exact session. Choosing it doesn’t send a message.</p><label for="aetherSession">Project and agent session</label><select id="aetherSession" class="inp" required><option value="">Choose a session…</option>${rows.map((r) => `<option value="${esc(r.key)}">${esc(r.project)} · ${esc(r.title || r.agent)} · ${esc(machineLabel(r.machine))} · ${esc(r.sessionId.slice(-8))}</option>`).join("")}</select><p class="aether-choice" aria-live="polite"></p></div><div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Bring to island</button></div></form>`;
  const options = new Map(rows.map((r) => [r.key, aetherIdentity(r)]));
  const sel = d.querySelector("select"); sel.value = aetherCurrent()?.key || "";
  sel.onchange = () => { const r = options.get(sel.value); d.querySelector(".aether-choice").textContent = r ? `Target session: ${r.sessionId}` : ""; }; sel.onchange();
  d.querySelector('button[value="cancel"]').formNoValidate = true;
  d.addEventListener("close", () => {
    if (d.returnValue === "ok" && aetherMatches(S.rows.get(sel.value), options.get(sel.value))) aetherPin(sel.value);
    else if (d.returnValue === "ok") toast("That session changed. Choose it again to check the target.", true);
    d.remove(); if (aetherState.picker === d) aetherState.picker = null;
  });
  d.addEventListener("click", (e) => { if (e.target === d) { const b = d.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) d.close("cancel"); } });
  document.body.append(d); d.showModal();
}
function aetherReply() {
  if (S.mode !== "aether" || !aetherConnected()) return;
  const r = aetherCurrent();
  if (!r) return aetherRender();
  const preview = window.__BOOT__?.aetherPreview;
  if (preview) { location.assign(preview.origin + linkPath(r)); return; }
  // No send, connect, draft transfer or permission decision. The existing named chat owns all of those.
  aetherLeave(); select(r.key, { open: true });
}
$("dbody").addEventListener("click", (e) => {
  const action = e.target.closest("[data-aether]")?.dataset.aether;
  if (!action || S.mode !== "aether") return;
  if (action === "choose") aetherChoose();
  if (action === "reply") aetherReply();
  if (action === "retry") { aetherState.error = ""; reconnectSoon(0); void aetherRefresh(); aetherRender(); }
  if (action === "journal") { $("aetherJournal")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" }); $("aetherJournal")?.focus({ preventScroll: true }); }
});
for (const event of ["online", "offline"]) window.addEventListener(event, () => { if (S.mode === "aether") { aetherRender(); if (navigator.onLine) void aetherRefresh(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.mode === "aether") void aetherRefresh(); });
const aetherRegistration = deckPlugins.register("aether", {
  views: { aether: { load: aetherLoad, render: aetherRender, leave: aetherLeave, path: () => "/?view=aether" } },
  tabs: [{ view: "aether", label: "Aether", icon: aetherIcon, order: 15 }],
  palette: () => [{ t: "Aether: visit your project island", slot: "views", run: () => setMode("aether") }],
});
aetherRegistration.extend("session.menu", (r) => aetherIdentity(r) ? [{ html: "Visit this session’s Aether island", run: () => { aetherPin(r.key); setMode("aether"); } }] : []);
