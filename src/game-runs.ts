// The game layer: leads for a project (read-only, from Discover → Leads) and runs (an idea turned into a project with
// a business milestone ladder). Pure helpers; the service (game.ts) does the writing.
import type { LadderItem } from "./journey-ai";
import { hash } from "./game-rules";
import type { LeadPost } from "./game-quests";

const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
export const slugify = (s: string, n = 40) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n).replace(/-+$/, "");
/** A link reduced to what identifies it (host without www, path, query): the same lead never counts twice. */
export const normUrl = (u: string) => { try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) return ""; return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`.toLowerCase(); } catch { return ""; } };
export const isUrl = (u: unknown): u is string => typeof u === "string" && !!normUrl(u);

// ── leads ───────────────────────────────────────────────────────────────────────────
export function projectTerms(p: string, j?: { tags?: string[] }, run?: Run): string[] {
  const t = new Set<string>();
  for (const x of p.split(/[-_]+/)) if (x.length >= 4) t.add(x.toLowerCase());
  for (const x of j?.tags ?? []) t.add(String(x).toLowerCase().replace(/[-_]+/g, " "));
  for (const x of [run?.buyer, run?.offer].filter(Boolean) as string[]) for (const w of x.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 5) t.add(w);
  return [...t];
}
const GENERIC = new Set(["reader", "readers", "creator", "creators", "app", "apps", "tool", "tools", "user", "users", "people", "coach", "coaches", "alone", "hate", "work"]);
/** Public posts from the Leads cache (and your saved leads) whose search matches the project, newest first, not yet contacted. */
export function leadsFor(terms: string[], cache: any, saved: any[] = [], exclude = new Set<string>(), max = 6): LeadPost[] {
  const T = terms.map((x) => x.toLowerCase()).filter((x) => !GENERIC.has(x));
  const hit = (kw: string) => !GENERIC.has(kw) && kw.length >= 4 && T.some((t) => t === kw || t.includes(kw) || (kw.includes(" ") && kw.includes(t) && t.length >= 5));
  const posts: LeadPost[] = [];
  // Only posts you can answer on the page itself: App Store reviews can't be replied to by a stranger.
  const push = (q: any, where?: string) => { const url = String(q?.url ?? ""); const n = normUrl(url); if (!n || exclude.has(n) || q.source === "appstore" || n.startsWith("apps.apple.com")) return; posts.push({ id: `l${hash(n)}`, title: clip(q.title || q.snippet, 120), url, where: clip(where ?? q.where?.label ?? q.source ?? "", 40) || undefined, author: q.author ? clip(q.author, 40) : undefined, at: Number(q.at) || undefined, snippet: q.snippet ? clip(q.snippet, 200) : undefined }); };
  for (const e of Object.values<any>(cache?.entries ?? {})) {
    const kws: string[] = (e?.keywords ?? []).map((k: string) => String(k).toLowerCase());
    if (!kws.some(hit) && !T.some((t) => t.length >= 6 && String(e?.text ?? "").toLowerCase().includes(t))) continue;
    for (const th of e.themes ?? []) for (const q of th.quotes ?? []) push(q);
  }
  for (const s of saved) if ([s.text, s.label, s.idea].some((x) => T.some((t) => String(x ?? "").toLowerCase().includes(t)))) for (const q of s.quotes ?? []) push(q);
  const seen = new Set<string>();
  return posts.filter((p) => { const k = normUrl(p.url); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, max);
}

// ── runs: an idea becomes a project with a milestone ladder seeded from it ─────────────────────
export type Run = { id: string; name: string; buyer?: string; offer?: string; price?: string; kit?: string; pitch?: string; createdAt: number; source?: string };
const L = (title: string, source: string, target: number, unit: string, metric: string, tier: number, why?: string): LadderItem => ({ id: slugify(title), title, source, target, unit, metric, tier, why });
export function runLadder(r: Run): LadderItem[] {
  const who = r.buyer ? clip(r.buyer, 40) : "your first users";
  return [
    L("Offer page live", "deploy.live", 1, "deploys", "Live deploys", 0, `A page ${who} can read and buy from`),
    L("First user", "manual.users", 1, "users", "Users", 1, `One of ${who} tries it`),
    L("First paying customer", "manual.paying_customers", 1, "customers", "Paying customers", 2, r.price ? `Someone pays ${r.price}` : "Someone pays"),
    L("10 paying customers", "manual.paying_customers", 10, "customers", "Paying customers", 3),
    L("$100 a month", "manual.mrr", 100, "$", "Monthly revenue", 4),
    L("$1k a month", "manual.mrr", 1000, "$", "Monthly revenue", 5),
  ];
}
/** Whatever the gallery (or anyone) passes: a string or an object with some of name/title, buyer, offer, price, kit. */
export function cleanIdea(idea: any): Run | { error: string } {
  const o = typeof idea === "string" ? { name: idea } : idea && typeof idea === "object" ? idea : {};
  const name = clip(o.name ?? o.title ?? o.label ?? "", 60);
  if (name.length < 2) return { error: "An idea needs a name" };
  const id = slugify(o.slug || name);
  if (!id) return { error: "That name has no letters or digits to make a folder from" };
  const s = (v: unknown, n: number) => (v == null || v === "" ? undefined : clip(v, n));
  return { id, name, buyer: s(o.buyer ?? o.audience ?? o.who, 80), offer: s(o.offer ?? o.product, 120), price: s(o.price, 30), kit: s(o.kit ?? o.starter ?? o.starterKit, 200), pitch: s(o.pitch ?? o.summary ?? o.idea, 200), createdAt: 0, source: s(o.source, 40) };
}
export function runPrompt(r: Run, cwd: string, first: { title: string; why: string }, exists: boolean) {
  const home = cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  const setup = exists ? "" : `Set it up: git init, a README that states the offer, buyer and price in three lines${r.kit ? ", starting from the starter kit above" : ""}.\n`;
  return `${exists ? `This is ${home}, the folder for “${r.name}”.` : `This is a brand-new, empty folder (${home}) for a new business run: “${r.name}”.`}
The idea: ${r.pitch ?? r.name}${r.buyer ? `\nWho buys it: ${r.buyer}` : ""}${r.offer ? `\nThe offer: ${r.offer}` : ""}${r.price ? `\nPrice: ${r.price}` : ""}${r.kit ? `\nStarter kit to build on: ${r.kit}` : ""}

${setup}First quest: ${first.title}. ${first.why}
Build the smallest page that states the offer, the price and a way to buy or join a waitlist. Keep it plain. Run it locally and show me.
Don't post, message, email or buy anything on my behalf, and don't deploy without asking me first. When it's live, add one dated line to ~/wiki/log.md saying it shipped and where.`;
}
/** A run's folder may only be created directly inside the projects folder, with a plain name. */
export function runFolderOk(cwd: string, projectsDir: string) {
  const base = projectsDir.replace(/\/+$/, ""), c = String(cwd ?? "").replace(/\/+$/, "");
  return c.startsWith(`${base}/`) && /^[a-z0-9][a-z0-9-]{0,59}$/.test(c.slice(base.length + 1));
}
