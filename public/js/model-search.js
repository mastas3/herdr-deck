"use strict";
// Pure helpers for the model picker (no DOM, so a test runs this whole file): search and ranking, highlight marks,
// the recent list, finding the chosen model, and the labels on a row.
const MODEL_MAX_ROWS = 60;
const MODEL_RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const modelEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const modelWords = (q) => String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
const modelStart = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(MODEL_RE_SPECIAL, "\\$&")}`);
/** How well one word matches a model: 3 a name prefix, 2 a word start in the name or ID, 1 anywhere in either, 0 not at all. */
function modelWordScore(name, id, w, start) {
  if (name.startsWith(w)) return 3;
  if (start.test(name) || start.test(id)) return 2;
  return name.includes(w) || id.includes(w) ? 1 : 0;
}
/** The best `max` models for a query (every word must match), and how many matched in all. Ties keep the list's order. */
function modelSearch(models, query, max = MODEL_MAX_ROWS) {
  const words = modelWords(query);
  if (!words.length) return { rows: models.slice(0, max), total: models.length };
  const starts = words.map(modelStart), exact = words.join(" "), hits = [];
  models.forEach((m, i) => {
    const name = (m.l ?? "").toLowerCase(), id = m.v.toLowerCase();
    let score = id === exact ? 10 : 0;
    for (let k = 0; k < words.length; k++) { const s = modelWordScore(name, id, words[k], starts[k]); if (!s) return; score += s; }
    hits.push({ m, i, score });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return { rows: hits.slice(0, max).map((h) => h.m), total: hits.length };
}
/** `text` as safe HTML with every match of a query word wrapped in <mark>. */
function modelMarks(text, query) {
  const t = String(text ?? ""), low = t.toLowerCase(), spans = [];
  for (const w of modelWords(query)) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) spans.push([i, i + w.length]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) { const last = merged[merged.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([s[0], s[1]]); }
  let out = "", at = 0;
  for (const [a, b] of merged) { out += `${modelEsc(t.slice(at, a))}<mark>${modelEsc(t.slice(a, b))}</mark>`; at = b; }
  return out + modelEsc(t.slice(at));
}
/** The recent list after choosing `value`: newest first, no duplicates, at most `max`. */
const modelRecent = (list, value, max = 5) => (value ? [value, ...list.filter((x) => x !== value)].slice(0, max) : list);
/** The chosen model and its provider, or null when it isn't offered (a saved model that has since gone). */
function modelFind(providers, v) {
  if (!v) return null;
  for (const p of providers) { const m = p.models.find((x) => x.v === v); if (m) return { m, p }; }
  return null;
}
const modelCtx = (n) => (!(n > 0) ? "" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const modelMoney = (n) => `$${+n.toFixed(n < 1 ? 3 : 2)}`;
const modelPrice = (p) => (p ? `${modelMoney(p.in)} / ${modelMoney(p.out)}` : "");
/** The small labels under a model's name. A detail the source didn't give is skipped. */
function modelBadges(m) {
  const b = [];
  if (m.ctx) b.push({ k: "ctx", t: modelCtx(m.ctx), title: "Context window" });
  if (m.free) b.push({ k: "free", t: "Free" });
  else if (m.price) b.push({ k: "price", t: modelPrice(m.price), title: "USD per million tokens (input / output)" });
  if (m.reasoning || m.efforts?.length) b.push({ k: "reason", t: m.efforts?.length ? `Reasoning: ${m.efforts.join(", ")}` : "Reasoning" });
  if (m.note) b.push({ k: "note", t: m.note });
  return b;
}
