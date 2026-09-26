// Autoresearch: reading a research report (front matter + the machine-readable findings), scoring its niches,
// merging them into one ranked leaderboard, and the slop filters that keep generic or unsourced work off it.
import { SCORE_KEYS, clip, overlap, repairJson, slugify, typeOf, words, type Link, type Niche, type QType, type ScoreKey, type Scores } from "./autoresearch-core";

// ── reports: front matter + the machine-readable findings ───────────────────────────────
/** Front matter with flat `key: value`, `key: [a, b]` and one level of indented children (`scores:` → `  demand: 7`). */
export function frontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = String(text ?? "").replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return { data: {}, body: String(text ?? "") };
  const data: Record<string, any> = {};
  let parent: string | undefined;
  const val = (v: string) => {
    v = v.trim().replace(/\s+#.*$/, "");
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (/^\{.*\}$/.test(v)) { const o: Record<string, string> = {}; for (const p of v.slice(1, -1).split(",")) { const kv = p.match(/^\s*["']?([\w-]+)["']?\s*:\s*(.*)$/); if (kv) o[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ""); } return o; }
    return v.replace(/^["']|["']$/g, "");
  };
  for (const line of m[1].split(/\r?\n/)) {
    const child = line.match(/^\s+([\w-]+):\s*(.*)$/);
    if (child && parent) { if (typeof data[parent] !== "object") data[parent] = {}; data[parent][child[1]] = val(child[2]); continue; }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[2].trim() === "") { parent = kv[1]; data[kv[1]] = ""; continue; }
    parent = undefined;
    data[kv[1]] = val(kv[2]);
  }
  return { data, body: String(text).slice(m[0].length) };
}
/** "7", "7/10", "70%", 0.7, "high" → 0..10. */
export function score10(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, Math.min(10, v > 0 && v < 1 ? v * 10 : v)) : undefined;
  const s = String(v).trim().toLowerCase();
  const word: Record<string, number> = { "very high": 9, high: 8, "medium-high": 6.5, medium: 5, moderate: 5, "medium-low": 3.5, low: 2, "very low": 1, none: 0 };
  if (s in word) return word[s];
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (frac) return Math.max(0, Math.min(10, (Number(frac[1]) / Number(frac[2])) * 10));
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%/);
  if (pct) return Math.max(0, Math.min(10, Number(pct[1]) / 10));
  const n = s.match(/^-?\d+(?:\.\d+)?/);
  return n ? score10(Number(n[0])) : undefined;
}
const SCORE_ALIAS: Record<string, ScoreKey> = { demand: "demand", willingness_to_pay: "willingness_to_pay", wtp: "willingness_to_pay", willingness: "willingness_to_pay", pay: "willingness_to_pay", competition: "competition", fit_with_user_assets: "fit_with_user_assets", fit: "fit_with_user_assets", asset_fit: "fit_with_user_assets", timing: "timing", heat: "timing", timing_heat: "timing", confidence: "confidence" };
export function cleanScores(o: any): Scores {
  const out: Scores = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) {
    const key = SCORE_ALIAS[k.toLowerCase().replace(/[\s/-]+/g, "_")];
    const n = score10(v);
    if (key && n != null) out[key] = Math.round(n * 10) / 10;
  }
  return out;
}
const urlOk = (u: unknown) => /^https?:\/\/[^\s<>"']+$/.test(String(u ?? "").trim());
const links = (xs: unknown, n = 12): Link[] => (Array.isArray(xs) ? xs : []).map((x: any) => typeof x === "string" ? (urlOk(x) ? { name: hostOf(x), url: x } : { name: clip(x, 80), url: "" }) : { name: clip(x?.name ?? x?.where ?? x?.label ?? hostOf(x?.url), 80), url: urlOk(x?.url) ? String(x.url).trim() : "" }).filter((l) => l.name).slice(0, n);
export const hostOf = (u: unknown) => { try { return new URL(String(u)).hostname.replace(/^www\./, ""); } catch { return ""; } };
const strs = (xs: unknown, n: number, len = 200) => (Array.isArray(xs) ? xs : typeof xs === "string" && xs ? [xs] : []).map((x: any) => clip(typeof x === "string" ? x : x?.text ?? x?.title ?? x?.pitch ?? x?.name ?? "", len)).filter(Boolean).slice(0, n);

export type ParsedNiche = Omit<Niche, "id" | "rubric" | "score" | "jev" | "runs" | "seen" | "firstAt" | "updatedAt">;
export type Report = {
  ok: boolean; error?: string;
  question: string; type?: QType; date?: string; verdict: string; title: string; summary: string;
  scores: Scores; niches: ParsedNiche[]; openQuestions: string[]; opportunities: string[]; links: string[];
};
/** The JSON findings block: the last fenced ```json block (or a bare object) with a "niches" key. */
export function findingsJson(body: string): any {
  const blocks = [...String(body ?? "").matchAll(/```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) { const j = repairJson(b); if (j && typeof j === "object" && ("niches" in j || "opportunities" in j)) return j; }
  const j = repairJson(body.slice(body.search(/\{\s*"niches"/)));
  return j && typeof j === "object" && "niches" in j ? j : undefined;
}
export function parseNiche(x: any, fallbackScores: Scores = {}): ParsedNiche | undefined {
  const name = clip(x?.name ?? x?.niche ?? x?.title, 90);
  if (!name) return undefined;
  const pains = (Array.isArray(x?.pains) ? x.pains : []).map((p: any) => typeof p === "string" ? { quote: clip(p, 240), url: "" } : { quote: clip(p?.quote ?? p?.text ?? p?.pain, 240), url: urlOk(p?.url) ? String(p.url).trim() : "" }).filter((p: any) => p.quote).slice(0, 8);
  const competitors = (Array.isArray(x?.competitors) ? x.competitors : []).map((c: any) => typeof c === "string" ? { name: clip(c, 60), url: "" } : { name: clip(c?.name, 60), url: urlOk(c?.url) ? String(c.url).trim() : "", price: c?.price ? clip(c.price, 40) : undefined, gap: c?.gap ? clip(c.gap, 160) : undefined }).filter((c: any) => c.name).slice(0, 10);
  const where = links(x?.where ?? x?.channels ?? x?.communities ?? (Array.isArray(x?.audiences) ? x.audiences.flatMap((a: any) => a?.where ?? []) : []), 10);
  const audience = clip(x?.audience ?? (Array.isArray(x?.audiences) ? x.audiences.map((a: any) => (typeof a === "string" ? a : a?.who)).filter(Boolean).join("; ") : ""), 200);
  const evidence = [...new Set([...(Array.isArray(x?.evidence) ? x.evidence : []), ...pains.map((p: any) => p.url), ...where.map((w) => w.url), ...competitors.map((c: any) => c.url)].filter(urlOk).map((u: string) => u.trim()))].slice(0, 30);
  const scores = { ...fallbackScores, ...cleanScores(x?.scores ?? x) };
  return {
    name, summary: clip(x?.summary ?? x?.pitch ?? x?.description, 280), whyNow: clip(x?.why_now ?? x?.whyNow ?? x?.timing_reason, 240), audience,
    where, pains, competitors, prices: strs(x?.price_points ?? x?.prices ?? x?.pricing, 6, 80), opportunities: strs(x?.opportunities ?? x?.ideas, 5), evidence, scores,
  };
}
/** Parses a research report. `ok` needs front matter with a question, a verdict and at least four numeric scores. */
export function parseReport(text: string): Report {
  const { data, body } = frontmatter(text);
  const scores = cleanScores({ ...(typeof data.scores === "object" && !Array.isArray(data.scores) ? data.scores : {}), ...Object.fromEntries(Object.entries(data).filter(([k]) => SCORE_ALIAS[k.toLowerCase()])) });
  const title = clip(body.match(/^#\s+(.+)$/m)?.[1] ?? data.question ?? "", 120);
  const summary = clip(body.replace(/```[\s\S]*?```/g, "").replace(/^#.*$/gm, "").split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !/^(\||---|- |\* |\d+\. |>)/.test(x)) ?? "", 420);
  const j = findingsJson(body);
  let niches = (Array.isArray(j?.niches) ? j.niches : []).map((x: any) => parseNiche(x, scores)).filter(Boolean) as ParsedNiche[];
  const allLinks = [...new Set([...body.matchAll(/https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g)].map((m) => m[0]))];
  const rep: Report = {
    ok: false, question: clip(data.question, 300), type: typeOf(data.type), date: data.date ? clip(data.date, 20) : undefined, verdict: clip(data.verdict, 200), title, summary,
    scores, niches: [], openQuestions: strs(j?.open_questions ?? j?.openQuestions, 8, 240), opportunities: strs(j?.opportunities, 8, 240), links: allLinks.slice(0, 200),
  };
  // No findings block: the report's own scores still describe one niche, named by its title.
  if (!niches.length && title && Object.keys(scores).length >= 4) niches = [{ name: clip(data.niche ?? title, 90), summary, whyNow: "", audience: "", where: [], pains: [], competitors: [], prices: [], opportunities: rep.opportunities.slice(0, 3), evidence: allLinks.slice(0, 12), scores }];
  rep.niches = niches.slice(0, 8);
  if (!Object.keys(data).length) rep.error = "no front matter";
  else if (!rep.question) rep.error = "front matter has no question";
  else if (!rep.verdict) rep.error = "front matter has no verdict";
  else if (Object.keys(scores).length < 4) rep.error = `front matter has ${Object.keys(scores).length} of the 6 scores`;
  rep.ok = !rep.error;
  return rep;
}

// ── the evaluator: a rubric, Jev, and one ranked leaderboard ───────────────────────────
/** 0..100 from the 0..10 scores. Competition counts against; thin evidence and low confidence discount it. */
export function rubric(s: Scores, evidenceLinks = 0) {
  const g = (k: ScoreKey, d = 5) => s[k] ?? d;
  const base = 0.25 * g("demand") + 0.22 * g("willingness_to_pay") + 0.18 * g("fit_with_user_assets") + 0.15 * g("timing") + 0.2 * (10 - g("competition"));
  const conf = 0.6 + 0.04 * g("confidence", 5);
  const ev = Math.min(1, 0.75 + 0.025 * evidenceLinks);
  return Math.round(base * 10 * conf * ev);
}
/** The final score: the rubric, blended with Jev's probability (≥10 paying customers in 60 days) when there is one. */
export const combined = (rub: number, jev?: number) => (jev == null ? rub : Math.round(0.65 * rub + 0.35 * 100 * Math.max(0, Math.min(1, jev))));
export const nicheId = (name: string) => slugify(words(name).slice(0, 6).join(" "), 48) || slugify(name, 48) || "niche";
/** Two niche names are the same niche when their words mostly overlap, or one contains the other. */
export function sameNiche(a: string, b: string) {
  const A = words(a).join(" "), B = words(b).join(" ");
  if (!A || !B) return false;
  if (A === B || (A.length >= 8 && B.includes(A)) || (B.length >= 8 && A.includes(B))) return true;
  return overlap(a, b) >= 0.5;
}
const uniqBy = <T>(xs: T[], key: (x: T) => string, n: number) => { const seen = new Set<string>(); return xs.filter((x) => { const k = key(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, n); };
/** Adds one run's niches to the leaderboard: duplicates merge (scores averaged, evidence unioned), then everything is re-ranked. */
export function mergeNiches(board: Niche[], incoming: (ParsedNiche & { jev?: number })[], runN: number, now: number): { board: Niche[]; ids: string[] } {
  const out = board.map((n) => ({ ...n }));
  const ids: string[] = [];
  for (const x of incoming) {
    const hit = out.find((n) => sameNiche(n.name, x.name));
    if (!hit) {
      const id = (() => { let id = nicheId(x.name), i = 2; while (out.some((n) => n.id === id)) id = `${nicheId(x.name)}-${i++}`; return id; })();
      const rub = rubric(x.scores, x.evidence.length);
      out.push({ ...x, id, rubric: rub, jev: x.jev, score: combined(rub, x.jev), runs: [runN], seen: 1, firstAt: now, updatedAt: now });
      ids.push(id);
      continue;
    }
    const w = hit.seen;
    const scores: Scores = { ...hit.scores };
    for (const k of SCORE_KEYS) {
      const a = hit.scores[k], b = x.scores[k];
      if (b != null) scores[k] = a == null ? b : Math.round(((a * w + b) / (w + 1)) * 10) / 10;
    }
    Object.assign(hit, {
      scores, seen: w + 1, updatedAt: now, runs: [...new Set([...hit.runs, runN])],
      summary: x.summary || hit.summary, whyNow: x.whyNow || hit.whyNow, audience: hit.audience || x.audience,
      where: uniqBy([...hit.where, ...x.where], (l) => l.url || l.name, 12), pains: uniqBy([...hit.pains, ...x.pains], (p) => p.url || p.quote, 10),
      competitors: uniqBy([...hit.competitors, ...x.competitors], (c) => c.name.toLowerCase(), 12), prices: uniqBy([...hit.prices, ...x.prices], (s) => s, 8),
      opportunities: uniqBy([...hit.opportunities, ...x.opportunities], (s) => s, 6), evidence: uniqBy([...hit.evidence, ...x.evidence], (s) => s, 40),
      jev: x.jev ?? hit.jev,
    });
    hit.rubric = rubric(hit.scores, hit.evidence.length);
    hit.score = combined(hit.rubric, hit.jev);
    ids.push(hit.id);
  }
  out.sort((a, b) => b.score - a.score || b.seen - a.seen || a.firstAt - b.firstAt);
  return { board: out.slice(0, 60), ids: [...new Set(ids)] };
}
/** Keep a run when it put a niche in the top 10 with a real score, or raised one already there; otherwise discard it. */
export const KEEP_MIN = 50;
export function keepRun(before: Niche[], after: Niche[], ids: string[], min = KEEP_MIN) {
  const top = after.slice(0, 10);
  return ids.some((id) => {
    const n = top.find((x) => x.id === id);
    if (!n || n.score < min) return false;
    const was = before.find((x) => x.id === id);
    return !was || n.score > was.score || n.evidence.length > was.evidence.length;
  });
}

// ── slop filters: only niches with a named buyer, a place, a real price and linked pains reach the board ─────────
const GENERIC = new Set(words("ai tool tools platform app apps solution solutions creator business businesses people user everyone anyone service services product products content marketing assistant startup startups company companies brand brands online digital smart powered"));
const BUZZ = /\b(for everyone|all-in-one|one-stop|super ?app|revolutioni[sz]\w*|game[- ]chang\w*|next[- ]gen\w*|cutting[- ]edge|seamless\w*|unlock\w* (the|your) (power|potential)|leverag\w+ (ai|the power)|fast-paced|ever-evolving|rapidly evolving|landscape of)\b/gi;
const specific = (s: string) => words(s).some((w) => !GENERIC.has(w));
const priced = (s: string) => /[$€£₪¥]\s?\d|\d\s?(usd|eur|ils|\/mo|\/month|\/yr|per month|a month)/i.test(s);
/** Why a niche can't go on the leaderboard (empty when it can). */
export function nicheProblems(n: ParsedNiche): string[] {
  const out: string[] = [];
  if (!specific(n.name) || (n.name.match(BUZZ) ?? []).length) out.push("buzzword niche, no specific product or job");
  if (!n.audience || !specific(n.audience)) out.push("no named buyer");
  if (!n.where.some((w) => w.url)) out.push("no linked place where the buyers gather");
  if (![...n.prices, ...n.competitors.map((c) => c.price ?? "")].some(priced)) out.push("no price observed in the market");
  if (!n.pains.some((p) => p.url)) out.push("no linked pains");
  return out;
}
/** Why a whole report is discarded: too few sources behind it, or written in generic filler. */
export function reportProblems(rep: Report, body: string): string[] {
  const out: string[] = [];
  const hosts = new Set(rep.links.map(hostOf).filter((h) => h && h !== "example.com"));
  if (rep.links.length < 5 || hosts.size < 2) out.push(`unsourced: ${rep.links.length} link${rep.links.length === 1 ? "" : "s"} from ${hosts.size} site${hosts.size === 1 ? "" : "s"}`);
  const buzz = [...new Set((body.match(BUZZ) ?? []).map((x) => x.toLowerCase()))];
  if (buzz.length >= 3) out.push(`generic language (${buzz.slice(0, 4).join(", ")})`);
  return out;
}
