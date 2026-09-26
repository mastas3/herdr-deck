// The game layer, part 2: today's three quests for the main quest. One headless Claude Code call a day (a fast model,
// low effort, no tools; the same runner the project pages use) turns the journey's next milestone, the current boss,
// fresh leads, the live site and the product into six quests: three for today and three spares that Reroll swaps in.
//
// Every quest must name something real from this project's state (a lead's post, a subreddit, the live site, the
// product, the project itself). A quest that could apply to any project unchanged ("engage with your audience",
// "improve the UX") is rejected, and so is one without a way to verify it. What's left is filled from templates that
// are built only from the same real state; when there isn't enough of it, the board shows fewer quests, not filler.
//
// Only titles, milestone names, numbers, lead post titles/links, the site's host and product name go to the model.
import { parseJsonLoose, type Runner } from "./journey-ai";
import { hash } from "./game-rules";

export type QuestProof = "sell" | "talk" | "lead" | "ship" | "milestone" | "metric" | "check";
export const QUEST_PROOFS: QuestProof[] = ["sell", "talk", "lead", "ship", "milestone", "metric", "check"];
export const BUSINESS = new Set<QuestProof>(["sell", "talk", "lead", "ship"]);
export const QUEST_XP: Record<QuestProof, number> = { sell: 150, talk: 80, lead: 60, ship: 100, milestone: 120, metric: 40, check: 20 };
export const VERIFY: Record<QuestProof, string> = {
  sell: "Auto: a Gumroad sale, or a paying-customers or revenue number you log with a note",
  talk: "Check it off with a note (who, what they said) or a link to the thread",
  lead: "Log each lead you contacted with its link",
  ship: "Auto: a release or tag, or a wiki entry that says it shipped; or check it off with the live link",
  milestone: "Auto: the milestone unlocks from its evidence",
  metric: "Auto: log the number with a note",
  check: "Auto: the project's own checks pass (proof of done)",
};
export type LeadPost = { id: string; title: string; url: string; where?: string; author?: string; at?: number; snippet?: string };
export type Quest = {
  id: string; title: string; why: string; milestone?: string; milestoneTitle?: string; proof: QuestProof; count: number;
  mode: "agent" | "diy"; prompt?: string; steps: string[]; leads: LeadPost[]; xp: number; verify: string; metric?: string; // metric: the number a metric quest wants
  state: "open" | "done"; doneAt?: number; evidence?: { title: string; evidence: string; link?: any; ids: string[]; manual?: boolean }; progress?: number;
};
export type QuestCtx = {
  project: string; root?: string; pitch?: string; heading?: string; stage?: string; nature?: string; day: string;
  next: { id: string; title: string; metric: string; target: number; value?: number; unit?: string }[];
  boss?: { title: string; source: string; value: number; target: number; unit: string; measured: boolean };
  /** Where it's live (from the wiki) and what's for sale (the Gumroad product the journey matched). */
  urls?: string[]; product?: string;
  recent: string[]; leads: LeadPost[]; connections: string[]; done: string[];
  run?: { buyer?: string; offer?: string; price?: string | number };
};
export type Rejected = { title: string; reason: string };

const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
const home = (p?: string) => (p ?? "").replace(/^\/(?:Users|home)\/[^/]+/, "~");
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
export const SAFETY = "Rules: don't post, message, email, publish or buy anything on my behalf, and don't deploy to production without asking me first. Prepare drafts I can send myself. Never invent testimonials, reviews, customers or numbers: leave a clearly marked gap instead. When something ships for real, add one dated line to ~/wiki/log.md saying what shipped and where it's live.";

// ── specificity: a quest has to be about this project ───────────────────────────────────────
/** Wording that makes a quest advice rather than a task. */
export const VAGUE = /\b(engage|engagement|marketing|brand(ing)? awareness|audience|leverage|optimi[sz]e|boost|synerg\w*|social media|online presence|content strategy|networking|brainstorm|research the market|think about|consider|explore|stay consistent|keep (going|shipping)|momentum|best practices|user experience|the ux|the ui|polish|refine|enhance)\b|^\s*(improve|work on|continue|focus on|start|try to)\b/i;
const STOP = new Set("about after again against their there these those which while would could should where with from into your that this than then them they have been being what when will just more most some such only other also very over under each every both through using used make made build built first".split(" "));
/** Words from the pitch and offer that name what this project is (a feature, a topic), for the weak anchors. */
export const keywords = (ctx: QuestCtx) => [...new Set(`${ctx.pitch ?? ""} ${ctx.run?.offer ?? ""} ${ctx.run?.buyer ?? ""}`.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? [])].filter((w) => !STOP.has(w));
/**
 * Why a quest is too generic to keep (undefined: it's specific). It must name something only this project has: the
 * project, a lead's post, a place (subreddit, site), the live site, the product, or two words of its own pitch.
 * Milestone names alone don't count: "First paying customer" is on every ladder.
 */
export function genericReason(q: Pick<Quest, "title" | "why" | "leads" | "steps">, ctx: QuestCtx): string | undefined {
  if (VAGUE.test(q.title)) return "vague wording: advice, not a task";
  const text = `${q.title} ${q.why} ${q.steps.join(" ")}`.toLowerCase();
  const strong = [ctx.project, ...ctx.project.split(/[-_]/).filter((w) => w.length >= 5), ...(ctx.urls ?? []).map(hostOf), ctx.product, ctx.run?.offer, ...ctx.leads.map((l) => l.where)]
    .filter((x): x is string => !!x && x.length >= 4).map((x) => x.toLowerCase());
  if (q.leads.length || strong.some((a) => text.includes(a)) || /\br\/\w{3,}|https?:\/\/|\b[a-z0-9-]+\.(com|app|io|net|org|dev|ai|co)\b/.test(text)) return undefined;
  if (keywords(ctx).filter((w) => text.includes(w)).length >= 2) return undefined;
  return "could apply to any project: it names no lead, place, site, product or feature of this one";
}
/** Keeps the specific quests; says why each other one went. */
export function vetQuests(qs: Quest[], ctx: QuestCtx): { kept: Quest[]; rejected: Rejected[] } {
  const kept: Quest[] = [], rejected: Rejected[] = [];
  for (const q of qs) {
    const why = genericReason(q, ctx);
    if (why) { rejected.push({ title: q.title, reason: why }); continue; }
    // A filler reason is replaced by the plain one: the milestone it moves.
    kept.push(VAGUE.test(q.why) || !q.why ? { ...q, why: q.milestoneTitle ? `Moves “${q.milestoneTitle}”.` : "" } : q);
  }
  return { kept, rejected };
}

// ── the prompt ──────────────────────────────────────────────────────────────────────
export const SYSTEM = "You turn one founder's project state into today's concrete tasks. Selling, talking to users and shipping to users come before writing code. You reply with exactly one JSON object and nothing else: no prose, no code fences.";
export function prompt(ctx: QuestCtx): string {
  const sites = [...new Set((ctx.urls ?? []).map(hostOf).filter(Boolean))].slice(0, 3);
  const lines = [
    `Project: ${ctx.project}${ctx.pitch ? ` — ${clip(ctx.pitch, 160)}` : ""}`,
    ctx.nature ? `Kind: ${ctx.nature}` : "", ctx.stage ? `Stage reached: ${ctx.stage}` : "",
    sites.length ? `Live at: ${sites.join(", ")}` : "", ctx.product ? `For sale on Gumroad: “${clip(ctx.product, 80)}”` : "",
    ctx.run ? `The run: sells ${clip(ctx.run.offer ?? "?", 100)} to ${clip(ctx.run.buyer ?? "?", 80)}${ctx.run.price ? ` at ${clip(String(ctx.run.price), 20)}` : ""}` : "",
    ctx.boss ? `Current boss: ${ctx.boss.title} (${ctx.boss.measured ? `${ctx.boss.value} of ${ctx.boss.target}` : "not measured yet"})` : "",
    ctx.next.length ? `Next milestones (id: title, now/target):\n${ctx.next.slice(0, 4).map((m) => `- ${m.id}: ${clip(m.title, 60)} (${m.value ?? "not measured"}/${m.target}${m.unit ? ` ${m.unit}` : ""})`).join("\n")}` : "",
    ctx.heading ? `Heading: ${clip(ctx.heading, 200)}` : "",
    ctx.recent.length ? `Recent proof: ${ctx.recent.slice(0, 5).map((r) => clip(r, 70)).join("; ")}` : "",
    ctx.leads.length ? `Fresh leads (public posts by people with the problem; index: where, title):\n${ctx.leads.slice(0, 6).map((l, i) => `${i}: ${l.where ?? "web"}, “${clip(l.title, 90)}”`).join("\n")}` : "No fresh leads.",
    ctx.connections.length ? `Accounts and tools the founder has: ${ctx.connections.slice(0, 16).map((c) => clip(c, 24)).join(", ")}` : "",
    ctx.done.length ? `Already done lately (don't repeat): ${ctx.done.slice(0, 6).map((d) => clip(d, 60)).join("; ")}` : "",
  ].filter(Boolean);
  return `${lines.join("\n")}

Write 6 quests for today (the first 3 are today's, the rest are spares). Each is doable in one sitting and moves a milestone or the boss. At least 2 of the first 3 must be selling, talking to users, contacting leads or shipping to users; at most 1 may be pure code. The founder sends every message and post themselves: agent quests only prepare (code, pages, drafts).

Every quest must name something real from the state above: a lead's post (by its title or index), a subreddit or site, the live site, the product, or a feature named in the pitch. A quest that could apply to any project unchanged is thrown away.
Thrown away: "Engage with your audience", "Work on marketing", "Improve the UX", "Post on social media", "Talk to potential users".
Kept: "Reply to the 3 r/humandesign posts from today's leads about chart apps getting profiles wrong", "Put the Founding Reading's Gumroad link on the 2027prophecy.com home page".
Leads are public posts: the founder replies on the post itself, helpfully and to what it asks (a link only where it answers the question). Use only the names, products and numbers listed above; never invent people, testimonials, reviews or figures.
Proof is logged on the quest board as a link or a note (not in a file).
No hype, no motivational lines: plain words.

Reply with JSON only:
{"quests":[{"title":"imperative, under 80 chars, names the real thing","why":"which milestone or boss it moves, in one plain sentence under 140 chars","milestone":"<milestone id from the list>","proof":"sell|talk|lead|ship|milestone|metric|check","count":1,"mode":"agent|diy","prompt":"agent mode only: exact instructions for a coding agent working in the project folder","steps":["diy mode only: 2-4 short checklist steps"],"leads":[0,1]}]}
proof means how it's verified: sell = a sale or paying customer logged; talk = a conversation or public post logged with a note/link; lead = leads contacted, each logged with its link (count = how many); ship = a release/deploy/wiki "shipped" entry or the live link; milestone = the milestone unlocks; metric = a number logged with a note; check = the project's tests pass. "leads" lists indexes of the fresh leads the quest uses.`;
}

// ── validation and repair ───────────────────────────────────────────────────────────────
const inferProof = (t: string): QuestProof => /^\s*(ship|deploy|launch|release|publish|put)\b/i.test(t) ? "ship" : /\b(buy|pay|price|sell|sale|checkout|invoice|customer)\b/i.test(t) ? "sell" : /\b(lead|reply|dm|contact)\b/i.test(t) ? "lead" : /\b(talk|call|interview|ask|post|feedback)\b/i.test(t) ? "talk" : /\b(ship|deploy|launch|release|publish|live)\b/i.test(t) ? "ship" : /\b(test|check|fix)\b/i.test(t) ? "check" : "metric";
function finish(q: Omit<Quest, "id" | "xp" | "verify" | "state">, ctx: QuestCtx): Quest {
  const ms = ctx.next.find((m) => m.id === q.milestone) ?? ctx.next[0];
  const prompt = q.mode === "agent" ? `${q.prompt ?? ""}\n\nContext: this is the ${ctx.project} project${ctx.root ? ` (${home(ctx.root)})` : ""}. Read ~/wiki/projects/${ctx.project}.md and the README first. Today's quest: “${q.title}”${ms ? `, which moves the milestone “${ms.title}”` : ""}. How it's verified: ${VERIFY[q.proof]}.\n${SAFETY}` : undefined;
  return { ...q, id: `q${hash(`${ctx.day}|${ctx.project}|${q.title}`)}`, milestone: ms?.id, milestoneTitle: ms?.title, prompt, xp: QUEST_XP[q.proof], verify: q.proof === "lead" ? `${VERIFY.lead} (${q.count} needed)` : VERIFY[q.proof], state: "open" };
}
/** Keeps only quests with a real shape: a title, a known proof, agent quests with a prompt, lead quests with real leads. */
export function normalizeQuests(raw: any, ctx: QuestCtx): Quest[] {
  const list = Array.isArray(raw?.quests) ? raw.quests : Array.isArray(raw) ? raw : [];
  const out: Quest[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const title = clip(x.title, 90);
    if (title.length < 6 || seen.has(title.toLowerCase())) continue;
    const proof: QuestProof = QUEST_PROOFS.includes(x.proof) ? x.proof : inferProof(`${title} ${x.why ?? ""}`);
    const idx = (Array.isArray(x.leads) ? x.leads : []).map(Number).filter((i: number) => Number.isInteger(i) && i >= 0 && i < ctx.leads.length);
    let leads = [...new Set<number>(idx)].map((i) => ctx.leads[i]);
    if (proof === "lead" && !leads.length) { if (!ctx.leads.length) continue; leads = ctx.leads.slice(0, 3); }
    const steps = (Array.isArray(x.steps) ? x.steps : []).map((s: unknown) => clip(s, 120)).filter((s: string) => s.length > 3).slice(0, 5);
    const agentPrompt = clip(x.prompt, 1400);
    const mode: Quest["mode"] = x.mode === "agent" && agentPrompt.length >= 30 ? "agent" : steps.length ? "diy" : agentPrompt.length >= 30 ? "agent" : "diy";
    const count = proof === "lead" || proof === "talk" ? Math.max(1, Math.min(5, Math.round(Number(x.count) || (proof === "lead" ? Math.min(3, leads.length) : 1)))) : 1;
    seen.add(title.toLowerCase());
    out.push(finish({ title, why: clip(x.why, 160), milestone: String(x.milestone ?? ""), proof, count: proof === "lead" ? Math.min(count, Math.max(1, leads.length)) : count, mode, prompt: mode === "agent" ? agentPrompt : undefined, steps: mode === "diy" ? (steps.length ? steps : [title]) : [], leads }, ctx));
  }
  return out.slice(0, 8); // a few extra: vetting may drop some
}

// ── quests from templates: built only from real state, so they're specific or absent ─────────────
export function fallbackQuests(ctx: QuestCtx): Quest[] {
  const next = ctx.next[0];
  const site = (ctx.urls ?? []).map(hostOf).find(Boolean);
  const offer = ctx.run?.offer || ctx.product;
  const places = [...new Set(ctx.leads.map((l) => l.where).filter(Boolean) as string[])];
  const place = places[0];
  const money = !!ctx.boss && /customer|paying|month|revenue|sale|\$/i.test(`${ctx.boss.title} ${ctx.boss.unit}`);
  const q = (t: Omit<Quest, "id" | "xp" | "verify" | "state" | "milestone" | "steps" | "leads"> & Partial<Pick<Quest, "steps" | "leads">>) => ({ milestone: next?.id, steps: [], leads: [], ...t });
  const pool: Omit<Quest, "id" | "xp" | "verify" | "state">[] = [];
  const n = Math.min(3, ctx.leads.length);
  if (n) {
    const ls = ctx.leads.slice(0, n);
    const where = places.length === 1 ? `${places[0]} ` : "";
    pool.push(q({ title: n === 1 ? `Reply to “${clip(ls[0].title, 50)}” on ${ls[0].where ?? "its thread"}` : `Reply to the ${n} ${where}posts from today's leads`, why: `They wrote about the problem ${ctx.project} solves${ls[0].title ? `, e.g. “${clip(ls[0].title, 60)}”` : ""}.`, proof: "lead", count: n, mode: "diy", steps: [...ls.map((l) => `Reply on ${l.where ?? "the thread"}: “${clip(l.title, 70)}”`), "Log each reply you sent (its link is the proof)"], leads: ls }));
  }
  if (money && offer && place) pool.push(q({ title: `Offer “${clip(offer, 40)}” to one person from ${place}`, why: `${ctx.boss!.title} is the boss${ctx.boss!.measured ? ` (${ctx.boss!.value} of ${ctx.boss!.target})` : ""}; only a real offer moves it.`, proof: "sell", mode: "diy", steps: [`Pick someone in ${place} who described the problem`, `Send them the link to “${clip(offer, 50)}”${ctx.run?.price ? ` and the price (${ctx.run.price})` : ""}`, "If they pay, log a paying customer with a note"] }));
  if (next) pool.push(q({ title: `Ship one change ${site ? `on ${site}` : `to ${ctx.project}`} that moves “${clip(next.title, 40)}”`, why: `The next milestone: ${next.title} (${next.value ?? "not measured"} of ${next.target}${next.unit ? ` ${next.unit}` : ""}).`, milestone: next.id, proof: "ship", mode: "agent", prompt: `Find the smallest change${site ? ` to ${site}` : ""} that gets ${ctx.project} measurably closer to “${next.title}” (${next.metric}: ${next.value ?? "not measured"} of ${next.target}). Propose it in three bullet points and wait for my go. Then build it, run the checks, and prepare it to go live.` }));
  if (ctx.leads[n]) { // a lead the reply quest didn't take
    const l = ctx.leads[n];
    pool.push(q({ title: `Ask the author of “${clip(l.title, 45)}” what they use today`, why: `One real answer about how ${l.where ?? "they"} handle it now beats a guess.`, proof: "talk", mode: "diy", steps: [`Open the post on ${l.where ?? "its site"}`, "Ask what they use now and what they'd pay to fix", "Log the answer: who, and the one thing they said"], leads: [l] }));
  }
  if (ctx.boss && !ctx.boss.measured) pool.push(q({ title: `Log ${ctx.project}'s real ${ctx.boss.unit === "$" ? "monthly revenue" : ctx.boss.unit || "numbers"} for “${clip(ctx.boss.title, 32)}”`, why: `The boss reads that number, and it isn't measured yet.`, proof: "metric", metric: ctx.boss.source, mode: "diy", steps: [`Look up the real number${site ? ` (${site} analytics, payments)` : " (analytics, payments)"}`, "Log it on the project page with a note saying where it came from"] }));
  if (place && (offer || site)) pool.push(q({ title: `Draft a ${place} post about ${offer ? `“${clip(offer, 40)}”` : site}`, why: `${place} is where today's leads are; a draft ready to post makes the next ship visible there.`, proof: "talk", mode: "agent", prompt: `Write a short, plain post for ${place} (under 150 words) about ${offer ? `“${offer}”` : site}: the problem it solves, who it's for, what's live${site ? ` at ${site}` : ""}, and one link. Match ${place}'s rules and tone. Save it as drafts/${place.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}-post.md in the project folder. Don't post it; I'll post it myself.` }));
  const done = new Set(ctx.done.map((d) => d.toLowerCase()));
  const seen = new Set<string>();
  return pool.filter((x) => { const k = x.title.toLowerCase(); if (done.has(k) || seen.has(k)) return false; seen.add(k); return true; }).map((x) => finish(x, ctx)).slice(0, 6);
}

/** The first three are today's: people first, at most one pure-code quest, at least one sell/talk/lead. */
export function arrange(qs: Quest[], fill: Quest[]): Quest[] {
  const titles = new Set<string>(), taken = new Set(qs.flatMap((q) => q.leads.map((l) => l.url)));
  const spare = fill.filter((q) => !q.leads.some((l) => taken.has(l.url))); // a template that replies to a lead a kept quest already has
  const all = [...qs, ...spare].filter((q) => { const k = q.title.toLowerCase(); if (titles.has(k)) return false; titles.add(k); return true; });
  const people = all.filter((q) => q.proof === "sell" || q.proof === "talk" || q.proof === "lead");
  const today: Quest[] = [];
  if (people[0]) today.push(people[0]);
  for (const q of all) {
    if (today.length >= 3) break;
    if (today.includes(q)) continue;
    if (!BUSINESS.has(q.proof) && today.some((x) => !BUSINESS.has(x.proof))) continue;
    today.push(q);
  }
  for (const q of all) if (today.length < 3 && !today.includes(q)) today.push(q);
  const spares = all.filter((q) => !today.includes(q)).slice(0, 3);
  return [...today, ...spares];
}

export type QuestGen = { quests: Quest[]; rejected: Rejected[]; source: "claude" | "rules"; model?: string; note?: string; ms?: number };
/** One model pass, vetted for specificity; what it gets wrong is filled from the templates. Never throws. */
export async function generateQuests(ctx: QuestCtx, opts: { runner?: Runner; timeoutMs?: number; onCall?: () => void } = {}): Promise<QuestGen> {
  const fill = fallbackQuests(ctx);
  const few = (n: number) => (n < 3 ? ` Only ${n} quest${n === 1 ? "" : "s"}: there isn't enough real state for more (fresh leads in Discover → Leads, a live URL in the wiki or a product on Gumroad add more).` : "");
  if (!opts.runner) { const quests = arrange([], fill); return { quests, rejected: [], source: "rules", note: `No model here: quests come from simple rules.${few(quests.length)}` }; }
  const t0 = Date.now();
  try {
    opts.onCall?.();
    const r = await opts.runner(SYSTEM, prompt(ctx), opts.timeoutMs ?? 60_000);
    const { kept, rejected } = vetQuests(normalizeQuests(parseJsonLoose(r.text), ctx), ctx);
    const quests = arrange(kept, fill);
    if (!kept.length) return { quests, rejected, source: "rules", note: `The model's answer couldn't be used: quests come from simple rules.${few(quests.length)}`, ms: Date.now() - t0 };
    return { quests, rejected, source: "claude", model: r.model, ms: Date.now() - t0, note: kept.length < 3 ? `Some quests came from simple rules.${few(quests.length)}` : undefined };
  } catch (e: any) {
    const quests = arrange([], fill);
    return { quests, rejected: [], source: "rules", note: `${clip(e?.message ?? "The model failed", 100)}: quests come from simple rules.${few(quests.length)}`, ms: Date.now() - t0 };
  }
}
