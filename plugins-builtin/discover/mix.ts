// The Mixer: combine your projects, found repos, connections, tools and interests into project ideas.
//
// Engines: headless Claude Code (`claude -p`, a small fast model, no tools) or a local Ollama model. Either one
// runs async with a timeout, streams its JSON back (cards appear as each mix is complete), and is validated and
// repaired; when the model is missing, slow or talks nonsense, a deterministic combiner fills in, so the page
// never hangs. Only the names and one-line descriptions of the chosen ingredients (and your optional direction)
// are sent to the model: no wiki pages, no secrets, no session content.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Gem, Profile, Repo } from "./discover";

const DAY = 86_400_000;

// ── types ─────────────────────────────────────────────────────────────────────
// Ingredients and their kinds are core (Opportunities builds its catalog from them too).
import { KIND_LABEL, type IngKind, type Ingredient } from "../../src/ingredients";
export { KIND_LABEL, type IngKind, type Ingredient } from "../../src/ingredients";
/** A connections-store item, as much of it as the mixer needs. */
export type ConnLite = { id: string; name: string; cat?: string; state?: string; detail?: string; kind?: string; hidden?: boolean };
export type Difficulty = "weekend" | "week" | "month";
export type Mix = {
  id: string; title: string; pitch: string;
  ingredients: string[]; // exact ingredient names
  ids: string[]; // the same ingredients' ids (kinds and colors on the page)
  how: { name: string; role: string }[];
  why_novel: string; first_steps: string[]; difficulty: Difficulty; wow: number;
  source: "claude" | "ollama" | "template";
};
export type Engine = "claude" | "ollama" | "template";

/** Store categories that are tools an agent uses rather than services a product is built on. */
const TOOL_CATS = new Set(["ai", "mcp", "skills"]);
/** Never ingredients: key names say nothing a model could build with. */
const SKIP_CATS = new Set(["keys"]);

// ── small helpers ──────────────────────────────────────────────────────────────
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").replace(/\/(?:Users|home)\/[^/\s]+/g, "~").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
/** FNV-1a: a short stable hash for cache keys and ids. */
export function hash(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
/** A small seeded PRNG, so the same day and selection give the same template mixes. */
function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
/** The local calendar day, "YYYY-MM-DD". */
export const dayOf = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ── ingredients ───────────────────────────────────────────────────────────────────
export type IngInput = { profile?: Profile; gems?: Gem[]; trending?: Gem[]; saved?: Repo[]; items?: ConnLite[]; catLabels?: Record<string, string> };
/** Everything you could mix, grouped by kind. Local only: nothing here is sent anywhere until you pick it. */
export function collectIngredients(inp: IngInput): Ingredient[] {
  const out: Ingredient[] = [];
  const seen = new Set<string>();
  const add = (x: Ingredient) => { const k = `${x.kind}:${norm(x.name)}`; if (!x.name || seen.has(k) || seen.has(x.id)) return; seen.add(k); seen.add(x.id); out.push(x); };
  const p = inp.profile;
  for (const x of p?.projects ?? []) {
    if (x.weight <= 0 || x.tags.includes("external") || ["dead", "archived"].includes(x.status)) continue;
    add({ id: `p:${x.name}`, kind: "project", name: x.name, desc: clip(x.tldr, 120), group: x.status, ready: true });
  }
  for (const r of [...(inp.gems ?? []).slice(0, 30), ...(inp.trending ?? []).slice(0, 12), ...(inp.saved ?? [])]) {
    add({ id: `r:${r.full}`, kind: "repo", name: r.full, desc: clip(r.desc, 120), group: r.lang, ready: true });
  }
  for (const i of inp.items ?? []) {
    if (i.hidden || SKIP_CATS.has(i.cat ?? "")) continue;
    const tool = TOOL_CATS.has(i.cat ?? "") || i.kind === "agent" || i.kind === "sub" || i.kind === "skill" || i.kind === "mcp";
    const ready = !i.state || i.state === "ready" || i.state === "installed";
    add({ id: `${tool ? "t" : "c"}:${i.id}`, kind: tool ? "tool" : "conn", name: clip(i.name, 60), desc: clip(i.detail, 110), group: inp.catLabels?.[i.cat ?? ""] ?? i.cat ?? "Other", ready });
  }
  for (const it of p?.interests ?? []) add({ id: `i:${it.id}`, kind: "interest", name: it.label, desc: it.projects.length ? clip(`From ${it.projects.slice(0, 3).join(", ")}`, 110) : it.source === "you" ? "You added this" : "", ready: true });
  return out;
}
/** What a model may see of an ingredient: its kind, name and a one-line description. Nothing else. */
export const sanitizeIngredient = (x: any): Ingredient | undefined => {
  const kind = String(x?.kind ?? "") as IngKind;
  if (!(kind in KIND_LABEL)) return undefined;
  const name = clip(x?.name, 80);
  if (!name) return undefined;
  return { id: clip(x?.id, 160) || `${kind[0]}:${name}`, kind, name, desc: clip(x?.desc, 140), group: x?.group ? clip(x.group, 40) : undefined, ready: x?.ready !== false };
};

// ── the prompt ──────────────────────────────────────────────────────────────────────
const KIND_WORD: Record<IngKind, string> = { project: "my project", repo: "open-source repo", conn: "service/connection I have", tool: "agent tool/skill I have", interest: "interest of mine" };
export function mixPrompt(ings: Ingredient[], direction = "", n = 6) {
  const system = "You invent surprising, buildable project ideas by combining a person's ingredients. You answer with strict JSON only: no prose, no Markdown, no code fences.";
  const list = ings.map((x) => `- ${x.name} (${KIND_WORD[x.kind]})${x.desc ? `: ${x.desc}` : ""}`).join("\n");
  const user = [
    `Ingredients (use these exact names):`, list, "",
    direction.trim() ? `Direction to steer every idea toward: "${clip(direction, 200)}"` : "No direction given: optimize for what is novel and genuinely useful.",
    "",
    `Invent ${n} different mixes. Each combines 2 to 4 of the ingredients above into one concrete product, tool or experiment a solo developer with coding agents could build. Every mix must use a different set of ingredients (never the same set twice), and across the ${n} mixes use every ingredient at least once. Prefer non-obvious pairings that create something neither part could do alone.`,
    "",
    'Reply with exactly this JSON shape: {"mixes":[{"title":"short catchy name","pitch":"one line: what it is and for whom","ingredients":["exact name","exact name"],"how":[{"name":"exact name","role":"what this ingredient contributes"}],"why_novel":"one sentence","first_steps":["step 1","step 2","step 3"],"difficulty":"weekend|week|month","wow":4}]}',
    "wow is 1 to 5 (how surprising and delightful). Keep every string short.",
  ].join("\n");
  return { system, user };
}

// ── parsing: validate and repair whatever the model sent ───────────────────────────────
/** Balanced JSON objects anywhere in the text (string-aware), outermost first; unclosed ones are skipped. */
function objectsIn(text: string): { s: number; e: number }[] {
  const found: { s: number; e: number }[] = [];
  const stack: number[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push(i);
    else if (c === "}" && stack.length) found.push({ s: stack.pop()!, e: i + 1 });
  }
  return found.sort((a, b) => a.s - b.s);
}
const loose = (t: string) => t.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1");
function tryJson(t: string): any { try { return JSON.parse(t); } catch { try { return JSON.parse(loose(t)); } catch { return undefined; } } }
/** The raw mix objects in a model's reply: whole JSON when it parses, otherwise every complete object with a title. */
export function rawMixes(text: string): any[] {
  const t = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const a = Math.min(...["{", "["].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
  const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (Number.isFinite(a) && b > a) {
    const j = tryJson(t.slice(a, b + 1));
    if (j) {
      const arr = Array.isArray(j) ? j : Array.isArray(j.mixes) ? j.mixes : Array.isArray(j.ideas) ? j.ideas : typeof j.title === "string" ? [j] : Object.values(j).find(Array.isArray) ?? [];
      if (arr.length) return arr.filter((x: any) => x && typeof x === "object");
    }
  }
  // Partial or broken: every complete object that looks like a mix (an outer {"mixes": [ that never closed is skipped).
  const out: any[] = [];
  let covered = -1;
  for (const { s, e } of objectsIn(t)) {
    if (s < covered) continue; // nested inside a mix we already have
    const j = tryJson(t.slice(s, e));
    if (j && typeof j === "object" && !Array.isArray(j) && typeof j.title === "string") { out.push(j); covered = e; }
  }
  return out;
}
/** Find which chosen ingredient a model meant by a name: exact, then the repo's short name, then loosely. */
export function matchIngredient(name: string, ings: Ingredient[]): Ingredient | undefined {
  const n = String(name ?? "").trim();
  if (!n) return undefined;
  const lc = n.toLowerCase(), nn = norm(n);
  return ings.find((x) => x.name.toLowerCase() === lc)
    ?? ings.find((x) => x.kind === "repo" && x.name.split("/")[1]?.toLowerCase() === lc)
    ?? ings.find((x) => norm(x.name) === nn || (x.kind === "repo" && norm(x.name.split("/")[1] ?? "") === nn))
    ?? (nn.length >= 4 ? ings.find((x) => { const xn = norm(x.name); return xn.length >= 4 && (xn.includes(nn) || nn.includes(xn)); }) : undefined);
}
const DIFFS: Difficulty[] = ["weekend", "week", "month"];
function difficultyOf(v: unknown, count: number): Difficulty {
  const s = String(v ?? "").toLowerCase();
  if (/weekend|day|hour|easy|small/.test(s)) return "weekend";
  if (/month|quarter|hard|large|big/.test(s)) return "month";
  if (/week|medium/.test(s)) return "week";
  return count <= 2 ? "weekend" : count === 3 ? "week" : "month";
}
function wowOf(v: unknown) { const m = String(v ?? "").match(/\d+(\.\d+)?/); const x = m ? Math.round(Number(m[0])) : 3; return Math.max(1, Math.min(5, x)); }
const strList = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x?.step ?? x?.text ?? x?.title ?? "")).map(String)
  : typeof v === "string" ? v.split(/\r?\n|(?<=\S)\s+(?=\d+[.)]\s)/).map((x) => x.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean) : [];
/** One raw object → a clean Mix, or nothing when it can't be trusted (unknown ingredients, no title). */
export function normalizeMix(raw: any, ings: Ingredient[], source: Mix["source"]): Mix | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const title = clip(raw.title ?? raw.name, 90);
  if (!title) return undefined;
  const names: unknown[] = Array.isArray(raw.ingredients) ? raw.ingredients : typeof raw.ingredients === "string" ? raw.ingredients.split(/,|\+| x | × /) : [];
  const picked: Ingredient[] = [];
  for (const v of names) { const m = matchIngredient(typeof v === "string" ? v : (v as any)?.name ?? "", ings); if (m && !picked.includes(m)) picked.push(m); }
  // "how" as [{name, role}], {name: role} or "name: role" lines; it can also name ingredients the list forgot.
  let how: { name: string; role: string }[] = [];
  const hv = raw.how ?? raw.contributions;
  if (Array.isArray(hv)) how = hv.map((h: any) => (typeof h === "string" ? { name: h.split(/[:—–-]\s/)[0], role: h.split(/[:—–-]\s/).slice(1).join(" - ") } : { name: String(h?.name ?? h?.ingredient ?? ""), role: String(h?.role ?? h?.contribution ?? h?.does ?? "") }));
  else if (hv && typeof hv === "object") how = Object.entries(hv).map(([k, v]) => ({ name: k, role: String(v) }));
  else if (typeof hv === "string") how = hv.split(/\r?\n|;\s/).map((l) => { const [k, ...r] = l.replace(/^[-*•]\s*/, "").split(/:\s|\s[—–-]\s/); return { name: k, role: r.join(" - ") }; });
  const hows: { name: string; role: string }[] = [];
  for (const h of how) {
    const m = matchIngredient(h.name, ings);
    if (!m) continue;
    if (!picked.includes(m) && picked.length < 4) picked.push(m);
    if (!hows.some((x) => x.name === m.name) && picked.includes(m)) hows.push({ name: m.name, role: clip(h.role, 180) || roleOf(m) });
  }
  const need = Math.min(2, ings.length);
  if (picked.length < need) return undefined;
  const use = picked.slice(0, 4);
  for (const m of use) if (!hows.some((x) => x.name === m.name)) hows.push({ name: m.name, role: roleOf(m) });
  const steps = strList(raw.first_steps ?? raw.steps ?? raw.firstSteps).map((x) => clip(x, 180)).filter(Boolean).slice(0, 3);
  return {
    id: hash(`${title}|${use.map((x) => x.id).join(",")}`), title, pitch: clip(raw.pitch ?? raw.summary ?? raw.description, 220),
    ingredients: use.map((x) => x.name), ids: use.map((x) => x.id), how: hows.filter((h) => use.some((m) => m.name === h.name)),
    why_novel: clip(raw.why_novel ?? raw.whyNovel ?? raw.why ?? raw.novelty, 240), first_steps: steps.length ? steps : stepsFor(use, ""),
    difficulty: difficultyOf(raw.difficulty ?? raw.effort, use.length), wow: wowOf(raw.wow ?? raw.score), source,
  };
}
/** A model's whole reply → clean, distinct mixes. */
export function parseMixes(text: string, ings: Ingredient[], source: Mix["source"]): Mix[] {
  const out: Mix[] = [];
  for (const r of rawMixes(text)) {
    const m = normalizeMix(r, ings, source);
    if (!m) continue;
    if (out.some((x) => x.title.toLowerCase() === m.title.toLowerCase())) continue;
    out.push(m);
  }
  return out;
}

// ── the deterministic combiner ───────────────────────────────────────────────────────
const short = (x: Ingredient) => (x.kind === "repo" ? x.name.split("/")[1] ?? x.name : x.name);
const lowerDesc = (x: Ingredient, n = 70) => { const d = clip(x.desc, n).replace(/\.$/, ""); return d ? d[0].toLowerCase() + d.slice(1) : ""; };
function roleOf(x: Ingredient): string {
  const d = lowerDesc(x, 90);
  switch (x.kind) {
    case "project": return `the product and its users${d ? `: ${d}` : ""}`;
    case "repo": return `the ready-made engine${d ? `: ${d}` : ""}`;
    case "conn": return `${x.group ? `the ${x.group.toLowerCase().replace(/ & .*/, "")} piece` : "the service it runs on"}${d ? `: ${d}` : ""}`;
    case "tool": return `builds and runs it${d ? `: ${d}` : ""}`;
    case "interest": return `the domain and audience it serves (${x.name})`;
  }
}
function stepFor(x: Ingredient, other?: Ingredient): string {
  switch (x.kind) {
    case "project": return `Open ${x.name} and mark the one place ${other ? short(other) : "the new part"} plugs in`;
    case "repo": return `Clone ${x.name} and run its smallest example`;
    case "conn": return `Make one test call to ${x.name} from a script`;
    case "tool": return `Ask ${x.name} to scaffold the glue code`;
    case "interest": return `Write down three things ${x.name} people would pay attention to`;
  }
}
function stepsFor(use: Ingredient[], direction: string): string[] {
  return [stepFor(use[0], use[1]), stepFor(use[1] ?? use[0], use[0]), `Wire them into one end-to-end demo${direction ? ` aimed at "${clip(direction, 60)}"` : ""} and show it to one real person`];
}
/** Title and pitch for a pair, by the kinds involved. */
function pairText(a: Ingredient, b: Ingredient): { title: string; pitch: string } {
  const [x, y] = [a, b].sort((p, q) => ORDER.indexOf(p.kind) - ORDER.indexOf(q.kind));
  const k = `${x.kind}+${y.kind}`;
  const dx = lowerDesc(x), dy = lowerDesc(y);
  switch (k) {
    case "project+project": return { title: `${x.name} meets ${y.name}`, pitch: `One product out of two of yours: ${dx || x.name}, fused with ${dy || y.name}.` };
    case "project+repo": return { title: `${short(y)} inside ${x.name}`, pitch: `Put ${y.name}${dy ? ` (${dy})` : ""} at the core of ${x.name} and ship the feature it unlocks.` };
    case "project+conn": return { title: `${x.name}, through ${y.name}`, pitch: `${x.name} delivered and powered by ${y.name}${dy ? ` (${dy})` : ""}, so it reaches people where they already are.` };
    case "project+tool": return { title: `${x.name} on autopilot`, pitch: `Let ${y.name} keep ${x.name} growing on its own: ${dx || "your project"}, maintained and extended by an agent.` };
    case "project+interest": return { title: `${x.name} for ${y.name}`, pitch: `Re-aim ${x.name} at ${y.name}: ${dx || "what you built"}, reshaped for that audience.` };
    case "repo+repo": return { title: `${short(x)} × ${short(y)}`, pitch: `Chain ${x.name} into ${y.name}: two engines that were never meant to meet${dx && dy ? ` (${dx}; ${dy})` : ""}.` };
    case "repo+conn": return { title: `${short(x)} on ${y.name}`, pitch: `Run ${x.name}${dx ? ` (${dx})` : ""} on ${y.name} and turn it into a service you can use from anywhere.` };
    case "repo+tool": return { title: `${short(x)}, agent-driven`, pitch: `Hand ${x.name} to ${y.name}: an agent that operates it for you${dx ? ` (${dx})` : ""}.` };
    case "repo+interest": return { title: `${short(x)} for ${y.name}`, pitch: `Point ${x.name}${dx ? ` (${dx})` : ""} at ${y.name} and see what only that combination can do.` };
    case "conn+conn": return { title: `${x.name} → ${y.name} bridge`, pitch: `Whatever lands in ${x.name} flows into ${y.name}, filtered and shaped on the way.` };
    case "conn+tool": return { title: `${y.name} runs your ${x.name}`, pitch: `An agent with ${y.name} that watches and works ${x.name}${dx ? ` (${dx})` : ""} for you.` };
    case "conn+interest": {
      const g = (x.group ?? "").toLowerCase();
      if (/media|creative/.test(g)) return { title: `${y.name}, made with ${x.name}`, pitch: `Turn ${y.name} into something people watch or hear, made with ${x.name}${dx ? ` (${dx})` : ""}.` };
      if (/cloud|deploy|data/.test(g)) return { title: `A ${y.name} app on ${x.name}`, pitch: `A small public ${y.name} app, hosted and stored on ${x.name}.` };
      if (/comm/.test(g)) return { title: `A ${y.name} feed on ${x.name}`, pitch: `A daily ${y.name} digest, delivered through ${x.name}.` };
      return { title: `${y.name} × ${x.name}`, pitch: `Use ${x.name}${dx ? ` (${dx})` : ""} for ${y.name}, in a way nobody in that space does yet.` };
    }
    case "tool+tool": return { title: `${x.name} + ${y.name} crew`, pitch: `Two agent tools as one crew: ${dx || x.name}, handing off to ${dy || y.name}.` };
    case "tool+interest": return { title: `An agent for ${y.name}`, pitch: `${x.name} as a research-and-build assistant that only thinks about ${y.name}.` };
    case "interest+interest": return { title: `Where ${x.name} meets ${y.name}`, pitch: `A small tool at the overlap of ${x.name} and ${y.name}, where few people are building.` };
  }
  return { title: `${x.name} × ${y.name}`, pitch: `${x.name} combined with ${y.name}.` };
}
const ORDER: IngKind[] = ["project", "repo", "conn", "tool", "interest"];
/** Mixes built from templates over ingredient kinds: instant, private, always available. */
export function templateMixes(ings: Ingredient[], direction = "", seed = 1, n = 6): Mix[] {
  const xs = ings.slice(0, 16);
  if (!xs.length) return [];
  const r = rng(seed * 2654435761 + xs.length);
  const combos: Ingredient[][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    combos.push([xs[i], xs[j]]);
    for (let k = j + 1; k < xs.length && combos.length < 400; k++) combos.push([xs[i], xs[j], xs[k]]);
  }
  if (xs.length === 1) combos.push([xs[0]]);
  const used = new Map<string, number>();
  const score = (c: Ingredient[]) => new Set(c.map((x) => x.kind)).size * 2 - c.reduce((a, x) => a + (used.get(x.id) ?? 0) * 1.6, 0) - (c.length === 3 ? 0.6 : 0) + r() * 0.9;
  const out: Mix[] = [];
  const dir = clip(direction, 80);
  while (out.length < n && combos.length) {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < combos.length; i++) { const s = score(combos[i]); if (s > bs) { bs = s; bi = i; } }
    const c = combos.splice(bi, 1)[0];
    for (const x of c) used.set(x.id, (used.get(x.id) ?? 0) + 1);
    const [a, b = a, third] = c;
    const t = a === b ? { title: `${a.name}, remixed`, pitch: `A new angle on ${a.name}${a.desc ? `: ${lowerDesc(a)}` : ""}.` } : pairText(a, b);
    if (third) t.title = `${t.title} + ${short(third)}`;
    if (out.some((m) => m.title === clip(t.title, 90))) continue;
    const kinds = new Set(c.map((x) => x.kind)).size;
    out.push({
      id: hash(`t|${t.title}|${c.map((x) => x.id).join(",")}`), title: clip(t.title, 90),
      pitch: clip(`${t.pitch}${third ? ` Plus ${short(third)} as ${roleOf(third).split(":")[0]}.` : ""}${dir ? ` Aimed at: ${dir}.` : ""}`, 260),
      ingredients: c.map((x) => x.name), ids: c.map((x) => x.id), how: c.map((x) => ({ name: x.name, role: roleOf(x) })),
      why_novel: kinds >= 2 ? `It joins a ${KIND_WORD[a.kind]} with a ${KIND_WORD[b.kind]}${third ? ` and a ${KIND_WORD[third.kind]}` : ""}, a pairing you haven't built yet.` : "Two things of the same kind, pushed further together than either goes alone.",
      first_steps: stepsFor(c, dir), difficulty: c.length <= 2 ? "weekend" : "week", wow: Math.min(5, 1 + kinds + (c.length === 3 ? 1 : 0)), source: "template",
    });
  }
  return out;
}

// ── "Mixes for you": what the daily mix is made of, and when it's due ─────────────────────────
/** Your strongest interests, most alive projects, a couple of gems and some ready connections. */
export function forYouIngredients(all: Ingredient[], seed: number): Ingredient[] {
  const r = rng(seed * 40503 + 7);
  const take = <T>(xs: T[], k: number) => { const a = [...xs]; const out: T[] = []; while (a.length && out.length < k) out.push(a.splice(Math.floor(r() * Math.min(a.length, k + 2)), 1)[0]); return out; };
  const of = (k: IngKind) => all.filter((x) => x.kind === k && x.ready);
  const conns = of("conn").filter((x) => !/device|network|browser/i.test(x.group ?? ""));
  const byGroup = new Map<string, Ingredient>();
  for (const c of conns) if (!byGroup.has(c.group ?? "")) byGroup.set(c.group ?? "", c);
  return [...take(of("interest").slice(0, 5), 3), ...take(of("project").slice(0, 6), 3), ...take(of("repo").slice(0, 6), 2), ...take([...byGroup.values()], 3)];
}
export type Daily = { day: string; at: number; status: "running" | "done" | "error"; mixes?: Mix[]; engine?: string; model?: string; note?: string };
/** At most once per calendar day: a run that started today (finished, failed or still going) blocks another. */
export const dailyDue = (last: Daily | undefined, now: number) => !last || last.day !== dayOf(now);

// ── cache keys ──────────────────────────────────────────────────────────────────────
export const mixKey = (ids: string[], direction: string, engine: string) => hash(`${engine}|${[...new Set(ids)].sort().join(",")}|${String(direction ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`);

// ── engines: headless Claude Code and Ollama (core: Opportunities, Research and the Library run them too) ──
import { claudeInstalled, ollamaModels, runClaude, runOllama } from "../../src/model-run";
export { ollamaModels, runClaude, runOllama, type RunOpts } from "../../src/model-run";

// ── jobs, cache, the daily mix ───────────────────────────────────────────────────────────
export type Job = {
  id: string; key: string; engine: Engine; model?: string; started: number; finished?: number;
  status: "running" | "done" | "error" | "cancelled"; stage: string; mixes: Mix[]; note?: string; error?: string;
  ings: Ingredient[]; direction: string; abort: AbortController;
};
type CacheEntry = { at: number; engine: Engine; model?: string; mixes: Mix[]; note?: string; ms?: number };
export type MixerDeps = {
  file: string; // where results are cached
  runClaude?: typeof runClaude; runOllama?: typeof runOllama; ollamaModels?: typeof ollamaModels; claudeAvailable?: () => boolean;
  timeouts?: { claude: number; ollama: number };
};
const MAX_ENTRIES = 40;

export function createMixer(deps: MixerDeps) {
  const TEST = process.env.NODE_ENV === "test";
  const rc = deps.runClaude ?? (TEST ? async () => { throw new Error("no model in tests"); } : runClaude);
  const ro = deps.runOllama ?? (TEST ? async () => { throw new Error("no model in tests"); } : runOllama);
  const om = deps.ollamaModels ?? (TEST ? async () => [] : ollamaModels);
  // Tests never reach a real model unless they pass one in.
  const hasClaude = deps.claudeAvailable ?? (() => claudeInstalled() && process.env.NODE_ENV !== "test");
  const T = deps.timeouts ?? { claude: 60_000, ollama: 120_000 };
  const read = () => { try { return JSON.parse(readFileSync(deps.file, "utf8")); } catch { return undefined; } };
  const store: { entries: Record<string, CacheEntry>; daily?: Daily } = { entries: {}, ...read() };
  let saveT: ReturnType<typeof setTimeout> | undefined;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(flush, 300); };
  function flush() { clearTimeout(saveT); try { mkdirSync(deps.file.replace(/\/[^/]+$/, ""), { recursive: true }); const tmp = `${deps.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(store)); renameSync(tmp, deps.file); } catch {} }
  const jobs = new Map<string, Job>();
  let modelsCache: { at: number; list: string[] } | undefined;
  async function engines() {
    if (!modelsCache || Date.now() - modelsCache.at > 60_000) modelsCache = { at: Date.now(), list: await om() };
    return { claude: hasClaude(), ollama: modelsCache.list };
  }

  /** Run one engine over the ingredients; fill with templates on failure; returns the finished job. */
  function start(ings: Ingredient[], direction: string, engine: Engine, model?: string, key = mixKey(ings.map((x) => x.id), direction, `${engine}${model ? `:${model}` : ""}`), onDone?: (j: Job) => void): Job {
    const job: Job = { id: crypto.randomUUID().slice(0, 12), key, engine, model, started: Date.now(), status: "running", stage: "Starting…", mixes: [], ings, direction, abort: new AbortController() };
    jobs.set(job.id, job);
    for (const [id, j] of jobs) if (j.status !== "running" && Date.now() - (j.finished ?? j.started) > 10 * 60_000) jobs.delete(id);
    const n = 6;
    const seed = Number.parseInt(hash(`${key}|${Date.now()}`), 36) % 100000;
    (async () => {
      let reason = "";
      if (engine === "template") job.stage = "Combining…";
      else {
        const { system, user } = mixPrompt(ings, direction, n);
        let lastParse = 0, latest = "";
        const onText = (all: string) => {
          latest = all;
          if (Date.now() - lastParse < 200) return;
          lastParse = Date.now();
          const got = parseMixes(all, ings, engine);
          if (got.length > job.mixes.length) { job.mixes = got; job.stage = `Mixed ${got.length} of ${n}…`; }
        };
        const timer = setTimeout(() => { reason = "timeout"; job.abort.abort(); }, engine === "ollama" ? T.ollama : T.claude);
        try {
          const run = engine === "ollama" ? ro : rc;
          const r = await run({ system, user, timeoutMs: engine === "ollama" ? T.ollama : T.claude, signal: job.abort.signal, onText, onStage: (s) => { if (!job.mixes.length) job.stage = s; }, model });
          job.model = r.model;
          job.mixes = parseMixes(r.text, ings, engine);
          if (!job.mixes.length) reason = "unreadable";
        } catch (e: any) {
          if (!reason) reason = job.abort.signal.aborted ? "cancelled" : "error";
          job.error = e?.message ?? String(e);
          // Whatever complete mixes arrived before the time limit still count.
          const got = parseMixes(latest, ings, engine);
          if (got.length > job.mixes.length) job.mixes = got;
        } finally { clearTimeout(timer); }
      }
      if (reason === "cancelled") { job.status = "cancelled"; job.finished = Date.now(); onDone?.(job); return; }
      // Never leave you with nothing: templates fill whatever the model didn't deliver.
      if (job.mixes.length < 3) {
        const fill = templateMixes(ings, direction, seed, n).filter((t) => !job.mixes.some((m) => m.title === t.title));
        job.mixes = [...job.mixes, ...fill].slice(0, n);
        if (engine !== "template") job.note = reason === "timeout" ? `${engine === "ollama" ? "Ollama" : "Claude"} took too long, so quick template mixes fill in.` : reason === "unreadable" ? "The model's answer couldn't be read, so these are quick template mixes." : `${job.error ?? "The model isn't available"}. These are quick template mixes.`;
      } else if (reason === "timeout") job.note = "Stopped at the time limit: these are the mixes that were done.";
      job.status = "done"; job.finished = Date.now(); job.stage = "Done";
      if (engine !== "template" && job.mixes.some((m) => m.source !== "template")) {
        store.entries[key] = { at: Date.now(), engine, model: job.model, mixes: job.mixes, note: job.note, ms: job.finished - job.started };
        const keys = Object.keys(store.entries);
        if (keys.length > MAX_ENTRIES) for (const k of keys.sort((a, b) => store.entries[a].at - store.entries[b].at).slice(0, keys.length - MAX_ENTRIES)) delete store.entries[k];
        save();
      }
      onDone?.(job);
    })();
    return job;
  }
  const view = (j: Job) => ({ id: j.id, key: j.key, engine: j.engine, model: j.model, started: j.started, finished: j.finished, elapsed: (j.finished ?? Date.now()) - j.started, status: j.status, stage: j.stage, mixes: j.mixes, note: j.note, error: j.error });

  return {
    engines,
    cached: (key: string) => store.entries[key],
    /** Mix, from the cache when this exact selection, direction and engine ran before (unless forced). */
    mix(ings: Ingredient[], direction: string, engine: Engine, model?: string, force = false) {
      const key = mixKey(ings.map((x) => x.id), direction, `${engine}${model ? `:${model}` : ""}`);
      const c = store.entries[key];
      if (c && !force) return { key, cached: true, result: { ...c, key } };
      for (const j of jobs.values()) if (j.key === key && j.status === "running") return { key, job: view(j) };
      return { key, job: view(start(ings, direction, engine, model, key)) };
    },
    peek(ings: Ingredient[], direction: string, engine: Engine, model?: string) { const key = mixKey(ings.map((x) => x.id), direction, `${engine}${model ? `:${model}` : ""}`); const c = store.entries[key]; return c ? { key, cached: true, result: { ...c, key } } : { key }; },
    status(id: string) { const j = jobs.get(id); if (!j) throw new Error("That mix is gone (the deck restarted?). Mix again."); return view(j); },
    cancel(id: string) { const j = jobs.get(id); if (j && j.status === "running") { j.abort.abort(); j.status = "cancelled"; j.finished = Date.now(); } return j ? view(j) : { status: "cancelled" }; },
    /** The daily "Mixes for you": generated at most once a day, in the background, only when asked. */
    daily(ings: Ingredient[], now = Date.now(), wait = false) {
      const seed = Math.floor(now / DAY);
      const templates = templateMixes(ings, "", seed, 5);
      const d = store.daily;
      if (dailyDue(d, now) && ings.length >= 3 && !wait) {
        const engine: Engine | undefined = hasClaude() ? "claude" : modelsCache?.list.length ? "ollama" : undefined;
        if (engine) {
          store.daily = { day: dayOf(now), at: now, status: "running", mixes: d?.mixes, engine };
          save();
          start(ings, "", engine, undefined, `daily|${dayOf(now)}`, (j) => {
            const good = j.mixes.filter((m) => m.source !== "template");
            store.daily = { day: dayOf(now), at: Date.now(), status: good.length ? "done" : "error", mixes: good.length ? j.mixes.slice(0, 6) : d?.mixes, engine, model: j.model, note: good.length ? undefined : j.note ?? j.error };
            save();
          });
        }
      }
      const cur = store.daily;
      const running = cur?.status === "running" && Date.now() - cur.at < 3 * 60_000;
      return { mixes: cur?.mixes?.length ? cur.mixes : templates, generated: !!cur?.mixes?.length, running, waiting: wait && dailyDue(cur, now), day: cur?.day, engine: cur?.engine, model: cur?.model, note: cur?.note, at: cur?.at };
    },
    flush,
    _store: store,
  };
}
export type Mixer = ReturnType<typeof createMixer>;
