// Tolerant JSON for model replies: fences, prose around the JSON, smart quotes, trailing commas, a reply cut off
// mid-array (every complete object before the cut is kept), and bare arrays vs {"key": [...]}. Never throws.

/** Strip code fences and prose; normalize quotes that models (and Markdown renderers) curl. */
function clean(text: string) {
  return String(text ?? "").replace(/```(?:json|JSON)?/g, "").replace(/[“”]/g, '"').trim();
}
const noTrailing = (t: string) => t.replace(/,\s*([}\]])/g, "$1");
/** Typos models make in keys: a doubled closing quote (`"flaw"":`) or a missing comma between objects (`}{`). */
// Hebrew acronyms use a double quote (ע"י, ש"ח); inside a JSON string that ends the string, so it becomes gershayim (״).
const fixTypos = (t: string) => t.replace(/"{2}\s*:/g, '":').replace(/}\s*{/g, "},{").replace(/([\u0590-\u05FF])"([\u0590-\u05FF])/g, "$1\u05F4$2");
/** A reply cut off mid-way: close the open string, arrays and objects so what arrived still parses. */
export function closeTruncated(t: string): string {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (const c of t) {
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if ((c === "}" || c === "]") && stack.length) stack.pop();
  }
  return `${t}${inStr ? '"' : ""}${stack.reverse().join("")}`;
}
/** Parse, then retry without trailing commas, with key typos fixed and with bare newlines inside strings escaped. */
function tryParse(t: string): any {
  for (const f of [(x: string) => x, noTrailing, (x: string) => noTrailing(fixTypos(x)), (x: string) => noTrailing(fixTypos(escapeNewlinesInStrings(x)))]) {
    try { return JSON.parse(f(t)); } catch {}
  }
  return undefined;
}
function escapeNewlinesInStrings(t: string) {
  let out = "", inStr = false, esc = false;
  for (const c of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      else if (c === "\n") { out += "\\n"; continue; }
      else if (c === "\r") continue;
    } else if (c === '"') inStr = true;
    out += c;
  }
  return out;
}
/** Complete, balanced {...} spans (string-aware), in order of their start. */
function objectSpans(text: string): { s: number; e: number; depth: number }[] {
  const found: { s: number; e: number; depth: number }[] = [];
  const stack: number[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push(i);
    else if (c === "}" && stack.length) { const s = stack.pop()!; found.push({ s, e: i + 1, depth: stack.length }); }
  }
  return found.sort((a, b) => a.s - b.s);
}
/** The whole reply as JSON when it parses (outermost object or array). */
export function parseLoose(text: string): any {
  const t = clean(text);
  const a = [t.indexOf("{"), t.indexOf("[")].filter((x) => x >= 0);
  if (!a.length) return undefined;
  const start = Math.min(...a);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return (end > start ? tryParse(t.slice(start, end + 1)) : undefined) ?? tryParse(closeTruncated(fixTypos(t.slice(start))));
}
/**
 * The list of records in a reply: `[...]`, `{"<key>": [...]}` or the first array value; when the reply is broken
 * or cut off, every complete object that has one of `mustHave` keys (the shallowest ones, not their nested parts).
 */
export function extractRecords(text: string, keys: string[] = [], mustHave: string[] = []): any[] {
  const whole = parseLoose(text);
  const pick = (j: any): any[] | undefined => {
    if (Array.isArray(j)) return j;
    if (j && typeof j === "object") {
      for (const k of keys) if (Array.isArray(j[k])) return j[k];
      if (mustHave.some((k) => k in j)) return [j];
      const arr = Object.values(j).find(Array.isArray);
      if (arr) return arr as any[];
    }
    return undefined;
  };
  const got = pick(whole);
  if (got?.length) return got.filter((x) => x && typeof x === "object");
  const t = fixTypos(clean(text));
  const out: any[] = [];
  let covered = -1;
  for (const { s, e } of objectSpans(t)) {
    if (s < covered) continue;
    const j = tryParse(t.slice(s, e));
    if (!j || typeof j !== "object" || Array.isArray(j)) continue;
    if (mustHave.length && !mustHave.some((k) => k in j)) continue;
    out.push(j); covered = e;
  }
  return out;
}
// ── field coercion ─────────────────────────────────────────────────────────────────────────
export const str = (v: unknown, n = 400): string => {
  const t = (typeof v === "string" ? v : v == null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t;
};
export const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const m = String(v ?? "").match(/-?\d+(?:\.\d+)?/);
  const x = m ? Number(m[0]) : NaN;
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : dflt;
};
export const list = (v: unknown, n = 8, each = 200): string[] => {
  const xs = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n|;\s*|(?<=\S)\s+(?=\d+[.)]\s)/) : [];
  return xs.map((x) => str(typeof x === "string" ? x.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "") : (x as any)?.title ?? (x as any)?.name ?? (x as any)?.text ?? x, each)).filter(Boolean).slice(0, n);
};
