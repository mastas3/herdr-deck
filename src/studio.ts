// Studio: a chat that assembles things out of everything you have (projects, gems, connections, tools, interests).
//
// The model sees a compact catalog of the inventory (names and one-liners only: no wiki bodies, no secrets, no
// session content), the trimmed conversation so far, and your message. It answers in plain text with rich blocks
// (<build>, <ask>, <next>) that are parsed and repaired while they stream, so the page can draw cards as they
// complete. Engines: headless Claude Code (fast Haiku or deeper Sonnet), a local Ollama model, or the instant
// template combiner from the Mixer. Every run has a time limit; when a model is missing, slow or unreadable,
// template builds fill in, so a question never ends in nothing. Conversations live in <dataDir>/studio/<id>.json.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { hash, KIND_LABEL, runClaude, runOllama, sanitizeIngredient, templateMixes, type Ingredient, type IngKind, type Mix } from "./mix";
import { composeDice, fillStarters, INTENTS, RIFFS, SYSTEM } from "./studio-prompts";

const HOME = homedir();

// ── privacy: what may reach a model ─────────────────────────────────────────────────
/** Secret-looking strings out, home paths shortened. Belt and braces: the inventory holds names, not values. */
export function redact(s: unknown): string {
  return String(s ?? "")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "~")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[abprs]-|AKIA|AIza|ya29\.|glpat-|hf_)[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS))\s*[=:]\s*\S+/g, "$1")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
}
const clip = (s: unknown, n: number) => { const t = redact(s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
/** Store entries that say nothing a build could use: launchd jobs, browser profiles, SSH aliases, plan details. */
const NOISE_DESC = /^(background service|homebrew service|ssh host|chrome profile|brave profile)|subscription|\bplan$|sign-in$/i;
const BLANK_DESC = /^(>-?|\|)?$|^(local|remote) mcp server$/i;
const descOf = (x: Ingredient, n: number) => (BLANK_DESC.test(x.desc.trim()) ? "" : clip(x.desc, n));

// ── the catalog: the whole inventory, compact ───────────────────────────────────────────
/** Names and one-liners, grouped by kind and category. Only ready things (you can't build on what isn't set up). */
export function buildCatalog(ings: Ingredient[], maxChars = 18_000): string {
  const ready = ings.filter((x) => x.ready && x.name && !NOISE_DESC.test(x.desc.trim()));
  const of = (k: IngKind) => ready.filter((x) => x.kind === k);
  const render = (d: { p: number; r: number; c: number; t: number }) => {
    const out: string[] = ["# His inventory (use these exact names)"];
    const projects = of("project").filter((x) => !["legacy", "note"].includes(x.group ?? "")).slice(0, 70);
    if (projects.length) out.push("", `## ${KIND_LABEL.project} (name [status]: what it is)`, ...projects.map((x) => `- ${clip(x.name, 60)} [${x.group ?? "?"}]${descOf(x, d.p) ? `: ${descOf(x, d.p)}` : ""}`));
    const repos = of("repo").slice(0, 30);
    if (repos.length) out.push("", "## Open-source repos he found (gems & trending on GitHub)", ...repos.map((x) => `- ${clip(x.name, 70)}${descOf(x, d.r) ? `: ${descOf(x, d.r)}` : ""}`));
    for (const [k, title, n] of [["conn", "Services & connections he has, by category", d.c], ["tool", "Agent tools, models, MCP servers & skills", d.t]] as const) {
      const xs = of(k);
      if (!xs.length) continue;
      const groups = new Map<string, Ingredient[]>();
      for (const x of xs) groups.set(x.group ?? "Other", [...(groups.get(x.group ?? "Other") ?? []), x]);
      out.push("", `## ${title}`);
      for (const [g, ys] of groups) out.push(`- ${clip(g, 40)}: ${ys.slice(0, 45).map((x) => { const dd = descOf(x, n); return dd ? `${clip(x.name, 50)} (${dd})` : clip(x.name, 50); }).join("; ")}`);
    }
    const ints = of("interest");
    if (ints.length) out.push("", "## His interests", `- ${ints.map((x) => clip(x.name, 40)).join("; ")}`);
    return out.join("\n");
  };
  // Shorter descriptions until it fits: the names always stay.
  for (const d of [{ p: 110, r: 80, c: 40, t: 50 }, { p: 80, r: 60, c: 28, t: 32 }, { p: 50, r: 40, c: 0, t: 0 }, { p: 0, r: 0, c: 0, t: 0 }]) {
    const s = render(d);
    if (s.length <= maxChars) return s;
  }
  return render({ p: 0, r: 0, c: 0, t: 0 }).slice(0, maxChars);
}

// ── conversations ──────────────────────────────────────────────────────────────────
export type IngRef = { id: string; kind: IngKind; name: string };
/** The plan that makes a build ready to execute (all optional: the chat keeps a thinner build, the feed doesn't). */
export type Plan = { customer?: string; problem?: string; offer?: string; price?: string; model?: string; mvp?: string[]; launch?: string[]; week?: string[]; cost?: string; first_dollar?: string; risks?: string[] };
export type Build = Mix & Plan & { extra: string[]; project?: string; money?: string; row?: string };
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
const GENERIC = /\b(ai[- ]powered platform|leverag\w*|synerg\w*|revolutioni[sz]\w*|seamless\w*|cutting[- ]edge|one[- ]stop|all[- ]in[- ]one solution|next[- ]gen\w*)\b/i;
/** How complete the plan is, 0..1 (the feed shows the best first). */
export function planScore(b: Build): number {
  const checks = [b.customer, b.problem, b.offer, b.price && /\d/.test(b.price), b.model, (b.mvp?.length ?? 0) >= 3, b.ids.length >= 2, (b.launch?.length ?? 0) >= 1, (b.week?.length ?? 0) >= 3, b.cost, b.first_dollar, b.risks?.length];
  return checks.filter(Boolean).length / checks.length;
}
/** The feed's quality gate: a specific customer, a real price, a buildable MVP on his real inventory, a launch and a week of tasks; nothing generic. */
export function isExecutable(b: Build): boolean {
  return !!b.customer && b.customer.length >= 12 && !!b.price && /\d/.test(b.price) && (b.mvp?.length ?? 0) >= 3 && b.ids.length >= 2
    && (b.launch?.length ?? 0) >= 1 && (b.week?.length ?? 0) >= 3 && !!b.pitch && b.pitch.length >= 20 && !GENERIC.test(`${b.title} ${b.pitch}`) && planScore(b) >= 0.75;
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

// ── the store and the jobs ─────────────────────────────────────────────────────────────
export type StudioDeps = {
  dir: string; projectsDir: string;
  ingredients: (wait?: number) => Promise<Ingredient[]>;
  engines: () => Promise<{ claude: boolean; ollama: string[] }>;
  runClaude?: typeof runClaude; runOllama?: typeof runOllama;
  timeouts?: { haiku: number; sonnet: number; ollama: number };
};
export type Engine = "claude" | "ollama" | "template";
type Job = { id: string; convo: string; engine: Engine; model?: string; started: number; firstAt?: number; finished?: number; status: "running" | "done" | "error" | "cancelled"; stage: string; text: string; msg?: BotMsg; err?: string; abort: AbortController; ings: Ingredient[] };
const ID = /^[a-z0-9]{6,24}$/;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

export function createStudio(deps: StudioDeps) {
  const TEST = process.env.NODE_ENV === "test";
  const rc = deps.runClaude ?? (TEST ? async () => { throw new Error("no model in tests"); } : runClaude);
  const ro = deps.runOllama ?? (TEST ? async () => { throw new Error("no model in tests"); } : runOllama);
  const T = deps.timeouts ?? { haiku: 75_000, sonnet: 120_000, ollama: 150_000 };
  const file = (id: string) => `${deps.dir}/${id}.json`;
  const jobs = new Map<string, Job>();

  function read(id: string): Convo | undefined {
    if (!ID.test(id)) return undefined;
    try { const c = JSON.parse(readFileSync(file(id), "utf8")); return c && Array.isArray(c.messages) ? c : undefined; } catch { return undefined; }
  }
  function write(c: Convo) {
    mkdirSync(deps.dir, { recursive: true });
    const tmp = `${file(c.id)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, file(c.id));
  }
  function list() {
    let names: string[] = [];
    try { names = readdirSync(deps.dir).filter((f) => /^[a-z0-9]{6,24}\.json$/.test(f)); } catch {}
    return names.map((f) => read(f.slice(0, -5))).filter((c): c is Convo => !!c)
      .map((c) => ({ id: c.id, title: c.title, updated: c.updated, turns: c.messages.filter((m) => m.role === "user").length, running: [...jobs.values()].some((j) => j.convo === c.id && j.status === "running") }))
      .sort((a, b) => b.updated - a.updated).slice(0, 200);
  }
  const runningFor = (id: string) => [...jobs.values()].find((j) => j.convo === id && j.status === "running");
  const view = (j: Job) => {
    const live = j.msg ? { blocks: j.msg.blocks, refs: j.msg.refs } : parseReply(j.text, j.ings, { final: false, source: j.engine === "ollama" ? "ollama" : "claude" });
    return { id: j.id, convo: j.convo, engine: j.engine, model: j.model, status: j.status, stage: j.stage, elapsed: (j.finished ?? Date.now()) - j.started, firstMs: j.firstAt ? j.firstAt - j.started : undefined, ...live, message: j.msg };
  };

  async function send(body: { id?: string; text?: string; use?: unknown[]; engine?: string; model?: string }) {
    const text = String(body.text ?? "").trim().slice(0, 4000);
    const all = await deps.ingredients(800);
    const by = new Map(all.map((x) => [x.id, x]));
    const use: IngRef[] = (Array.isArray(body.use) ? body.use : []).slice(0, 16).map((x: any) => by.get(String(x?.id ?? "")) ?? sanitizeIngredient(x))
      .filter((x): x is Ingredient => !!x).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i).map((x) => ({ id: x.id, kind: x.kind, name: x.name }));
    if (!text && !use.length) throw new Error("Say what you want to make, or add some ingredients");
    let c = body.id ? read(String(body.id)) : undefined;
    if (body.id && !c && !ID.test(String(body.id))) throw new Error("Which conversation?");
    if (c && runningFor(c.id)) throw new Error("Still answering the last message. Stop it first, or wait a moment.");
    if ([...jobs.values()].filter((j) => j.status === "running").length >= 3) throw new Error("Three answers are already being written. Try again in a moment.");
    const now = Date.now();
    if (!c) c = { id: ID.test(String(body.id ?? "")) ? String(body.id) : newId(), title: clip(text || `Mix: ${use.map((x) => x.name).join(" + ")}`, 70), created: now, updated: now, messages: [] };
    const history = c.messages.slice();
    c.messages.push({ role: "user", text, use, at: now });
    c.updated = now;
    write(c);
    const engine: Engine = body.engine === "ollama" || body.engine === "template" ? body.engine : "claude";
    const model = engine === "claude" ? (body.model === "sonnet" ? "sonnet" : "haiku") : engine === "ollama" ? (body.model ? String(body.model).slice(0, 80) : undefined) : undefined;
    const job: Job = { id: newId(), convo: c.id, engine, model, started: now, status: "running", stage: "Starting…", text: "", abort: new AbortController(), ings: all };
    jobs.set(job.id, job);
    for (const [k, j] of jobs) if (j.status !== "running" && Date.now() - (j.finished ?? j.started) > 15 * 60_000) jobs.delete(k);
    run(job, c.id, history, text, use);
    return { convo: summary(c), job: view(job) };
  }

  async function run(job: Job, convoId: string, history: Msg[], text: string, use: IngRef[]) {
    const all = job.ings;
    const seed = Number.parseInt(hash(`${convoId}|${job.started}`), 36) % 100000;
    let msg: BotMsg;
    if (job.engine === "template") msg = templateReply(use, all, seed);
    else {
      let reason = "";
      const limit = job.engine === "ollama" ? T.ollama : job.model === "sonnet" ? T.sonnet : T.haiku;
      const timer = setTimeout(() => { reason = "timeout"; job.abort.abort(); }, limit);
      const source = job.engine === "ollama" ? "ollama" : "claude";
      try {
        const opts = {
          // A small local model reads a shorter catalog (faster to load, easier to follow).
          system: `${SYSTEM}\n\n${buildCatalog(all, job.engine === "ollama" ? 9000 : 18_000)}`, user: turnPrompt(history, text, use), timeoutMs: limit, signal: job.abort.signal, model: job.model, json: false,
          onText: (t: string) => { if (!job.firstAt) { job.firstAt = Date.now(); job.stage = "Writing…"; } job.text = t; },
          onStage: (s: string) => { if (!job.firstAt) job.stage = s; },
        };
        const r = await (job.engine === "ollama" ? ro : rc)(opts);
        job.model = r.model;
        job.text = r.text;
      } catch (e: any) {
        if (!reason) reason = job.abort.signal.aborted ? "cancelled" : "error";
        job.stage = reason;
        if (reason === "error") job.err = e?.message ?? String(e);
      } finally { clearTimeout(timer); }
      const got = parseReply(job.text, all, { final: true, source });
      const hasBody = got.blocks.some((b) => b.t === "build" || (b.t === "text" && b.md.length > 40));
      const who = job.engine === "ollama" ? "Ollama" : "Claude";
      if (reason === "cancelled") msg = { role: "assistant", ...got, engine: job.engine, model: job.model, at: Date.now(), stopped: true, note: got.blocks.length ? "Stopped: this is what arrived before you pressed Stop." : "Stopped." };
      else if (!hasBody) {
        const why = reason === "timeout" ? `${who} took too long` : reason === "error" ? clip(job.err || `${who} isn't available`, 160) : `${who}'s answer couldn't be read`;
        msg = { ...templateReply(use, all, seed, `${why}, so here are quick template combinations instead. Try again, or switch the engine.`), error: reason === "error" ? clip(job.err, 200) : undefined };
        msg.note = why;
      } else {
        msg = { role: "assistant", ...got, engine: job.engine, model: job.model, at: Date.now(), note: reason === "timeout" ? "Stopped at the time limit: this is what was done." : undefined };
        // A small local model often answers in plain words only: quick combinations of the same things come with it.
        if (!got.blocks.some((b) => b.t === "build") && use.length >= 2) {
          const t = templateReply(use, all, seed);
          msg.blocks.push(...t.blocks.filter((b) => b.t === "build"));
          Object.assign(msg.refs, t.refs);
          msg.note = `${who} answered without builds, so quick template combinations of your picks are added.`;
        }
        if (!msg.blocks.some((b) => b.t === "next")) msg.blocks.push({ t: "next", items: RIFFS.slice(0, 3) });
      }
    }
    job.finished = Date.now();
    msg.ms = job.finished - job.started;
    if (job.firstAt) msg.firstMs = job.firstAt - job.started;
    msg.engine = job.engine;
    job.msg = msg;
    const c = read(convoId);
    if (c) { c.messages.push(msg); c.updated = Date.now(); try { write(c); } catch {} }
    job.status = msg.stopped ? "cancelled" : "done";
    job.stage = "Done";
  }
  const summary = (c: Convo) => ({ id: c.id, title: c.title, updated: c.updated, turns: c.messages.filter((m) => m.role === "user").length });

  let folders: { at: number; list: string[] } | undefined;
  const projectFolders = () => {
    if (!folders || Date.now() - folders.at > 60_000) { let l: string[] = []; try { l = readdirSync(deps.projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch {} folders = { at: Date.now(), list: l }; }
    return folders.list;
  };

  return {
    list, read, send,
    /** Everything the Studio's first screen needs: conversations, the starter deck, what you have, the engines. */
    async home(body: { seed?: number; wait?: number } = {}) {
      const [all, engines] = await Promise.all([deps.ingredients(Math.min(15_000, Number(body.wait) || 2500)), deps.engines()]);
      const seed = Number(body.seed) || Math.floor(Date.now() / 86_400_000);
      const counts = Object.fromEntries((["project", "repo", "conn", "tool", "interest"] as IngKind[]).map((k) => [k, all.filter((x) => x.kind === k && x.ready).length]));
      // No services or tools yet: the connections scan is still running (the page asks again, waiting longer).
      return { convos: list(), starters: fillStarters(all, seed), intents: INTENTS, riffs: RIFFS, counts, engines, seed, partial: !counts.conn && !counts.tool };
    },
    get(id: string) {
      const c = read(id);
      if (!c) throw new Error("That conversation is gone");
      const j = runningFor(id);
      return { ...c, job: j ? view(j) : undefined };
    },
    status(id: string) { const j = jobs.get(id); if (!j) throw new Error("That answer is gone (the deck restarted?). Send it again."); return view(j); },
    stop(id: string) { const j = jobs.get(id); if (j?.status === "running") j.abort.abort(); return j ? view(j) : { status: "cancelled" }; },
    rename(id: string, title: string) { const c = read(id); if (!c) throw new Error("That conversation is gone"); c.title = clip(title, 80) || c.title; write(c); return { convos: list() }; },
    remove(id: string) { if (!ID.test(id)) throw new Error("Which conversation?"); for (const j of jobs.values()) if (j.convo === id && j.status === "running") j.abort.abort(); try { rmSync(file(id), { force: true }); } catch {} return { convos: list() }; },
    async dice(seed: number, wild: boolean) { const all = await deps.ingredients(800); const d = composeDice(all, Number(seed) || Date.now() % 1e6, wild); if (!d) throw new Error("Not enough ingredients yet to roll the dice"); return d; },
    buildPrompt(b: Partial<Build>) { return buildPromptFor(b, deps.projectsDir, projectFolders()); },
    _jobs: jobs,
  };
}
export type Studio = ReturnType<typeof createStudio>;
