"use strict";
// The keyboard as data: every shortcut the deck answers, where it applies and what it does. input.js runs these,
// and the "?" sheet and ⌘K's key hints are built from them (plus plugins' keys), so the help can't drift from the
// real bindings. An entry without `run` is handled elsewhere (the palette, the composer, Decisions) and only listed.
const cursel = () => (S.sel && S.rows.has(S.sel) ? S.sel : null);
// ── keymap (data) ── test/keymap.test.ts evaluates this block on its own: no key bound twice, Decisions match inboxKey().
const DECK_KEYS = [
  { sec: "Anywhere", keys: ["⌘K"], label: "Search everything, run any command" },
  { sec: "Anywhere", id: "filter", keys: ["/"], label: "Filter the list", run: () => { if (app.classList.contains("list-off")) $("listToggle").click(); $("q").focus(); $("q").select(); } },
  { sec: "Anywhere", id: "next", keys: ["j", "ArrowDown"], label: "Next session", run: () => moveSel(1) },
  { sec: "Anywhere", id: "prev", keys: ["k", "ArrowUp"], label: "Previous session", run: () => moveSel(-1) },
  { sec: "Anywhere", id: "needs", keys: ["J"], label: "Next session waiting on you", run: () => nextNeedsMe() },
  { sec: "Anywhere", id: "new", keys: ["n"], label: "New session", run: () => openNew() },
  { sec: "Anywhere", id: "machine", keys: [..."123456789"], label: "Switch machine (1 is All)", run: (e) => { const ids = ["all", ...(S.summary.machines ?? []).map((m) => m.id)]; if (ids[e.key - 1] && ids.length > 2) setMachine(ids[e.key - 1]); } },
  { sec: "Anywhere", id: "undo", keys: ["⌘Z"], label: "Undo a close, rename or skip while its toast shows" },
  { sec: "Anywhere", id: "help", keys: ["?"], label: "Keyboard shortcuts (this list)", run: () => openKeys() },
  { sec: "Anywhere", id: "esc", keys: ["Escape"], label: "Back: picked messages, the view, the filter, the selection, then home", run: () => escBack() },

  { sec: "The selected session", id: "chatfind", keys: ["⌘F"], when: () => cursel(), label: "Search its chat (while the chat has focus): Enter / ⇧Enter step, Esc closes" },
  { sec: "The selected session", id: "reply", keys: ["r"], when: () => cursel(), label: "Write it a message (start with ! to run a shell command)", run: () => focusReply() },
  { sec: "The selected session", id: "tools", keys: ["."], when: () => cursel() || S.picked.size, label: "Tools for it, or for the selection", run: () => openToolMenu(document.querySelector('[data-dact="tools"]') ?? $("cRecipe")) },
  { sec: "The selected session", id: "term", keys: ["t"], when: () => cursel(), label: "Type straight into its terminal, in the inspector (Ctrl+] to stop)", run: () => focusTerminal() },
  { sec: "The selected session", id: "focus", keys: ["f"], when: () => cursel(), label: "Switch herdr to it (a Codex app thread opens in the app)", run: () => { const r = rowOf(cursel()); r?.app ? codexAct("codex-open", r) : focusPane(r.key); } },
  { sec: "The selected session", id: "link", keys: ["y"], when: () => cursel(), label: "Copy a link to it", run: () => copy(linkUrl(rowOf(cursel())), "link") },
  { sec: "The selected session", id: "resume", keys: ["Y"], when: () => cursel(), label: "Copy its resume command", run: () => { const r = rowOf(cursel()); r.resume ? copy(r.resume, "resume command") : toast("This session has no resume command yet", true); } },
  { sec: "The selected session", id: "rename", keys: ["e"], when: () => { const r = rowOf(cursel()); return r && !r.app && !r.hist; }, label: "Rename it", run: () => renameSession(rowOf(cursel())) },
  { sec: "The selected session", id: "brief", keys: ["b"], when: () => cursel(), label: "Write or rewrite its brief", run: () => writeBrief(cursel()) },
  { sec: "The selected session", id: "workers", keys: ["w"], when: () => cursel(), label: "Show or hide the workers it dispatched (on a worker: its dispatcher’s)", run: () => toggleTreeSel() },
  { sec: "The selected session", id: "parent", keys: ["p"], when: () => cursel(), label: "Open the session that dispatched this worker", run: () => gotoTreeParent() },
  { sec: "The selected session", id: "pick", keys: ["s"], when: () => cursel(), label: "Add it to the selection (or ⌘-click a row)", run: () => togglePick(cursel()) },
  { sec: "The selected session", id: "pickall", keys: ["A"], label: "Select every session the list shows (again: clear)", run: () => pickAllShown() },
  { sec: "The selected session", id: "close", keys: ["x"], when: () => cursel() || S.picked.size, label: "Close it or the selection (asks first, then offers Undo)", run: () => askClose(targets()) },

  { sec: "Views", id: "inbox", keys: ["i"], label: "Decisions: everything waiting on you", run: () => setMode(S.mode === "inbox" ? null : "inbox") },
  { sec: "Views", id: "history", keys: ["h"], label: "History: search every past session", run: () => { setMode(S.mode === "history" ? null : "history"); if (S.mode === "history") focusHistSearch(); } },
  { sec: "Views", id: "usage", keys: ["U"], label: "Usage: every AI account’s limits and balance", run: () => setMode(S.mode === "usage" ? null : "usage") },
  { sec: "Views", id: "board", keys: ["l"], label: "Live board: everything working right now", run: () => setBoard(!S.board) },
  { sec: "Views", id: "closed", keys: ["c"], label: "Closed sessions, to reopen one", run: () => { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); } },
  { sec: "Views", id: "group", keys: ["g"], label: "Switch between folders, priority and projects", run: () => setGroup(S.group === "folders" ? "priority" : S.group === "priority" ? "project" : "folders") },
  { sec: "Views", id: "foldAll", keys: ["G"], when: () => S.group === "project", label: "Collapse or expand every project (grouped by project)", run: () => foldAllProjects() },

  { sec: "Layout", id: "list", keys: ["["], label: "Collapse the list", run: () => $("listToggle").click() },
  { sec: "Layout", id: "insp", keys: ["]", "\\"], label: "Show or hide the inspector: terminal, subagents, servers", run: () => toggleInspector() },
  { sec: "Layout", id: "itab", keys: ["`"], when: () => cursel(), label: "Next inspector tab (opens it)", run: () => inspNextTab() },

  { sec: "Message box", keys: ["Enter"], label: "Send (on a phone, a new line)" },
  { sec: "Message box", keys: ["⇧Enter"], label: "New line" },
  { sec: "Message box", keys: ["⌥Enter"], label: "Queue it for when the agent finishes this turn" },
  { sec: "Message box", keys: ["⌘C"], label: "Copy the messages you picked in the chat" },
  { sec: "Message box", keys: ["Escape"], label: "Leave the box" },
];
/** Decisions (i): run by inboxKeydown() and inboxKey(), listed here for the sheet. */
const INBOX_KEYS = [
  { keys: ["j", "k", "ArrowDown", "ArrowUp"], label: "Next / previous decision" },
  { keys: ["1–9"], label: "Pick that option on the focused card" },
  { keys: ["y"], label: "Yes: the allow / yes / recommended option; on finished work, Looks good" },
  { keys: ["n"], label: "No: the deny / no option; on finished work, Send back (prefilled)" },
  { keys: ["v"], label: "Verify now (finished work)" },
  { keys: ["r"], label: "Reply in your own words (Enter sends, Esc closes)" },
  { keys: ["o", "Enter"], label: "Open the session" },
  { keys: ["s", "x"], label: "Skip it for now without answering" },
  { keys: ["u"], label: "Bring back the last skipped one" },
  { keys: ["f", "F"], label: "Next / previous filter (All, Quick ones, Permissions, Questions, Done?)" },
  { keys: ["Escape"], label: "Close the reply box, then leave Decisions" },
];
// ── end keymap
const KEY_NAME = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };
const keyName = (k) => KEY_NAME[k] ?? k;
/** The binding a key press runs now, or undefined. */
const keyBinding = (k) => DECK_KEYS.find((b) => b.run && b.keys.includes(k) && (!b.when || b.when()));
/** Every key the core answers: plugins can't take these (registry.js). */
const coreKeys = () => new Set([...DECK_KEYS.flatMap((b) => b.keys), "Enter", "ArrowLeft", "ArrowRight"]);
/** The key hint for a command id, for ⌘K. */
function keyOf(id) { const b = DECK_KEYS.find((x) => x.id === id); return b ? keyName(b.keys[0]) : ""; }

/** Esc, innermost first (escAction in core.js decides). */
function escBack() {
  const a = escAction({ chatPicks: chatSel.size, mode: S.mode, sub: S.sub, q: S.q, picked: S.picked.size, sel: S.sel && rowOf(S.sel) ? S.sel : null, board: S.board });
  if (a === "picks") clearPicks();
  else if (a === "mode") setMode(null);
  else if (a === "sub") { S.sub = null; headSig = ""; chatDom.key = null; renderDetail(); chatTick(true); }
  else if (a === "search") { S.q = ""; S.deep = null; $("q").value = ""; render(); }
  else if (a === "picked") { S.picked.clear(); render(); }
  else if (a === "home") goHome();
}

// ── the "?" sheet: DECK_KEYS, the Decisions keys and plugins' keys, searchable ──
function keySheetRows() {
  const groups = new Map();
  const add = (sec, keys, label) => { if (!groups.has(sec)) groups.set(sec, []); groups.get(sec).push({ keys, label }); };
  for (const b of DECK_KEYS) add(b.sec, b.id === "machine" ? ["1–9"] : b.keys.map(keyName), b.label);
  for (const b of INBOX_KEYS) add("Decisions (i)", b.keys.map(keyName), b.label);
  for (const p of deckPlugins.keyList()) add("Plugins", [p.key], p.label);
  return groups;
}
function renderKeySheet(q = "") {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // A single key typed matches that key exactly ("x" finds Close, not every label with an x in it).
  const hit = (r) => words.length === 1 && words[0].length === 1 ? r.keys.some((k) => k.toLowerCase() === words[0]) : words.every((w) => r.label.toLowerCase().includes(w));
  const html = [...keySheetRows()].map(([sec, rows]) => {
    const shown = rows.filter(hit);
    return shown.length ? `<h4>${esc(sec)}</h4><table>${shown.map((r) => `<tr><td>${r.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(" ")}</td><td>${esc(r.label)}</td></tr>`).join("")}</table>` : "";
  }).join("");
  $("keysList").innerHTML = html || `<p class="hint">No shortcut matches “${esc(q)}”.</p>`;
}
function openKeys() {
  $("keysQ").value = "";
  renderKeySheet();
  if (!$("help").open) $("help").showModal();
  if (!isPhone()) $("keysQ").focus();
}
$("keysQ").addEventListener("input", (e) => renderKeySheet(e.target.value));
// Esc clears the search first, then closes the sheet.
$("keysQ").addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.value) { e.preventDefault(); e.target.value = ""; renderKeySheet(); } });

// ── small power moves ──
/** The next session with a decision waiting on you (Decisions' order), after the selected one; wraps around. */
function nextNeedsMe() {
  const keys = (S.decisions ?? []).filter((d) => !answered(d)).map((d) => d.key).filter((k, i, a) => rowOf(k) && a.indexOf(k) === i);
  if (!keys.length) return toast("Nothing is waiting on you");
  const k = keys[(keys.indexOf(S.sel) + 1) % keys.length];
  if (S.mode) setMode(null);
  if (!inScope(rowOf(k))) setMachine("all");
  select(k, { scroll: true, open: isPhone() }); // desktop: the keyboard stays on the list, so J J J walks them (r to reply)
  toast(keys.length > 1 ? `${keys.indexOf(k) + 1} of ${keys.length} waiting on you · J for the next` : "The only one waiting on you");
}
/** A: every live session the list shows joins the selection; again, with all of them picked, clears it. */
function pickAllShown() {
  const keys = (S.visible ?? []).filter((r) => !r.app && !r.hist).map((r) => r.key);
  if (!keys.length) return toast("No sessions shown to select");
  const all = keys.every((k) => S.picked.has(k));
  S.picked = all ? new Set() : new Set(keys);
  render();
  toast(all ? "Selection cleared" : `Selected ${keys.length} · x closes them, . runs a tool, Esc clears`);
}
function focusHistSearch() { if (!isPhone()) requestAnimationFrame(() => $("hq")?.focus()); }
