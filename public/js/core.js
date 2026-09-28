"use strict";
// herdr deck client. State arrives inlined in the page (window.__BOOT__), then as row patches over SSE.
// The session pane is a chat: the whole conversation, live, with a composer that talks to the agent.

// ── state ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function store(k, v) { try { localStorage.setItem("deck:" + k, JSON.stringify(v)); } catch {} }
function load(k, d) { try { const v = localStorage.getItem("deck:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
/** Live rows, plus past sessions opened from History (kept out of the live list). */
const rowOf = (k) => S.rows.get(k) ?? S.hrows.get(k);

// ── detail-pane logic (pure: no DOM, no S) ── test/detail.test.ts evaluates this block on its own.
const TABS = ["chat", "agents", "about", "images", "info"];
/** The tab the detail pane really shows: a tab with nothing in it (and simple mode) falls back to Chat. */
function effTab(tab, d, simple) {
  if (simple || !TABS.includes(tab)) return "chat";
  if (tab === "images" && !d?.imagesTotal) return "chat";
  if (tab === "agents" && !d?.subagents?.length) return "chat";
  return tab;
}
/** Opening a different session always starts on Chat; re-rendering the same one keeps its tab. */
const tabAfterSelect = (prevKey, key, tab) => (prevKey === key ? tab : "chat");
/** What Esc does, innermost first: picked messages, an open view, a subagent, the search, a selection, then home. */
function escAction(s) {
  if (s.chatPicks) return "picks";
  if (s.mode) return "mode";
  if (s.sub) return "sub";
  if (s.q) return "search";
  if (s.picked) return "picked";
  if (s.sel && !s.board) return "home";
  return null;
}
/** A permission prompt as Approve / Deny plus whatever other options it has. Deny falls back to Esc. */
function permChoices(d) {
  const t = (o) => String(o.title ?? "").replace(/[*_`]/g, "").trim();
  const approve = d.options.find((o) => /^(yes|allow|approve|proceed|confirm|continue|trust)\b/i.test(t(o))) ?? null;
  const deny = d.options.find((o) => o !== approve && /^(no|deny|reject|cancel|don.?t|exit)\b/i.test(t(o))) ?? { id: "esc", title: "Deny (Esc)", keys: ["esc"], synthetic: true };
  return { approve, deny, rest: d.options.filter((o) => o !== approve && o !== deny) };
}
/** Context use for the status line. A percentage only when the window is known (or a safe guess for Claude/Codex). */
function ctxInfo(r) {
  if (r?.ctxTokens == null) return null;
  let win = r.ctxWindow || null;
  if (!win && r.agent === "claude") win = /\[1m\]|1m/i.test(r.model ?? "") || r.ctxTokens > 200_000 ? 1_000_000 : 200_000;
  if (!win && r.agent === "codex") win = 272_000;
  return { tokens: r.ctxTokens, window: win, pct: win ? Math.min(100, (r.ctxTokens / win) * 100) : null, guessed: !r.ctxWindow && !!win };
}
/** The proof-of-done chip: class, label and what it does. */
function checkInfo(c, project) {
  if (!c || c.state === "skipped") return null;
  const cmd = c.cmd ? `\`${c.cmd}\`` : "the project’s checks";
  const map = {
    "needs-approval": ["ask", "Verify it’s done", `Proof of done: runs ${cmd} in ${project || "the project"}’s folder to check the agent’s work really passes. You approve the command once per project.`],
    pass: ["ok", "✓ Checks pass", `Proof of done: ${cmd} passed. Click to see the output, run it again or change it.`],
    fail: ["bad", "✗ Checks fail", `Proof of done: ${cmd} failed${c.exit != null ? ` (exit ${c.exit})` : ""}. Click to see the output, run it again or change it.`],
    running: ["run", "Checking…", `Proof of done: running ${cmd} now.`],
    queued: ["run", "Check queued", `Proof of done: ${cmd} runs next.`],
    error: ["bad", "Check error", `Proof of done: ${cmd} couldn’t run.`],
  };
  const m = map[c.state];
  return m ? { cls: m[0], label: m[1], tip: m[2] } : null;
}
const dirtyText = (n) => (n ? `${n} uncommitted` : "");
// ── end detail-pane logic
const S = {
  token: "", self: "", rows: new Map(), hrows: new Map(), summary: { herdr: [], machines: [] }, graveyard: [], tools: [], toolGroups: {},
  mode: null, usage: {}, hist: {}, decisions: [], jev: {}, canShare: false, done: new Map(),
  machine: load("machine", "all"), q: "", sel: null, picked: new Set(), view: "inbox", group: load("group", "priority") === "project" ? "project" : "priority",
  tab: load("tab2", "chat"), closedSecs: load("closedSecs", { stale: true, empty: true }), closedProj: load("closedProj", {}),
  notify: false, fit: load("fit", true), autoBrief: load("autoBrief", true),
  details: new Map(), board: false, sub: null,
  tpos: load("tpos", "bottom"), main: load("main", "chat"),
};
S.notify = load("notify", false) && "Notification" in window && Notification.permission === "granted";
const THEMES = [
  ["", "System", "Follows your device’s light or dark setting", ["#131a22", "#f6f7f9"]],
  ["dark", "Harbor", "The default dark", ["#131a22", "#8fbfff"]],
  ["light", "Light", "Clean and bright", ["#f6f7f9", "#1f6fd1"]],
  ["midnight", "Midnight", "True black, easy on OLED phones", ["#000000", "#8ab4ff"]],
  ["nord", "Nord", "Cool arctic blues", ["#2e3440", "#88c0d0"]],
  ["solarized", "Solarized", "The classic low-contrast dark", ["#002b36", "#b58900"]],
  ["paper", "Paper", "Warm light, like a notebook", ["#f7f3ea", "#9a4f22"]],
  ["contrast", "High contrast", "Maximum legibility", ["#000000", "#ffd000"]],
  ["dracula", "Dracula", "Purple night with neon accents", ["#282a36", "#bd93f9"]],
  ["mocha", "Catppuccin Mocha", "Soft pastels on warm dark", ["#1e1e2e", "#cba6f7"]],
  ["latte", "Catppuccin Latte", "Soft pastels, light", ["#eff1f5", "#8839ef"]],
  ["tokyo", "Tokyo Night", "Deep blue city lights", ["#1a1b26", "#7aa2f7"]],
  ["gruvbox", "Gruvbox", "Retro warm and earthy", ["#282828", "#fabd2f"]],
  ["rosepine", "Rosé Pine", "Muted, dreamy and calm", ["#191724", "#ebbcba"]],
  ["everforest", "Everforest", "Green and restful", ["#2d353b", "#a7c080"]],
  ["onedark", "One Dark", "The Atom classic", ["#282c34", "#61afef"]],
  ["github", "GitHub Light", "Crisp and familiar", ["#ffffff", "#0969da"]],
  ["monokai", "Monokai", "Bold and punchy", ["#272822", "#a6e22e"]],
];
function applyTheme(name) {
  const root = document.documentElement;
  if (name) root.dataset.theme = name; else delete root.dataset.theme;
  // The phone's status bar and the installed app's title bar follow the theme.
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) { m.setAttribute("content", bg); m.removeAttribute("media"); }
  });
}
applyTheme(load("theme", ""));
S.simple = load("simple", false);
if (S.simple) { document.documentElement.dataset.simple = ""; S.tab = "chat"; }
const app = $("app");
app.dataset.tpos = S.tpos;
app.dataset.main = S.main;
app.style.setProperty("--lw-open", load("lw", 380) + "px");
app.style.setProperty("--th-open", load("th", Math.round(innerHeight * 0.34)) + "px");
app.style.setProperty("--tw-open", load("tw", Math.round(innerWidth * 0.4)) + "px");
app.classList.toggle("list-off", load("listOff", false));
app.classList.toggle("term-off", load("termOff", false) || load("simple", false));
const phone = matchMedia("(max-width: 760px)");
const isPhone = () => phone.matches;

// ── talking to the deck, toasts, copying ────────────────────────────────
async function api(path, body, timeoutMs) {
  let res;
  try { res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-deck-token": S.token }, body: JSON.stringify(body), signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined }); }
  catch (e) { if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error("That took too long. Try again in a moment."); throw e; }
  if (res.status === 403) { reconnectSoon(200); throw new Error("Reconnecting to the deck…"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
/** Toasts stack (three at most) and slide. A "…" toast is progress, so what follows replaces it in place. Returns the toast. */
function toast(msg, err) {
  let box = document.querySelector(".toasts");
  if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.append(box); }
  const live = [...box.children].filter((x) => !x._out);
  let t = live[live.length - 1];
  if (!t || !(t._msg === msg || t._msg.endsWith("…"))) {
    while (live.length >= 3) toastOut(live.shift());
    const before = motion.rects(live);
    t = document.createElement("div"); t.setAttribute("role", "status");
    box.append(t);
    motion.flip(before);
    motion.enter(t, isPhone() ? "rise" : "slide");
  } else if (t._msg !== msg) motion.enter(t, "fade");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = t._msg = msg;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => toastOut(t), err ? 7000 : 2400);
  return t;
}
function toastOut(t) {
  if (t._out) return;
  t._out = true; clearTimeout(t._timer);
  // The stack is anchored at the bottom: only a toast below others makes them move down (then they glide).
  motion.leave(t, isPhone() ? "fade" : "slide", () => { const below = t.nextElementSibling ? motion.rects([...t.parentElement.children].filter((x) => x !== t)) : null; t.remove(); if (below) motion.flip(below); });
}
async function copy(text, what) { try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`); } catch { toast("The browser blocked clipboard access", true); } }

// ── a small promise-based dialog (no browser pop-ups) ────────────────────
function askDialog({ title, text = "", input, ok = "OK", danger = false, multiline = false, selectInput = true }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "ask";
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${esc(title)}</h3>${text ? `<p class="hint" style="white-space:pre-wrap">${esc(text)}</p>` : ""}${input != null ? (multiline ? `<textarea class="inp" rows="4">${esc(input)}</textarea>` : `<input class="inp" value="${esc(input)}">`) : ""}</div><div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" value="ok">${esc(ok)}</button></div></form>`;
    document.body.append(d);
    d.addEventListener("close", () => { const v = d.returnValue === "ok" ? (input != null ? d.querySelector(".inp").value : true) : null; motion.drop(d); resolve(v); });
    d.showModal();
    if (selectInput) d.querySelector(".inp")?.select?.(); else d.querySelector("button[value=ok]")?.focus();
  });
}
