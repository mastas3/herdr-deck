// The Studio's conversations and replies: what a model is reminded of, the <build>/<ask>/<next> blocks parsed and
// repaired out of a streaming reply, the quality gates for a build, the instant template reply, and the "Build it now"
// brief. Pure functions; the store and the jobs are studio.ts.
import { homedir } from "node:os";
import { hash, sanitizeIngredient, templateMixes, type Ingredient, type IngKind, type Mix } from "./mix";
import { redact } from "../../src/ingredients";
import { composeDice, RIFFS } from "./studio-prompts";
import { CH_LABEL, comparablesFor, comparablesLine, type Comparables, type Target } from "../../src/library-strategy";

const HOME = homedir();
const clip = (s: unknown, n: number) => { const t = redact(s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };

// ── conversations ──────────────────────────────────────────────────────────────────
export type IngRef = { id: string; kind: IngKind; name: string };
/** The plan that makes a build ready to execute (all optional: the chat keeps a thinner build, the feed doesn't). */
export type Plan = { customer?: string; problem?: string; offer?: string; price?: string; model?: string; mvp?: string[]; launch?: string[]; week?: string[]; cost?: string; first_dollar?: string; risks?: string[] };
/** A build's comparable founders, compact: one line, the top three with a link to their moment, and the strategy check. */
export type BuildComps = { line: string; items: { name: string; link: string; revenue?: string; published?: string; old?: string; channel?: string; tactic?: string }[]; checks: string[] };
export type Build = Mix & Plan & { extra: string[]; project?: string; money?: string; row?: string; comps?: BuildComps };
export function buildComps(b: Partial<Build>, find: (t: Target) => Comparables | undefined = comparablesFor): BuildComps | undefined {
  const r = find({ name: b.title, offer: b.offer ?? b.pitch, buyer: b.customer, price: b.price, channel: b.launch?.join("; ") });
  if (!r) return undefined;
  return {
    line: comparablesLine(r), checks: r.checks,
    items: r.comparables.slice(0, 3).map((c) => { const f = c.first.find((x) => x.channel !== "other") ?? c.first[0]; return { name: c.name, link: f?.link ?? c.url, revenue: c.revenue?.text, published: c.published || undefined, old: c.old || undefined, channel: f && f.channel !== "other" ? CH_LABEL[f.channel] : undefined, tactic: f?.text }; }),
  };
}
export type Block =
  | { t: "text"; md: string }
  | { t: "build"; b: Build }
  | { t: "ask"; q: string; options: string[] }
  | { t: "next"; items: string[] }
  | { t: "pending"; kind: string };
export type UserMsg = { role: "user"; text: string; use: IngRef[]; at: number };
export type BotMsg = { role: "assistant"; blocks: Block[]; refs: Record<string, IngRef>; engine: string; model?: string; ms?: number; firstMs?: number; note?: string; error?: string; at: number; stopped?: boolean };
export type Msg = UserMsg | BotMsg;
export type Convo = { id: string; title: string; created: number; updated: number; messages: Msg[] };

/** What a model is reminded of: the recent turns, compact (a build is its title, pitch and ingredients). */
export function historyText(msgs: Msg[], budget = 6000): string {
  const lines = msgs.map((m) => {
    if (m.role === "user") return `Stas: ${clip(m.text, 900)}${m.use.length ? `\n(use these: ${m.use.map((x) => x.name).join(", ")})` : ""}`;
    const parts = m.blocks.map((b) => (b.t === "text" ? clip(b.md, 700) : b.t === "build" ? `<build> ${b.b.title}: ${b.b.pitch} [${[...b.b.ingredients, ...b.b.extra].join(" + ")}]` : b.t === "ask" ? `<ask> ${b.q} (${b.options.join(" / ")})` : "")).filter(Boolean);
    return `You: ${parts.join("\n") || "(no answer)"}`;
  });
  const out: string[] = [];
  let n = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < 12; i--) { if (n + lines[i].length > budget && out.length) break; out.unshift(lines[i]); n += lines[i].length; }
  if (out.length < lines.length) out.unshift(`(${lines.length - out.length} earlier messages left out)`);
  return out.join("\n\n");
}
/** The user turn sent to the model: the conversation so far, then the new message and the ingredients to use. */
export function turnPrompt(history: Msg[], text: string, use: IngRef[]): string {
  const h = historyText(history);
  return [
    h ? `The conversation so far:\n\n${h}\n\n---\n` : "",
    `Stas: ${text.trim() || (use.length ? "Assemble something great out of these." : "Surprise me.")}`,
    use.length ? `\nUse these from my inventory (build around them; you may add other inventory items): ${use.map((x) => `${x.name} (${KIND_WORD[x.kind]})`).join(", ")}` : "",
    "\n(Answer in the Studio format: 1 to 3 short sentences, then 2 or 3 <build>{...}</build> blocks, then one <next>[...]</next>.)",
  ].join("\n").trim();
}
const KIND_WORD: Record<IngKind, string> = { project: "my project", repo: "a repo I found", conn: "a service I have", tool: "an agent tool", interest: "an interest" };

// ── parsing: blocks out of a streaming reply ───────────────────────────────────────────
const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
/**
 * Which inventory item a model meant: exact name, a repo's short name, the same name loosely, or the start of a
 * longer name ("YouTube RAG" → "YouTube RAG (yt-transcriber)"); never the other way round ("Stripe Atlas" is not
 * "Stripe"). Ready items win over ones that aren't set up.
 */
export function matchInv(name: string, ings: Ingredient[]): Ingredient | undefined {
  const n = String(name ?? "").replace(/^\[\[|\]\]$/g, "").trim();
  if (!n) return undefined;
  const lc = n.toLowerCase(), nn = normName(n);
  const tests: ((x: Ingredient) => boolean)[] = [
    (x) => x.name.toLowerCase() === lc,
    (x) => x.kind === "repo" && x.name.split("/")[1]?.toLowerCase() === lc,
    (x) => normName(x.name) === nn || (x.kind === "repo" && normName(x.name.split("/")[1] ?? "") === nn),
    (x) => nn.length >= 5 && normName(x.name).startsWith(nn),
  ];
  for (const t of tests) { const hit = ings.find((x) => x.ready && t(x)) ?? ings.find(t); if (hit) return hit; }
  // "Gumroad (recurring subscription product)": the name before the note.
  const bare = n.replace(/\s*[(—–:].*$/, "").trim();
  return bare && bare !== n ? matchInv(bare, ings) : undefined;
}
const TAGS = ["build", "ask", "next"];
const loose = (t: string) => t.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1");
function tryJson(t: string): any {
  const s = t.replace(/```(?:json)?/gi, "").trim();
  for (const x of [s, loose(s)]) { try { return JSON.parse(x); } catch {} }
  // Cut to the outermost braces/brackets and try again (a model sometimes adds words around the JSON).
  const a = Math.min(...["{", "["].map((c) => (s.indexOf(c) < 0 ? Infinity : s.indexOf(c)))), b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (Number.isFinite(a) && b > a) for (const x of [s.slice(a, b + 1), loose(s.slice(a, b + 1))]) { try { return JSON.parse(x); } catch {} }
  return undefined;
}
/** Model text for a plain-text field: [[brackets]] off (they're only for the prose), one line, clipped. */
const plain = (v: unknown, n: number) => clip(String(v ?? "").replace(/\[\[([^\]\n]{1,80})\]\]/g, "$1"), n);
const strs = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n|;\s/) : [])
  .map((x: any) => plain(typeof x === "string" ? x.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "") : x?.text ?? x?.label ?? x?.step ?? x?.title ?? "", n)).filter(Boolean).slice(0, max);
function diffOf(v: unknown, n: number): Mix["difficulty"] {
  const s = String(v ?? "").toLowerCase();
  return /weekend|day|hour|small|easy/.test(s) ? "weekend" : /month|quarter|large|big|hard/.test(s) ? "month" : /week|medium/.test(s) ? "week" : n <= 2 ? "weekend" : n <= 3 ? "week" : "month";
}

/** One <build> object → a clean build: inventory names matched (unknown ones become "new" pieces). */
export function normalizeBuild(raw: any, ings: Ingredient[], source: Mix["source"]): Build | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const title = plain(raw.title ?? raw.name, 90).replace(/\s*\((?:saas|app|service|api|tool|bot|b2b|b2c)\)\s*$/i, "");
  if (!title) return undefined;
  const names: unknown[] = Array.isArray(raw.ingredients) ? raw.ingredients : typeof raw.ingredients === "string" ? raw.ingredients.split(/,|\+/) : [];
  const picked: Ingredient[] = [];
  const extra: string[] = [];
  for (const v of names) {
    const n = typeof v === "string" ? v : String((v as any)?.name ?? "");
    const m = matchInv(n, ings);
    if (m) { if (!picked.includes(m)) picked.push(m); } else if (n.trim()) extra.push(clip(n, 60));
  }
  const hv = raw.how ?? raw.roles;
  const how = (Array.isArray(hv) ? hv.map((h: any) => (typeof h === "string" ? { name: h.split(/:\s/)[0], role: h.split(/:\s/).slice(1).join(": ") } : { name: String(h?.name ?? h?.ingredient ?? ""), role: String(h?.role ?? h?.does ?? "") }))
    : hv && typeof hv === "object" ? Object.entries(hv).map(([k, v]) => ({ name: k, role: String(v) })) : []) as { name: string; role: string }[];
  const hows: { name: string; role: string }[] = [];
  for (const h of how) {
    const m = matchInv(h.name, ings);
    if (!m) continue;
    if (!picked.includes(m) && picked.length < 6) picked.push(m);
    if (!hows.some((x) => x.name === m.name)) hows.push({ name: m.name, role: plain(h.role, 180) });
  }
  const use = picked.slice(0, 6);
  for (const x of [...strs(raw.new ?? raw.extra ?? raw.outside, 60, 3)]) if (!extra.includes(x)) extra.push(x);
  const proj = raw.project ? matchInv(String(raw.project), ings.filter((x) => x.kind === "project")) : undefined;
  const week = strs(raw.week ?? raw.first_week ?? raw.tasks, 180, 7);
  const steps = strs(raw.first_steps ?? raw.steps ?? raw.firstSteps, 180, 5);
  const opt = (v: unknown, n: number) => { const t = plain(v, n); return t || undefined; };
  const list = (v: unknown, n: number, max: number) => { const l = strs(v, n, max); return l.length ? l : undefined; };
  const wowN = Number(String(raw.wow ?? raw.score ?? "").match(/\d+/)?.[0] ?? 3);
  return {
    id: hash(`${title}|${use.map((x) => x.id).join(",")}`), title, pitch: plain(raw.pitch ?? raw.summary ?? raw.description, 240),
    ingredients: use.map((x) => x.name), ids: use.map((x) => x.id), how: hows.filter((h) => use.some((x) => x.name === h.name)),
    why_novel: plain(raw.why ?? raw.why_novel ?? raw.whyNovel, 240), first_steps: steps.length ? steps : week.slice(0, 3), difficulty: diffOf(raw.size ?? raw.difficulty ?? raw.effort, use.length),
    wow: Math.max(1, Math.min(5, Number.isFinite(wowN) ? wowN : 3)), source, extra: extra.slice(0, 3), project: proj?.name, money: raw.money ? plain(raw.money, 160) : undefined,
    customer: opt(raw.customer ?? raw.audience ?? raw.target, 200), problem: opt(raw.problem ?? raw.pain, 220), offer: opt(raw.offer, 220),
    price: opt(raw.price ?? raw.pricing, 120), model: opt(raw.model ?? raw.business_model, 60), mvp: list(raw.mvp ?? raw.scope, 160, 6),
    launch: list(raw.launch ?? raw.first_customers ?? raw.go_to_market, 220, 5), week: week.length ? week : undefined, cost: opt(raw.cost ?? raw.monthly_cost, 100),
    first_dollar: opt(raw.first_dollar ?? raw.firstDollar ?? raw.time_to_first_dollar, 80), risks: list(raw.risks ?? raw.risk, 180, 4), row: raw.row ? plain(raw.row, 20) : undefined,
  };
}
const GENERIC = /\b(ai[- ]powered (platform|solution|tool)|leverag\w*|synerg\w*|revolutioni[sz]\w*|seamless\w*|cutting[- ]edge|one[- ]stop|all[- ]in[- ]one solution|next[- ]gen\w*|game[- ]chang\w*|supercharg\w*|unleash\w*|empower\w*|harness(ing)? the power|elevate your|streamline your|transform your|effortless\w*|in today'?s (fast|digital)|unlock(ing)? (the|your) (full )?potential)\b/i;
/** "Everyone", "businesses", "creators": not a buyer you can message today. */
const VAGUE_BUYER = /^\s*(everyone|anyone|people|users|businesses|small businesses|companies|creators|content creators|developers|entrepreneurs|professionals|individuals)\s*\.?\s*$/i;
/** The first-customer plan has to name a real place, not "social media". */
const NAMED_CHANNEL = /r\/\w|@\w|https?:\/\/|\b(groups?|discord|telegram|slack|whatsapp|facebook|instagram|tiktok|twitter|x\.com|reddit|youtube|linkedin|forums?|subreddit|newsletter|mailing list|product hunt|hacker news|indie hackers|meetup|shopify community|app store|github)\b|\b(dm|message|email|call)\w* \d+/i;
const EMOJI = /\p{Extended_Pictographic}/u;
/** Buzzwords, a buyer nobody can message, no named channel, or emoji in the name: AI slop, never shown. */
export function isSlop(b: Partial<Build>): boolean {
  const text = [b.title, b.pitch, b.customer, b.offer, b.problem, ...(b.launch ?? [])].filter(Boolean).join(" ");
  return GENERIC.test(text) || VAGUE_BUYER.test(String(b.customer ?? "")) || !NAMED_CHANNEL.test((b.launch ?? []).join(" ")) || EMOJI.test(String(b.title ?? ""));
}
/** How complete the plan is, 0..1 (the feed shows the best first). */
export function planScore(b: Build): number {
  const checks = [b.customer, b.problem, b.offer, b.price && /\d/.test(b.price), b.model, (b.mvp?.length ?? 0) >= 3, b.ids.length >= 2, (b.launch?.length ?? 0) >= 1, (b.week?.length ?? 0) >= 3, b.cost, b.first_dollar, b.risks?.length];
  return checks.filter(Boolean).length / checks.length;
}
/** The feed's quality gate: a specific customer, a real price, a buildable MVP on his real inventory, a launch and a week of tasks; nothing generic. */
export function isExecutable(b: Build): boolean {
  return !!b.customer && b.customer.length >= 12 && !!b.price && /\d/.test(b.price) && (b.mvp?.length ?? 0) >= 3 && b.ids.length >= 2
    && (b.launch?.length ?? 0) >= 1 && (b.week?.length ?? 0) >= 3 && !!b.pitch && b.pitch.length >= 20 && !isSlop(b) && planScore(b) >= 0.75;
}
function blockOf(kind: string, inner: string, ings: Ingredient[], source: Mix["source"]): Block | undefined {
  const j = tryJson(inner);
  if (kind === "build") { const b = normalizeBuild(j, ings, source); return b ? { t: "build", b } : undefined; }
  if (kind === "ask") {
    const q = plain(j?.q ?? j?.question ?? (j ? "" : inner.split("\n")[0]), 200);
    const options = strs(j?.options ?? j?.answers ?? j?.choices, 80, 5);
    return q && options.length ? { t: "ask", q, options } : undefined;
  }
  if (kind === "next") {
    const items = strs(Array.isArray(j) ? j : j?.items ?? j?.next ?? j?.followups ?? (j ? [] : inner), 120, 5);
    return items.length ? { t: "next", items } : undefined;
  }
  return undefined;
}
const tidy = (s: string) => s.replace(/^\s*```[a-z]*\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();

/**
 * A reply (complete or still streaming) → blocks. Text between tags streams as it comes; a block appears when its
 * closing tag arrives (a "pending" block stands in until then); a half-typed tag at the end is hidden. A reply with no
 * tags at all but JSON build objects (a model ignoring the format) is repaired into builds.
 */
export function parseReply(text: string, ings: Ingredient[], opts: { final?: boolean; source?: Mix["source"] } = {}): { blocks: Block[]; refs: Record<string, IngRef> } {
  const src = String(text ?? "");
  const source = opts.source ?? "claude";
  const blocks: Block[] = [];
  const pushText = (s: string) => { const t = tidy(s); if (!t) return; const last = blocks[blocks.length - 1]; if (last?.t === "text") last.md = `${last.md}\n\n${t}`; else blocks.push({ t: "text", md: t }); };
  const open = /<(build|ask|next)\s*>/gi;
  let i = 0;
  for (;;) {
    open.lastIndex = i;
    const m = open.exec(src);
    if (!m) break;
    pushText(src.slice(i, m.index));
    const kind = m[1].toLowerCase();
    const start = m.index + m[0].length;
    let close = src.toLowerCase().indexOf(`</${kind}>`, start);
    // A model that forgets closing tags: the next block's opening tag ends this one.
    open.lastIndex = start;
    const nextOpen = open.exec(src)?.index ?? -1;
    let skip = kind.length + 3;
    if (nextOpen >= 0 && (close < 0 || nextOpen < close)) { close = nextOpen; skip = 0; }
    if (close < 0) {
      // Unclosed: still streaming, or the model forgot the closing tag (only trusted at the very end).
      const b = opts.final ? blockOf(kind, src.slice(start), ings, source) : undefined;
      if (b) blocks.push(b); else if (!opts.final) blocks.push({ t: "pending", kind });
      i = src.length;
      break;
    }
    const b = blockOf(kind, src.slice(start, close), ings, source);
    if (b) blocks.push(b);
    i = close + skip;
  }
  let rest = src.slice(i);
  if (!opts.final) rest = rest.replace(/<\/?[a-z]{0,6}$/i, ""); // a tag being typed
  rest = rest.replace(new RegExp(`</?(?:${TAGS.join("|")})\\s*>`, "gi"), "");
  // No tags anywhere, but JSON objects with titles: a model that answered in the Mixer's shape.
  if (opts.final && !blocks.some((b) => b.t !== "text") && /\{\s*"title"/.test(rest)) {
    const objs = jsonObjects(rest);
    for (const o of objs) { const b = normalizeBuild(o.v, ings, source); if (b) blocks.push({ t: "build", b }); }
    if (objs.length) rest = objs.reduceRight((s, o) => s.slice(0, o.s) + s.slice(o.e), rest).replace(/"?(builds|mixes|ideas)"?\s*:\s*\[\s*,?\s*\]/g, "").replace(/^[\s{}[\],]+$/gm, "");
  }
  pushText(rest);
  // Inline [[names]] and every build's ingredients resolve to inventory items (the page draws them as chips).
  const refs: Record<string, IngRef> = {};
  for (const b of blocks) {
    if (b.t === "text") for (const mm of b.md.matchAll(/\[\[([^\]\n]{1,80})\]\]/g)) { const x = matchInv(mm[1], ings); if (x) refs[mm[1]] = { id: x.id, kind: x.kind, name: x.name }; }
    if (b.t === "build") b.b.ids.forEach((id, k) => { const x = ings.find((y) => y.id === id); if (x) refs[b.b.ingredients[k]] = { id, kind: x.kind, name: x.name }; });
  }
  return { blocks, refs };
}
/** Complete JSON objects with a "title" in a text (string-aware), outermost first, with their spans. */
function jsonObjects(t: string): { s: number; e: number; v: any }[] {
  const spans: { s: number; e: number }[] = [];
  const stack: number[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push(i);
    else if (c === "}" && stack.length) spans.push({ s: stack.pop()!, e: i + 1 });
  }
  const out: { s: number; e: number; v: any }[] = [];
  let covered = -1;
  for (const sp of spans.sort((a, b) => a.s - b.s)) {
    if (sp.s < covered) continue;
    const v = tryJson(t.slice(sp.s, sp.e));
    if (v && typeof v === "object" && typeof v.title === "string") { out.push({ ...sp, v }); covered = sp.e; }
  }
  return out;
}

/** The instant engine (and the fallback): the Mixer's template combiner, as builds. */
export function templateReply(ings: IngRef[] | Ingredient[], all: Ingredient[], seed: number, note?: string): BotMsg {
  const by = new Map(all.map((x) => [x.id, x]));
  const xs = (ings as (IngRef | Ingredient)[]).map((x) => by.get(x.id) ?? sanitizeIngredient(x)).filter((x): x is Ingredient => !!x);
  const pool = xs.length >= 2 ? xs : (composeDice(all, seed)?.ids ?? []).map((id) => by.get(id)!).filter(Boolean);
  const mixes = templateMixes(pool, "", seed, 3);
  const blocks: Block[] = [{ t: "text", md: note ?? (mixes.length ? `Three quick combinations of ${pool.map((x) => `[[${x.name}]]`).join(", ")}, made instantly without a model.` : "Pick two or more ingredients and I'll combine them.") }];
  for (const m of mixes) blocks.push({ t: "build", b: { ...m, extra: [] } });
  blocks.push({ t: "next", items: RIFFS.slice(0, 3) });
  const refs: Record<string, IngRef> = {};
  for (const x of pool) refs[x.name] = { id: x.id, kind: x.kind, name: x.name };
  return { role: "assistant", blocks, refs, engine: "template", at: Date.now() };
}

// ── the build prompt ("Build it now") ─────────────────────────────────────────────────
/** A folder name for a new project. */
export const slugOf = (s: string) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "new-idea";
/**
 * "Build it now": a complete implementation brief (the plan, the stack mapped to what you have, the tasks) for a new
 * coding session, and the folder it runs in: the project it lives in when that exists here, otherwise the projects
 * folder, with the brief asking for a new ~/Documents/Projects/<slug> (a session can only start in a folder that exists).
 */
export function buildPromptFor(b: Partial<Build>, projectsDir: string, folders: string[]): { prompt: string; cwd: string; label: string; folder: string } {
  const title = plain(b.title, 90) || "the idea";
  const projectNames = [b.project, ...(b.ids ?? []).filter((id) => id.startsWith("p:")).map((id) => id.slice(2))].filter((x): x is string => !!x);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const home = projectNames.map((n) => folders.find((f) => f === n) ?? folders.find((f) => norm(f) === norm(n))).find(Boolean);
  let slug = slugOf(title);
  if (!home && folders.includes(slug)) slug = `${slug}-app`;
  const pd = projectsDir.replace(HOME, "~");
  const folder = home ? `${pd}/${home}` : `${pd}/${slug}`;
  const L = (label: string, v?: string) => (v ? `${label}: ${plain(v, 260)}` : "");
  const list = (label: string, xs?: string[], numbered = false) => (xs?.length ? `## ${label}\n${xs.map((x, i) => `${numbered ? `${i + 1}.` : "-"} ${plain(x, 240)}`).join("\n")}` : "");
  const stack = (b.how ?? []).length ? (b.how ?? []).map((h) => `- ${plain(h.name, 80)}: ${plain(h.role, 200)}`) : (b.ingredients ?? []).map((x) => `- ${plain(x, 80)}`);
  const sections = [
    `Build this: "${title}"${b.pitch ? ` — ${plain(b.pitch, 240)}` : ""}`,
    "",
    "## The business",
    [L("Customer", b.customer), L("Problem", b.problem), L("Offer", b.offer), L("Pricing", [b.price, b.model].filter(Boolean).join(" · ")), L("Cost to run", b.cost), L("Time to first dollar", b.first_dollar), L("How it earns", b.money)].filter(Boolean).join("\n"),
    list("MVP scope", b.mvp),
    stack.length ? `## Stack (things I already have)\n${stack.join("\n")}` : "",
    b.extra?.length ? `New pieces it needs: ${b.extra.map((x) => plain(x, 60)).join(", ")}` : "",
    list("Launch: the first 10 customers", b.launch),
    list("First week", b.week?.length ? b.week : b.first_steps, true),
    list("Risks", b.risks),
    b.why_novel ? L("Why now", b.why_novel) : "",
    "",
    "## How to work",
    `1. ${home ? `You're in the ${home} project (${folder}); build it there.` : `Create ${folder} and build it there (git init; a README with the pitch and this plan).`} First read ~/wiki/index.md and the wiki pages of the projects involved (~/wiki/projects/<name>.md). What I have connected is listed in ~/.config/herdr-deck/CONNECTIONS.md (names only; never print secrets).`,
    "2. Write the plan to PLAN.md: milestones, what \"working\" means for the MVP, and the first-week tasks as a checklist. Then build the first milestone end to end: the smallest version a customer could actually use.",
    "3. Verify it for real (run it, test it, screenshot any UI) and tell me exactly how to try it, and which launch step I can do today. Don't deploy, publish, message anyone or spend money without asking me first.",
  ];
  return { prompt: sections.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim(), cwd: home ? `${projectsDir}/${home}` : projectsDir, label: `Build ${title.slice(0, 30)}`, folder };
}
