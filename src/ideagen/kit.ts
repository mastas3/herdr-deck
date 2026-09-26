// Starter kits: everything an idea needs to start building, generated lazily when a card is opened or played, cached
// per idea. The spec, architecture, build plan and go-to-market copy come from one Claude call; connectors, keys,
// scaffold, quests and the readiness meter are computed here from the user's real inventory (repos are checked with gh).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { GhRes } from "../discover";
import type { IdeaCard, Inventory, KitReadiness, KitTask, StarterKit } from "./types";
import type { ClaudeRunner } from "./llm";
import { CAP } from "./inventory";
import { builderSummary } from "./judge";
import { parseLoose, list, str } from "./json";

export const KIT_VERSION = "k1";
const HOME = homedir();
export const slugOf = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "idea";

// ── the deterministic half ───────────────────────────────────────────────────────────────
/** Which MCP servers and skills the user already has that help build this, by capability. */
const TOOLS: [string, RegExp, string][] = [
  ["payments", /^gumroad$/i, "create the product and read sales"], ["hosting", /^vercel$/i, "deploy previews and read logs"],
  ["db-auth", /^supabase$/i, "migrations and typed queries"], ["landing", /^codex-image$/i, "logo, OG image and app icon"],
  ["image-gen", /^codex-image$/i, "generate the product's images"], ["video", /^hyperframes$/i, "promo and product videos"],
  ["landing", /^playwright$/i, "check the landing page and checkout end to end"], ["llm", /^context7$/i, "current SDK docs while coding"],
  ["scraping", /^playwright$/i, "headless collection and tests"], ["search-api", /^last30days$/i, "fresh research on the buyer before launch"],
];
function mcpAndSkills(caps: string[], inv: Inventory) {
  const out: { name: string; use: string }[] = [];
  for (const [cap, re, use] of TOOLS) {
    if (!caps.includes(cap) && !(cap === "landing" && caps.includes("hosting"))) continue;
    const a = inv.assets.find((x) => x.owned && (x.kind === "mcp" || x.kind === "skill") && re.test(x.name));
    if (a && !out.some((o) => o.name === a.name)) out.push({ name: `${a.name} (${a.kind === "mcp" ? "MCP" : "skill"})`, use });
  }
  return out;
}
function keysFor(caps: string[], inv: Inventory) {
  const names = [...new Set(caps.flatMap((c) => CAP[c]?.keys ?? []))];
  return names.map((name) => { const k = inv.keys.find((x) => x.name === name); return { name, purpose: caps.find((c) => CAP[c]?.keys?.includes(name))!, have: !!k, where: k?.where }; });
}
function deployTarget(inv: Inventory) {
  const has = (re: RegExp) => inv.assets.some((a) => a.owned && a.ready && re.test(a.name));
  if (has(/^netlify$/i)) return "Netlify (npx netlify-cli deploy; the CLI is signed in)";
  if (has(/^vercel$/i)) return "Vercel (vercel deploy)";
  return "Cloudflare Pages (npx wrangler pages deploy)";
}
/** Does a GitHub repo exist? One core-API call per repo (not the search budget). */
export async function repoExists(url: string, gh: (args: string[], t?: number) => Promise<GhRes>): Promise<boolean> {
  const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!m) return false;
  const r = await gh([`repos/${m[1]}/${m[2].replace(/\.git$/, "")}`], 10_000);
  return r.ok && !!r.data?.full_name;
}
export function readiness(k: Omit<StarterKit, "readiness" | "judge" | "cost">): StarterKit["readiness"] {
  const items: KitReadiness[] = [
    { label: "Spec, architecture and build plan", status: k.buildPlan.length >= 3 ? "ready" : "missing" },
    ...k.connectors.repos.map((r): KitReadiness => ({ label: `Repo ${r.name}`, status: r.verified ? "ready" : "missing", how: r.verified ? undefined : "couldn't verify it exists; pick another" })),
    ...k.connectors.keys.map((x): KitReadiness => ({ label: `Key ${x.name}`, status: x.have ? "ready" : "needs-user", how: x.have ? `already set (${x.where})` : `create it and add it to .env` })),
    ...k.connectors.services.filter((s) => !s.have).map((s): KitReadiness => ({ label: `Sign up: ${s.name}`, status: "needs-user", how: s.url })),
    ...k.connectors.missing.map((m): KitReadiness => ({ label: `Missing: ${m.label}`, status: "missing", how: m.suggestions[0] ? `${m.suggestions[0].type}: ${m.suggestions[0].name}` : undefined })),
    { label: "Graphics (logo, OG image, icon)", status: "needs-user", how: "run the prompts in graphics/PROMPTS.md with the codex-image skill" },
    { label: "Checkout product", status: "needs-user", how: "create the product at the price in GTM.md (the Gumroad MCP can do it on request)" },
  ];
  const score = Math.round((items.filter((i) => i.status === "ready").length / items.length) * 100) / 100;
  return { score, items };
}

// ── the model half ───────────────────────────────────────────────────────────────────────────
export function kitPrompt(c: IdeaCard, inv: Inventory, deploy: string) {
  const system = "You are a senior engineer and a plain-spoken founder writing a starter kit a coding agent will build from. Everything must be specific to this product and this builder: real file names, real commands, real numbers. No placeholders (no TBD, Lorem, 'your product'), no hype words, no invented statistics. Strict JSON only: no prose, no Markdown fences.";
  const card = { name: c.name, hook: c.hook, buyer: c.buyer, pain: c.pain, evidence: c.evidence.map((e) => e.snippet), offer: c.offer, price: c.price, channel: c.channel, mvp: c.mvp,
    stack: c.stack.map((s) => ({ name: s.name, role: s.role, owned: s.owned, path: s.owned && inv.assets.find((a) => a.id === s.assetId)?.kind === "project" ? `~/Documents/Projects/${s.name}` : undefined })),
    have: c.connectors.filter((x) => !x.missing).map((x) => `${x.label}: ${x.have.map((h) => h.name).join(", ")}`), missing: c.missing.map((x) => x.label), trend: c.trend ? { name: c.trend.label, why_now: c.trend.whyNow } : undefined };
  const user = [
    "THE BUILDER", builderSummary(inv), `Deploy target: ${deploy}. Project folder: ~/Documents/Projects/${slugOf(c.name)}.`, "",
    "THE IDEA", JSON.stringify(card), "",
    "Write the kit. Rules:",
    "- spec: the problem in the buyer's words (use the evidence), jobs, what is in and out of v1, metrics tied to milestones (landing live, 10 conversations, first paying customer).",
    "- architecture: components naming which of the builder's projects/services does what (exact names), a data model, and the key flows as steps.",
    "- tasks: 5 to 8 ordered tasks, each small enough for one agent session, each with a prompt the builder can paste into Claude Code as-is (name files, commands and acceptance checks inside the prompt) and 2–3 acceptance checks.",
    "- landing: headline, subhead, 3 benefits, CTA — written for this buyer, in their language (Hebrew if the buyer is Hebrew-speaking).",
    "- pricing: 2–3 tiers with numbers consistent with the idea's price.",
    "- launch_posts: 3 posts, one per channel the builder has access to for this buyer; each reads like a person wrote it, no hashtags soup.",
    "- outreach: one message the builder sends personally to the first 10 prospects (it is never sent automatically).",
    "- Language: spec, architecture and tasks in English; landing, launch posts and outreach in the buyer's language.",
    "- No placeholders of any kind (no <bot_name>, no [link]): propose a concrete value and say to check it, e.g. \"@hd_atlas_bot (check it's free)\".",
    `- Deploy only to ${deploy.split(" (")[0]}; don't mention other hosts.`,
    "- When a task reads an external format (log files, an API, a scraped page), its prompt starts by inspecting a real sample (the exact command) before writing the parser.",
    "",
    'JSON shape: {"spec":{"problem":"","buyer":"","jobs":[],"scope_in":[],"scope_out":[],"metrics":[{"metric":"","target":"","milestone":""}]},"architecture":{"summary":"","components":[{"name":"","does":"","uses":""}],"data_model":[{"entity":"","fields":[]}],"flows":[{"name":"","steps":[]}]},"tasks":[{"id":"T1","title":"","size":"S","prompt":"","accept":[],"depends_on":[]}],"landing":{"headline":"","subhead":"","benefits":[],"cta":""},"pricing":[{"tier":"","price":"","includes":[]}],"launch_posts":[{"channel":"","text":""}],"outreach":""}',
  ].join("\n");
  return { system, user };
}
export function parseKitReply(text: string) {
  const j = parseLoose(text) ?? {};
  const tasks: KitTask[] = (Array.isArray(j.tasks) ? j.tasks : []).slice(0, 10).map((t: any, i: number) => ({
    id: str(t?.id, 8) || `T${i + 1}`, title: str(t?.title, 120), size: (["S", "M", "L"].includes(t?.size) ? t.size : "M") as KitTask["size"],
    prompt: str(t?.prompt, 2000), accept: list(t?.accept, 4, 200), dependsOn: list(t?.depends_on, 4, 8),
  })).filter((t: KitTask) => t.title && t.prompt);
  const a = j.architecture ?? {}, s = j.spec ?? {}, l = j.landing ?? {};
  return {
    spec: { problem: str(s.problem, 600), buyer: str(s.buyer, 300), jobs: list(s.jobs, 6), scopeIn: list(s.scope_in, 10), scopeOut: list(s.scope_out, 8), metrics: (Array.isArray(s.metrics) ? s.metrics : []).slice(0, 6).map((m: any) => ({ metric: str(m?.metric, 120), target: str(m?.target, 80), milestone: str(m?.milestone, 80) })) },
    architecture: { summary: str(a.summary, 600), components: (Array.isArray(a.components) ? a.components : []).slice(0, 10).map((x: any) => ({ name: str(x?.name, 60), does: str(x?.does, 200), uses: str(x?.uses, 120) })), dataModel: (Array.isArray(a.data_model) ? a.data_model : []).slice(0, 8).map((x: any) => ({ entity: str(x?.entity, 40), fields: list(x?.fields, 12, 60) })), flows: (Array.isArray(a.flows) ? a.flows : []).slice(0, 5).map((x: any) => ({ name: str(x?.name, 60), steps: list(x?.steps, 10, 200) })) },
    buildPlan: tasks,
    landing: { headline: str(l.headline, 120), subhead: str(l.subhead, 240), benefits: list(l.benefits, 3, 160), cta: str(l.cta, 60) },
    pricing: (Array.isArray(j.pricing) ? j.pricing : []).slice(0, 3).map((p: any) => ({ tier: str(p?.tier, 40), price: str(p?.price, 40), includes: list(p?.includes, 6, 120) })),
    launchPosts: (Array.isArray(j.launch_posts) ? j.launch_posts : []).slice(0, 3).map((p: any) => ({ channel: str(p?.channel, 80), text: str(p?.text, 1200) })),
    outreach: str(j.outreach, 1200),
  };
}

// ── building, caching, judging ───────────────────────────────────────────────────────────────
export type KitDeps = { inv: Inventory; claude: ClaudeRunner; gh: (args: string[], t?: number) => Promise<GhRes>; cacheDir: string; card: (id: string) => IdeaCard | undefined };
const kitFile = (d: KitDeps, id: string) => `${d.cacheDir}/kits/${id.replace(/[^\w.-]+/g, "_")}.json`;
/** The kit for an idea: cached, or built now (one Claude call plus a gh check per repo). */
export async function buildStarterKit(ideaId: string, d: KitDeps): Promise<StarterKit> {
  if (existsSync(kitFile(d, ideaId))) return JSON.parse(readFileSync(kitFile(d, ideaId), "utf8"));
  const c = d.card(ideaId);
  if (!c) throw new Error(`No idea ${ideaId} in the gallery`);
  const t0 = Date.now();
  const deploy = deployTarget(d.inv);
  const p = kitPrompt(c, d.inv, deploy);
  const r = await d.claude({ system: p.system, user: p.user, model: "sonnet", tag: `kit:${c.id}` });
  const m = parseKitReply(r.text);
  const caps = c.connectors.map((x) => x.cap);
  const repoSugs = c.connectors.flatMap((x) => x.suggestions).filter((s) => s.type === "repo" && s.url);
  const repos = await Promise.all(repoSugs.slice(0, 4).map(async (s) => ({ name: s.name, url: s.url!, why: s.why, verified: await repoExists(s.url!, d.gh) })));
  const ownedProjects = c.stack.filter((s) => s.owned && d.inv.assets.find((a) => a.id === s.assetId)?.kind === "project");
  const slug = slugOf(c.name);
  const base = ownedProjects[0] ? `copy the patterns (not the code wholesale) from ~/Documents/Projects/${ownedProjects[0].name}` : repos.find((x) => x.verified)?.url ?? "npm create astro@latest (Astro, as in the builder's hd2027-blog)";
  const kit: Omit<StarterKit, "readiness" | "judge" | "cost"> = {
    ideaId, slug, at: Date.now(), version: KIT_VERSION, spec: m.spec, architecture: m.architecture, buildPlan: m.buildPlan,
    connectors: {
      repos,
      services: c.connectors.flatMap((x) => [...x.have.filter((h) => h.id.startsWith("svc:") || h.id.startsWith("acct:")).map((h) => ({ name: h.name, url: "", why: x.label, have: true })), ...x.suggestions.filter((s) => s.type === "service").map((s) => ({ name: s.name, url: s.url ?? "", why: s.why, free: s.free, have: false }))])
        .filter((s, i, a) => a.findIndex((y) => y.name === s.name) === i),
      keys: keysFor(caps, d.inv), mcpAndSkills: mcpAndSkills(caps, d.inv), missing: c.missing,
    },
    scaffold: {
      folder: `~/Documents/Projects/${slug}`, base, deploy,
      files: [
        { path: "README.md", purpose: "what it is, who it's for, how to run it" }, { path: "CLAUDE.md", purpose: "agent instructions: stack, commands, rules, where the owned projects live" },
        { path: "AGENTS.md", purpose: "same instructions for Codex and other agents" }, { path: ".env.example", purpose: "the key names the project needs (no values)" },
        { path: "TASKS.md", purpose: "the build plan with paste-ready agent prompts and acceptance checks" }, { path: "SPEC.md", purpose: "the PRD" },
        { path: "ARCHITECTURE.md", purpose: "components, data model, flows" }, { path: "CONNECTORS.md", purpose: "repos, services, keys, MCP/skills, what's missing" },
        { path: "GTM.md", purpose: "landing copy, pricing, launch posts, outreach" }, { path: "QUESTS.md", purpose: "the play loop and how each quest is verified" },
        { path: "graphics/PROMPTS.md", purpose: "codex-image prompts for logo, OG image and icon" },
      ],
    },
    gtm: {
      landing: m.landing, pricing: m.pricing, launchPosts: m.launchPosts, outreach: m.outreach,
      graphics: [
        { asset: "logo", prompt: `Flat vector logo mark for "${c.name}": one simple symbol tied to ${c.topics[0] ?? "the product"}, two colours, no text, readable at 32 px, on white` },
        { asset: "og-image", prompt: `1200×630 social preview for "${c.name}": the headline "${m.landing.headline || c.hook}" in large clean type on a plain background, one small product screenshot, no stock people` },
        { asset: "app-icon", prompt: `512×512 app icon for "${c.name}": the logo mark centred on a solid colour square, rounded corners, no text` },
      ],
    },
    quests: c.play.quests.map((q) => ({ ...q, done: false })),
  };
  const full: StarterKit = { ...kit, readiness: readiness(kit), cost: { claudeCalls: 1, ms: Date.now() - t0 } };
  mkdirSync(`${d.cacheDir}/kits`, { recursive: true });
  writeFileSync(kitFile(d, ideaId), JSON.stringify(full, null, 1));
  return full;
}
/** One Claude call: could a coding agent start from this kit without asking questions? */
export async function judgeKit(k: StarterKit, claude: ClaudeRunner): Promise<NonNullable<StarterKit["judge"]>> {
  const system = "You are an engineering lead deciding whether a coding agent can start implementing from a starter kit without asking the human anything. Be strict. Strict JSON only.";
  const user = `KIT\n${JSON.stringify({ ...k, judge: undefined })}\n\nReply exactly: {"ready":1-5,"questions":["questions the agent would still have to ask"],"notes":"one or two sentences"} where 5 = an agent can start now and finish v1 without questions; 1 = too vague to start.`;
  const r = await claude({ system, user, model: "sonnet", tag: `kit-judge:${k.ideaId}` });
  const j = parseLoose(r.text) ?? {};
  return { ready: Math.max(1, Math.min(5, Number(j.ready) || 1)), questions: list(j.questions, 10, 240), notes: str(j.notes, 400) };
}
export const kitsHome = `${HOME}/.config/herdr-deck/ideas`;
