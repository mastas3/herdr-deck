"use strict";
// The terminal: polling the pane, typing into it and ANSI colours. It is the inspector's first tab (inspector.js).
// ── terminal ─────────────────────────────────────────────────────────────
let termTimer = null, termText = "", termHash = "", typing = false;
/** On screen now: the inspector shows its Terminal tab (on the phone, the inspector screen is up). */
const termVisible = () => inspTab() === "term" && (isPhone() ? app.dataset.mview === "term" : app.classList.contains("insp-on"));
const showTerminal = () => openInspector("term");
/** Not on screen (the chat offers to open it). */
const termHidden = () => !termVisible();
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
$("screen").addEventListener("focus", () => { if (isPhone()) return; typing = true; $("tpane").classList.add("typing"); $("tMode").textContent = "Typing into the pane · Ctrl+] to stop"; pollTerm(); });
$("screen").addEventListener("blur", () => { typing = false; $("tpane").classList.remove("typing"); $("tMode").textContent = "Click the screen to type into it"; });
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
