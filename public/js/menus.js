"use strict";
// Menus: the session's More menu, Settings, Theme, Machines and Simple mode; sharing and verifying a session.
// ── sharing a dev server, verifying ──────────────────────────────────────────
async function shareRow(r, port) {
  if (!S.canShare && r.machine === S.self) return toast("Tailscale isn’t installed on this machine", true);
  const p = port || r.ports?.[0]?.port;
  if (!p) {
    const tool = S.tools.find((t) => t.id === "show-me");
    if (tool && (await askDialog({ title: "No server running", text: "The deck can’t see a server this session runs. Ask the agent to start it and share a tailnet link?", ok: "Ask the agent" }))) runTool(tool, [r.key]);
    return;
  }
  try {
    toast(`Sharing :${p} on your tailnet…`);
    const res = await api("/api/share", { key: r.key, port: p });
    await copy(res.url, "tailnet link");
    window.open(res.url, "_blank", "noopener");
  } catch (e) { toast(e.message, true); }
}
async function unshareRow(r, port) {
  try { await api("/api/share", { key: r.key, port, off: true }); toast(`Stopped sharing :${port}`); } catch (e) { toast(e.message, true); }
}
async function verifyRow(r, force) {
  try {
    const res = await api("/api/verify", { key: r.key, force });
    const c = res.check;
    if (c?.state === "needs-approval") {
      const cmd = await askDialog({ title: `Verify ${r.project}?`, text: "The deck will run this in the project folder now, and again whenever an agent there says it’s done. You can edit it; it’s remembered for this project only.", input: c.cmd, ok: "Allow and run" });
      if (!cmd) return;
      await api("/api/verify", { key: r.key, approve: true, cmd, force: true });
      return toast(`Checking ${r.project}…`);
    }
    toast(c?.state === "skipped" ? c.reason ?? "Nothing to check" : c?.state === "queued" || c?.state === "running" ? `Checking ${r.project}…` : `Last check: ${c?.state}`);
  } catch (e) { toast(e.message, true); }
}
function checkMenu(anchor, r) {
  const c = r.check;
  if (!c) return verifyRow(r, true);
  if (c.state === "needs-approval") return verifyRow(r, false);
  openMenu(anchor, [
    { html: `<span>${esc(c.cmd ?? "")}</span><small>${esc(c.state)}${c.at ? ` · ${esc(agoText(c.at))}` : ""}${c.ms ? ` · ${Math.round(c.ms / 1000)}s` : ""}</small>`, run: () => {} },
    c.tail?.length && { html: "Show the output", run: () => askDialog({ title: `${c.cmd} → ${c.state}`, text: c.tail.slice(-40).join("\n"), ok: "Close" }) },
    { html: "Run again", run: () => verifyRow(r, true) },
    { html: "Change the command…", run: async () => { const cmd = await askDialog({ title: `Check command for ${r.project}`, input: c.cmd ?? "", ok: "Save and run" }); if (cmd) api("/api/verify", { key: r.key, approve: true, cmd, force: true }).catch((x) => toast(x.message, true)); } },
    { html: "Turn checks off for this project", danger: true, run: () => api("/api/verify", { key: r.key, approve: false }).then(() => toast("Checks off")) },
  ].filter(Boolean));
}
$("views")?.addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) setMode(S.mode === v ? null : v); });


let menuEl = null;
function openMenu(anchor, items, heading, cls = "") {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "menu " + cls;
  menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = (heading ? `<div class="mh">${esc(heading)}</div>` : "") + items.map((it, i) => it === "-" ? "<hr>" : `<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}${it.on ? " on" : ""}"${it.title ? ` title="${esc(it.title)}"` : ""}>${it.html}</button>`).join("");
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const h = menuEl.offsetHeight, w = menuEl.offsetWidth;
  menuEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
  const up = cls.includes("up") || r.bottom + h + 8 > innerHeight;
  menuEl.style.top = (up ? Math.max(8, r.top - h - 8) : r.bottom + 6) + "px";
  menuEl.style.transformOrigin = `${Math.round(r.left + r.width / 2 - parseFloat(menuEl.style.left))}px ${up ? "100%" : "0"}`;
  menuEl.onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b) return; const it = items[Number(b.dataset.i)]; closeMenu(); it.run(); };
  menuEl.querySelector("button")?.focus();
  menuEl.addEventListener("keydown", (e) => {
    const bs = [...menuEl.querySelectorAll("button")];
    const i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); anchor.focus?.(); }
  });
}
function closeMenu() { if (menuEl) motion.leave(menuEl, "fade"); menuEl = null; }
addEventListener("pointerdown", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
function moreMenu(anchor) {
  const r = rowOf(S.sel);
  if (!r) return;
  if (r.app) return openMenu(anchor, [
    { html: "Open in the Codex app", run: () => codexAct("codex-open", r) },
    { html: "Continue in herdr<small>Resume with the Codex CLI in a new tab</small>", run: () => codexAct("codex-resume", r) },
    { html: "Copy link", run: () => copy(linkUrl(r), "link") },
    { html: "Copy resume command", run: () => copy(r.resume, "resume command") },
    { html: briefBusy.has(r.key) ? "Writing brief…" : "Write or rewrite the brief", run: () => writeBrief(r.key) },
    "-",
    { html: "Hide from the deck", run: () => codexAct("codex-hide", r) },
  ]);
  openMenu(anchor, [
    isPhone() && { html: "Switch herdr to this pane", run: () => focusPane(r.key) },
    { html: "Copy link", run: () => copy(linkUrl(r), "link") },
    r.resume && { html: "Copy resume command", run: () => copy(r.resume, "resume command") },
    projectHome(r.project) && { html: `New session in ${esc(r.project)}<small>${esc(home(projectHome(r.project).cwd))}</small>`, run: () => openNew(projectHome(r.project)) },
    { html: "Copy folder path", run: () => copy(r.cwd, "path") },
    { html: "Rename…<small>The herdr pane and the agent’s own name</small>", run: () => renameSession(r) },
    { html: briefBusy.has(r.key) ? "Writing brief…" : "Write or rewrite the brief", run: () => writeBrief(r.key) },
    !isPhone() && { html: "Type into the terminal", run: () => focusTerminal() },
    !isPhone() && { html: `Move the terminal…<small>Now: ${TPOS_NAME[S.tpos].toLowerCase()}</small>`, run: () => layoutMenu(anchor) },
    "-",
    { html: "Close session…", danger: true, run: () => askClose([r.key]) },
  ].filter(Boolean));
}
function settingsMenu(anchor) {
  openMenu(anchor, [
    { html: `Theme: ${esc(THEMES.find((t) => t[0] === load("theme", ""))?.[1] ?? "System")}<small>${THEMES.length - 1} themes: Dracula, Catppuccin, Tokyo Night, Nord…</small>`, run: () => setTimeout(() => themeMenu(anchor), 0) },
    { html: `Notifications on this device…<small>${PUSH.on ? "On: pushed even when the deck is closed" : S.notify ? "Page alerts on (only while the deck is open)" : "When an agent needs you or finishes"}</small>`, run: openNotifications },
    { html: "Automations…<small>Alerts, morning digest, empty sessions, proof of done</small>", run: openAutomations },
    { html: `Auto briefs: ${S.autoBrief ? "on" : "off"}<small>Write a brief when you open a session</small>`, run: () => { S.autoBrief = !S.autoBrief; store("autoBrief", S.autoBrief); toast(`Auto briefs ${S.autoBrief ? "on" : "off"}`); } },
    !isPhone() && { html: `Terminal: ${TPOS_NAME[S.tpos].toLowerCase()}<small>Move it (\\)</small>`, run: () => layoutMenu(anchor) },
    { html: "Close candidates<small>Select empty, duplicate and week-old sessions</small>", run: suggestClose },
    { html: `Simple mode: ${S.simple ? "on" : "off"}<small>Big, friendly, only the essentials</small>`, run: () => setSimple(!S.simple) },
    { html: "Machines…<small>Add or remove computers the deck watches</small>", run: openMachines },
    { html: "Tools<small>What each tool does; add your own</small>", run: () => setMode("tools") },
    { html: "Usage<small>Every AI account’s limits and balance, on every machine</small>", run: () => setMode("usage") },
    ...deckPlugins.contributions("settings.entries"),
    { html: `Reduce motion: ${motion.reduced() ? "on" : "off"}<small>${motion.reduced() ? "Your system asks for less motion" : "Things change at once, without animating"}</small>`, run: () => { motion.setReduced(!motion.reduced()); toast(`Reduce motion ${motion.reduced() ? "on" : "off"}`); } },
    !isPhone() && { html: "Keyboard shortcuts<small>?</small>", run: openKeys },
  ].filter(Boolean));
}
function setTheme(name) { motion.swap(() => applyTheme(name)); store("theme", name); }
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  setTheme(["light", "paper"].includes(cur) ? "dark" : "light");
}
function themeMenu(anchor) {
  const cur = load("theme", "");
  openMenu(anchor, THEMES.map(([id, label, hint, [a, b]]) => ({
    html: `<span style="display:flex;gap:9px;align-items:center"><span style="width:26px;height:18px;border-radius:5px;background:linear-gradient(135deg, ${a} 55%, ${b} 55%);box-shadow:inset 0 0 0 1px rgba(127,127,127,.35);flex:none"></span><span>${esc(label)}<small style="display:block">${esc(hint)}</small></span></span>`,
    on: cur === id, run: () => setTheme(id),
  })), "Theme");
}
async function toggleAlerts() {
  if (!("Notification" in window)) return toast("This browser can’t show notifications", true);
  if (!S.notify && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return toast("Notifications are blocked for this page", true);
  S.notify = !S.notify; store("notify", S.notify); toast(`Alerts ${S.notify ? "on" : "off"}`);
}

// ── machines: add or remove the computers this deck watches ─────────────
async function openMachines() {
  let info;
  try { info = await api("/api/machines", {}); } catch (e) { return toast(e.message, true); }
  const d = document.createElement("dialog");
  d.className = "ask wide";
  const draw = () => {
    const rows = info.remotes.map((m) => `<div class="mrow"><span class="dot" style="--c:var(--${m.online ? "idle" : "blocked"})"></span><b>${esc(m.label)}</b><span class="hint">${esc(m.ssh)}${m.online ? "" : ` · ${esc(m.error ?? "offline")}`}</span><span class="spacer"></span><button type="button" class="btn ghost" data-mren="${esc(m.id)}">Rename</button><button type="button" class="btn ghost danger" data-mdel="${esc(m.id)}">Remove</button></div>`).join("");
    const self = info.machines.find((m) => m.local && m.kind !== "app");
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Machines</h3><p class="hint">Each machine runs its own copy of the deck; this one (${esc(self?.label ?? "")}) shows them all together.</p>
      <div class="mrow"><span class="dot" style="--c:var(--idle)"></span><b>${esc(self?.label ?? "This machine")}</b><span class="hint">this machine</span></div>${rows}
      <h4 style="margin:18px 0 6px">Add a machine</h4>
      <p class="hint">It needs SSH access with a key (no password prompt) and <a href="https://bun.sh" target="_blank" rel="noopener">Bun</a> installed. The deck installs itself there as a user service that only listens locally, then connects through SSH.</p>
      <div class="madd"><input class="inp" name="ssh" list="mSsh" placeholder="SSH host, e.g. work-laptop" autocomplete="off"><datalist id="mSsh">${info.sshHosts.filter((h) => !info.remotes.some((m) => m.ssh === h)).map((h) => `<option value="${esc(h)}">`).join("")}</datalist><input class="inp" name="label" placeholder="Name (optional)"><button type="button" class="btn primary" data-madd>Add</button></div>
      <div class="mlog hint" aria-live="polite"></div></div><div class="dlg-f"><button class="btn" value="ok">Done</button></div></form>`;
  };
  draw();
  document.body.append(d);
  d.addEventListener("close", () => motion.drop(d));
  d.addEventListener("click", async (e) => {
    const add = e.target.closest("[data-madd]"), del = e.target.closest("[data-mdel]"), ren = e.target.closest("[data-mren]");
    const log = d.querySelector(".mlog");
    try {
      if (add) {
        const f = new FormData(d.querySelector("form"));
        if (!String(f.get("ssh")).trim()) return;
        add.disabled = true; add.innerHTML = '<span class="spin"></span> Installing…';
        log.textContent = `Installing the deck on ${f.get("ssh")} and connecting. This takes about a minute.`;
        await api("/api/machines", { op: "add", ssh: f.get("ssh"), label: f.get("label") });
        toast(`Added ${f.get("label") || f.get("ssh")}`);
      } else if (del) {
        const m = info.remotes.find((x) => x.id === del.dataset.mdel);
        if (!(await askDialog({ title: `Remove ${m.label}?`, text: "The deck stops showing its sessions. Nothing on that machine is closed or uninstalled; you can add it back any time.", ok: "Remove", danger: true }))) return;
        await api("/api/machines", { op: "remove", id: m.id });
      } else if (ren) {
        const m = info.remotes.find((x) => x.id === ren.dataset.mren);
        const label = await askDialog({ title: "Rename machine", input: m.label, ok: "Rename" });
        if (!label) return;
        await api("/api/machines", { op: "rename", id: m.id, label });
      } else return;
      info = await api("/api/machines", {});
      draw();
    } catch (x) { log.textContent = x.message; if (add) { add.disabled = false; add.textContent = "Add"; } toast(x.message, true); }
  });
  d.showModal();
}

// ── simple mode ──────────────────────────────────────────────────────────
function setSimple(on) {
  S.simple = on;
  store("simple", on);
  if (on) document.documentElement.dataset.simple = ""; else delete document.documentElement.dataset.simple;
  if (on && S.group !== "priority") setGroup("priority");
  app.classList.toggle("term-off", on || load("termOff", false));
  if (on) { S.tab = "chat"; S.mode = null; }
  headSig = ""; bodySig = ""; chatDom.key = null; lastOrder = "";
  for (const c of rowCache.values()) c.sig = "";
  motion.swap(() => { renderNow(); renderDetail(); });
  toast(on ? "Simple mode on. Settings → Simple mode turns it off." : "Simple mode off");
}
