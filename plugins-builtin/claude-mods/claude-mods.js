"use strict";
// Claude owns mod execution and drawing. The deck adds profile inventory and keys for its native UI.
const cmState = { machines: null, loading: false, error: "", timer: null, generation: 0 };
const cmApi = (body) => api("/api/claude-mods", body, 30_000);
const cmOn = () => S.mode === "plugins" && S.plug.tab === "claude-mods";
const cmLive = (r) => r?.agent === "claude" && !r.app && !r.hist;
const cmOpen = () => { setMode("plugins"); plugTab("claude-mods"); };
function cmSignals(r) {
  return Object.entries(r.signals ?? {}).map(([k, v]) => `<span class="cm-signal${k === "stall" ? " cm-stall" : ""}" title="${esc(({ ctx: "Context usage", cache: "Prompt cache", stall: "Last turn problem", acct_t: "Claude account", acct_m: "Claude account", acct_o: "OpenAI account" })[k] ?? k)}">${esc(v)}</span>`).join("");
}
function cmProfileHTML(p) {
  return `<section class="cm-profile"><h4>${esc(p.label)}</h4><p class="hint"><code>${esc(p.dir)}</code></p>
    ${p.error ? `<p class="cm-error">${esc(p.error)}</p>` : ""}
    ${p.hooksDisabled ? '<p class="cm-error">User hooks are disabled in this profile.</p>' : ""}
    ${p.managedOnly ? '<p class="hint">This profile allows only managed mods.</p>' : ""}
    ${p.plugins.length ? p.plugins.map(m => `<article class="cm-plugin"><div><strong>${esc(m.name)}</strong> <span class="tag">${m.mod ? "Mod" : "Plugin"}</span> <span class="hint">${esc(m.version ?? "")}</span></div>
      <p>${esc(m.description || (m.missing ? "Plugin files are missing." : "No description."))}</p>
      <p class="hint">${m.enabled ? "Configured on" : "Not enabled in user settings"} · ${esc(m.scope)}${m.source === "directory" ? " · local directory" : ""}${m.projectPath ? ` · ${esc(m.projectPath)}` : ""}${m.missing ? " · files missing" : ""}</p>
      ${m.commands.length ? `<p class="hint">${m.commands.map(c => `<code>${esc(c)}</code>`).join(" · ")}</p>` : ""}</article>`).join("") : '<p class="hint">No configured plugins found.</p>'}</section>`;
}
function cmInventoryHTML() {
  return `<div class="cm-inventory"><div class="cm-heading"><h3>Claude Mods & plugins</h3><button class="btn" data-cm-refresh>Refresh</button></div>
    <p>Installed plugins and local mod directories on each machine, grouped by Claude profile.</p>
    <p class="hint">This is configuration, not proof a running session loaded it. Project and managed settings can override it. Open a session’s Mods panel → /plugin to check or change its plugins; /reload-plugins applies updates.</p>
    ${cmState.error ? `<p class="cm-error">${esc(cmState.error)}</p>` : ""}
    ${!cmState.machines ? '<p class="hint">Reading profiles…</p>' : cmState.machines.map(m => `<section><h3>${esc(m.label)}</h3>${m.error ? `<p class="cm-error">${esc(m.error)}</p>` : ""}${m.profiles.map(cmProfileHTML).join("")}${!m.error && !m.profiles.length ? '<p class="hint">No Claude profiles found.</p>' : ""}</section>`).join("")}</div>`;
}
async function cmLoad() {
  if (cmState.loading) return;
  cmState.loading = true; cmState.error = "";
  try { cmState.machines = (await cmApi({ op: "machines" })).machines; }
  catch (e) { cmState.error = e.message; }
  finally { cmState.loading = false; if (cmOn()) renderPlugins(); }
}
function cmLeave() { clearTimeout(cmState.timer); cmState.timer = null; cmState.generation++; }
async function cmSession(el, row) {
  cmLeave();
  const generation = cmState.generation;
  el.dataset.cmSession = row.sessionId ?? "";
  el.innerHTML = `<div class="cm-session"><h3>Claude Mods</h3><div data-cm-signals>${cmSignals(row)}</div><p class="hint" data-cm-info>Reading this session’s profile…</p><div class="cm-actions" data-cm-commands></div>
    <p class="cm-error" data-cm-error hidden></p><pre class="cm-screen" data-cm-screen aria-label="Claude terminal output"></pre>
    <div class="cm-actions"><button class="btn" data-cm-focus>Focus mod buttons</button>${["tab", "shift+tab", "left", "right", "up", "down", "enter", "esc", "a", "b", "c", "d", "e"].map(k => `<button class="btn" data-cm-key="${k}">${k}</button>`).join("")}</div>
    <p class="hint">For next-steps: focus the buttons, then press a–e. Guards keep running inside Claude.</p>
    <div class="cm-actions"><button class="btn" data-cm-terminal>Open full terminal</button><button class="btn" data-cm-inventory>All profiles & plugins</button></div>
    <p class="hint">Graphics and mouse-only widgets need the native terminal. Commands registered dynamically can be typed in the full terminal.</p></div>`;
  const current = () => cmState.generation === generation && el.isConnected && S.sel === row.key;
  const fail = (e) => { if (current()) { const box = el.querySelector("[data-cm-error]"); box.hidden = false; box.textContent = e.message; } };
  async function act(body, button) {
    if (button) button.disabled = true;
    try { await cmApi({ ...body, machine: row.machine ?? S.self, key: row.key, sessionId: row.sessionId }); }
    catch (e) { fail(e); }
    finally { if (button) button.disabled = false; }
  }
  el.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.hasAttribute("data-cm-focus")) return act({ op: "keys", keys: ["ctrl+x", "tab"] }, b);
    if (b.dataset.cmKey) return act({ op: "keys", keys: [b.dataset.cmKey] }, b);
    if (b.dataset.cmCommand) return act({ op: "command", command: b.dataset.cmCommand }, b);
    if (b.hasAttribute("data-cm-terminal")) openInspector("term");
    if (b.hasAttribute("data-cm-inventory")) cmOpen();
  };
  try {
    const data = await cmApi({ op: "session", key: row.key, machine: row.machine ?? S.self });
    if (!current()) return;
    const profile = data.profiles.find(p => p.id === data.profile);
    el.querySelector("[data-cm-info]").textContent = profile ? `${profile.label} · ${profile.plugins.filter(p => p.mod && p.enabled).length} mods configured. /plugin shows what this session actually loaded.` : "Profile not identified yet. /plugin shows what this session loaded.";
    el.querySelector("[data-cm-commands]").innerHTML = data.commands.map(c => `<button class="btn" data-cm-command="${esc(c)}">${esc(c)}</button>`).join("");
  } catch (e) { fail(e); }
  let hash = "";
  async function screen() {
    if (!current()) return;
    if (!document.hidden) {
      try {
        const d = await api("/api/read", { key: row.key, lines: 100, hash });
        if (!current()) return;
        if (!d.same) { hash = d.hash; const pre = el.querySelector("[data-cm-screen]"); pre.innerHTML = ansi(d.text ?? ""); pre.scrollTop = pre.scrollHeight; }
      } catch (e) { fail(e); }
    }
    if (current()) cmState.timer = setTimeout(screen, 1000);
  }
  void screen();
}
const cmReg = deckPlugins.register("claude-mods", {
  palette: () => [{ t: "Claude Mods: profiles, plugins and controls", slot: "more", run: cmOpen }],
});
cmReg.extend("plugins.tabs", { id: "claude-mods", label: "Claude Mods", order: 35, render: cmInventoryHTML, open: cmLoad });
cmReg.extend("inspector.tabs", { key: "claude-mods", label: "Mods", icon: ICON.bot, order: 35, when: cmLive, render: cmSession,
  patch: (el, row) => { if (el.dataset.cmSession !== (row.sessionId ?? "")) return cmSession(el, row); const box = el.querySelector("[data-cm-signals]"); if (box) setHTML(box, cmSignals(row)); }, leave: cmLeave });
cmReg.extend("row.chips", (row) => cmLive(row) ? cmSignals(row) : "");
cmReg.extend("session.menu", (row) => cmLive(row) ? [{ html: `${ICON.bot} Claude Mods`, run: () => openInspector("claude-mods") }] : []);
cmReg.extend("new.fields", {
  render(el, { kind }) {
    const profiles = newOpts?.claudeProfiles ?? [];
    el.hidden = kind !== "claude" || !profiles.length;
    if (el.hidden) { el.replaceChildren(); return; }
    const selected = load("cmProfile:" + newMachine, "");
    el.innerHTML = `<label class="lab" for="cmNewProfile">Claude profile</label><select class="inp" id="cmNewProfile"><option value="">Shell default</option>${profiles.map(p => `<option value="${esc(p.id)}"${selected === p.id ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select><p class="hint">Uses this profile’s account, settings and plugins on ${esc(realMachines().find(m => m.id === newMachine)?.label ?? "this machine")}.</p>`;
    el.querySelector("select").onchange = (e) => store("cmProfile:" + newMachine, e.target.value);
  },
  apply(body) { if (body.kind === "claude" && $("cmNewProfile")?.value) body.claudeProfile = $("cmNewProfile").value; },
  restore(pre) { if (pre.claudeProfile && $("cmNewProfile")) $("cmNewProfile").value = pre.claudeProfile; },
});
document.addEventListener("click", (e) => { if (e.target.closest("[data-cm-refresh]")) cmLoad(); });
