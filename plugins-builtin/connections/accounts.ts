// Accounts: one card per social network or site you have, merging every sign of it (a saved login's site name,
// a desktop app, API key NAMES, an MCP server, a CLI, or an account you added with your handle). And the
// "Recommended for you" row: services you don't have yet, ranked by how well they fit your projects.
// Pure functions over what the scanner found; the scanner (connections.ts) does the I/O.
import type { Item } from "./connections";
import { HOW_LABEL, INTERESTS, RECS, SITES_CATALOG, cardId, registrable, sensitive, siteFor, type Rec, type Site } from "../../src/catalog";
import type { LoginProfile } from "./logins";
import { RECIPES, type Recipe } from "./recipes";

/** An account you added by hand: the catalog id, your public handle or profile URL, and how agents may use it. */
export type Account = { id: string; handle?: string; url?: string; notes?: string; at?: number };
/** What the scanner found for a catalog entry beyond logins: apps, CLIs, key names, MCP servers. */
export type Evidence = { via: string[]; strong: boolean; app: boolean };
export type MergeInput = {
  svc: Item[]; // the scanner's service cards, including ones that are off
  logins: LoginProfile[];
  accounts: Account[];
  evidence?: (s: Site) => Evidence;
};
const ACCOUNT_CATS = new Set(["social", "sites"]);
const NONE: Evidence = { via: [], strong: false, app: false };
const isChrome = (browser: string) => /^Chrome\b/.test(browser);

export const handleText = (h?: string) => { const t = String(h ?? "").trim(); return !t ? "" : /^https?:\/\//.test(t) || t.startsWith("@") || t.includes(".") || t.includes("/") ? t : `@${t}`; };
export function profileUrl(s: Site, a?: Account): string | undefined {
  if (a?.url) return a.url;
  const h = String(a?.handle ?? "").trim().replace(/^@/, "");
  if (!h || !s.profile || /[\s/?#]/.test(h)) return undefined;
  return s.profile.replace("{h}", encodeURIComponent(h));
}

/** Logins grouped by catalog entry, plus the registrable domains nothing in the catalog matches. */
export function groupLogins(logins: LoginProfile[]) {
  const bySite = new Map<string, { where: string[]; chrome: boolean }>();
  const other = new Set<string>();
  for (const p of logins) for (const host of p.hosts) {
    if (sensitive(host)) continue; // the reader drops these already; never trust a single gate
    const s = siteFor(host);
    if (!s) { other.add(registrable(host)); continue; }
    const g = bySite.get(s.id) ?? { where: [], chrome: false };
    if (!g.where.includes(p.label)) g.where.push(p.label);
    g.chrome ||= isChrome(p.browser);
    bySite.set(s.id, g);
  }
  return { bySite, other: [...other].sort() };
}

/**
 * Social and site cards, with every piece of evidence merged into one card each. Catalog entries tied to an
 * existing service card (X, Telegram, GitHub…) reuse its id, so recipes keep matching; social ones move into the
 * Social media category. Returns the service cards (updated, minus the ones that moved), the account cards,
 * and one "Other sites" card for logins the catalog doesn't know (their domains stay in `sites`, never in text).
 */
export function mergeAccounts(inp: MergeInput): { svc: Item[]; accounts: Item[]; other?: Item } {
  const { bySite, other } = groupLogins(inp.logins);
  const mine = new Map(inp.accounts.map((a) => [a.id, a]));
  const svc = new Map(inp.svc.map((i) => [i.id, i]));
  const moved = new Set<string>();
  const accounts: Item[] = [];
  for (const s of SITES_CATALOG) {
    const L = bySite.get(s.id), U = mine.get(s.id);
    const ev = s.apps || s.bins || s.env || s.mcp ? (inp.evidence?.(s) ?? NONE) : NONE;
    const prev = s.svc ? svc.get(s.svc) : undefined;
    const own = !!(L || U || ev.via.length);
    const account = ACCOUNT_CATS.has(s.cat);
    if (!own && !(account && prev && prev.state !== "off")) continue;
    const was = prev?.state && prev.state !== "off" ? prev.state : undefined;
    let state: NonNullable<Item["state"]>;
    if (was) state = was !== "ready" && s.browser && L?.chrome ? "ready" : was;
    else if (ev.strong || (s.browser && L?.chrome)) state = "ready";
    else state = "account";
    const where = L ? `signed in (saved login in ${L.where.join(", ")})` : "";
    const note = [was ? prev!.note : "", U?.handle ? handleText(U.handle) : "", where, !L && ev.app ? "desktop app installed" : "", !L && !ev.app && !was && U ? "added by you" : ""].filter(Boolean).join(" · ");
    const loginVia = (L?.where ?? []).map((w) => `saved login (${w})`);
    const elsewhere = s.browser && L && !L.chrome ? ` Your saved login is in ${L.where.join(", ")}; Claude in Chrome drives Chrome, so sign in there first.` : "";
    const base: Item = prev ? { ...prev } : { id: cardId(s), name: s.name, kind: "account" };
    const card: Item = {
      ...base,
      state, status: state === "ready" ? "ready" : "partial",
      note, site: s.id,
      via: [...new Set([...(was ? prev!.via ?? [] : []), ...ev.via, ...loginVia])],
      logins: L?.where,
      handle: U?.handle || undefined, url: profileUrl(s, U),
      own: U ? { handle: U.handle, url: U.url, notes: U.notes } : undefined,
    };
    if (account) {
      Object.assign(card, { cat: s.cat, group: s.cat, name: s.name, color: s.color, glyph: s.glyph, detail: s.what, connect: s.connect.map(([h, t]) => `${HOW_LABEL[h]}: ${t}`) });
      card.use = (U?.notes || (was && prev?.use) || s.agents) + elsewhere;
      if (!prev) card.kind = "account";
      if (prev) moved.add(prev.id);
      accounts.push(card);
    } else {
      // An existing service card: the login is one more piece of evidence. A login alone doesn't set up the CLI/API.
      if (U?.notes) card.use = U.notes;
      else if (!was) card.use = `${prev?.use ?? ""} You have an account (${[where, U ? "added by you" : ""].filter(Boolean).join(", ")}); it isn't set up for agents on this machine yet.`.trim();
      if (prev) svc.set(prev.id, card);
      else accounts.push({ ...card, cat: s.cat, group: s.cat, color: s.color, detail: s.what || s.name });
    }
  }
  const out = [...svc.values()].filter((i) => !moved.has(i.id));
  const others: Item | undefined = other.length ? {
    id: "sites:other", name: "Other sites", kind: "sites", cat: "sites", group: "sites", state: "ready", status: "ready",
    detail: `${other.length} more site${other.length === 1 ? "" : "s"} with saved logins that aren't in the catalog`,
    note: `${other.length} site${other.length === 1 ? "" : "s"}`, sites: other,
    use: "Sites you have saved logins for (names only). Claude in Chrome can use the ones saved in Chrome; ask before signing in or changing anything.",
  } : undefined;
  return { svc: out, accounts, other: others };
}

// ── adding an account by hand ───────────────────────────────────────────────
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
/** Validate and add (or replace) one of your accounts. Throws with a message the page can show. */
export function upsertAccount(list: Account[], input: any, now = Date.now()): Account[] {
  const id = clean(input?.id, 60);
  if (!SITES_CATALOG.some((s) => s.id === id)) throw new Error("Pick a service from the list");
  const handle = clean(input?.handle, 100);
  if (handle && /\s/.test(handle.replace(/^https?:\/\/\S+$/, ""))) throw new Error("A handle has no spaces");
  const url = clean(input?.url, 300);
  if (url) { let ok = false; try { ok = /^https?:$/.test(new URL(url).protocol); } catch {} if (!ok) throw new Error("The profile link should start with https://"); }
  const notes = clean(input?.notes, 1000);
  const a: Account = { id, ...(handle ? { handle } : {}), ...(url ? { url } : {}), ...(notes ? { notes } : {}), at: now };
  return [...list.filter((x) => x.id !== id), a];
}

// ── recommended for you ─────────────────────────────────────────────────────
/** How strongly the wiki talks about each interest: key → mentions. */
export function interestsFrom(text: string): Map<string, number> {
  const t = text.toLowerCase();
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(INTERESTS)) { const n = t.match(v.re)?.length ?? 0; if (n) out.set(k, n); }
  return out;
}
const weight = (n: number | undefined) => (n ? 2 + Math.min(3, Math.floor(n / 8)) : 0);
export type RecInfo = { why: string; project?: string; free: string; url: string; unlocks: { id: string; title: string }[]; score: number; owns: string[] };

/** True when you already have the service: its card is set up (any state but off), a login matches, or you added it. */
export function owned(rec: Rec, items: Item[], logins: LoginProfile[], accounts: Account[]): boolean {
  const live = new Set(items.filter((i) => i.state !== "off" && i.status !== "off").map((i) => i.id));
  if (rec.owns.some((id) => live.has(id))) return true;
  if (accounts.some((a) => rec.owns.includes(`acct:${a.id}`) || a.id === rec.id)) return true;
  // A saved login for the service, or for any account that covers it (a beehiiv login covers "a newsletter").
  const hosts = logins.flatMap((p) => p.hosts);
  const covered = SITES_CATALOG.filter((s) => rec.owns.includes(cardId(s))).flatMap((s) => s.domains);
  return [...(rec.domains ?? []), ...covered].some((d) => hosts.some((h) => h === d || h.endsWith(`.${d}`)));
}

/** Services worth signing up for: the ones you don't have, best fit to your projects first. */
export function recommend(items: Item[], logins: LoginProfile[], accounts: Account[], wikiText: string, recipes: Recipe[] = RECIPES): Item[] {
  const hits = interestsFrom(wikiText);
  const out: Item[] = [];
  for (const rec of RECS) {
    if (owned(rec, items, logins, accounts)) continue;
    let score = rec.base, best = "", bw = 0;
    for (const k of Object.keys(rec.fit)) { const w = weight(hits.get(k)); score += w; if (w > bw) { bw = w; best = k; } }
    const project = best ? INTERESTS[best].label : undefined;
    const why = best ? `${project}: ${rec.fit[best]}` : rec.why;
    const unlocks = recipes.filter((r) => [...r.needs, ...(r.optional ?? [])].some((n) => n.any.includes(rec.owns[0]))).map((r) => ({ id: r.id, title: r.title }));
    const info: RecInfo = { why, project, free: rec.free, url: rec.url, unlocks, score, owns: rec.owns };
    out.push({ id: `rec:${rec.id}`, name: rec.name, kind: "rec", cat: "recommended", group: rec.cat, color: rec.color, glyph: rec.glyph, state: "off", status: "off", detail: rec.what, note: why, url: rec.url, rec: info, use: `Not set up. Sign up at ${rec.url} (${rec.free}).` });
  }
  return out.sort((a, b) => b.rec!.score - a.rec!.score || a.name.localeCompare(b.name));
}
