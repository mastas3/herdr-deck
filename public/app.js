"use strict";
// herdr deck client. State arrives inlined in the page (window.__BOOT__), then as row patches over SSE.
// The session pane is a chat: the whole conversation, live, with a composer that talks to the agent.

// ── state ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function store(k, v) { try { localStorage.setItem("deck:" + k, JSON.stringify(v)); } catch {} }
function load(k, d) { try { const v = localStorage.getItem("deck:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
const S = {
  token: "", self: "", rows: new Map(), summary: { herdr: [], machines: [] }, graveyard: [], recipes: [],
  machine: load("machine", "all"), q: "", sel: null, picked: new Set(), view: "inbox", group: load("group", "inbox"),
  tab: load("tab2", "chat"), closedSecs: load("closedSecs", { stale: true, empty: true }), closedProj: load("closedProj", {}),
  notify: false, fit: load("fit", true), autoBrief: load("autoBrief", true),
  details: new Map(), board: false, sub: null,
  tpos: load("tpos", "bottom"), main: load("main", "chat"),
};
S.notify = load("notify", false) && "Notification" in window && Notification.permission === "granted";
const theme = load("theme", ""); if (theme) document.documentElement.dataset.theme = theme;
const app = $("app");
app.dataset.tpos = S.tpos;
app.dataset.main = S.main;
app.style.setProperty("--lw-open", load("lw", 380) + "px");
app.style.setProperty("--th-open", load("th", Math.round(innerHeight * 0.34)) + "px");
app.style.setProperty("--tw-open", load("tw", Math.round(innerWidth * 0.4)) + "px");
app.classList.toggle("list-off", load("listOff", false));
app.classList.toggle("term-off", load("termOff", false));
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
const realMachines = () => (S.summary.machines ?? []).filter((m) => m.kind !== "app");
const plain = (t) => String(t ?? "").replace(/^\s*\[\d{4}-\d\d-\d\d[^\]]*\]\s*/, "").replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/, "").replace(/\s+/g, " ").trim();
const home = (p) => String(p ?? "").replace(/^\/(Users|home)\/[^/]+/, "~");
const isAgent = (r) => ["claude", "codex", "opencode"].includes(r?.agent);
const ICON = {
  chev: '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 6 4 4 4-4"/></svg>',
  back: '<svg class="chev" style="transform:rotate(90deg)" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 6 4 4 4-4"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  jump: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2 7.5 8.5"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.8 9.5 6l4.3.2-3.4 2.7 1.2 4.2L8 10.7l-3.6 2.4 1.2-4.2L2.2 6.2 6.5 6z"/></svg>',
  bot: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/></svg>',
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
function inline(s) {
  const codes = [];
  let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
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
function choicesHTML(opts) {
  return `<div class="choices">${opts.map((o) => {
    const first = o.body[0].replace(/\*\*/g, "");
    const cut = first.search(/(?<=[.!?])\s|\s[—–-]\s|:\s/);
    const title = (cut > 0 && cut < 110 ? first.slice(0, cut) : first.length < 110 ? first : first.slice(0, 100) + "…").replace(/[.:]$/, "");
    const rest = [cut > 0 && cut < 110 ? first.slice(cut).replace(/^\s*[—–:-]?\s*/, "") : first.length < 110 ? "" : first, ...o.body.slice(1)].filter((x) => x.trim());
    const rec = /recommend|\bpreferred\b/i.test(o.body[0]);
    const lab = o.label.toUpperCase();
    return `<div class="choice${rec ? " rec" : ""}" data-choice="${esc(o.label)}" data-title="${esc(title.replace(/\s*\((my )?recommend(ed|ation)\)/i, ""))}"><span class="cl">${esc(lab)}</span><div class="cb"><div class="ct">${inline(title)}${rec ? '<span class="rp">Recommended</span>' : ""}</div>${rest.length ? `<div class="cd">${rest.map(inline).join("<br>")}</div>` : ""}</div><button class="btn primary cs" data-choose="${esc(o.label)}" tabindex="-1">Choose ${esc(lab)}</button></div>`;
  }).join("")}</div>`;
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
      const prevText = (out[out.length - 1] ?? "").replace(/<[^>]+>/g, "");
      const ch = OPT_RE.test(l) ? parseChoices(lines, i, /\?\s*$/.test(prevText) || /\b(choose|option|which|prefer|pick|decide)\b/i.test(prevText)) : null;
      if (ch) { out.push(choicesHTML(ch.opts)); i = ch.end; continue; }
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
const SECTIONS = [["needs", "Needs you"], ["running", "Running"], ["quiet", "Quiet"], ["stale", "Stale"], ["empty", "Empty"]];
function sectionOf(r) {
  if (r.status === "blocked" || r.status === "done") return "needs";
  if (r.status === "working") return "running";
  if (r.empty) return "empty";
  if (r.stale) return "stale";
  return "quiet";
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
      if (!q.inc.every((w) => h.includes(w)) || q.exc.some((w) => h.includes(w))) continue;
    }
    out.push(r);
  }
  const act = (r) => r.lastActiveAt ?? r.startedAt ?? 0;
  out.sort((a, b) => (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1) || act(b) - act(a));
  return out;
}

// ── list rendering (keyed; only changed rows touch the DOM) ──────────────
const rowCache = new Map();
function rowHTML(r, byProject) {
  const live = r.status === "working";
  const mach = multiMachine() && S.machine === "all" ? `<span class="mach">${esc(machineLabel(r.machine))}</span>` : "";
  const agoEl = `<span class="ago${live ? " going" : ""}" ${live ? "" : `data-t="${r.lastActiveAt ?? ""}"`} title="Last active ${esc(abs(r.lastActiveAt))}">${live ? "working" : ago(r.lastActiveAt)}</span>`;
  const title = `<span class="tl"><b>${esc(r.title || "(untitled)")}</b> <span class="pane">${paneTag(r)}</span></span>`;
  let line = "";
  const tail = r.tail?.length ? plain(r.tail[r.tail.length - 1]) : "";
  if (r.status === "blocked") line = `<span class="ln ask">${esc(tail || "waiting for you")}</span>`;
  else if (live) line = `<span class="ln now">${r.todos?.total ? `<span class="stp">${r.todos.done}/${r.todos.total}</span>` : ""}${r.now ? esc(nowWords(r.now)) : r.step ? esc(r.step) : "thinking…"}</span>`;
  else if (r.status === "done") line = `<span class="ln">Finished · ${esc(plain(r.lastMessage) || tail)}</span>`;
  else if (r.empty) line = `<span class="ln">${r.agent === "shell" ? "empty shell" : "no conversation yet"}</span>`;
  const running = (r.subagents ?? []).filter((x) => x.running);
  const subs = running.length ? `<span class="subs">${running.slice(0, 3).map((x) => `<div><span class="spin"></span>${esc(x.type || "agent")}: ${esc(x.description ?? "")}${x.now ? ` <span class="mono">${esc(x.now)}</span>` : ""}</div>`).join("")}${running.length > 3 ? `<div>+${running.length - 3} more</div>` : ""}</span>` : "";
  const dot = `<span class="dot" style="--c:${statusVar(r.status)}"></span>`;
  if (byProject) return `${dot}<span class="tl" style="grid-column:auto"><b>${esc(r.title || "(untitled)")}</b> <span class="pane">${paneTag(r)}</span>${r.launch ? ` <span class="via">via ${esc(r.launch)}</span>` : ""} ${mach}</span>${agoEl}${line}${subs}`;
  return `${dot}<span class="pl"><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>${r.launch ? `<span class="via">via ${esc(r.launch)}</span>` : ""}${mach}</span>${agoEl}${title}${line}${subs}`;
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
  const n = [...S.rows.values()].filter((r) => r.status === "blocked" || r.status === "done").length;
  document.title = (n ? `(${n}) ` : "") + "herdr deck";
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
    const empty = rows.filter((r) => r.empty);
    const by = new Map();
    for (const r of rows) if (!r.empty) by.set(r.project, [...(by.get(r.project) ?? []), r]);
    const rank = (rs) => (rs.some((r) => r.status === "blocked" || r.status === "done") ? 0 : rs.some((r) => r.status === "working") ? 1 : 2);
    const latest = (rs) => Math.max(...rs.map((r) => r.lastActiveAt ?? 0));
    const groups = [...by.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || latest(b[1]) - latest(a[1]))
      .map(([p, rs]) => ({ key: "p:" + p, label: p, proj: p, rows: rs.sort((a, b) => ["blocked", "done", "working"].indexOf(b.status) - ["blocked", "done", "working"].indexOf(a.status) || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)), closed: !!S.closedProj[p] }));
    if (empty.length) groups.push({ key: "empty", label: "Empty", rows: empty, closed: S.closedSecs.empty !== false });
    return groups;
  }
  const g = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  for (const r of rows) g[sectionOf(r)].push(r);
  return SECTIONS.map(([k, label]) => ({ key: k, label, rows: g[k], closed: !!S.closedSecs[k] })).filter((x) => x.rows.length);
}
function renderList() {
  const box = $("rows");
  const rows = visibleRows();
  const byProject = S.group === "project";
  const groups = listGroups(rows);
  S.visible = groups.flatMap((g) => (g.closed ? [] : g.rows));
  for (const k of rowCache.keys()) if (!S.rows.has(k)) rowCache.delete(k);
  for (const r of rows) {
    let c = rowCache.get(r.key);
    if (!c) {
      const el = document.createElement("div");
      el.className = "row"; el.dataset.key = r.key; el.setAttribute("role", "button");
      c = { el, sig: "" };
      rowCache.set(r.key, c);
    }
    const sig = JSON.stringify(r) + S.machine + multiMachine() + byProject;
    if (c.sig !== sig) {
      const was = c.el.dataset.status;
      c.el.innerHTML = rowHTML(r, byProject); c.el.dataset.status = r.status; c.sig = sig;
      if (was && was !== r.status && (r.status === "blocked" || r.status === "done")) { c.el.classList.remove("flash"); void c.el.offsetWidth; c.el.classList.add("flash"); }
    }
    c.el.classList.toggle("sel", S.sel === r.key && !S.board);
    c.el.classList.toggle("picked", S.picked.has(r.key));
    c.el.classList.toggle("stale", !!r.stale && r.status !== "working" && r.status !== "blocked");
  }
  const order = S.group + groups.map((g) => g.key + ":" + (g.closed ? "x" : "") + g.rows.map((r) => r.key).join(",")).join("|");
  if (order !== lastOrder || box.dataset.view !== "list") {
    lastOrder = order;
    box.dataset.view = "list";
    box._h = "";
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      const sec = document.createElement("section");
      sec.className = "sec" + (g.closed ? " closed" : "") + (g.proj ? " proj" : "");
      if (g.proj) sec.style.setProperty("--pc", pc(g.proj));
      const nb = g.rows.filter((r) => r.status === "blocked" || r.status === "done").length, nw = g.rows.filter((r) => r.status === "working").length;
      const dots = g.proj ? `<span class="dots">${nb ? `<span class="dot" style="--c:var(--blocked)" title="${nb} need you"></span>` : ""}${nw ? `<span class="dot" style="--c:var(--working)" title="${nw} working"></span>` : ""}</span>` : "";
      const extra = g.key === "empty" ? `<span class="act link" data-secact="closeEmpty" role="button">Close all</span>` : "";
      sec.innerHTML = `<button class="sec-h" data-sec="${esc(g.key)}" aria-expanded="${!g.closed}">${ICON.chev}${g.proj ? '<span class="sw"></span>' : ""}${esc(g.label)} <span class="n">${g.rows.length}</span>${dots}${extra}</button><div class="sec-b"></div>`;
      const body = sec.lastChild;
      for (const r of g.rows) body.append(rowCache.get(r.key).el);
      frag.append(sec);
    }
    box.replaceChildren(frag);
    if (!rows.length) box.innerHTML = `<div class="empty-state">${S.rows.size ? "Nothing matches. Press Esc to clear the filter." : "No sessions yet. Press n to start one."}</div>`;
  }
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
  const tile = (r) => {
    const subs = (r.subagents ?? []).filter((x) => x.running).length;
    const since = r.status === "working" && r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
    const tm = since ? `<span class="tm" data-since="${since}">${clock(Date.now() - since)}</span>` : r.status === "blocked" ? `<span class="tm">waiting</span>` : `<span class="tm" data-t="${r.lastActiveAt ?? ""}">${ago(r.lastActiveAt)}</span>`;
    const tip = `${r.title || r.agent}\n${r.project}${r.launch ? " (via " + r.launch + ")" : ""} · ${paneName(r)}${multiMachine() ? " · " + machineLabel(r.machine) : ""}\n${STATUS_NAME[r.status] ?? r.status}${r.now ? " · " + r.now : ""}${subs ? `\n${subs} subagent${subs === 1 ? "" : "s"} running` : ""}`;
    return `<button class="tile${S.sel === r.key && !S.board ? " sel" : ""}" data-key="${esc(r.key)}" data-status="${r.status}" style="--pc:${pc(r.project)};--c:${statusVar(r.status)}" title="${esc(tip)}"><span class="ab">${esc(initials(r.project))}</span>${r.status !== "idle" ? '<span class="sd"></span>' : ""}${subs ? `<span class="sb">+${subs}</span>` : ""}<span class="tt">${esc(shortTitle(r.title))}</span>${tm}</button>`;
  };
  const html = [["needs", "Needs you"], ["running", "Running"], ["quiet", "Quiet"]].filter(([k]) => groups[k].length)
    .map(([k, label]) => `<div class="mh">${label.split(" ")[0]} <span class="n">${groups[k].length}</span></div>${groups[k].map(tile).join("")}`).join("")
    + (hidden ? `<button class="more" data-railmore>+${hidden} stale or empty</button>` : "");
  setHTML($("mini"), html);
}
function renderFooter() {
  const all = [...S.rows.values()].filter(inScope);
  const off = (S.summary.machines ?? []).filter((m) => !m.online);
  setHTML($("lf"), `<span><b>${all.length}</b> sessions · ${mem(all.reduce((s, r) => s + r.rssKB, 0))}</span>${off.length ? `<span class="warn" title="${esc(off.map((m) => m.label + ": " + (m.error ?? "")).join("\n"))}">${off.length} offline</span>` : ""}<span class="spacer"></span><button class="link" data-lf="closed">${S.view === "closed" ? "Sessions" : `Closed ${S.graveyard.length}`}</button><button class="link" data-lf="menu">Settings</button>`);
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
  for (const el of document.querySelectorAll("[data-t]")) { const t = Number(el.dataset.t); if (t) el.textContent = el.dataset.fmt === "long" ? agoText(t) : ago(t); }
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
  const r = S.rows.get(S.sel);
  const path = S.board || !r ? "/" : linkPath(r);
  if (location.pathname !== path) history.replaceState(history.state, "", path);
}

// ── selection & detail data ──────────────────────────────────────────────
let briefTimer = null;
function select(key, opts = {}) {
  if (!key || !S.rows.has(key)) return;
  const changed = S.sel !== key;
  S.sel = key;
  S.board = false;
  store("sel", key);
  if (changed) {
    S.sub = null;
    termText = ""; termHash = ""; $("screen").innerHTML = ""; headSig = ""; bodySig = "";
    $("cText").value = S.drafts?.get(key) ?? ""; autosize($("cText"));
    chatDom.key = null;
    chatSel.clear(); lastPicked = null; $("msgbar")?.remove(); $("detail").classList.remove("selecting");
  }
  render();
  loadDetail(key);
  pollTerm(true);
  chatTick(true);
  prefetchNeighbours(key);
  if (opts.scroll) requestAnimationFrame(() => rowCache.get(key)?.el.scrollIntoView({ block: "nearest" }));
  if (opts.open && isPhone()) setMView("detail", true);
  syncUrl();
}
S.drafts = new Map();
const inflight = new Map();
async function loadDetail(key) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await api("/api/detail", { key });
      S.details.set(key, { data, stamp: S.rows.get(key)?.lastActiveAt, at: Date.now() });
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
  const r = S.rows.get(key);
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
  if (c.gen !== slice.gen || slice.reset) { c.msgs.clear(); c.first = Infinity; c.last = -1; c.gen = slice.gen; }
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
  const r = S.rows.get(key);
  if (!r) return;
  const visible = !S.board && S.tab === "chat" && (isPhone() ? app.dataset.mview === "detail" : !(S.tpos === "tab" && S.main === "term"));
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
  for (const m of ms) {
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
  if (b.kind === "user" || b.kind === "pending") {
    const long = (m.text ?? "").length > 900;
    return `<div class="msg user${b.kind === "pending" ? " pending" : ""}">${MSG_TOOLS}<div class="body${long ? " clamp" : ""}" ${long ? "data-toggle" : ""}>${esc(m.text)}</div>${imgs(m.images)}<div class="t">${b.kind === "pending" ? "sending…" : esc(when(m.at))}</div></div>`;
  }
  if (b.kind === "assistant") return `<div class="msg assistant">${MSG_TOOLS}<div class="md">${md(m.text)}</div><div class="t">${esc(when(m.at))}</div></div>`;
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
function renderChat() {
  const body = $("dbody");
  const key = S.sel;
  if (!key || S.board || S.tab !== "chat") return;
  const id = chatId(key, S.sub);
  const c = chatOf(id);
  const r = S.rows.get(key);
  if (c.gen == null && !c.msgs.size && !c.pending.length) {
    if (chatDom.key !== id + ":loading") {
      chatDom.key = id + ":loading";
      body.innerHTML = `<div class="chat"><p class="hint">${r && !r.sessionId ? (r.empty ? "Nothing has happened in this pane yet." : "No conversation found for this pane. The terminal shows what it’s doing.") : "Loading the conversation…"}</p></div>`;
    }
    return;
  }
  const dref = S.details.get(key)?.data;
  const st = S.rows.get(key)?.status;
  if (chatDom.key === id && chatDom.v === c.v && chatDom.dref === dref && chatDom.st === st && chatDom.el && body.contains(chatDom.el)) return;
  chatDom.v = c.v; chatDom.dref = dref; chatDom.st = st;
  const blocks = chatBlocks(c);
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 90;
  if (chatDom.key !== id || !chatDom.el || !body.contains(chatDom.el)) {
    chatDom.key = id;
    chatDom.blocks = [];
    const wrap = document.createElement("div");
    wrap.className = "chat";
    wrap.innerHTML = `<button class="btn ghost more" data-earlier ${c.first > 0 ? "" : "hidden"}>Load earlier messages</button>`;
    body.replaceChildren(wrap);
    chatDom.el = wrap;
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
  decorateLatest(wrap, blocks, S.rows.get(key));
  const grew = next.length && next[next.length - 1].key !== chatDom.lastKey;
  chatDom.lastKey = next[next.length - 1]?.key;
  if (chatDom.fresh !== id) { chatDom.fresh = id; body.scrollTop = body.scrollHeight; }
  else if (nearBottom) body.scrollTop = body.scrollHeight;
  else if (grew) showNewPill();
}
/** Only the newest agent message is actionable: its choices become buttons, a closing question gets quick replies. */
function decorateLatest(wrap, blocks, r) {
  wrap.querySelector(".quick")?.remove();
  wrap.querySelector(".thinking")?.remove();
  for (const el of wrap.querySelectorAll(".choices.pickable")) el.classList.remove("pickable");
  if (!r || S.sub) return;
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
  const r = S.rows.get(S.sel);
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

function showNewPill() {
  if (chatDom.el?.querySelector(".newpill")) return;
  const b = document.createElement("button");
  b.className = "newpill";
  b.textContent = "↓ New messages";
  b.onclick = () => { $("dbody").scrollTo({ top: $("dbody").scrollHeight, behavior: "smooth" }); b.remove(); };
  chatDom.el?.append(b);
}
$("dbody").addEventListener("scroll", () => {
  const body = $("dbody");
  if (S.tab === "chat" && body.scrollTop < 240) loadEarlier();
  if (body.scrollHeight - body.scrollTop - body.clientHeight < 60) chatDom.el?.querySelector(".newpill")?.remove();
}, { passive: true });

// ── session pane ─────────────────────────────────────────────────────────
let headSig = "", bodySig = "";
function renderDetail() {
  const r = S.rows.get(S.sel);
  const d = S.details.get(S.sel)?.data;
  if (S.board || !r) return renderBoard();
  $("dh").hidden = false;
  const tab = S.tab === "images" && !d?.imagesTotal ? "chat" : S.tab === "agents" && !d?.subagents?.length ? "chat" : S.tab;
  const hs = JSON.stringify([r.title, r.project, r.launch, r.status, r.model, r.branch, r.dirty, r.tab, r.tabNumber, r.ctxTokens, r.lastActiveAt, r.duplicate, r.machine, d?.asks, d?.imagesTotal, d?.subagents?.length, d?.subagents?.filter((x) => x.running).length, tab, S.tpos, S.main, S.sub, S.summary.machines?.length]);
  if (hs !== headSig) { headSig = hs; renderHead(r, d, tab); }
  const cached = S.details.get(S.sel);
  if (cached && cached.stamp !== r.lastActiveAt && !inflight.has(r.key)) { clearTimeout(renderDetail.t); renderDetail.t = setTimeout(() => loadDetail(r.key), 700); }
  renderNowbar(r, d);
  renderAsk(r);
  $("composer").hidden = !r || S.sub != null || !!r.app;
  $("appbar").hidden = !r.app || S.sub != null;
  if (r.app) setHTML($("appbar"), `<span>${r.status === "working" ? '<span class="spin" style="vertical-align:-1px"></span> Working in the Codex app' : "This thread lives in the Codex app"}${!(S.summary.machines ?? []).find((m) => m.kind === "app")?.online ? " (the app isn’t running)" : ""}.</span><span class="spacer"></span><button class="btn primary" data-dact="codexopen">${ICON.jump}Open in Codex</button><button class="btn" data-dact="codexresume" title="Resume it with the Codex CLI in a new herdr tab">${ICON.term}Continue in herdr</button><button class="btn ghost" data-dact="codexhide" title="Hide it from the deck (it stays in the app)">Hide</button>`);
  $("cStop").hidden = !(r.status === "working" && isAgent(r));
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
  if (bs === bodySig) return;
  bodySig = bs;
  chatDom.key = null;
  const box = $("dbody");
  const scroll = box.scrollTop;
  box.innerHTML = `<div class="pad">${!d ? `<p class="hint">Reading the conversation…</p>` : tab === "images" ? imagesHTML(r, d) : tab === "info" ? factsHTML(r, d) : tab === "agents" ? agentsHTML(d) : aboutHTML(r, d)}</div>`;
  box.scrollTop = scroll;
}
function renderHead(r, d, tab) {
  const created = d?.startedAt ?? r.createdAt;
  const where = [
    `<span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>`,
    r.launch ? `<span title="Started in ${esc(home(r.cwd))}">via ${esc(r.launch)}</span>` : "",
    multiMachine() ? `<span>${esc(machineLabel(r.machine))}</span>` : "",
    `<span>${paneTag(r)}</span>`,
    r.branch ? `<span>${esc(r.branch)}${r.dirty ? ` · ${r.dirty} uncommitted` : ""}</span>` : "",
    r.duplicate ? `<span class="warn">another pane has this conversation</span>` : "",
  ].join("");
  const meta = [
    `<span class="pill" style="--c:${statusVar(r.status)}">${STATUS_NAME[r.status] ?? esc(r.status)}</span>`,
    `<span>${esc(r.agent)}${r.model ? ` · ${esc(r.model.replace(/^claude-/, ""))}` : ""}</span>`,
    created ? `<span>started <b>${esc(DF.format(new Date(created)))}</b></span>` : "",
    r.lastActiveAt ? `<span>active <b data-t="${r.lastActiveAt}" data-fmt="long">${agoText(r.lastActiveAt)}</b></span>` : "",
    d?.asks ? `<span><b>${d.asks}</b> ${d.asks === 1 ? "request" : "requests"}</span>` : "",
    r.ctxTokens != null ? `<span><b>${tok(r.ctxTokens)}</b> context</span>` : "",
  ].filter(Boolean).join("");
  const subsRun = d?.subagents?.filter((x) => x.running).length;
  const tabs = [["chat", "Chat"], ["agents", "Subagents", d?.subagents?.length, subsRun], ["about", "About"], ["images", "Images", d?.imagesTotal], ["info", "Info"]]
    .filter(([k, , n]) => (k !== "images" && k !== "agents") || n)
    .map(([k, label, n, run]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}${n ? ` <span class="n">${run ? `${run} running · ` : ""}${n}</span>` : ""}</button>`).join("");
  const swap = S.tpos === "tab" ? `<div class="seg2"><button data-main="chat" aria-selected="${S.main === "chat"}">Chat</button><button data-main="term" aria-selected="${S.main === "term"}">Terminal</button></div>` : "";
  setHTML($("dh"), `<div class="dh-where">${where}</div>
    <div class="dh-top"><h1 class="dh-title">${esc(r.title || "(untitled)")}</h1>
      <div class="dh-acts">${r.app ? `<button class="btn" data-dact="codexopen" title="Open this thread in the Codex app">${ICON.jump}Open in Codex</button>` : `${S.tpos === "none" ? `<button class="btn desk" data-dact="showterm" title="Show the terminal (t)">${ICON.term}Terminal</button>` : ""}<button class="btn" data-dact="recipes" title="Recipes (.)">${ICON.star}Recipes</button><button class="btn desk" data-dact="focus" title="Switch herdr to this pane (f)">${ICON.jump}Jump</button>`}<button class="ib" data-dact="link" aria-label="Copy a link to this session" title="Copy link (y)">${ICON.link}</button><button class="ib" data-dact="more" aria-label="More actions" title="More">${ICON.more}</button></div></div>
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
    const cur = S.rows.get(S.sel);
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
  const r = S.rows.get(S.sel);
  if (!r || !act) return;
  e.stopPropagation();
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

// Live board: everything working or waiting, at a glance.
function renderBoard() {
  $("dh").hidden = true; $("nowbar").hidden = true; $("askbox").hidden = true; $("composer").hidden = true; $("subcrumb").hidden = true;
  chatDom.key = null;
  const rows = [...S.rows.values()].filter(inScope);
  const live = rows.filter((r) => r.status === "working" || r.status === "blocked").sort((a, b) => (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1) || (a.turnStartedAt ?? 0) - (b.turnStartedAt ?? 0));
  const done = rows.filter((r) => r.status === "done").sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  const card = (r) => {
    const subs = (r.subagents ?? []).filter((x) => x.running);
    const since = r.status === "working" && r.turnStartedAt && Date.now() - r.turnStartedAt < 12 * 3600_000 ? r.turnStartedAt : null;
    return `<div class="card" data-card="${esc(r.key)}" data-status="${r.status}"><div class="top"><span class="dot" style="--c:${statusVar(r.status)}"></span><span class="pj" style="--pc:${pc(r.project)}">${esc(r.project)}</span>${multiMachine() ? `<span class="mach">${esc(machineLabel(r.machine))}</span>` : ""}<span class="spacer"></span><span class="hint">${since ? `<span data-since="${since}">${clock(Date.now() - since)}</span>` : esc(STATUS_NAME[r.status])}</span></div>
      <div class="ti">${esc(r.title || r.agent)} <span class="hint">${paneTag(r)}</span></div>
      ${r.status === "blocked" ? `<div class="now" style="color:var(--blocked)">${esc(plain(r.tail?.[r.tail.length - 1]) || "waiting for you")}</div>` : r.step || r.now ? `<div class="now">${r.todos?.total ? `<span class="stp">${r.todos.done}/${r.todos.total}</span> ` : ""}${esc(r.step ?? "")}${r.step && r.now ? " · " : ""}${esc(nowWords(r.now))}</div>` : ""}
      ${subs.map((x) => `<div class="now"><span class="spin" style="width:9px;height:9px;border-width:1.5px"></span> ${esc(x.type || "agent")}: ${esc(x.description ?? "")}${x.now ? ` · ${esc(x.now)}` : ""}</div>`).join("")}
      <pre>${ansi((r.tail ?? []).slice(-4).join("\n"))}</pre></div>`;
  };
  const n = live.length;
  const html = `<div class="d-empty"><h2>${n ? `${live.filter((r) => r.status === "working").length} working, ${live.filter((r) => r.status === "blocked").length} waiting for you` : "Nothing running right now"}</h2><p>${n ? "Live. Click a card to open it." : "Pick a session, press ⌘K to find anything, or n to start one."}</p>
    ${n ? `<div class="board">${live.map(card).join("")}</div>` : `<p><button class="btn primary" data-dact="new">New session</button></p>`}
    ${done.length ? `<h4 class="hint" style="margin:22px 0 8px;font-size:14px">Finished, not looked at yet</h4><div class="board">${done.slice(0, 12).map(card).join("")}</div>` : ""}</div>`;
  const box = $("dbody");
  if (box._board !== html) { box.innerHTML = html; box._board = html; }
  bodySig = "board"; headSig = "";
  $("tTitle").textContent = "Terminal";
}

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
async function sendMessage(text, fromEl) {
  const key = S.sel;
  const r = S.rows.get(key);
  if (!text || !r) return;
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
$("composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage($("cText").value.trim(), $("cText")); });
$("reply").addEventListener("submit", (e) => { e.preventDefault(); sendMessage($("replyText").value.trim(), $("replyText")); });
for (const [id, form] of [["cText", "composer"], ["replyText", "reply"]]) {
  $(id).addEventListener("input", (e) => { autosize(e.target); if (S.sel) S.drafts.set(S.sel, e.target.value); });
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isPhone()) { e.preventDefault(); $(form).requestSubmit(); }
    if (e.key === "Escape") e.target.blur();
  });
}
$("cRecipe").onclick = (e) => openRecipeMenu(e.currentTarget);
$("cStop").onclick = () => S.sel && api("/api/keys", { key: S.sel, keys: ["esc"] }).then(() => toast("Sent Esc to interrupt")).catch((x) => toast(x.message, true));
function focusReply() {
  if (isPhone()) { if (app.dataset.mview !== "detail") { history.replaceState({ mview: "detail" }, ""); setMView("detail", false); } }
  else if (S.tpos === "tab" && S.main === "term") setMain("chat");
  if (S.tab !== "chat") { S.tab = "chat"; store("tab2", S.tab); renderDetail(); }
  S.board = false;
  $("cText").focus();
}

// ── terminal ─────────────────────────────────────────────────────────────
let termTimer = null, termText = "", termHash = "", typing = false;
const termVisible = () => (isPhone() ? app.dataset.mview === "term" : S.tpos === "none" ? false : S.tpos === "tab" ? S.main === "term" : !app.classList.contains("term-off"));
const showTerminal = () => setTpos(load("lastTpos", "bottom"));
async function pollTerm(first) {
  clearTimeout(termTimer);
  const key = S.sel;
  if (!key || !S.rows.has(key)) return;
  const r = S.rows.get(key);
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
  const r = S.rows.get(S.sel);
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
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-deck-token": S.token }, body: JSON.stringify(body) });
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
  const all = keys.map((k) => S.rows.get(k)).filter(Boolean);
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
function setBoard(on) { S.board = on; headSig = ""; bodySig = ""; if (on && isPhone()) setMView("detail", true); render(); syncUrl(); if (!on) chatTick(true); }

async function sendRecipe(recipe, keys = targets()) {
  const rows = keys.map((k) => S.rows.get(k)).filter((r) => r && !r.app && r.agent !== "shell" && (!recipe.agents || recipe.agents.includes(r.agent)));
  if (!rows.length) return toast("No agent session to send that to", true);
  if (rows.length > 1 && !confirm(`Send “${recipe.label}” to ${rows.length} sessions?`)) return;
  try {
    const { results } = await api("/api/recipe", { keys: rows.map((r) => r.key), prompt: recipe.prompt });
    const bad = results.filter((x) => !x.ok);
    toast(bad.length ? `Sent to ${results.length - bad.length}; ${bad.length} failed: ${bad[0].error}` : rows.length === 1 ? `Sent “${recipe.label}”` : `Sent “${recipe.label}” to ${rows.length} sessions`, !!bad.length);
    setTimeout(() => { pollTerm(); chatTick(true); }, 300);
  } catch (e) { toast(e.message, true); }
}
function openRecipeMenu(anchor) {
  const n = targets().length;
  if (!n) return toast("Pick a session first");
  const items = S.recipes.map((r) => ({ html: `${esc(r.label)}${r.hint ? `<small>${esc(r.hint)}</small>` : ""}`, run: () => sendRecipe(r) }));
  items.push("-", { html: "Edit recipes…", run: openRecipesEditor });
  openMenu(anchor, items, n > 1 ? `Send to ${n} selected sessions` : "Send to this session");
}
function openRecipesEditor() {
  const list = $("recList");
  const row = (r = {}) => `<div class="r"><input placeholder="Name" value="${esc(r.label ?? "")}" data-f="label"><button type="button" class="btn ghost" data-del>Remove</button><textarea placeholder="Prompt" data-f="prompt">${esc(r.prompt ?? "")}</textarea><input placeholder="One-line hint (optional)" value="${esc(r.hint ?? "")}" data-f="hint" style="grid-column:1/-1"><input type="hidden" value="${esc(r.id ?? "")}" data-f="id"><input type="hidden" value="${esc((r.agents ?? []).join(","))}" data-f="agents"></div>`;
  list.innerHTML = S.recipes.map(row).join("");
  $("recAdd").onclick = () => { list.insertAdjacentHTML("beforeend", row()); list.lastElementChild.querySelector("input").focus(); };
  list.onclick = (e) => { if (e.target.closest("[data-del]")) e.target.closest(".r").remove(); };
  const d = $("recipesDlg");
  d.returnValue = "";
  d.onclose = async () => {
    if (d.returnValue !== "ok") return;
    const recipes = [...list.querySelectorAll(".r")].map((el) => {
      const v = (f) => el.querySelector(`[data-f="${f}"]`).value.trim();
      return { id: v("id") || undefined, label: v("label"), prompt: v("prompt"), hint: v("hint") || undefined, agents: v("agents") ? v("agents").split(",") : undefined };
    });
    try { S.recipes = (await api("/api/recipes", { recipes })).recipes; toast("Recipes saved"); } catch (e) { toast(e.message, true); }
  };
  d.showModal();
}

let menuEl = null;
function openMenu(anchor, items, heading) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "menu";
  menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = (heading ? `<div class="mh">${esc(heading)}</div>` : "") + items.map((it, i) => it === "-" ? "<hr>" : `<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}${it.on ? " on" : ""}">${it.html}</button>`).join("");
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const h = menuEl.offsetHeight, w = menuEl.offsetWidth;
  menuEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
  menuEl.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  menuEl.onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b) return; const it = items[Number(b.dataset.i)]; closeMenu(); it.run(); };
  menuEl.querySelector("button")?.focus();
  menuEl.addEventListener("keydown", (e) => {
    const bs = [...menuEl.querySelectorAll("button")];
    const i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    if (e.key === "Escape") { closeMenu(); anchor.focus?.(); }
  });
}
function closeMenu() { menuEl?.remove(); menuEl = null; }
addEventListener("pointerdown", (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
function moreMenu(anchor) {
  const r = S.rows.get(S.sel);
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
    { html: "Copy folder path", run: () => copy(r.cwd, "path") },
    { html: "Rename tab…", run: () => { const label = prompt("New tab name", r.tab || r.title); if (label != null) api("/api/rename", { key: r.key, label }).then(() => toast("Renamed")).catch((x) => toast(x.message, true)); } },
    { html: briefBusy.has(r.key) ? "Writing brief…" : "Write or rewrite the brief", run: () => writeBrief(r.key) },
    !isPhone() && { html: "Type into the terminal", run: () => focusTerminal() },
    !isPhone() && { html: `Move the terminal…<small>Now: ${TPOS_NAME[S.tpos].toLowerCase()}</small>`, run: () => layoutMenu(anchor) },
    "-",
    { html: "Close session…", danger: true, run: () => askClose([r.key]) },
  ].filter(Boolean));
}
function settingsMenu(anchor) {
  openMenu(anchor, [
    { html: `Theme: ${document.documentElement.dataset.theme || "system"}<small>Switch light / dark</small>`, run: toggleTheme },
    { html: `Alerts: ${S.notify ? "on" : "off"}<small>When an agent finishes or needs input</small>`, run: toggleAlerts },
    { html: `Auto briefs: ${S.autoBrief ? "on" : "off"}<small>Write a brief when you open a session</small>`, run: () => { S.autoBrief = !S.autoBrief; store("autoBrief", S.autoBrief); toast(`Auto briefs ${S.autoBrief ? "on" : "off"}`); } },
    !isPhone() && { html: `Terminal: ${TPOS_NAME[S.tpos].toLowerCase()}<small>Move it (\\)</small>`, run: () => layoutMenu(anchor) },
    { html: "Close candidates<small>Select empty, duplicate and week-old sessions</small>", run: suggestClose },
    { html: "Edit recipes…", run: openRecipesEditor },
    !isPhone() && { html: "Keyboard shortcuts", run: () => $("help").showModal() },
  ].filter(Boolean));
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = cur === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  store("theme", next);
}
async function toggleAlerts() {
  if (!("Notification" in window)) return toast("This browser can’t show notifications", true);
  if (!S.notify && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return toast("Notifications are blocked for this page", true);
  S.notify = !S.notify; store("notify", S.notify); toast(`Alerts ${S.notify ? "on" : "off"}`);
}
function suggestClose() {
  const WEEK = 7 * 86400000;
  const old = (r) => r.lastActiveAt && Date.now() - r.lastActiveAt > WEEK;
  const c = [...S.rows.values()].filter(inScope).filter((r) => !r.app && (r.empty || r.duplicate || old(r)) && r.status !== "working" && r.status !== "blocked");
  const seen = new Set(), pick = [];
  for (const r of c.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))) {
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
  const rc = S.recipes.find((x) => x.id === "status") ?? { label: "Status", prompt: "In one line: what are you working on, and what's left?" };
  await sendRecipe(rc, rows.map((r) => r.key));
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
  const cur = S.rows.get(S.sel);
  const n = targets().length;
  const sessions = [...S.rows.values()].map((r) => ({ r, s: fuzzy(`${r.title} ${r.project} ${r.launch ?? ""} ${paneName(r)} ${machineLabel(r.machine)} ${r.agent} ${r.branch ?? ""}`, q) }))
    .filter((x) => x.s).sort((a, b) => b.s - a.s || (b.r.lastActiveAt ?? 0) - (a.r.lastActiveAt ?? 0)).slice(0, q ? 8 : 5);
  if (sessions.length) out.push({ head: q ? "Sessions" : "Recent sessions" }, ...sessions.map(({ r }) => ({
    html: `<span class="dot" style="--c:${statusVar(r.status)}"></span><span>${esc(r.title || r.agent)} <span class="hint">${paneTag(r)}</span></span><small>${esc(r.project)}${multiMachine() ? " · " + esc(machineLabel(r.machine)) : ""} · ${esc(ago(r.lastActiveAt) || STATUS_NAME[r.status])}</small>`,
    run: () => { if (!inScope(r)) setMachine("all"); S.view = "inbox"; select(r.key, { scroll: true, open: true }); },
  })));
  if (n) {
    const recipes = S.recipes.map((rc) => ({ rc, s: fuzzy(`${rc.label} ${rc.hint ?? ""} recipe send`, q) })).filter((x) => x.s).slice(0, q ? 6 : 4);
    if (recipes.length) out.push({ head: n > 1 ? `Send to ${n} selected` : `Send to “${cur?.title ?? "session"}”` }, ...recipes.map(({ rc }) => ({ html: `<span>${esc(rc.label)}</span><small>${esc(rc.hint ?? "")}</small>`, run: () => sendRecipe(rc) })));
  }
  const cmds = [
    { t: "New session", k: "n", run: openNew },
    { t: "Live board: everything working right now", k: "l", run: () => setBoard(true) },
    cur && { t: "Message this session", k: "r", run: focusReply },
    cur && !cur.app && { t: "Jump to this pane in herdr", k: "f", run: () => focusPane(cur.key) },
    cur?.app && { t: "Open this thread in the Codex app", run: () => codexAct("codex-open", cur) },
    cur?.app && { t: "Continue this Codex thread in herdr", run: () => codexAct("codex-resume", cur) },
    cur && { t: "Copy a link to this session", k: "y", run: () => copy(linkUrl(cur), "link") },
    cur && { t: "Write or rewrite the brief", k: "b", run: () => writeBrief(cur.key) },
    cur && { t: "Close this session…", k: "x", run: () => askClose([cur.key]) },
    n > 1 && { t: `Close ${n} selected sessions…`, run: () => askClose(targets()) },
    { t: `Group the list by ${S.group === "project" ? "what needs you" : "project"}`, k: "g", run: () => setGroup(S.group === "project" ? "inbox" : "project") },
    ...(!isPhone() ? TPOS.filter((p) => p !== S.tpos).map((p) => ({ t: `Terminal: ${TPOS_NAME[p].toLowerCase()}`, run: () => setTpos(p) })) : []),
    { t: "Standup: ask every idle agent for a status line", run: standup },
    { t: "Select close candidates", run: suggestClose },
    { t: "Close all empty sessions…", run: () => askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)) },
    { t: "Show closed sessions", k: "c", run: () => { S.view = "closed"; render(); } },
    { t: "Edit recipes", run: openRecipesEditor },
    { t: `Turn alerts ${S.notify ? "off" : "on"}`, run: toggleAlerts },
    { t: "Toggle light / dark", run: toggleTheme },
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
function palRun(i = palIndex) { const it = palItems[i]; if (!it || it.head) return; $("palette").close(); it.run(); }
$("palQ").addEventListener("input", renderPalette);
$("palQ").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palMove(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palMove(-1); }
  else if (e.key === "Enter") { e.preventDefault(); palRun(); }
});
$("palList").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) palRun(Number(b.dataset.p)); });
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) $("palette").close(); });

// ── new session ──────────────────────────────────────────────────────────
const KINDS = [["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["shell", "Shell"]];
let newOpts = null, newKind = load("newKind", "claude"), newMachine = null, pendingSelect = null;
let nSel = { model: "", effort: "", mode: "" };
async function loadNewOptions() {
  try { newOpts = await api("/api/new-options", { machine: newMachine }); } catch (e) { newOpts = { recent: [], projects: [], argHints: {}, choices: {} }; toast(e.message, true); }
  const cur = S.rows.get(S.sel);
  const saved = load("newCwd:" + newMachine, "");
  $("nCwd").value = saved || (cur && cur.machine === newMachine ? home(cur.projectRoot ?? cur.cwd) : "") || home(newOpts.recent[0] ?? "");
  $("nCwdList").innerHTML = [...new Set([...newOpts.recent, ...newOpts.projects])].map((p) => `<option value="${esc(home(p))}">`).join("");
  const projRoots = [...new Set([...S.rows.values()].filter((r) => r.machine === newMachine && r.projectRoot).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)).map((r) => r.projectRoot))];
  const recent = [...new Set([...projRoots, ...newOpts.recent])].slice(0, 7);
  $("nCwdSugg").innerHTML = recent.length ? `<span class="hint">Recent:</span>` + recent.map((p) => `<button type="button" data-cwd="${esc(home(p))}" title="${esc(p)}">${esc(p.split("/").pop())}</button>`).join("") : "";
  renderKinds();
}
async function openNew() {
  const cur = S.rows.get(S.sel);
  newMachine = (S.machine !== "all" ? S.machine : cur?.machine) ?? S.self;
  const ms = realMachines();
  if (!ms.some((m) => m.id === newMachine)) newMachine = S.self;
  $("nMachineWrap").hidden = ms.length <= 1;
  $("nMachine").innerHTML = ms.map((m) => `<button type="button" data-m="${esc(m.id)}" aria-pressed="${m.id === newMachine}" ${m.online ? "" : "disabled"}>${esc(m.label)}</button>`).join("");
  $("nPrompt").value = ""; $("nLabel").value = "";
  $("nFocus").checked = load("newFocus", false);
  $("newDlg").showModal();
  renderKinds();
  await loadNewOptions();
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
  if (e.target.closest("[data-secact]")?.dataset.secact === "closeEmpty") { e.stopPropagation(); return askClose([...S.rows.values()].filter(inScope).filter((r) => r.empty).map((r) => r.key)); }
  const sec = e.target.closest("[data-sec]");
  if (sec) {
    const k = sec.dataset.sec;
    if (k.startsWith("p:")) { const p = k.slice(2); S.closedProj = { ...S.closedProj, [p]: !S.closedProj[p] }; store("closedProj", S.closedProj); }
    else { S.closedSecs = { ...S.closedSecs, [k]: !(k === "empty" && S.group === "project" ? S.closedSecs.empty !== false : S.closedSecs[k]) }; store("closedSecs", S.closedSecs); }
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
  select(row.dataset.key, { open: true });
});
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
  const blockEl = e.target.closest("[data-b]");
  if (e.target.closest("[data-copy]") && blockEl) return copyBlocks([blockEl.dataset.b]);
  if (e.target.closest("[data-pick]") && blockEl) return pickBlock(blockEl.dataset.b, e.shiftKey);
  if (chatSel.size && blockEl && !e.target.closest("a, button, [data-toggle]")) return pickBlock(blockEl.dataset.b, e.shiftKey);
  if (e.target.closest("[data-selcopy]")) { copyBlocks([...chatSel]); return clearPicks(); }
  if (e.target.closest("[data-selall]")) { for (const b of chatDom.data ?? []) chatSel.add(b.key); return renderSelBar(); }
  if (e.target.closest("[data-selclear]")) return clearPicks();
  const choose = e.target.closest("[data-choose]");
  if (choose && choose.closest(".choices.pickable")) { const c = choose.closest("[data-choice]"); return sendMessage(`(${c.dataset.choice}) ${c.dataset.title}`, $("cText")); }
  const choice = e.target.closest(".choices.pickable [data-choice]");
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
  const r = S.rows.get(S.sel);
  if (!r) return;
  if (act === "recipes") openRecipeMenu(b);
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
$("selRecipe").onclick = (e) => openRecipeMenu(e.currentTarget);
$("selClose").onclick = () => askClose([...S.picked]);
$("selClear").onclick = () => { S.picked.clear(); render(); };
$("q").addEventListener("input", (e) => { S.q = e.target.value; render(); });
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; S.q = ""; e.target.blur(); render(); }
  if (e.key === "Enter") { const first = S.visible?.[0]; if (first) { select(first.key, { open: true }); e.target.blur(); } }
});
$("paletteBtn").onclick = (e) => { e.preventDefault(); openPalette(); };
$("paletteMini").onclick = () => openPalette();
$("newBtn").onclick = openNew;
$("fitBtn").onclick = () => { S.fit = !S.fit; store("fit", S.fit); fitTerm(); toast(S.fit ? "Fitting the pane’s width" : "Fixed font size"); };
$("listToggle").onclick = () => { app.classList.toggle("list-off"); store("listOff", app.classList.contains("list-off")); lastOrder = ""; $("mini")._h = ""; render(); setTimeout(fitTerm, 0); };
$("termToggle").onclick = () => { app.classList.toggle("term-off"); store("termOff", app.classList.contains("term-off")); pollTerm(); };

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
  if (e.target.matches("input, textarea, select, #screen") || document.querySelector("dialog[open]") || menuEl) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key, cur = S.sel && S.rows.has(S.sel) ? S.sel : null;
  if (k === "/") { e.preventDefault(); if (app.classList.contains("list-off")) $("listToggle").click(); $("q").focus(); $("q").select(); }
  else if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveSel(1); }
  else if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveSel(-1); }
  else if (k === "r" && cur) { e.preventDefault(); focusReply(); }
  else if (k === "." && (cur || S.picked.size)) { e.preventDefault(); openRecipeMenu(document.querySelector('[data-dact="recipes"]') ?? $("cRecipe")); }
  else if (k === "t" && cur) { e.preventDefault(); focusTerminal(); }
  else if (k === "`" && S.tpos === "tab") { e.preventDefault(); setMain(S.main === "chat" ? "term" : "chat"); }
  else if (k === "\\") { e.preventDefault(); setTpos(TPOS[(TPOS.indexOf(S.tpos) + 1) % TPOS.length]); toast(`Terminal: ${TPOS_NAME[S.tpos].toLowerCase()}`); }
  else if (k === "g") setGroup(S.group === "project" ? "inbox" : "project");
  else if (k === "l") setBoard(!S.board);
  else if (k === "n") { e.preventDefault(); openNew(); }
  else if (k === "f" && cur) S.rows.get(cur)?.app ? codexAct("codex-open", S.rows.get(cur)) : focusPane(cur);
  else if (k === "y" && cur) copy(linkUrl(S.rows.get(cur)), "link");
  else if (k === "x" && (S.picked.size || cur)) askClose(targets());
  else if (k === "s" && cur) togglePick(cur);
  else if (k === "b" && cur) writeBrief(cur);
  else if (k === "[") $("listToggle").click();
  else if (k === "]") $("termToggle").click();
  else if (k === "c") { S.view = S.view === "closed" ? "inbox" : "closed"; lastOrder = ""; render(); }
  else if (k === "?") $("help").showModal();
  else if (/^[1-9]$/.test(k)) { const ids = ["all", ...(S.summary.machines ?? []).map((m) => m.id)]; if (ids[k - 1] && ids.length > 2) setMachine(ids[k - 1]); }
  else if (k === "Escape" && chatSel.size) clearPicks();
  else if (k === "Escape") { if (S.sub) { S.sub = null; headSig = ""; chatDom.key = null; renderDetail(); chatTick(true); } else if (S.board) setBoard(false); else if (S.q) { S.q = ""; $("q").value = ""; } else if (S.picked.size) S.picked.clear(); render(); }
});

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
  if (!S.notify || !prev || prev.status === next.status) return;
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
  S.recipes = data.recipes ?? [];
  S.publicUrl = data.publicUrl ?? "";
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
  if (!S.sel || !S.rows.has(S.sel)) {
    S.sel = null;
    const saved = load("sel", null);
    if (saved && S.rows.has(saved) && !isPhone()) return select(saved);
    if (!isPhone()) { S.board = [...S.rows.values()].some((r) => r.status === "working" || r.status === "blocked"); if (!S.board) { const f = visibleRows()[0]; if (f) return select(f.key); } }
  }
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
    for (const r of p.upsert) { notifyTransitions(S.rows.get(r.key), r); S.rows.set(r.key, r); }
    for (const k of p.remove) { S.rows.delete(k); S.details.delete(k); }
    S.summary = p.summary;
    if (pendingSelect && S.rows.has(pendingSelect)) { const k = pendingSelect; pendingSelect = null; select(k, { scroll: true, open: true }); return; }
    if (S.sel && !S.rows.has(S.sel)) { S.sel = null; const next = S.visible?.find((r) => S.rows.has(r.key))?.key; if (next && !isPhone()) return select(next); }
    if (S.sel && p.upsert.some((r) => r.key === S.sel)) chatTick();
    render();
  });
  es.addEventListener("graveyard", (e) => { S.graveyard = JSON.parse(e.data); render(); });
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
if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
{
  const params = new URLSearchParams(location.search);
  if (params.get("status") === "blocked") { S.q = "is:blocked"; $("q").value = S.q; render(); }
  if (params.get("new")) setTimeout(openNew, 50);
  if ([...params.keys()].length) history.replaceState(history.state, "", "/");
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollTerm(); chatTick(true); } });
