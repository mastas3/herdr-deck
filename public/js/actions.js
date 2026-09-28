"use strict";
// Actions on sessions (close, jump, pick, rename, the board) and the Tools menu.
// ── actions ──────────────────────────────────────────────────────────────
const targets = () => (S.picked.size ? [...S.picked] : S.sel ? [S.sel] : []);

function askClose(keys) {
  const all = keys.map((k) => rowOf(k)).filter(Boolean);
  const apps = all.filter((r) => r.app);
  if (apps.length && apps.length === all.length) return toast(apps.length === 1 ? "Codex app threads can’t be closed from here. Use Hide in its ⋯ menu." : "Codex app threads can’t be closed from here; use Hide on each.");
  const rows = all.filter((r) => !r.app);
  if (!rows.length) return toast("Nothing to close");
  const d = $("confirm");
  const busy = rows.filter((r) => r.status === "working" || r.status === "blocked");
  const dirty = rows.filter((r) => r.dirty);
  const noResume = rows.filter((r) => !r.resume && !r.empty);
  const subs = rows.reduce((n, r) => n + (r.subagents ?? []).filter((x) => x.running).length, 0);
  $("cTitle").textContent = rows.length === 1 ? `Close “${rows[0].title || rows[0].agent}”?` : `Close ${rows.length} sessions?`;
  $("cWarn").innerHTML = [
    busy.length ? `<span class="warn">${busy.length === 1 && rows.length === 1 ? "It is" : busy.length + " are"} working or waiting for you right now.</span>` : "",
    subs ? `<span class="warn">${subs} subagent${subs === 1 ? " is" : "s are"} still running.</span>` : "",
    dirty.length ? `<span class="warn">${dirty.length === 1 && rows.length === 1 ? "Its folder has" : dirty.length + " have folders with"} uncommitted changes (they stay on disk).</span>` : "",
  ].filter(Boolean).join(" ");
  $("cList").innerHTML = rows.map((r) => `<div><span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.title || r.agent)}</span><span class="m">${esc(r.project)} · ${paneTag(r)}${multiMachine() ? " · " + esc(machineLabel(r.machine)) : ""} · ${r.lastActiveAt ? agoText(r.lastActiveAt) : "no activity"} · ${mem(r.rssKB)}</span></div>`).join("");
  $("cNote").innerHTML = `Frees about <b>${mem(rows.reduce((s, r) => s + r.rssKB, 0))}</b>. ` + (noResume.length ? `<span class="warn">${noResume.length} can’t be resumed.</span> ` : "") + `Closed agent sessions can be reopened from Closed.`;
  $("cWholeWrap").hidden = !rows.some((r) => r.tabPanes > 1);
  $("cWhole").checked = false;
  $("cOk").textContent = rows.length === 1 ? "Close" : `Close ${rows.length}`;
  d.returnValue = "";
  d.onclose = () => { if (d.returnValue === "ok") closeKeys(rows.map((r) => r.key), $("cWhole").checked); };
  d.showModal();
  $("cOk").focus();
}
/** Closes now: the rows dim at once, the toast says what's happening, and Undo reopens what was closed. */
async function closeKeys(keys, wholeTab) {
  const dim = (on) => { for (const k of keys) rowCache.get(k)?.el.classList.toggle("closing", on); };
  const title = rowOf(keys[0])?.title || rowOf(keys[0])?.agent || "the session"; // before the row goes
  dim(true);
  toast(keys.length === 1 ? "Closing…" : `Closing ${keys.length} sessions…`);
  try {
    const { results } = await api("/api/close", { keys, wholeTab });
    const failed = results.filter((x) => !x.ok), graves = results.flatMap((x) => x.graves ?? []);
    for (const x of results) if (x.ok) S.picked.delete(x.key);
    for (const x of failed) rowCache.get(x.key)?.el.classList.remove("closing");
    setTimeout(() => dim(false), 4000); // herdr's next state drops them; a row still here by then isn't dimmed forever
    const ok = results.length - failed.length;
    if (failed.length) toast(`Closed ${ok}; ${failed.length} failed: ${failed[0].error}`, true, { label: "Retry", run: () => closeKeys(failed.map((x) => x.key), wholeTab) });
    else toast(ok === 1 ? `Closed “${title}”` : `Closed ${ok}`, false, graves.length ? { label: "Undo", run: () => reopenGraves(graves) } : undefined);
    render();
  } catch (e) { dim(false); toast("Close failed: " + e.message, true, { label: "Retry", run: () => closeKeys(keys, wholeTab) }); }
}
async function reopenGraves(ids) {
  toast(ids.length === 1 ? "Reopening…" : `Reopening ${ids.length} sessions…`);
  const res = await Promise.allSettled(ids.map((id) => api("/api/reopen", { id })));
  const bad = res.filter((x) => x.status === "rejected");
  if (bad.length) toast(`Reopened ${ids.length - bad.length}; ${bad.length} failed: ${bad[0].reason?.message}. They’re in Closed (c).`, true);
  else toast(ids.length === 1 ? "Reopened" : `Reopened ${ids.length}`);
}
async function focusPane(key) { try { await api("/api/focus", { key, raise: true }); toast("Switched herdr to this pane"); } catch (e) { toast("Couldn’t switch: " + e.message, true, { label: "Retry", run: () => focusPane(key) }); } }
/** One message to every selected agent session (the same path as the message box, one send each). */
async function messagePicked() {
  const rows = targets().map(rowOf).filter((r) => r && isAgent(r) && !r.app && !r.hist);
  if (!rows.length) return toast("None of the selected sessions can take a message", true);
  const text = (await askDialog({ title: `Message ${rows.length} sessions`, text: rows.map((r) => `• ${r.title || r.agent} (${r.project})`).join("\n"), input: "", ok: "Send", multiline: true }))?.trim();
  if (!text) return;
  toast(`Sending to ${rows.length}…`);
  const res = await Promise.allSettled(rows.map((r) => api("/api/send", { key: r.key, text })));
  const bad = rows.filter((_, i) => res[i].status === "rejected");
  if (bad.length) toast(`Sent to ${rows.length - bad.length}; ${bad.length} failed: ${res.find((x) => x.status === "rejected").reason?.message}`, true);
  else toast(`Sent to ${rows.length} sessions`);
}
function togglePick(key) { S.picked.has(key) ? S.picked.delete(key) : S.picked.add(key); render(); }
function moveSel(d) {
  const rows = S.visible ?? [];
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.key === S.sel);
  i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + d));
  select(rows[i].key, { scroll: true });
}
function openSub(id) {
  S.sub = id; S.tab = "chat"; store("tab2", "chat");
  headSig = ""; bodySig = ""; chatDom.key = null;
  renderDetail();
  chatTick(true);
}
function setBoard(on) { S.board = on; if (on) S.mode = null; headSig = ""; bodySig = ""; if (on && isPhone()) setMView("detail", true); render(); syncUrl(); if (!on) chatTick(true); }
/** Home is the live board: what's running and what's waiting on you, answerable in place. */
function goHome() { if (!S.board || S.mode) setBoard(true); }

// ── rename: the herdr pane, and the agent's own /rename ──────────────────
async function renameSession(r) {
  if (!r || r.app || r.hist) return;
  const agentName = r.agent === "claude" ? "Claude Code" : r.agent === "codex" ? "Codex" : null;
  const label = await askDialog({ title: "Rename session", text: `Renames the herdr pane${r.tabPanes <= 1 ? " and tab" : ""}${agentName ? `, and runs /rename in ${agentName} so its own history shows the name too` : ""}.`, input: r.title || r.tab || "", ok: "Rename" });
  if (label == null || !label.trim()) return;
  applyRename(r, label.trim(), r.title || r.tab || "");
}
/** The new name shows at once; the next state from herdr confirms it. Undo renames it back the same way. */
async function applyRename(r, label, before) {
  const agentName = r.agent === "claude" ? "Claude Code" : r.agent === "codex" ? "Codex" : null;
  const live = () => rowOf(r.key);
  if (live()) { live().title = label; headSig = ""; render(); if (S.sel === r.key) renderDetail(); }
  const undo = before && before !== label ? { label: "Undo", run: () => applyRename(live() ?? r, before, label) } : undefined;
  try {
    const res = await api("/api/rename", { key: r.key, label });
    if (res.slash) {
      if (res.busy) { await api("/api/queue", { op: "add", key: r.key, text: res.slash }); toast(`Renamed to “${label}”. ${agentName} gets /rename when it finishes this turn.`, false, undo); }
      else { await api("/api/send", { key: r.key, text: res.slash }); toast(`Renamed to “${label}”`, false, undo); }
    } else toast(`Renamed to “${label}”`, false, undo);
    headSig = "";
  } catch (x) {
    if (live()) { live().title = before; headSig = ""; render(); }
    toast("Rename failed: " + x.message, true, { label: "Retry", run: () => applyRename(r, label, before) });
  }
}

// ── close candidates, a stand-up, grouping, the terminal ─────────────────
function suggestClose() {
  const WEEK = 7 * 86400000;
  const old = (r) => r.lastActiveAt && Date.now() - r.lastActiveAt > WEEK;
  const c = [...S.rows.values()].filter(inScope).filter((r) => !r.app && (r.empty || r.duplicate || old(r)) && r.status !== "working" && r.status !== "blocked");
  const seen = new Set(), pick = [];
  for (const r of c.sort((a, b) => act(b) - act(a))) {
    const id = r.duplicate && `${r.machine}:${r.agent}:${r.sessionId}`;
    if (id && !seen.has(id) && !old(r) && !r.empty) { seen.add(id); continue; }
    pick.push(r.key);
  }
  S.picked = new Set(pick);
  S.closedSecs = { ...S.closedSecs, stale: false, empty: false };
  lastOrder = "";
  toast(pick.length ? `Selected ${pick.length}. Review them, then Close.` : "Nothing looks safe to close");
  render();
}
async function standup() {
  const rows = [...S.rows.values()].filter(inScope).filter((r) => isAgent(r) && !r.app && (r.status === "idle" || r.status === "done") && !r.empty && !r.stale);
  if (!rows.length) return toast("No idle agents to ask");
  const tool = S.tools.find((x) => x.id === "status");
  if (tool) await runTool(tool, rows.map((r) => r.key));
}
function setGroup(g) { S.group = g; store("group", g); lastOrder = ""; render(); }
function focusTerminal() {
  if (S.tpos === "none") showTerminal();
  if (S.tpos === "tab") setMain("term");
  else if (app.classList.contains("term-off")) { app.classList.remove("term-off"); store("termOff", false); }
  $("screen").focus();
}

// ── tools (replace recipes) ──────────────────────────────────────────────
const TI2 = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
Object.assign(ICON, {
  globe: TI2('<circle cx="8" cy="8" r="5.8"/><path d="M2.3 8h11.4M8 2.2c1.7 1.7 2.4 3.6 2.4 5.8S9.7 12.1 8 13.8C6.3 12.1 5.6 10.2 5.6 8S6.3 3.9 8 2.2"/>'),
  mail: TI2('<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/>'),
  history: TI2('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.8v2.6h2.6M8 5v3.2l2.2 1.3"/>'),
  clip: TI2('<path d="m13 7.5-5.2 5.2a3.2 3.2 0 0 1-4.5-4.5L8.8 2.7a2.1 2.1 0 0 1 3 3L6.4 11.1a1 1 0 0 1-1.5-1.5L9.8 4.7"/>'),
  compact: TI2('<path d="M3 3h10M3 13h10M8 5v6M5.5 7 8 4.5 10.5 7M5.5 9 8 11.5 10.5 9"/>'),
  pulse: TI2('<path d="M1.5 8.5h3l1.5-4 3 8 1.8-4.5h3.7"/>'),
  book: TI2('<path d="M3 2.8h6.5A2.5 2.5 0 0 1 12 5.3v8H5.5A2.5 2.5 0 0 1 3 10.8z"/><path d="M3 10.8a2.5 2.5 0 0 1 2.5-2.5H12"/>'),
  note: TI2('<path d="M4 2.5h5.5L12.5 5.5v8H4z"/><path d="M9.5 2.5v3h3M6 8.5h4.5M6 11h3"/>'),
  check: TI2('<path d="m3 8.5 3 3 7-7.5"/>'),
  flask: TI2('<path d="M6 2.5h4M6.8 2.5v4L3.2 12a1 1 0 0 0 .9 1.5h7.8a1 1 0 0 0 .9-1.5L9.2 6.5v-4"/>'),
  eye: TI2('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  inbox: TI2('<path d="M2 9.5 3.8 3.5h8.4L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>'),
  plug: TI2('<path d="M6 2v3.5M10 2v3.5M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>'),
  tools: TI2('<path d="M9.8 3.2a3 3 0 0 0-3.9 3.9L2.5 10.5a1.4 1.4 0 0 0 2 2l3.4-3.4a3 3 0 0 0 3.9-3.9L10 7l-1.9-.4L7.8 4.8z"/>'),
  back2: TI2('<path d="M6.5 4 2.5 8l4 4M3 8h10.5"/>'),
});
const TOOL_ICON = { mail: "mail", history: "history", clip: "clip", compact: "compact", pulse: "pulse", back: "back2", book: "book", note: "note", check: "check", flask: "flask", eye: "eye", globe: "globe", play: "play", star: "star" };
const toolGlyph = (t) => ICON[TOOL_ICON[t.icon] ?? "star"] ?? ICON.star;

/** Runs a tool on sessions: a prompt or sequence goes to the agents; actions run in the deck. */
async function runTool(tool, keys = targets()) {
  if (tool.action === "upload") return pickFiles();
  const rows = keys.map((k) => rowOf(k)).filter((r) => r && !r.hist);
  const agentRows = rows.filter((r) => !r.app && isAgent(r) && (!tool.agents || tool.agents.includes(r.agent)));
  if (tool.action === "share") { const r = rows[0]; return r ? shareRow(r) : toast("Pick a session first", true); }
  if (tool.action === "verify") { const r = rows[0]; return r ? verifyRow(r, true) : toast("Pick a session first", true); }
  if (!agentRows.length) return toast(rows.some((r) => r.app) ? "Codex app threads can’t take messages from the deck" : "No agent session to use that on", true);
  if (agentRows.length > 1 && !(await askDialog({ title: `${tool.label} on ${agentRows.length} sessions?`, text: agentRows.map((r) => `• ${r.title} (${r.project})`).join("\n"), ok: "Send" }))) return;
  try {
    const { results } = await api("/api/tool", { id: tool.id, keys: agentRows.map((r) => r.key) });
    const bad = results.filter((x) => !x.ok);
    toast(bad.length ? `${tool.label}: ${results.length - bad.length} ok, ${bad.length} failed (${bad[0].error})` : tool.kind === "sequence" ? `${tool.label}: step 1 sent; step 2 follows when it’s done` : `${tool.label}: sent${agentRows.length > 1 ? ` to ${agentRows.length} sessions` : ""}`, !!bad.length);
    setTimeout(() => { pollTerm(); chatTick(true); }, 300);
  } catch (e) { toast(e.message, true); }
}
function openToolMenu(anchor, compact) {
  const n = targets().length;
  const cell = (icon, label, hint, run) => ({ html: `<span class="tg">${icon}</span><span class="tl2">${esc(label)}</span>`, title: hint, run });
  const items = S.tools.filter((t) => t.action !== "upload").map((t) => cell(toolGlyph(t), t.label, t.hint ?? "", () => runTool(t)));
  // Cells plugins add ("tools.menu": { icon, label, hint, run(sel) }), e.g. Connections.
  const extra = deckPlugins.contributions("tools.menu").map((c) => cell(c.icon ?? "", c.label, c.hint ?? "", () => c.run(S.sel)));
  items.push("-", ...extra,
    cell(ICON.clip, "Attach files", "Or drop / paste them into the chat", pickFiles),
    cell(ICON.tools, "Manage tools", "What each tool sends; add your own", () => setMode("tools")));
  openMenu(anchor, items, n > 1 ? `Tools for ${n} selected sessions` : "Tools", compact ? "grid up" : "grid");
}
