"use strict";
// Formatting: times, sizes, project colours, tool calls in plain words.
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
const DTF = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DF = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const TF = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** A 24-hour HH:MM field. The browser's own time input follows its locale (AM/PM in some), so times are typed as text. */
const time24 = (attrs, v) => `<input type="text" inputmode="numeric" maxlength="5" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" placeholder="HH:MM" autocomplete="off" ${attrs} value="${esc(v ?? "")}">`;
// "7:30", "0730" or "7" becomes "07:30"/"07:00" when you leave the field; anything that isn't a time goes back to what it was.
document.addEventListener("focusin", (e) => { if (e.target.matches?.("input[pattern^='([01]']")) e.target.dataset.was = e.target.value; });
document.addEventListener("focusout", (e) => {
  const el = e.target; if (!el.matches?.("input[pattern^='([01]']")) return;
  const m = el.value.trim().match(/^(\d{1,2}):?(\d{2})$/) || el.value.trim().match(/^(\d{1,2})$/);
  const h = m ? +m[1] : NaN, mi = m ? +(m[2] ?? 0) : NaN;
  const ok = h >= 0 && h < 24 && mi >= 0 && mi < 60;
  const v = ok ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : el.dataset.was ?? "";
  if (v !== el.value) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }
});
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
  // Shared by several extras (Discover, Opportunities, Leads, the Library, project pages, the connections store) and
  // every view's close button, so each keeps its icons while the others are switched off.
  bolt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  bulb: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12.4h4M6.6 14.4h2.8M8 1.7a4.4 4.4 0 0 0-2.6 8c.4.3.6.8.6 1.3v.4h4V11c0-.5.2-1 .6-1.3A4.4 4.4 0 0 0 8 1.7z"/></svg>',
  dice: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="10.4" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5v9l7-4.5z"/></svg>',
  ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h3.2"/></svg>',
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
