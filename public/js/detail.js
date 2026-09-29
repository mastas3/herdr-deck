"use strict";
// The session pane: header, tabs, now bar, the question box, the live board, briefs and the status line.
// ── session pane ─────────────────────────────────────────────────────────
let headSig = "", bodySig = "";
function renderDetail() {
  const r = rowOf(S.sel);
  syncFind();
  syncCodexControl(r);
  app.classList.toggle("native-task", !!r?.app && !S.board && !S.mode);
  const d = S.details.get(S.sel)?.data;
  renderPbar(S.mode || S.board ? null : r);
  if (S.mode) return renderMode();
  $("dbody")._mode = null;
  if (S.board || !r) return renderBoard();
  $("dh").hidden = false;
  const tab = effTab(S.tab, d, S.simple);
  const hs = JSON.stringify([r.title, r.project, r.launch, r.status, r.model, r.branch, r.worktree, r.wtBase, r.dirty, r.tab, r.tabNumber, r.cwd, r.check?.state, r.check?.cmd, r.check?.at, r.ports, r.lastActiveAt, r.duplicate, r.machine, d?.asks, d?.imagesTotal, tab, S.insp.open, S.sub, S.summary.machines?.length, radarChip(r)]);
  if (hs !== headSig) { headSig = hs; renderHead(r, d, tab); }
  const cached = S.details.get(S.sel);
  if (cached && cached.stamp !== r.lastActiveAt && !inflight.has(r.key)) { clearTimeout(renderDetail.t); renderDetail.t = setTimeout(() => loadDetail(r.key), 700); }
  renderNowbar(r, d);
  renderAsk(r);
  $("composer").hidden = !r || S.sub != null || !!r.hist;
  $("appbar").hidden = !(r.app || r.hist) || S.sub != null || !!(r.app && codexView(r)?.ready && !codexConnecting.has(r.key));
  if (r.hist) setHTML($("appbar"), `<span>A past session${r.startedAt ? ` · started <b>${esc(DF.format(new Date(r.startedAt)))}</b>` : ""}${r.lastActiveAt ? ` · last active ${esc(agoText(r.lastActiveAt))}` : ""}${multiMachine() ? ` · ${esc(machineLabel(r.machine))}` : ""}</span><span class="spacer"></span><button class="btn primary" data-dact="histresume" title="Resume it in a new herdr tab">${ICON.term}Resume in herdr</button><button class="btn ghost" data-dact="backhist">${ICON.back} History</button>`);
  else if (r.app) setHTML($("appbar"), codexConnectionHTML(r));
  renderModelChip(r); // model-chip.js
  $("cStop").hidden = !codexCanReply(r) || !((r.status === "working" || r.app && r.status === "blocked") && isAgent(r));
  $("cStop").title = r.app ? "Stop this Codex turn" : "Interrupt the agent (Esc in its terminal)";
  const busy = (r.app ? codexView(r)?.status === "working" : r.status === "working") && isAgent(r);
  $("cSend").disabled = !!r.app && (codexSending.has(r.key) || codexConnecting.has(r.key));
  $("cSteer").disabled = $("cSend").disabled;
  $("cSend").textContent = r.app && codexConnecting.has(r.key) ? "Connecting…" : r.app && busy ? "Queue" : "Send";
  $("cSend").title = busy ? "Send now; the agent picks it up while it works (⌥Enter: hold it until it finishes)" : "Send (Enter)";
  $("cSteer").hidden = !(r.app && busy);
  if (r.app && busy) $("cSend").title = "Send after the current turn; Steer sends now";
  renderQueue(r);
  renderPastes();
  renderStatusLine(r);
  syncDock(); // the frame's height settles before the chat restores its place (inspector.js)
  $("cText").placeholder = r.agent === "shell" ? "Run a command" : r.status === "blocked" ? r.app ? "Reply to Codex" : "Answer, or use the keys above" : `Message ${r.agent === "claude" ? "Claude" : r.agent === "codex" ? "Codex" : r.agent === "opencode" ? "OpenCode" : r.agent}`;
  $("replyText").placeholder = $("cText").placeholder;
  $("mTitle").innerHTML = `<span class="dot" style="--c:${statusVar(r.status)}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(r.title || r.agent)}</span>`;
  $("subcrumb").hidden = !S.sub;
  if (S.sub) {
    const sub = d?.subagents?.find((x) => x.id === S.sub);
    setHTML($("subcrumb"), `<button class="btn ghost" data-dact="unsub">${ICON.back} Main conversation</button><span>${ICON.bot.replace("<svg", '<svg style="width:15px;height:15px;vertical-align:-3px"')} <b>${esc(sub?.description ?? "Subagent")}</b></span><span class="hint">${esc([sub?.type, sub?.model].filter(Boolean).join(" · "))}${sub?.running ? " · running" : ""}</span>`);
  }
  if (tab === "chat") {
    // Coming from another tab, the board or a view: build the chat afresh. Already showing it: renderChat updates it.
    if (bodySig !== "chat") { bodySig = "chat"; if (chatDom.key !== chatId(S.sel, S.sub) || !chatDom.el?.isConnected) { chatDom.key = null; chatDom.fresh = null; } }
    renderChat();
    return;
  }
  const bs = JSON.stringify([tab, r.key, d, r.subagents, briefBusy.has(r.key)]);
  if (bs === bodySig && $("dbody").firstElementChild?.classList.contains("pad")) return;
  bodySig = bs;
  chatDom.key = null;
  const box = $("dbody");
  const scroll = box.scrollTop;
  box.innerHTML = `<div class="pad">${!d ? `<p class="hint">Reading the conversation…</p>` : tab === "images" ? imagesHTML(r, d) : tab === "info" ? factsHTML(r, d) : aboutHTML(r, d)}</div>`;
  box.scrollTop = scroll;
}
function renderHead(r, d, tab) {
  // One line: the title and what it is (status, project, branch), the few actions on the right. Under it one quiet
  // row: the chips that need an eye (uncommitted work, proof of done, servers), then the pane's tabs.
  const where = [r.launch ? `via ${r.launch}` : "", home(r.cwd), r.app ? "Codex app" : r.hist ? "past session" : `herdr ${paneName(r)}`].filter(Boolean).join(" · ");
  const id = [
    `<span class="pill" style="--c:${statusVar(r.status)}">${STATUS_NAME[r.status] ?? esc(r.status)}</span>`,
    projectLink() ? `<button class="pj" data-dact="journey" style="--pc:${pc(r.project)}" title="${esc(where)} · open the project page">${esc(r.project)}</button>` : `<span class="pj" style="--pc:${pc(r.project)}" title="${esc(where)}">${esc(r.project)}</span>`,
    r.branch ? `<span class="mono br" title="Branch">${esc(r.branch)}</span>` : "",
    r.worktree ? `<button class="wtm" data-dact="worktree" title="Working in the worktree ${esc(r.worktree)}${r.wtBase ? `, from ${esc(r.wtBase)}` : ""}. Merge, open a PR, keep or remove it">${ICON.tree}worktree</button>` : "",
  ].join("");
  const chips = [
    radarChip(r),
    r.dirty ? `<span class="wchip" title="${esc(`${r.dirty} file${r.dirty === 1 ? "" : "s"} changed and not committed${r.branch ? ` on ${r.branch}` : ""}`)}">${ICON.warn}${esc(dirtyText(r.dirty))}</span>` : "",
    r.check ? checkChip(r.check, r.project) : "",
    r.duplicate ? `<span class="wchip" title="Two panes are attached to this one conversation">${ICON.warn}duplicate</span>` : "",
    portsChip(r),
    multiMachine() ? `<span class="opt" title="${esc(where)}">${esc(machineLabel(r.machine))}</span>` : "",
    r.lastActiveAt ? `<span class="opt" title="Last active ${esc(abs(r.lastActiveAt))}">active <b data-t="${r.lastActiveAt}" data-fmt="long">${agoText(r.lastActiveAt)}</b></span>` : "",
  ].filter(Boolean).join("");
  const tabs = [["chat", "Chat"], ["about", "About"], ["images", "Images", d?.imagesTotal], ["info", "Info"]]
    .filter(([k, , n]) => k !== "images" || n)
    .map(([k, label, n]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${n ? ` <span class="n">${n}</span>` : ""}</button>`).join("")
    + (tab === "chat" && r.sessionId ? `<button class="ib cfind-btn" data-cfopen title="Search this chat (⌘F)" aria-label="Search this chat">${FIND_ICON}</button>` : "");
  const insp = inspTabs(r).length ? `<button class="ib desk" data-dact="insp" aria-pressed="${app.classList.contains("insp-on")}" aria-label="Inspector: terminal, subagents, servers" title="Inspector: terminal, subagents, servers (])">${ICON.panel}</button>` : "";
  const acts = r.hist ? `<button class="btn" data-dact="backhist">${ICON.back} History</button><button class="btn primary" data-dact="histresume">${ICON.term}Resume</button>`
    : r.app ? `<button class="btn" data-dact="codexopen" title="Open this thread in the Codex app">${ICON.jump}Open in Codex</button>`
    : `<button class="btn desk" data-dact="focus" title="Switch herdr to this pane (f)">${ICON.jump}Jump</button>`;
  setHTML($("dh"), `<div class="dh-top"><h1 class="dh-title" title="${esc(r.title || "")}">${esc(r.title || "(untitled)")}</h1><div class="dh-id">${id}</div>
      <div class="dh-acts">${acts}<button class="ib" data-dact="link" aria-label="Copy a link to this session" title="Copy link (y)">${ICON.link}</button><button class="ib" data-dact="more" aria-label="More actions" title="More">${ICON.more}</button>${insp}</div></div>
    <div class="dh-row2"><div class="dh-meta">${chips}</div><nav class="tabsbar" role="tablist">${tabs}</nav></div>`);
}
function renderNowbar(r, d) {
  const el = $("nowbar");
  const subs = (r.subagents ?? []).filter((x) => x.running);
  const on = r.status === "working" && !S.sub;
  el.hidden = !on;
  if (!on) return;
  const since = r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
  const prog = r.todos?.total ? `<span class="prog" title="${r.todos.done} of ${r.todos.total} steps done"><i style="width:${Math.round((100 * r.todos.done) / r.todos.total)}%"></i></span><span class="stp">${r.todos.done}/${r.todos.total}</span>` : "";
  setHTML(el, `<span class="spin"></span><span>Working${since ? ` <b data-since="${since}">${clock(Date.now() - since)}</b>` : ""}</span>${prog}<span class="what">${r.step ? `<span class="step">${esc(r.step)}</span>` : ""}${esc(r.now ? nowWords(r.now) : r.step ? "" : "thinking…")}</span>${subs.length ? `<button class="sub-n" data-insp="agents" title="See them in the inspector">${ICON.bot}${subs.length} subagent${subs.length === 1 ? "" : "s"}</button>` : ""}`);
}
/** Plugins' bars above the composer ("session.bar": (row) => html); none on the board, in a view or in a subagent. */
function renderPbar(r) {
  const el = $("pbar");
  if (!el) return;
  const html = r && !S.sub ? deckPlugins.each("session.bar", r).filter(Boolean).join("") : "";
  setHTML(el, html);
  el.hidden = !html;
}
let askTimer = null, askHash = "";
async function renderAsk(r) {
  if (r.app) return renderCodexRequests(r);
  $("askbox")._codexSig = null;
  const el = $("askbox");
  // The same question the list shows (its options, or Approve / Deny for a permission prompt), answerable here too;
  // a blocked agent's live screen and keys stay underneath it.
  const d = pendingAsk(r), blocked = r.status === "blocked";
  const on = (blocked || !!d) && !S.sub && !S.board && (!isPhone() || app.dataset.mview === "detail");
  if (!on) { el.hidden = true; el._card = ""; clearTimeout(askTimer); askTimer = null; askHash = ""; return; }
  if (el.hidden || !el.querySelector(".askcard")) {
    el.hidden = false; el._card = "";
    el.innerHTML = `<div class="askcard"></div><div class="askterm"><pre>…</pre><div class="ks">${["1", "2", "3", "y", "n", "enter", "esc", "up", "down"].map((k) => `<button data-akey="${k}">${k}</button>`).join("")}</div></div>`;
  }
  const card = d ? boardAsk(r) : "";
  if (card !== el._card) { el._card = card; el.querySelector(".askcard").innerHTML = card; }
  el.querySelector(".askterm").hidden = !blocked;
  if (!blocked) { clearTimeout(askTimer); askTimer = null; askHash = ""; return; }
  if (askTimer) return;
  const tick = async () => {
    askTimer = null;
    const cur = rowOf(S.sel);
    if (!cur || cur.status !== "blocked") return;
    try {
      const res = await api("/api/read", { key: cur.key, lines: 40, hash: askHash });
      if (!res.same) { askHash = res.hash; const text = res.text.replace(/\s+$/, "").split("\n").slice(-18).join("\n"); el.querySelector("pre").innerHTML = ansi(text); }
    } catch {}
    askTimer = setTimeout(tick, 1200);
  };
  askTimer = setTimeout(tick, 0);
}
// Answers in the session's own answer box go straight to the agent, like the list's and the board's.
$("askbox").addEventListener("click", async (e) => {
  const box = e.target.closest("[data-rask]");
  if (!box) return;
  const key = box.dataset.rask, d = pendingAsk({ key });
  if (!d) return;
  if (e.target.closest("[data-rreply], [data-ropen]")) return focusReply();
  const pick = e.target.closest("[data-ropt], [data-rdeny]");
  if (!pick) return;
  const o = pick.hasAttribute("data-rdeny") ? permChoices(d).deny : d.options.find((x) => String(x.id) === pick.dataset.ropt);
  if (!o) return;
  box.classList.add("sending");
  try { await answerOption(d, o); toast(`${pick.classList.contains("no") ? "Denied" : pick.classList.contains("yes") ? "Approved" : "Answered"}: ${plain(d.question).slice(0, 60)}`); render(); renderViews(); const cur = rowOf(S.sel); if (cur) renderAsk(cur); }
  catch (x) { box.classList.remove("sending"); toast(x.message, true); }
});
$("appbar").addEventListener("click", (e) => {
  const act = e.target.closest("[data-dact]")?.dataset.dact;
  const r = rowOf(S.sel);
  if (!r || !act) return;
  e.stopPropagation();
  if (act === "histresume") return resumeHist(r);
  if (act === "backhist") return setMode("history");
  if (act === "codexopen") codexAct("codex-open", r);
  if (act === "codexresume") codexAct("codex-resume", r);
  if (act === "codexreconnect") reconnectCodex(r);
  if (act === "codexconnect") reconnectCodex(r, true);
  if (act === "codexhide") codexAct("codex-hide", r);
});
async function codexAct(what, r) {
  try {
    if (what === "codex-open") { await api("/api/codex-open", { key: r.key }); toast("Opened in the Codex app"); }
    if (what === "codex-resume") { const { key } = await api("/api/codex-resume", { key: r.key }); pendingSelect = key; toast("Resuming it in a new herdr tab…"); }
    if (what === "codex-hide") { await api("/api/codex-hide", { key: r.key }); toast("Hidden from the deck. It’s still in the Codex app."); }
  } catch (e) { toast(e.message, true); }
}
$("askbox").addEventListener("click", (e) => {
  const k = e.target.closest("[data-akey]")?.dataset.akey;
  if (k && S.sel) api("/api/keys", { key: S.sel, keys: [k] }).then(() => { askHash = ""; setTimeout(() => chatTick(true), 400); }).catch((x) => toast(x.message, true));
});
function aboutHTML(r, d) {
  const out = [];
  const busy = briefBusy.has(r.key);
  if (d.turnsCount ?? d.turns?.length) {
    const b = d.brief;
    if (b) out.push(`<div class="brief" style="--pc:${pc(r.project)}"><p class="about">${esc(b.about)}</p><div class="cols"><div><h4>How it started</h4><p>${esc(b.started)}</p></div><div><h4>Where it stands</h4><p>${esc(b.now)}</p></div></div>
      <div class="foot">Brief by ${esc(b.model)}, ${agoText(b.at)}${d.briefStale ? " · the session has moved on since" : ""}<button class="link" data-dact="brief" ${busy ? "disabled" : ""}>${busy ? "Writing…" : "Rewrite"}</button></div></div>`);
    else out.push(`<div class="brief pending" style="--pc:${pc(r.project)}"><p class="about">${busy ? "Writing a short brief…" : "No brief yet."}</p><div class="foot">${busy ? "A local model is reading the conversation; nothing leaves your machines." : `<button class="btn" data-dact="brief">Write brief</button><span>Runs locally with Ollama.</span>`}</div></div>`);
  }
  if (d.recap) out.push(`<div class="blk"><h4>${esc(d.recap.source)}</h4><p class="prose">${mdLite(d.recap.text)}</p>${d.recap.at ? `<div class="when">${esc(abs(d.recap.at))}</div>` : ""}</div>`);
  if (d.started) out.push(`<div class="blk"><h4>Your first message <button class="link" data-dact="expand" data-target="startedText">Show all</button></h4><p class="prose clamp" id="startedText">${esc(d.started)}</p><div class="when">${esc(abs(d.startedAt))}</div></div>`);
  if (!out.length) out.push(`<p class="hint">${r.empty ? "Nothing has happened in this pane yet." : "No conversation found for this pane."}</p>`);
  return out.join("");
}
function imagesHTML(r, d) {
  const imgs = [...(d.images ?? [])].reverse();
  S.gallery = imgs.map((im) => ({ ...im, sub: null }));
  return `<p class="hint" style="margin:0 0 10px">${d.imagesTotal} ${d.imagesTotal === 1 ? "image" : "images"}${d.imagesTotal > imgs.length ? `, newest ${imgs.length} shown` : ""}: screenshots you pasted and images the agent looked at.</p>
    <div class="gallery">${imgs.map((im, i) => `<button data-img="${i}"><img loading="lazy" decoding="async" alt="" src="${imgUrl(r.key, im.id)}" onerror="this.parentElement.hidden=true"><span>${im.source === "pasted" ? "you" : "agent"}${im.at ? " · " + esc(DF.format(new Date(im.at))) : ""}</span></button>`).join("")}</div>`;
}
function factsHTML(r, d) {
  const f = [];
  const fact = (k, v, mono) => v != null && v !== "" && f.push(`<dt>${k}</dt><dd${mono ? ' class="mono"' : ""}>${v}</dd>`);
  fact("Project", `${esc(r.project)}${r.projectRoot ? ` <span class="hint mono">${esc(home(r.projectRoot))}</span>` : ""}`);
  fact("Started in", esc(home(r.cwd)), true);
  fact("Command", esc(r.command), true);
  fact("Resume with", esc(r.resume), true);
  fact("Model", esc(r.model));
  fact("Launched via", esc(r.launch));
  fact("Conversation started", (d?.startedAt ?? r.createdAt) ? esc(abs(d?.startedAt ?? r.createdAt)) : "");
  fact("Requests", d?.asks || "");
  fact("Branch", r.branch ? `${esc(r.branch)}${r.dirty ? ` · ${r.dirty} uncommitted` : ""}` : "", true);
  fact("Context", r.ctxTokens != null ? `${tok(r.ctxTokens)} tokens${r.ctxWindow ? ` of ${tok(r.ctxWindow)}` : ""}` : "");
  fact("Agent work", d?.workMs ? dur(d.workMs) : "");
  fact("Compactions", d?.compactions || "");
  fact("Spend", r.cost ? `$${r.cost.toFixed(2)}` : "");
  fact("Memory", `${mem(r.rssKB)} across ${r.procs} processes · CPU ${r.cpu}%`);
  fact("Process started", r.startedAt ? esc(abs(r.startedAt)) : "");
  fact("herdr", `${esc(machineLabel(r.machine))} · ${esc(r.herdr)} · ${esc(r.workspace)} · tab ${esc(r.tabNumber)}${r.tab ? ` “${esc(r.tab)}”` : ""} · ${esc(r.paneId)}`);
  if (r.approx) fact("Note", "Matched to its OpenCode session by folder, so its dates may belong to a neighbour.");
  return `<dl class="facts">${f.join("")}</dl>`;
}
const imgUrl = (key, id, sub) => `/api/image?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}&t=${encodeURIComponent(S.token)}`;

// Home: the live board. Everything working or waiting, at a glance, with pending questions answerable in place.
/** The one-tap answers on a board card: a permission prompt gets Approve / Deny first; questions look like the list's. */
function boardAsk(r) {
  const d = pendingAsk(r);
  if (!d) return "";
  if (d.kind !== "prompt") return rowAsk(r);
  const { approve, deny, rest } = permChoices(d);
  if (!approve) return rowAsk(r);
  const chip = (o) => `<button class="ropt" data-ropt="${esc(o.id)}" title="${esc(o.title)}"><span class="ol">${esc(String(o.id).toUpperCase())}</span>${esc(plain(o.title).slice(0, 44))}${plain(o.title).length > 44 ? "…" : ""}</button>`;
  return `<div class="rask perm" data-rask="${esc(r.key)}"><div class="rq">${esc(plain(d.question))}</div><div class="ropts"><button class="ropt yes" data-ropt="${esc(approve.id)}" title="${esc(approve.title)}">${ICON.check}Approve</button><button class="ropt no" data-rdeny title="${esc(deny.title)}">Deny</button>${rest.slice(0, 3).map(chip).join("")}<button class="ropt ghost" data-rreply>Other…</button></div></div>`;
}
function boardCard(r) {
  const subs = (r.subagents ?? []).filter((x) => x.running);
  const since = r.status === "working" && r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
  const ask = boardAsk(r);
  const tail = (r.tail ?? []).slice(-4).join("\n");
  return `<div class="top"><span class="dot" style="--c:${statusVar(r.status)}"></span><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>${multiMachine() ? `<span class="mach">${esc(machineLabel(r.machine))}</span>` : ""}<span class="spacer"></span><span class="hint">${since ? `<span data-since="${since}">${clock(Date.now() - since)}</span>` : esc(STATUS_NAME[r.status])}</span></div>
      <div class="ti">${esc(r.title || r.agent)} <span class="hint">${paneTag(r)}</span></div>${rowChips(r, "board")}
      ${ask ? "" : r.status === "blocked" ? `<div class="now" style="color:var(--blocked)">${esc(plain(r.tail?.[r.tail.length - 1]) || "waiting for you")}</div>` : r.step || r.now ? `<div class="now">${r.todos?.total ? `<span class="stp">${r.todos.done}/${r.todos.total}</span> ` : ""}${esc(r.step ?? "")}${r.step && r.now ? " · " : ""}${esc(nowWords(r.now))}</div>` : ""}
      ${subs.map((x) => `<div class="now"><span class="spin" style="width:9px;height:9px;border-width:1.5px"></span> ${esc(x.type || "agent")}: ${esc(x.description ?? "")}${x.now ? ` · ${esc(x.now)}` : ""}</div>`).join("")}
      ${ask || (tail.trim() ? `<pre>${ansi(tail)}</pre>` : "")}`;
}
/** Keyed update of one grid of cards: only cards whose content changed are touched; new ones ease in. */
function syncCards(grid, rows, animate) {
  const have = new Map([...grid.children].map((el) => [el.dataset.card, el]));
  let prev = null;
  for (const r of rows) {
    let el = have.get(r.key);
    have.delete(r.key);
    if (!el) { el = document.createElement("div"); el.className = "card" + (animate ? " enter" : ""); el.dataset.card = r.key; }
    if (el.dataset.status !== r.status) el.dataset.status = r.status;
    el.classList.toggle("asks", !!pendingAsk(r));
    setHTML(el, boardCard(r));
    const want = prev ? prev.nextElementSibling : grid.firstElementChild;
    if (want !== el) grid.insertBefore(el, want);
    prev = el;
  }
  for (const el of have.values()) el.remove();
}
function renderBoard() {
  $("dh").hidden = true; $("nowbar").hidden = true; $("askbox").hidden = true; $("composer").hidden = true; $("subcrumb").hidden = true;
  $("statusline").hidden = true; $("appbar").hidden = true; $("jumpBottom").hidden = true;
  $("dbody")._mode = null;
  chatDom.key = null;
  const rows = [...S.rows.values()].filter(inScope);
  const waits = (r) => r.status === "blocked" || !!pendingAsk(r);
  const live = rows.filter((r) => r.status === "working" || waits(r)).sort((a, b) => Number(waits(b)) - Number(waits(a)) || (a.turnStartedAt ?? 0) - (b.turnStartedAt ?? 0));
  const done = rows.filter((r) => unseenDone(r) && !live.includes(r)).sort((a, b) => act(b) - act(a)).slice(0, 12);
  const nWork = live.filter((r) => r.status === "working" && !waits(r)).length, nWait = live.filter(waits).length;
  const box = $("dbody");
  let root = box.firstElementChild;
  const fresh = !root?.hasAttribute("data-home");
  if (fresh) {
    box.innerHTML = `<div class="d-empty" data-home><div class="autos"></div><div class="hh"></div><div class="board" data-bl="live"></div><h4 class="hint bh" hidden>Finished, not looked at yet</h4><div class="board" data-bl="done"></div></div>`;
    root = box.firstElementChild;
    box.scrollTop = 0;
  }
  setHTML(root.querySelector(".hh"), `<h2>${live.length ? `${nWork} working, ${nWait} waiting for you` : "Nothing running right now"}</h2><p>${live.length ? `Live. ${nWait ? "Answer right here, or click" : "Click"} a card to open it.` : "Pick a session, press ⌘K to find anything, or n to start one."}</p>${live.length ? "" : `<p><button class="btn primary" data-dact="new">New session</button></p>`}`);
  setHTML(root.querySelector(".autos"), autoCards());
  syncCards(root.querySelector('[data-bl="live"]'), live, !fresh);
  syncCards(root.querySelector('[data-bl="done"]'), done, !fresh);
  root.querySelector(".bh").hidden = !done.length;
  bodySig = "board"; headSig = "";
  setHTML($("mTitle"), "Live board");
}
// Answers on board cards go straight to the agent; the rest of the card opens the session.
$("dbody").addEventListener("click", async (e) => {
  const box = e.target.closest(".card [data-rask]");
  if (!box) return;
  e.stopPropagation();
  const key = box.dataset.rask, d = pendingAsk({ key });
  if (!d) return;
  const pick = e.target.closest("[data-ropt], [data-rdeny]");
  if (pick) {
    const o = pick.hasAttribute("data-rdeny") ? permChoices(d).deny : d.options.find((x) => String(x.id) === pick.dataset.ropt);
    if (!o) return;
    box.classList.add("sending");
    try { await answerOption(d, o); toast(`${pick.classList.contains("no") ? "Denied" : pick.classList.contains("yes") ? "Approved" : "Answered"}: ${plain(d.question).slice(0, 60)}`); render(); renderViews(); }
    catch (x) { box.classList.remove("sending"); toast(x.message, true); }
    return;
  }
  if (e.target.closest("[data-rreply], [data-ropen]")) { select(key, { scroll: true, open: true }); if (e.target.closest("[data-rreply]")) focusReply(); return; }
  select(key, { scroll: true, open: true });
}, true);

const briefBusy = new Set();
async function writeBrief(key = S.sel, auto = false) {
  if (!key || briefBusy.has(key)) return;
  briefBusy.add(key);
  bodySig = ""; renderDetail();
  try {
    const { brief } = await api("/api/brief", { key });
    const c = S.details.get(key);
    if (c) c.data = { ...c.data, brief, briefStale: false };
  } catch (e) { if (!auto) toast("Brief failed: " + e.message, true); }
  briefBusy.delete(key);
  bodySig = ""; renderDetail();
}

// ── status line: project, context, the account and its limits ──────────────────────────────
function meter(pct, label, title, resets, extra, more = "") {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const cls = `${p >= 80 ? "hot" : p >= 50 ? "warm" : ""} ${more}`.trim(); // the terminal status line's colours
  return `<span class="meter ${cls}" title="${esc(title)}${resets ? ` · resets ${esc(inText(resets))}` : ""}"><span class="ml">${esc(label)}</span><span class="mb"><i style="width:${p}%"></i></span><b>${p}%</b>${extra ? `<span class="mx">${esc(extra)}</span>` : ""}</span>`;
}
function inText(t) { const ms = t - Date.now(); if (ms <= 0) return "now"; const h = Math.floor(ms / 3600_000), m = Math.round((ms % 3600_000) / 60_000); return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `in ${h}h ${m}m` : `in ${m}m`; }
function renderStatusLine(r) {
  const el = $("statusline");
  if (!el) return;
  if (!r || r.hist || S.sub || S.mode || S.board) { el.hidden = true; return; }
  el.hidden = false;
  // The project and branch are in the header, the model on its chip in the message box (model-chip.js): here only
  // what's being used up.
  const parts = [];
  const cx = isAgent(r) ? ctxInfo(r) : null;
  if (cx?.pct != null) parts.push(meter(cx.pct, "context", `${tok(cx.tokens)} of ${tok(cx.window)} tokens in context${cx.guessed ? " (window size guessed from the model)" : ""}`, null, tok(cx.tokens)));
  else if (cx) parts.push(`<span class="meter" title="${esc(`${cx.tokens.toLocaleString()} tokens in context; this model’s window size isn’t known`)}"><span class="ml">context</span><b>${tok(cx.tokens)}</b><span class="mx">tokens</span></span>`);
  parts.push(...usageParts(r)); // usage.js: the account this session spends and its limits
  if (r.agent === "opencode" && r.cost) parts.push(`<span class="meter" title="What this OpenCode session has cost so far"><span class="ml">spent</span><b>$${r.cost.toFixed(2)}</b></span>`);
  el.hidden = !parts.length;
  setHTML(el, parts.join(""));
  motion.bars(el); // meters glide to their new value (and between sessions)
}
