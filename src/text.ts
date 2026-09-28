// Small text helpers the wiki and idea files need (Discover's profile, Leads' sources), and JSON from a model's reply
// (Research's planner, Opportunities' generator).
export const slugify = (s: string, n = 48) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, " ").replace(/[_\s-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "");
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = new Map<string, RegExp>();
/** A term matches at the start of a word ("orchestrat" hits "orchestration", "rag" doesn't hit "storage"). */
export function hasTerm(text: string, term: string) {
  let re = termRe.get(term);
  if (!re) { re = new RegExp(`(^|[^a-z0-9])${escRe(term)}`); termRe.set(term, re); }
  return re.test(text);
}

/** YAML front matter: flat `key: value` and `key: [a, b]` only, which is all the wiki and idea files use. */
export function frontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    data[kv[1]] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : v.replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(m[0].length) };
}

function balanced(text: string): string[] {
  const out: string[] = [];
  const stack: number[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push(i);
    else if (c === "}" && stack.length) { const s = stack.pop()!; if (!stack.length) out.push(text.slice(s, i + 1)); }
  }
  return out;
}
const loose = (t: string) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1").replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
function tryJson(t: string): any { try { return JSON.parse(t); } catch { try { return JSON.parse(loose(t)); } catch { return undefined; } } }
/** The first JSON object in a model's reply: code fences, prose around it, trailing commas and bare keys are all forgiven. */
export function repairJson(text: string): any {
  const t = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const whole = tryJson(t);
  if (whole && typeof whole === "object") return whole;
  for (const o of balanced(t)) { const j = tryJson(o); if (j && typeof j === "object") return j; }
  return undefined;
}
