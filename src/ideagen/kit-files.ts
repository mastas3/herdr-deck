// Writing a starter kit to disk as a project folder. Only called after the user confirms Play/Begin: it creates the
// folder with docs an agent can start from, and never writes key values (only names in .env.example).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import type { StarterKit } from "./types";

/** What a kit writes, in order (Play's confirm dialog lists them before anything is written). */
export const KIT_FILES = ["README.md", "CLAUDE.md", "AGENTS.md", ".env.example", "SPEC.md", "ARCHITECTURE.md", "TASKS.md", "CONNECTORS.md", "GTM.md", "QUESTS.md", "graphics/PROMPTS.md", "kit.json"];
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
function renderKit(k: StarterKit, name: string): Record<string, string> {
  const c = k.connectors;
  const agent = [
    `# ${name}`, "", k.spec.problem, "",
    "## How to work here", "",
    `- Read SPEC.md, ARCHITECTURE.md and TASKS.md first; do the tasks in order and tick them off in TASKS.md.`,
    `- Base: ${k.scaffold.base}. Deploy: ${k.scaffold.deploy}.`,
    `- Secrets: names are in .env.example; values live in .env (never commit it, never print values).`,
    `- Never post, send messages or charge anyone on the user's behalf; draft and ask.`,
    ...(c.mcpAndSkills.length ? ["", "## Tools you have", "", bullets(c.mcpAndSkills.map((t) => `${t.name}: ${t.use}`))] : []),
  ].join("\n");
  const files: Record<string, string> = {
    "README.md": [`# ${name}`, "", k.spec.problem, "", `**For:** ${k.spec.buyer}`, "", "## Start", "", "1. Read CLAUDE.md (agents read it automatically).", "2. Copy .env.example to .env and fill in the keys marked missing in CONNECTORS.md.", "3. Work through TASKS.md; play the quests in QUESTS.md."].join("\n"),
    "CLAUDE.md": agent,
    "AGENTS.md": agent,
    ".env.example": [`# Key names ${name} needs. Values go in .env, never here.`, ...c.keys.map((x) => `${x.name}=${x.have ? `  # you already have it: ${x.where}` : "  # missing: create it"}`)].join("\n"),
    "SPEC.md": [`# Spec: ${name}`, "", "## Problem", "", k.spec.problem, "", "## Buyer", "", k.spec.buyer, "", "## Jobs", "", bullets(k.spec.jobs), "", "## In scope (v1)", "", bullets(k.spec.scopeIn), "", "## Out of scope", "", bullets(k.spec.scopeOut), "", "## Success metrics", "", "| metric | target | milestone |", "|---|---|---|", ...k.spec.metrics.map((m) => `| ${m.metric} | ${m.target} | ${m.milestone} |`)].join("\n"),
    "ARCHITECTURE.md": [`# Architecture: ${name}`, "", k.architecture.summary, "", "## Components", "", "| component | does | uses |", "|---|---|---|", ...k.architecture.components.map((x) => `| ${x.name} | ${x.does} | ${x.uses} |`), "", "## Data model", "", ...k.architecture.dataModel.map((e) => `- **${e.entity}**: ${e.fields.join(", ")}`), "", "## Flows", "", ...k.architecture.flows.flatMap((f) => [`### ${f.name}`, "", ...f.steps.map((s, i) => `${i + 1}. ${s}`), ""])].join("\n"),
    "TASKS.md": [`# Build plan: ${name}`, "", ...k.buildPlan.flatMap((t) => [`## [ ] ${t.id} ${t.title} (${t.size})${t.dependsOn.length ? ` — after ${t.dependsOn.join(", ")}` : ""}`, "", "Agent prompt:", "", "```", t.prompt, "```", "", "Done when:", "", bullets(t.accept), ""])].join("\n"),
    "CONNECTORS.md": [`# Connectors: ${name}`, "", "## Repos", "", ...(c.repos.length ? c.repos.map((r) => `- ${r.verified ? "✓" : "✗ unverified"} [${r.name}](${r.url}) — ${r.why}`) : ["- none needed beyond your own projects"]), "", "## Services", "", ...c.services.map((s) => `- ${s.have ? "have" : "sign up"}: ${s.name}${s.url ? ` (${s.url})` : ""} — ${s.why}${s.free ? ` · ${s.free}` : ""}`), "", "## Keys (names only)", "", ...c.keys.map((x) => `- ${x.name}: ${x.have ? `have (${x.where})` : "missing"}`), "", "## MCP servers & skills", "", ...c.mcpAndSkills.map((t) => `- ${t.name}: ${t.use}`), "", "## Still missing", "", ...(c.missing.length ? c.missing.flatMap((m) => [`- **${m.label}**`, ...m.suggestions.map((s) => `  - ${s.type}: ${s.name}${s.url ? ` (${s.url})` : ""} — ${s.how}`)]) : ["- nothing"])].join("\n"),
    "GTM.md": [`# Go to market: ${name}`, "", "## Landing page", "", `# ${k.gtm.landing.headline}`, "", k.gtm.landing.subhead, "", bullets(k.gtm.landing.benefits), "", `**${k.gtm.landing.cta}**`, "", "## Pricing", "", ...k.gtm.pricing.map((p) => `- **${p.tier} — ${p.price}**: ${p.includes.join("; ")}`), "", "## Launch posts (post them yourself)", "", ...k.gtm.launchPosts.flatMap((p) => [`### ${p.channel}`, "", p.text, ""]), "## First-10 outreach (send it yourself; nothing is sent automatically)", "", k.gtm.outreach].join("\n"),
    "QUESTS.md": [`# Quests: ${name}`, "", ...k.quests.map((q, i) => `${i + 1}. [ ] **${q.title}** — verified when ${q.verify}`), "", "## Conversation log", "", "| date | who | where | their words |", "|---|---|---|---|"].join("\n"),
    "graphics/PROMPTS.md": [`# Graphics prompts (codex-image skill)`, "", ...k.gtm.graphics.flatMap((g) => [`## ${g.asset}`, "", g.prompt, ""])].join("\n"),
    "kit.json": JSON.stringify(k, null, 1),
  };
  return files;
}
/** Write the kit into `dir` (refuses a non-empty folder unless overwrite). Returns the files written. */
export function materializeKit(k: StarterKit, name: string, dir: string, o: { overwrite?: boolean } = {}): string[] {
  if (existsSync(dir) && readdirSync(dir).length && !o.overwrite) throw new Error(`${dir} already exists and isn't empty`);
  const files = renderKit(k, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = `${dir}/${rel}`;
    mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(p, body.endsWith("\n") ? body : `${body}\n`);
  }
  return Object.keys(files);
}
