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

// ── formatting ───────────────────────────────────────────────────────────
function ago(t) {
  if (!t) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 60) return Math.round(s / 86400) + "d";
  return Math.round(s / 86400 / 30) + "mo";
}
const agoText = (t) => (!t ? "" : ago(t) === "now" ? "just now" : ago(t) + " ago");
const DTF = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const DF = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const TF = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const abs = (t) => (t ? DTF.format(new Date(t)) : "—");
const when = (t) => (!t ? "" : Date.now() - t < 20 * 3600_000 ? TF.format(new Date(t)) : DF.format(new Date(t)));
const mem = (kb) => (kb >= 1048576 ? (kb / 1048576).toFixed(1) + " GB" : Math.round(kb / 1024) + " MB");
const tok = (n) => (n == null ? "" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");
const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
function hue(name) { let h = 2166136261; for (const c of name) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h) % 360; }
const pc = (p) => `oklch(var(--pc-l) var(--pc-c) ${hue(p || "?")})`;
const STATUS_NAME = { working: "Working", blocked: "Needs input", done: "Finished", idle: "Idle", empty: "Empty", unknown: "Unknown" };
const statusVar = (s) => `var(--${s in STATUS_NAME ? s : "unknown"})`;
const machineOf = (id) => S.summary.machines?.find((m) => m.id === id);
const machineLabel = (id) => machineOf(id)?.label ?? id ?? "";
const multiMachine = () => (S.summary.machines?.length ?? 0) > 1;
/** First run: no herdr server answers on this machine. */
const noHerdr = () => { const m = (S.summary.machines ?? []).find((x) => x.local); return !!m && Array.isArray(m.herdr) && !m.herdr.length; };
const realMachines = () => (S.summary.machines ?? []).filter((m) => m.kind !== "app");
const plain = (t) => String(t ?? "").replace(/^\s*\[\d{4}-\d\d-\d\d[^\]]*\]\s*/, "").replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/, "").replace(/\s+/g, " ").trim();
const home = (p) => String(p ?? "").replace(/^\/(Users|home)\/[^/]+/, "~");
const isAgent = (r) => ["claude", "codex", "opencode"].includes(r?.agent);
const ICON = {
  sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>',
  plus: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`,
  chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 6 4 4 4-4"/></svg>',
  back: '<svg class="chev" style="transform:rotate(90deg)" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 6 4 4 4-4"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  jump: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2 7.5 8.5"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.8 9.5 6l4.3.2-3.4 2.7 1.2 4.2L8 10.7l-3.6 2.4 1.2-4.2L2.2 6.2 6.5 6z"/></svg>',
  bot: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/></svg>',
  home: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 7.2 8 2.8l5.5 4.4M4 6v7h3v-3.5h2V13h3V6"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 2.2 14.3 13H1.7z"/><path d="M8 6.5v3M8 11.4h.01"/></svg>',
  link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.9.9M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8a3 3 0 0 0 4.2 4.2l.9-.9"/></svg>',
  term: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m5 7 2 1.5L5 10M8.5 10.5H11"/></svg>',
};

/** Tab/pane as herdr names it: "(24 · chat-with-chart)", or "(tab 24)" when the label just repeats the title. */
/** "(24 · chat-with-chart)", or nothing for Codex app threads (their badge already says where they are). */
const paneTag = (r) => (r.app ? "" : `(${esc(paneName(r))})`);
function paneName(r) {
  if (r.app) return "Codex app";
  const lbl = String(r.tab ?? "").trim();
  const bare = lbl.replace(/^\d+\s+/, "");
  const t = String(r.title ?? "").toLowerCase();
  let s;
  if (!bare || /^\d+$/.test(bare)) s = `tab ${r.tabNumber}`;
  else {
    const b = bare.toLowerCase();
    const same = b.length >= 4 && (t.startsWith(b.slice(0, 20)) || b.startsWith(t.slice(0, 20)));
    s = same ? `tab ${r.tabNumber}` : `${r.tabNumber} · ${bare}`;
  }
  const wsCount = new Set([...S.rows.values()].filter((x) => x.machine === r.machine).map((x) => x.workspace)).size;
  if (wsCount > 1 && r.workspace) s = `${r.workspace} › ${s}`;
  if (r.tabPanes > 1) s += " · split";
  return s;
}

// ── tool calls in plain words ────────────────────────────────────────────
const TI = {
  edit: '<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/>',
  read: '<path d="M4 2h6l3 3v9H4z"/><path d="M6.5 8h4M6.5 10.5h4"/>',
  run: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m5 7 2 1.5L5 10M8.5 10.5H11"/>',
  find: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
  web: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2.2 2 8.8 0 11M8 2.5c-2 2.2-2 8.8 0 11"/>',
  plan: '<path d="M3 4h1M3 8h1M3 12h1M6.5 4H13M6.5 8H13M6.5 12H13"/>',
  agent: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/>',
  tool: '<path d="M9.5 2.5a3 3 0 0 0-3.8 3.8L2.5 9.5l2 2 3.2-3.2a3 3 0 0 0 3.8-3.8L9.8 6.2 8 5.8l-.4-1.8z"/>',
};
/** What a tool call did, as a verb a person would use: "Edited", "Ran", "Searched"… (present tense while running). */
function toolWords(name) {
  const n = String(name ?? "").toLowerCase().replace(/^.* · /, "");
  const k = /^(edit|multiedit|write|apply_patch|notebookedit|patch)$/.test(n) ? "edit"
    : /^(read|view|cat)$/.test(n) ? "read"
    : /^(bash|shell|exec|exec_command|local_shell|local_shell_call|shell_command|run)$/.test(n) ? "run"
    : /^(grep|glob|search|ls|list|find|codebase_search)$/.test(n) ? "find"
    : /^(webfetch|websearch|web_search|fetch)$/.test(n) || /browser|navigate|playwright/.test(n) ? "web"
    : /^(todowrite|update_plan|todo)$/.test(n) ? "plan"
    : /^(agent|task)$/.test(n) ? "agent" : "tool";
  const V = { edit: ["Edited", "Editing"], read: ["Read", "Reading"], run: ["Ran", "Running"], find: ["Searched", "Searching"], web: ["Browsed", "Browsing"], plan: ["Updated the plan", "Planning"], agent: ["Subagent", "Subagent"], tool: [String(name ?? "Tool"), String(name ?? "Tool")] };
  if (/^websearch|web_search/.test(n)) V.web = ["Searched the web", "Searching the web"];
  if (/^write$/.test(n)) V.edit = ["Wrote", "Writing"];
  return { k, done: V[k][0], doing: V[k][1] };
}
const toolIcon = (k) => `<svg class="ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${TI[k] ?? TI.tool}</svg>`;
/** "Bash: npm test" → "Running npm test", for the now lines. */
function nowWords(now, running = true) {
  if (!now) return "";
  const i = now.indexOf(": ");
  const name = i > 0 ? now.slice(0, i) : now, rest = i > 0 ? now.slice(i + 2) : "";
  const w = toolWords(name);
  return w.k === "tool" ? now : `${running ? w.doing : w.done}${rest ? " " + rest : ""}`;
}

// ── markdown (safe: escaped first) ───────────────────────────────────────
const PATHISH = /^(?:~\/|\/|\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+ -]*[\w@.+-])+\/?(?::\d+(?::\d+)?)?$/;
const looksLikePath = (c) => PATHISH.test(c) && (/^(~\/|\/)/.test(c) || /\.\w{1,8}(:\d+)*$/.test(c)) && !/^\w+:\/\//.test(c);
function inline(s) {
  const codes = [];
  let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // local file links, "[name](</abs/path>)" or "[name](/abs/path)": show the name, the path on hover
    .replace(/\[([^\]\n]+)\]\((?:&lt;)?((?:~|\/|\.{1,2}\/)[^\s)]*?)(?:&gt;)?\)/g, '<a class="fpath" data-path="$2" title="$2">$1</a>')
    // [[wiki-page]] links into the personal wiki
    .replace(/\[\[([\w.-]+)(?:\|([^\]\n]+))?\]\]/g, (_, name, label) => `<a class="fpath" data-path="wiki:${name}" title="Wiki: ${name}">${label ?? name}</a>`)
    // bare paths in prose: ~/… or an absolute home path
    .replace(/(^|[\s(])((?:~|\/Users\/[\w.-]+|\/home\/[\w.-]+)\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])/g, '$1<a class="fpath" data-path="$2" title="$2">$2</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => { const c = codes[Number(i)]; return looksLikePath(c.replace(/&amp;/g, "&")) ? `<code class="fpath" data-path="${c}" title="Open ${c}">${c}</code>` : `<code>${c}</code>`; });
}
/**
 * Choices an agent offers ("(a) … (b) …", "A) …", or a numbered list right after a question) become cards
 * you can pick with one click. Returns null when the lines aren't a clean, sequential set of 2+ options.
 */
const OPT_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:\(([a-hA-H1-9])\)|([a-hA-H1-9])[).:]|Option ([A-Ha-h1-9])[:.)]?)(?:\*\*)?\s+(.+)$/;
function parseChoices(lines, start, afterQuestion) {
  const opts = [];
  const labelOf = (l) => { const m = l?.match(OPT_RE); return m ? { label: (m[1] ?? m[2] ?? m[3]).toLowerCase(), text: m[4] } : null; };
  let i = start;
  for (;;) {
    const o = labelOf(lines[i]);
    if (!o) break;
    const want = opts.length ? String.fromCharCode(opts[opts.length - 1].label.charCodeAt(0) + 1) : null;
    if (want ? o.label !== want : !/^[a1]$/.test(o.label)) break;
    if (/^\d$/.test(o.label) && !afterQuestion) return null; // a plain numbered list stays a list
    const body = [o.text];
    i++;
    const next = String.fromCharCode(o.label.charCodeAt(0) + 1);
    // An option runs until the next option's label (even across blank lines); the last one ends at a blank line.
    let j = i;
    while (j < lines.length && j - i < 40 && labelOf(lines[j])?.label !== next) j++;
    const until = j < lines.length && labelOf(lines[j])?.label === next ? j : (() => { let k = i; while (k < lines.length && lines[k].trim() && !OPT_RE.test(lines[k])) k++; return k; })();
    for (; i < until; i++) if (lines[i].trim()) body.push(lines[i]);
    opts.push({ label: o.label, body });
    if (until >= lines.length || labelOf(lines[until])?.label !== next) break;
  }
  return opts.length >= 2 ? { opts, end: i } : null;
}
const DECIDE = /\b(pick|choose|choice|options?|ways?\b|paths?|approach(?:es)?|alternatives?|directions?|decide|decision|go with|prefer|should (?:i|we)|would you like|want me to|which (?:one|option|way|path|approach|of these|do you|would you|should))\b/i;
const ASKS = /\?\s*\**\s*$|\b(pick one|choose|which (?:one|do you|would you)|prefer|your call|let me know which|tell me which)\b/i;
/** Title = a leading **bold** phrase, else the first sentence; the rest describes it. */
function splitOption(body) {
  const first = body[0];
  const bold = first.match(/^\*\*(.+?)\*\*[\s:—–.-]*(.*)$/);
  let title, restFirst;
  if (bold) { title = bold[1]; restFirst = bold[2]; }
  else {
    const plainFirst = first.replace(/\*\*/g, "");
    const cut = plainFirst.search(/(?<=[.!?])\s|\s[—–-]\s|:\s|;\s/);
    title = cut > 0 && cut < 100 ? plainFirst.slice(0, cut) : plainFirst.length <= 100 ? plainFirst : plainFirst.slice(0, 90).replace(/\s+\S*$/, "") + "…";
    restFirst = cut > 0 && cut < 100 ? plainFirst.slice(cut).replace(/^\s*[—–:;-]?\s*/, "") : plainFirst.length <= 100 ? "" : plainFirst;
  }
  return { title: title.replace(/[\s,;:.—–-]+$/, ""), rest: [restFirst, ...body.slice(1)].filter((x) => x && x.trim()) };
}
function choicesHTML(opts, question) {
  return `<div class="choices">${question ? `<div class="cq">${inline(question)}</div>` : ""}${opts.map((o) => {
    const { title, rest } = splitOption(o.body);
    const rec = /recommend|\bpreferred\b/i.test(o.body[0]);
    const lab = o.label.toUpperCase();
    const clean = title.replace(/\s*\((my )?recommend(ed|ation)\)/i, "");
    return `<div class="choice${rec ? " rec" : ""}" data-choice="${esc(o.label)}" data-title="${esc(clean)}"><span class="cl">${esc(lab)}</span><div class="cb"><div class="ct">${inline(clean)}${rec ? '<span class="rp">Recommended</span>' : ""}</div>${rest.length ? `<div class="cd">${rest.map(inline).join("<br>")}</div>` : ""}</div><button class="btn primary cs" data-choose="${esc(o.label)}" tabindex="-1">Choose ${esc(lab)}</button></div>`;
  }).join("")}<div class="chint">Click an option to put it in your reply · <b>Choose</b> sends it</div></div>`;
}
function diffHTML(code) {
  return `<pre class="diff"><code>${code.replace(/\n$/, "").split("\n").map((l) => `<span class="${/^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@/.test(l) ? "hunk" : ""}">${esc(l)}</span>`).join("\n")}</code></pre>`;
}
function md(text) {
  const out = [];
  const src = String(text ?? "");
  const langs = [...src.matchAll(/^```([^\n]*)\n/gm)].map((m) => m[1].trim().toLowerCase());
  const parts = src.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  for (let p = 0; p < parts.length; p++) {
    if (p % 2 === 1) { const lang = langs[(p - 1) / 2] ?? ""; out.push(lang === "diff" || lang === "patch" ? diffHTML(parts[p]) : `<pre><code>${esc(parts[p].replace(/\n$/, ""))}</code></pre>`); continue; }
    const lines = parts[p].split("\n");
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const prevHTML = out[out.length - 1] ?? "";
      const prevText = prevHTML.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      const intro = prevText.split(/(?<=[.!?:])\s+/).pop() ?? "";
      const decisive = /\?\s*$/.test(intro) || (DECIDE.test(intro) && /[:?]\s*$/.test(intro));
      const ch = OPT_RE.test(l) ? parseChoices(lines, i, decisive) : null;
      if (ch) {
        const outro = lines.slice(ch.end).find((x) => x.trim()) ?? "";
        const rec = ch.opts.some((o) => /recommend/i.test(o.body[0]));
        const numeric = /^\d$/.test(ch.opts[0].label);
        if (decisive || (!numeric && (rec || ASKS.test(outro)))) {
          // The question moves into the card group, so the options read as answers to it.
          // A short question/lead-in paragraph moves into the card group so the options read as answers to it.
          let q = "";
          if (/[?:]\s*\**\s*$/.test(prevText) && (prevText === intro || prevText.length < 140) && /^<(p|h\d)>/.test(prevHTML)) { out.pop(); q = prevText.replace(/\*\*/g, ""); }
          out.push(choicesHTML(ch.opts, q));
          i = ch.end;
          continue;
        }
      }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? "")) {
        const row = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = row(l);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(`<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table>`);
        continue;
      }
      if (/^\s*>/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${q.map(inline).join("<br>")}</blockquote>`);
        continue;
      }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d+[.)]/.test(l);
        const items = [];
        while (i < lines.length && (/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          const ln = lines[i++];
          if (/^\s*([-*•]|\d+[.)])\s+/.test(ln)) items.push(ln.replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
          else items[items.length - 1] += "\n" + ln.trim();
        }
        const check = (x) => { const c = x.match(/^\[( |x|X)\]\s+/); return c ? `<span class="ck${c[1] !== " " ? " on" : ""}"></span>${inline(x.slice(c[0].length)).replace(/\n/g, "<br>")}` : inline(x).replace(/\n/g, "<br>"); };
        const task = items.some((x) => /^\[( |x|X)\]\s/.test(x));
        out.push(`<${ordered ? "ol" : "ul"}${task ? ' class="tasks"' : ""}>${items.map((x) => `<li>${check(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*>|\s*([-*•]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
  }
  return out.join("");
}
/** Light markdown for short prose (briefs, recaps). */
const mdLite = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code class="mono" style="font-size:.86em">$1</code>').replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");

// ── inbox & projects ─────────────────────────────────────────────────────
/** A finished session stops needing you once you've opened it (on any device). */
const unseenDone = (r) => r.status === "done" && !r.seen;
const needsYou = (r) => r.status === "blocked" || unseenDone(r);
/** herdr's "priority" order: an attention queue. Lower rank comes first. */
/** Opened in the last 15 minutes: a new session stays in plain sight even before anything happens in it. */
const fresh = (r) => !!r.bornAt && Date.now() - r.bornAt < 15 * 60_000;
const act = (r) => r.lastActiveAt ?? r.bornAt ?? 0;
function rank(r) {
  if (r.status === "blocked") return 0;
  if (unseenDone(r)) return 1;
  if (r.status === "working") return 2;
  if (r.empty && fresh(r)) return 3;
  if (r.empty) return 6;
  if (r.stale) return 5;
  return 3;
}
/* @pure:list-begin: no globals in here; test/list.test.ts evaluates this block on its own. */
/** A compact span for reason chips: "" under 45 s, then "3m", "2h", "5d", "2mo". */
function span(ms) {
  const s = ms / 1000;
  if (!(s >= 45)) return "";
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 60) return Math.round(s / 86400) + "d";
  return Math.round(s / 86400 / 30) + "mo";
}
/** The chip text for a reason kind at time `now` (re-run by the ticker for chips that carry a time). */
function reasonLabel(k, t, now) {
  const s = t ? span(now - t) : "";
  switch (k) {
    case "perm": return "needs permission";
    case "ask": return "asks you";
    case "wait": return "needs you";
    case "done": return s ? `finished ${s} ago` : "just finished";
    case "work": return s ? `working ${s}` : "working";
    case "new": return "new";
    case "empty": return "empty";
    case "stale": return s ? `stale ${s}` : "stale";
    default: return s ? `idle ${s}` : "idle";
  }
}
/** Why a row sits where it does in the priority list, mirroring rank(). `ask` is the pending decision's kind, if any. */
function reasonOf(r, ask, now) {
  let k, t = 0;
  if (ask === "prompt") k = "perm";
  else if (ask === "question") k = "ask";
  else if (r.status === "blocked") k = "wait";
  else if (r.status === "done" && !r.seen) { k = "done"; t = r.lastActiveAt ?? 0; }
  else if (r.status === "working") { k = "work"; t = r.turnStartedAt && now - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : 0; }
  else if (r.empty) k = r.bornAt && now - r.bornAt < 15 * 60_000 ? "new" : "empty";
  else if (r.stale) { k = "stale"; t = r.lastActiveAt ?? 0; }
  else { k = "idle"; t = r.lastActiveAt ?? 0; }
  return { k, t, text: reasonLabel(k, t, now) };
}
/** Fields that change every few seconds while an agent works; a row that only changed these re-renders at most once a second. */
const VOLATILE = new Set(["now", "step", "todos", "tail", "subagents", "lastActiveAt", "rssKB", "cpu", "procs", "ctxTokens", "cost", "focused", "dirty", "cols", "rows", "_hay"]);
function stableSig(r) {
  const running = (r.subagents ?? []).filter((x) => x.running).length;
  return JSON.stringify(r, (k, v) => (VOLATILE.has(k) ? undefined : v)) + "|" + running + "|" + !!(r.tail?.length || r.now || r.step);
}
/** While the order is frozen: what is shown keeps its place, gone rows drop out, new rows wait. */
function frozenOrder(shown, next) {
  const want = new Set(next), have = new Set(shown);
  return { keys: shown.filter((k) => want.has(k)), held: next.filter((k) => !have.has(k)) };
}
/* @pure:list-end */
const SECTIONS = [["needs", "Needs you"], ["running", "Running"], ["quiet", "Quiet"], ["stale", "Stale"], ["empty", "Empty"]];
function sectionOf(r) {
  const k = rank(r);
  return k <= 1 ? "needs" : k === 2 ? "running" : k === 6 ? "empty" : k === 5 ? "stale" : "quiet";
}
function parseQuery(q) {
  const inc = [], exc = [], is = [], agent = [];
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w.startsWith("is:")) is.push(w.slice(3));
    else if (w.startsWith("agent:")) agent.push(w.slice(6));
    else if (w.startsWith("-") && w.length > 1) exc.push(w.slice(1));
    else inc.push(w);
  }
  return { inc, exc, is, agent };
}
const hayHit = (r) => { const q = parseQuery(S.q); return q.inc.length && q.inc.every((w) => hay(r).includes(w)); };
function hay(r) {
  return (r._hay ??= [r.title, r.project, r.launch, r.branch, r.cwd, r.agent, r.status, r.model, r.tab, r.workspace, machineLabel(r.machine), r.firstPrompt, r.lastMessage, r.now, r.tail.join(" ")].filter(Boolean).join(" \u0001 ").toLowerCase());
}
const inScope = (r) => S.machine === "all" || r.machine === S.machine;
function visibleRows() {
  const q = parseQuery(S.q);
  const out = [];
  for (const r of S.rows.values()) {
    if (!inScope(r)) continue;
    if (q.is.length && !q.is.every((f) => (f === "stale" ? r.stale : f === "dup" ? r.duplicate : f === "empty" ? r.empty : f === "live" ? r.status === "working" || r.status === "blocked" : r.status === f))) continue;
    if (q.agent.length && !q.agent.some((a) => r.agent.startsWith(a))) continue;
    if (q.inc.length || q.exc.length) {
      const h = hay(r);
      if (q.exc.some((w) => h.includes(w))) continue;
      if (!q.inc.every((w) => h.includes(w)) && !(S.deep?.q === S.q && S.deep.byKey.has(r.key))) continue;
    }
    out.push(r);
  }
  const act = (r) => r.lastActiveAt ?? r.startedAt ?? 0;
  const deep = S.deep?.q === S.q ? S.deep.byKey : null;
  // Deep-search hits come first when the words only appear inside the conversation.
  out.sort((a, b) => rank(a) - rank(b) || act(b) - act(a));
  if (deep) out.sort((a, b) => Number(!!hayHit(b)) - Number(!!hayHit(a)) || 0);
  return out;
}

// ── list rendering (keyed; only changed rows touch the DOM) ──────────────
const rowCache = new Map();
const SIMPLE_STATUS = { working: ["Working on it", "✨"], blocked: ["Needs you", "👋"], done: ["Finished", "✅"], idle: ["Resting", "💤"], empty: ["Ready, nothing asked yet", "·"], unknown: ["Status unknown", "?"], history: ["Past session", "🕘"] };
/** The question an agent is waiting on, answerable right in the list (like Claude on the web and phone). */
const pendingAsk = (r) => (S.decisions ?? []).find((d) => d.key === r.key && (d.kind === "prompt" || d.kind === "question") && !S.done.has(d.key));
function rowAsk(r) {
  const d = pendingAsk(r);
  if (!d) return "";
  const opts = d.options.slice(0, 4).map((o) => `<button class="ropt${o.rec ? " rec" : ""}" data-ropt="${esc(o.id)}" title="${esc(o.title)}"><span class="ol">${esc(String(o.id).toUpperCase())}</span>${esc(plain(o.title).slice(0, 44))}${plain(o.title).length > 44 ? "…" : ""}</button>`).join("");
  return `<div class="rask" data-rask="${esc(r.key)}"><div class="rq">${esc(plain(d.question))}</div><div class="ropts">${opts}${d.options.length > 4 ? `<button class="ropt more" data-ropen>+${d.options.length - 4} more</button>` : ""}<button class="ropt ghost" data-rreply>${d.options.length ? "Other…" : "Reply…"}</button></div></div>`;
}
async function answerOption(d, o) {
  if (d.kind === "prompt") await api("/api/keys", { key: d.key, keys: o.keys ?? [String(o.id)] });
  else await api("/api/send", { key: d.key, text: o.send ?? o.title });
  S.done.set(d.key, Date.now());
  api("/api/decide", { key: d.key, action: "answer", choice: String(o.id) }).catch(() => {});
  api("/api/seen", { key: d.key }).catch(() => {});
}

/** Where a session lives: which machine (and herdr workspace), shown under every row in both modes. */
const SRC_ICON = {
  mac: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="3" width="11" height="7.5" rx="1"/><path d="M1 13h14"/></svg>',
  remote: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><path d="M4.5 4.7h.01M4.5 11.2h.01"/></svg>',
  app: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M6 8h4"/></svg>',
};
function srcLine(r) {
  const m = (S.summary.machines ?? []).find((x) => x.id === r.machine);
  const icon = r.app ? SRC_ICON.app : m && !m.local ? SRC_ICON.remote : SRC_ICON.mac;
  const where = r.app ? "Codex app" : r.hist ? `${machineLabel(r.machine)} · history` : `${machineLabel(r.machine)}${r.workspace && !S.simple ? ` · ${r.workspace}` : ""}`;
  return `<span class="src" title="Runs on ${esc(machineLabel(r.machine))}">${icon}<span>${esc(where)}</span></span>`;
}
function simpleRow(r) {
  const [word, em] = SIMPLE_STATUS[r.status] ?? ["", ""];
  return `<span class="dot" style="--c:${statusVar(r.status)}"></span><span class="tl"><b>${esc(r.title || "(untitled)")}</b></span><span class="ago">${r.status === "working" ? em : esc(ago(r.lastActiveAt))}</span><span class="ln"><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span> · <span class="sw" data-s="${r.status}">${esc(word)}</span>${radarChip(r)}</span>${srcLine(r)}${rowAsk(r)}`;
}
/** The reason chip: why this row is ranked where it is ("needs permission", "finished 2m ago", "working 3m", "idle 3d"…). */
function reasonChip(r, why) {
  const tip = why.k === "work" && why.t ? `Working since ${abs(why.t)}` : `Last active ${abs(r.lastActiveAt)}`;
  return `<span class="ago why" data-k="${why.k}"${why.t ? ` data-t="${why.t}" data-why="${why.k}"` : ""} title="${esc(tip)}">${esc(why.text)}</span>`;
}
const RADAR_PHASE = { exploring: "reading and searching", editing: "changing files", testing: "running tests or builds", debugging: "chasing a failure", wrapping_up: "wrapping up" };
const RADAR_WHY = { repeat: "it made the same tool call 3 or more times in its last 8", errors: "3 or more of its last 6 tool calls failed", stall: "this turn has run over 10 minutes without editing a file" };
/** Jev's stuck/drift read on a running session, as a small chip; nothing unless it's fairly sure (70%+). */
function radarChip(r) {
  const e = r.status === "working" && (S.radar ?? []).find((x) => x.key === r.key);
  if (!e) return "";
  const bits = [e.stuck >= 0.7 ? `looping ${Math.round(e.stuck * 100)}%` : "", e.offTask >= 0.7 ? `off task ${Math.round(e.offTask * 100)}%` : ""].filter(Boolean);
  if (!bits.length) return "";
  const tip = `Jev thinks this session may be ${e.stuck >= 0.7 && e.offTask >= 0.7 ? "stuck and off task" : e.stuck >= 0.7 ? "stuck" : "off task"}${e.phase ? `; it looks like it's mostly ${RADAR_PHASE[e.phase] ?? e.phase}` : ""}.\nThe deck asked because ${RADAR_WHY[e.trigger] ?? "it looked unusual"}.\nJust a heads-up: nothing happens on its own.`;
  return `<span class="rchip" title="${esc(tip)}">${esc(bits.join(" · "))}</span>`;
}
function rowHTML(r, byProject, why = reasonOf(r, pendingAsk(r)?.kind, Date.now())) {
  if (S.simple) return simpleRow(r);
  const live = r.status === "working";
  const agoEl = reasonChip(r, why);
  const title = `<span class="tl"><b>${esc(r.title || "(untitled)")}</b> <span class="pane">${paneTag(r)}</span></span>`;
  let line = "";
  const tail = r.tail?.length ? plain(r.tail[r.tail.length - 1]) : "";
  if (r.status === "blocked") line = pendingAsk(r) ? "" : `<span class="ln ask">${esc(tail || "waiting for you")}</span>`;
  else if (live) line = `<span class="ln now">${r.todos?.total ? `<span class="stp">${r.todos.done}/${r.todos.total}</span>` : ""}${r.now ? esc(nowWords(r.now)) : r.step ? esc(r.step) : "thinking…"}</span>`;
  else if (unseenDone(r)) line = `<span class="ln">${esc(plain(r.lastMessage) || tail || "finished")}</span>`;
  else if (r.empty) line = `<span class="ln">${r.agent === "shell" ? "empty shell" : "no conversation yet"}</span>`;
  const hit = S.q && S.deep?.q === S.q ? S.deep.byKey.get(r.key) : null;
  if (hit) {
    let snip = esc(hit.snippet);
    for (const w of parseQuery(S.q).inc) snip = snip.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (x) => `<mark>${x}</mark>`);
    line = `<span class="ln hit">${hit.role === "user" ? "You: " : hit.role === "tool" ? "" : "Agent: "}“${snip}”${hit.count > 1 ? ` <span class="hint">· ${hit.count} messages</span>` : ""}</span>`;
  }
  // The status line is always there (quiet rows show the last reply, or stay blank), so rows keep their height.
  if (!line && !pendingAsk(r)) { const last = plain(r.lastMessage); line = last ? `<span class="ln last">${esc(last)}</span>` : `<span class="ln ph" aria-hidden="true">&nbsp;</span>`; }
  const running = (r.subagents ?? []).filter((x) => x.running);
  const subs = running.length ? `<span class="subs" title="${esc(running.map((x) => `${x.type || "agent"}: ${x.description ?? ""}${x.now ? " · " + x.now : ""}`).join("\n"))}"><span class="spin"></span><span class="st">↳ ${running.length} subagent${running.length === 1 ? "" : "s"}: ${esc(running[0].description || running[0].type || "agent")}</span></span>` : "";
  const dot = `<span class="dot" style="--c:${statusVar(r.status === "done" && r.seen ? "idle" : r.status)}"></span>`;
  const rc = radarChip(r);
  if (byProject) return `${dot}<span class="tl" style="grid-column:auto">${rc}<b>${esc(r.title || "(untitled)")}</b> <span class="pane">${paneTag(r)}</span>${r.launch ? ` <span class="via">via ${esc(r.launch)}</span>` : ""}</span>${agoEl}${srcLine(r)}${line}${subs}${rowAsk(r)}`;
  return `${dot}<span class="pl"><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>${r.launch ? `<span class="via">via ${esc(r.launch)}</span>` : ""}${rc}</span>${agoEl}${title}${srcLine(r)}${line}${subs}${rowAsk(r)}`;
}
let lastOrder = "", queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; renderNow(); });
}
function renderNow() {
  renderMachines();
  if (S.view === "closed") renderClosed(); else renderList();
  renderLive();
  renderFooter();
  renderDetail();
  renderViews();
  const n = [...S.rows.values()].filter(needsYou).length;
  document.title = (n ? `(${n}) ` : "") + "herdr deck";
  reportPresence();
}
function renderMachines() {
  const ms = S.summary.machines ?? [];
  const count = (id) => [...S.rows.values()].filter((r) => id === "all" || r.machine === id).length;
  const html = ms.length > 1 ? [["all", "All"], ...ms.map((m) => [m.id, m.label, m])].map(([id, label, m]) =>
    `<button role="tab" data-machine="${esc(id)}" aria-selected="${S.machine === id}" title="${m && !m.online ? esc(m.kind === "app" ? "The Codex app isn’t running" : "Offline: " + (m.error ?? "")) : ""}">${esc(label)} <span class="n">${count(id)}</span>${m && !m.online ? '<span class="off"></span>' : ""}</button>`).join("") : "";
  setHTML($("machines"), html);
  for (const b of $("groupSeg").children) b.setAttribute("aria-selected", b.dataset.group === S.group);
}
function renderLive() {
  const rows = [...S.rows.values()].filter(inScope);
  const working = rows.filter((r) => r.status === "working");
  const blocked = rows.filter((r) => r.status === "blocked");
  const subs = rows.reduce((n, r) => n + (r.subagents ?? []).filter((x) => x.running).length, 0);
  const el = $("live");
  el.hidden = !working.length && !blocked.length;
  el.setAttribute("aria-pressed", S.board);
  setHTML(el, `${working.length ? '<span class="spin"></span>' : '<span class="dot" style="--c:var(--blocked)"></span>'}<span><b>${working.length}</b> working${blocked.length ? ` · <b>${blocked.length}</b> waiting` : ""}${subs ? ` · <b>${subs}</b> subagent${subs === 1 ? "" : "s"}` : ""}</span><span class="spacer"></span><span class="dim">${S.board ? "Close board" : "Live board"}</span>`);
}
function listGroups(rows) {
  if (S.group === "project") {
    const empty = rows.filter((r) => r.empty && !fresh(r));
    const by = new Map();
    for (const r of rows) if (!r.empty || fresh(r)) by.set(r.project, [...(by.get(r.project) ?? []), r]);
    const rank = (rs) => (rs.some((r) => r.status === "blocked" || r.status === "done") ? 0 : rs.some((r) => r.status === "working") ? 1 : 2);
    const latest = (rs) => Math.max(...rs.map(act));
    const groups = [...by.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || latest(b[1]) - latest(a[1]))
      .map(([p, rs]) => ({ key: "p:" + p, label: p, proj: p, rows: rs.sort((a, b) => ["blocked", "done", "working"].indexOf(b.status) - ["blocked", "done", "working"].indexOf(a.status) || act(b) - act(a)), closed: !!S.closedProj[p] }));
    if (empty.length) groups.push({ key: "empty", label: "Empty", rows: empty, closed: S.closedSecs.empty !== false });
    return groups;
  }
  // Priority: one attention-ordered list; old and empty sessions fold away at the bottom.
  const main = rows.filter((r) => rank(r) < 5), tail = rows.filter((r) => rank(r) >= 5);
  const out = [{ key: "all", label: "", rows: main, closed: false, flat: true }];
  if (tail.length) out.push({ key: "old", label: `Stale & empty`, rows: tail, closed: S.closedSecs.old !== false, tail: true });
  return out.filter((x) => x.rows.length);
}
// The order never changes under the pointer: it is frozen while the pointer is over the list, while a touch is
// in progress, and for FREEZE_MS after it leaves. Row contents keep updating; moves are applied (FLIP) on release.
const FREEZE_MS = 1200;
const listHold = { over: false, touch: false, until: 0, timer: 0 };
const orderFrozen = () => listHold.over || listHold.touch || Date.now() < listHold.until;
function releaseSoon() {
  listHold.until = Date.now() + FREEZE_MS;
  clearTimeout(listHold.timer);
  listHold.timer = setTimeout(() => { listHold.timer = 0; if (!orderFrozen()) render(); }, FREEZE_MS + 20);
}
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const EASE = getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "cubic-bezier(.2, .8, .2, 1)";
/** A row whose volatile fields changed within the last second waits; this brings the list back to it. */
let volTimer = 0, volDue = 0;
function renderLater(ms) {
  const due = Date.now() + ms;
  if (volTimer && volDue <= due) return;
  clearTimeout(volTimer); volDue = due;
  volTimer = setTimeout(() => { volTimer = 0; render(); }, ms);
}
/** Where each row is, before a reorder (read before any DOM write, so it costs no extra layout). */
function rowTops(box) {
  const out = new Map();
  for (const el of box.querySelectorAll(".row[data-key]")) { const r = el.getBoundingClientRect(); if (r.height) out.set(el.dataset.key, r.top); }
  return out;
}
/** FLIP: every on-screen row that moved starts where it was and glides to its new place (new rows slide in via CSS). */
function flipRows(box, before) {
  const b = box.getBoundingClientRect();
  const moves = [];
  for (const el of box.querySelectorAll(".row[data-key]")) {
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom < b.top || r.top > b.bottom) continue;
    const was = before.get(el.dataset.key);
    // A row coming from far away enters from the nearest edge instead of flying across the whole list.
    if (was != null && Math.abs(was - r.top) >= 1) moves.push([el, Math.max(-b.height, Math.min(b.height, was - r.top))]);
  }
  for (const [el, dy] of moves) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: EASE });
}
let lastView = "";
function renderList() {
  const box = $("rows");
  const rows = visibleRows();
  const byProject = S.group === "project";
  const groups = listGroups(rows);
  const order = S.group + groups.map((g) => g.key + ":" + (g.closed ? "x" : "") + g.rows.map((r) => r.key).join(",")).join("|");
  // Anything you changed yourself (filter, grouping, machine, a folded section) applies at once, even under the pointer.
  const view = [S.group, S.machine, S.q, S.deep?.q ?? "", JSON.stringify(S.closedSecs), JSON.stringify(S.closedProj)].join("\u0001");
  const selHidden = !!S.sel && rows.some((r) => r.key === S.sel) && !rowCache.get(S.sel)?.el.isConnected;
  const force = !lastOrder || box.dataset.view !== "list" || view !== lastView || selHidden || !rows.length || !box.querySelector(".row[data-key]");
  const apply = order !== lastOrder && (force || !orderFrozen());
  const before = apply && !force && !reduceMotion.matches ? rowTops(box) : null;
  for (const k of rowCache.keys()) if (!S.rows.has(k)) rowCache.delete(k);
  const now = Date.now();
  const deepOn = S.q && S.deep?.q === S.q;
  for (const r of rows) {
    let c = rowCache.get(r.key);
    if (!c) {
      const el = document.createElement("div");
      el.className = "row born"; el.dataset.key = r.key; el.setAttribute("role", "button");
      // Drop the flash once it has played, or re-inserting the row on a reorder would replay it.
      el.addEventListener("animationend", (e) => { if (e.animationName === "flash") el.classList.remove("flash"); });
      c = { el, sig: "", stable: "", at: 0 };
      rowCache.set(r.key, c);
    }
    const ask = pendingAsk(r);
    const why = reasonOf(r, ask?.kind, now);
    const ctx = JSON.stringify(ask ?? "") + radarChip(r) + why.k + !!S.simple + S.machine + multiMachine() + byProject + (deepOn ? JSON.stringify(S.deep.byKey.get(r.key) ?? "") + S.q : "");
    const sig = JSON.stringify(r) + ctx;
    c.el.classList.toggle("unseen", needsYou(r));
    if (c.sig !== sig) {
      const stable = stableSig(r) + ctx;
      // Only the live bits moved (tool line, todos, tail, subagents, memory): at most one repaint a second per row.
      if (c.sig && c.stable === stable && now - c.at < 1000) renderLater(1000 - (now - c.at) + 16);
      else {
        const was = c.el.dataset.status;
        c.el.innerHTML = rowHTML(r, byProject, why); c.el.dataset.status = r.status; c.sig = sig; c.stable = stable; c.at = now;
        if (was && was !== r.status && (r.status === "blocked" || r.status === "done")) { c.el.classList.remove("flash"); void c.el.offsetWidth; c.el.classList.add("flash"); }
      }
    }
    // Selected means "this is the session on the right": not while the board or a view (Inbox, History…) is showing.
    c.el.classList.toggle("sel", S.sel === r.key && !S.board && !S.mode);
    c.el.classList.toggle("picked", S.picked.has(r.key));
    c.el.classList.toggle("stale", !!r.stale && r.status !== "working" && r.status !== "blocked");
  }
  if (apply) {
    lastOrder = order; lastView = view;
    box.dataset.view = "list";
    box._h = "";
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      const sec = document.createElement("section");
      sec.className = "sec" + (g.closed ? " closed" : "") + (g.proj ? " proj" : "");
      if (g.proj) sec.style.setProperty("--pc", pc(g.proj));
      const nb = g.rows.filter((r) => r.status === "blocked" || r.status === "done").length, nw = g.rows.filter((r) => r.status === "working").length;
      const dots = g.proj ? `<span class="dots">${nb ? `<span class="dot" style="--c:var(--blocked)" title="${nb} need you"></span>` : ""}${nw ? `<span class="dot" style="--c:var(--working)" title="${nw} working"></span>` : ""}</span>` : "";
      const extra = g.key === "empty" || g.tail ? `<span class="act link" data-secact="closeEmpty" role="button">Close empty</span>`
        : g.proj && projectHome(g.proj) ? `<span class="padd" data-secact="newin" data-proj="${esc(g.proj)}" role="button" title="New session in ${esc(g.proj)}" aria-label="New session in ${esc(g.proj)}">${ICON.plus}</span>` : "";
      if (g.flat) { sec.className = "sec flat"; sec.innerHTML = `<div class="sec-b"></div>`; const body = sec.lastChild; for (const r of g.rows) body.append(rowCache.get(r.key).el); frag.append(sec); continue; }
      sec.innerHTML = `<button class="sec-h" data-sec="${esc(g.key)}" aria-expanded="${!g.closed}">${ICON.chev}${g.proj ? '<span class="sw"></span>' : ""}${esc(g.label)} <span class="n">${g.rows.length}</span>${dots}${extra}</button><div class="sec-b"></div>`;
      const body = sec.lastChild;
      for (const r of g.rows) body.append(rowCache.get(r.key).el);
      frag.append(sec);
    }
    // A live reorder glides (FLIP below); only a change you made replays the sections' entrance.
    box.classList.toggle("settled", !force);
    box.replaceChildren(frag);
    if (!rows.length) box.innerHTML = `<div class="empty-state">${S.rows.size ? "Nothing matches. Press Esc to clear the filter." : noHerdr() ? "herdr isn’t running on this machine yet. Open a terminal and run <code>herdr</code>, then start your agents inside it; they’ll show up here by themselves. New to herdr? See <a href=\"https://herdr.dev\" target=\"_blank\" rel=\"noopener\">herdr.dev</a>." : "No sessions yet. Press n to start one."}</div>`;
    if (before) flipRows(box, before);
    const born = box.querySelectorAll(".row.born");
    if (born.length) requestAnimationFrame(() => requestAnimationFrame(() => { for (const el of born) el.classList.remove("born"); }));
    S.visible = groups.flatMap((g) => (g.closed ? [] : g.rows));
  } else if (order !== lastOrder) {
    // Frozen: rows that went away leave, everything else holds its place, newcomers wait for the release.
    const shown = [...box.querySelectorAll(".row[data-key]")].map((el) => el.dataset.key);
    const { keys } = frozenOrder(shown, rows.map((r) => r.key));
    const keep = new Set(keys);
    for (const k of shown) if (!keep.has(k)) { box.querySelector(`.row[data-key="${CSS.escape(k)}"]`)?.remove(); lastOrder = "~" + lastOrder; }
    const open = new Set([...box.querySelectorAll(".sec:not(.closed) .row[data-key]")].map((el) => el.dataset.key));
    S.visible = keys.filter((k) => open.has(k)).map((k) => S.rows.get(k)).filter(Boolean);
  } else S.visible = groups.flatMap((g) => (g.closed ? [] : g.rows));
  if (app.classList.contains("list-off")) renderRail(rows);
  for (const k of S.picked) if (!S.rows.has(k)) S.picked.delete(k);
  $("selbar").hidden = !S.picked.size;
  if (S.picked.size) $("selInfo").textContent = `${S.picked.size} selected`;
}
/** Project initials for the rail: "herdr-deck" → "HD", "Conductor" → "Co". */
function initials(p) {
  const parts = String(p || "?").split(/[-_.\s]+/).filter(Boolean);
  return parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : parts[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}
function shortTitle(t) {
  const w = String(t || "").replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((x) => x.length > 2 && !/^(the|and|for|with|from|into)$/i.test(x));
  return w.slice(0, 2).join(" ") || t || "";
}
/** Collapsed list: a tile per session (project badge, status, a word of title, time), grouped by what needs you. */
function renderRail(rows) {
  const groups = { needs: [], running: [], quiet: [] };
  let hidden = 0;
  for (const r of rows) { const s = sectionOf(r); if (groups[s]) groups[s].push(r); else hidden++; }
  for (const g of Object.values(groups)) g.sort((a, b) => rank(a) - rank(b) || act(b) - act(a));
  const tile = (r) => {
    const subs = (r.subagents ?? []).filter((x) => x.running).length;
    const since = r.status === "working" && r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
    const tm = since ? `<span class="tm" data-since="${since}">${clock(Date.now() - since)}</span>` : r.status === "blocked" ? `<span class="tm">waiting</span>` : `<span class="tm" data-t="${r.lastActiveAt ?? ""}">${ago(r.lastActiveAt)}</span>`;
    const tip = `${r.title || r.agent}\n${r.project}${r.launch ? " (via " + r.launch + ")" : ""} · ${paneName(r)}${multiMachine() ? " · " + machineLabel(r.machine) : ""}\n${STATUS_NAME[r.status] ?? r.status}${r.now ? " · " + r.now : ""}${subs ? `\n${subs} subagent${subs === 1 ? "" : "s"} running` : ""}`;
    return `<button class="tile${S.sel === r.key && !S.board && !S.mode ? " sel" : ""}" data-key="${esc(r.key)}" data-status="${r.status}" style="--pc:${pc(r.project)};--c:${statusVar(r.status)}" title="${esc(tip)}"><span class="ab">${esc(initials(r.project))}</span>${r.status !== "idle" ? '<span class="sd"></span>' : ""}${subs ? `<span class="sb">+${subs}</span>` : ""}<span class="tt">${esc(shortTitle(r.title))}</span>${tm}</button>`;
  };
  const html = [["needs", "Needs you"], ["running", "Running"], ["quiet", "Quiet"]].filter(([k]) => groups[k].length)
    .map(([k, label]) => `<div class="mh">${label.split(" ")[0]} <span class="n">${groups[k].length}</span></div>${groups[k].map(tile).join("")}`).join("")
    + (hidden ? `<button class="more" data-railmore>+${hidden} stale or empty</button>` : "");
  setHTML($("mini"), html);
}
function renderFooter() {
  // Counted by the same rules as the list (machine tab and search), so the two never disagree.
  const all = [...S.rows.values()].filter(inScope);
  const shown = S.q ? visibleRows() : all;
  const kb = (rs) => rs.reduce((s, r) => s + (r.rssKB || 0), 0);
  const per = new Map();
  for (const r of shown) { const m = per.get(r.machine) ?? { n: 0, kb: 0 }; m.n++; m.kb += r.rssKB || 0; per.set(r.machine, m); }
  const tip = [...per].sort((a, b) => b[1].kb - a[1].kb).map(([id, m]) => `${machineLabel(id)}: ${m.n} session${m.n === 1 ? "" : "s"}${m.kb ? ` · ${mem(m.kb)}` : ""}`).join("\n")
    + "\n\nMemory is what the agents’ process trees use right now: each agent plus the builds, tests and servers it started. It rises and falls as they start and stop. The deck itself isn’t counted.";
  const count = S.q ? `<b>${shown.length}</b> of ${all.length} sessions` : `<b>${all.length}</b> session${all.length === 1 ? "" : "s"}`;
  const off = (S.summary.machines ?? []).filter((m) => !m.online);
  setHTML($("lf"), `<span class="lfn" title="${esc(tip)}">${count} · agents use ${mem(kb(shown))}</span>${off.length ? `<span class="warn" title="${esc(off.map((m) => m.label + ": " + (m.error ?? "")).join("\n"))}">${off.length} offline</span>` : ""}<span class="spacer"></span><button class="link" data-lf="closed">${S.view === "closed" ? "Sessions" : `Closed ${S.graveyard.length}`}</button><button class="link" data-lf="menu">Settings</button>`);
}
function renderClosed() {
  const box = $("rows");
  box.dataset.view = "closed";
  lastOrder = "";
  const q = S.q.toLowerCase();
  const list = S.graveyard.filter((g) => (S.machine === "all" || g.machine === S.machine) && (!q || [g.title, g.project, g.cwd].join(" ").toLowerCase().includes(q)));
  setHTML(box, `<div class="sec"><button class="sec-h" data-lf="inbox">${ICON.back}Back to sessions</button></div>` +
    (list.length ? list.map((g) => `<div class="row" data-grave="${esc(g.id)}"><span class="dot" style="--c:var(--empty)"></span><span class="pl"><span class="pj" style="--pc:${pc(g.project)}">${esc(g.project)}</span>${multiMachine() ? `<span class="mach">${esc(machineLabel(g.machine))}</span>` : ""}</span><span class="ago">${ago(g.closedAt)}</span>
      <span class="tl"><b>${esc(g.title || "(untitled)")}</b></span><span class="ln">closed ${esc(abs(g.closedAt))}</span>
      <span class="ln" style="margin-top:6px;display:flex;gap:4px">${g.resume ? `<button class="btn" data-gact="reopen">Reopen</button><button class="btn ghost" data-gact="copy">Copy resume</button>` : `<button class="btn" data-gact="reopen">New tab here</button>`}<button class="btn ghost" data-gact="forget">Remove</button></span></div>`).join("")
      : `<div class="empty-state">Sessions you close are kept here so you can reopen them.</div>`));
  $("selbar").hidden = true;
  setHTML($("mini"), "");
}
function setHTML(el, html) { if (el._h !== html) { el.innerHTML = html; el._h = html; } }
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-t]")) { const t = Number(el.dataset.t); if (t) el.textContent = el.dataset.why ? reasonLabel(el.dataset.why, t, now) : el.dataset.fmt === "long" ? agoText(t) : ago(t); }
}, 20000);
setInterval(() => { for (const el of document.querySelectorAll("[data-since]")) el.textContent = clock(Date.now() - Number(el.dataset.since)); }, 1000);

// ── session links ────────────────────────────────────────────────────────
// /s/<machine>/<agent>/<session id> follows the conversation even if its pane moves; shells link to their pane.
function linkPath(r) {
  if (!r) return "/";
  return r.sessionId ? `/s/${encodeURIComponent(r.machine)}/${encodeURIComponent(r.agent)}/${encodeURIComponent(r.sessionId)}` : `/s/${encodeURIComponent(r.machine)}/pane/${encodeURIComponent(r.key)}`;
}
const linkUrl = (r) => (S.publicUrl || location.origin) + linkPath(r);
function resolveLink(path) {
  const m = path.match(/^\/s\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [machine, agent, id] = m.slice(1).map(decodeURIComponent);
  if (agent === "pane") return S.rows.has(id) ? { key: id } : { missing: true };
  const r = [...S.rows.values()].find((x) => x.sessionId === id && (x.machine === machine || !machine)) ?? [...S.rows.values()].find((x) => x.sessionId === id);
  if (r) return { key: r.key };
  const g = S.graveyard.find((x) => x.resume && x.resume.includes(id));
  return { missing: true, grave: g };
}
function syncUrl() {
  const r = rowOf(S.sel);
  const path = S.board || !r ? "/" : linkPath(r);
  if (location.pathname !== path) history.replaceState(history.state, "", path);
}

// ── selection & detail data ──────────────────────────────────────────────
let briefTimer = null;
function select(key, opts = {}) {
  if (!key || !rowOf(key)) return;
  const changed = S.sel !== key;
  S.tab = tabAfterSelect(S.sel, key, S.tab);
  S.sel = key;
  S.board = false;
  S.mode = null;
  store("sel", key);
  if (changed) {
    S.sub = null;
    termText = ""; termHash = ""; $("screen").innerHTML = ""; headSig = ""; bodySig = "";
    $("cText").value = S.drafts?.get(key) ?? ""; autosize($("cText"));
    chatDom.key = null;
    chatSel.clear(); lastPicked = null; $("msgbar")?.remove(); $("detail").classList.remove("selecting");
  }
  const row = rowOf(key);
  if (row && unseenDone(row)) { row.seen = true; api("/api/seen", { key }).catch(() => {}); }
  render();
  loadDetail(key);
  pollTerm(true);
  chatTick(true);
  prefetchNeighbours(key);
  if (opts.scroll) requestAnimationFrame(() => rowCache.get(key)?.el.scrollIntoView({ block: "nearest" }));
  if (opts.open && isPhone()) setMView("detail", true);
  // Opening a session puts you straight in its message box (desktop; on a phone it would pop the keyboard).
  // The pane renders a frame or two later, so try for up to half a second.
  if (opts.open && !isPhone()) {
    let tries = 0;
    const go = () => {
      const t = $("cText");
      if (S.sel !== key || S.mode || document.querySelector("dialog[open]") || !t || t.disabled) return;
      if (!t.offsetParent) { if (++tries < 12) setTimeout(go, 40); return; }
      if (document.activeElement === t) return;
      t.focus({ preventScroll: true });
      t.setSelectionRange?.(t.value.length, t.value.length);
    };
    requestAnimationFrame(go);
  }
  syncUrl();
}
S.drafts = new Map();
const inflight = new Map();
async function loadDetail(key) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await api("/api/detail", { key });
      S.details.set(key, { data, stamp: rowOf(key)?.lastActiveAt, at: Date.now() });
      if (data.chat) mergeChat(key, data.chat);
      if (S.sel === key) { headSig = ""; bodySig = ""; renderDetail(); maybeAutoBrief(key); }
    } catch {}
    inflight.delete(key);
  })();
  inflight.set(key, p);
  return p;
}
/** Hovering or moving next to a session warms its detail, so opening it is instant. */
function prefetch(key) {
  const c = S.details.get(key);
  const r = rowOf(key);
  if (!r || (c && c.stamp === r.lastActiveAt && Date.now() - c.at < 60_000)) return;
  loadDetail(key);
}
function prefetchNeighbours(key) {
  const v = S.visible ?? [];
  const i = v.findIndex((r) => r.key === key);
  setTimeout(() => { for (const r of [v[i + 1], v[i - 1]]) if (r) prefetch(r.key); }, 250);
}
function maybeAutoBrief(key) {
  clearTimeout(briefTimer);
  const d = S.details.get(key)?.data;
  if (!S.autoBrief || !d || d.brief || !d.turns?.length || (d.asks ?? 0) < 2 || briefBusy.has(key)) return;
  briefTimer = setTimeout(() => { if (S.sel === key) writeBrief(key, true); }, 1400);
}

// ── chat engine ──────────────────────────────────────────────────────────
// Per conversation (session, or session#subagent): messages by index, a gen that voids old cursors,
// and pending sends shown until the transcript echoes them.
const chats = new Map();
const chatId = (key, sub) => (sub ? `${key}#${sub}` : key);
function chatOf(id) {
  let c = chats.get(id);
  if (!c) { c = { gen: null, total: 0, msgs: new Map(), first: Infinity, last: -1, pending: [], busy: false, v: 0 }; chats.set(id, c); }
  return c;
}
function mergeChat(key, slice, sub) {
  const c = chatOf(chatId(key, sub));
  if (c.gen !== slice.gen || slice.reset) { c.msgs.clear(); c.first = Infinity; c.last = -1; c.gen = slice.gen; if (S.sel === key) chatDom.key = null; }
  c.total = slice.total;
  for (const m of slice.messages) {
    c.msgs.set(m.i, m);
    c.first = Math.min(c.first, m.i);
    c.last = Math.max(c.last, m.i);
    if (m.role === "user" && c.pending.length) c.pending = c.pending.filter((p) => p.text.trim() !== String(m.text ?? "").trim());
  }
  c.pending = c.pending.filter((p) => Date.now() - p.at < 90_000);
  c.v++;
  if (S.sel === key && S.sub === (sub ?? null)) renderChat();
}
let chatTimer = null;
async function chatTick(now) {
  clearTimeout(chatTimer);
  const key = S.sel, sub = S.sub;
  const r = rowOf(key);
  if (!r) return;
  const visible = chatOn() && (isPhone() ? app.dataset.mview === "detail" : !(S.tpos === "tab" && S.main === "term"));
  const c = chatOf(chatId(key, sub));
  const live = r.status === "working" || r.status === "blocked" || (r.subagents ?? []).some((x) => x.running) || c.pending.length;
  if (visible && !document.hidden && !c.busy && r.sessionId) {
    const due = now === true || live || c.stamp !== r.lastActiveAt;
    if (due) {
      c.busy = true;
      c.stamp = r.lastActiveAt;
      try {
        const q = c.gen == null ? { key, sub, limit: 150 } : { key, sub, gen: c.gen, after: c.last };
        mergeChat(key, await api("/api/chat", q), sub);
      } catch {}
      c.busy = false;
    }
  }
  chatTimer = setTimeout(chatTick, live ? 900 : 2500);
}
async function loadGap(from, to) {
  const c = chatOf(chatId(S.sel, S.sub));
  try { mergeChat(S.sel, await api("/api/chat", { key: S.sel, sub: S.sub, gen: c.gen, from, to: Math.min(to, from + 150) }), S.sub); } catch (e) { toast(e.message, true); }
}
/** Open a session's chat at one message (from a search hit), highlighted. */
async function jumpTo(key, i) {
  if (S.sel !== key) select(key, { open: true });
  S.tab = "chat"; S.sub = null;
  const c = chatOf(chatId(key));
  // Hold the jump for a moment: the refreshes that follow opening a session must not scroll away from it.
  S.jump = { key, i, until: Date.now() + 3000, flashed: false };
  if (!c.msgs.has(i)) { try { mergeChat(key, await api("/api/chat", { key, around: i })); } catch { return; } }
  headSig = ""; bodySig = ""; renderDetail();
  applyJump();
}
function applyJump() {
  const j = S.jump;
  if (!j || j.key !== S.sel || Date.now() > j.until) { S.jump = null; return false; }
  const b = (chatDom.data ?? []).find((x) => x.ms.some((m) => m.i === j.i));
  const el = b && chatDom.blocks.find((o) => o.key === b.key)?.el;
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  if (!el.classList.contains("hl")) el.classList.add("hl"); // a redraw replaced the element: mark the new one too
  j.flashed = true;
  return true;
}
async function loadEarlier() {
  const c = chatOf(chatId(S.sel, S.sub));
  if (c.busy || !(c.first > 0) || c.gen == null) return;
  c.busy = true;
  const body = $("dbody");
  const h = body.scrollHeight, top = body.scrollTop;
  try {
    mergeChat(S.sel, await api("/api/chat", { key: S.sel, sub: S.sub, gen: c.gen, before: c.first, limit: 150 }), S.sub);
    body.scrollTop = top + (body.scrollHeight - h);
  } catch {}
  c.busy = false;
}

/** Messages → blocks: consecutive tool calls fold into one group; subagent calls get their own card. */
function chatBlocks(c) {
  const ms = [...c.msgs.values()].sort((a, b) => a.i - b.i);
  const blocks = [];
  let group = null;
  let prevI = null;
  for (const m of ms) {
    if (prevI != null && m.i - prevI > 1) { group = null; blocks.push({ key: "gap" + prevI, kind: "gap", ms: [{ i: prevI + 1, to: m.i }] }); }
    prevI = m.i;
    const agent = m.role === "tool" && /^(agent|task)$/i.test(m.tool ?? "");
    if (m.role === "tool" && !agent) {
      if (!group) { group = { key: "t" + m.i, kind: "tools", ms: [] }; blocks.push(group); }
      group.ms.push(m);
      continue;
    }
    group = null;
    blocks.push({ key: "m" + m.i, kind: agent ? "agent" : m.role, ms: [m] });
  }
  for (const p of c.pending) blocks.push({ key: "p" + p.at, kind: "pending", ms: [p] });
  return blocks;
}
const expanded = new Set();
const MSG_TOOLS = `<span class="mt"><button class="ib" data-copy title="Copy" aria-label="Copy">${'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5"/></svg>'}</button><button class="ib" data-pick title="Select (for copying several)" aria-label="Select"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5.5 8 2 2 3-4"/></svg></button></span>`;
function blockHTML(b, key) {
  const m = b.ms[0];
  const imgs = (list) => (list?.length ? `<div class="thumbs">${list.map((id) => `<button data-cimg="${esc(id)}"><img loading="lazy" decoding="async" alt="" src="${imgUrl(key, id, S.sub)}" onerror="this.parentElement.hidden=true"></button>`).join("")}</div>` : "");
  if (b.kind === "gap") return `<button class="gapbtn" data-gap="${m.i}" data-gapto="${m.to}">⋯ ${m.to - m.i} more messages here · show them</button>`;
  if (b.kind === "user" || b.kind === "pending") {
    const long = (m.text ?? "").length > 900;
    return `<div class="msg user${b.kind === "pending" ? " pending" : ""}">${MSG_TOOLS}<div class="body${long ? " clamp" : ""}" ${long ? "data-toggle" : ""}>${esc(m.text)}</div>${imgs(m.images)}<div class="t">${b.kind === "pending" ? "sending…" : esc(when(m.at))}</div></div>`;
  }
  if (b.kind === "assistant") return `<div class="msg assistant">${MSG_TOOLS}<div class="md">${md(m.text)}</div>${imgs(m.images)}<div class="t">${esc(when(m.at))}</div></div>`;
  if (b.kind === "note") return `<div class="note${/^Recap:/.test(m.text) ? " recap" : ""}">${/^Recap:/.test(m.text) ? mdLite(m.text) : esc(m.text)}</div>`;
  if (b.kind === "agent") {
    const d = S.details.get(S.sel)?.data;
    const sub = (d?.subagents ?? []).find((x) => x.id === m.sub) ?? (d?.subagents ?? []).find((x) => x.description && m.summary?.startsWith(x.description));
    const running = sub ? sub.running : m.state === "running";
    return `<button class="agent-card msg" ${sub ? `data-sub="${esc(sub.id)}"` : "disabled"}><span class="ic">${ICON.bot}</span><span class="d">${esc(sub?.description ?? m.summary ?? "Subagent")}</span>
      <span class="s">${running ? '<span class="spin"></span>running' : m.state === "error" ? "failed" : "done"}${sub?.tools ? ` · ${sub.tools} tools` : ""}</span>
      <span class="m${running && sub?.now ? " mono" : ""}">${running && sub?.now ? esc(sub.now) : esc([sub?.type ?? m.subType, sub?.model].filter(Boolean).join(" · ") || "subagent")}${sub ? " · open ›" : ""}</span></button>`;
  }
  // tool group
  const all = b.ms;
  const open = expanded.has(b.key) || all.length <= 4;
  const shown = open ? all : all.slice(-3);
  const line = (t) => { const w = toolWords(t.tool); const run = t.state === "running"; return `<div class="tool${run ? " run" : ""}${t.state === "error" ? " err" : ""}" title="${esc(t.tool)}">${toolIcon(w.k)}<span class="nm">${esc(run ? w.doing : w.done)}</span><span class="sm">${esc(t.summary ?? "")}</span>${run ? '<span class="spin"></span>' : t.state === "error" ? '<span class="x">failed</span>' : ""}</div>`; };
  const allImgs = all.flatMap((t) => t.images ?? []);
  return `<div class="tools msg">${MSG_TOOLS}${!open ? `<button class="fold" data-fold="${b.key}">▸ ${all.length - 3} earlier tool calls</button>` : all.length > 4 ? `<button class="fold" data-fold="${b.key}">▾ hide</button>` : ""}${shown.map(line).join("")}${imgs(allImgs.slice(-6))}</div>`;
}
const chatDom = { key: null, blocks: [], el: null };
/** The chat is what the detail body shows (not a view, the board, or another tab; empty tabs count as chat). */
const chatOn = () => !!S.sel && !S.board && !S.mode && effTab(S.tab, S.details.get(S.sel)?.data, S.simple) === "chat";
function renderChat() {
  const body = $("dbody");
  const key = S.sel;
  if (!key || !chatOn()) return;
  const id = chatId(key, S.sub);
  const c = chatOf(id);
  const r = rowOf(key);
  if (c.gen == null && !c.msgs.size && !c.pending.length) {
    // No conversation (a shell, or an agent that hasn't been asked anything yet): show the live terminal here.
    const noConv = r && !r.sessionId;
    const tail = noConv ? (r.tail ?? []).slice(-24).join("\n") : "";
    const k = id + ":loading:" + (noConv ? tail.length + ":" + tail.slice(-80) + termHidden() : "");
    if (chatDom.key !== k) {
      chatDom.key = k;
      body.innerHTML = noConv
        ? `<div class="chat noconv"><p class="hint">${r.agent === "shell" ? "A shell. Type a command below and press Enter." : r.empty ? `${esc(r.agent === "opencode" ? "OpenCode" : r.agent === "codex" ? "Codex" : r.agent === "claude" ? "Claude" : r.agent)} is ready. Send it a message below.` : "No conversation found for this pane. Here’s its terminal."}</p><pre class="dterm live">${ansi(tail) || "…"}</pre>${termHidden() || app.classList.contains("term-off") ? `<button class="btn" data-dact="showterm">${ICON.term}Open the terminal</button>` : ""}</div>`
        : `<div class="chat"><p class="hint">Loading the conversation…</p></div>`;
    }
    return;
  }
  const dref = S.details.get(key)?.data;
  const st = rowOf(key)?.status;
  if (chatDom.key === id && chatDom.v === c.v && chatDom.dref === dref && chatDom.st === st && chatDom.el && body.contains(chatDom.el)) return;
  chatDom.v = c.v; chatDom.dref = dref; chatDom.st = st;
  const blocks = chatBlocks(c);
  const nearBottom = scrollPin.stick;
  const rebuilt = chatDom.key !== id || !chatDom.el || !body.contains(chatDom.el);
  const anchor = !rebuilt && !nearBottom ? takeAnchor() : null;
  if (rebuilt) {
    chatDom.key = id;
    chatDom.blocks = [];
    const wrap = document.createElement("div");
    wrap.className = "chat";
    wrap.innerHTML = `<button class="btn ghost more" data-earlier ${c.first > 0 ? "" : "hidden"}>Load earlier messages</button>`;
    body.replaceChildren(wrap);
    chatDom.el = wrap;
    chatSizeObs.disconnect();
    chatSizeObs.observe(wrap);
  }
  const wrap = chatDom.el;
  wrap.querySelector("[data-earlier]").hidden = !(c.first > 0);
  const old = new Map(chatDom.blocks.map((b) => [b.key, b]));
  const next = [];
  let prevEl = wrap.querySelector("[data-earlier]");
  for (const b of blocks) {
    const sig = JSON.stringify(b.ms) + (b.kind === "agent" ? JSON.stringify(S.details.get(key)?.data?.subagents?.map((x) => [x.id, x.running, x.now, x.tools])) : "") + expanded.has(b.key);
    let o = old.get(b.key);
    if (!o || o.sig !== sig) {
      const t = document.createElement("template");
      t.innerHTML = blockHTML(b, key).trim();
      const el = t.content.firstElementChild;
      el.dataset.b = b.key;
      if (o) o.el.replaceWith(el);
      else if (chatDom.fresh === id) el.classList.add("enter"); // new while you watch: ease it in
      o = { key: b.key, sig, el };
    }
    o.el.classList.toggle("picked", chatSel.has(b.key));
    if (prevEl.nextElementSibling !== o.el) prevEl.after(o.el);
    prevEl = o.el;
    old.delete(b.key);
    next.push(o);
  }
  for (const o of old.values()) o.el.remove();
  chatDom.blocks = next;
  chatDom.data = blocks;
  decorateLatest(wrap, blocks, rowOf(key));
  const grew = next.length && next[next.length - 1].key !== chatDom.lastKey;
  chatDom.lastKey = next[next.length - 1]?.key;
  if (applyJump()) { chatDom.fresh = id; scrollPin.stick = false; }
  else if (chatDom.fresh !== id) { chatDom.fresh = id; toBottom(); }
  else if (nearBottom) toBottom();
  else { restoreAnchor(anchor); if (grew) scrollPin.unread++; }
  renderJumpBtn();
}
/** Only the newest agent message is actionable: its choices become buttons, a closing question gets quick replies. */
function decorateLatest(wrap, blocks, r) {
  wrap.querySelector(".quick")?.remove();
  wrap.querySelector(".thinking")?.remove();
  for (const el of wrap.querySelectorAll(".choices.pickable")) el.classList.remove("pickable");
  if (!r || S.sub) return;
  for (const el of wrap.querySelectorAll(".choices")) el.classList.toggle("can", !r.app && isAgent(r));
  const canSend = !r.app && isAgent(r) && r.status !== "working";
  const lastAsst = [...blocks].reverse().find((b) => b.kind === "assistant");
  const tailBlock = blocks[blocks.length - 1];
  const lastEl = lastAsst && chatDom.blocks.find((o) => o.key === lastAsst.key)?.el;
  if (lastEl && canSend && tailBlock === lastAsst) {
    const ch = lastEl.querySelector(".choices");
    if (ch) ch.classList.add("pickable");
    else {
      const text = String(lastAsst.ms[0].text ?? "").trim();
      const q = text.split(/\n\s*\n/).pop() ?? "";
      if (/\?\s*\**\s*$/.test(q) && /\b(should|shall|want|do you|would you|can i|may i|ok to|okay to|go ahead|proceed|ready)\b/i.test(q)) {
        const d = document.createElement("div");
        d.className = "quick";
        d.innerHTML = ["Yes, go ahead", "No, not now", "Tell me more first"].map((t) => `<button class="btn" data-quick="${esc(t)}">${esc(t)}</button>`).join("");
        lastEl.after(d);
      }
    }
  }
  // A turn is running but nothing has come back yet: say so, in the chat, where you're looking.
  if (r.status === "working" && tailBlock && (tailBlock.kind === "user" || tailBlock.kind === "pending")) {
    const d = document.createElement("div");
    d.className = "thinking";
    d.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>${esc(r.agent === "claude" ? "Claude" : r.agent === "codex" ? "Codex" : r.agent)} is thinking`;
    wrap.append(d);
  }
}

// ── copy & select messages ───────────────────────────────────────────────
const chatSel = new Set();
function blockText(b, withHeader) {
  const r = rowOf(S.sel);
  const who = b.kind === "user" || b.kind === "pending" ? "You" : b.kind === "assistant" ? (r?.agent === "claude" ? "Claude" : r?.agent === "codex" ? "Codex" : r?.agent ?? "Agent") : b.kind === "tools" ? "Tools" : "Note";
  const body = b.kind === "tools" ? b.ms.map((t) => `${toolWords(t.tool).done} ${t.summary ?? ""}`.trim()).join("\n")
    : b.kind === "agent" ? `Subagent: ${b.ms[0].summary ?? ""}` : String(b.ms[0].text ?? "");
  return withHeader ? `**${who}**${b.ms[0].at ? ` (${when(b.ms[0].at)})` : ""}\n${body}` : body;
}
function copyBlocks(keys) {
  const blocks = (chatDom.data ?? []).filter((b) => keys.includes(b.key));
  if (!blocks.length) return;
  copy(blocks.length === 1 ? blockText(blocks[0], false) : blocks.map((b) => blockText(b, true)).join("\n\n"), blocks.length === 1 ? "message" : `${blocks.length} messages`);
}
let lastPicked = null;
function pickBlock(key, range) {
  const keys = (chatDom.data ?? []).map((b) => b.key);
  if (range && lastPicked && keys.includes(lastPicked)) {
    const [a, z] = [keys.indexOf(lastPicked), keys.indexOf(key)].sort((x, y) => x - y);
    for (const k of keys.slice(a, z + 1)) chatSel.add(k);
  } else chatSel.has(key) ? chatSel.delete(key) : chatSel.add(key);
  lastPicked = key;
  renderSelBar();
}
function renderSelBar() {
  for (const o of chatDom.blocks) o.el.classList.toggle("picked", chatSel.has(o.key));
  $("detail").classList.toggle("selecting", chatSel.size > 0);
  let bar = $("msgbar");
  if (!chatSel.size) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "msgbar"; bar.className = "msgbar"; $("composer").before(bar); }
  bar.innerHTML = `<b>${chatSel.size}</b> selected <span class="hint">· shift-click to select a range</span><span class="spacer"></span><button class="btn primary" data-selcopy>Copy</button><button class="btn ghost" data-selall>All</button><button class="btn ghost" data-selclear>Clear</button>`;
}
function clearPicks() { chatSel.clear(); lastPicked = null; renderSelBar(); }

// ── keeping your place ───────────────────────────────────────────────────
// At the bottom, the chat stays pinned there as messages arrive and images load. Scrolled up, the
// message you're reading stays exactly where it is, whatever changes above or below it.
const scrollPin = { stick: true, unread: 0, anchor: null, expect: null };
/** The deck's own scrolls are recorded, so the scroll handler can tell them from yours. */
function setScroll(top) { const b = $("dbody"); b.scrollTop = top; scrollPin.expect = b.scrollTop; }
function takeAnchor() {
  const body = $("dbody"), top = body.getBoundingClientRect().top;
  for (const o of chatDom.blocks ?? []) {
    const r = o.el.getBoundingClientRect();
    if (r.bottom > top + 8) return { key: o.key, off: r.top - top };
  }
  return null;
}
function restoreAnchor(a) {
  if (!a) return;
  const body = $("dbody");
  const el = chatDom.blocks?.find((o) => o.key === a.key)?.el;
  if (!el?.isConnected) return;
  const delta = el.getBoundingClientRect().top - body.getBoundingClientRect().top - a.off;
  if (Math.abs(delta) > 0.5) setScroll(body.scrollTop + delta);
}
function toBottom(smooth) {
  const body = $("dbody");
  scrollPin.stick = true; scrollPin.unread = 0;
  // While a smooth scroll is in flight its own scroll events mustn't unpin it (and redraws keep pinning).
  if (smooth) { scrollPin.expect = null; scrollPin.flying = Date.now() + 700; body.scrollTo({ top: body.scrollHeight, behavior: "smooth" }); } else setScroll(body.scrollHeight);
  renderJumpBtn();
}
function renderJumpBtn() {
  const btn = $("jumpBottom");
  if (!btn) return;
  const show = chatOn() && !scrollPin.stick && !!chatDom.el;
  btn.hidden = !show;
  if (show) btn.style.bottom = Math.max(14, $("detail").getBoundingClientRect().bottom - $("dbody").getBoundingClientRect().bottom + 14) + "px";
  btn.classList.toggle("has-new", scrollPin.unread > 0);
  btn.querySelector(".n").textContent = scrollPin.unread ? (scrollPin.unread > 9 ? "9+" : String(scrollPin.unread)) : "";
}
$("jumpBottom")?.addEventListener("click", () => toBottom(true));
$("dbody").addEventListener("scroll", () => {
  const body = $("dbody");
  const gap = body.scrollHeight - body.scrollTop - body.clientHeight;
  const mine = scrollPin.expect != null && Math.abs(body.scrollTop - scrollPin.expect) < 2;
  scrollPin.expect = null;
  if (scrollPin.flying && Date.now() < scrollPin.flying) { if (gap < 2) scrollPin.flying = 0; }
  else if (!mine) scrollPin.stick = gap < 40;
  scrollPin.anchor = scrollPin.stick ? null : takeAnchor();
  if (scrollPin.stick) scrollPin.unread = 0;
  if (chatOn() && body.scrollTop < 240) loadEarlier();
  renderJumpBtn();
}, { passive: true });
// Late layout (images, code blocks, fonts): stay pinned, or keep the anchor still.
new ResizeObserver(() => {
  if (!chatOn() || !chatDom.el) return;
  if (scrollPin.stick) setScroll($("dbody").scrollHeight);
  else if (scrollPin.anchor) restoreAnchor(scrollPin.anchor);
}).observe($("dbody"));
const chatSizeObs = new ResizeObserver(() => {
  if (!chatOn() || !chatDom.el) return;
  if (scrollPin.stick) setScroll($("dbody").scrollHeight);
  else if (scrollPin.anchor) restoreAnchor(scrollPin.anchor);
});

// ── session pane ─────────────────────────────────────────────────────────
let headSig = "", bodySig = "";
function renderDetail() {
  const r = rowOf(S.sel);
  const d = S.details.get(S.sel)?.data;
  if (S.mode) return renderMode();
  $("dbody")._mode = null;
  if (S.board || !r) return renderBoard();
  $("dh").hidden = false;
  const tab = effTab(S.tab, d, S.simple);
  const hs = JSON.stringify([r.title, r.project, r.launch, r.status, r.model, r.branch, r.dirty, r.tab, r.tabNumber, r.cwd, r.check?.state, r.check?.cmd, r.check?.at, r.ports, r.lastActiveAt, r.duplicate, r.machine, d?.asks, d?.imagesTotal, d?.subagents?.length, d?.subagents?.filter((x) => x.running).length, tab, S.tpos, S.main, S.sub, S.summary.machines?.length, radarChip(r)]);
  if (hs !== headSig) { headSig = hs; renderHead(r, d, tab); }
  const cached = S.details.get(S.sel);
  if (cached && cached.stamp !== r.lastActiveAt && !inflight.has(r.key)) { clearTimeout(renderDetail.t); renderDetail.t = setTimeout(() => loadDetail(r.key), 700); }
  renderNowbar(r, d);
  renderAsk(r);
  $("composer").hidden = !r || S.sub != null || !!r.app || !!r.hist;
  $("appbar").hidden = !(r.app || r.hist) || S.sub != null;
  renderStatusLine(r);
  if (r.hist) setHTML($("appbar"), `<span>A past session${r.startedAt ? ` · started <b>${esc(DF.format(new Date(r.startedAt)))}</b>` : ""}${r.lastActiveAt ? ` · last active ${esc(agoText(r.lastActiveAt))}` : ""}${multiMachine() ? ` · ${esc(machineLabel(r.machine))}` : ""}</span><span class="spacer"></span><button class="btn primary" data-dact="histresume" title="Resume it in a new herdr tab">${ICON.term}Resume in herdr</button><button class="btn ghost" data-dact="backhist">${ICON.back} History</button>`);
  else if (r.app) setHTML($("appbar"), `<span>${r.status === "working" ? '<span class="spin" style="vertical-align:-1px"></span> Working in the Codex app' : "This thread lives in the Codex app"}${!(S.summary.machines ?? []).find((m) => m.kind === "app")?.online ? " (the app isn’t running)" : ""}.</span><span class="spacer"></span><button class="btn primary" data-dact="codexopen">${ICON.jump}Open in Codex</button><button class="btn" data-dact="codexresume" title="Resume it with the Codex CLI in a new herdr tab">${ICON.term}Continue in herdr</button><button class="btn ghost" data-dact="codexhide" title="Hide it from the deck (it stays in the app)">Hide</button>`);
  $("cStop").hidden = !(r.status === "working" && isAgent(r));
  const busy = r.status === "working" && isAgent(r);
  $("cSend").textContent = "Send";
  $("cSend").title = busy ? "Send now; the agent picks it up while it works (⌥Enter: hold it until it finishes)" : "Send (Enter)";
  $("cSteer").hidden = true;
  renderQueue(r);
  renderPastes();
  $("cText").placeholder = r.agent === "shell" ? "Run a command" : r.status === "blocked" ? "Answer, or use the keys above" : `Message ${r.agent === "claude" ? "Claude" : r.agent === "codex" ? "Codex" : r.agent === "opencode" ? "OpenCode" : r.agent}`;
  $("replyText").placeholder = $("cText").placeholder;
  $("tTitle").textContent = r.title || r.agent;
  $("mTitle").innerHTML = `<span class="dot" style="--c:${statusVar(r.status)}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(r.title || r.agent)}</span>`;
  $("subcrumb").hidden = !S.sub;
  if (S.sub) {
    const sub = d?.subagents?.find((x) => x.id === S.sub);
    setHTML($("subcrumb"), `<button class="btn ghost" data-dact="unsub">${ICON.back} Main conversation</button><span>${ICON.bot.replace("<svg", '<svg style="width:15px;height:15px;vertical-align:-3px"')} <b>${esc(sub?.description ?? "Subagent")}</b></span><span class="hint">${esc([sub?.type, sub?.model].filter(Boolean).join(" · "))}${sub?.running ? " · running" : ""}</span>`);
  }
  if (tab === "chat") {
    if (bodySig !== "chat") { bodySig = "chat"; chatDom.key = null; chatDom.fresh = null; }
    renderChat();
    return;
  }
  const bs = JSON.stringify([tab, r.key, d, r.subagents, briefBusy.has(r.key)]);
  if (bs === bodySig && $("dbody").firstElementChild?.classList.contains("pad")) return;
  bodySig = bs;
  chatDom.key = null;
  const box = $("dbody");
  const scroll = box.scrollTop;
  box.innerHTML = `<div class="pad">${!d ? `<p class="hint">Reading the conversation…</p>` : tab === "images" ? imagesHTML(r, d) : tab === "info" ? factsHTML(r, d) : tab === "agents" ? agentsHTML(d) : aboutHTML(r, d)}</div>`;
  box.scrollTop = scroll;
}
function renderHead(r, d, tab) {
  // Title first, then one compact meta row: the signals that matter (status, uncommitted work, proof of done) lead.
  const where = [r.launch ? `via ${r.launch}` : "", home(r.cwd), r.app ? "Codex app" : r.hist ? "past session" : `herdr ${paneName(r)}`].filter(Boolean).join(" · ");
  const meta = [
    `<span class="pill" style="--c:${statusVar(r.status)}">${STATUS_NAME[r.status] ?? esc(r.status)}</span>`,
    radarChip(r),
    `<span class="pj" style="--pc:${pc(r.project)}" title="${esc(where)}">${esc(r.project)}</span>`,
    r.dirty ? `<span class="wchip" title="${esc(`${r.dirty} file${r.dirty === 1 ? "" : "s"} changed and not committed${r.branch ? ` on ${r.branch}` : ""}`)}">${ICON.warn}${esc(dirtyText(r.dirty))}</span>` : "",
    r.check ? checkChip(r.check, r.project) : "",
    r.duplicate ? `<span class="wchip" title="Two panes are attached to this one conversation">${ICON.warn}duplicate</span>` : "",
    ...(r.ports ?? []).map((p) => p.url
      ? `<span class="portw"><a class="port on" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open on your tailnet: ${esc(p.url)}">${ICON.globe}${esc(String(p.port))} ↗</a><button class="port-x" data-dact="unshare" data-port="${p.port}" title="Stop sharing">×</button></span>`
      : `<button class="port" data-dact="share" data-port="${p.port}" title="${esc(p.cmd)} is serving on :${p.port}. Share it on your tailnet">${ICON.globe}:${p.port} · share</button>`),
    r.branch ? `<span class="mono br" title="Branch">${esc(r.branch)}</span>` : "",
    `<span class="ag">${esc(r.agent)}${r.model ? ` · ${esc(r.model.replace(/^claude-/, ""))}` : ""}</span>`,
    multiMachine() ? `<span class="opt">${esc(machineLabel(r.machine))}</span>` : "",
    r.lastActiveAt ? `<span class="opt" title="Last active ${esc(abs(r.lastActiveAt))}">active <b data-t="${r.lastActiveAt}" data-fmt="long">${agoText(r.lastActiveAt)}</b></span>` : "",
  ].filter(Boolean).join("");
  const subsRun = d?.subagents?.filter((x) => x.running).length;
  const tabs = [["chat", "Chat"], ["agents", "Subagents", d?.subagents?.length, subsRun], ["about", "About"], ["images", "Images", d?.imagesTotal], ["info", "Info"]]
    .filter(([k, , n]) => (k !== "images" && k !== "agents") || n)
    .map(([k, label, n, run]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${n ? ` <span class="n">${run ? `${run} running · ` : ""}${n}</span>` : ""}</button>`).join("");
  const swap = S.tpos === "tab" ? `<div class="seg2"><button data-main="chat" aria-selected="${S.main === "chat"}">Chat</button><button data-main="term" aria-selected="${S.main === "term"}">Terminal</button></div>` : "";
  setHTML($("dh"), `<div class="dh-top"><h1 class="dh-title" title="${esc(r.title || "")}">${esc(r.title || "(untitled)")}</h1>
      <div class="dh-acts"><button class="ib desk" data-dact="home" aria-label="Home" title="Home: the live board (Esc)">${ICON.home}</button>${r.hist ? `<button class="btn" data-dact="backhist">${ICON.back} History</button><button class="btn primary" data-dact="histresume">${ICON.term}Resume</button>` : r.app ? `<button class="btn" data-dact="codexopen" title="Open this thread in the Codex app">${ICON.jump}Open in Codex</button>` : `${termHidden() ? `<button class="btn desk" data-dact="showterm" title="Show the terminal (t)">${ICON.term}Terminal</button>` : ""}<button class="btn" data-dact="tools" title="Tools (.)">${ICON.bolt}Tools</button><button class="btn desk" data-dact="focus" title="Switch herdr to this pane (f)">${ICON.jump}Jump</button>`}<button class="ib" data-dact="link" aria-label="Copy a link to this session" title="Copy link (y)">${ICON.link}</button><button class="ib" data-dact="more" aria-label="More actions" title="More">${ICON.more}</button></div></div>
    <div class="dh-meta">${meta}</div>
    <nav class="tabsbar" role="tablist">${tabs}${swap}</nav>`);
}
function renderNowbar(r, d) {
  const el = $("nowbar");
  const subs = (r.subagents ?? []).filter((x) => x.running);
  const on = r.status === "working" && !S.sub;
  el.hidden = !on;
  if (!on) return;
  const since = r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
  const prog = r.todos?.total ? `<span class="prog" title="${r.todos.done} of ${r.todos.total} steps done"><i style="width:${Math.round((100 * r.todos.done) / r.todos.total)}%"></i></span><span class="stp">${r.todos.done}/${r.todos.total}</span>` : "";
  setHTML(el, `<span class="spin"></span><span>Working${since ? ` <b data-since="${since}">${clock(Date.now() - since)}</b>` : ""}</span>${prog}<span class="what">${r.step ? `<span class="step">${esc(r.step)}</span>` : ""}${esc(r.now ? nowWords(r.now) : r.step ? "" : "thinking…")}</span>${subs.length ? `<button class="btn ghost" data-tab="agents" style="padding:2px 8px">${ICON.bot}${subs.length} subagent${subs.length === 1 ? "" : "s"}</button>` : ""}`);
}
let askTimer = null, askHash = "";
async function renderAsk(r) {
  const el = $("askbox");
  const on = r.status === "blocked" && !S.sub && !S.board && (!isPhone() || app.dataset.mview === "detail");
  if (!on) { el.hidden = true; clearTimeout(askTimer); askHash = ""; return; }
  if (el.hidden) { el.hidden = false; el.innerHTML = `<pre>…</pre><div class="ks">${["1", "2", "3", "y", "n", "enter", "esc", "up", "down"].map((k) => `<button data-akey="${k}">${k}</button>`).join("")}</div>`; }
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
$("appbar").addEventListener("click", (e) => {
  const act = e.target.closest("[data-dact]")?.dataset.dact;
  const r = rowOf(S.sel);
  if (!r || !act) return;
  e.stopPropagation();
  if (act === "histresume") return resumeHist(r);
  if (act === "backhist") return setMode("history");
  if (act === "codexopen") codexAct("codex-open", r);
  if (act === "codexresume") codexAct("codex-resume", r);
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
  if (d.turns?.length) {
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
function agentsHTML(d) {
  const subs = [...(d.subagents ?? [])].sort((a, b) => Number(b.running) - Number(a.running) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return `<p class="hint" style="margin:0">${subs.length} subagent${subs.length === 1 ? "" : "s"}${subs.some((x) => x.running) ? `, ${subs.filter((x) => x.running).length} running now` : ""}. Open one to read its whole conversation.</p>
    <table class="subtable">${subs.map((x) => `<tr data-sub="${esc(x.id)}"><td style="width:18px">${x.running ? '<span class="spin"></span>' : '<span class="dot" style="--c:var(--idle)"></span>'}</td><td><b>${esc(x.description ?? x.id)}</b><div class="hint">${esc([x.type, x.model, x.tools ? `${x.tools} tool calls` : ""].filter(Boolean).join(" · "))}</div>${x.running && x.now ? `<div class="mono hint" style="font-size:12px">${esc(x.now)}</div>` : ""}</td><td class="hint" style="white-space:nowrap;text-align:right">${esc(when(x.startedAt))}<br>${x.running ? "running" : "done " + esc(agoText(x.lastActiveAt))}</td></tr>`).join("")}</table>`;
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
      <div class="ti">${esc(r.title || r.agent)} <span class="hint">${paneTag(r)}</span></div>
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
  $("tTitle").textContent = "Terminal";
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

// ── sending ──────────────────────────────────────────────────────────────
function autosize(el) { el.style.height = ""; el.style.height = Math.min(el.scrollHeight, innerHeight * 0.34) + "px"; }
async function sendMessage(text, fromEl, how) {
  const key = S.sel;
  const r = rowOf(key);
  if (!r) return;
  const pastes = fromEl === $("cText") ? takePastes(key) : [];
  if (!text && !pastes.length) return;
  // Long text travels as a file: pasted blocks, and anything too big to type into a terminal.
  if (pastes.length || text.length > LONG_SEND) {
    try { text = await fileLongText(r, text, pastes); }
    catch (x) { restorePastes(key, pastes); toast("Couldn’t save the long text: " + x.message, true); return; }
  }
  if (how === "later" && r.status === "working" && isAgent(r)) {
    fromEl.value = ""; autosize(fromEl); S.drafts.delete(key); closeSlash();
    try { await api("/api/queue", { op: "add", key, text }); toast("Queued. It goes when the agent finishes this turn."); }
    catch (x) { fromEl.value = text; toast("Couldn’t queue: " + x.message, true); }
    return;
  }
  closeSlash();
  const c = chatOf(chatId(key));
  const p = { role: "user", text, at: Date.now() };
  if (isAgent(r)) { c.pending.push(p); c.v++; S.sub = null; if (S.tab !== "chat") { S.tab = "chat"; store("tab2", S.tab); } renderDetail(); $("dbody").scrollTop = $("dbody").scrollHeight; }
  fromEl.value = ""; autosize(fromEl); S.drafts.delete(key);
  try {
    await api("/api/send", { key, text });
    setTimeout(() => chatTick(true), 250);
    setTimeout(pollTerm, 150);
  } catch (x) {
    c.pending = c.pending.filter((q) => q !== p);
    c.v++;
    fromEl.value = text;
    renderChat();
    toast("Send failed: " + x.message, true);
  }
}
$("composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage($("cText").value.trim(), $("cText"), e.submitter?.id === "cSteer" ? "steer" : undefined); });
$("reply").addEventListener("submit", (e) => { e.preventDefault(); sendMessage($("replyText").value.trim(), $("replyText")); });
for (const [id, form] of [["cText", "composer"], ["replyText", "reply"]]) {
  $(id).addEventListener("input", (e) => { autosize(e.target); if (S.sel) S.drafts.set(S.sel, e.target.value); });
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.altKey && !e.isComposing) { e.preventDefault(); return sendMessage(e.target.value.trim(), e.target, "later"); }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isPhone()) { e.preventDefault(); $(form).requestSubmit(); }
    if (e.key === "Escape") e.target.blur();
  });
}
$("cRecipe").onclick = (e) => openToolMenu(e.currentTarget, true);
$("cSteer").onclick = () => sendMessage($("cText").value.trim(), $("cText"), "steer");
$("cStop").onclick = () => S.sel && api("/api/keys", { key: S.sel, keys: ["esc"] }).then(() => toast("Sent Esc to interrupt")).catch((x) => toast(x.message, true));
function focusReply() {
  if (isPhone()) { if (app.dataset.mview !== "detail") { history.replaceState({ mview: "detail" }, ""); setMView("detail", false); } }
  else if (S.tpos === "tab" && S.main === "term") setMain("chat");
  if (S.tab !== "chat") { S.tab = "chat"; store("tab2", S.tab); renderDetail(); }
  S.board = false;
  $("cText").focus();
}

// A chat image that won't load usually means its transcript was rewritten under us: the server has
// dropped the stale parse, so reload the conversation once to get fresh image ids.
let imgRetry = 0;
document.addEventListener("error", (e) => {
  const el = e.target;
  if (el?.tagName !== "IMG" || !String(el.src).includes("/api/image") || Date.now() - imgRetry < 15_000) return;
  imgRetry = Date.now();
  const id = chatId(S.sel, S.sub);
  chats.delete?.(id);
  chatDom.key = null;
  setTimeout(() => chatTick(true), 300);
}, true);

// ── queued messages ──────────────────────────────────────────────────────
// While an agent works, Enter queues (the hub sends it when the turn ends); Steer (⌘Enter) sends now.
function renderQueue(r) {
  const q = (S.queue ?? {})[r?.key] ?? [];
  const el = $("qbar");
  if (!q.length || !r || S.mode || S.sub) { el.hidden = true; el._h = ""; return; }
  el.hidden = false;
  setHTML(el, q.map((x, i) => `<div class="qi" data-qid="${esc(x.id)}"><span class="qn">${i === 0 ? (r.status === "working" ? "Next" : "Sending…") : i + 1}</span><span class="qt" title="${esc(x.text.slice(0, 600))}">${esc(x.text.replace(/\s+/g, " ").slice(0, 160))}</span><button class="ib" data-qact="edit" title="Edit">${ICON.note}</button><button class="btn ghost sm" data-qact="now" title="Send it now (steer)">Send now</button><button class="ib" data-qact="remove" title="Remove">${ICON.x}</button></div>`).join(""));
}
$("qbar").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-qact]");
  if (!b) return;
  const id = b.closest("[data-qid]").dataset.qid, key = S.sel, act = b.dataset.qact;
  const it = (S.queue[key] ?? []).find((x) => x.id === id);
  try {
    if (act === "edit") {
      const text = await askDialog({ title: "Edit queued message", input: it?.text ?? "", ok: "Save", multiline: true });
      if (text != null) await api("/api/queue", { op: "update", key, id, text });
    } else await api("/api/queue", { op: act, key, id });
    if (act === "now") toast("Sent");
  } catch (x) { toast(x.message, true); }
});

// ── long pastes: a chip, not a wall of text ──────────────────────────────
// Big pastes become chips; on send each one is saved as a file on the session's machine and the
// agent gets the path (the way Claude Code itself handles long pastes). Anything else over the limit too.
const LONG_PASTE_CHARS = 4000, LONG_PASTE_LINES = 40, LONG_SEND = 12000, MAX_PASTE = 20 * 1024 * 1024;
S.pastes = new Map(); // session key → [{ id, text, name }]
const pasteList = (key = S.sel) => S.pastes.get(key) ?? [];
function takePastes(key) { const l = pasteList(key); S.pastes.delete(key); renderPastes(); return l; }
function restorePastes(key, l) { if (l.length) { S.pastes.set(key, [...l, ...pasteList(key)]); renderPastes(); } }
function pasteKind(t) {
  const s = t.trimStart();
  if (/^[\[{]/.test(s)) { try { JSON.parse(t); return "json"; } catch {} }
  if (/^(diff --git|--- a\/|@@ )/m.test(s.slice(0, 400))) return "diff";
  if (/^(\s*at |Traceback|\w+Error:|\[\d{2}:\d{2}|\d{4}-\d{2}-\d{2}[ T]\d{2}:)/m.test(s.slice(0, 2000))) return "log";
  if (/^#{1,3} |\n#{1,3} |\*\*|^- /m.test(s.slice(0, 3000))) return "md";
  return "txt";
}
function addPaste(text) {
  if (text.length > MAX_PASTE) return toast("That’s over 20 MB; attach it as a file instead", true);
  const l = pasteList();
  const kind = pasteKind(text);
  l.push({ id: Math.random().toString(36).slice(2, 8), text, name: `pasted-${l.length + 1}.${kind}`, kind });
  S.pastes.set(S.sel, l);
  renderPastes();
}
function renderPastes() {
  const el = $("cAtt");
  const l = S.sel ? pasteList() : [];
  el.hidden = !l.length;
  setHTML(el, l.map((p) => { const lines = p.text.split("\n").length; return `<span class="pchip" data-pid="${p.id}"><span class="pk">${esc(p.kind.toUpperCase())}</span><button class="pl" data-pact="view" title="Preview">Pasted text · ${lines.toLocaleString()} lines · ${p.text.length < 1024 * 1024 ? Math.max(1, Math.round(p.text.length / 1024)) + " KB" : (p.text.length / 1048576).toFixed(1) + " MB"}</button><button class="ib" data-pact="inline" title="Put the text in the message instead">${ICON.note}</button><button class="ib" data-pact="remove" title="Remove">${ICON.x}</button></span>`; }).join("") + (l.length ? `<span class="hint">Sent as ${l.length > 1 ? "files" : "a file"} the agent reads</span>` : ""));
}
$("cAtt").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pact]");
  if (!b) return;
  const id = b.closest("[data-pid]").dataset.pid, l = pasteList(), p = l.find((x) => x.id === id);
  if (!p) return;
  if (b.dataset.pact === "remove") S.pastes.set(S.sel, l.filter((x) => x !== p));
  if (b.dataset.pact === "inline") { S.pastes.set(S.sel, l.filter((x) => x !== p)); const ta = $("cText"); ta.value = ta.value ? `${ta.value}\n${p.text}` : p.text; autosize(ta); }
  if (b.dataset.pact === "view") {
    const d = document.createElement("dialog"); d.className = "ask wide";
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${esc(p.name)} <span class="hint">${p.text.split("\n").length.toLocaleString()} lines</span></h3><pre class="pview">${esc(p.text.slice(0, 200_000))}${p.text.length > 200_000 ? "\n…" : ""}</pre></div><div class="dlg-f"><button class="btn primary" value="ok">Done</button></div></form>`;
    document.body.append(d); d.addEventListener("close", () => d.remove()); d.showModal();
  }
  renderPastes();
});
/** Saves pasted blocks (and a too-long message) next to the session and returns the message the agent gets. */
async function fileLongText(r, text, pastes) {
  const blocks = [...pastes];
  if (text.length > LONG_SEND) { blocks.unshift({ text, name: "message.md", kind: "md" }); text = ""; }
  const refs = [];
  for (const [i, p] of blocks.entries()) {
    const res = await fetch(`/api/upload?key=${encodeURIComponent(r.key)}&name=${encodeURIComponent(p.name)}`, { method: "POST", headers: { "x-deck-token": S.token, "content-type": "text/plain;charset=utf-8" }, body: new Blob([p.text], { type: "text/plain" }) });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error ?? res.statusText);
    const lines = p.text.split("\n").length;
    refs.push(p.name === "message.md" ? `[My full message is in ${j.path} (${lines} lines). Read it first.]` : `[Pasted text #${i + 1}: ${lines} lines, saved at ${j.path}. Read it.]`);
  }
  return [text, ...refs].filter(Boolean).join("\n\n");
}

// ── "/" menu: the agent's own commands, plus deck tools ──────────────────
const slash = { cache: new Map(), open: false, idx: 0, items: [] };
function closeSlash() { slash.open = false; $("slashPop").hidden = true; }
async function slashFor(r) {
  const k = `${r.machine}|${r.agent}|${r.projectRoot ?? r.cwd}`;
  if (!slash.cache.has(k)) slash.cache.set(k, api("/api/slash", { key: r.key }).then((x) => x.commands ?? []).catch(() => []));
  return slash.cache.get(k);
}
async function updateSlash() {
  const ta = $("cText"), r = rowOf(S.sel);
  const m = ta.value.match(/^\/([\w:.\-]*)$/);
  if (!m || !r || !isAgent(r) || r.app) return closeSlash();
  const q = m[1].toLowerCase();
  const cmds = await slashFor(r);
  if (ta.value.match(/^\/([\w:.\-]*)$/)?.[1].toLowerCase() !== q) return;
  const score = (c) => { const n = c.cmd.slice(1).toLowerCase(); if (!q) return 1; if (n === q) return 100; if (n.startsWith(q)) return 60 - n.length / 10; const seg = n.split(/[:\-]/); if (seg.some((x) => x.startsWith(q))) return 40; if (n.includes(q)) return 20; return (c.desc ?? "").toLowerCase().includes(q) ? 5 : 0; };
  const srcRank = { project: 0, yours: 1, "built-in": 2, prompt: 2, skill: 3, plugin: 4 };
  const agentItems = cmds.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || srcRank[a.c.src] - srcRank[b.c.src] || a.c.cmd.localeCompare(b.c.cmd)).slice(0, 40).map((x) => ({ ...x.c, type: "cmd" }));
  const tools = S.tools.filter((t) => t.action !== "upload" && (!q || fuzzy(`${t.label} ${t.hint ?? ""}`, q))).slice(0, q ? 4 : 3).map((t) => ({ type: "tool", tool: t, cmd: t.label, desc: t.hint }));
  slash.items = [...agentItems, ...tools];
  slash.idx = 0;
  slash.open = slash.items.length > 0;
  renderSlash(r);
}
function renderSlash(r) {
  const el = $("slashPop");
  if (!slash.open) { el.hidden = true; return; }
  el.hidden = false;
  const who = r.agent === "claude" ? "Claude Code" : r.agent === "codex" ? "Codex" : "OpenCode";
  let lastType = "";
  el.innerHTML = slash.items.map((it, i) => {
    const head = it.type !== lastType ? `<div class="sh">${it.type === "cmd" ? `${who} commands` : "Deck tools"}</div>` : "";
    lastType = it.type;
    return `${head}<button type="button" role="option" class="si${i === slash.idx ? " on" : ""}" data-si="${i}" aria-selected="${i === slash.idx}">${it.type === "tool" ? `<span class="sg">${toolGlyph(it.tool)}</span>` : ""}<b>${esc(it.cmd)}</b>${it.hint ? `<span class="shint">${esc(it.hint)}</span>` : ""}<span class="sd">${esc(it.desc ?? "")}</span>${it.src && it.src !== "built-in" ? `<span class="ssrc">${esc(it.src)}</span>` : ""}</button>`;
  }).join("");
  el.querySelector(".si.on")?.scrollIntoView({ block: "nearest" });
}
function chooseSlash(i, send) {
  const it = slash.items[i];
  if (!it) return;
  const ta = $("cText");
  closeSlash();
  if (it.type === "tool") { ta.value = ""; autosize(ta); return runTool(it.tool); }
  ta.value = it.cmd + " ";
  autosize(ta);
  ta.focus();
  if (send && !it.hint) sendMessage(it.cmd, ta);
}
$("cText").addEventListener("input", () => { renderPastes(); updateSlash(); });
$("cText").addEventListener("keydown", (e) => {
  if (!slash.open) return;
  const n = slash.items.length;
  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { slash.idx = (slash.idx + 1) % n; renderSlash(rowOf(S.sel)); }
  else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { slash.idx = (slash.idx - 1 + n) % n; renderSlash(rowOf(S.sel)); }
  else if (e.key === "Tab") chooseSlash(slash.idx, false);
  else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) chooseSlash(slash.idx, true);
  else if (e.key === "Escape") closeSlash();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
$("slashPop").addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the box
$("slashPop").addEventListener("click", (e) => { const b = e.target.closest("[data-si]"); if (b) chooseSlash(Number(b.dataset.si), true); });
$("cText").addEventListener("blur", () => setTimeout(closeSlash, 120));

// ── rename: the herdr pane, and the agent's own /rename ──────────────────
async function renameSession(r) {
  if (!r || r.app || r.hist) return;
  const agentName = r.agent === "claude" ? "Claude Code" : r.agent === "codex" ? "Codex" : null;
  const label = await askDialog({ title: "Rename session", text: `Renames the herdr pane${r.tabPanes <= 1 ? " and tab" : ""}${agentName ? `, and runs /rename in ${agentName} so its own history shows the name too` : ""}.`, input: r.title || r.tab || "", ok: "Rename" });
  if (label == null || !label.trim()) return;
  try {
    const res = await api("/api/rename", { key: r.key, label: label.trim() });
    if (res.slash) {
      if (res.busy) { await api("/api/queue", { op: "add", key: r.key, text: res.slash }); toast(`Renamed. ${agentName} gets /rename when it finishes this turn.`); }
      else { await api("/api/send", { key: r.key, text: res.slash }); toast(`Renamed to “${label.trim()}”`); }
    } else toast(`Renamed to “${label.trim()}”`);
    headSig = "";
  } catch (x) { toast(x.message, true); }
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
  d.addEventListener("close", () => d.remove());
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
  render(); renderDetail();
  toast(on ? "Simple mode on. Settings → Simple mode turns it off." : "Simple mode off");
}

// ── terminal ─────────────────────────────────────────────────────────────
let termTimer = null, termText = "", termHash = "", typing = false;
/** Out of sight with no handle on screen: hidden, or collapsed while docked on the right. */
const termHidden = () => !S.simple && (S.tpos === "none" || (S.tpos === "right" && app.classList.contains("term-off")));
const termVisible = () => (isPhone() ? app.dataset.mview === "term" : S.tpos === "none" ? false : S.tpos === "tab" ? S.main === "term" : !app.classList.contains("term-off"));
const showTerminal = () => {
  if (app.classList.contains("term-off")) { app.classList.remove("term-off"); store("termOff", false); }
  setTpos(S.tpos === "none" ? load("lastTpos", "bottom") : S.tpos);
  headSig = ""; renderDetail(); pollTerm(true);
};
async function pollTerm(first) {
  clearTimeout(termTimer);
  const key = S.sel;
  if (!key || !S.rows.has(key)) return;
  const r = rowOf(key);
  if (r.app) {
    $("screen").textContent = "This thread runs in the Codex app, so it has no terminal here.\nUse “Continue in herdr” to resume it in a terminal tab.";
    termText = ""; termHash = "";
    return;
  }
  if (!document.hidden && termVisible()) {
    try {
      const res = await api("/api/read", { key, lines: 400, hash: first === true ? "" : termHash });
      if (S.sel !== key) return;
      if (!res.same) {
        termHash = res.hash;
        termText = res.text;
        const el = $("screen");
        const atBottom = first === true || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        let text = res.text.replace(/\s+$/, "");
        if (isPhone()) { const cols = Math.max(20, Math.floor((el.clientWidth - 24) / 6.9)); text = text.replace(/[─━═▀▄_]{24,}/g, (m) => m.slice(0, cols)); }
        el.innerHTML = ansi(text);
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
    } catch {}
  }
  fitTerm();
  termTimer = setTimeout(pollTerm, typing ? 150 : r.status === "working" ? 500 : 1400);
}
function fitTerm() {
  const r = rowOf(S.sel);
  const el = $("screen");
  if (isPhone()) { el.style.fontSize = ""; return; }
  let size = 12.5;
  if (S.fit && r?.cols && el.clientWidth) size = Math.max(8, Math.min(13.5, (el.clientWidth - 26) / (r.cols * 0.6)));
  const v = size.toFixed(2) + "px";
  if (el.style.fontSize !== v) el.style.fontSize = v;
}
const KEYMAP = { Enter: "enter", Escape: "esc", Backspace: "backspace", Tab: "tab", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
let typeOps = [], typeTimer = null;
function queueType(op) {
  const last = typeOps[typeOps.length - 1];
  if (op.text && last?.text !== undefined) last.text += op.text; else typeOps.push(op);
  if (!typeTimer) typeTimer = setTimeout(flushType, 25);
}
async function flushType() {
  typeTimer = null;
  const ops = typeOps; typeOps = [];
  if (!ops.length || !S.sel) return;
  try { await api("/api/type", { key: S.sel, ops }); } catch (e) { toast("Typing failed: " + e.message, true); }
  setTimeout(pollTerm, 40);
}
$("screen").addEventListener("focus", () => { if (isPhone()) return; typing = true; $("term").classList.add("typing"); $("tMode").textContent = "· typing into the pane, Ctrl+] to stop"; pollTerm(); });
$("screen").addEventListener("blur", () => { typing = false; $("term").classList.remove("typing"); $("tMode").textContent = "· click to type into it"; });
$("screen").addEventListener("keydown", (e) => {
  if (e.metaKey || isPhone()) return;
  if (e.ctrlKey && e.key === "]") { e.preventDefault(); $("screen").blur(); return; }
  let op = null;
  if (KEYMAP[e.key]) op = { keys: [(e.shiftKey && e.key === "Tab" ? "shift+" : "") + KEYMAP[e.key]] };
  else if (/^F\d{1,2}$/.test(e.key)) op = { keys: [e.key.toLowerCase()] };
  else if (e.ctrlKey && e.key.length === 1) op = { keys: ["ctrl+" + e.key.toLowerCase()] };
  else if (e.altKey && e.code?.startsWith("Key")) op = { keys: ["alt+" + e.code.slice(3).toLowerCase()] };
  else if (e.key.length === 1) op = { text: e.key };
  if (!op) return;
  e.preventDefault();
  queueType(op);
});
$("screen").addEventListener("paste", (e) => { if (isPhone()) return; const t = e.clipboardData?.getData("text/plain"); if (t) { e.preventDefault(); queueType({ text: t }); } });
$("keys").innerHTML = ["esc", "enter", "ctrl+c", "up", "down", "tab", "1", "2", "3", "y", "n"].map((k) => `<button data-key="${k}" title="Send ${k}">${k}</button>`).join("");
$("keys").addEventListener("click", (e) => {
  const k = e.target.closest("[data-key]")?.dataset.key;
  if (k && S.sel) api("/api/keys", { key: S.sel, keys: [k] }).then(() => setTimeout(pollTerm, 60)).catch((x) => toast(x.message, true));
});
$("keysBtn").onclick = () => { const on = $("keys").hidden; $("keys").hidden = !on; $("keysBtn").setAttribute("aria-expanded", on); };

const PAL16 = ["#1c1f24", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#c8ccd4", "#5c6370", "#ff7b86", "#b5e890", "#ffd580", "#82c4ff", "#dd9cf0", "#7bd6e0", "#ffffff"];
function c256(n) {
  if (n < 16) return PAL16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const s = [0, 95, 135, 175, 215, 255];
  return `rgb(${s[Math.floor(n / 36)]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`;
}
function ansi(text) {
  let out = "", st = {}, open = false, last = 0, m;
  const re = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;
  const style = () => {
    const css = [];
    let fg = st.fg, bg = st.bg;
    if (st.inv) [fg, bg] = [bg ?? "var(--term-bg)", fg ?? "var(--term-ink)"];
    if (fg) css.push("color:" + fg);
    if (bg) css.push("background:" + bg);
    if (st.b) css.push("font-weight:600");
    if (st.d) css.push("opacity:.6");
    if (st.i) css.push("font-style:italic");
    if (st.u) css.push("text-decoration:underline");
    return css.join(";");
  };
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    const p = (m[1] || "0").split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) st = {};
      else if (c === 1) st.b = 1; else if (c === 2) st.d = 1; else if (c === 3) st.i = 1; else if (c === 4) st.u = 1; else if (c === 7) st.inv = 1;
      else if (c === 22) { st.b = 0; st.d = 0; } else if (c === 23) st.i = 0; else if (c === 24) st.u = 0; else if (c === 27) st.inv = 0;
      else if (c >= 30 && c <= 37) st.fg = PAL16[c - 30]; else if (c >= 90 && c <= 97) st.fg = PAL16[c - 82];
      else if (c >= 40 && c <= 47) st.bg = PAL16[c - 40]; else if (c >= 100 && c <= 107) st.bg = PAL16[c - 92];
      else if (c === 39) st.fg = null; else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && p[i + 1] === 5) { st[c === 38 ? "fg" : "bg"] = c256(p[i + 2]); i += 2; }
      else if ((c === 38 || c === 48) && p[i + 1] === 2) { st[c === 38 ? "fg" : "bg"] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
    }
    if (open) out += "</span>";
    const css = style();
    open = !!css;
    if (css) out += `<span style="${css}">`;
  }
  out += esc(text.slice(last));
  if (open) out += "</span>";
  return out;
}

// ── layout: where the terminal lives ─────────────────────────────────────
const TPOS = ["bottom", "right", "top", "tab", "none"];
const TPOS_NAME = { bottom: "Bottom", right: "Right", top: "Top", tab: "Shared with chat", none: "Hidden" };
function setTpos(p) {
  if (!TPOS.includes(p)) return;
  if (p !== "none") store("lastTpos", p);
  S.tpos = p; store("tpos", p); app.dataset.tpos = p;
  if (p === "tab" && app.classList.contains("term-off")) { app.classList.remove("term-off"); store("termOff", false); }
  $("tMain").hidden = p !== "tab";
  $("termToggle").hidden = p === "tab" || p === "none";
  $("splitH").setAttribute("aria-orientation", p === "right" ? "vertical" : "horizontal");
  headSig = "";
  render();
  requestAnimationFrame(() => { fitTerm(); pollTerm(); chatTick(true); });
}
function setMain(m) {
  S.main = m; store("main", m); app.dataset.main = m;
  for (const b of $("tMain").children) b.setAttribute("aria-selected", b.dataset.main === m);
  headSig = "";
  render();
  if (m === "term") pollTerm(true); else chatTick(true);
}
function layoutMenu(anchor) {
  openMenu(anchor, TPOS.map((p) => ({ html: `Terminal: ${TPOS_NAME[p]}${p === "tab" ? "<small>Switch between them with `</small>" : ""}`, on: S.tpos === p, run: () => setTpos(p) })), "Move the terminal (or drag its handle)");
}
$("layoutBtn").onclick = (e) => layoutMenu(e.currentTarget);
$("termHide").onclick = () => { setTpos("none"); toast("Terminal hidden. Bring it back with the Terminal button or \\"); };
$("tMain").addEventListener("click", (e) => { const m = e.target.closest("button[data-main]")?.dataset.main; if (m) setMain(m); });
// Drag the terminal's handle onto a drop zone to move it.
$("tGrip").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const listW = $("list").getBoundingClientRect().right;
  const mx = listW + 12, mw = innerWidth - listW - 24, mh = innerHeight;
  const zones = {
    top: [mx, 12, mw, mh * 0.2],
    bottom: [mx, mh * 0.8 - 12, mw, mh * 0.2],
    right: [mx + mw * 0.72, mh * 0.24, mw * 0.28, mh * 0.52],
    tab: [mx + mw * 0.2, mh * 0.3, mw * 0.44, mh * 0.4],
  };
  for (const el of $("dz").children) {
    const [x, y, w, h] = zones[el.dataset.pos];
    Object.assign(el.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  }
  document.body.classList.add("moving");
  let target = null;
  const move = (ev) => {
    target = null;
    for (const el of $("dz").children) {
      const b = el.getBoundingClientRect();
      const on = ev.clientX >= b.left && ev.clientX <= b.right && ev.clientY >= b.top && ev.clientY <= b.bottom;
      el.classList.toggle("on", on);
      if (on) target = el.dataset.pos;
    }
  };
  const up = () => {
    document.body.classList.remove("moving");
    for (const el of $("dz").children) el.classList.remove("on");
    removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
    if (target) { setTpos(target); if (target === "tab") setMain("term"); toast(`Terminal: ${TPOS_NAME[target].toLowerCase()}`); }
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
});

// ── actions ──────────────────────────────────────────────────────────────
async function api(path, body, timeoutMs) {
  let res;
  try { res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-deck-token": S.token }, body: JSON.stringify(body), signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined }); }
  catch (e) { if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error("That took too long. Try again in a moment."); throw e; }
  if (res.status === 403) { reconnectSoon(200); throw new Error("Reconnecting to the deck…"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
let toastTimer;
function toast(msg, err) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.setAttribute("role", "status"); document.body.append(t); }
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), err ? 7000 : 2400);
}
async function copy(text, what) { try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`); } catch { toast("The browser blocked clipboard access", true); } }
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
  d.onclose = async () => {
    if (d.returnValue !== "ok") return;
    try {
      const { results } = await api("/api/close", { keys: rows.map((r) => r.key), wholeTab: $("cWhole").checked });
      const failed = results.filter((x) => !x.ok);
      for (const x of results) if (x.ok) S.picked.delete(x.key);
      toast(failed.length ? `Closed ${results.length - failed.length}; ${failed.length} failed: ${failed[0].error}` : `Closed ${results.length}`, !!failed.length);
      render();
    } catch (e) { toast("Close failed: " + e.message, true); }
  };
  d.showModal();
  $("cOk").focus();
}
async function focusPane(key) { try { await api("/api/focus", { key, raise: true }); toast("Switched herdr to this pane"); } catch (e) { toast("Couldn’t switch: " + e.message, true); } }
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
  play: TI2('<path d="M5 3.5v9l7.5-4.5z"/>'),
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
  items.push("-",
    cell(ICON.plug, "Connections", "Tell this agent what it can use: deploy targets, APIs, MCP servers…", () => openConnections(S.sel)),
    cell(ICON.clip, "Attach files", "Or drop / paste them into the chat", pickFiles),
    cell(ICON.tools, "Manage tools", "What each tool sends; add your own", () => setMode("tools")));
  openMenu(anchor, items, n > 1 ? `Tools for ${n} selected sessions` : "Tools", compact ? "grid up" : "grid");
}

// ── a small promise-based dialog (no browser pop-ups) ────────────────────
function askDialog({ title, text = "", input, ok = "OK", danger = false, multiline = false }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "ask";
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${esc(title)}</h3>${text ? `<p class="hint" style="white-space:pre-wrap">${esc(text)}</p>` : ""}${input != null ? (multiline ? `<textarea class="inp" rows="4">${esc(input)}</textarea>` : `<input class="inp" value="${esc(input)}">`) : ""}</div><div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" value="ok">${esc(ok)}</button></div></form>`;
    document.body.append(d);
    d.addEventListener("close", () => { const v = d.returnValue === "ok" ? (input != null ? d.querySelector(".inp").value : true) : null; d.remove(); resolve(v); });
    d.showModal();
    d.querySelector(".inp")?.select?.();
  });
}

// ── views: inbox, history, tools, connections ────────────────────────────
function setMode(m) {
  if (m === "inbox" && S.mode !== "inbox") { S.ifocus = null; S.ifocusIdx = 0; } // the first card has the focus ring on open
  S.mode = m;
  S.board = false;
  headSig = ""; bodySig = ""; chatDom.key = null;
  if (m === "history" && !S.histRes) loadHistory();
  if (m === "connections") loadConnections();
  if (m === "discover") loadDiscover();
  if (m === "inbox" && S.jevOpen) loadJevStats(true);
  if (isPhone() && m) setMView("detail", true);
  render();
  renderDetail();
  renderViews();
}
function renderViews() {
  const el = $("views");
  if (!el) return;
  const n = (S.decisions ?? []).filter((d) => !S.done.has(d.key)).length;
  const v = [["inbox", "Inbox", ICON.inbox, n], ["history", "History", ICON.history], ["discover", "Discover", ICON.compass]];
  setHTML(el, v.map(([id, label, icon, count]) => `<button data-view="${id}" aria-pressed="${S.mode === id}" title="${label}${id === "inbox" ? " (i)" : id === "history" ? " (h)" : id === "discover" ? " (d)" : ""}">${icon}<span>${label}</span>${count ? `<b>${count}</b>` : ""}</button>`).join(""));
}
function renderMode() {
  $("dh").hidden = true; $("nowbar").hidden = true; $("askbox").hidden = true; $("composer").hidden = true; $("subcrumb").hidden = true; $("appbar").hidden = true;
  $("statusline").hidden = true; $("jumpBottom").hidden = true;
  chatDom.key = null;
  if (S.mode === "inbox") renderInbox();
  else if (S.mode === "history") renderHistory();
  else if (S.mode === "tools") renderTools();
  else if (S.mode === "connections") renderConnections();
  else if (S.mode === "discover") renderDiscover();
}
function modeHTML(html) {
  const box = $("dbody");
  if (box._mode !== S.mode || !box.querySelector(":scope > .view")) { box.innerHTML = `<button class="vclose" data-vclose title="Close (Esc)" aria-label="Close">${ICON.x}</button><div class="view" data-view="${S.mode}"></div>`; box._mode = S.mode; box._board = ""; box.scrollTop = 0; }
  setHTML(box.querySelector(".view"), html);
}
$("dbody").addEventListener("click", (e) => { if (e.target.closest("[data-vclose]")) { e.stopPropagation(); setMode(null); } }, true);

// Inbox ────────────────────────────────────────────────────────────────────
S.inboxFilter = load("inboxFilter", "all");
const KIND = { prompt: ["Needs permission", "blocked"], question: ["Asks you", "done"], review: ["Says it’s done", "working"] };
function checkChip(c, project) {
  const m = checkInfo(c, project);
  return m ? `<button class="chk ${m.cls}" data-dact="check" title="${esc(m.tip)}${c.at ? ` · ${esc(agoText(c.at))}` : ""}">${m.cls === "ask" ? ICON.check : ""}${esc(m.label)}</button>` : "";
}
function jevLine(d) {
  const j = d.jev;
  if (!j || j.state === "skipped") return "";
  if (j.state === "pending") return `<div class="jev pending"><span class="spin"></span> Jev is looking…</div>`;
  if (d.kind === "review" && j.done != null) {
    const p = Math.round(j.done * 100);
    const cls = p >= 70 ? "ok" : p >= 40 ? "mid" : "bad";
    return `<div class="jev ${cls}"><span class="jb">Jev</span> ${p}% really done${j.next ? ` · suggests <b>${j.next === "accept" ? "accept" : j.next === "send_back" ? "send it back" : "ask a question"}</b>` : ""}</div>`;
  }
  if (j.pick != null) return `<div class="jev"><span class="jb">Jev</span> would pick <b>${esc(String(j.pick).toUpperCase())}</b>${j.pickP != null ? ` (${Math.round(j.pickP * 100)}%)` : ""}${j.low != null ? ` · ${j.low >= 0.7 ? "low stakes" : j.low < 0.35 ? "<b>high stakes</b>" : "medium stakes"}` : ""}${riskChip(j)}</div>`;
  return "";
}
/** How reversible Jev thinks the terminal prompt is, as a small chip (deck-prompt only; nothing when the risk feature is off or Jev skipped). */
function riskChip(j) {
  if (j.risk == null) return "";
  if (j.riskP != null && j.riskP < 0.5) return ` <span class="risk unclear">risk unclear</span>`;
  const label = j.risk === "read_only" ? "read-only" : j.risk === "reversible" ? "reversible" : "irreversible";
  return ` <span class="risk${j.risk === "irreversible" ? " irr" : ""}">${esc(label)}</span>`;
}
// <inbox-keys> Pure: what a triage key means on a decision. No DOM, no globals (test/inbox-keys.test.ts runs this block).
const YES_RE = /^\W*(yes|y|allow|approve|accept|ok|okay|confirm|proceed|continue|go ahead|trust|sure)\b/i;
const NO_RE = /^\W*(no|n|deny|reject|decline|cancel|don['’]?t|do not|exit|abort|stop)\b/i;
/** The option `y` (want "yes") or `n` (want "no") answers with: the first yes-/no-worded option; for yes, else the recommended one. */
function yesNoOption(d, want) {
  const opts = d?.options ?? [];
  const re = want === "yes" ? YES_RE : NO_RE;
  return opts.find((o) => re.test(String(o.title ?? ""))) ?? (want === "yes" ? opts.find((o) => o.rec) : undefined);
}
/** { opt } answers with an option, { act } runs a card action, { miss } explains why the key does nothing here, null: not a card key. */
function inboxKey(d, k) {
  if (!d) return null;
  const n = d.options?.length ?? 0;
  if (/^[1-9]$/.test(k)) { const o = d.options?.[Number(k) - 1]; return o ? { opt: o } : { miss: n ? `This one has ${n} option${n === 1 ? "" : "s"}` : "No options here: y, n, v or r" }; }
  if (k === "y" || k === "n") {
    if (d.kind === "review") return { act: k === "y" ? "accept" : "sendback" };
    const o = yesNoOption(d, k === "y" ? "yes" : "no");
    return o ? { opt: o } : { miss: `No clear ${k === "y" ? "yes" : "no"} option here: pick with 1–${Math.min(n, 9)}` };
  }
  if (k === "v") return d.kind === "review" ? { act: "verify" } : { miss: "Verify is for finished work" };
  if (k === "r") return { act: "reply" };
  if (k === "o" || k === "Enter") return { act: "open" };
  if (k === "s" || k === "x") return { act: "skip" };
  return null;
}
// </inbox-keys>
const kh = (k) => `<kbd class="kh" aria-hidden="true">${k}</kbd>`;
function decisionCard(d) {
  const r = rowOf(d.key);
  if (!r) return "";
  const [kindLabel, kindVar] = d.kind === "review" && !d.claim ? ["Finished", "idle"] : KIND[d.kind];
  const pick = d.jev?.pick;
  const yes = yesNoOption(d, "yes"), no = yesNoOption(d, "no");
  // The badge is the key that picks it (1–9); an agent's own letter stays visible beside the title.
  const opts = d.options.map((o, i) => `<button class="dopt${o.rec ? " rec" : ""}${o === yes ? " isyes" : ""}${pick === o.id ? " jevpick" : ""}" data-dopt="${esc(o.id)}"><span class="ol">${i < 9 ? i + 1 : esc(String(o.id).toUpperCase())}</span><span class="ob"><span class="ot">${/^[a-h]$/i.test(o.id) ? `<span class="oid">${esc(o.id.toUpperCase())}</span>` : ""}${inline(o.title)}${o.rec ? '<span class="rp">Recommended</span>' : ""}${pick === o.id ? '<span class="rp jevp">Jev</span>' : ""}</span>${o.detail ? `<span class="od">${inline(o.detail)}</span>` : ""}</span>${o === yes ? kh("y") : o === no ? kh("n") : ""}</button>`).join("");
  const c = r.check;
  const check = d.kind === "review" ? (c?.state === "needs-approval"
    ? `<div class="dcheck ask">The deck can re-run this project’s checks to prove it: <code>${esc(c.cmd)}</code><span class="spacer"></span><button class="btn primary" data-dcheck="allow">Allow for ${esc(r.project)}</button><button class="btn" data-dcheck="edit">Edit…</button><button class="btn ghost" data-dcheck="never">Never</button></div>`
    : c && c.state !== "skipped" ? `<div class="dcheck ${c.state}">${c.state === "pass" ? "✓" : c.state === "fail" ? "✗" : '<span class="spin"></span>'} <code>${esc(c.cmd ?? "")}</code> ${c.state === "pass" ? `passed${c.ms ? ` in ${Math.round(c.ms / 1000)}s` : ""}` : c.state === "fail" ? `failed (exit ${c.exit})` : c.state}${c.at && (c.state === "pass" || c.state === "fail") ? ` · ${esc(agoText(c.at))}` : ""}${c.tail?.length && c.state === "fail" ? `<details><summary>Output</summary><pre>${esc(c.tail.slice(-25).join("\n"))}</pre></details>` : ""}</div>` : "") : "";
  const acts = d.kind === "review"
    ? `<button class="btn primary" data-dact2="accept">${ICON.check}Looks good${kh("y")}</button><button class="btn" data-dact2="sendback">Send back…${kh("n")}</button><button class="btn" data-dact2="verify">Verify now${kh("v")}</button><button class="btn ghost" data-dact2="reply">Reply…${kh("r")}</button>`
    : `<button class="btn ghost" data-dact2="reply">Something else…${kh("r")}</button>${d.kind === "prompt" ? `<button class="btn ghost" data-dact2="term">Show terminal</button>` : ""}`;
  return `<article class="dcard" data-dkey="${esc(d.key)}" data-kind="${d.kind}" style="--pc:${pc(r.project)};--kc:var(--${kindVar})">
    <header><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span><span class="dk">${kindLabel}</span>${multiMachine() ? `<span class="hint">${esc(machineLabel(r.machine))}</span>` : ""}<span class="dhr"><span class="hint" data-t="${d.at}">${esc(agoText(d.at))}</span><button class="dskip" data-dact2="skip" title="Hide it for now without answering (s)">Skip${kh("s")}</button><button class="ib" data-dact2="open" title="Open the session (o)">${ICON.jump}</button></span></header>
    <div class="dtitle">${esc(r.title)} <span class="hint">${paneTag(r)}</span></div>
    <div class="dq">${inline(d.question)}</div>
    ${d.context && d.kind !== "prompt" ? `<details class="dctx"><summary>Context</summary><div class="md">${md(d.context)}</div></details>` : d.kind === "prompt" ? `<pre class="dterm">${ansi((r.tail ?? []).slice(-6).join("\n"))}</pre>` : ""}
    ${jevLine(d)}
    ${opts ? `<div class="dopts">${opts}</div>` : ""}
    ${check}
    <div class="dacts">${acts}</div>
    <form class="dreply" hidden><textarea rows="2" placeholder="Reply to the agent"></textarea><button class="btn primary">Send</button></form>
  </article>`;
}
// Jev panel: what the suggestions cost and how often they matched what you did (from ~/.jev receipts).
S.jevOpen = load("jevOpen", false);
let jevLoading = 0;
async function loadJevStats(force) {
  if (!force && Date.now() - jevLoading < 4000) return;
  jevLoading = Date.now();
  try { S.jevStats = await api("/api/jev/stats", {}); S.jevErr = null; } catch (e) { S.jevErr = e.message; }
  if (S.mode === "inbox") renderInbox();
}
const money = (n) => (n == null ? "–" : n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const ktok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n ?? 0));
const pctOf = (r) => (r == null ? "–" : `${Math.round(r * 100)}%`);
function jevBar(j) {
  const label = j.available ? `Jev · ${j.calls ?? 0}/${j.cap ?? "–"} today` : "Jev is off on this machine";
  return `<div class="jevbar"><button class="jevtog" data-jevtog aria-expanded="${!!S.jevOpen}"><span class="jb">Jev</span>${esc(label.replace(/^Jev · /, ""))}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button></div>${S.jevOpen ? jevPanel(S.jevStats, j) : ""}`;
}
// What each Jev feature sends, so you can switch off any of them.
const JEV_FEATS = [
  ["risk", "Risk level on permission prompts", "adds one question to the prompt check it already sends"],
  ["radar", "Stuck radar", "sends the last tool calls of a running session when it looks stuck"],
  ["route", "Send by description", "sends your message and your sessions' titles when you ask it to route"],
];
function jevPanel(st, j) {
  if (!st) return `<section class="jevp"><p class="hint">${S.jevErr ? esc(S.jevErr) : "Reading the receipts…"}</p></section>`;
  const span = (t, x) => `<div class="jst"><span class="jl">${t}</span><b>${x.calls}</b><span>call${x.calls === 1 ? "" : "s"}</span><span class="jm">${ktok(x.inputTokens)} tok · ${money(x.cost)}</span>${x.repeats ? `<span class="jm jwarn" title="Asked again with the exact same state (before the dedupe fix)">${x.repeats} repeat${x.repeats === 1 ? "" : "s"}</span>` : ""}</div>`;
  const KN = { prompt: "Permissions", question: "Questions", done: "Done?" };
  const hitRow = (k) => { const h = st.hit[k]; return `<div class="jhr"><span>${KN[k]}</span><span class="jbarv"><i style="width:${h.n ? Math.round((h.hits / h.n) * 100) : 0}%"></i></span><b>${h.n ? pctOf(h.rate) : "–"}</b><span class="jm">${h.hits}/${h.n}</span></div>`; };
  const cal = (rows, verb) => rows.map((b) => `<span class="jcal"><b>${esc(b.band)}</b> ${b.n ? `${verb} ${b.accepted ?? b.hits}/${b.n}` : "none yet"}</span>`).join("");
  const KS = { prompt: "Permission", question: "Question", done: "Done?" };
  const recent = st.recent.length ? st.recent.map((x) => {
    const mark = x.followed == null ? `<span class="jno"></span>` : x.followed ? `<span class="jok" title="You did what Jev suggested">✓</span>` : `<span class="jx" title="You did something else">✗</span>`;
    const rep = x.repeats ? ` <span class="jwarn" title="Asked ${x.repeats + 1} times with the same state (before the dedupe fix)">×${x.repeats + 1}</span>` : "";
    return `<li><span class="jt" data-t="${x.at}">${esc(agoText(x.at))}</span><span class="jk">${KS[x.kind]}${rep}</span><span class="jq">${x.label ? esc(x.label) : `<span class="hint">–</span>`}</span><span class="js">Jev <b>${esc(x.suggestion)}</b>${x.pickTitle ? ` <span class="hint">${esc(x.pickTitle)}</span>` : ""}</span><span class="ja">${x.actual ? `You <b>${esc(x.actual)}</b>${x.actualTitle ? ` <span class="hint">${esc(x.actualTitle)}</span>` : ""}` : `<span class="hint">no answer recorded</span>`}</span>${mark}</li>`;
  }).join("") : `<li class="hint">No deck decisions in the receipts yet.</li>`;
  const cap = st.cap;
  const feats = JEV_FEATS.map(([k, title, sends]) => `<label class="nchk"><input type="checkbox" data-jevfeat="${k}" ${j.features?.[k] !== false ? "checked" : ""}><span><b>${title}</b><small>${sends}</small></span></label>`).join("");
  return `<section class="jevp" aria-label="Jev">
    <div class="jgrid">${span("Today", st.today)}${span("7 days", st.week)}${span("All time", st.total)}</div>
    <div class="jcols">
      <div><h4>Matched what you did <span class="hint">${st.hit.all.n ? `${pctOf(st.hit.all.rate)} of ${st.hit.all.n}` : ""}</span></h4>${["prompt", "question", "done"].map(hitRow).join("")}</div>
      <div><h4>Calibration</h4><div class="jcr"><span class="jl">“Done” said</span>${cal(st.calibration.done, "accepted")}</div><div class="jcr"><span class="jl">Pick confidence</span>${cal(st.calibration.pick, "right")}</div></div>
    </div>
    <h4>Last ${st.recent.length} decisions</h4>
    <ul class="jrec">${recent}</ul>
    <form class="jcap"><label>Daily cap <input type="number" min="0" max="100000" step="1" value="${cap.cap}" inputmode="numeric" aria-label="Jev calls per day"></label><button class="btn">Save</button><span class="hint">${cap.used} used today · at the cap ≈ ${money(cap.cap * 1200 * st.price.perMillionInput / 1e6)}/day${cap.source === "env" ? " · from DECK_JEV_DAILY until you save" : ""}</span></form>
    <div class="jfeat">${feats}</div>
    <p class="hint jfoot">${st.asked} decisions asked, ${st.answered} answered in the deck. All Jev use today: ${st.allAgentsToday.calls} calls, ${money(st.allAgentsToday.cost)}. $${st.price.perMillionInput} per million input tokens, output free.</p>
  </section>`;
}
// Keyboard triage: a focus ring over the cards (S.ifocus), skips that hide a card until it changes or you undo.
const IFILTERS = [["all", "All"], ["quick", "Quick ones"], ["prompt", "Permissions"], ["question", "Questions"], ["review", "Done?"]];
S.skipped = new Map(); // key → the decision's signature when skipped; it comes back when the decision changes
S.skipStack = [];
S.ifocus = null; S.ifocusIdx = 0;
const dsig = (d) => `${d.kind}|${d.at}|${d.question}`;
const isSkipped = (d) => S.skipped.get(d.key) === dsig(d);
const KEYHINTS = [[["j", "k"], "move"], [["1–9"], "pick"], [["y", "n"], "yes / no"], [["v"], "verify"], [["r"], "reply"], [["o"], "open"], [["s"], "skip"], [["u"], "undo skip"], [["f"], "filter"], [["Esc"], "back"]];
function renderInbox() {
  const box = $("dbody");
  // A reply being written survives the re-render that any decision change triggers.
  const drafts = box._mode === "inbox" ? [...box.querySelectorAll(".dcard .dreply:not([hidden])")].map((f) => { const ta = f.querySelector("textarea"); return { key: f.closest(".dcard").dataset.dkey, text: ta.value, action: f.dataset.action, focus: document.activeElement === ta, a: ta.selectionStart, b: ta.selectionEnd }; }) : [];
  const waiting = (S.decisions ?? []).filter((d) => rowOf(d.key) && !S.done.has(d.key));
  for (const k of [...S.skipped.keys()]) if (!waiting.some((d) => d.key === k && isSkipped(d))) S.skipped.delete(k);
  const all = waiting.filter((d) => !isSkipped(d)).sort((a, b) => ({ prompt: 0, question: 1, review: 2 })[a.kind] - ({ prompt: 0, question: 1, review: 2 })[b.kind] || b.at - a.at);
  const quick = (d) => d.jev?.low >= 0.7 || (d.kind === "review" && (d.jev?.done ?? 0) >= 0.7);
  const f = S.inboxFilter;
  const list = all.filter((d) => f === "all" || (f === "quick" ? quick(d) : d.kind === f));
  const count = (k) => all.filter((d) => (k === "quick" ? quick(d) : d.kind === k)).length;
  const chips = IFILTERS.map(([k, l]) => [k, l, k === "all" ? all.length : count(k)])
    .map(([k, l, n]) => `<button class="chip" data-ifilter="${k}" aria-pressed="${f === k}">${l}${n ? ` <b>${n}</b>` : ""}</button>`).join("") + (isPhone() ? "" : `<span class="chipkey">${kh("f")} cycles</span>`);
  const j = S.jev ?? {};
  const nSkip = S.skipped.size;
  const skipped = nSkip ? ` <button class="iunskip" data-iunskip title="Show the skipped ones again">${nSkip} skipped · show</button>` : "";
  const hints = isPhone() ? "" : `<div class="khint" aria-label="Keyboard">${KEYHINTS.map(([ks, t]) => `<span>${ks.map((k) => `<kbd>${k}</kbd>`).join("")} ${t}</span>`).join("")}</div>`;
  modeHTML(`<header class="vh"><h2>${ICON.inbox}Decisions</h2><p>${all.length ? `${all.length} waiting on you. Answer here; it goes straight to the agent.` : "Nothing is waiting on you."}${skipped}</p>${jevBar(j)}${hints}<div class="chips">${chips}</div></header>
    ${list.length ? `<div class="dlist">${list.map(decisionCard).join("")}</div>` : `<div class="empty-v"><p>${all.length ? "None in this filter." : nSkip ? "Only skipped ones left." : "All clear. When an agent asks something, needs permission, or says it’s done, it shows up here."}</p></div>`}`);
  for (const x of drafts) {
    const form = box.querySelector(`.dcard[data-dkey="${CSS.escape(x.key)}"] .dreply`);
    if (!form || !form.hidden) continue;
    const ta = form.querySelector("textarea");
    form.hidden = false; form.dataset.action = x.action ?? ""; ta.value = x.text; autosize(ta);
    if (x.focus) { ta.focus(); ta.setSelectionRange(x.a, x.b); }
  }
  applyInboxFocus(false);
}
const inboxCards = () => [...$("dbody").querySelectorAll(".dcard:not(.leaving)")];
const cardOf = (key) => document.querySelector(`#dbody .dcard[data-dkey="${CSS.escape(key)}"]`);
/** Put the focus ring on S.ifocus, or on the card now at its old place (the next one) when it's gone. */
function applyInboxFocus(scroll) {
  const cards = inboxCards();
  const el = cards.find((c) => c.dataset.dkey === S.ifocus) ?? cards[Math.min(S.ifocusIdx, cards.length - 1)];
  for (const c of $("dbody").querySelectorAll(".dcard.kfocus")) if (c !== el) c.classList.remove("kfocus");
  if (!el) { S.ifocus = null; return; }
  S.ifocus = el.dataset.dkey; S.ifocusIdx = cards.indexOf(el);
  if (!isPhone()) el.classList.add("kfocus");
  if (scroll) el.scrollIntoView({ block: el.offsetHeight > $("dbody").clientHeight - 24 ? "start" : "nearest", behavior: "smooth" });
}
function moveInboxFocus(delta) {
  const cards = inboxCards();
  if (!cards.length) return;
  const i = cards.findIndex((c) => c.dataset.dkey === S.ifocus);
  S.ifocus = cards[i < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, i + delta))].dataset.dkey;
  applyInboxFocus(true);
}
/** The answered or skipped card is leaving: the ring goes to the one after it (or before, at the end). */
function focusPast(key) {
  const cards = inboxCards(), i = cards.findIndex((c) => c.dataset.dkey === key);
  if (i < 0 || S.ifocus !== key) return;
  S.ifocus = (cards[i + 1] ?? cards[i - 1])?.dataset.dkey ?? null;
  S.ifocusIdx = i;
}
function nextHint() {
  const d = S.ifocus && (S.decisions ?? []).find((x) => x.key === S.ifocus);
  if (!d) return "All clear · Esc to go back";
  if (d.kind === "review") return "Next: y looks good · n send back · v verify · s skip";
  const n = Math.min(d.options.length, 9);
  return `Next: ${yesNoOption(d, "yes") ? "y / n · " : ""}${n ? `1–${n} pick · ` : ""}r reply · s skip`;
}
function triageToast(msg) {
  toast(msg);
  const t = document.querySelector(".toast");
  if (t && !isPhone()) { const h = document.createElement("span"); h.className = "tnext"; h.textContent = nextHint(); t.append(h); }
}
async function decide(key, action, fn, choice, sent) {
  const card = cardOf(key);
  if (card?.classList.contains("leaving")) return;
  focusPast(key);
  card?.classList.add("leaving");
  applyInboxFocus(true);
  try {
    await fn();
    S.done.set(key, Date.now());
    api("/api/decide", { key, action, choice }).catch(() => {});
    if (action !== "verify") api("/api/seen", { key }).catch(() => {});
    if (sent) triageToast(sent);
    setTimeout(() => { renderInbox(); renderViews(); if (S.mode === "inbox") applyInboxFocus(true); }, 180); // the answered card is gone: keep the next one in view
  } catch (e) { card?.classList.remove("leaving"); S.ifocus = key; applyInboxFocus(true); toast(e.message, true); }
}
setInterval(() => { for (const [k, t] of S.done) if (Date.now() - t > 20_000) S.done.delete(k); }, 5000);
/** Answer with one of the card's options: the digit or cursor keys for a terminal prompt, the option's text for a question. */
function inboxPick(key, o) {
  const d = (S.decisions ?? []).find((x) => x.key === key), r = rowOf(key);
  if (!d || !r) return;
  const sent = `Sent “${plain(o.title).slice(0, 60)}” to ${r.project}`;
  if (d.kind === "prompt") return decide(key, "answer", () => api("/api/keys", { key, keys: o.keys ?? [String(o.id)] }), String(o.id), sent);
  return decide(key, "answer", () => api("/api/send", { key, text: o.send ?? o.title }), String(o.id), sent);
}
function inboxAct(key, act) {
  const card = cardOf(key), r = rowOf(key);
  if (!card || !r) return;
  if (act === "open") return select(key, { scroll: true, open: true });
  if (act === "term") { select(key, { open: true }); return showTerminal(); }
  if (act === "skip") return skipDecision(key);
  if (act === "accept") return decide(key, "accept", async () => {}, undefined, `Looks good: ${r.project} accepted`);
  if (act === "verify") return verifyRow(r, true);
  if (act === "sendback" || act === "reply") {
    const form = card.querySelector(".dreply");
    form.hidden = false;
    const ta = form.querySelector("textarea");
    if (act === "sendback" && !ta.value) ta.value = r.check?.state === "fail" ? `The checks fail (\`${r.check.cmd}\`, exit ${r.check.exit}). Fix it, re-run them, and show me the output.` : "Not done yet: run the tests and type checks, show me the output, and fix anything that fails.";
    form.dataset.action = act;
    ta.focus();
    autosize(ta);
    form.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function closeReply(form) {
  form.hidden = true;
  if (form.contains(document.activeElement)) document.activeElement.blur();
  applyInboxFocus(false);
}
function skipDecision(key) {
  const d = (S.decisions ?? []).find((x) => x.key === key);
  if (!d) return;
  focusPast(key);
  S.skipped.set(key, dsig(d));
  S.skipStack.push(key);
  renderInbox();
  applyInboxFocus(true);
  triageToast(`Skipped ${rowOf(key)?.project ?? "it"} for now · u brings it back`);
}
function undoSkip() {
  while (S.skipStack.length) {
    const k = S.skipStack.pop();
    if (!S.skipped.has(k)) continue;
    S.skipped.delete(k);
    S.ifocus = k;
    renderInbox();
    applyInboxFocus(true);
    return toast(`Back: ${rowOf(k)?.project ?? "the decision"}`);
  }
  toast("Nothing skipped to bring back");
}
function setInboxFilter(f) { S.inboxFilter = f; store("inboxFilter", f); S.ifocus = null; S.ifocusIdx = 0; renderInbox(); }
/** Inbox keys, called by the global handler (which already skips inputs, dialogs and menus). True when handled. */
function inboxKeydown(e) {
  const k = e.key;
  if (k === "Escape") { const form = $("dbody").querySelector(".dreply:not([hidden])"); if (form) { closeReply(form); return true; } return false; }
  if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveInboxFocus(1); return true; }
  if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveInboxFocus(-1); return true; }
  if (k === "f" || k === "F") {
    const i = IFILTERS.findIndex(([id]) => id === S.inboxFilter);
    const [id, label] = IFILTERS[(i + (k === "F" ? IFILTERS.length - 1 : 1)) % IFILTERS.length];
    setInboxFilter(id);
    toast(`Showing: ${label}`);
    return true;
  }
  if (k === "u") { undoSkip(); return true; }
  if (k === "Enter" && e.target.closest?.("button, a, summary")) return false; // Enter on a focused button presses it
  const isCardKey = /^([1-9ynvrosx]|Enter)$/.test(k);
  const card = S.ifocus && cardOf(S.ifocus);
  const d = card && !card.classList.contains("leaving") && (S.decisions ?? []).find((x) => x.key === S.ifocus);
  if (!d) return isCardKey; // an empty inbox swallows card keys instead of running their global meanings
  const a = inboxKey(d, k);
  if (!a) return false;
  e.preventDefault();
  if (a.miss) toast(a.miss);
  else if (a.opt) inboxPick(d.key, a.opt);
  else inboxAct(d.key, a.act);
  return true;
}
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "inbox") return;
  const chip = e.target.closest("[data-ifilter]");
  if (chip) return setInboxFilter(chip.dataset.ifilter);
  if (e.target.closest("[data-iunskip]")) { S.skipped.clear(); S.skipStack = []; return renderInbox(); }
  if (e.target.closest("[data-jevtog]")) { S.jevOpen = !S.jevOpen; store("jevOpen", S.jevOpen); renderInbox(); if (S.jevOpen) loadJevStats(true); return; }
  const card = e.target.closest(".dcard");
  if (!card) return;
  const key = card.dataset.dkey;
  const d = S.decisions.find((x) => x.key === key);
  const r = rowOf(key);
  if (!d || !r) return;
  if (S.ifocus !== key && !card.classList.contains("leaving")) { S.ifocus = key; applyInboxFocus(false); }
  const opt = e.target.closest("[data-dopt]");
  if (opt) {
    const o = d.options.find((x) => String(x.id) === opt.dataset.dopt);
    return o && inboxPick(key, o);
  }
  const chk = e.target.closest("[data-dcheck]")?.dataset.dcheck;
  if (chk) {
    if (chk === "never") return api("/api/verify", { key, approve: false }).then(() => toast(`Checks off for ${r.project}`)).catch((x) => toast(x.message, true));
    let cmd = r.check?.cmd;
    if (chk === "edit") { cmd = await askDialog({ title: `Check command for ${r.project}`, text: "Runs in the project folder when an agent says it’s done. Only this command, only for this project.", input: cmd ?? "", ok: "Allow" }); if (!cmd) return; }
    return api("/api/verify", { key, approve: true, cmd }).then(() => toast(`Checking ${r.project}…`)).catch((x) => toast(x.message, true));
  }
  const act = e.target.closest("[data-dact2]")?.dataset.dact2;
  if (act) inboxAct(key, act);
});
$("dbody").addEventListener("change", async (e) => {
  const f = e.target.closest?.("[data-jevfeat]");
  if (!f) return;
  const on = f.checked;
  try { const r = await api("/api/jev/feature", { name: f.dataset.jevfeat, on }); S.jev = r.jev; toast(`${JEV_FEATS.find((x) => x[0] === f.dataset.jevfeat)?.[1] ?? "Jev feature"}: ${on ? "on" : "off"}`); } catch (x) { f.checked = !on; toast(x.message, true); }
});
$("dbody").addEventListener("submit", async (e) => {
  const cap = e.target.closest(".jcap");
  if (cap) {
    e.preventDefault();
    const n = Number(cap.querySelector("input").value);
    try { const r = await api("/api/jev/cap", { cap: n }); S.jev = r.jev; toast(`Jev daily cap: ${n}`); loadJevStats(true); } catch (x) { toast(x.message, true); }
    return;
  }
  const form = e.target.closest(".dreply");
  if (!form) return;
  e.preventDefault();
  const key = form.closest(".dcard").dataset.dkey;
  const text = form.querySelector("textarea").value.trim();
  if (!text) return;
  const back = form.dataset.action === "sendback";
  decide(key, back ? "sendback" : "reply", () => api("/api/send", { key, text }), undefined, `${back ? "Sent back to" : "Sent to"} ${rowOf(key)?.project ?? "the agent"}: “${plain(text).slice(0, 50)}${text.length > 50 ? "…" : ""}”`);
});
$("dbody").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && e.target.matches(".dreply textarea")) { e.preventDefault(); e.target.form.requestSubmit(); }
  if (e.key === "Escape" && e.target.matches(".dreply textarea")) { e.preventDefault(); e.stopPropagation(); closeReply(e.target.form); }
});

// History ──────────────────────────────────────────────────────────────────
S.hq = { q: "", machine: "all", agent: "", project: "" };
let histSeq = 0, histTimer = null;
async function loadHistory(more) {
  const seq = ++histSeq;
  const q = S.hq;
  try {
    const before = more ? S.histRes?.sessions?.[S.histRes.sessions.length - 1]?.last : undefined;
    const res = await api("/api/history", { q: q.q, machine: q.machine, agent: q.agent || undefined, project: q.project || undefined, limit: 80, before: q.q ? undefined : before });
    if (seq !== histSeq) return;
    if (more && S.histRes) res.sessions = [...S.histRes.sessions, ...res.sessions.filter((x) => !S.histRes.sessions.some((y) => y.key === x.key))];
    S.histRes = res;
    if (S.mode === "history") renderHistory();
  } catch (e) { toast(e.message, true); }
}
function renderHistStatus() {
  const el = document.getElementById("histStatus");
  if (!el) return;
  const h = S.hist ?? {};
  el.textContent = h.building ? `Indexing ${h.done ?? 0} of ${h.total ?? "?"} changed sessions…` : `${(h.indexed ?? 0).toLocaleString()} past sessions indexed on ${S.self ? machineLabel(S.self) : "this machine"}${multiMachine() ? " (other machines index their own)" : ""}`;
}
function hlite(snip) { return esc(snip).replace(/\u0002/g, "<mark>").replace(/\u0003/g, "</mark>"); }
function renderHistory() {
  const res = S.histRes;
  const q = S.hq;
  const projects = res?.projects ?? [];
  const mach = realMachines();
  const box = $("dbody");
  const html = `<header class="vh"><h2>${ICON.history}History</h2><p id="histStatus"></p>
    <div class="hfilters"><label class="find"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg><input id="hq" type="search" placeholder="Search everything you’ve ever done with an agent" value="${esc(q.q)}" autocomplete="off" spellcheck="false"></label>
    ${mach.length > 1 ? `<select id="hmach"><option value="all">All machines</option>${mach.map((m) => `<option value="${esc(m.id)}" ${q.machine === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>` : ""}
    <select id="hagent"><option value="">Claude + Codex</option><option value="claude" ${q.agent === "claude" ? "selected" : ""}>Claude Code</option><option value="codex" ${q.agent === "codex" ? "selected" : ""}>Codex</option></select>
    <select id="hproj"><option value="">All projects</option>${projects.map((p) => `<option value="${esc(p.project)}" ${q.project === p.project ? "selected" : ""}>${esc(p.project)} (${p.n})</option>`).join("")}</select></div></header>
    <div class="hlist">${!res ? `<p class="hint">Loading…</p>` : res.sessions.length ? res.sessions.map((h) => `<button class="hitem" data-hkey="${esc(h.key)}" ${h.hit ? `data-hi="${h.hit.i}"` : ""} style="--pc:${pc(h.project)}">
        <span class="ht">${esc(h.title || "(untitled)")}</span>
        <span class="hm"><span class="pj" style="--pc:${pc(h.project)}">${esc(h.project || "no project")}</span><span>${h.agent === "claude" ? "Claude" : "Codex"}</span>${multiMachine() ? `<span>${esc(machineLabel(h.machine))}</span>` : ""}<span title="${esc(abs(h.last))}">${esc(h.last ? DF.format(new Date(h.last)) : "")}</span>${h.asks ? `<span>${h.asks} request${h.asks === 1 ? "" : "s"}</span>` : ""}${h.hits > 1 ? `<span>${h.hits} matches</span>` : ""}</span>
        ${h.hit ? `<span class="hs">${hlite(h.hit.snippet)}</span>` : h.first && h.first !== h.title ? `<span class="hs dim">${esc(h.first.slice(0, 220))}</span>` : ""}
      </button>`).join("") + (!q.q && res.sessions.length >= 80 ? `<button class="btn ghost more" data-hmore>Older sessions</button>` : "") : `<p class="hint">${q.q ? "No past session mentions that." : "No past sessions yet."}</p>`}</div>`;
  const focused = document.activeElement?.id === "hq";
  const caret = focused ? document.activeElement.selectionStart : null;
  modeHTML(html);
  renderHistStatus();
  if (focused) { const i = $("hq"); i.focus(); i.setSelectionRange(caret, caret); }
}
$("dbody").addEventListener("input", (e) => {
  if (e.target.id !== "hq") return;
  S.hq.q = e.target.value;
  clearTimeout(histTimer);
  histTimer = setTimeout(() => loadHistory(), 180);
});
$("dbody").addEventListener("change", (e) => {
  const id = e.target.id;
  if (id === "hmach") S.hq.machine = e.target.value;
  else if (id === "hagent") S.hq.agent = e.target.value;
  else if (id === "hproj") S.hq.project = e.target.value;
  else return;
  loadHistory();
});
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "history") return;
  if (e.target.closest("[data-hmore]")) return loadHistory(true);
  const b = e.target.closest("[data-hkey]");
  if (b) openHist(b.dataset.hkey, b.dataset.hi != null ? Number(b.dataset.hi) : undefined);
});
async function openHist(key, i) {
  try {
    let row = S.hrows.get(key);
    if (!row) {
      const { row: r } = await api("/api/history-row", { key });
      if (!r) return toast("That session is no longer in the index", true);
      const machine = key.includes("|") ? key.split("|")[0] : S.self;
      row = { ...r, key, machine };
      S.hrows.set(key, row);
    }
    S.tab = "chat";
    if (i != null) return jumpTo(key, i);
    select(key, { open: true });
  } catch (e) { toast(e.message, true); }
}
async function resumeHist(r) {
  try {
    const res = await api("/api/history-resume", { key: r.key });
    toast("Resuming in a new herdr tab…");
    if (res.key) pendingSelect = res.key;
  } catch (e) { toast(e.message, true); }
}

// Tools view ────────────────────────────────────────────────────────────────
function renderTools() {
  const cur = rowOf(S.sel);
  const target = cur && !cur.hist && !cur.app && isAgent(cur) ? cur : null;
  const groups = Object.entries(S.toolGroups ?? {});
  const card = (t) => `<div class="tcard" data-tool="${esc(t.id)}"><div class="tt">${toolGlyph(t)}<b>${esc(t.label)}</b>${t.kind === "action" ? '<span class="tk">runs in the deck</span>' : t.kind === "sequence" ? '<span class="tk">2 steps</span>' : ""}</div><p>${esc(t.hint ?? "")}</p>
      ${t.prompt ? `<details><summary>What it sends</summary><pre>${esc(t.prompt)}${t.then ? `\n\n— then, when it’s done —\n\n${esc(t.then)}` : ""}</pre></details>` : ""}
      <div class="tacts">${target || t.action === "upload" ? `<button class="btn primary" data-trun="${esc(t.id)}">Use on “${esc((target?.title ?? "this session").slice(0, 28))}”</button>` : `<span class="hint">Open a session to use it</span>`}${t.builtin ? "" : `<button class="btn ghost" data-tedit="${esc(t.id)}">Edit</button><button class="btn ghost" data-tdel="${esc(t.id)}">Delete</button>`}</div></div>`;
  modeHTML(`<header class="vh"><h2>${ICON.tools}Tools</h2><p>One click makes the agent do something useful, or the deck does it for you. Use them from a session’s <b>Tools</b> button, the ☆ in the message box, <kbd>.</kbd>, or ⌘K. Select several sessions to use one on all of them.</p></header>
    ${groups.map(([g, label]) => { const ts = S.tools.filter((t) => t.group === g); return ts.length || g === "custom" ? `<section class="tgroup"><h3>${esc(label)}</h3><div class="tgrid">${ts.map(card).join("")}${g === "custom" ? `<button class="tcard add" data-tnew>${ICON.star}<b>New tool</b><p>A prompt you send often, one click away. Use {project}, {branch}, {title} and {handoff}.</p></button>` : ""}</div></section>` : ""; }).join("")}`);
}
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "tools") return;
  const run = e.target.closest("[data-trun]")?.dataset.trun;
  if (run) { const t = S.tools.find((x) => x.id === run); if (t) runTool(t, S.sel ? [S.sel] : []); return; }
  const edit = e.target.closest("[data-tedit]")?.dataset.tedit;
  const del = e.target.closest("[data-tdel]")?.dataset.tdel;
  const custom = S.tools.filter((t) => !t.builtin);
  if (del) { if (await askDialog({ title: "Delete this tool?", ok: "Delete", danger: true })) saveTools(custom.filter((t) => t.id !== del)); return; }
  if (edit || e.target.closest("[data-tnew]")) {
    const t = custom.find((x) => x.id === edit) ?? {};
    const label = await askDialog({ title: edit ? "Edit tool" : "New tool", text: "Its name", input: t.label ?? "", ok: "Next" });
    if (!label) return;
    const prompt = await askDialog({ title: label, text: "What it sends to the agent. {project}, {branch}, {title} and {handoff} are filled in.", input: t.prompt ?? "", ok: "Save", multiline: true });
    if (!prompt) return;
    saveTools(edit ? custom.map((x) => (x.id === edit ? { ...x, label, prompt } : x)) : [...custom, { label, prompt, hint: prompt.slice(0, 120) }]);
  }
});
async function saveTools(custom) {
  try { S.tools = (await api("/api/tools", { tools: custom })).tools; renderTools(); toast("Saved"); } catch (e) { toast(e.message, true); }
}

// Connections ─────────────────────────────────────────────────────────────
// An app store for what each machine can reach: categories, featured rows, search, select-all, and recipes
// that combine connections into workflows. Open it from a session to add picks to that session's context.
// Each machine keeps its own inventory; the hub gives every card a category and a state (src/store.ts).
ICON.bolt = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>';
ICON.x = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

// <conn-store> pure helpers (tested in test/store.test.ts)
function connState(i) { return i.state ?? (i.status === "off" ? "off" : i.status === "partial" ? "signed-out" : "ready"); }
function connSelectable(i) { return connState(i) !== "off"; }
/** Every card once, in section order. */
function connItems(inv) { const seen = new Map(); for (const s of inv?.sections ?? []) for (const i of s.items) if (!seen.has(i.id)) seen.set(i.id, i); return [...seen.values()]; }
/** Every word of the query appears in the name, what it's for, how it's reached, its group or its category. */
function connMatch(i, q, catLabel) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${i.name} ${i.detail ?? ""} ${i.note ?? ""} ${(i.via ?? []).join(" ")} ${i.group ?? ""} ${catLabel ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
/** The cards in view: a search spans every category; otherwise one category ("off" = not set up). */
function connView(items, { cat, q, showHidden, labels }) {
  const inCat = (i) => (cat === "off" ? connState(i) === "off" : i.cat === cat && connState(i) !== "off");
  return items.filter((i) => (q ? true : inCat(i)) && (showHidden || q || !i.hidden) && connMatch(i, q, labels?.[i.cat]));
}
/** Select every selectable card in `items` (the category or search in view). Returns a new set. */
function connSelectAll(pick, items) { const s = new Set(pick); for (const i of items) if (connSelectable(i)) s.add(i.id); return s; }
/** Unselect the cards in `items`; with no items, unselect everything. Returns a new set. */
function connSelectNone(pick, items) { if (!items) return new Set(); const s = new Set(pick); for (const i of items) s.delete(i.id); return s; }
function connAllPicked(pick, items) { const sel = items.filter(connSelectable); return sel.length > 0 && sel.every((i) => pick.has(i.id)); }
/** Recipes that use any picked connection, most overlap first. */
function recipesFor(recipes, pick) {
  return recipes.map((r) => ({ r, n: [...r.ready.needs, ...r.ready.optional].filter((x) => x.id && pick.has(x.id)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n).map((x) => x.r);
}
/** "Ready to use": ready services, agents and plans, at most two per category, up to `max`. */
function connFeatured(items, order, max = 14) {
  const per = new Map(), out = [];
  const pool = items.filter((i) => connState(i) === "ready" && !i.hidden && ["service", "agent", "sub"].includes(i.kind)).sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || Number(!b.color) - Number(!a.color));
  for (const i of pool) { const n = per.get(i.cat) ?? 0; if (n >= 2) continue; per.set(i.cat, n + 1); out.push(i); if (out.length >= max) break; }
  return out;
}
function connRecent(items, now, days = 14) { return items.filter((i) => i.since && now - i.since < days * 864e5 && !i.hidden && connState(i) !== "off").sort((a, b) => b.since - a.since).slice(0, 12); }
// </conn-store>

const CICON = {
  home: TI2('<path d="M2.5 7.2 8 2.8l5.5 4.4M4 6v7h8V6"/>'),
  ai: TI2('<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/>'),
  code: TI2('<path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5M9 3 7 13"/>'),
  cloud: TI2('<path d="M4.5 12.5h7a2.8 2.8 0 0 0 .4-5.6A4 4 0 0 0 4.2 7.5a2.5 2.5 0 0 0 .3 5z"/>'),
  data: TI2('<ellipse cx="8" cy="4" rx="5" ry="1.8"/><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8"/>'),
  comms: TI2('<path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  media: TI2('<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="m2.5 11 3.5-3.5 2.5 2.5 1.5-1.5 3.5 3.5"/><circle cx="10.5" cy="6" r="1"/>'),
  knowledge: TI2('<path d="M3 2.8h6.5A2.5 2.5 0 0 1 12 5.3v8H5.5A2.5 2.5 0 0 1 3 10.8z"/><path d="M3 10.8a2.5 2.5 0 0 1 2.5-2.5H12"/>'),
  commerce: TI2('<path d="M2 3h2l1.6 7.2h6.9L14 5H4.6"/><circle cx="6.2" cy="12.8" r=".9"/><circle cx="11.4" cy="12.8" r=".9"/>'),
  automation: TI2('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>'),
  research: TI2('<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.6 3.6"/>'),
  devices: TI2('<rect x="2" y="3" width="9" height="7" rx="1"/><path d="M4.5 12.5h4M12 6h2v7.5h-3"/>'),
  browsers: TI2('<circle cx="8" cy="8" r="5.8"/><path d="M2.3 8h11.4M8 2.2c1.7 1.7 2.4 3.6 2.4 5.8S9.7 12.1 8 13.8C6.3 12.1 5.6 10.2 5.6 8S6.3 3.9 8 2.2"/>'),
  mcp: TI2('<path d="M6 2v3.5M10 2v3.5M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>'),
  skills: TI2('<path d="M8 1.8 9.5 6l4.3.2-3.4 2.7 1.2 4.2L8 10.7l-3.6 2.4 1.2-4.2L2.2 6.2 6.5 6z"/>'),
  keys: TI2('<circle cx="5.5" cy="10.5" r="2.8"/><path d="m7.5 8.5 6-6M11.5 4.5l1.5 1.5M10 6l1.2 1.2"/>'),
  yours: TI2('<path d="M8 3v10M3 8h10"/>'),
  off: TI2('<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/>'),
  recipe: TI2('<path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3"/>'),
  sliders: TI2('<path d="M3 4.5h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.5"/><circle cx="10.5" cy="11.5" r="1.5"/>'),
};
const CST = { ready: ["ok", "Ready"], "signed-out": ["warn", "Signed out"], installed: ["mid", "Installed only"], offline: ["mid", "Offline"], off: ["off", "Not set up"] };
S.conn = { machine: null, data: new Map(), mcp: null, pick: new Set(), cat: load("connCat2", "home"), q: "", tab: load("connTab", "store"), recipes: new Map(), rcat: "all", ropen: null, rfor: null, open: null };

function openConnections(key, tab) {
  const r = key ? rowOf(key) : rowOf(S.sel);
  S.conn.target = r && !r.app && !r.hist && isAgent(r) ? r.key : null;
  if (r && r.machine && r.machine !== "codex-app") S.conn.machine = r.machine;
  S.conn.pick.clear();
  S.conn.rfor = null;
  if (tab) S.conn.tab = tab;
  setMode("connections");
}
async function loadConnections(refresh) {
  const m = S.conn.machine ?? S.self;
  S.conn.loading = true;
  if (S.mode === "connections") renderConnections();
  try {
    const [inv, mcp] = await Promise.all([api("/api/connections", { machine: m, refresh }), S.conn.mcp ? null : api("/api/mcp-info", {}).catch(() => null)]);
    S.conn.data.set(m, inv);
    if (mcp) { S.conn.mcp = mcp; S.audit = mcp.audit; }
    if (refresh || S.conn.tab === "recipes") loadRecipes(true);
  } catch (e) { toast(e.message, true); }
  S.conn.loading = false;
  if (S.mode === "connections") renderConnections();
  // The other machines load quietly, so each card can say which machines have it.
  for (const x of realMachines()) if (x.online && x.id !== m && !S.conn.data.has(x.id)) api("/api/connections", { machine: x.id }).then((inv) => { S.conn.data.set(x.id, inv); if (S.mode === "connections") renderConnections(); }).catch(() => {});
}
async function loadRecipes(force) {
  const m = S.conn.machine ?? S.self;
  if (S.conn.rloading || (!force && S.conn.recipes.has(m))) return;
  S.conn.rloading = true;
  try { S.conn.recipes.set(m, await api("/api/recipes", { op: "list", machine: m })); } catch (e) { toast(e.message, true); }
  S.conn.rloading = false;
  if (S.mode === "connections") renderConnections();
}

const hexLight = (hex) => { const h = String(hex).replace("#", ""); if (h.length !== 6) return false; const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6; };
function connHue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const KGLYPH = { key: "keys", skill: "skills", mcp: "mcp", background: "automation", ssh: "devices", device: "devices", browser: "browsers" };
function connBadge(i, big) {
  const style = i.color ? `--bg:${i.color};--fg:${hexLight(i.color) ? "#141414" : "#fff"}` : `--bg:oklch(0.8 0.09 ${connHue(i.name)});--fg:oklch(0.26 0.06 ${connHue(i.name)})`;
  const g = KGLYPH[i.kind] ? CICON[KGLYPH[i.kind]] : esc(initials(String(i.name).replace(/[^\p{L}\p{N}\s._-]/gu, " ").trim() || "?"));
  return `<span class="cbadge${big ? " big" : ""}" style="${style}" aria-hidden="true">${g}</span>`;
}
function connWhere(id) {
  if (S.conn.data.size < 2) return null;
  const out = [];
  for (const [mid, inv] of S.conn.data) { const i = connItems(inv).find((x) => x.id === id); if (i && connState(i) !== "off") out.push(machineLabel(mid)); }
  return out;
}
const catLabel = (inv, id) => (id === "off" ? "Not set up" : id === "home" ? "Featured" : inv?.categories?.find((c) => c.id === id)?.label ?? id ?? "");
function connCard(i, n, inv, showCat) {
  const st = connState(i);
  const [cls, label] = CST[st] ?? CST.ready;
  const picked = S.conn.pick.has(i.id), open = S.conn.open === i.id;
  const where = connWhere(i.id);
  const fresh = i.since && Date.now() - i.since < 14 * 864e5;
  const via = i.via ?? [];
  const uses = open ? recipesFor(S.conn.recipes.get(S.conn.machine ?? S.self)?.recipes ?? [], new Set([i.id])).slice(0, 6) : [];
  return `<article class="ccard${picked ? " picked" : ""}${open ? " open" : ""}${i.hidden ? " hid" : ""}${st === "off" ? " isoff" : ""}" data-cid="${esc(i.id)}" style="--i:${Math.min(n, 14)}">
    <button class="cpick" data-cpick aria-pressed="${picked}" aria-label="Select ${esc(i.name)}" ${st === "off" ? "disabled" : ""}>${ICON.check}</button>
    <div class="ctop" data-copen>${connBadge(i)}<span class="ctt"><span class="cname">${esc(i.name)}</span>${showCat ? `<span class="ccat">${esc(catLabel(inv, i.cat))}</span>` : ""}</span></div>
    <div class="cwhat" data-copen>${esc(i.detail || i.note || " ")}</div>
    <div class="cfoot" data-copen><span class="cst ${cls}">${label}</span>${fresh ? '<span class="cnew">New</span>' : ""}${i.note && i.detail && !open && i.note !== "installed" ? `<span class="cnote2">${esc(i.note)}</span>` : ""}${where?.length ? `<span class="cmach" title="On ${esc(where.join(", "))}">${where.map((w) => `<i>${esc(w)}</i>`).join("")}</span>` : ""}</div>
    ${open ? `<div class="cmore">
      ${via.length ? `<div class="cvia">${via.map((v) => `<span>${esc(v)}</span>`).join("")}</div>` : ""}
      ${i.note ? `<div class="hint">${esc(i.note)}</div>` : ""}
      <label class="clab">How agents should use it</label>
      <textarea class="cuse" data-cnote rows="3" placeholder="e.g. Deploy with npx netlify-cli deploy --prod">${esc(i.use ?? "")}</textarea>
      ${uses.length ? `<label class="clab">Recipes that use it</label><div class="cuses">${uses.map((r) => `<button class="chip" data-cgorecipe="${esc(r.id)}">${CICON.recipe}${esc(r.title)}</button>`).join("")}</div>` : ""}
      <div class="cacts"><button class="btn ghost" data-chide>${i.hidden ? "Show again" : "Hide"}</button>${i.custom ? `<button class="btn ghost danger" data-cremove>Remove</button>` : ""}<span class="spacer"></span>${st === "off" ? "" : `<button class="btn" data-cone>Add just this</button>`}</div>
    </div>` : ""}
  </article>`;
}
function connMini(i, inv) {
  const st = connState(i);
  return `<button class="cmini" data-cjump="${esc(i.id)}" data-cjcat="${esc(i.cat)}" title="${esc(i.detail ?? "")}">${connBadge(i, true)}<span class="cmn">${esc(i.name)}</span><span class="cms">${esc(catLabel(inv, i.cat))}</span>${st !== "ready" ? `<span class="cst ${CST[st]?.[0] ?? "off"}">${CST[st]?.[1] ?? ""}</span>` : ""}</button>`;
}
function selBar(items, what) {
  const sel = items.filter(connSelectable);
  if (!sel.length) return "";
  const all = connAllPicked(S.conn.pick, items);
  return `<div class="csel"><span class="hint">${items.length} ${items.length === 1 ? "card" : "cards"}${sel.length < items.length ? ` · ${sel.length} selectable` : ""}</span><span class="spacer"></span>
    ${all ? `<button class="btn ghost" data-csnone>Unselect ${esc(what)}</button>` : `<button class="btn ghost" data-csall>${ICON.check}Select all ${sel.length} ${esc(what)}</button>`}</div>`;
}
function renderStore(inv, items, labels, q) {
  const order = (inv?.categories ?? []).map((c) => c.id);
  const cat = S.conn.cat;
  if (!inv) return `<div class="cgrid2">${Array.from({ length: 8 }, (_, n) => `<div class="ccard skel" style="--i:${n}"></div>`).join("")}</div><p class="hint">Looking around ${esc(machineLabel(S.conn.machine ?? S.self))}…</p>`;
  if (q) {
    const hits = connView(items, { q, labels }).sort((a, b) => Number(connState(a) === "off") - Number(connState(b) === "off") || order.indexOf(a.cat) - order.indexOf(b.cat));
    const shown = hits.slice(0, S.conn.more ? 600 : 120);
    return `${selBar(hits, "matches")}${hits.length ? `<div class="cgrid2">${shown.map((i, n) => connCard(i, n, inv, true)).join("")}</div>${hits.length > shown.length ? `<button class="link" data-cmore>Show all ${hits.length}</button>` : ""}` : `<p class="hint cempty">Nothing on ${esc(inv.machine)} matches “${esc(q)}”. <button class="link" data-cadd>Add it by hand</button></p>`}`;
  }
  if (cat === "home") {
    const feat = connFeatured(items, order), recent = connRecent(items, Date.now());
    const readyAll = items.filter((i) => connState(i) === "ready" && !i.hidden);
    const tiles = order.map((id) => ({ id, label: labels[id], n: items.filter((i) => i.cat === id && connState(i) !== "off" && !i.hidden) })).filter((t) => t.n.length || t.id === "yours");
    return `<section class="cfeat"><div class="cfh"><h3>Ready to use</h3><span class="hint">${readyAll.length} ready on ${esc(machineLabel(S.conn.machine ?? S.self))}</span><span class="spacer"></span><button class="btn ghost" data-cseverything>${ICON.check}Select all ${readyAll.length} ready</button></div>
        <div class="cstrip">${feat.map((i) => connMini(i, inv)).join("")}</div></section>
      ${recent.length ? `<section class="cfeat"><div class="cfh"><h3>Recently added</h3><span class="hint">new on ${esc(machineLabel(S.conn.machine ?? S.self))} in the last two weeks</span></div><div class="cstrip">${recent.map((i) => connMini(i, inv)).join("")}</div></section>` : ""}
      <section class="cfeat"><div class="cfh"><h3>Browse</h3></div><div class="ctiles">${tiles.map((t, n) => `<button class="ctile" data-ccat="${esc(t.id)}" style="--i:${Math.min(n, 14)}"><span class="cti">${CICON[t.id] ?? ""}</span><span class="ctl">${esc(t.label)}</span><span class="ctn">${t.n.length}</span><span class="ctg">${t.n.slice(0, 4).map((i) => connBadge(i)).join("")}</span></button>`).join("")}</div></section>`;
  }
  const SR = { ready: 0, "signed-out": 1, installed: 2, offline: 3, off: 4 };
  const view = connView(items, { cat, showHidden: S.conn.showHidden, labels }).sort((a, b) => SR[connState(a)] - SR[connState(b)]);
  const hid = cat === "off" ? 0 : items.filter((i) => i.cat === cat && i.hidden && connState(i) !== "off").length;
  const off = cat === "off" ? [] : items.filter((i) => i.cat === cat && connState(i) === "off" && !i.hidden);
  const hint = cat === "off" ? "Common services this machine can’t reach yet" : inv.categories?.find((c) => c.id === cat)?.hint ?? "";
  return `<div class="cch"><span class="cti big">${CICON[cat] ?? ""}</span><div><h3>${esc(catLabel(inv, cat))}</h3><p class="hint">${esc(hint)}</p></div></div>
    ${selBar(view, "here")}
    ${view.length ? `<div class="cgrid2">${view.map((i, n) => connCard(i, n, inv, false)).join("")}</div>` : `<p class="hint cempty">${cat === "yours" ? "Nothing here yet. “Add your own” for anything the scan can’t see: a staging server, a team API, a login in your password manager…" : "Nothing here on this machine."}</p>`}
    ${hid ? `<button class="link" data-cshowhid>${S.conn.showHidden ? "Hide" : "Show"} ${hid} hidden</button>` : ""}
    ${off.length ? `<h4 class="csub">Not set up here</h4><div class="cgrid2">${off.map((i, n) => connCard(i, n, inv, false)).join("")}</div>` : ""}`;
}
const RST = { ready: "ok", almost: "warn", missing: "off" };
function recipeCard(r, inv, n) {
  const rd = r.ready, open = S.conn.ropen === r.id;
  const mname = machineLabel(S.conn.machine ?? S.self);
  const st = rd.state === "ready" ? `Ready on ${mname}` : rd.state === "almost" ? "Needs a sign-in" : `Missing ${rd.missing}`;
  const chip = (x, opt) => `<span class="rneed ${x.state}${opt ? " opt" : ""}" title="${esc(x.state === "missing" ? `${x.label}: not found on ${mname}` : `${x.label}: ${x.name ?? ""}${x.state === "partial" ? " (signed out / not running)" : ""}`)}">${x.state === "ready" ? ICON.check : x.state === "partial" ? "!" : "–"} ${esc(x.label)}</span>`;
  return `<article class="rcard r-${rd.state}${open ? " open" : ""}" data-rid="${esc(r.id)}" style="--i:${Math.min(n, 14)}">
    <div class="rtop" data-ropen><span class="cti">${CICON[r.cat] ?? CICON.recipe}</span><span class="rtt"><span class="rname">${esc(r.title)}</span><span class="ccat">${esc(catLabel(inv, r.cat))}${r.custom ? " · yours" : ""}${r.machine === "other" ? " · runs on your other machine" : ""}</span></span><span class="cst ${RST[rd.state]}">${esc(st)}</span></div>
    <p class="rpitch" data-ropen>${esc(r.pitch)}</p>
    <div class="rneeds">${rd.needs.map((x) => chip(x)).join("")}${rd.optional.map((x) => chip(x, true)).join("")}</div>
    ${open ? `<div class="rmore"><ol class="rsteps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      <div class="rmeta"><span>${ICON.bot} ${esc(KINDS.find(([k]) => k === (r.agent ?? "claude"))?.[1] ?? r.agent)}</span>${r.folder ? `<span><code>${esc(r.folder)}</code></span>` : ""}</div>
      <details class="rprompt"><summary>The prompt</summary><pre>${esc(r.prompt)}</pre></details></div>` : ""}
    <div class="racts"><button class="btn primary" data-rrun>${ICON.bolt}Run</button><button class="btn ghost" data-rcopy>Copy prompt</button><button class="btn ghost" data-rcustom>${CICON.sliders}Customize</button>${r.custom ? `<button class="btn ghost danger" data-rdel>Delete</button>` : ""}<span class="spacer"></span><button class="link" data-ropen>${open ? "Less" : "Steps"}</button></div>
  </article>`;
}
function renderRecipes(inv, labels, q) {
  const m = S.conn.machine ?? S.self;
  const rec = S.conn.recipes.get(m);
  if (!rec) return `<div class="rgrid">${Array.from({ length: 6 }, (_, n) => `<div class="rcard skel" style="--i:${n}"></div>`).join("")}</div>`;
  let list = rec.recipes;
  if (S.conn.rfor?.size) list = recipesFor(list, S.conn.rfor);
  const cats = [...new Set(rec.recipes.map((r) => r.cat))];
  const rc = S.conn.rcat;
  if (rc === "ready") list = list.filter((r) => r.ready.state === "ready");
  else if (rc === "mine") list = list.filter((r) => r.custom);
  else if (rc !== "all") list = list.filter((r) => r.cat === rc);
  if (q) list = list.filter((r) => connMatch({ name: r.title, detail: r.pitch, via: [...r.ready.needs, ...r.ready.optional].map((x) => x.label), group: r.steps.join(" ") }, q, labels[r.cat]));
  const nReady = rec.recipes.filter((r) => r.ready.state === "ready").length;
  const forNames = S.conn.rfor?.size ? [...S.conn.rfor].map((id) => connItems(inv).find((i) => i.id === id)?.name ?? id) : [];
  return `${forNames.length ? `<div class="rfor">${CICON.recipe}<span>Recipes that use <b>${esc(forNames.slice(0, 4).join(", "))}${forNames.length > 4 ? ` +${forNames.length - 4}` : ""}</b>. Run adds your picks to the prompt.</span><span class="spacer"></span><button class="btn ghost" data-rforclear>Show all recipes</button></div>` : ""}
    <nav class="rchips"><button data-rcat="all" aria-pressed="${rc === "all"}">All <span class="n">${rec.recipes.length}</span></button><button data-rcat="ready" aria-pressed="${rc === "ready"}">Ready now <span class="n">${nReady}</span></button>${rec.recipes.some((r) => r.custom) ? `<button data-rcat="mine" aria-pressed="${rc === "mine"}">Yours</button>` : ""}${cats.map((c) => `<button data-rcat="${esc(c)}" aria-pressed="${rc === c}">${esc(labels[c] ?? c)}</button>`).join("")}</nav>
    ${!rec.reachable ? `<p class="hint">${esc(machineLabel(m))} isn’t reachable, so readiness can’t be checked right now.</p>` : ""}
    ${list.length ? `<div class="rgrid">${list.map((r, n) => recipeCard(r, inv, n)).join("")}</div>` : `<p class="hint cempty">No recipes match.</p>`}
    <p class="hint" style="margin-top:18px">Ready recipes come first. <b>Run</b> opens the New session dialog with the prompt, folder and agent filled in; nothing starts until you press Start there. Your own recipes are saved on the hub in <code>~/.config/herdr-deck/recipes.json</code>.</p>`;
}
function renderConnections() {
  const m = S.conn.machine ?? S.self;
  const inv = S.conn.data.get(m);
  if (!inv && !S.conn.loading) loadConnections();
  if (S.conn.tab === "recipes" && !S.conn.recipes.has(m)) loadRecipes();
  const mach = realMachines();
  const target = rowOf(S.conn.target);
  const q = S.conn.q.trim();
  const items = connItems(inv);
  const labels = Object.fromEntries((inv?.categories ?? []).map((c) => [c.id, c.label]));
  const order = (inv?.categories ?? []).map((c) => c.id);
  const count = (id) => items.filter((i) => (id === "off" ? connState(i) === "off" : i.cat === id && connState(i) !== "off") && !i.hidden).length;
  const cats = ["home", ...order.filter((id) => count(id) || id === "yours"), ...(count("off") ? ["off"] : [])];
  if (!cats.includes(S.conn.cat) && inv) S.conn.cat = "home";
  const n = S.conn.pick.size;
  const tab = S.conn.tab;
  const nRec = S.conn.recipes.get(m)?.recipes.length;
  modeHTML(`<header class="vh cvh"><h2>${ICON.plug}Connections</h2>
      <p>${target ? `Pick what <b>${esc(target.title)}</b> should know about, then add it to its context.` : "What each machine can reach, how agents should use it, and recipes that put it all to work."}</p>
      <div class="ctoolbar"><span class="seg ctabs" role="tablist"><button role="tab" data-ctab="store" aria-pressed="${tab === "store"}">Store${inv ? ` <span class="n">${items.filter((i) => connState(i) !== "off").length}</span>` : ""}</button><button role="tab" data-ctab="recipes" aria-pressed="${tab === "recipes"}">Recipes${nRec ? ` <span class="n">${nRec}</span>` : ""}</button></span>
        ${mach.length > 1 ? `<span class="seg">${mach.map((x) => `<button data-cmach="${esc(x.id)}" aria-pressed="${x.id === m}" ${x.online ? "" : "disabled"}>${esc(x.label)}</button>`).join("")}</span>` : ""}
        <input class="inp csearch" data-csearch type="search" placeholder="${tab === "recipes" ? "Search recipes" : `Search ${esc(machineLabel(m))}`}" value="${esc(S.conn.q)}" autocomplete="off" aria-label="Search">
        <span class="spacer"></span><button class="btn ghost" data-cadd>${ICON.plus}Add your own</button><button class="btn ghost" data-crefresh title="Scan again">${S.conn.loading ? '<span class="spin"></span>' : "Rescan"}</button></div>
    </header>
    <div class="cstore${tab === "recipes" ? " rtab" : ""}">
      ${tab === "store" ? `<nav class="crail" aria-label="Categories">${cats.map((id) => `<button data-ccat="${esc(id)}" aria-pressed="${!q && id === S.conn.cat}">${CICON[id] ?? ""}<span class="crl">${esc(catLabel(inv, id))}</span>${id === "home" ? "" : `<span class="n">${count(id)}</span>`}</button>`).join("")}</nav>` : ""}
      <div class="cmain">${tab === "store" ? renderStore(inv, items, labels, q) : renderRecipes(inv, labels, q)}</div>
    </div>
    ${inv?.file && tab === "store" ? `<p class="hint cfile">Agents on ${esc(inv.machine)} can also read the whole list at <code>${esc(inv.file.replace(/^\/(Users|home)\/[^/]+/, "~"))}</code>, or ask the deck’s MCP server.</p>` : ""}
    <div class="cbar${n ? " on" : ""}"><b>${n}</b>&nbsp;selected<button class="btn ghost" data-cclear>Clear</button><span class="spacer"></span><button class="btn ghost" data-ccopy2>Copy</button><button class="btn ghost" data-cmix title="Open them in Discover’s mixer">Mix these</button><button class="btn" data-cuse>${CICON.recipe}Use in a recipe</button>${target ? `<button class="btn primary" data-csend>Add to “${esc(target.title.slice(0, 28))}${target.title.length > 28 ? "…" : ""}”</button>` : `<button class="btn primary" data-csendpick>Add to a session…</button>`}</div>`);
}
async function connText(ids) {
  const m = S.conn.machine ?? S.self;
  const { text } = await api("/api/connections-text", { machine: m, ids });
  return `Context from herdr deck: connections you can use for this work on ${machineLabel(m)}. Use them when they help.\n\n${text}`;
}
async function sendConnections(ids, key) {
  const r = rowOf(key);
  if (!r) return toast("Pick a session first", true);
  try {
    const text = await connText(ids);
    const busy = r.status === "working";
    if (text.length > LONG_SEND) { const withFile = await fileLongText(r, "Here are the connections you can use.", [{ text, name: "connections.md" }]); await api(busy ? "/api/queue" : "/api/send", busy ? { op: "add", key, text: withFile } : { key, text: withFile }); }
    else await api(busy ? "/api/queue" : "/api/send", busy ? { op: "add", key, text } : { key, text });
    toast(`${busy ? "Queued" : "Added"} ${ids.length} connection${ids.length === 1 ? "" : "s"} for “${r.title}”`);
    S.conn.pick.clear();
    setMode(null);
    select(key, { open: true });
  } catch (e) { toast(e.message, true); }
}
function pickSessionFor(anchor, run) {
  const rows = [...S.rows.values()].filter((r) => isAgent(r) && !r.app && inScope(r)).sort((a, b) => act(b) - act(a)).slice(0, 14);
  openMenu(anchor, rows.map((r) => ({ html: `<span class="dot" style="--c:${statusVar(r.status)}"></span> ${esc(r.title)}<small>${esc(r.project)}</small>`, run: () => run(r.key) })), "Add to which session?");
}
function connItem(id) { return connItems(S.conn.data.get(S.conn.machine ?? S.self)).find((x) => x.id === id); }
async function connConf(body) {
  try { const inv = await api("/api/connections-conf", { machine: S.conn.machine ?? S.self, ...body }); S.conn.data.set(S.conn.machine ?? S.self, inv); renderConnections(); }
  catch (e) { toast(e.message, true); }
}
function recipeOf(id) { return S.conn.recipes.get(S.conn.machine ?? S.self)?.recipes.find((r) => r.id === id); }
async function recipePrompt(id) { return api("/api/recipes", { op: "prompt", id, machine: S.conn.machine ?? S.self, picked: S.conn.rfor ? [...S.conn.rfor] : [] }); }
/** Run = the New session dialog, prefilled. Nothing starts until the user presses Start there. */
async function runRecipe(id) {
  const r = recipeOf(id);
  if (!r) return;
  let p;
  try { p = await recipePrompt(id); } catch (e) { return toast(e.message, true); }
  let m = S.conn.machine ?? S.self;
  if (p.machine === "other") m = realMachines().find((x) => x.id !== S.self && x.online)?.id ?? m;
  const tgt = rowOf(S.conn.target);
  const cwd = p.folder || (tgt && tgt.machine === m ? tgt.projectRoot ?? tgt.cwd : "") || "";
  await openNew(cwd ? { machine: m, cwd, project: r.title } : undefined);
  if (newMachine !== m && realMachines().some((x) => x.id === m && x.online)) {
    newMachine = m;
    for (const b of $("nMachine").children) b.setAttribute("aria-pressed", b.dataset.m === m);
    await loadNewOptions();
  }
  if (KINDS.some(([k]) => k === p.agent) && newKind !== p.agent) { newKind = p.agent; renderKinds(); }
  $("newDlg").querySelector("h3").textContent = `Run recipe: ${r.title}`;
  $("nPrompt").value = p.prompt;
  $("nLabel").value = r.title.slice(0, 40);
  renderCmd();
}
async function customizeRecipe(id) {
  const r = recipeOf(id);
  if (!r) return;
  const inv = S.conn.data.get(S.conn.machine ?? S.self);
  const picked = [...S.conn.pick].map((x) => connItems(inv).find((i) => i.id === x)).filter(Boolean);
  const d = document.createElement("dialog");
  d.className = "ask rdlg";
  const cats = (inv?.categories ?? []).filter((c) => !["keys", "skills", "yours"].includes(c.id));
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${r.custom ? "Edit your recipe" : `Customize “${esc(r.title)}”`}</h3><p class="hint">${r.custom ? "" : "Saved as your own copy; the built-in stays as it is. "}Stored on the hub in ~/.config/herdr-deck/recipes.json.</p>
    <label class="lab">Title</label><input class="inp" name="title" required maxlength="80" value="${esc(r.custom ? r.title : `${r.title} (mine)`)}">
    <label class="lab">One-line pitch</label><input class="inp" name="pitch" maxlength="240" value="${esc(r.pitch)}">
    <div class="rrow"><div><label class="lab">Category</label><select class="inp" name="cat">${cats.map((c) => `<option value="${esc(c.id)}"${c.id === r.cat ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select></div>
      <div><label class="lab">Agent</label><select class="inp" name="agent">${KINDS.filter(([k]) => k !== "shell").map(([k, l]) => `<option value="${k}"${k === (r.agent ?? "claude") ? " selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label class="lab">Runs on</label><select class="inp" name="machine"><option value="hub">The machine you pick</option><option value="other"${r.machine === "other" ? " selected" : ""}>Your other machine</option></select></div></div>
    <label class="lab">Folder <span class="hint">(optional, e.g. ~/wiki)</span></label><input class="inp" name="folder" value="${esc(r.folder ?? "")}">
    <label class="lab">Steps <span class="hint">(one per line)</span></label><textarea class="inp" name="steps" rows="4">${esc(r.steps.join("\n"))}</textarea>
    <label class="lab">Prompt <span class="hint">({connections}, {machine}, {date} are filled in)</span></label><textarea class="inp rpt" name="prompt" rows="9" required>${esc(r.prompt)}</textarea>
    ${picked.length ? `<label class="chk-l"><input type="checkbox" name="addpicked"> Also require my ${picked.length} selected connection${picked.length === 1 ? "" : "s"} (${esc(picked.slice(0, 3).map((i) => i.name).join(", "))}${picked.length > 3 ? "…" : ""})</label>` : ""}</div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save recipe</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", async () => {
    if (d.returnValue === "ok") {
      const f = Object.fromEntries(new FormData(d.querySelector("form")));
      const needs = [...r.needs, ...(f.addpicked ? picked.map((i) => ({ label: i.name, any: [i.id] })) : [])];
      try {
        await api("/api/recipes", { op: "save", machine: S.conn.machine ?? S.self, recipe: { ...f, id: r.custom ? r.id : undefined, from: r.custom ? r.from : r.id, needs, optional: r.optional ?? [] } });
        S.conn.rcat = "mine"; await loadRecipes(true); toast("Saved your recipe");
      } catch (e) { toast(e.message, true); }
    }
    d.remove();
  });
  d.showModal();
}
function connRerender(fn) { fn(); renderConnections(); }
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "connections") return;
  const t = e.target;
  const tab = t.closest("[data-ctab]")?.dataset.ctab;
  if (tab) { S.conn.tab = tab; store("connTab", tab); if (tab === "recipes") loadRecipes(); $("dbody").scrollTop = 0; return renderConnections(); }
  const cm = t.closest("[data-cmach]")?.dataset.cmach;
  if (cm) { S.conn.machine = cm; S.conn.pick.clear(); S.conn.rfor = null; renderConnections(); loadConnections(); if (S.conn.tab === "recipes") loadRecipes(); return; }
  const cat = t.closest("[data-ccat]")?.dataset.ccat;
  if (cat) { S.conn.cat = cat; store("connCat2", cat); S.conn.open = null; S.conn.q = ""; S.conn.more = false; $("dbody").scrollTop = 0; return renderConnections(); }
  const jump = t.closest("[data-cjump]");
  if (jump) { S.conn.cat = jump.dataset.cjcat; store("connCat2", S.conn.cat); S.conn.open = jump.dataset.cjump; renderConnections(); $("dbody").querySelector(`[data-cid="${CSS.escape(jump.dataset.cjump)}"]`)?.scrollIntoView({ block: "center", behavior: reduceMotion.matches ? "auto" : "smooth" }); return; }
  const rcat = t.closest("[data-rcat]")?.dataset.rcat;
  if (rcat) return connRerender(() => { S.conn.rcat = rcat; S.conn.ropen = null; });
  const go = t.closest("[data-cgorecipe]")?.dataset.cgorecipe;
  if (go) return connRerender(() => { S.conn.tab = "recipes"; S.conn.rcat = "all"; S.conn.q = ""; S.conn.rfor = null; S.conn.ropen = go; });
  if (t.closest("[data-rforclear]")) return connRerender(() => { S.conn.rfor = null; });
  if (t.closest("[data-crefresh]")) return loadConnections(true);
  if (t.closest("[data-cshowhid]")) return connRerender(() => { S.conn.showHidden = !S.conn.showHidden; });
  if (t.closest("[data-cmore]")) return connRerender(() => { S.conn.more = true; });
  const inv = S.conn.data.get(S.conn.machine ?? S.self);
  const labels = Object.fromEntries((inv?.categories ?? []).map((c) => [c.id, c.label]));
  const inView = () => connView(connItems(inv), { cat: S.conn.cat, q: S.conn.q.trim(), showHidden: S.conn.showHidden, labels });
  if (t.closest("[data-csall]")) return connRerender(() => { S.conn.pick = connSelectAll(S.conn.pick, inView()); });
  if (t.closest("[data-csnone]")) return connRerender(() => { S.conn.pick = connSelectNone(S.conn.pick, inView()); });
  if (t.closest("[data-cseverything]")) return connRerender(() => { S.conn.pick = connSelectAll(S.conn.pick, connItems(inv).filter((i) => connState(i) === "ready" && !i.hidden)); });
  if (t.closest("[data-cclear]")) return connRerender(() => { S.conn.pick = connSelectNone(S.conn.pick); });
  if (t.closest("[data-ccopy2]")) return copy(await connText([...S.conn.pick]), "connections");
  if (t.closest("[data-cuse]")) { S.conn.rfor = new Set(S.conn.pick); S.conn.tab = "recipes"; S.conn.rcat = "all"; S.conn.q = ""; $("dbody").scrollTop = 0; loadRecipes(); return renderConnections(); }
  if (t.closest("[data-csend]")) return sendConnections([...S.conn.pick], S.conn.target);
  if (t.closest("[data-csendpick]")) return pickSessionFor(t.closest("[data-csendpick]"), (k) => sendConnections([...S.conn.pick], k));
  if (t.closest("[data-cadd]")) return addConnection();
  if (t.closest("[data-csuggest]")) return suggestProjects();
  const rc = t.closest("[data-rid]");
  if (rc) {
    const id = rc.dataset.rid;
    if (t.closest("[data-rrun]")) return runRecipe(id);
    if (t.closest("[data-rcopy]")) { try { copy((await recipePrompt(id)).prompt, "the recipe prompt"); } catch (err) { toast(err.message, true); } return; }
    if (t.closest("[data-rcustom]")) return customizeRecipe(id);
    if (t.closest("[data-rdel]")) { if (await askDialog({ title: `Delete “${recipeOf(id)?.title}”?`, ok: "Delete", danger: true })) { try { await api("/api/recipes", { op: "delete", id }); await loadRecipes(true); } catch (err) { toast(err.message, true); } } return; }
    if (t.closest("[data-ropen]") && !t.closest("details")) return connRerender(() => { S.conn.ropen = S.conn.ropen === id ? null : id; });
    return;
  }
  const card = t.closest("[data-cid]");
  if (!card) return;
  const id = card.dataset.cid;
  if (t.closest("[data-cpick]")) return connRerender(() => { S.conn.pick.has(id) ? S.conn.pick.delete(id) : S.conn.pick.add(id); });
  if (t.closest("[data-chide]")) return connConf({ op: connItem(id)?.hidden ? "unhide" : "hide", id });
  if (t.closest("[data-cremove]")) { if (await askDialog({ title: `Remove “${connItem(id)?.name}”?`, ok: "Remove", danger: true })) connConf({ op: "remove", id }); return; }
  if (t.closest("[data-cone]")) return S.conn.target ? sendConnections([id], S.conn.target) : pickSessionFor(t.closest("[data-cone]"), (k) => sendConnections([id], k));
  if (t.closest("[data-copen]")) { S.conn.open = S.conn.open === id ? null : id; if (S.conn.open) loadRecipes(); renderConnections(); $("dbody").querySelector(`[data-cid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" }); }
});
$("dbody").addEventListener("input", (e) => {
  if (S.mode !== "connections" || !e.target.matches("[data-csearch]")) return;
  S.conn.q = e.target.value;
  S.conn.more = false;
  clearTimeout(renderConnections.t);
  renderConnections.t = setTimeout(() => { const pos = e.target.selectionStart; renderConnections(); const el = $("dbody").querySelector("[data-csearch]"); el?.focus(); el?.setSelectionRange(pos, pos); }, 80);
});
$("dbody").addEventListener("focusout", (e) => {
  if (S.mode !== "connections" || !e.target.matches("[data-cnote]")) return;
  const id = e.target.closest("[data-cid]")?.dataset.cid;
  const it = connItem(id);
  if (it && e.target.value.trim() !== (it.use ?? "").trim()) connConf({ op: "note", id, text: e.target.value });
});
async function addConnection() {
  const d = document.createElement("dialog");
  d.className = "ask";
  const inv = S.conn.data.get(S.conn.machine ?? S.self);
  const cats = (inv?.categories ?? []).filter((c) => !["skills", "keys", "mcp"].includes(c.id));
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Add a connection</h3><p class="hint">Something agents on ${esc(machineLabel(S.conn.machine ?? S.self))} can use that the scan can’t see.</p>
    <label class="lab">Name</label><input class="inp" name="name" placeholder="Staging server" required>
    <label class="lab">What it’s for</label><input class="inp" name="detail" placeholder="Pre-production copy of the funnel">
    <label class="lab">Category</label><select class="inp" name="cat">${cats.map((c) => `<option value="${esc(c.id)}"${c.id === "yours" ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
    <label class="lab">How agents should use it</label><textarea class="inp" name="use" rows="3" placeholder="ssh staging, app in /srv/app, restart with pm2 restart app"></textarea>
    <label class="lab">Reached via <span class="hint">(comma separated, optional)</span></label><input class="inp" name="via" placeholder="ssh staging, key STAGING_TOKEN"></div>
    <div class="dlg-f"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Add</button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", () => {
    if (d.returnValue === "ok") { const f = Object.fromEntries(new FormData(d.querySelector("form"))); S.conn.cat = f.cat || "yours"; S.conn.q = ""; connConf({ op: "add", item: f }); }
    d.remove();
  });
  d.showModal();
}
async function suggestProjects() {
  if (!(await askDialog({ title: "Suggest mega projects?", text: "Starts a new Claude session (in ~/wiki if you have one, otherwise your home folder) with the list of everything your machines can reach (names only, no keys), and asks it to propose ambitious projects. It won’t build anything until you pick.", ok: "Start" }))) return;
  try { const r = await api("/api/suggest-projects", {}); toast("Starting a Claude session with your connections…"); if (r.key) pendingSelect = r.key; } catch (e) { toast(e.message, true); }
}

// ══ Discover ═════════════════════════════════════════════════════════════════
// Repos worth forking, matched to what you build; an idea lab that searches GitHub for building blocks; the
// plans agents write for your ideas; and "what if" sparks. Server side: src/discover.ts.
// Nothing here starts a session on its own: every action opens the New session dialog, prefilled.
ICON.compass = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="m10.7 5.3-1.6 3.8-3.8 1.6 1.6-3.8z"/></svg>';
ICON.bulb = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12.4h4M6.6 14.4h2.8M8 1.7a4.4 4.4 0 0 0-2.6 8c.4.3.6.8.6 1.3v.4h4V11c0-.5.2-1 .6-1.3A4.4 4.4 0 0 0 8 1.7z"/></svg>';
S.disc = { data: null, loading: false, tab: load("discTab", "you"), filter: null, idea: load("discIdea", ""), ideaRes: null, ideaBusy: false, open: null, plans: new Map(), shuffle: 0, pending: null, more: false };
const DTABS = [["you", "For you"], ["mix", "Mix"], ["lab", "Idea lab"], ["ideas", "Ideas"], ["saved", "Saved"]];
const kfmt = (n) => (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(n)));
function dHue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

async function loadDiscover(opts = {}) {
  clearTimeout(loadDiscover.t);
  if (S.disc.loading && !opts.refresh) return;
  S.disc.loading = true;
  if (opts.refresh && S.disc.data) { S.disc.data.refreshing = true; if (S.mode === "discover") renderDiscover(); }
  try { S.disc.data = await api("/api/discover", { refresh: !!opts.refresh, shuffle: S.disc.shuffle }); }
  catch (e) { toast(e.message, true); }
  S.disc.loading = false;
  if (S.mode !== "discover") return;
  // The mixer keeps its own regions up to date; a background refresh doesn't rebuild it (and the phone keyboard) mid-typing.
  if (S.disc.tab !== "mix" || !$("dbody").querySelector("#mixtray")) renderDiscover();
  // While GitHub is being searched, or today's mixes are being made, check back every few seconds.
  const fy = S.disc.data?.mixes?.forYou;
  if (S.disc.data?.refreshing || fy?.running || fy?.waiting) loadDiscover.t = setTimeout(() => { if (S.mode === "discover") loadDiscover(); }, 3000);
}
function discTab(t) { S.disc.tab = t; store("discTab", t); renderDiscover(); $("dbody").scrollTop = 0; if (t === "mix") mixEnter(); }
function gemBy(full) {
  const d = S.disc.data ?? {};
  const all = [...(d.gems ?? []), ...(d.trending ?? []), ...(d.saved ?? []), ...(S.disc.ideaRes?.groups ?? []).flatMap((g) => g.repos)];
  return all.find((g) => g.full === full);
}
const isSaved = (full) => (S.disc.data?.saved ?? []).some((x) => x.full === full);

function gemCard(g, i, opts = {}) {
  const projs = [...new Set((g.why ?? []).flatMap((w) => w.projects))].slice(0, 3);
  const saved = isSaved(g.full);
  const areas = (g.why ?? []).map((w) => w.label).slice(0, 2);
  return `<article class="gcard${opts.mini ? " gmini" : ""}" data-gfull="${esc(g.full)}" style="--h:${dHue(g.full)};--i:${Math.min(i, 10)}">
    <div class="gtop"><span class="cbadge">${esc(initials(g.name))}</span><div class="gid">
      <a class="gname" href="${esc(g.url)}" target="_blank" rel="noopener" title="Open ${esc(g.full)} on GitHub"><span class="gown">${esc(g.owner)}/</span>${esc(g.name)}</a>
      <div class="gmeta"><span title="${g.stars} stars">★ ${kfmt(g.stars)}</span>${g.lang ? `<span>${esc(g.lang)}</span>` : ""}${g.pushed ? `<span title="Last push ${esc(g.pushed.slice(0, 10))}">${esc(agoText(Date.parse(g.pushed)))}</span>` : ""}${g.license ? `<span>${esc(g.license)}</span>` : ""}${g.spm >= 25 ? `<span class="ghot" title="About ${kfmt(g.spm)} stars a month since it started">↑ ${kfmt(g.spm)}/mo</span>` : ""}</div>
    </div></div>
    ${g.desc ? `<p class="gdesc">${esc(g.desc)}</p>` : ""}
    ${g.topics?.length && !opts.mini ? `<div class="gtopics">${g.topics.slice(0, 5).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    ${areas.length ? `<div class="gwhy">${ICON.star}<span>Fits <b>${esc(areas.join(" + "))}</b>${projs.length ? ` · like your ${projs.map((p) => `<i>${esc(p)}</i>`).join(", ")}` : ""}</span></div>` : ""}
    <div class="gacts"><button class="btn primary" data-gfork>Fork &amp; explore</button><a class="btn ghost" href="${esc(g.url)}" target="_blank" rel="noopener">GitHub</a><button class="btn ghost" data-gsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button><button class="btn ghost" data-gmix title="Add it to the mixer and combine it with your other things">Mix this</button>${opts.saved ? "" : `<button class="btn ghost" data-gdis title="Don’t show it again">Dismiss</button>`}</div>
  </article>`;
}
function discStatus(d) {
  const n = d.profile.interests.length;
  if (!d.gh) return `<span class="derr">${ICON.warn}The GitHub CLI (<code>gh</code>) isn’t installed here, so there’s nothing to search with.</span>`;
  const when = d.fetchedAt ? `found ${esc(agoText(d.fetchedAt))}` : "";
  return `${d.refreshing ? `<span class="spin"></span><span>Searching GitHub${d.progress?.total ? ` · ${Math.min(d.progress.done, d.progress.total)} of ${d.progress.total}` : ` in ${n} areas`}… cached results stay up meanwhile</span>` : `<span>${d.stale && d.fetchedAt ? `<b class="dstale">Stale</b> · ` : ""}${when ? `Gems ${when}` : "No gems fetched yet"}</span>`}
    ${d.error ? `<span class="derr" title="${esc(d.error)}">${ICON.warn}${esc(d.error.slice(0, 90))}</span>` : ""}<span class="spacer"></span><button class="btn ghost" data-drefresh ${d.refreshing ? "disabled" : ""}>Refresh</button>`;
}
function renderDiscover() {
  const d = S.disc.data;
  const tab = S.disc.tab;
  const nIdeas = d?.ideas?.length ?? 0, nSaved = (d?.saved?.length ?? 0) + (d?.mixes?.saved?.length ?? 0);
  const tabs = DTABS.map(([id, label]) => `<button data-dtab="${id}" aria-pressed="${tab === id}">${label}${id === "ideas" && nIdeas ? ` <span class="n">${nIdeas}</span>` : id === "saved" && nSaved ? ` <span class="n">${nSaved}</span>` : ""}</button>`).join("");
  // The mixer, once on screen, is only ever patched region by region: its inputs are never rebuilt under your fingers.
  if (tab === "mix" && d && $("dbody")._mode === "discover" && $("dbody").querySelector(":scope > .view #mixtray")) {
    const nav = $("dbody").querySelector(".dtabs");
    if (nav) setHTML(nav, tabs);
    return mixPatch();
  }
  const head = `<header class="vh"><h2>${ICON.compass}Discover</h2><p>Repos worth forking, picked for what you build. Any idea, searched against what already exists and planned by an agent.</p>
    <nav class="seg dtabs">${tabs}</nav></header>`;
  let body = "";
  if (!d) body = `<div class="dgrid">${Array.from({ length: 6 }, () => '<div class="gcard skel"></div>').join("")}</div><p class="hint">Reading your wiki and repos…</p>`;
  else if (tab === "lab") body = discLab(d);
  else if (tab === "mix") body = discMix();
  else if (tab === "ideas") body = discIdeas(d);
  else if (tab === "saved") body = discSaved(d, nSaved);
  else body = discForYou(d);
  const ta = document.activeElement?.matches?.("[data-didea], [data-mixdir], [data-mixq]") ? document.activeElement : null;
  const taSel = ta ? [...["didea", "mixdir", "mixq"].filter((k) => k in ta.dataset).map((k) => `[data-${k}]`), ta.selectionStart, ta.selectionEnd] : null;
  // Cards animate in when a tab (or a new idea result) first appears, not on every background update.
  const animKey = `${tab}|${S.disc.ideaRes?.text ?? ""}|${!!d}`;
  const calm = S.disc.animKey === animKey && $("dbody")._mode === "discover";
  S.disc.animKey = animKey;
  // The flag lives on the persistent .view element, so flipping it never rebuilds the cards.
  $("dbody").querySelector(":scope > .view")?.classList.toggle("calm", calm);
  // Background redraws keep where you swiped the horizontal rows to.
  const strips = [...$("dbody").querySelectorAll(".dstrip")].map((x) => x.scrollLeft);
  modeHTML(head + body);
  $("dbody").querySelectorAll(".dstrip").forEach((x, i) => { if (strips[i]) x.scrollLeft = strips[i]; });
  $("dbody").querySelector(":scope > .view")?.classList.toggle("calm", calm);
  if (taSel) { const t = $("dbody").querySelector(taSel[0]); t?.focus(); try { t?.setSelectionRange(taSel[1], taSel[2]); } catch {} }
  if (tab === "mix" && d && !S.disc.mix.ings && !S.disc.mix.loading) mixEnter();
}
function discForYou(d) {
  const p = d.profile;
  const f = S.disc.filter && p.interests.some((i) => i.id === S.disc.filter) ? S.disc.filter : null;
  const gems = f ? d.gems.filter((g) => g.why.some((w) => w.id === f)) : d.gems;
  const shown = gems.slice(0, S.disc.more || f ? 48 : 18);
  const langs = p.languages.slice(0, 3).map((l) => l.name);
  const chip = (i) => `<span class="dchip${f === i.id ? " on" : ""}${i.source === "you" ? " you" : ""}" title="${esc(i.projects.length ? `From ${i.projects.join(", ")}` : i.source === "you" ? "You added this" : "")}"><button data-dfilter="${esc(i.id)}" aria-pressed="${f === i.id}">${esc(i.label)}</button><button class="dx" data-dremove="${esc(i.id)}" aria-label="Remove ${esc(i.label)}">${ICON.x}</button></span>`;
  return `<section class="dprof"><h3 class="dsub">What you’re into</h3>
      <div class="dchips">${p.interests.map(chip).join("")}<button class="dchip add" data-dadd>${ICON.plus}Add</button></div>
      <p class="hint">From ${p.counts.wiki} wiki projects, ${p.counts.concepts} concepts, ${p.counts.log} recent log entries and ${p.counts.repos} local repos${p.connections.length ? `, plus ${p.connections.length} connections` : ""}.${langs.length ? ` Mostly ${esc(langs.join(", "))}.` : ""} Only these keywords are sent to GitHub search.${p.removed.length ? ` <button class="link" data-drestore>Restore ${p.removed.length} removed</button>` : ""}</p></section>
    ${f ? "" : mixesForYou(d)}
    <div class="dstatus">${discStatus(d)}</div>
    ${d.trending.length && !f ? `<h3 class="dsub">Trending in your areas <span class="hint">new this season, climbing fast</span></h3><div class="dstrip">${d.trending.map((g, i) => gemCard(g, i, { mini: true })).join("")}</div>` : ""}
    <h3 class="dsub">Hidden gems ${f ? `<span class="hint">in ${esc(p.interests.find((i) => i.id === f)?.label)}</span> <button class="link" data-dfilter="">Show all</button>` : `<span class="hint">30–5,000 stars, active this half-year, licensed</span>`}</h3>
    ${shown.length ? `<div class="dgrid">${shown.map((g, i) => gemCard(g, i)).join("")}</div>${gems.length > shown.length ? `<p style="text-align:center;margin-top:14px"><button class="btn" data-dmore>Show ${gems.length - shown.length} more</button></p>` : ""}`
      : d.refreshing || !d.fetchedAt ? `<div class="dgrid">${Array.from({ length: 6 }, () => '<div class="gcard skel"></div>').join("")}</div>` : `<div class="empty-state">No gems ${f ? "in this area" : "yet"}. Try Refresh, or add an interest.</div>`}
    ${d.dismissed ? `<p class="hint" style="margin-top:18px">${d.dismissed} dismissed. <button class="link" data-dundis>Bring them back</button></p>` : ""}`;
}
function repoRow(r) {
  const saved = isSaved(r.full);
  return `<div class="drow" data-gfull="${esc(r.full)}"><div class="drt"><a href="${esc(r.url)}" target="_blank" rel="noopener"><span class="gown">${esc(r.owner)}/</span>${esc(r.name)}</a><span class="gmeta"><span>★ ${kfmt(r.stars)}</span>${r.lang ? `<span>${esc(r.lang)}</span>` : ""}${r.pushed ? `<span>${esc(agoText(Date.parse(r.pushed)))}</span>` : ""}${r.license ? `<span>${esc(r.license)}</span>` : ""}</span></div>
    ${r.desc ? `<p>${esc(r.desc)}</p>` : ""}<div class="dracts"><button class="btn ghost" data-gfork>Fork &amp; explore</button><button class="btn ghost" data-gsave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button></div></div>`;
}
function discLab(d) {
  const r = S.disc.ideaRes;
  const chips = (xs, cls = "") => xs.map((x) => `<span class="dtag ${cls}">${esc(x)}</span>`).join("");
  return `<section class="dlab">
      <textarea class="dbig" data-didea rows="3" placeholder="Describe any idea, however ambitious. “A voice that tells me each morning what today’s transits mean for my chart”, “a map of every drone show on Earth”…" aria-label="Your idea">${esc(S.disc.idea)}</textarea>
      <div class="dlabacts"><button class="btn" data-dsearch ${S.disc.ideaBusy ? "disabled" : ""}>${S.disc.ideaBusy ? '<span class="spin"></span>Searching…' : `${ICON.compass}Find building blocks`}</button><button class="btn primary" data-dresearch ${S.disc.ideaBusy ? "disabled" : ""}>${ICON.bulb}Research &amp; plan it</button>
        <span class="hint">Enter searches GitHub (only the idea’s keywords are sent). Research opens a new Claude Code session prefilled; you confirm it.</span></div>
    </section>
    ${r ? `<section class="dres">
      <p class="dkw"><span class="hint">Searched for</span> ${chips(r.keywords)}${r.cachedAt && Date.now() - r.cachedAt > 60_000 ? ` <span class="hint">· cached ${esc(agoText(r.cachedAt))}</span>` : ""}</p>
      ${r.related.length ? `<p class="dkw"><span class="hint">Your own work</span> ${chips(r.related, "dmine")}</p>` : ""}
      ${r.connections.length ? `<p class="dkw"><span class="hint">Your connections</span> ${chips(r.connections, "dconn")}</p>` : ""}
      ${r.groups.length ? r.groups.map((g) => `<h4 class="drole">${esc(g.role)} <span class="n">${g.repos.length}</span></h4><div class="dblocks">${g.repos.map(repoRow).join("")}</div>`).join("") : `<div class="empty-state">GitHub has nothing matching those words yet. That can be a good sign: research it to find the services and APIs that could do it.</div>`}
      ${r.topics.length ? `<p class="dkw dtopics"><span class="hint">GitHub topics</span> ${r.topics.map((t) => `<a class="dtag" href="https://github.com/topics/${encodeURIComponent(t.name)}" target="_blank" rel="noopener" title="${esc(t.desc)}">#${esc(t.name)}</a>`).join("")}</p>` : ""}
    </section>` : ""}
    <h3 class="dsub">Sparks <span class="hint">“what if” ideas from your projects, interests and connections</span> <button class="link" data-dshuffle>Shuffle</button></h3>
    <div class="dsparks">${d.sparks.map((s, i) => `<article class="spark" data-spark="${esc(s.id)}" style="--h:${dHue(s.id)};--i:${i}"><h4>${esc(s.title)}</h4><p>${esc(s.pitch)}</p><div class="suses">${chips(s.uses)}</div><div class="gacts"><button class="btn ghost" data-sparktry>Find building blocks</button><button class="btn primary" data-sparkplan>Research &amp; plan it</button></div></article>`).join("")}</div>`;
}
function discIdeas(d) {
  const ideas = d.ideas ?? [];
  if (!ideas.length) return `<div class="empty-state">No plans yet. Describe an idea in the <button class="link" data-dtab="lab">Idea lab</button> and press <b>Research &amp; plan it</b>: the agent writes its plan to <code>~/.config/herdr-deck/ideas/</code> and it shows up here.</div>`;
  return `<p class="hint dlead">Plans your agents wrote. Read one, then start building from it.</p><div class="dideas">${ideas.map((x, i) => {
    const open = S.disc.open === x.slug;
    const plan = S.disc.plans.get(x.slug);
    const live = x.session && rowOf(x.session.key);
    return `<article class="icard${open ? " open" : ""}" data-islug="${esc(x.slug)}" style="--i:${Math.min(i, 8)}">
      <div class="itop" ${x.pending ? "" : "data-iopen"}><span class="ist ${x.pending ? "busy" : esc(x.status)}">${x.pending ? '<span class="spin"></span>Researching' : esc(x.status)}</span><h4>${esc(x.title)}</h4><span class="hint">${esc(agoText(x.mtime))}</span></div>
      ${x.idea && x.idea !== x.title ? `<p class="iidea">“${esc(x.idea)}”</p>` : ""}
      ${x.summary && !open ? `<p class="isum">${esc(x.summary)}</p>` : ""}
      ${open ? `<div class="iplan md">${plan ? md(plan.text) : '<span class="spin"></span>'}</div>` : ""}
      <div class="gacts">${live ? `<button class="btn ghost" data-isess="${esc(x.session.key)}"><span class="dot" style="--c:${statusVar(live.status)}"></span>Open the session</button>` : ""}
        ${x.pending ? `<button class="btn ghost" data-iforget>Forget</button>` : `<button class="btn ghost" data-iopen>${open ? "Close" : "Read the plan"}</button><button class="btn primary" data-ibuild>Start building</button><button class="btn ghost" data-icopy>Copy path</button>`}</div>
    </article>`;
  }).join("")}</div>`;
}

/** Opens the New session dialog with a Discover prompt. The user reviews and confirms; nothing runs before that. */
async function discStart(kind, extra, title) {
  try {
    const r = await api("/api/discover/prompt", { kind, ...extra });
    S.disc.pending = r.slug ? { slug: r.slug, text: extra.text } : null;
    await openNew({ machine: S.self, cwd: r.cwd, project: "Discover", prompt: r.prompt, kind: "claude", label: r.label, title });
    promptTop();
  } catch (e) { toast(e.message, true); }
}
/** Show a long prefilled prompt from its first line, not its last. */
function promptTop() { const t = $("nPrompt"); t.scrollTop = 0; t.setSelectionRange?.(0, 0); }
async function ideaSearch(text) {
  text = String(text ?? S.disc.idea).trim();
  if (text.length < 4) { toast("Describe the idea first", true); return null; }
  S.disc.idea = text; store("discIdea", text);
  S.disc.ideaBusy = true; S.disc.tab = "lab"; store("discTab", "lab");
  renderDiscover();
  try { S.disc.ideaRes = { ...(await api("/api/discover/idea", { text }, 25_000)), text }; }
  catch (e) { toast(e.message, true); }
  S.disc.ideaBusy = false;
  if (S.mode === "discover") renderDiscover();
  return S.disc.ideaRes?.text === text ? S.disc.ideaRes : null;
}
async function ideaResearch(text) {
  text = String(text ?? S.disc.idea).trim();
  let r = S.disc.ideaRes?.text === text ? S.disc.ideaRes : await ideaSearch(text);
  // GitHub slow or rate-limited: plan it anyway; the research agent does its own searching.
  if (!r && text.length >= 4) { try { r = await api("/api/discover/prompt", { kind: "research", text }, 10_000); } catch (e) { toast(e.message, true); } }
  if (!r) return;
  S.disc.pending = { slug: r.slug, text };
  await openNew({ machine: S.self, cwd: r.cwd, project: "Idea lab", prompt: r.prompt, kind: "claude", label: `Plan: ${text.slice(0, 28)}`, title: "Research & plan this idea" });
  promptTop();
}
// A research session that actually started gets listed under Ideas right away (as "Researching").
$("newDlg").addEventListener("close", () => {
  const p = S.disc.pending;
  S.disc.pending = null;
  if (!p || $("newDlg").returnValue !== "ok" || !$("nPrompt").value.includes(`ideas/${p.slug}.md`)) return;
  api("/api/discover/idea-started", p).then((r) => { if (S.disc.data) S.disc.data.ideas = r.ideas; if (S.mode === "discover") renderDiscover(); }).catch(() => {});
});
async function discRepo(op, g) {
  try {
    const r = await api("/api/discover/repo", { op, repo: g, full: g.full });
    if (S.disc.data) { S.disc.data.saved = r.saved; S.disc.data.dismissed = r.dismissed; }
  } catch (e) { toast(e.message, true); }
}
$("dbody").addEventListener("click", async (e) => {
  if (S.mode !== "discover") return;
  const t = e.target;
  const tab = t.closest("[data-dtab]")?.dataset.dtab;
  if (tab) return discTab(tab);
  if (t.closest("[data-drefresh]")) return loadDiscover({ refresh: true });
  const fl = t.closest("[data-dfilter]");
  if (fl) { S.disc.filter = fl.dataset.dfilter && S.disc.filter !== fl.dataset.dfilter ? fl.dataset.dfilter : null; return renderDiscover(); }
  const rm = t.closest("[data-dremove]")?.dataset.dremove;
  if (rm) { try { S.disc.data = await api("/api/discover/interest", { op: "remove", id: rm }); if (S.disc.filter === rm) S.disc.filter = null; renderDiscover(); } catch (err) { toast(err.message, true); } return; }
  if (t.closest("[data-dadd]")) {
    const label = await askDialog({ title: "Add an interest", text: "A few words GitHub can search for, like “procedural music” or “home robotics”. Gems for it appear after the next search.", input: "", ok: "Add" });
    if (!label?.trim()) return;
    try { S.disc.data = await api("/api/discover/interest", { op: "add", label }); renderDiscover(); if (S.disc.data.refreshing) loadDiscover.t = setTimeout(() => loadDiscover(), 3000); } catch (err) { toast(err.message, true); }
    return;
  }
  if (t.closest("[data-drestore]")) { try { S.disc.data = await api("/api/discover/interest", { op: "restore" }); renderDiscover(); } catch (err) { toast(err.message, true); } return; }
  if (t.closest("[data-dmore]")) { S.disc.more = true; return renderDiscover(); }
  if (t.closest("[data-dundis]")) { await discRepo("undismiss", { full: "*/*" }); return loadDiscover(); }
  if (t.closest("[data-dshuffle]")) { S.disc.shuffle++; return loadDiscover(); }
  if (t.closest("[data-dsearch]")) return ideaSearch($("dbody").querySelector("[data-didea]")?.value);
  if (t.closest("[data-dresearch]")) return ideaResearch($("dbody").querySelector("[data-didea]")?.value);
  const sp = t.closest("[data-spark]");
  if (sp) {
    const s = S.disc.data?.sparks?.find((x) => x.id === sp.dataset.spark);
    if (!s) return;
    if (t.closest("[data-sparktry]")) { $("dbody").scrollTop = 0; return ideaSearch(s.idea); }
    if (t.closest("[data-sparkplan]")) { S.disc.idea = s.idea; store("discIdea", s.idea); return ideaResearch(s.idea); }
    return;
  }
  if (mixClick(t)) return;
  const ic = t.closest("[data-islug]");
  if (ic) {
    const slug = ic.dataset.islug;
    const x = S.disc.data?.ideas?.find((i) => i.slug === slug);
    const sess = t.closest("[data-isess]")?.dataset.isess;
    if (sess) { setMode(null); return select(sess, { scroll: true, open: true }); }
    if (t.closest("[data-iforget]")) { try { const r = await api("/api/discover/idea-forget", { slug }); S.disc.data.ideas = r.ideas; renderDiscover(); } catch (err) { toast(err.message, true); } return; }
    if (t.closest("[data-icopy]")) return copy(`~/.config/herdr-deck/ideas/${slug}.md`, "path");
    if (t.closest("[data-ibuild]")) return discStart("build", { slug, title: x?.title ?? slug }, `Start building: ${(x?.title ?? slug).slice(0, 40)}`);
    if (t.closest("[data-iopen]")) {
      S.disc.open = S.disc.open === slug ? null : slug;
      renderDiscover();
      if (S.disc.open && !S.disc.plans.has(slug)) {
        try { S.disc.plans.set(slug, await api("/api/discover/idea-file", { slug })); } catch (err) { toast(err.message, true); S.disc.open = null; }
        renderDiscover();
      }
      $("dbody").querySelector(`[data-islug="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    return;
  }
  const card = t.closest("[data-gfull]");
  if (!card) return;
  const g = gemBy(card.dataset.gfull);
  if (!g) return;
  if (t.closest("[data-gfork]")) return discStart("fork", { repo: g }, `Fork & explore ${g.full}`);
  if (t.closest("[data-gmix]")) return mixOpenWith([{ id: `r:${g.full}`, kind: "repo", name: g.full, desc: g.desc ?? "" }], { add: true, toastText: `Added ${g.full} to the mixer` });
  if (t.closest("[data-gsave]")) { await discRepo(isSaved(g.full) ? "unsave" : "save", g); toast(isSaved(g.full) ? `Saved ${g.full}` : `Removed ${g.full} from Saved`); return renderDiscover(); }
  if (t.closest("[data-gdis]")) {
    card.classList.add("gone");
    await discRepo("dismiss", g);
    for (const k of ["gems", "trending"]) if (S.disc.data?.[k]) S.disc.data[k] = S.disc.data[k].filter((x) => x.full !== g.full);
    setTimeout(renderDiscover, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  }
});
$("dbody").addEventListener("input", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-didea]")) return;
  S.disc.idea = e.target.value;
  clearTimeout(S.disc.saveT);
  S.disc.saveT = setTimeout(() => store("discIdea", S.disc.idea), 300);
});
$("dbody").addEventListener("keydown", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-didea]")) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ideaResearch(e.target.value); }
  else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ideaSearch(e.target.value); }
});
// ── Mixer: pick projects, repos, connections, tools and interests; get ideas only that mix makes possible ──
// Server side: src/mix.ts. The model sees only the names and one-line descriptions you pick, plus your direction.
S.disc.mix = { sel: load("mixSel", []), dir: load("mixDir", ""), engine: load("mixEngine", "claude"), q: "", all: false, ings: null, engines: null, connLoading: false, loading: false, job: null, res: null, open: new Set(), seen: new Set(), more: new Set(), peeked: "" };
const MIX_KINDS = [["project", "Your projects"], ["repo", "Gems & trending"], ["conn", "Connections & services"], ["tool", "Tools & skills"], ["interest", "Interests"]];
const MIX_PREFIX = { p: "project", r: "repo", c: "conn", t: "tool", i: "interest" };
const mixKindOf = (id) => MIX_PREFIX[String(id)[0]] ?? "conn";
const MIX_DIRS = ["make money", "for my HD audience", "weekend hack", "privacy-first", "wow on a phone", "runs itself"];
const MIX_DIFF = { weekend: "Weekend", week: "A week", month: "A month" };
const MIX_TOOL_CATS = new Set(["ai", "mcp", "skills"]);
const ingLite = (x) => ({ id: String(x.id), kind: x.kind, name: String(x.name), desc: String(x.desc ?? "").slice(0, 140) });
const mixIsSel = (id) => S.disc.mix.sel.some((x) => x.id === id);
function mixSetSel(sel) { S.disc.mix.sel = sel.slice(0, 16); store("mixSel", S.disc.mix.sel); }
function mixEngineParts() { const e = S.disc.mix.engine; return e.startsWith("ollama:") ? ["ollama", e.slice(7)] : [e, undefined]; }
function mixEngineLabel(engine, model) { return engine === "ollama" ? `Ollama · ${model ?? "local"}` : engine === "template" ? "templates" : `Claude${model ? ` ${model[0].toUpperCase()}${model.slice(1)}` : ""}`; }
/** The mixer regions update in place, so typing in the direction or search box never loses the keyboard. */
function mixPatch(...ids) {
  if (S.mode !== "discover" || S.disc.tab !== "mix") return;
  const view = $("dbody").querySelector(":scope > .view");
  const f = { mixtray: mixTrayHTML, mixopts: mixOptsHTML, mixres: mixResHTML, mixlist: mixListHTML };
  let n = 0;
  for (const id of ids.length ? ids : Object.keys(f)) {
    const el = view?.querySelector(`#${id}`);
    if (!el) continue;
    n++;
    const prog = id === "mixres" && S.disc.mix.job && el.querySelector(".mixprog");
    if (prog) { const st = prog.querySelector(".mstage"); if (st.textContent !== (S.disc.mix.job.stage ?? "")) st.textContent = S.disc.mix.job.stage ?? ""; setHTML(el.querySelector("#mixgrid"), mixGridHTML(S.disc.mix.job.mixes ?? [])); }
    else setHTML(el, f[id]());
  }
  if (!n) return renderDiscover();
  if (view) view._h = null; // the whole-view cache no longer matches what's on screen
}
async function mixEnter() {
  const m = S.disc.mix;
  if (!m.ings && !m.loading) loadMixIngs();
  mixPeek();
}
async function loadMixIngs(wait) {
  const m = S.disc.mix;
  if (m.loading) return;
  m.loading = true;
  try {
    const r = await api("/api/discover/mix-ingredients", wait ? { wait } : {}, 20_000);
    m.ings = r.ingredients; m.engines = r.engines; m.connLoading = r.connLoading;
    // Fresher descriptions for what's already picked.
    const by = new Map(m.ings.map((x) => [x.id, x]));
    mixSetSel(m.sel.map((x) => (by.has(x.id) ? ingLite(by.get(x.id)) : x)));
    if (m.engine === "claude" && !m.engines.claude) m.engine = m.engines.ollama[0] ? `ollama:${m.engines.ollama[0]}` : "template";
  } catch (e) { toast(e.message, true); }
  m.loading = false;
  mixPatch();
  // The connections scan wasn't done yet: ask once more, waiting longer.
  if (m.connLoading && !wait) setTimeout(() => { if (S.mode === "discover") { m.ings && (m.connLoading = false); loadMixIngs(9000); } }, 800);
}
/** Show the cached result for this exact selection, direction and engine, if there is one. */
async function mixPeek() {
  const m = S.disc.mix;
  if (m.sel.length < 2 || m.job) return;
  const [engine, model] = mixEngineParts();
  const sig = JSON.stringify([m.sel.map((x) => x.id).sort(), m.dir.trim().toLowerCase(), m.engine]);
  if (m.peeked === sig) return;
  m.peeked = sig;
  try { const r = await api("/api/discover/mix", { ingredients: m.sel, direction: m.dir, engine, model, peek: true }, 8000); if (r.cached && !m.job) { m.res = { ...r.result, cached: true }; mixPatch("mixres"); } } catch {}
}
async function mixStart(force = false) {
  const m = S.disc.mix;
  if (m.sel.length < 2) { toast("Pick at least two ingredients", true); return; }
  if (m.job) return;
  const [engine, model] = mixEngineParts();
  m.job = { status: "running", stage: "Starting…", mixes: [], engine, model, t0: Date.now() };
  mixPatch("mixres", "mixtray");
  const res = $("dbody").querySelector("#mixres");
  if (res && res.getBoundingClientRect().top > innerHeight * 0.6) res.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  try {
    const r = await api("/api/discover/mix", { ingredients: m.sel, direction: m.dir, engine, model, force }, 15_000);
    if (r.cached) { m.job = null; m.res = { ...r.result, cached: true }; }
    else { m.job = { ...r.job, t0: m.job.t0 }; m.peeked = ""; mixPoll(); }
  } catch (e) { m.job = null; toast(e.message, true); }
  mixPatch("mixres", "mixtray");
}
async function mixPoll() {
  const m = S.disc.mix;
  clearTimeout(mixPoll.t);
  if (!m.job?.id) return;
  const id = m.job.id;
  try {
    const j = await api("/api/discover/mix-status", { id }, 8000);
    if (m.job?.id !== id) return;
    if (j.status === "running") m.job = { ...j, t0: m.job.t0 };
    else {
      if (j.mixes.length) m.res = { mixes: j.mixes, note: j.status === "cancelled" ? "Stopped: these arrived before you cancelled." : j.note, engine: j.engine, model: j.model, ms: j.elapsed };
      else if (j.status === "cancelled") toast("Mix cancelled");
      m.job = null;
    }
  } catch (e) { if (m.job?.id === id) { toast(e.message, true); m.job = null; } }
  mixPatch("mixres", "mixtray");
  if (m.job) mixPoll.t = setTimeout(mixPoll, 650);
}
async function mixCancel() {
  const m = S.disc.mix;
  const id = m.job?.id;
  if (!id) { m.job = null; return mixPatch("mixres", "mixtray"); }
  try { await api("/api/discover/mix-cancel", { id }, 5000); } catch {}
  mixPoll();
}
function mixSurprise() {
  const m = S.disc.mix;
  if (!m.ings) return;
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  const of = (k, n) => m.ings.filter((x) => x.kind === k && x.ready).slice(0, n);
  const pools = [of("project", 12), of("repo", 16), of("conn", 60), Math.random() < 0.5 ? of("tool", 60) : of("interest", 14)];
  if (Math.random() < 0.4) pools.push(of("interest", 14));
  const out = [];
  for (const p of pools) { const x = p.length && pick(p); if (x && !out.some((y) => y.id === x.id)) out.push(ingLite(x)); }
  mixSetSel(out);
  m.res = null; m.peeked = "";
  mixPatch("mixtray", "mixopts", "mixlist", "mixres");
  mixPeek();
}
/** Put ingredients in the mixer (added to, or instead of, what's there) and open it. */
function mixOpenWith(xs, { add = false, toastText } = {}) {
  const m = S.disc.mix;
  const cur = add ? [...m.sel] : [];
  for (const x of xs) if (!cur.some((y) => y.id === x.id)) cur.push(ingLite(x));
  mixSetSel(cur);
  m.peeked = "";
  if (!add) m.res = null;
  S.disc.tab = "mix"; store("discTab", "mix");
  if (S.mode !== "discover") setMode("discover"); else { renderDiscover(); $("dbody").scrollTop = 0; }
  mixSyncDir();
  mixEnter();
  if (toastText) toast(toastText);
}
const mixFromCard = (x) => x.ids.map((id, i) => { const k = S.disc.mix.ings?.find((y) => y.id === id); return k ? ingLite(k) : { id, kind: mixKindOf(id), name: x.ingredients[i] ?? id, desc: "" }; });
function mixText(x) {
  return [`${x.title}: ${x.pitch}`, "", `Ingredients: ${x.ingredients.join(" + ")}`, ...(x.how ?? []).map((h) => `- ${h.name}: ${h.role}`), x.why_novel ? `Why it’s new: ${x.why_novel}` : "", x.first_steps?.length ? `First steps:\n${x.first_steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "", `Size: ${MIX_DIFF[x.difficulty] ?? x.difficulty} · wow ${x.wow}/5`].filter(Boolean).join("\n");
}
/** "Research & plan it": the same research flow as the Idea lab, with the mix as the idea (the dialog opens prefilled; nothing starts before you confirm). */
function mixResearch(x) {
  const dir = x.direction ?? S.disc.mix.dir;
  const text = `${x.title}: ${x.pitch} Combine ${x.how.map((h) => `${h.name} (${h.role})`).join("; ")}.${x.why_novel ? ` Why it’s new: ${x.why_novel}` : ""}${dir?.trim() ? ` Direction: ${dir.trim()}.` : ""} First steps I have in mind: ${x.first_steps.join("; ")}.`;
  const repos = x.ids.filter((id) => id.startsWith("r:")).map((id) => gemBy(id.slice(2)) ?? { full: id.slice(2), stars: "?" });
  const projects = x.ids.filter((id) => id.startsWith("p:")).map((id) => id.slice(2));
  return discStart("research", { text, slug: x.title, repos, projects }, "Research & plan this mix");
}
const allMixes = () => [...(S.disc.mix.res?.mixes ?? []), ...(S.disc.mix.job?.mixes ?? []), ...(S.disc.data?.mixes?.forYou?.mixes ?? []), ...(S.disc.data?.mixes?.saved ?? [])];
const mixSaved = (id) => (S.disc.data?.mixes?.saved ?? []).some((x) => x.id === id);
async function mixSave(x) {
  const op = mixSaved(x.id) ? "unsave" : "save";
  try {
    const r = await api("/api/discover/mix-save", { op, mix: x, direction: x.direction ?? S.disc.mix.dir });
    if (S.disc.data) S.disc.data.mixes = { ...(S.disc.data.mixes ?? {}), saved: r.mixes };
    toast(op === "save" ? `Saved “${x.title}”` : `Removed “${x.title}” from Saved`);
  } catch (e) { toast(e.message, true); }
}

/** The direction box lives outside the patched regions: set it (and the suggestion chips) directly. */
function mixSyncDir() {
  const m = S.disc.mix;
  const inp = $("dbody").querySelector("[data-mixdir]");
  if (inp && inp.value !== m.dir) inp.value = m.dir;
  for (const b of $("dbody").querySelectorAll("[data-mixdirpick]")) b.setAttribute("aria-pressed", String(b.dataset.mixdirpick === m.dir.trim().toLowerCase()));
  const v = $("dbody").querySelector(":scope > .view"); if (v) v._h = null;
}
function mixCard(x, i, ctx) {
  const m = S.disc.mix;
  const seenKey = `${ctx}:${x.id}`;
  const fresh = !m.seen.has(seenKey);
  m.seen.add(seenKey);
  const saved = mixSaved(x.id);
  const acts = ctx === "fy" ? `<button class="btn primary" data-mplan>Research &amp; plan it</button><button class="btn ghost" data-mopen>Open in mixer</button><button class="btn ghost" data-msave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button>`
    : ctx === "sv" ? `<button class="btn primary" data-mplan>Research &amp; plan it</button><button class="btn ghost" data-mopen>Open in mixer</button><button class="btn ghost" data-mcopy>Copy</button><button class="btn ghost" data-msave aria-pressed="true">Remove</button>`
    : `<button class="btn primary" data-mplan>Research &amp; plan it</button><button class="btn ghost" data-mremix title="Keep these ingredients selected and mix again">Remix</button><button class="btn ghost" data-msave aria-pressed="${saved}">${saved ? "Saved" : "Save"}</button><button class="btn ghost" data-mcopy>Copy</button>`;
  return `<article class="mixcard${fresh ? "" : " still"}" data-mix="${esc(x.id)}" style="--h:${dHue(x.title)};--i:${Math.min(i, 8)}">
    <h4>${esc(x.title)}</h4>
    <div class="mbadges"><span class="mdiff d-${esc(x.difficulty)}">${esc(MIX_DIFF[x.difficulty] ?? x.difficulty)}</span><span class="mwow" role="img" aria-label="Wow ${x.wow} of 5" title="Wow ${x.wow} of 5">${"★".repeat(x.wow)}<i>${"★".repeat(5 - x.wow)}</i></span>${x.source === "template" ? '<span class="msrc" title="From the quick template combiner, not a model">template</span>' : ""}</div>
    ${x.pitch ? `<p class="mpitch">${esc(x.pitch)}</p>` : ""}
    <div class="mings">${x.ids.map((id, j) => `<span class="ming k-${mixKindOf(id)}">${esc(x.ingredients[j] ?? id)}</span>`).join("")}</div>
    <details class="mmore" data-mdet="${esc(seenKey)}"${m.open.has(seenKey) ? " open" : ""}><summary>How, why &amp; first steps</summary>
      <ul class="mhow">${(x.how ?? []).map((h) => `<li><span class="ming k-${mixKindOf(x.ids[x.ingredients.indexOf(h.name)] ?? "")}">${esc(h.name)}</span> ${esc(h.role)}</li>`).join("")}</ul>
      ${x.why_novel ? `<p class="mwhy"><b>Why it’s new</b> ${esc(x.why_novel)}</p>` : ""}
      ${x.first_steps?.length ? `<ol class="msteps">${x.first_steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    </details>
    <div class="gacts">${acts}</div>
  </article>`;
}
function mixesForYou(d) {
  const fy = d.mixes?.forYou;
  if (!fy?.mixes?.length) return "";
  const status = fy.running ? '<span class="spin"></span> mixing today’s set with Claude… these are quick picks meanwhile'
    : fy.generated ? `from your top interests, projects, gems and connections · ${esc(mixEngineLabel(fy.engine, fy.model))}, ${esc(agoText(fy.at))}`
    : "quick picks from your top interests, projects, gems and connections";
  return `<h3 class="dsub">Mixes for you <span class="hint mfyst">${status}</span> <button class="link" data-dtab="mix">Open the mixer</button></h3>
    <div class="dstrip mstrip">${fy.mixes.map((x, i) => mixCard(x, i, "fy")).join("")}</div>`;
}
function mixChip(x) {
  return `<button class="mchip k-${x.kind}${x.ready ? "" : " off"}" data-ing="${esc(x.id)}" aria-pressed="${mixIsSel(x.id)}" title="${esc([x.desc, x.ready ? "" : "not ready on this machine"].filter(Boolean).join(" · "))}">${esc(x.name)}</button>`;
}
function mixTrayHTML() {
  const m = S.disc.mix;
  const n = m.sel.length;
  // Only a chip that was just added animates in; redraws of the tray don't replay the others.
  const fresh = m.justAdded; m.justAdded = null;
  return `<div class="mtray" aria-label="Picked">${n ? m.sel.map((x) => `<span class="mpick k-${esc(x.kind)}${x.id === fresh ? " fresh" : ""}"><span>${esc(x.name)}</span><button data-mixrm="${esc(x.id)}" aria-label="Remove ${esc(x.name)}">${ICON.x}</button></span>`).join("") : '<span class="hint">Nothing picked yet: tap things below, or <button class="link" data-mixsurprise>Surprise me</button></span>'}</div>
    <button class="btn primary mgo" data-mixgo ${n < 2 || m.job ? "disabled" : ""} title="${n < 2 ? "Pick at least two" : "Mix them"}">${m.job ? '<span class="spin"></span>Mixing' : `Mix${n ? ` ${n}` : ""}`}</button>`;
}
const mixGridHTML = (got) => `${got.map((x, i) => mixCard(x, i, "res")).join("")}${Array.from({ length: Math.max(0, 6 - got.length) }, () => '<div class="mixcard skel"></div>').join("")}`;
function mixResHTML() {
  const m = S.disc.mix;
  const j = m.job;
  // While mixing, the progress bar is drawn once and then only its words and clock change (mixPatch), so Cancel is always tappable.
  if (j) return `<div class="mixprog" role="status"><span class="spin"></span><b>Mixing with ${esc(mixEngineLabel(j.engine, j.model))}</b><span class="hint mstage">${esc(j.stage ?? "")}</span><span class="mclock" data-since="${j.t0}">${clock(Date.now() - j.t0)}</span><span class="spacer"></span><button class="btn ghost" data-mixcancel>Cancel</button></div>
      <div class="mgrid" id="mixgrid">${mixGridHTML(j.mixes ?? [])}</div>`;
  const r = m.res;
  if (!r) return `<p class="hint mempty">${m.sel.length < 2 ? "Pick two or more things below, add a direction if you like, then press <b>Mix</b>." : "Ready: press <b>Mix</b>."} Only the names and one-line descriptions of what you pick, and your direction, go to the model.</p>`;
  const secs = r.ms ? `${(r.ms / 1000).toFixed(r.ms < 10_000 ? 1 : 0)}s` : "";
  return `<div class="mixhead"><span><b>${r.mixes.length} mixes</b> · ${esc(mixEngineLabel(r.engine, r.model))}${r.cached ? ` · from cache${r.at ? `, ${esc(agoText(r.at))}` : ""}` : secs ? ` · ${secs}` : ""}</span><span class="spacer"></span><button class="btn ghost" data-mixagain ${m.sel.length < 2 ? "disabled" : ""}>Mix again</button></div>
    ${r.note ? `<p class="mnote">${ICON.warn}${esc(r.note)}</p>` : ""}
    <div class="mgrid">${r.mixes.map((x, i) => mixCard(x, i, "res")).join("")}</div>`;
}
function mixListHTML() {
  const m = S.disc.mix;
  if (!m.ings) return `<div class="mchips">${Array.from({ length: 14 }, (_, i) => `<span class="mchip skel" style="width:${60 + ((i * 37) % 70)}px"></span>`).join("")}</div>`;
  const q = m.q.trim().toLowerCase();
  const match = (x) => !q || `${x.name} ${x.desc} ${x.group ?? ""}`.toLowerCase().includes(q);
  const limit = (key, xs, n) => (q || m.more.has(key) || xs.length <= n + 2 ? xs : xs.slice(0, n));
  const more = (key, xs, shown) => (xs.length > shown.length ? `<button class="mchip moremix" data-mixmore="${esc(key)}">+${xs.length - shown.length} more</button>` : "");
  const out = [];
  for (const [k, label] of MIX_KINDS) {
    const all = m.ings.filter((x) => x.kind === k);
    const xs = all.filter((x) => (m.all || x.ready || !["conn", "tool"].includes(k)) && match(x));
    if (!xs.length && q) continue;
    let body;
    if (k === "conn" || k === "tool") {
      const groups = new Map();
      for (const x of xs) groups.set(x.group ?? "Other", [...(groups.get(x.group ?? "Other") ?? []), x]);
      body = [...groups].map(([g, ys]) => { const shown = limit(`${k}:${g}`, ys, 10); return `<div class="mgrp"><span class="mgl">${esc(g)} <span class="n">${ys.length}</span></span><div class="mchips">${shown.map(mixChip).join("")}${more(`${k}:${g}`, ys, shown)}</div></div>`; }).join("");
    } else { const shown = limit(k, xs, 18); body = `<div class="mchips">${shown.map(mixChip).join("")}${more(k, xs, shown)}</div>`; }
    const nsel = m.sel.filter((x) => x.kind === k).length;
    out.push(`<section class="mkind k-${k}"><h4><span class="kdot"></span>${esc(label)} <span class="n">${xs.length}${xs.length !== all.length && !q ? ` of ${all.length}` : ""}</span>${nsel ? `<span class="msel">${nsel} picked</span>` : ""}</h4>${xs.length ? body : `<p class="hint">${k === "repo" ? "No gems found yet: open For you and let it search GitHub." : (k === "conn" || k === "tool") && (m.connLoading || m.loading) ? '<span class="spin"></span> Scanning your connections…' : "Nothing here yet."}</p>`}</section>`);
  }
  return out.join("") || `<p class="hint">Nothing matches “${esc(m.q)}”.</p>`;
}
function mixOptsHTML() {
  const m = S.disc.mix;
  const e = m.engines;
  const opts = [["claude", "Claude (fast, default)", e && !e.claude], ...(e?.ollama ?? []).map((x) => [`ollama:${x}`, `Ollama · ${x} (private, local)`]), ["template", "Templates (instant, offline)"]];
  if (!opts.some(([v]) => v === m.engine)) opts.push([m.engine, m.engine]);
  return `<label class="mixeng"><span class="hint">Engine</span><select class="inp" data-mixeng aria-label="Engine">${opts.map(([v, l, dis]) => `<option value="${esc(v)}"${v === m.engine ? " selected" : ""}${dis ? " disabled" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <span class="spacer"></span><button class="btn ghost" data-mixsurprise>Surprise me</button><button class="btn ghost" data-mixclear ${m.sel.length ? "" : "disabled"}>Clear</button>`;
}
function discMix() {
  const m = S.disc.mix;
  // The picked tray is a direct child of the view, so it stays stuck to the top the whole way down.
  return `<p class="hint dlead mixlead">Pick things you have or found: projects, repos, connections, tools, interests. Get ideas only that combination makes possible.</p>
      <div class="mixbar" id="mixtray">${mixTrayHTML()}</div>
      <div class="mixctl">
        <input class="inp mixdir" data-mixdir type="text" enterkeyhint="go" maxlength="200" placeholder="Optional direction, e.g. “make money” or “for my HD audience”" value="${esc(m.dir)}" aria-label="Direction (optional)">
        <div class="mixsugg">${MIX_DIRS.map((x) => `<button class="dtag" data-mixdirpick="${esc(x)}" aria-pressed="${m.dir.trim().toLowerCase() === x}">${esc(x)}</button>`).join("")}</div>
        <div class="mixrow" id="mixopts">${mixOptsHTML()}</div>
      </div>
    <div id="mixres" class="mixres">${mixResHTML()}</div>
    <section class="mixpick"><div class="mixsearch"><input class="inp" data-mixq type="search" placeholder="Search ingredients" value="${esc(m.q)}" autocomplete="off" aria-label="Search ingredients">
      <label class="mixall"><input type="checkbox" data-mixall ${m.all ? "checked" : ""}> Show all connections, not only ready ones</label></div>
      <div id="mixlist">${mixListHTML()}</div></section>`;
}
function discSaved(d, n) {
  if (!n) return `<div class="empty-state">Nothing saved yet. <b>Save</b> a gem or a mix to keep it here.</div>`;
  const mixes = d.mixes?.saved ?? [];
  return `${mixes.length ? `<h3 class="dsub">Mixes <span class="hint">ideas you kept from the mixer</span></h3><div class="mgrid">${mixes.map((x, i) => mixCard(x, i, "sv")).join("")}</div>` : ""}
    ${d.saved.length ? `<h3 class="dsub">Repos <span class="hint">they stay here until you remove them</span></h3><div class="dgrid">${d.saved.map((g, i) => gemCard(g, i, { saved: true })).join("")}</div>` : ""}`;
}
/** Clicks inside the mixer and on mix cards. Returns true when it handled the click. */
function mixClick(t) {
  const m = S.disc.mix;
  const ing = t.closest("[data-ing]")?.dataset.ing;
  if (ing) {
    const x = m.ings?.find((y) => y.id === ing);
    if (!x) return true;
    if (mixIsSel(ing)) mixSetSel(m.sel.filter((y) => y.id !== ing));
    else if (m.sel.length >= 16) { toast("That’s plenty: 16 at most", true); return true; }
    else { mixSetSel([...m.sel, ingLite(x)]); m.justAdded = x.id; }
    mixPatch("mixtray", "mixopts", "mixlist");
    $("dbody").querySelector(`[data-ing="${CSS.escape(ing)}"]`)?.focus({ preventScroll: true });
    mixPeek();
    return true;
  }
  const rm = t.closest("[data-mixrm]")?.dataset.mixrm;
  if (rm) { mixSetSel(m.sel.filter((y) => y.id !== rm)); mixPatch("mixtray", "mixopts", "mixlist"); return true; }
  if (t.closest("[data-mixgo]")) { mixStart(false); return true; }
  if (t.closest("[data-mixagain]")) { mixStart(true); return true; }
  if (t.closest("[data-mixcancel]")) { mixCancel(); return true; }
  if (t.closest("[data-mixsurprise]")) { mixSurprise(); return true; }
  if (t.closest("[data-mixclear]")) { mixSetSel([]); m.res = null; mixPatch(); return true; }
  const more = t.closest("[data-mixmore]")?.dataset.mixmore;
  if (more) { m.more.add(more); mixPatch("mixlist"); return true; }
  const dp = t.closest("[data-mixdirpick]")?.dataset.mixdirpick;
  if (dp != null) {
    m.dir = m.dir.trim().toLowerCase() === dp ? "" : dp; store("mixDir", m.dir);
    mixSyncDir();
    mixPeek();
    return true;
  }
  const card = t.closest("[data-mix]");
  if (!card || t.closest("summary")) return false;
  const x = allMixes().find((y) => y.id === card.dataset.mix);
  if (!x) return false;
  if (t.closest("[data-mplan]")) { mixResearch(x); return true; }
  if (t.closest("[data-mcopy]")) { copy(mixText(x), "the mix"); return true; }
  if (t.closest("[data-mopen]")) { if (x.direction != null) { m.dir = x.direction; store("mixDir", m.dir); } mixOpenWith(mixFromCard(x), { toastText: "Opened in the mixer" }); return true; }
  if (t.closest("[data-mremix]")) { mixSetSel(mixFromCard(x)); m.peeked = ""; mixPatch("mixtray", "mixopts", "mixlist"); mixStart(true); return true; }
  if (t.closest("[data-msave]")) { mixSave(x).then(() => { if (S.disc.tab === "mix") mixPatch("mixres"); else renderDiscover(); }); return true; }
  return false;
}
$("dbody").addEventListener("toggle", (e) => {
  const k = e.target.dataset?.mdet;
  if (!k) return;
  if (e.target.open) S.disc.mix.open.add(k); else S.disc.mix.open.delete(k);
  const v = $("dbody").querySelector(":scope > .view"); if (v) v._h = null;
}, true);
$("dbody").addEventListener("input", (e) => {
  if (S.mode !== "discover") return;
  const m = S.disc.mix;
  if (e.target.matches("[data-mixq]")) { m.q = e.target.value; mixPatch("mixlist"); }
  else if (e.target.matches("[data-mixdir]")) {
    m.dir = e.target.value;
    for (const b of $("dbody").querySelectorAll("[data-mixdirpick]")) b.setAttribute("aria-pressed", String(b.dataset.mixdirpick === m.dir.trim().toLowerCase()));
    clearTimeout(m.saveT); m.saveT = setTimeout(() => { store("mixDir", m.dir); mixPeek(); }, 400);
    const v = $("dbody").querySelector(":scope > .view"); if (v) v._h = null;
  }
});
$("dbody").addEventListener("change", (e) => {
  if (S.mode !== "discover") return;
  const m = S.disc.mix;
  if (e.target.matches("[data-mixeng]")) { m.engine = e.target.value; store("mixEngine", m.engine); m.res = null; mixPatch("mixres"); mixPeek(); }
  else if (e.target.matches("[data-mixall]")) { m.all = e.target.checked; mixPatch("mixlist"); }
});
$("dbody").addEventListener("keydown", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-mixdir]") || e.key !== "Enter" || e.isComposing) return;
  e.preventDefault(); store("mixDir", S.disc.mix.dir); mixStart(false);
});
// Connections → "Mix these": the picked store cards go to the mixer (key names stay out).
$("dbody").addEventListener("click", (e) => {
  if (S.mode !== "connections" || !e.target.closest("[data-cmix]")) return;
  const byId = new Map(connItems(S.conn.data.get(S.conn.machine ?? S.self)).map((i) => [i.id, i]));
  const xs = [...S.conn.pick].map((id) => byId.get(id)).filter((i) => i && i.cat !== "keys")
    .map((i) => { const tool = MIX_TOOL_CATS.has(i.cat) || ["agent", "sub", "skill", "mcp"].includes(i.kind); return { id: `${tool ? "t" : "c"}:${i.id}`, kind: tool ? "tool" : "conn", name: i.name, desc: i.detail ?? "" }; });
  if (!xs.length) return toast("Pick some connections first (API key names can’t be mixed)", true);
  S.conn.pick.clear();
  mixOpenWith(xs, { add: true, toastText: `Added ${xs.length} to the mixer` });
});
// ══ end Discover ═════════════════════════════════════════════════════════════

// ── status line: project, context, plan limits ──────────────────────────────
function meter(pct, label, title, resets, extra) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const cls = p >= 85 ? "hot" : p >= 60 ? "warm" : "";
  return `<span class="meter ${cls}" title="${esc(title)}${resets ? ` · resets ${esc(inText(resets))}` : ""}"><span class="ml">${esc(label)}</span><span class="mb"><i style="width:${p}%"></i></span><b>${p}%</b>${extra ? `<span class="mx">${esc(extra)}</span>` : ""}</span>`;
}
function inText(t) { const ms = t - Date.now(); if (ms <= 0) return "now"; const h = Math.floor(ms / 3600_000), m = Math.round((ms % 3600_000) / 60_000); return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `in ${h}h ${m}m` : `in ${m}m`; }
function renderStatusLine(r) {
  const el = $("statusline");
  if (!el) return;
  if (!r || r.hist || S.sub || S.mode || S.board) { el.hidden = true; return; }
  el.hidden = false;
  const parts = [`<span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>`];
  const cx = isAgent(r) ? ctxInfo(r) : null;
  if (cx?.pct != null) parts.push(meter(cx.pct, "context", `${tok(cx.tokens)} of ${tok(cx.window)} tokens in context${cx.guessed ? " (window size guessed from the model)" : ""}`, null, tok(cx.tokens)));
  else if (cx) parts.push(`<span class="meter" title="${esc(`${cx.tokens.toLocaleString()} tokens in context; this model’s window size isn’t known`)}"><span class="ml">context</span><b>${tok(cx.tokens)}</b><span class="mx">tokens</span></span>`);
  const u = S.usage ?? {};
  if (r.agent === "claude" && u.claude) {
    const stale = u.claude.at && Date.now() - u.claude.at > 6 * 3600_000;
    if (u.claude.fiveHour != null) parts.push(meter(u.claude.fiveHour, "5h", `Claude 5-hour limit${stale ? " (last seen " + agoText(u.claude.at) + ")" : ""}`, u.claude.fiveHourResets));
    if (u.claude.weekly != null) parts.push(meter(u.claude.weekly, "week", "Claude weekly limit", u.claude.weeklyResets));
  } else if (r.agent === "codex" && u.codex?.windows?.length) {
    const stale = u.codex.at && Date.now() - u.codex.at > 6 * 3600_000;
    for (const w of u.codex.windows) parts.push(meter(w.pct, w.label === "Weekly" ? "week" : w.label, `Codex ${w.label.toLowerCase()} limit${u.codex.plan ? ` (${u.codex.plan} plan)` : ""}${stale ? " (last seen " + agoText(u.codex.at) + ")" : ""}`, w.resets));
  } else if (r.agent === "opencode" && r.cost) parts.push(`<span class="meter" title="What this OpenCode session has cost so far (OpenCode has no plan limits to show)"><span class="ml">spent</span><b>$${r.cost.toFixed(2)}</b></span>`);
  if (r.model) parts.push(`<span class="sl-m">${esc(r.model.replace(/^claude-/, ""))}</span>`);
  if (r.branch) parts.push(`<span class="sl-m">${esc(r.branch)}${r.dirty ? ` · ${r.dirty}±` : ""}</span>`);
  setHTML(el, parts.join(""));
}

// ── uploads: attach button, drag and drop, paste ─────────────────────────────
function pickFiles() {
  const r = rowOf(S.sel);
  if (!r || r.hist || r.app) return toast("Open a live session to attach files", true);
  $("fileIn").value = "";
  $("fileIn").click();
}
async function uploadFiles(files) {
  const r = rowOf(S.sel);
  if (!r || r.hist || r.app) return toast("Open a live session to attach files", true);
  const list = [...files].slice(0, 20);
  if (!list.length) return;
  const ta = $("cText");
  toast(`Uploading ${list.length} file${list.length > 1 ? "s" : ""}…`);
  const paths = [];
  for (const f of list) {
    try {
      const res = await fetch(`/api/upload?key=${encodeURIComponent(r.key)}&name=${encodeURIComponent(f.name || "pasted.png")}`, { method: "POST", headers: { "x-deck-token": S.token, "content-type": "application/octet-stream" }, body: f });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error ?? res.statusText);
      paths.push(j.path);
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  if (!paths.length) return;
  const block = paths.map((p) => `[Attached: ${p}]`).join("\n");
  ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${block}\n` : `${block}\n`;
  autosize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  toast(`Attached ${paths.length}. Add a note and send.`);
}
$("fileIn").addEventListener("change", (e) => uploadFiles(e.target.files));
// The paperclip is a <label for="fileIn">: the browser opens the picker itself, which works everywhere
// (a script-triggered click on a hidden input is ignored by some phones and installed apps).
$("cAttach").addEventListener("click", (e) => {
  const r = rowOf(S.sel);
  if (!r || r.hist || r.app) { e.preventDefault(); return toast("Open a live session to attach files", true); }
  $("fileIn").value = "";
});
$("cAttach").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("cAttach").click(); } });
{
  let depth = 0;
  const det = $("detail");
  const canDrop = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files") && !S.mode && rowOf(S.sel) && !rowOf(S.sel).hist && !rowOf(S.sel).app;
  det.addEventListener("dragenter", (e) => { if (!canDrop(e)) return; e.preventDefault(); depth++; det.classList.add("dropping"); });
  det.addEventListener("dragover", (e) => { if (canDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  det.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) det.classList.remove("dropping"); });
  det.addEventListener("drop", (e) => { if (!canDrop(e)) return; e.preventDefault(); depth = 0; det.classList.remove("dropping"); uploadFiles(e.dataTransfer.files); });
  $("cText").addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files ?? [])];
    if (fs.length) { e.preventDefault(); return uploadFiles(fs); }
    const t = e.clipboardData?.getData("text/plain") ?? "";
    if (t.length > LONG_PASTE_CHARS || t.split("\n").length > LONG_PASTE_LINES) { e.preventDefault(); addPaste(t); }
  });
}

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
function closeMenu() { menuEl?.remove(); menuEl = null; }
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
    { html: "Connections<small>Everything this setup can reach</small>", run: () => openConnections() },
    !isPhone() && { html: "Keyboard shortcuts", run: () => $("help").showModal() },
  ].filter(Boolean));
}
function setTheme(name) { applyTheme(name); store("theme", name); }
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

// ── push notifications (Web Push through the service worker) ───────────
// The hub sends them (Settings → Automations decides what), so they arrive with the app closed.
// The old page-only alerts (toggleAlerts) stay as the fallback where push isn't available.
const PUSH = {
  supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && isSecureContext,
  ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
  standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
  on: false, me: null, devices: [],
  id: load("pushDevice", "") || (() => { const id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, ""); store("pushDevice", id); return id; })(),
};
const b64uBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const bytesB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? "iPhone" : PUSH.ios ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Browser";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return PUSH.ios || /Android/.test(ua) ? kind : `${kind}${br ? " · " + br : ""}`;
}
/** Why this device can't get push, in words; null when it can. */
function pushBlocker() {
  if (S.push?.node) return "This machine is a node: its sessions reach you through the hub. Turn notifications on in the hub’s deck.";
  if (PUSH.ios && !PUSH.standalone) return "On iPhone and iPad, notifications only work in the installed app. In Safari tap Share → Add to Home Screen, open herdr deck from your Home Screen, then turn them on there.";
  if (!isSecureContext) return "Notifications need a secure address: open the deck over https (your tailnet link) or on localhost.";
  if (!PUSH.supported) return "This browser can’t receive push notifications.";
  if (Notification.permission === "denied") return PUSH.ios ? "Notifications are turned off for herdr deck. Turn them on in iOS Settings → Notifications → herdr deck." : /Android/i.test(navigator.userAgent) ? "Notifications are blocked for herdr deck. Long-press the herdr deck icon → App info → Notifications → Allow (or in Chrome: ⋮ → Settings → Site settings → Notifications), then reopen the deck." : "Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.";
  return null;
}
/** Keep the hub's copy of this device's subscription current (it can change under us). */
async function pushSync() {
  if (!PUSH.supported || !load("pushOn", false) || Notification.permission !== "granted" || !S.token) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && S.push?.key && bytesB64u(sub.options.applicationServerKey) !== S.push.key) { await sub.unsubscribe(); sub = null; }
    if (!sub && S.push?.key) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(S.push.key) });
    if (!sub) return;
    const r = await api("/api/push/subscribe", { id: PUSH.id, subscription: sub.toJSON() });
    PUSH.on = true; PUSH.me = r.device; PUSH.devices = r.devices;
  } catch (e) { console.warn("push sync:", e); }
}
async function enablePush(prefs, label) {
  const why = pushBlocker();
  if (why) throw new Error(why);
  // First thing in the tap: iOS only asks for permission from a user gesture.
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? pushBlocker() ?? "Notifications are blocked" : "Permission wasn’t granted");
  const reg = await navigator.serviceWorker.ready;
  const key = S.push?.key || (await api("/api/push/key", {})).key;
  let sub = await reg.pushManager.getSubscription();
  if (sub && bytesB64u(sub.options.applicationServerKey) !== key) { await sub.unsubscribe(); sub = null; }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
  const r = await api("/api/push/subscribe", { id: PUSH.id, subscription: sub.toJSON(), label, prefs });
  PUSH.on = true; PUSH.me = r.device; PUSH.devices = r.devices;
  store("pushOn", true);
  S.notify = false; store("notify", false); // push replaces the page-only alerts
}
async function disablePush() {
  try { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); await sub?.unsubscribe(); } catch {}
  const r = await api("/api/push/unsubscribe", { id: PUSH.id });
  PUSH.on = false; PUSH.me = null; PUSH.devices = r.devices; store("pushOn", false);
}
const PREFS0 = { needs: true, done: true, digest: true, quiet: { on: false, from: "22:00", to: "07:30" } };
async function openNotifications() {
  let info = { devices: [] };
  try { info = await api("/api/push/key", {}); S.push = { ...S.push, key: info.key, node: info.node }; } catch (e) { toast(e.message, true); }
  PUSH.devices = info.devices ?? [];
  PUSH.me = PUSH.devices.find((d) => d.id === PUSH.id) ?? null;
  if (PUSH.supported && Notification.permission === "granted" && load("pushOn", false) && !PUSH.me) await pushSync();
  PUSH.on = !!PUSH.me && load("pushOn", false);
  const d = document.createElement("dialog");
  d.className = "ask wide notif";
  let busy = false;
  const draw = () => {
    const why = pushBlocker();
    const me = PUSH.me;
    const p = me?.prefs ?? load("pushPrefs", PREFS0);
    const others = PUSH.devices.filter((x) => x.id !== PUSH.id);
    const chk = (k, label, hint) => `<label class="nchk"><input type="checkbox" data-pref="${k}" ${p[k] ? "checked" : ""}><span><b>${label}</b><small>${hint}</small></span></label>`;
    const state = PUSH.on && me
      ? `<div class="nstate on"><span class="dot" style="--c:var(--idle)"></span><span><b>On for this device</b><small>Through ${esc(me.service)}${me.lastOkAt ? ` · last delivered ${esc(agoText(me.lastOkAt))}` : ""}${me.lastError ? ` · <span class="warn">last try failed: ${esc(me.lastError.slice(0, 120))}</span>` : ""}</small></span></div>`
      : `<div class="nstate"><span class="dot" style="--c:var(--empty)"></span><span><b>Off for this device</b><small>${why ? "" : "Turn on to get alerts even when the deck is closed."}</small></span></div>`;
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Notifications on this device</h3>
      ${state}
      ${why ? `<p class="nwarn">${esc(why)}</p>` : ""}
      ${why && !PUSH.supported && "Notification" in window ? `<p class="hint">While the deck is open in this browser it can still alert you: <button type="button" class="btn sm" data-n="page">${S.notify ? "Turn page alerts off" : "Turn page alerts on"}</button></p>` : ""}
      <div class="nprefs"${why && !PUSH.on ? " hidden" : ""}>
      <label class="nname"><span>Name</span><input class="inp" data-n="label" value="${esc(me?.label ?? load("pushLabel", deviceLabel()))}" maxlength="40"></label>
      <h4>Send me</h4>
      ${chk("needs", "When a session needs me", "It’s waiting for an answer or a permission, on any machine")}
      ${chk("done", "When a session finishes", "It finished a turn you haven’t looked at")}
      ${chk("digest", "The morning digest", `At ${esc(S.auto?.rules?.digest?.time ?? "08:30")}: what finished overnight, what’s waiting, what’s idle (Automations sets the time)`)}
      <label class="nchk"><input type="checkbox" data-pref="quiet" ${p.quiet?.on ? "checked" : ""}><span><b>Quiet hours</b><small>No needs-you or finished alerts from <input type="time" class="inp tm" data-n="from" value="${esc(p.quiet?.from ?? "22:00")}"> to <input type="time" class="inp tm" data-n="to" value="${esc(p.quiet?.to ?? "07:30")}"></small></span></label>
      </div>
      ${others.length ? `<h4>Other devices</h4>${others.map((x) => `<div class="mrow"><span class="dot" style="--c:var(--${x.lastError ? "blocked" : "idle"})"></span><b>${esc(x.label)}</b><span class="hint">${esc(x.service)}${x.lastOkAt ? ` · last delivered ${esc(agoText(x.lastOkAt))}` : ""}</span><span class="spacer"></span><button type="button" class="btn ghost danger" data-ndel="${esc(x.id)}">Remove</button></div>`).join("")}` : ""}
      <p class="nlog hint" aria-live="polite"></p></div>
      <div class="dlg-f">${PUSH.on && me ? `<button type="button" class="btn ghost" data-n="off">Turn off</button><span class="spacer"></span><button type="button" class="btn" data-n="test">Send a test</button>` : `<span class="spacer"></span><button type="button" class="btn primary" data-n="on" ${why ? "disabled" : ""}>Turn on</button>`}<button class="btn" value="ok" autofocus>Done</button></div></form>`;
  };
  const prefsNow = () => {
    const get = (k) => d.querySelector(`[data-pref="${k}"]`)?.checked;
    return { needs: get("needs"), done: get("done"), digest: get("digest"), quiet: { on: get("quiet"), from: d.querySelector('[data-n="from"]').value || "22:00", to: d.querySelector('[data-n="to"]').value || "07:30" } };
  };
  const labelNow = () => d.querySelector('[data-n="label"]').value.trim() || deviceLabel();
  let saveT;
  const saveSoon = () => {
    store("pushPrefs", prefsNow()); store("pushLabel", labelNow());
    if (!PUSH.on) return;
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try {
        const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (!sub) return;
        const r = await api("/api/push/subscribe", { id: PUSH.id, subscription: sub.toJSON(), label: labelNow(), prefs: prefsNow() });
        PUSH.me = r.device; PUSH.devices = r.devices;
        d.querySelector(".nlog").textContent = "Saved";
      } catch (e) { d.querySelector(".nlog").textContent = e.message; }
    }, 350);
  };
  d.addEventListener("change", (e) => { if (e.target.closest("[data-pref], [data-n]")) saveSoon(); });
  d.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-n], [data-ndel]");
    if (!b || b.tagName === "INPUT" || busy) return;
    const log = d.querySelector(".nlog");
    const act = b.dataset.n;
    try {
      busy = true;
      if (act === "on") {
        b.disabled = true; b.innerHTML = '<span class="spin"></span> Turning on…';
        await enablePush(prefsNow(), labelNow());
        toast("Notifications on for this device");
        draw();
        d.querySelector(".nlog").textContent = "On. Send a test to check it arrives.";
      } else if (act === "off") {
        await disablePush();
        toast("Notifications off for this device");
        draw();
      } else if (act === "test") {
        b.disabled = true; b.textContent = "Sending…";
        const r = await api("/api/push/test", { id: PUSH.id });
        PUSH.devices = r.devices; PUSH.me = r.devices.find((x) => x.id === PUSH.id) ?? PUSH.me;
        draw();
        d.querySelector(".nlog").textContent = "Sent. It should show up in a few seconds" + (document.hidden ? "." : " (on a Mac it may land in Notification Centre while the deck is in front).");
      } else if (act === "page") {
        await toggleAlerts();
        draw();
      } else if (b.dataset.ndel) {
        const x = PUSH.devices.find((v) => v.id === b.dataset.ndel);
        if (!(await askDialog({ title: `Stop notifications on ${x?.label ?? "that device"}?`, text: "It stops getting pushes. If that device still has notifications turned on, it signs up again the next time it opens the deck.", ok: "Remove", danger: true }))) return;
        const r = await api("/api/push/unsubscribe", { id: b.dataset.ndel });
        PUSH.devices = r.devices;
        draw();
      }
    } catch (x) {
      draw();
      d.querySelector(".nlog").textContent = x.message;
      toast(x.message, true);
    } finally { busy = false; }
  });
  draw();
  document.body.append(d);
  d.addEventListener("close", () => { clearTimeout(saveT); d.remove(); });
  d.showModal();
  d.scrollTop = 0; // focus sits on Done (no keyboard popping up on a phone); keep the top in view
}
// What this page is showing, so the hub doesn't push about a session you're looking at.
const PAGE_ID = Math.random().toString(36).slice(2, 12);
let presSig = "", presAt = 0;
function reportPresence() {
  if (!S.token) return;
  const shown = !document.hidden && S.sel && !S.board && !S.mode && (!isPhone() || app.dataset.mview === "detail") ? S.sel : null;
  const sig = `${shown}|${document.hidden}`;
  if (sig === presSig && Date.now() - presAt < 30_000) return;
  if (document.hidden && presSig.endsWith("|true")) return;
  presSig = sig; presAt = Date.now();
  api("/api/push/presence", { page: PAGE_ID, key: shown, visible: !document.hidden }).catch(() => {});
}
setInterval(reportPresence, 20_000);
document.addEventListener("visibilitychange", reportPresence);
/** A notification was tapped while the deck was open: go to its session (or home for the digest). */
function openFromPush(url) {
  let u;
  try { u = new URL(url, location.origin); } catch { return goHome(); }
  if (u.pathname.startsWith("/s/")) {
    const hit = resolveLink(u.pathname);
    if (hit?.key) { S.machine = "all"; lastOrder = ""; return select(hit.key, { scroll: true, open: true }); }
    return toast(hit?.grave ? `“${hit.grave.title}” was closed. Reopen it from Closed.` : "That session isn’t open anymore.", true);
  }
  goHome();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => {
  const m = e.data ?? {};
  if (m.type === "open") openFromPush(m.url);
  if (m.type === "push") {
    (window.__pushes ??= []).push(m.data);
    if (m.data?.kind === "test") toast("Test notification arrived ✓");
  }
});

// ── automations (hub rules) and their cards on the live board ────────────
const hm = (mins) => (mins % 60 ? `${mins} minutes` : mins === 60 ? "an hour" : `${mins / 60} hours`);
function autoCards() {
  const A = S.auto;
  if (!A) return "";
  let out = "";
  const dg = A.digest;
  if (dg) {
    const it = (x, cls = "") => { const r = rowOf(x.key); return `<button class="dgi ${cls}" data-open="${esc(x.key)}" ${r ? "" : "disabled"} title="${esc(x.title)}"><span class="dot" style="--c:${statusVar(r?.status ?? x.status)}"></span><span class="t">${esc(shortTitle(x.title))}</span><span class="p">${esc(x.project)}${multiMachine() && x.machine ? " · " + esc(machineLabel(x.machine)) : ""}</span></button>`; };
    const cap = isPhone() ? 4 : 8;
    const sec = (label, all, n, extra = "", max = cap) => { const list = all.slice(0, max); return n ? `<div class="dgs"><h5>${label} <span class="n">${n}</span>${extra}</h5>${list.length ? `<div class="dgl">${list.map((x) => it(x)).join("")}${n > list.length ? `<span class="hint">+${n - list.length} more</span>` : ""}</div>` : ""}</div>` : ""; };
    const idleLive = (dg.idle ?? []).filter((x) => rowOf(x.key));
    out += `<div class="acard digest" data-acard="digest"><div class="ah"><span class="ai">${ICON.sun}</span><b>Morning digest</b><span class="hint">${esc(new Date(dg.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}<span class="desk"> · since yesterday 18:00</span></span><span class="spacer"></span><button class="ib" data-auto="dismissDigest" aria-label="Dismiss the digest" title="Dismiss">${ICON.x}</button></div>
      ${dg.counts.waiting + dg.counts.finished + dg.counts.running + dg.counts.idle === 0 ? `<p class="hint">Quiet night: nothing finished, nothing waiting.</p>` : ""}
      ${sec("Waiting on you", dg.waiting, dg.counts.waiting)}${sec("Finished since last evening", dg.finished, dg.counts.finished)}${sec("Still running", dg.running, dg.counts.running)}
      ${sec("Idle for 3+ days", dg.idle, dg.counts.idle, idleLive.length ? `<button class="btn sm" data-auto="closeIdle">Close these…</button>` : "", isPhone() ? 0 : 6)}</div>`;
  }
  const snoozed = new Set(load("emptySnooze", []));
  const keys = (A.empty?.keys ?? []).filter((k) => { const r = rowOf(k); return r && inScope(r) && r.empty; });
  if (keys.length && keys.some((k) => !snoozed.has(k))) {
    out += `<div class="acard emptyc" data-acard="empty"><span class="dot" style="--c:var(--empty)"></span><span class="et"><b>${keys.length} empty session${keys.length === 1 ? "" : "s"} for over ${hm(A.empty.minutes)}</b><small>${esc(keys.slice(0, 4).map((k) => shortTitle(rowOf(k).title || rowOf(k).agent)).join(", "))}${keys.length > 4 ? ` +${keys.length - 4}` : ""}</small></span><span class="spacer"></span><button class="btn ghost" data-auto="snoozeEmpty">Not now</button><button class="btn" data-auto="closeEmpty">Close all…</button></div>`;
  }
  return out;
}
$("dbody").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-auto], [data-open]");
  if (!a || !a.closest(".acard")) return;
  e.stopPropagation();
  if (a.dataset.open) return select(a.dataset.open, { scroll: true, open: true });
  const act = a.dataset.auto;
  const emptyKeys = () => (S.auto?.empty?.keys ?? []).filter((k) => { const r = rowOf(k); return r && inScope(r) && r.empty; });
  try {
    if (act === "dismissDigest") { S.auto = await api("/api/automations", { op: "dismiss-digest" }); render(); }
    else if (act === "closeEmpty") askClose(emptyKeys());
    else if (act === "snoozeEmpty") { store("emptySnooze", emptyKeys()); bodySig = ""; render(); }
    else if (act === "closeIdle") askClose((S.auto?.digest?.idle ?? []).map((x) => x.key).filter((k) => rowOf(k)));
  } catch (x) { toast(x.message, true); }
}, true);
const RULES = [
  { id: "alerts", title: "Needs you and finished alerts", text: "Push to your devices when a session starts waiting for an answer or finishes a turn you haven’t seen, on any machine. One push per session per change; three or more at once become one; nothing for a session that’s open on a screen." },
  { id: "digest", title: "Morning digest", text: "Once a day: what finished since yesterday evening, what’s waiting on you, what’s still running, and sessions idle for more than three days. Pushed to devices that want it, and shown at the top of the Live board until you dismiss it." },
  { id: "empty", title: "Empty sessions", text: "A card on the Live board when shells or agents have had no conversation for a while, with one Close all… (you confirm). Nothing is ever closed automatically." },
  { id: "proof", title: "Proof of done", text: "When an agent says it’s done, re-run the project’s own check (the command you approved once per project) and show pass or fail on the session." },
];
async function openAutomations() {
  let A;
  try { A = await api("/api/automations", { op: "get" }); } catch (e) { return toast(e.message, true); }
  const d = document.createElement("dialog");
  d.className = "ask wide autodlg";
  const draw = () => {
    const R = A.rules, st = A.status ?? {};
    const devs = A.devices ?? [];
    const cfg = {
      alerts: `<label class="nchk in"><input type="checkbox" data-r="alerts.needs" ${R.alerts.needs ? "checked" : ""}> needs you</label><label class="nchk in"><input type="checkbox" data-r="alerts.done" ${R.alerts.done ? "checked" : ""}> finished</label><span class="hint">· ${devs.length ? `${devs.length} device${devs.length === 1 ? "" : "s"}: ${esc(devs.map((x) => x.label).join(", "))}` : "no devices yet"} · <button type="button" class="link" data-a="notif">Notifications on this device…</button></span>`,
      digest: `<label class="nchk in">at <input type="time" class="inp tm" data-r="digest.time" value="${esc(R.digest.time)}"></label><button type="button" class="btn sm" data-a="digestShow">Show digest now</button><button type="button" class="btn sm" data-a="digestPush" ${devs.length ? "" : "disabled"}>Push it now</button>`,
      empty: `<label class="nchk in">after <input type="number" min="5" step="5" class="inp num" data-r="empty.minutes" value="${R.empty.minutes}"> minutes</label>${A.empty?.keys?.length ? `<span class="hint">· ${A.empty.keys.length} right now</span>` : ""}`,
      proof: "",
    };
    const last = (s) => (s?.lastRunAt ? `<span class="${s.ok === false ? "warn" : ""}">${esc(agoText(s.lastRunAt))}: ${esc(s.lastResult ?? "")}</span>` : "Hasn’t run yet");
    d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>Automations</h3><p class="hint">Rules the hub runs for every machine it watches${A.node ? ". <b>This machine is a node</b>, so it doesn’t send pushes; the hub does" : ""}.</p>
      ${RULES.map((x) => `<div class="arule${R[x.id].on ? "" : " off"}"><label class="sw"><input type="checkbox" data-r="${x.id}.on" ${R[x.id].on ? "checked" : ""} aria-label="${esc(x.title)}"><span></span></label><div class="ab"><b>${x.title}</b><p>${x.text}</p>${cfg[x.id] ? `<div class="acfg">${cfg[x.id]}</div>` : ""}<div class="alast">Last: ${last(st[x.id])}</div></div></div>`).join("")}
      <p class="alog hint" aria-live="polite"></p></div><div class="dlg-f"><button class="btn" value="ok" autofocus>Done</button></div></form>`;
  };
  d.addEventListener("change", async (e) => {
    const f = e.target.closest("[data-r]");
    if (!f) return;
    const [rule, k] = f.dataset.r.split(".");
    const v = f.type === "checkbox" ? f.checked : f.type === "number" ? Number(f.value) : f.value;
    try { A = await api("/api/automations", { op: "set", rules: { [rule]: { [k]: v } } }); S.auto = A; draw(); render(); }
    catch (x) { d.querySelector(".alog").textContent = x.message; }
  });
  d.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    try {
      if (b.dataset.a === "notif") { d.close(); return openNotifications(); }
      b.disabled = true;
      A = await api("/api/automations", { op: "digest", push: b.dataset.a === "digestPush" });
      S.auto = A; draw(); goHome(); render();
      d.querySelector(".alog").textContent = b.dataset.a === "digestPush" ? "Digest pushed and shown on the Live board." : "The digest is at the top of the Live board.";
    } catch (x) { d.querySelector(".alog").textContent = x.message; b.disabled = false; }
  });
  draw();
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
  d.scrollTop = 0;
}
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
  if (routeOn() && q.split(/\s+/).filter(Boolean).length >= 3) out.push({ html: `<span>Send to the right session…</span><small>Jev suggests, you confirm</small>`, keep: true, run: () => routeAsk(q) });
  const cur = rowOf(S.sel);
  const n = targets().length;
  const sessions = [...S.rows.values()].map((r) => ({ r, s: fuzzy(`${r.title} ${r.project} ${r.launch ?? ""} ${paneName(r)} ${machineLabel(r.machine)} ${r.agent} ${r.branch ?? ""}`, q) }))
    .filter((x) => x.s).sort((a, b) => b.s - a.s || (b.r.lastActiveAt ?? 0) - (a.r.lastActiveAt ?? 0)).slice(0, q ? 8 : 5);
  if (sessions.length) out.push({ head: q ? "Sessions" : "Recent sessions" }, ...sessions.map(({ r }) => ({
    html: `<span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.title || r.agent)} <span class="hint">${paneTag(r)}</span></span><small>${esc(r.project)}${multiMachine() ? " · " + esc(machineLabel(r.machine)) : ""} · ${esc(ago(r.lastActiveAt) || STATUS_NAME[r.status])}</small>`,
    run: () => { if (!inScope(r)) setMachine("all"); S.view = "inbox"; select(r.key, { scroll: true, open: true }); },
  })));
  if (n) {
    const tools = S.tools.filter((t) => t.action !== "upload").map((t) => ({ t, s: fuzzy(`${t.label} ${t.hint ?? ""} tool`, q) })).filter((x) => x.s).slice(0, q ? 6 : 4);
    if (tools.length) out.push({ head: n > 1 ? `Tools for ${n} selected` : `Tools for “${cur?.title ?? "session"}”` }, ...tools.map(({ t }) => ({ html: `<span>${esc(t.label)}</span><small>${esc(t.hint ?? "")}</small>`, run: () => runTool(t) })));
  }
  const cmds = [
    { t: "New session", k: "n", run: () => openNew() },
    cur && projectHome(cur.project) && { t: `New session in ${cur.project}`, run: () => openNew(projectHome(cur.project)) },
    { t: "Live board: everything working right now", k: "l", run: () => setBoard(true) },
    cur && { t: "Message this session", k: "r", run: focusReply },
    cur && !cur.app && { t: "Jump to this pane in herdr", k: "f", run: () => focusPane(cur.key) },
    cur?.app && { t: "Open this thread in the Codex app", run: () => codexAct("codex-open", cur) },
    cur?.app && { t: "Continue this Codex thread in herdr", run: () => codexAct("codex-resume", cur) },
    cur && { t: "Copy a link to this session", k: "y", run: () => copy(linkUrl(cur), "link") },
    cur && !cur.app && !cur.hist && { t: "Rename this session…", k: "e", run: () => renameSession(cur) },
    { t: "Connections: what agents can use", run: () => openConnections(cur?.key) },
    { t: "Machines: add or remove computers", run: openMachines },
    { t: S.simple ? "Simple mode: off" : "Simple mode: big and friendly", run: () => setSimple(!S.simple) },
    cur && { t: "Write or rewrite the brief", k: "b", run: () => writeBrief(cur.key) },
    cur && { t: "Close this session…", k: "x", run: () => askClose([cur.key]) },
    n > 1 && { t: `Close ${n} selected sessions…`, run: () => askClose(targets()) },
    { t: S.group === "project" ? "Sort the list by priority" : "Group the list by project", k: "g", run: () => setGroup(S.group === "project" ? "priority" : "project") },
    ...(!isPhone() ? TPOS.filter((p) => p !== S.tpos).map((p) => ({ t: `Terminal: ${TPOS_NAME[p].toLowerCase()}`, run: () => setTpos(p) })) : []),
    { t: "Standup: ask every idle agent for a status line", run: standup },
    { t: "Select close candidates", run: suggestClose },
    { t: "Close all empty sessions…", run: () => askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)) },
    { t: "Show closed sessions", k: "c", run: () => { S.view = "closed"; render(); } },
    { t: "Decision inbox: everything waiting on you", k: "i", run: () => setMode("inbox") },
    { t: "History: search every past session", k: "h", run: () => setMode("history") },
    { t: "Tools: what each one does", run: () => setMode("tools") },
    { t: "Connections: everything this setup can reach", run: () => setMode("connections") },
    { t: "Suggest mega projects from my connections", run: suggestProjects },
    { t: "Discover: repos worth forking, picked for you", k: "d", run: () => { S.disc.tab = "you"; setMode("discover"); } },
    { t: "Idea lab: research and plan any idea", run: () => { S.disc.tab = "lab"; setMode("discover"); setTimeout(() => $("dbody").querySelector("[data-didea]")?.focus(), 60); } },
    { t: "Ideas: plans your agents wrote", run: () => { S.disc.tab = "ideas"; setMode("discover"); } },
    q.length > 14 && { t: `Idea lab: “${q.slice(0, 60)}”`, run: () => { setMode("discover"); ideaSearch(q); } },
    { t: `Turn alerts ${S.notify ? "off" : "on"}`, run: toggleAlerts },
    { t: "Notifications on this device…", run: openNotifications },
    { t: "Automations: alerts, morning digest, empty sessions, proof of done", run: openAutomations },
    { t: "Show the morning digest now", run: async () => { try { S.auto = await api("/api/automations", { op: "digest" }); goHome(); render(); } catch (e) { toast(e.message, true); } } },
    { t: "Toggle light / dark", run: toggleTheme },
    ...THEMES.map(([id, label]) => ({ t: `Theme: ${label}`, run: () => setTheme(id) })),
    !isPhone() && { t: "Keyboard shortcuts", k: "?", run: () => $("help").showModal() },
    ...(multiMachine() ? [["all", "all machines"], ...S.summary.machines.map((m) => [m.id, m.label])].map(([id, label]) => ({ t: `Show ${label}`, run: () => setMachine(id) })) : []),
  ].filter(Boolean).map((c) => ({ ...c, s: fuzzy(c.t, q) })).filter((c) => c.s).slice(0, q ? 8 : 6);
  if (cmds.length) out.push({ head: "Commands" }, ...cmds.map((c) => ({ html: `<span>${esc(c.t)}</span>${c.k && !isPhone() ? `<small><kbd>${esc(c.k)}</kbd></small>` : ""}`, run: c.run })));
  if (q) {
    const projects = [...new Set([...S.rows.values()].map((r) => r.project))].map((p) => ({ p, s: fuzzy(p, q) })).filter((x) => x.s).slice(0, 4);
    if (projects.length) out.push({ head: "Projects" }, ...projects.map(({ p }) => ({ html: `<span class="dot" style="--c:${pc(p)}"></span><span>Only show ${esc(p)}</span>`, run: () => { $("q").value = p; S.q = p; S.view = "inbox"; render(); } })));
  }
  return out;
}
function renderPalette() {
  palItems = paletteItems($("palQ").value.trim());
  palIndex = palItems.findIndex((x) => !x.head);
  $("palList").innerHTML = palItems.map((it, idx) => it.head ? `<div class="mh">${esc(it.head)}</div>` : `<button role="option" data-p="${idx}" class="${idx === palIndex ? "on" : ""}">${it.html}</button>`).join("") || `<div class="empty-state">Nothing found</div>`;
}
function palMove(d) {
  const idxs = palItems.map((x, i) => (x.head ? -1 : i)).filter((i) => i >= 0);
  if (!idxs.length) return;
  palIndex = idxs[(idxs.indexOf(palIndex) + d + idxs.length) % idxs.length];
  for (const b of $("palList").querySelectorAll("[data-p]")) b.classList.toggle("on", Number(b.dataset.p) === palIndex);
  $("palList").querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function palRun(i = palIndex) { const it = palItems[i]; if (!it || it.head) return; if (!it.keep) $("palette").close(); it.run(); }
$("palQ").addEventListener("input", renderPalette);
$("palQ").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
  else if (e.key === "Enter") { e.preventDefault(); palRun(); }
});
$("palList").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) palRun(Number(b.dataset.p)); });
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) $("palette").close(); });

// ── send by description ──────────────────────────────────────────────────
// Jev suggests which session a message is for; nothing is sent until you press Enter or Send here.
let palRoute = null;
const PAL_FOOT = $("palette").querySelector(".pal-foot").innerHTML;
const routeOn = () => !!S.jev?.available && S.jev?.features?.route !== false;
const ROUTE_SURE = 0.6;
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
  $("palMsg").value = q;
  $("palMsg").focus();
  renderRoute();
  try {
    const r = await api("/api/jev/route", { text: q }, 20_000);
    if (palRoute !== m) return; // you went back or closed the palette meanwhile
    const picks = (r.picks ?? []).filter((x) => S.rows.has(x.key));
    if (picks.length) {
      m.list = picks;
      m.sel = picks[0].p >= ROUTE_SURE ? picks[0].key : null;
      m.why = m.sel ? `Jev’s pick${r.ms != null ? ` · ${r.ms} ms` : ""}` : "Jev isn’t sure, pick one";
    } else {
      m.list = routeRecent();
      m.why = `${ROUTE_WHY[r.fallback] ?? "Jev couldn’t pick one."}${m.list.length ? " Pick one." : ""}`;
    }
  } catch (x) {
    if (palRoute !== m) return;
    m.list = routeRecent();
    m.why = `${x.message}${m.list.length ? " Pick one." : ""}`;
  }
  m.busy = false;
  renderRoute();
}
function renderRoute() {
  const m = palRoute;
  if (!m) return;
  $("palWhy").textContent = m.busy ? "Asking Jev which session…" : m.why;
  $("palPicks").innerHTML = m.list.map((x) => {
    const r = rowOf(x.key);
    if (!r) return "";
    return `<button type="button" role="option" data-rk="${esc(x.key)}" class="${x.key === m.sel ? "on" : ""}" aria-selected="${x.key === m.sel}"><span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.project)} · ${esc(r.title || r.agent)}${x.p != null ? ` — ${Math.round(x.p * 100)}%` : ""}</span><small>${multiMachine() ? esc(machineLabel(r.machine)) + " · " : ""}${esc(STATUS_NAME[r.status] ?? r.status)}</small></button>`;
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

// ── new session ──────────────────────────────────────────────────────────
const KINDS = [["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["shell", "Shell"]];
let newOpts = null, newKind = load("newKind", "claude"), newMachine = null, pendingSelect = null;
let nSel = { model: "", effort: "", mode: "" };
async function loadNewOptions() {
  try { newOpts = await api("/api/new-options", { machine: newMachine }); } catch (e) { newOpts = { recent: [], projects: [], argHints: {}, choices: {} }; toast(e.message, true); }
  const cur = rowOf(S.sel);
  const saved = load("newCwd:" + newMachine, "");
  $("nCwd").value = saved || (cur && cur.machine === newMachine ? home(cur.projectRoot ?? cur.cwd) : "") || home(newOpts.recent[0] ?? "");
  $("nCwdList").innerHTML = [...new Set([...newOpts.recent, ...newOpts.projects])].map((p) => `<option value="${esc(home(p))}">`).join("");
  const projRoots = [...new Set([...S.rows.values()].filter((r) => r.machine === newMachine && r.projectRoot).sort((a, b) => act(b) - act(a)).map((r) => r.projectRoot))];
  const recent = [...new Set([...projRoots, ...newOpts.recent])].slice(0, 7);
  $("nCwdSugg").innerHTML = recent.length ? `<span class="hint">Recent:</span>` + recent.map((p) => `<button type="button" data-cwd="${esc(home(p))}" title="${esc(p)}">${esc(p.split("/").pop())}</button>`).join("") : "";
  renderKinds();
}
/** Where a project lives: the folder and machine of its most recent session. */
function projectHome(p) {
  const r = [...S.rows.values()].filter((r) => r.project === p && r.projectRoot && !r.app && inScope(r)).sort((a, b) => act(b) - act(a))[0];
  return r ? { machine: r.machine, cwd: r.projectRoot, project: p } : undefined;
}
/** `pre` ({ machine, cwd, project }) opens it already pointed at a project folder. */
async function openNew(pre) {
  pre = pre && pre.cwd ? pre : undefined;
  const cur = rowOf(S.sel);
  newMachine = pre?.machine ?? (S.machine !== "all" ? S.machine : cur?.machine) ?? S.self;
  const ms = realMachines();
  if (!ms.some((m) => m.id === newMachine)) newMachine = S.self;
  $("nMachineWrap").hidden = ms.length <= 1;
  $("nMachine").innerHTML = ms.map((m) => `<button type="button" data-m="${esc(m.id)}" aria-pressed="${m.id === newMachine}" ${m.online ? "" : "disabled"}>${esc(m.label)}</button>`).join("");
  $("nPrompt").value = pre?.prompt ?? ""; $("nLabel").value = pre?.label ?? "";
  newKind = pre?.kind ?? load("newKind", newKind); // Discover prefills Claude Code for that one session; your saved choice is untouched
  $("nFocus").checked = load("newFocus", false);
  $("newDlg").querySelector("h3").textContent = pre?.title ?? (pre ? `New session in ${pre.project}` : "New session");
  if (pre) $("nCwd").value = home(pre.cwd);
  $("newDlg").showModal();
  renderKinds();
  await loadNewOptions();
  if (pre) { $("nCwd").value = home(pre.cwd); renderCmd(); }
  if (!isPhone()) (newKind === "shell" ? $("nCwd") : $("nPrompt")).focus();
}
function renderKinds() {
  $("nKind").innerHTML = KINDS.map(([k, label]) => `<button type="button" data-kind="${k}" aria-pressed="${newKind === k}">${label}</button>`).join("");
  const shell = newKind === "shell";
  $("nPromptWrap").hidden = shell; $("nArgsWrap").hidden = shell; $("nAgentOpts").hidden = shell;
  nSel = { model: "", effort: "", mode: "", ...load("opts:" + newKind, {}) };
  $("nArgs").value = load("args:" + newKind, "");
  const hints = newOpts?.argHints?.[newKind] ?? [];
  $("nArgsSugg").innerHTML = hints.length ? `<span class="hint">Your other ${esc(newKind)} sessions use:</span>` + hints.map((h) => `<button type="button" data-args="${esc(h)}">${esc(h)}</button>`).join("") : "";
  renderAgentOpts();
}
function renderAgentOpts() {
  const ch = newOpts?.choices?.[newKind];
  if (!ch) { $("nAgentOpts").hidden = true; renderCmd(); return; }
  $("nAgentOpts").hidden = newKind === "shell";
  $("nModel").value = nSel.model;
  $("nModelList").innerHTML = ch.models.filter((m) => m.v).map((m) => `<option value="${esc(m.v)}">${esc(m.l ?? "")}</option>`).join("");
  const quick = ch.models.slice(0, newKind === "opencode" ? 1 : 7);
  $("nModelSugg").innerHTML = quick.map((m) => `<button type="button" data-model="${esc(m.v)}" style="${nSel.model === m.v ? "border-style:solid;color:var(--ink)" : ""}">${esc(m.l ?? m.v)}</button>`).join("") + (newKind === "opencode" && ch.models.length > 1 ? `<span class="hint">${ch.models.length - 1} models: type to search</span>` : "");
  const model = ch.models.find((m) => m.v === nSel.model);
  const efforts = model?.efforts?.length ? model.efforts : ch.efforts;
  $("nEffortWrap").hidden = !efforts.length;
  $("nEffort").innerHTML = [["", ch.defaultEffort ? `Default (${ch.defaultEffort})` : "Default"], ...efforts.map((e) => [e, e])].map(([v, l]) => `<button type="button" data-effort="${esc(v)}" aria-pressed="${nSel.effort === v}">${esc(l)}</button>`).join("");
  $("nModeLabel").textContent = newKind === "claude" ? "Permissions" : newKind === "codex" ? "Sandbox" : "Agent";
  $("nMode").innerHTML = ch.modes.map((m) => `<button type="button" data-mode="${esc(m.v)}" aria-pressed="${nSel.mode === m.v}">${esc(m.l ?? m.v)}</button>`).join("");
  renderCmd();
}
/** Mirrors the server's agentArgs so you see exactly what will run. */
function renderCmd() {
  if (newKind === "shell") { $("nCmd").textContent = `a shell in ${$("nCwd").value || "…"}`; return; }
  const a = [newKind];
  const { model, effort, mode } = nSel;
  if (newKind === "claude") { if (model) a.push("--model", model); if (effort) a.push("--effort", effort); if (mode === "bypassPermissions") a.push("--dangerously-skip-permissions"); else if (mode) a.push("--permission-mode", mode); }
  if (newKind === "codex") { if (model) a.push("-m", model); if (effort) a.push("-c", `model_reasoning_effort="${effort}"`); if (mode === "yolo") a.push("--dangerously-bypass-approvals-and-sandbox"); else if (mode) a.push("-s", mode); }
  if (newKind === "opencode") { if (model) a.push("-m", model); if (mode) a.push("--agent", mode); }
  const extra = $("nArgs").value.trim();
  $("nCmd").textContent = "$ " + a.join(" ") + (extra ? " " + extra : "");
}
function saveOpts() { store("opts:" + newKind, nSel); renderAgentOpts(); }
$("nMachine").addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (!b || b.disabled) return; newMachine = b.dataset.m; for (const x of $("nMachine").children) x.setAttribute("aria-pressed", x.dataset.m === newMachine); loadNewOptions(); });
$("nKind").addEventListener("click", (e) => { const b = e.target.closest("[data-kind]"); if (b) { newKind = b.dataset.kind; store("newKind", newKind); renderKinds(); } });
$("nModelSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-model]"); if (b) { nSel.model = b.dataset.model; saveOpts(); } });
$("nModel").addEventListener("change", (e) => { nSel.model = e.target.value.trim(); saveOpts(); });
$("nModel").addEventListener("input", (e) => { nSel.model = e.target.value.trim(); store("opts:" + newKind, nSel); renderCmd(); });
$("nEffort").addEventListener("click", (e) => { const b = e.target.closest("[data-effort]"); if (b) { nSel.effort = b.dataset.effort; saveOpts(); } });
$("nMode").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) { nSel.mode = b.dataset.mode; saveOpts(); } });
$("nArgs").addEventListener("input", renderCmd);
$("nCwd").addEventListener("input", renderCmd);
$("nArgsSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-args]"); if (b) { $("nArgs").value = b.dataset.args; renderCmd(); } });
$("nCwdSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-cwd]"); if (b) { $("nCwd").value = b.dataset.cwd; renderCmd(); } });
$("nPrompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("nOk").click(); } });
$("newDlg").addEventListener("close", async () => {
  if ($("newDlg").returnValue !== "ok") return;
  const body = { machine: newMachine, kind: newKind, cwd: $("nCwd").value.trim(), ...(newKind === "shell" ? {} : nSel), args: $("nArgs").value.trim(), prompt: newKind === "shell" ? "" : $("nPrompt").value, label: $("nLabel").value.trim(), focus: $("nFocus").checked };
  store("newCwd:" + newMachine, body.cwd); store("args:" + newKind, body.args); store("newFocus", body.focus);
  try {
    const { key } = await api("/api/new", body);
    pendingSelect = key;
    if (S.rows.has(key)) { pendingSelect = null; select(key, { scroll: true, open: true }); }
    toast(newKind === "shell" ? "Opened a shell" : `Starting ${newKind}…`);
  } catch (e) { toast("Couldn’t start: " + e.message, true); }
});

// ── events ───────────────────────────────────────────────────────────────
function setMachine(id) { S.machine = id; store("machine", id); S.picked.clear(); lastOrder = ""; render(); }
$("machines").addEventListener("click", (e) => { const b = e.target.closest("[data-machine]"); if (b) setMachine(b.dataset.machine); });
$("groupSeg").addEventListener("click", (e) => { const g = e.target.closest("[data-group]")?.dataset.group; if (g) setGroup(g); });
$("live").onclick = () => setBoard(!S.board);
$("rows").addEventListener("click", async (e) => {
  const newin = e.target.closest('[data-secact="newin"]');
  if (newin) { e.stopPropagation(); return openNew(projectHome(newin.dataset.proj)); }
  if (e.target.closest("[data-secact]")?.dataset.secact === "closeEmpty") { e.stopPropagation(); return askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)); }
  const sec = e.target.closest("[data-sec]");
  if (sec) {
    const k = sec.dataset.sec;
    if (k.startsWith("p:")) { const p = k.slice(2); S.closedProj = { ...S.closedProj, [p]: !S.closedProj[p] }; store("closedProj", S.closedProj); }
    else { const closed = k === "old" ? S.closedSecs.old !== false : k === "empty" && S.group === "project" ? S.closedSecs.empty !== false : !!S.closedSecs[k]; S.closedSecs = { ...S.closedSecs, [k]: !closed }; store("closedSecs", S.closedSecs); }
    lastOrder = ""; return render();
  }
  if (e.target.closest("[data-lf]")?.dataset.lf === "inbox") { S.view = "inbox"; lastOrder = ""; return render(); }
  const grave = e.target.closest("[data-grave]");
  if (grave) {
    const g = S.graveyard.find((x) => x.id === grave.dataset.grave);
    const act = e.target.closest("[data-gact]")?.dataset.gact;
    if (!g || !act) return;
    try {
      if (act === "copy") return copy(g.resume, "resume command");
      if (act === "forget") return api("/api/forget", { id: g.id });
      if (act === "reopen") { toast(`Reopening “${g.title}”…`); await api("/api/reopen", { id: g.id }); toast(`Reopened “${g.title}”`); }
    } catch (x) { toast(x.message, true); }
    return;
  }
  const row = e.target.closest(".row[data-key]");
  if (!row) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); return togglePick(row.dataset.key); }
  const hit = S.q && S.deep?.q === S.q ? S.deep.byKey.get(row.dataset.key) : null;
  if (hit) return jumpTo(row.dataset.key, hit.i);
  select(row.dataset.key, { open: true });
});
// Order freeze: the pointer (or a finger) on the list holds the order still; see renderList.
$("rows").addEventListener("pointerenter", () => { listHold.over = true; });
$("rows").addEventListener("pointermove", () => { listHold.over = true; }, { passive: true });
$("rows").addEventListener("pointerleave", () => { listHold.over = false; releaseSoon(); });
$("rows").addEventListener("touchstart", () => { listHold.touch = true; }, { passive: true });
for (const ev of ["touchend", "touchcancel"]) $("rows").addEventListener(ev, () => { listHold.touch = false; releaseSoon(); }, { passive: true });
// Switching away with the pointer resting on the list shouldn't pin a stale order forever.
addEventListener("blur", () => { if (listHold.over || listHold.touch) { listHold.over = listHold.touch = false; releaseSoon(); } });
let hoverTimer = null;
$("rows").addEventListener("pointerover", (e) => {
  const row = e.target.closest(".row[data-key]");
  if (!row || row._warm) return;
  row._warm = true;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => prefetch(row.dataset.key), 70);
  row.addEventListener("pointerleave", () => { row._warm = false; clearTimeout(hoverTimer); }, { once: true });
});
$("rows").addEventListener("touchstart", (e) => { const row = e.target.closest(".row[data-key]"); if (row) prefetch(row.dataset.key); }, { passive: true });
$("mini").addEventListener("click", (e) => {
  if (e.target.closest("[data-railmore]")) return $("listToggle").click();
  const b = e.target.closest("[data-key]");
  if (b) select(b.dataset.key);
});
$("detail").addEventListener("click", (e) => {
  if (e.target.closest("#appbar")) return;
  const fp = e.target.closest("[data-path]");
  if (fp && !chatSel.size) { e.preventDefault(); e.stopPropagation(); return openFile(fp.dataset.path); }
  const blockEl = e.target.closest("[data-b]");
  if (e.target.closest("[data-copy]") && blockEl) return copyBlocks([blockEl.dataset.b]);
  if (e.target.closest("[data-pick]") && blockEl) return pickBlock(blockEl.dataset.b, e.shiftKey);
  if (chatSel.size && blockEl && !e.target.closest("a, button, [data-toggle]")) return pickBlock(blockEl.dataset.b, e.shiftKey);
  if (e.target.closest("[data-selcopy]")) { copyBlocks([...chatSel]); return clearPicks(); }
  if (e.target.closest("[data-selall]")) { for (const b of chatDom.data ?? []) chatSel.add(b.key); return renderSelBar(); }
  if (e.target.closest("[data-selclear]")) return clearPicks();
  const choose = e.target.closest("[data-choose]");
  if (choose && choose.closest(".choices.pickable")) { const c = choose.closest("[data-choice]"); return sendMessage(`(${c.dataset.choice}) ${c.dataset.title}`, $("cText")); }
  const choice = e.target.closest(".choices.can [data-choice]");
  if (choice) {
    for (const x of choice.parentElement.children) x.classList.toggle("on", x === choice);
    $("cText").value = `(${choice.dataset.choice}) ${choice.dataset.title}${$("cText").value.trim() ? "" : ". "}`;
    autosize($("cText")); $("cText").focus();
    return;
  }
  const quick = e.target.closest("[data-quick]");
  if (quick) return sendMessage(quick.dataset.quick, $("cText"));
  const fold = e.target.closest("[data-fold]");
  if (fold) { const k = fold.dataset.fold; expanded.has(k) ? expanded.delete(k) : expanded.add(k); chatDom.v = -1; return renderChat(); }
  const t = e.target.closest("[data-toggle]");
  if (t) return t.classList.toggle("clamp");
  if (e.target.closest("[data-earlier]")) return loadEarlier();
  const gap = e.target.closest("[data-gap]");
  if (gap) return loadGap(Number(gap.dataset.gap), Number(gap.dataset.gapto));
  const sub = e.target.closest("[data-sub]");
  if (sub) return openSub(sub.dataset.sub);
  const card = e.target.closest("[data-card]");
  if (card) return select(card.dataset.card, { scroll: true, open: true });
  const cimg = e.target.closest("[data-cimg]");
  if (cimg) {
    const all = [...$("dbody").querySelectorAll("[data-cimg]")].map((b) => ({ id: b.dataset.cimg, sub: S.sub }));
    S.gallery = all;
    return openLightbox(all.findIndex((x) => x.id === cimg.dataset.cimg));
  }
  const img = e.target.closest("[data-img]");
  if (img) return openLightbox(Number(img.dataset.img));
  const main = e.target.closest("button[data-main]");
  if (main) return setMain(main.dataset.main);
  const tab = e.target.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; store("tab2", S.tab); if (S.tab !== "chat") S.sub = null; headSig = ""; bodySig = ""; renderDetail(); if (S.tab === "chat") chatTick(true); return; }
  const b = e.target.closest("[data-dact]");
  if (!b) return;
  const act = b.dataset.dact;
  if (act === "new") return openNew();
  if (act === "home") return goHome();
  const r = rowOf(S.sel);
  if (!r) return;
  if (act === "tools") openToolMenu(b);
  if (act === "share") shareRow(r, Number(b.dataset.port));
  if (act === "unshare") unshareRow(r, Number(b.dataset.port));
  if (act === "histresume") resumeHist(r);
  if (act === "backhist") setMode("history");
  if (act === "check") checkMenu(b, r);
  if (act === "showterm") showTerminal();
  if (act === "link") copy(linkUrl(r), "link");
  if (act === "codexopen") codexAct("codex-open", r);
  if (act === "codexresume") codexAct("codex-resume", r);
  if (act === "codexhide") codexAct("codex-hide", r);
  if (act === "focus") focusPane(r.key);
  if (act === "more") moreMenu(b);
  if (act === "brief") writeBrief(r.key);
  if (act === "unsub") { S.sub = null; headSig = ""; bodySig = ""; chatDom.key = null; renderDetail(); chatTick(true); }
  if (act === "expand") { const el = $(b.dataset.target); el?.classList.toggle("clamp"); b.textContent = el?.classList.contains("clamp") ? "Show all" : "Show less"; }
});
$("lf").addEventListener("click", (e) => {
  const a = e.target.closest("[data-lf]")?.dataset.lf;
  if (a === "closed") { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); }
  if (a === "menu") settingsMenu(e.target.closest("[data-lf]"));
});
$("selRecipe").onclick = (e) => openToolMenu(e.currentTarget);
$("selClose").onclick = () => askClose([...S.picked]);
$("selClear").onclick = () => { S.picked.clear(); render(); };
let deepTimer = null, deepSeq = 0;
/** Searches inside every conversation (server-side), so a word said once, weeks ago, still finds its session. */
function deepSearch() {
  clearTimeout(deepTimer);
  const q = S.q.trim();
  const words = parseQuery(q).inc;
  if (q.length < 3 || !words.length) { if (S.deep) { S.deep = null; lastOrder = ""; render(); } return; }
  deepTimer = setTimeout(async () => {
    const seq = ++deepSeq;
    try {
      const { hits } = await api("/api/search", { q: words.join(" ") });
      if (seq !== deepSeq || S.q.trim() !== q) return;
      S.deep = { q: S.q, byKey: new Map(hits.map((h) => [h.key, h])) };
      lastOrder = ""; render();
    } catch {}
  }, 160);
}
$("q").addEventListener("input", (e) => { S.q = e.target.value; render(); deepSearch(); });
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; S.q = ""; S.deep = null; e.target.blur(); render(); }
  if (e.key === "Enter") { const first = S.visible?.[0]; if (first) { select(first.key, { open: true }); e.target.blur(); } }
});
$("paletteBtn").onclick = (e) => { e.preventDefault(); openPalette(); };
$("paletteMini").onclick = () => openPalette();
$("newBtn").onclick = openNew;
$("fitBtn").onclick = () => { S.fit = !S.fit; store("fit", S.fit); fitTerm(); toast(S.fit ? "Fitting the pane’s width" : "Fixed font size"); };
$("listToggle").onclick = () => { app.classList.toggle("list-off"); store("listOff", app.classList.contains("list-off")); lastOrder = ""; $("mini")._h = ""; render(); setTimeout(fitTerm, 0); };
$("termToggle").onclick = () => {
  app.classList.toggle("term-off"); store("termOff", app.classList.contains("term-off")); pollTerm();
  headSig = ""; renderDetail();
  if (app.classList.contains("term-off") && S.tpos === "right") toast("Terminal collapsed. Bring it back with the Terminal button at the top, or ]");
};

let fileCtx = null;
async function openFile(path, key = S.sel) {
  const r = rowOf(key);
  try {
    const f = await api("/api/file", { key, path });
    fileCtx = { key, path: f.path, raw: path };
    $("fTitle").textContent = home(f.path);
    const mac = r && (r.machine === S.self || r.machine === "codex-app");
    $("fOpen").hidden = !mac; $("fReveal").hidden = !mac;
    const body = $("fBody");
    if (f.kind === "dir") body.innerHTML = `<ul class="dirlist">${f.entries.map((n) => `<li><a class="fpath" data-path="${esc(f.path + "/" + n)}">${esc(n)}</a></li>`).join("") || "<li class=hint>Empty folder</li>"}</ul>`;
    else if (f.kind === "image") body.innerHTML = `<img class="fimg" alt="" src="/api/file-raw?key=${encodeURIComponent(key)}&path=${encodeURIComponent(f.path)}&t=${encodeURIComponent(S.token)}">`;
    else if (f.kind === "binary") body.innerHTML = `<p class="hint">A binary file (${mem(f.size / 1024)}). Open it on the Mac instead.</p>`;
    else if (f.kind === "markdown") body.innerHTML = `<div class="md fmd">${md(f.content)}</div>`;
    else body.innerHTML = `<pre class="fcode">${f.content.split("\n").map((l, n) => `<span class="ln${f.line === n + 1 ? " at" : ""}" data-n="${n + 1}">${esc(l) || " "}</span>`).join("\n")}</pre>`;
    $("fMeta").textContent = f.size != null ? `${mem(f.size / 1024)} · changed ${agoText(f.mtime)}` : `${f.entries?.length ?? 0} items`;
    if (!$("fileDlg").open) $("fileDlg").showModal();
    if (f.line) requestAnimationFrame(() => body.querySelector(".ln.at")?.scrollIntoView({ block: "center" }));
    else body.scrollTop = 0;
  } catch (e) { toast(e.message, true); }
}
$("fileDlg").addEventListener("click", (e) => {
  const fp = e.target.closest("[data-path]");
  if (fp) { e.preventDefault(); return openFile(fp.dataset.path, fileCtx?.key); }
  if (e.target === $("fileDlg")) $("fileDlg").close();
});
$("fOpen").onclick = () => fileCtx && api("/api/file-open", { key: fileCtx.key, path: fileCtx.path }).then(() => toast("Opened on the Mac")).catch((x) => toast(x.message, true));
$("fReveal").onclick = () => fileCtx && api("/api/file-open", { key: fileCtx.key, path: fileCtx.path, reveal: true }).then(() => toast("Shown in Finder")).catch((x) => toast(x.message, true));
$("fCopy").onclick = () => fileCtx && copy(fileCtx.path, "path");

function openLightbox(i) {
  const g = S.gallery ?? [];
  if (!g[i]) return;
  S.lb = i;
  $("lbImg").src = imgUrl(S.sel, g[i].id, g[i].sub);
  $("lbCap").textContent = `${i + 1} of ${g.length}${g[i].source ? ` · ${g[i].source === "pasted" ? "you pasted this" : "the agent looked at this"}` : ""}${g[i].at ? " · " + abs(g[i].at) : ""}`;
  if (!$("lightbox").open) $("lightbox").showModal();
}
$("lbPrev").onclick = () => openLightbox(Math.max(0, S.lb - 1));
$("lbNext").onclick = () => openLightbox(Math.min((S.gallery?.length ?? 1) - 1, S.lb + 1));
$("lightbox").addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") $("lbPrev").click(); if (e.key === "ArrowRight") $("lbNext").click(); });

// Splitters: window-level listeners so fast drags over other panels never drop.
function drag(el, axisOf, onMove, onEnd) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const axis = axisOf();
    el.classList.add("drag");
    document.body.classList.add("dragging", axis === "x" ? "col" : "row");
    const move = (ev) => { ev.preventDefault(); onMove(ev); };
    const up = () => { el.classList.remove("drag"); document.body.classList.remove("dragging", "col", "row"); removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); onEnd(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  });
}
let lw = load("lw", 380), th = load("th", Math.round(innerHeight * 0.34)), tw = load("tw", Math.round(innerWidth * 0.4));
const setLw = (v) => { lw = Math.round(Math.max(260, Math.min(innerWidth * 0.6, v))); app.style.setProperty("--lw-open", lw + "px"); };
const setTh = (v) => { th = Math.round(Math.max(90, Math.min(innerHeight - 180, v))); app.style.setProperty("--th-open", th + "px"); };
const setTw = (v) => { tw = Math.round(Math.max(280, Math.min(innerWidth - lw - 320, v))); app.style.setProperty("--tw-open", tw + "px"); };
const unCollapse = () => { if (app.classList.contains("term-off")) { app.classList.remove("term-off"); store("termOff", false); } };
drag($("splitV"), () => "x", (e) => setLw(e.clientX), () => { store("lw", lw); fitTerm(); });
drag($("splitH"), () => (S.tpos === "right" ? "x" : "y"), (e) => {
  if (S.tpos === "right") setTw(innerWidth - e.clientX);
  else setTh(S.tpos === "top" ? e.clientY : innerHeight - e.clientY);
  unCollapse();
}, () => { store("th", th); store("tw", tw); fitTerm(); });
$("splitV").ondblclick = () => { setLw(380); store("lw", lw); fitTerm(); };
$("splitH").ondblclick = () => { if (S.tpos === "right") { setTw(Math.round(innerWidth * 0.4)); store("tw", tw); } else { setTh(Math.round(innerHeight * 0.34)); store("th", th); } fitTerm(); };
$("splitV").addEventListener("keydown", (e) => { const step = e.shiftKey ? 60 : 20; if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setLw(lw + (e.key === "ArrowRight" ? step : -step)); store("lw", lw); fitTerm(); } });
$("splitH").addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 60 : 20;
  if (S.tpos === "right" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); setTw(tw + (e.key === "ArrowLeft" ? step : -step)); store("tw", tw); fitTerm(); }
  if (S.tpos !== "right" && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); setTh(th + ((e.key === "ArrowUp") === (S.tpos === "bottom") ? step : -step)); store("th", th); fitTerm(); }
});
new ResizeObserver(() => fitTerm()).observe($("screen"));

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && chatSel.size && !getSelection()?.toString()) { e.preventDefault(); copyBlocks([...chatSel]); return clearPicks(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return $("palette").open ? $("palette").close() : openPalette(); }
  if (e.defaultPrevented || e.target.matches("input, textarea, select, #screen") || document.querySelector("dialog[open]") || menuEl) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.mode === "inbox" && inboxKeydown(e)) return;
  const k = e.key, cur = S.sel && S.rows.has(S.sel) ? S.sel : null;
  if (k === "/") { e.preventDefault(); if (app.classList.contains("list-off")) $("listToggle").click(); $("q").focus(); $("q").select(); }
  else if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveSel(1); }
  else if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveSel(-1); }
  else if (k === "r" && cur) { e.preventDefault(); focusReply(); }
  else if (k === "." && (cur || S.picked.size)) { e.preventDefault(); openToolMenu(document.querySelector('[data-dact="tools"]') ?? $("cRecipe")); }
  else if (k === "i") setMode(S.mode === "inbox" ? null : "inbox");
  else if (k === "h") setMode(S.mode === "history" ? null : "history");
  else if (k === "d") setMode(S.mode === "discover" ? null : "discover");
  else if (k === "t" && cur) { e.preventDefault(); focusTerminal(); }
  else if (k === "`" && S.tpos === "tab") { e.preventDefault(); setMain(S.main === "chat" ? "term" : "chat"); }
  else if (k === "\\") { e.preventDefault(); setTpos(TPOS[(TPOS.indexOf(S.tpos) + 1) % TPOS.length]); toast(`Terminal: ${TPOS_NAME[S.tpos].toLowerCase()}`); }
  else if (k === "g") setGroup(S.group === "project" ? "priority" : "project");
  else if (k === "l") setBoard(!S.board);
  else if (k === "n") { e.preventDefault(); openNew(); }
  else if (k === "f" && cur) rowOf(cur)?.app ? codexAct("codex-open", rowOf(cur)) : focusPane(cur);
  else if (k === "y" && cur) copy(linkUrl(rowOf(cur)), "link");
  else if (k === "x" && (S.picked.size || cur)) askClose(targets());
  else if (k === "s" && cur) togglePick(cur);
  else if (k === "b" && cur) writeBrief(cur);
  else if (k === "e" && cur && !rowOf(cur)?.app && !rowOf(cur)?.hist) { e.preventDefault(); renameSession(rowOf(cur)); }
  else if (k === "[") $("listToggle").click();
  else if (k === "]") $("termToggle").click();
  else if (k === "c") { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); }
  else if (k === "?") $("help").showModal();
  else if (/^[1-9]$/.test(k)) { const ids = ["all", ...(S.summary.machines ?? []).map((m) => m.id)]; if (ids[k - 1] && ids.length > 2) setMachine(ids[k - 1]); }
  else if (k === "Escape") {
    const a = escAction({ chatPicks: chatSel.size, mode: S.mode, sub: S.sub, q: S.q, picked: S.picked.size, sel: S.sel && rowOf(S.sel) ? S.sel : null, board: S.board });
    if (a === "picks") clearPicks();
    else if (a === "mode") setMode(null);
    else if (a === "sub") { S.sub = null; headSig = ""; chatDom.key = null; renderDetail(); chatTick(true); }
    else if (a === "search") { S.q = ""; S.deep = null; $("q").value = ""; render(); }
    else if (a === "picked") { S.picked.clear(); render(); }
    else if (a === "home") goHome();
  }
});

// ── right-click (or long-press) a session ────────────────────────────────
function rowMenu(r, x, y) {
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), focus() {} };
  const live = !r.app && !r.hist;
  const items = [
    { html: `Open`, run: () => { select(r.key, { scroll: true, open: true }); } },
    live && { html: "Rename…<small>The pane, the tab and the agent’s own name</small>", run: () => renameSession(r) },
    live && isAgent(r) && { html: "Message it…", run: () => { select(r.key, { open: true }); focusReply(); } },
    live && !isPhone() && { html: "Jump to it in herdr", run: () => focusPane(r.key) },
    r.app && { html: "Open in the Codex app", run: () => codexAct("codex-open", r) },
    r.app && { html: "Continue in herdr", run: () => codexAct("codex-resume", r) },
    projectHome(r.project) && { html: `New session in ${esc(r.project)}`, run: () => openNew(projectHome(r.project)) },
    { html: "Copy link", run: () => copy(linkUrl(r), "link") },
    live && { html: S.picked.has(r.key) ? "Unselect" : "Select<small>To act on several at once</small>", run: () => togglePick(r.key) },
    "-",
    live && { html: "Close session…", danger: true, run: () => askClose([r.key]) },
    r.app && { html: "Hide from the deck", danger: true, run: () => codexAct("codex-hide", r) },
  ].filter(Boolean);
  openMenu(anchor, items, r.title || r.agent);
}
$("rows").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-rask]");
  if (!card) return;
  e.stopPropagation();
  const key = card.dataset.rask, d = (S.decisions ?? []).find((x) => x.key === key);
  if (!d) return;
  const b = e.target.closest("[data-ropt]");
  if (b) {
    const o = d.options.find((x) => String(x.id) === b.dataset.ropt);
    if (!o) return;
    card.classList.add("sending");
    try { await answerOption(d, o); toast(`Answered: ${plain(o.title).slice(0, 60)}`); render(); if (S.mode === "inbox") renderInbox(); renderViews(); }
    catch (x) { card.classList.remove("sending"); toast(x.message, true); }
    return;
  }
  if (e.target.closest("[data-rreply], [data-ropen]")) { select(key, { scroll: true, open: true }); if (e.target.closest("[data-rreply]")) focusReply(); return; }
  select(key, { scroll: true, open: true });
}, true);
$("rows").addEventListener("contextmenu", (e) => {
  const el = e.target.closest(".row[data-key]");
  const r = el && rowOf(el.dataset.key);
  if (!r) return;
  e.preventDefault();
  rowMenu(r, e.clientX, e.clientY);
});
// Touch: hold a row for half a second (iOS has no contextmenu event).
{
  let t = 0, sx = 0, sy = 0, fired = false;
  $("rows").addEventListener("touchstart", (e) => {
    const el = e.target.closest(".row[data-key]");
    if (!el || e.touches.length > 1) return;
    fired = false; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    clearTimeout(t);
    t = setTimeout(() => { const r = rowOf(el.dataset.key); if (r) { fired = true; navigator.vibrate?.(8); rowMenu(r, sx, sy); } }, 480);
  }, { passive: true });
  $("rows").addEventListener("touchmove", (e) => { if (Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 8) clearTimeout(t); }, { passive: true });
  $("rows").addEventListener("touchend", (e) => { clearTimeout(t); if (fired) { e.preventDefault(); fired = false; } });
}

// ── phone navigation: a native-feeling stack (list → chat ⇄ terminal) ─────
function setMView(v, push) {
  if (app.dataset.mview === v) return;
  const from = app.dataset.mview;
  app.dataset.mview = v;
  for (const b of document.querySelectorAll(".mbar [data-mv]")) b.setAttribute("aria-selected", b.dataset.mv === v);
  if (push && isPhone()) history.pushState({ mview: v }, "");
  if (v === "term") pollTerm(true);
  if (v === "detail") { chatTick(true); renderDetail(); }
  if (v === "list" && from !== "list") { S.board = false; requestAnimationFrame(() => rowCache.get(S.sel)?.el.scrollIntoView({ block: "nearest" })); }
}
addEventListener("popstate", (e) => setMView(e.state?.mview ?? "list", false));
$("mBack").onclick = () => (history.state?.mview ? history.back() : setMView("list", false));
document.querySelector(".mbar .seg2").addEventListener("click", (e) => {
  const v = e.target.closest("[data-mv]")?.dataset.mv;
  if (!v || v === app.dataset.mview) return;
  if (isPhone()) history.replaceState({ mview: v }, "");
  setMView(v, false);
});
// Swipe from the left edge to go back, like iOS.
{
  let sx = 0, sy = 0, dx = 0, on = false, panels = [];
  addEventListener("touchstart", (e) => {
    if (!isPhone() || app.dataset.mview === "list") return;
    const t = e.touches[0];
    if (t.clientX > 28) return;
    sx = t.clientX; sy = t.clientY; dx = 0; on = true;
    panels = [app.dataset.mview === "term" ? $("term") : $("detail"), $("mbar")];
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (!on) return;
    const t = e.touches[0];
    dx = Math.max(0, t.clientX - sx);
    if (Math.abs(t.clientY - sy) > 40 && dx < 20) { on = false; return; }
    app.classList.add("swiping");
    for (const p of panels) p.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  addEventListener("touchend", () => {
    if (!on) return;
    on = false;
    app.classList.remove("swiping");
    for (const p of panels) p.style.transform = "";
    if (dx > 80) (history.state?.mview ? history.back() : setMView("list", false));
  });
}

// ── live data ────────────────────────────────────────────────────────────
function notifyTransitions(prev, next) {
  if (!S.notify || PUSH.on || !prev || prev.status === next.status) return;
  const done = next.status === "done" && prev.status === "working";
  const blocked = next.status === "blocked";
  if (!done && !blocked) return;
  try {
    const n = new Notification(blocked ? `${next.title || next.agent} needs input` : `${next.title || next.agent} finished`, { body: `${next.project}${multiMachine() ? " · " + machineLabel(next.machine) : ""}`, tag: next.key });
    n.onclick = () => { window.focus(); select(next.key, { scroll: true, open: true }); };
  } catch {}
}
function applyFull(data) {
  S.token = data.token;
  S.self = data.self;
  S.rows = new Map(data.rows.map((r) => [r.key, r]));
  S.summary = data.summary;
  S.graveyard = data.graveyard ?? [];
  S.tools = data.tools ?? [];
  S.queue = data.queue ?? {};
  S.toolGroups = data.toolGroups ?? {};
  S.usage = data.usage ?? {};
  S.hist = data.history ?? {};
  S.decisions = data.decisions ?? [];
  S.radar = data.radar ?? [];
  S.jev = data.jev ?? {};
  S.canShare = !!data.canShare;
  S.publicUrl = data.publicUrl ?? "";
  S.auto = data.auto ?? S.auto;
  S.push = data.push ?? S.push;
  if (!S.linkDone && location.pathname.startsWith("/s/")) {
    S.linkDone = true;
    const hit = resolveLink(location.pathname);
    if (hit?.key) { S.sel = null; S.machine = "all"; lastOrder = ""; render(); select(hit.key, { scroll: true, open: true }); return; }
    toast(hit?.grave ? `“${hit.grave.title}” was closed. Reopen it from Closed.` : "That session isn’t open anymore.", true);
    if (hit?.grave) S.view = "closed";
    history.replaceState(history.state, "", "/");
  }
  S.linkDone = true;
  if (S.machine !== "all" && !S.summary.machines?.some((m) => m.id === S.machine)) S.machine = "all";
  lastOrder = "";
  // No deep link: open on home, the live board (the phone opens on the list).
  if (!S.sel || !rowOf(S.sel)) { S.sel = null; S.board = true; }
  render();
}
let es = null, reconnectTimer = null;
function reconnectSoon(ms = 1500) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { es?.close(); connect(); }, ms);
}
function connect() {
  es = new EventSource("/events");
  es.addEventListener("full", (e) => { $("conn").classList.remove("off"); applyFull(JSON.parse(e.data)); });
  es.addEventListener("patch", (e) => {
    const p = JSON.parse(e.data);
    for (const r of p.upsert) { notifyTransitions(rowOf(r.key), r); S.rows.set(r.key, r); }
    for (const k of p.remove) { S.rows.delete(k); S.details.delete(k); }
    S.summary = p.summary;
    if (pendingSelect && rowOf(pendingSelect)) { const k = pendingSelect; pendingSelect = null; select(k, { scroll: true, open: true }); return; }
    if (S.sel && !rowOf(S.sel) && S.board) S.sel = null;
    if (S.sel && !rowOf(S.sel)) { S.sel = null; const next = S.visible?.find((r) => S.rows.has(r.key))?.key; if (next && !isPhone()) return select(next); }
    if (S.sel && p.upsert.some((r) => r.key === S.sel)) chatTick();
    render();
  });
  es.addEventListener("queue", (e) => { S.queue = JSON.parse(e.data); const r = rowOf(S.sel); if (r) renderQueue(r); render(); });
  es.addEventListener("graveyard", (e) => { S.graveyard = JSON.parse(e.data); render(); });
  es.addEventListener("history", (e) => { S.hist = JSON.parse(e.data); if (S.mode === "history") renderHistStatus(); });
  es.addEventListener("usage", (e) => { S.usage = JSON.parse(e.data); const r = rowOf(S.sel); if (r && !S.mode) renderStatusLine(r); });
  es.addEventListener("jev", (e) => { S.jev = JSON.parse(e.data); if (S.mode === "inbox") { if (S.jevOpen) loadJevStats(); else renderInbox(); } });
  es.addEventListener("radar", (e) => { S.radar = JSON.parse(e.data); render(); });
  es.addEventListener("decisions", (e) => { S.decisions = JSON.parse(e.data); renderViews(); if (S.mode === "inbox") { renderInbox(); if (S.jevOpen) loadJevStats(); } render(); });
  es.addEventListener("auto", (e) => { S.auto = JSON.parse(e.data); if (S.board) { bodySig = ""; render(); } });
  es.addEventListener("audit", (e) => { S.audit = JSON.parse(e.data); if (S.mode === "connections") renderConnections(); });
  es.addEventListener("notice", (e) => { const n = JSON.parse(e.data); toast(n.message, !n.ok); if (n.key && n.key === S.sel) loadDetail(n.key); });
  es.onopen = () => $("conn").classList.remove("off");
  es.onerror = () => {
    $("conn").classList.add("off");
    if (es.readyState === EventSource.CLOSED) reconnectSoon(2000);
  };
}
setTpos(S.tpos);
setMain(S.main);
if (window.__BOOT__) applyFull(window.__BOOT__);
connect();
if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").then(() => pushSync()).catch(() => {});
{
  const params = new URLSearchParams(location.search);
  if (params.get("status") === "blocked") { S.q = "is:blocked"; $("q").value = S.q; render(); }
  if (params.get("new")) setTimeout(openNew, 50);
  if (params.get("digest")) { S.sel = null; setBoard(true); }
  if ([...params.keys()].length) history.replaceState(history.state, "", "/");
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollTerm(); chatTick(true); } });
