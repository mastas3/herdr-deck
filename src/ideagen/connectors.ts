// Missing connectors: what an idea needs (capabilities), what the user already has for each, and — for what's
// missing — concrete things to add: a service (from the deck's recommended catalog), a GitHub repo (searched live,
// so it exists), a business to partner with, a prompt pack, or graphics to generate with the codex-image skill.
import { RECS } from "../catalog";
import type { GhRes } from "../discover";
import type { Asset, CapNeed, ConnectorSuggestion, Idea, Inventory } from "./types";
import { CAP } from "./inventory";

const WEB = /\b(web|app|site|dashboard|landing|pwa|portal|page|report viewer|browser)\b/i;
/** The capabilities an idea needs: what it declared, plus what selling it at all requires. */
export function requiredCaps(i: Pick<Idea, "needs" | "price" | "offer" | "mvp">): string[] {
  // Audience caps (Hebrew, Russian) say who it's for; they aren't something to connect.
  const caps = new Set(i.needs.filter((c) => CAP[c] && CAP[c].role !== "audience"));
  if (i.price && !/^free$/i.test(i.price.trim())) caps.add("payments");
  // Anything with a web front needs a host, a landing page, and a way to see the funnel for quest 1.
  if (WEB.test(`${i.offer} ${i.mvp}`)) { caps.add("hosting"); caps.add("landing"); caps.add("analytics"); }
  return [...caps];
}
const KIND_ORDER: Record<string, number> = { project: 0, service: 1, mcp: 2, account: 3, skill: 4, ai: 5 };
/** Infrastructure is only "had" through a real service, account or MCP server; a project or skill that mentions it doesn't count. */
const INFRA = new Set(["payments", "hosting", "db-auth", "email", "newsletter", "analytics", "booking", "social-post", "search-api", "whatsapp", "discord", "telegram-bot", "image-gen", "tts", "llm"]);
/** Owned, ready assets that provide a capability; the idea's own stack first. */
export function haveFor(cap: string, inv: Inventory, stackIds: string[] = []): Asset[] {
  return inv.assets.filter((a) => a.owned && a.ready && a.caps.includes(cap) && a.kind !== "key" && (!INFRA.has(cap) || ["service", "account", "mcp"].includes(a.kind) || stackIds.includes(a.id)))
    .sort((a, b) => Number(stackIds.includes(b.id)) - Number(stackIds.includes(a.id)) || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || b.strength - a.strength);
}

// ── suggestions ───────────────────────────────────────────────────────────────────────────
/** Who to partner with or resell through, by capability: real kinds of businesses, not made-up names. */
const BUSINESS: Record<string, { name: string; why: string; how: string }> = {
  "hd-content": { name: "A certified Human Design analyst", why: "reviews your interpretation copy so readers trust it", how: "offer a revenue share per report in exchange for review and a credit line" },
  "hd-calc": { name: "An established HD reader who sells readings", why: "brings buyers and validates the chart output", how: "white-label the report for them; they sell it to their clients" },
  tenders: { name: "A bid-writing consultant (Israel)", why: "already sells to companies that bid on tenders", how: "refer-a-client deal: they resell your alerts, you send them bid-writing work" },
  "lead-data": { name: "A small B2B lead-gen agency", why: "has the clients and the outreach process", how: "sell them the data or alerts wholesale; they package it for their clients" },
  video: { name: "A small podcast production studio", why: "delivers clips for many shows every week", how: "sell them a studio plan so their editors deliver faster" },
  transcription: { name: "A podcast production studio", why: "needs transcripts and subtitles for every episode", how: "per-episode wholesale price" },
  "fb-archive": { name: "The admin of the group you archive", why: "owns the community and its trust", how: "co-launch; the admin announces it, you split revenue" },
  community: { name: "A paid community owner", why: "has members who already pay", how: "offer it as a member perk in exchange for a share" },
  matching: { name: "A couples coach or dating coach", why: "has clients who want structured compatibility input", how: "coach-branded report, per-client price" },
  divination: { name: "A working tarot reader or astrologer", why: "has an audience and writes the interpretations", how: "they supply the voice/content, you supply the tool; split sales" },
  booking: { name: "A practitioner who already takes paid calls", why: "turns the product into an upsell to a call", how: "affiliate link to their Cal.com page" },
};
/** Prompt packs and templates worth writing first, by capability. */
const PROMPTS: Record<string, string> = {
  "hd-content": "A prompt pack that explains each type/authority/profile in plain language, grounded in hd-atlas cards (cite card ids), with a Hebrew and an English variant",
  llm: "A system prompt with the product's voice, the buyer's words from the linked posts, and refusal rules for anything medical, legal or financial",
  rag: "An answer template that always quotes the source passage and its timestamp or post link",
  tenders: "An extraction prompt that turns a tender PDF into budget, deadline, eligibility and required documents, as JSON",
  video: "A clip-selection prompt: find self-contained 30–60 s moments with a hook in the first 3 s, return timestamps and titles",
  transcription: "A cleanup prompt for transcripts: speaker labels, punctuation, filler removal, keep timestamps",
  matching: "A report template for two charts: 5 plain-language sections, each tied to a specific chart element",
  divination: "A reading template: the spread, each card's meaning in context, one practical takeaway, no fear language",
  "lead-data": "An outreach template in the buyer's language that names their exact problem from the linked posts",
};
export type GhSearch = (args: string[], timeoutMs?: number) => Promise<GhRes>;
/**
 * Libraries per capability: the canonical one (checked with one core-API call) or, when there is none, one GitHub
 * search whose results must mention the searched words. At most `maxSearches` calls per run, cached per capability.
 */
export function createRepoFinder(gh: GhSearch, maxSearches = 8) {
  const cache = new Map<string, ConnectorSuggestion[]>();
  let used = 0;
  const toSug = (x: any): ConnectorSuggestion => ({ type: "repo", name: x.full_name, url: x.html_url, verified: true, why: `${String(x.description ?? "").slice(0, 120)} (${x.stargazers_count}★)`, how: `git clone ${x.clone_url} and wire its smallest example into the MVP` });
  return async (cap: string): Promise<ConnectorSuggestion[]> => {
    const def = CAP[cap];
    if (!def?.lib && !def?.gh) return [];
    if (cache.has(cap)) return cache.get(cap)!;
    if (used >= maxSearches) return [];
    used++;
    let got: ConnectorSuggestion[] = [];
    if (def.lib) {
      const r = await gh([`repos/${def.lib}`], 10_000);
      if (r.ok && r.data?.full_name && !r.data.archived) got = [toSug(r.data)];
    } else {
      const words = def.gh!.toLowerCase().split(/\s+/);
      const r = await gh(["-X", "GET", "search/repositories", "-f", `q=${def.gh} in:name,description stars:>50 archived:false`, "-f", "sort=stars", "-f", "order=desc", "-f", "per_page=5"], 12_000);
      got = r.ok ? (r.data?.items ?? []).filter((x: any) => words.some((w) => `${x.full_name} ${x.description ?? ""}`.toLowerCase().includes(w))).slice(0, 2).map(toSug) : [];
    }
    cache.set(cap, got);
    return got;
  };
}
function services(cap: string, inv: Inventory): ConnectorSuggestion[] {
  return (CAP[cap]?.recs ?? []).map((id) => RECS.find((r) => r.id === id)).filter((r): r is (typeof RECS)[number] => !!r).slice(0, 2)
    .map((r) => ({ type: "service" as const, name: r.name, url: r.url, free: r.free, why: r.what, how: `Sign up at ${r.url}; ${inv.keys.length ? "put its key in .env (name only in .env.example)" : "add its key to .env"}` }));
}
function graphics(i: Pick<Idea, "name" | "buyer">): ConnectorSuggestion {
  return { type: "graphics", name: "Logo, app icon and OG image", why: `a landing page for ${i.buyer.split(/[,(]/)[0].trim() || "the buyer"} needs a face`, how: `codex-image skill: "flat logo mark for '${i.name}', 2 colours, no text, works at 32 px" + "1200×630 OG image with the headline"` };
}

/** Every needed capability → have / missing, and suggestions for the missing ones (repos only when a finder is given). */
export async function mapConnectors(i: Idea, inv: Inventory, findRepos?: (cap: string) => Promise<ConnectorSuggestion[]>): Promise<CapNeed[]> {
  const stackIds = i.stack.map((s) => s.assetId).filter(Boolean) as string[];
  const out: CapNeed[] = [];
  for (const cap of requiredCaps(i)) {
    const have = haveFor(cap, inv, stackIds).slice(0, 3).map((a) => ({ id: a.id, name: a.name }));
    const missing = have.length === 0;
    const suggestions: ConnectorSuggestion[] = [];
    if (missing) suggestions.push(...services(cap, inv));
    // A library to build it with, unless one of the user's own projects in the stack already does this part, or it's
    // infrastructure the user already has as a service (Gumroad needs no Stripe SDK).
    const ownCode = i.stack.some((x) => x.owned && inv.assets.find((a) => a.id === x.assetId)?.caps.includes(cap));
    if (findRepos && !ownCode && (missing || !INFRA.has(cap))) suggestions.push(...(await findRepos(cap)));
    const biz = BUSINESS[cap];
    if (biz) suggestions.push({ type: "business", name: biz.name, why: biz.why, how: biz.how });
    if (PROMPTS[cap]) suggestions.push({ type: "prompt", name: `${CAP[cap].label}: prompt pack`, why: "the first thing an agent needs to build this well", how: PROMPTS[cap] });
    if (cap === "landing") suggestions.push(graphics(i));
    out.push({ cap, label: CAP[cap]?.label ?? cap, have, missing, suggestions });
  }
  return out;
}
/** Share of the idea's stack the user already owns (0..1). */
export const ownedRatio = (i: Pick<Idea, "stack">) => (i.stack.length ? i.stack.filter((s) => s.owned).length / i.stack.length : 0);
