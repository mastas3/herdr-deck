"use strict";
// The command palette (⌘K), and sending a message by description.
// ── command palette ──────────────────────────────────────────────────────
let palItems = [], palIndex = 0;
function openPalette(initial = "") {
  const d = $("palette");
  if (palRoute) routeReset();
  $("palQ").value = initial;
  if (!d.open) d.showModal();
  renderPalette();
  $("palQ").focus();
}
function fuzzy(text, q) {
  if (!q) return 1;
  const t = text.toLowerCase();
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = t.indexOf(w);
    if (i < 0) return 0;
    score += i === 0 || t[i - 1] === " " ? 3 : 1;
  }
  return score;
}
function paletteItems(q) {
  const out = [];
  // A sentence rather than a search: offer to have Jev find the session it's meant for.
  if (routeOn() && q.split(/\s+/).filter(Boolean).length >= 3) out.push({ html: `<span>Send to the right session…</span><small>Jev suggests, you confirm</small>`, keep: true, route: true, run: () => routeAsk(q) });
  const cur = rowOf(S.sel);
  const n = targets().length;
  const sessions = [...S.rows.values()].map((r) => ({ r, s: fuzzy(`${r.title} ${r.project} ${r.launch ?? ""} ${paneName(r)} ${machineLabel(r.machine)} ${r.agent} ${r.branch ?? ""}`, q) }))
    .filter((x) => x.s).sort((a, b) => b.s - a.s || (b.r.lastActiveAt ?? 0) - (a.r.lastActiveAt ?? 0)).slice(0, q ? 8 : 5);
  if (sessions.length) out.push({ head: q ? "Sessions" : "Recent sessions" }, ...sessions.map(({ r }) => ({
    html: `<span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.title || r.agent)} <span class="hint">${paneTag(r)}</span></span><small>${esc(r.project)}${multiMachine() ? " · " + esc(machineLabel(r.machine)) : ""} · ${esc(ago(r.lastActiveAt) || STATUS_NAME[r.status])}</small>`,
    run: () => { if (!inScope(r)) setMachine("all"); S.view = "inbox"; select(r.key, { scroll: true, open: true }); },
  })));
  if (n && (q || !cur)) {
    const tools = S.tools.filter((t) => t.action !== "upload").map((t) => ({ t, s: fuzzy(`${t.label} ${t.hint ?? ""} tool`, q) })).filter((x) => x.s).slice(0, q ? 6 : 4);
    if (tools.length) out.push({ head: n > 1 ? `Tools for ${n} selected` : `Tools for “${cur?.title ?? "session"}”` }, ...tools.map(({ t }) => ({ html: `<span>${esc(t.label)}</span><small>${esc(t.hint ?? "")}</small>`, run: () => runTool(t) })));
  }
  // Plugins' commands go in the list at two places, "views" (next to the core's go-to commands) and "more"
  // (after Plugins); a `section` entry gets a heading of its own below, once you've typed something.
  const plug = deckPlugins.each("palette.entries", q, cur).flat().filter(Boolean);
  const slot = (name) => plug.filter((c) => !c.section && (c.slot ?? "more") === name).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // Commands: `id` takes its key hint from keymap.js; `ctx` ones act on the selected session (their own heading).
  const all = [
    { t: "New session", id: "new", run: () => openNew() },
    cur && projectHome(cur.project) && { t: `New session in ${cur.project}`, ctx: true, run: () => openNew(projectHome(cur.project)) },
    { t: "Next session waiting on you", id: "needs", run: nextNeedsMe },
    { t: "Live board: everything working right now", id: "board", run: () => setBoard(true) },
    cur && { t: "Message this session", id: "reply", ctx: true, run: focusReply },
    cur && !cur.app && { t: "Jump to this pane in herdr", id: "focus", ctx: true, run: () => focusPane(cur.key) },
    cur?.app && { t: "Open this thread in the Codex app", ctx: true, run: () => codexAct("codex-open", cur) },
    cur?.app && { t: "Continue this Codex thread in herdr", ctx: true, run: () => codexAct("codex-resume", cur) },
    cur && { t: "Copy a link to this session", id: "link", ctx: true, run: () => copy(linkUrl(cur), "link") },
    cur?.resume && { t: "Copy its resume command", id: "resume", ctx: true, run: () => copy(cur.resume, "resume command") },
    cur && !cur.app && !cur.hist && { t: "Rename this session…", id: "rename", ctx: true, run: () => renameSession(cur) },
    ...slot("views"),
    { t: "Machines: add or remove computers", run: openMachines },
    { t: S.simple ? "Simple mode: off" : "Simple mode: big and friendly", run: () => setSimple(!S.simple) },
    cur && { t: "Write or rewrite the brief", id: "brief", ctx: true, run: () => writeBrief(cur.key) },
    cur && { t: "Close this session…", id: "close", ctx: true, run: () => askClose([cur.key]) },
    { t: "Select every session shown", id: "pickall", run: pickAllShown },
    n > 1 && { t: `Message ${n} selected sessions…`, run: messagePicked },
    n > 1 && { t: `Close ${n} selected sessions…`, run: () => askClose(targets()) },
    S.picked.size > 0 && { t: "Clear the selection", run: () => { S.picked.clear(); render(); } },
    { t: S.group === "project" ? "Sort the list by priority" : "Group the list by project", id: "group", run: () => setGroup(S.group === "project" ? "priority" : "project") },
    ...(!isPhone() ? TPOS.filter((p) => p !== S.tpos).map((p) => ({ t: `Terminal: ${TPOS_NAME[p].toLowerCase()}`, run: () => setTpos(p) })) : []),
    { t: "Standup: ask every idle agent for a status line", run: standup },
    { t: "Select close candidates", run: suggestClose },
    { t: "Close all empty sessions…", run: () => askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)) },
    { t: "Show closed sessions", id: "closed", run: () => { S.view = "closed"; render(); } },
    { t: "Decision inbox: everything waiting on you", id: "inbox", run: () => setMode("inbox") },
    { t: "History: search every past session", id: "history", run: () => { setMode("history"); focusHistSearch(); } },
    { t: "Tools: what each one does", run: () => setMode("tools") },
    { t: "Usage: every AI account's limits and balance", id: "usage", run: () => setMode("usage") },
    { t: "Plugins: add integrations and business packs", run: () => setMode("plugins") },
    ...slot("more"),
    { t: `Turn alerts ${S.notify ? "off" : "on"}`, run: toggleAlerts },
    { t: "Notifications on this device…", run: openNotifications },
    { t: "Automations: alerts, morning digest, empty sessions, proof of done", run: openAutomations },
    { t: "Show the morning digest now", run: async () => { try { S.auto = await api("/api/automations", { op: "digest" }); goHome(); render(); } catch (e) { toast(e.message, true); } } },
    { t: "Toggle light / dark", run: toggleTheme },
    ...THEMES.map(([id, label]) => ({ t: `Theme: ${label}`, run: () => setTheme(id) })),
    !isPhone() && { t: "Keyboard shortcuts", id: "help", run: openKeys },
    ...(multiMachine() ? [["all", "all machines"], ...S.summary.machines.map((m) => [m.id, m.label])].map(([id, label]) => ({ t: `Show ${label}`, run: () => setMachine(id) })) : []),
  ].filter(Boolean).map((c) => ({ ...c, k: c.k ?? (c.id ? keyOf(c.id) : "") }));
  const cmdRow = (c) => ({ html: `<span>${esc(c.t)}</span>${c.k && !isPhone() ? `<small><kbd>${esc(c.k)}</kbd></small>` : ""}`, echo: c.echo, run: c.run, t: c.t });
  if (q) {
    const cmds = all.map((c) => ({ ...c, s: fuzzy(c.t, q) })).filter((c) => c.s).slice(0, 8);
    if (cmds.length) out.push({ head: "Commands" }, ...cmds.map(cmdRow));
  } else {
    // Empty: what you ran last, then what you can do to the selected session, then the everyday commands.
    const recent = load("palRecent", []).map((t) => all.find((c) => c.t === t)).filter(Boolean).slice(0, 3);
    const ctx = all.filter((c) => c.ctx && !recent.includes(c)).slice(0, 6);
    const rest = all.filter((c) => !c.ctx && !recent.includes(c)).slice(0, cur ? 4 : 6);
    if (recent.length) out.push({ head: "Recent commands" }, ...recent.map(cmdRow));
    if (ctx.length) out.push({ head: `“${cur.title || cur.agent}”` }, ...ctx.map(cmdRow));
    if (rest.length) out.push({ head: "Commands" }, ...rest.map(cmdRow));
  }
  if (q) {
    // A project quick switcher: show only it, or start a new session in its folder ("acme" or "new acme").
    const projects = [...new Set([...S.rows.values()].map((r) => r.project))].flatMap((p) => {
      const h = projectHome(p), dot = `<span class="dot" style="--c:${pc(p)}"></span>`;
      return [
        { s: fuzzy(`${p} only show`, q), html: `${dot}<span>Only show ${esc(p)}</span>`, run: () => { $("q").value = p; S.q = p; S.view = "inbox"; render(); } },
        h && { s: fuzzy(`${p} new session`, q) && fuzzy(p, q.replace(/\b(new|session)\b/gi, "")), html: `${dot}<span>New session in ${esc(p)}</span><small>${esc(home(h.cwd))}</small>`, t: `New session in ${p}`, run: () => openNew(h) },
      ].filter((x) => x && x.s);
    }).slice(0, 6);
    if (projects.length) out.push({ head: "Projects" }, ...projects);
    const heads = [...new Set(plug.filter((c) => c.section).map((c) => c.section))];
    for (const h of heads) out.push({ head: h }, ...plug.filter((c) => c.section === h).map(({ html, run }) => ({ html, run })));
  }
  return out;
}
function renderPalette() {
  palItems = paletteItems($("palQ").value.trim());
  // Enter runs the top match. Routing (a Jev call) is the default only when nothing else matches; the Idea lab
  // item echoes any long query, so it doesn't count as a match, and comes last.
  const at = (f) => palItems.findIndex((x) => !x.head && f(x));
  palIndex = [at((x) => !x.route && !x.echo), at((x) => x.route), at(() => true)].find((i) => i >= 0) ?? -1;
  $("palList").innerHTML = palItems.map((it, idx) => it.head ? `<div class="mh">${esc(it.head)}</div>` : `<button role="option" data-p="${idx}" class="${idx === palIndex ? "on" : ""}">${it.html}</button>`).join("") || `<div class="empty-state">Nothing found</div>`;
}
function palMove(d) {
  const idxs = palItems.map((x, i) => (x.head ? -1 : i)).filter((i) => i >= 0);
  if (!idxs.length) return;
  palIndex = idxs[(idxs.indexOf(palIndex) + d + idxs.length) % idxs.length];
  for (const b of $("palList").querySelectorAll("[data-p]")) b.classList.toggle("on", Number(b.dataset.p) === palIndex);
  $("palList").querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function palRun(i = palIndex) {
  const it = palItems[i];
  if (!it || it.head) return;
  if (it.t) store("palRecent", [it.t, ...load("palRecent", []).filter((t) => t !== it.t)].slice(0, 8));
  if (!it.keep) $("palette").close();
  it.run();
}
$("palQ").addEventListener("input", renderPalette);
$("palQ").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
  else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); palRun(); } // the route view it may open mustn't see this Enter
});
$("palList").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) palRun(Number(b.dataset.p)); });
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) $("palette").close(); });

// ── send by description ──────────────────────────────────────────────────
// Jev suggests which session a message is for; nothing is sent until you press Enter or Send here.
let palRoute = null;
let routeDraft = null; // the message as you last edited it, kept when you go back to the list
const PAL_FOOT = $("palette").querySelector(".pal-foot").innerHTML;
const routeOn = () => !!S.jev?.available && S.jev?.features?.route !== false;
const ROUTE_SURE = 0.6;
const ROUTE_SETTLE_MS = 400; // Enter does nothing this long after the picks appear, so a held or double Enter can't send
const ROUTE_WHY = { no_sessions: "No coding-agent session is running to send it to.", one_session: "Only one session can take it.", timeout: "Jev took too long.", deck_daily_cap: "Jev’s daily cap for the deck is used up.", unavailable: "Jev isn’t available." };
// Without Jev's picks you still choose, from the most recent sessions that can take a message.
const routeRecent = () => [...S.rows.values()].filter((r) => isAgent(r) && !r.empty && r.status !== "empty" && !r.app && !r.hist)
  .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)).slice(0, 6).map((r) => ({ key: r.key }));
async function routeAsk(q) {
  const m = palRoute = { q, busy: true, list: [], sel: null };
  $("palQ").hidden = true;
  $("palette").querySelector(".pal-foot").innerHTML = `<span><kbd>↑</kbd> <kbd>↓</kbd> pick</span><span><kbd>↵</kbd> send</span><span><kbd>esc</kbd> back</span>`;
  $("palList").innerHTML = `<div class="proute"><textarea id="palMsg" rows="3" aria-label="Message to send" spellcheck="true"></textarea><div class="mh" id="palWhy"></div><div id="palPicks" role="listbox" aria-label="Sessions"></div>
    <div class="proute-f"><button type="button" class="btn" data-rback>Back</button><button type="button" class="btn primary" data-rsend>Send</button></div></div>`;
  $("palMsg").value = routeDraft?.q === q ? routeDraft.text : q;
  $("palMsg").focus();
  renderRoute();
  try {
    const r = await api("/api/jev/route", { text: q }, 20_000);
    if (palRoute !== m) return; // you went back or closed the palette meanwhile
    const picks = (r.picks ?? []).filter((x) => S.rows.has(x.key));
    if (picks.length) {
      m.list = picks;
      m.sel = picks[0].p >= ROUTE_SURE && !routeBlocked(picks[0].key) ? picks[0].key : null;
      m.why = m.sel ? `Jev’s pick${r.ms != null ? ` · ${r.ms} ms` : ""}` : picks[0].p >= ROUTE_SURE ? "Jev’s pick is waiting on a prompt, so it isn’t preselected" : "Jev isn’t sure, pick one";
    } else {
      m.list = routeRecent();
      // Only one session can take it: pick it for you, Enter still sends.
      if (r.fallback === "one_session" && m.list.length === 1 && !routeBlocked(m.list[0].key)) m.sel = m.list[0].key;
      m.why = `${ROUTE_WHY[r.fallback] ?? "Jev couldn’t pick one."}${m.list.length && !m.sel ? " Pick one." : ""}`;
    }
  } catch (x) {
    if (palRoute !== m) return;
    m.list = routeRecent();
    m.why = `${x.message}${m.list.length ? " Pick one." : ""}`;
  }
  m.busy = false;
  m.readyAt = Date.now() + ROUTE_SETTLE_MS;
  renderRoute();
}
// A session waiting on a prompt could take the message as its answer ("yes, and…"): flag it, never preselect it.
const routeBlocked = (key) => rowOf(key)?.status === "blocked";
function renderRoute() {
  const m = palRoute;
  if (!m) return;
  $("palWhy").textContent = m.busy ? "Asking Jev which session…" : m.why;
  $("palPicks").innerHTML = m.list.map((x) => {
    const r = rowOf(x.key);
    if (!r) return "";
    return `<button type="button" role="option" data-rk="${esc(x.key)}" class="${x.key === m.sel ? "on" : ""}" aria-selected="${x.key === m.sel}"><span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.project)} · ${esc(r.title || r.agent)}${x.p != null ? ` — ${Math.round(x.p * 100)}%` : ""}</span><small>${multiMachine() ? esc(machineLabel(r.machine)) + " · " : ""}${r.status === "blocked" ? `<b>${pendingAsk(r)?.kind === "question" ? "waiting on your answer to a question" : "waiting on a permission prompt"}</b>` : esc(STATUS_NAME[r.status] ?? r.status)}</small></button>`;
  }).join("");
  $("palette").querySelector("[data-rsend]").disabled = m.busy || !m.sel;
}
function routeMove(d) {
  const m = palRoute;
  if (!m?.list.length) return;
  const i = m.list.findIndex((x) => x.key === m.sel);
  m.sel = m.list[i < 0 ? (d > 0 ? 0 : m.list.length - 1) : (i + d + m.list.length) % m.list.length].key;
  renderRoute();
  $("palPicks").querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function routeBack() {
  const q = palRoute?.q ?? "";
  if (palRoute) routeDraft = { q, text: $("palMsg").value };
  routeReset();
  $("palQ").value = q;
  renderPalette();
  $("palQ").focus();
}
function routeReset() {
  palRoute = null;
  $("palQ").hidden = false;
  $("palette").querySelector(".pal-foot").innerHTML = PAL_FOOT;
}
async function routeSend() {
  const m = palRoute;
  if (!m || m.busy || m.sending) return;
  const r = rowOf(m.sel), text = $("palMsg").value.trim();
  if (!r) return toast("Pick a session first", true);
  if (!text) return toast("Type a message first", true);
  m.sending = true;
  try {
    // The same path as the message box: long text travels as a file.
    await api("/api/send", { key: r.key, text: text.length > LONG_SEND ? await fileLongText(r, text, []) : text });
    routeDraft = null;
    $("palette").close();
    toast(`Sent to ${r.project}: “${plain(text).slice(0, 50)}${text.length > 50 ? "…" : ""}”`);
    if (S.sel === r.key) setTimeout(() => chatTick(true), 250);
  } catch (x) { m.sending = false; toast("Send failed: " + x.message, true); }
}
$("palette").addEventListener("keydown", (e) => {
  if (!palRoute) return;
  const t = e.target;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); routeBack(); }
  else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    if (t.closest?.("[data-rback], [data-rsend]")) return; // the button's own click
    if (t.id === "palMsg" && isPhone()) return; // a new line, like the message box on a phone
    e.preventDefault();
    // Only a fresh press after Jev's picks have settled sends: not the Enter that opened this view, nor one held down.
    if (palRoute.busy || e.repeat || Date.now() < (palRoute.readyAt ?? Infinity)) return;
    if (t.dataset?.rk) { palRoute.sel = t.dataset.rk; renderRoute(); }
    routeSend();
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !(t.id === "palMsg" && t.value.includes("\n"))) { e.preventDefault(); routeMove(e.key === "ArrowDown" ? 1 : -1); }
});
$("palList").addEventListener("click", (e) => {
  if (!palRoute) return;
  const b = e.target.closest("[data-rk]");
  if (b) { palRoute.sel = b.dataset.rk; renderRoute(); return; }
  if (e.target.closest("[data-rback]")) routeBack();
  else if (e.target.closest("[data-rsend]")) routeSend();
});
// Esc on some browsers, and the back gesture on Android, arrive as a cancel: go back rather than close.
$("palette").addEventListener("cancel", (e) => { if (palRoute) { e.preventDefault(); routeBack(); } });
$("palette").addEventListener("close", () => { if (palRoute) routeReset(); });
