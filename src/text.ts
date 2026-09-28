// Small text helpers the wiki and idea files need (Discover's profile, Leads' sources).
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
