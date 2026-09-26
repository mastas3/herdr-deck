// Studio's words: the assembler's system prompt, the starter-prompt deck (templates with ingredient slots filled
// from your real inventory), and the Dice / Wildcard composers. Pure data and pure functions: no I/O, so the
// whole deck is unit-tested against the inventory's real shape (test/studio.test.ts).
import type { Ingredient, IngKind } from "./mix";

// ── the build: an execution-ready business, app or service ──────────────────────────────
const WHO = `Stas is a solo developer in Israel who ships fast with coding agents (Claude Code, Codex) on a Mac, a Linux laptop and an Android phone, all on one Tailscale network. His audiences: the Human Design and 2027-prophecy community (Hebrew, Russian, English), creators, indie developers and small Israeli businesses. His inventory is listed below: his own projects, open-source repos he found, services and connections that are set up, agent tools and skills, and his interests.
Demand worth building on: Human Design buyers already pay $19 to $149 for reports, readings and courses; the 2027 prophecy is widely searched; Hebrew- and Russian-language tools are underserved; creators pay for clips, captions and repurposing; Israeli small businesses pay for anything that saves paperwork or finds them customers.`;
/** One build block: everything needed to start executing tomorrow morning. Shared by the chat and the feed. */
export const BUILD_SCHEMA = `<build>{"title":"product name","pitch":"one line: what it is, for whom","customer":"a specific segment and where they hang out online","problem":"their pain, concretely","offer":"what they get","price":"concrete numbers, e.g. $19 one-off or $9/month","model":"subscription | one-off | service | usage | ads | affiliate","mvp":["3 to 6 scope bullets"],"ingredients":["exact inventory name","exact inventory name"],"how":[{"name":"exact inventory name","role":"what it does in the stack"}],"new":["outside piece it needs, if any"],"launch":["how to get the first 10 customers: the channel and the exact first post or message"],"week":["5 to 7 concrete first-week tasks"],"cost":"rough monthly cost to run","first_dollar":"time to first dollar, e.g. 2 weeks","risks":["main risk"],"size":"weekend|week|month","wow":4,"project":"the one of his projects it lives in, or empty"}</build>`;
/** The bar every build must clear (the page drops ones that don't: see isExecutable in studio.ts). */
export const RUBRIC = `Quality bar (check every build before writing it; replace any that fails, never output a failing one):
- A real, specific customer you could message today (not "everyone", not "businesses"), a concrete price with numbers, and a plausible path to the first dollar within weeks.
- Feasible for one person with agents: the MVP fits in two weeks, and at least two of his real inventory items do real work in the stack (named exactly as in the inventory).
- Specific over generic: name the real mechanism (what data flows where, what the customer sees, what runs on a schedule). Never "an AI-powered platform that leverages synergies".
- Surprising but sensible: non-obvious pairings that make something neither part could do alone. Reuse what exists before inventing.
- OSINT tools only on public or consented data, used defensively. Nothing that needs credentials he doesn't have.
- Be brief: a pitch under 20 words; each list item under 16 words; launch items name the channel and the first message; week tasks are verbs you can do in an hour or two. Plain text inside blocks (no [[brackets]], no Markdown).`;

// ── the assembler (the chat) ──────────────────────────────────────────────────────────────
export const SYSTEM = `You are the Studio assembler inside "herdr deck", a private dashboard: a sharp, inventive product partner. ${WHO} Your job is to assemble ready-to-execute businesses, apps and services out of that inventory.

How to answer:
- Start with 1 to 3 short sentences of plain talk to him ("you", "your"; Markdown allowed). Wrap every inventory item you mention there in double brackets, exactly as named: [[yt-transcriber]], [[Telegram]].
- Then give 2 builds (3 only if he asks for more or for variations), each as one <build> block, each combining 2 to 5 inventory items (mix kinds: a project with a service, a repo, a tool). Up to 2 outside pieces go in "new".
- If the request is genuinely ambiguous, add one <ask> block with a short question and 2 to 4 tappable answers. Otherwise skip it.
- End with one <next> block: 3 or 4 follow-ups written as he would type them (short, specific, varied: go deeper, go wilder, go cheaper, ship it).
- Follow-up turns: when he says "riff", "wilder", "cheaper" or picks an answer, build on the conversation so far instead of starting over.

Block formats (valid JSON inside the tags, nothing else inside; no code fences):
${BUILD_SCHEMA}
<ask>{"q":"short question","options":["answer","answer","answer"]}</ask>
<next>["follow-up","follow-up","follow-up"]</next>

${RUBRIC}`;

// ── the feed ("Ideas for you" on Discover) ───────────────────────────────────────────────
export type FeedRow = { id: string; label: string; hue: number; brief: string };
export const FEED_ROWS: FeedRow[] = [
  { id: "money", label: "Make money this month", hue: 150, brief: "earns its first dollar within 30 days: a productized service, a paid tool or a digital product" },
  { id: "saas", label: "SaaS for your audience", hue: 265, brief: "subscription software for one of his audiences (the HD / 2027 community in Hebrew, Russian or English, creators, indie devs, small Israeli businesses)" },
  { id: "automations", label: "Automations that sell", hue: 205, brief: "a done-for-you automation or agent he sells to businesses or runs as a paid service" },
  { id: "content", label: "Content engines", hue: 28, brief: "a machine that makes content (video, voice, posts, newsletters) and grows an audience that pays" },
  { id: "projects", label: "Built from your projects", hue: 330, brief: "turns one of his existing projects (name it in \"project\") into a product with paying users" },
  { id: "gem", label: "Remix a gem", hue: 250, brief: "forks one of the open-source repos he found into a product people pay for" },
  { id: "weekend", label: "Weekend builds", hue: 55, brief: "shippable in one weekend, still with a real customer and a price" },
  { id: "wild", label: "Wild combos", hue: 310, brief: "an unexpected pairing of his things that still has a real, paying customer" },
];
/** The first view: six calls in parallel, two rows each (~72 ideas before the critic, which keeps about half). */
export const FEED_BATCHES: string[][] = [["money", "saas"], ["automations", "content"], ["projects", "gem"], ["weekend", "wild"], ["money", "content"], ["saas", "automations"]];
export const FEED_SYSTEM = `You write a feed of ready-to-execute business, app and service ideas for one person. ${WHO}

Answer with <build> blocks only: no prose before, between or after them. Every block also carries "row": the id of the row it belongs to.
${BUILD_SCHEMA.replace('"project":', '"row":"row id","project":')}

${RUBRIC}
- Every idea in the batch is different: a different customer, product and combination. No two ideas share a title or the same set of ingredients.
- Plausibly profitable: strangers pay for it. Not a tool for himself, his friends or one of his personal creative projects (films, games about friends) unless there is a clear market for it.
- Titles are product names only (no "(SaaS)" or "(App)" labels).`;
/** The quality gate's second pass: a harsh, cheap critic scores the batch; weak ideas leave the feed. */
export const JUDGE_SYSTEM = `You are a harsh early-stage investor and product critic. Score each idea from 1 to 10 on one question: would a solo developer with coding agents get paying customers for this within a month, using the stack listed? Reward: a specific, reachable customer; a price they would really pay; a small, clear MVP; a fresh angle. Punish (4 or less): vague or generic ideas, customers who are "everyone", tools only the founder would use, personal or friends-only projects, gimmicks nobody pays for, near-duplicates of an earlier idea in the list. Answer with JSON only, nothing else: {"scores":[{"i":1,"s":7},{"i":2,"s":3}]}`;
export function judgePrompt(ideas: { title: string; pitch: string; customer?: string; price?: string; ingredients: string[]; mvp?: string[] }[]): string {
  return `Score these ${ideas.length} ideas:\n\n${ideas.map((x, i) => `${i + 1}. ${x.title}: ${x.pitch} | customer: ${x.customer ?? "?"} | price: ${x.price ?? "?"} | stack: ${x.ingredients.join(", ")} | MVP: ${(x.mvp ?? []).join("; ")}`).join("\n")}`;
}
/** The critic's scores, from JSON or anything shaped like it. */
export function parseScores(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of String(text ?? "").matchAll(/"i"\s*:\s*(\d+)\s*,\s*"s"\s*:\s*(\d+(?:\.\d+)?)/g)) out.set(Number(m[1]), Math.max(1, Math.min(10, Number(m[2]))));
  return out;
}
/** One batch: which rows, how many each, the starting combinations (one per idea) and the titles already in the feed. */
export function feedPrompt(rows: FeedRow[], perRow: number, combos: string[][], avoid: string[]): string {
  return [
    `Write ${perRow * rows.length} ideas: ${perRow} for each of these rows.`,
    ...rows.map((r) => `- row "${r.id}" (${r.label}): ${r.brief}`),
    "",
    combos.length ? `Sparks from his inventory, one per idea. They are only sparks: keep the parts that make a real business, swap the rest for better items from his inventory, and drop a spark entirely if it can't make one:\n${combos.map((c, i) => `${i + 1}. ${c.join(" + ")}`).join("\n")}` : "",
    avoid.length ? `\nAlready in his feed, so don't repeat these or near-copies of them: ${avoid.slice(0, 80).join("; ")}` : "",
  ].join("\n").trim();
}

// ── the starter deck ────────────────────────────────────────────────────────────
export type Intent = { id: string; label: string; hue: number };
export const INTENTS: Intent[] = [
  { id: "money", label: "Make money", hue: 150 },
  { id: "audience", label: "Grow an audience", hue: 28 },
  { id: "automate", label: "Automate my life", hue: 205 },
  { id: "weird", label: "Weird & wonderful", hue: 310 },
  { id: "weekend", label: "Weekend hack", hue: 55 },
  { id: "hd", label: "For my HD community", hue: 275 },
  { id: "ship", label: "Ship something today", hue: 350 },
  { id: "gem", label: "Remix a gem", hue: 250 },
  { id: "machines", label: "Cross-machine power", hue: 180 },
  { id: "local", label: "Local & private", hue: 120 },
];

/**
 * Slots: {kind[@Group][#status][~regex]}. kind is project, repo, conn, tool or interest; @Group matches the store
 * category (or a project's status) by prefix; #status a project's status; ~regex the name, description or group.
 * A template whose slots can't all be filled from what you have is simply left out.
 */
export const STARTERS: [intent: string, text: string][] = [
  // Make money
  ["money", "Turn {project~2027|prophecy|astra} into something people pay $19 for this month, sold through {conn@Commerce~gumroad|shopify}. What's the smallest version that sells?"],
  ["money", "Package {project~yt-transcriber} as a paid service for creators, delivered through {conn@Communication~telegram|whatsapp|resend}. What would they actually pay for?"],
  ["money", "What could earn money on autopilot from {project#active} + {conn@Commerce} + {tool@Skills~last30days|deep-research}?"],
  ["money", "Which of my projects is closest to making money, and what single missing feature would close the gap?"],
  ["money", "Turn my {interest~human design|astrology|esoteric} know-how into a $9 / $39 / $149 product ladder built from what I already have."],
  ["money", "{project~tender|gov} is launched: design a paid alert tier businesses would subscribe to, with alerts on {conn@Communication~whatsapp|telegram|gmail}."],
  ["money", "A productized service I could sell to small businesses with {project~geo-audit|bizgen} + {conn@Search~last30days|serper|brave}."],
  // Grow an audience
  ["audience", "Turn {project~story-reel|yt-transcriber} + {conn@Media~elevenlabs|hyperframes|higgsfield} into a daily vertical video that grows a following without me touching it."],
  ["audience", "A free viral tool built from {project~bodygraph-3d|react-bodygraph} that pulls people into {project~astra|hd-atlas|2027}."],
  ["audience", "Mine {conn@Search~last30days|youtube} for what people ask about {interest} and turn the answers into a weekly show."],
  ["audience", "A Hebrew + Russian content engine on {conn@Communication~telegram|x \\(twitter\\)} fed by {project~hd2027-blog|hd-atlas}."],
  ["audience", "Build in public on autopilot: {conn@Knowledge~llm wiki|obsidian} + {conn@Communication~x \\(twitter\\)|telegram} + {project~stasmaksin}."],
  // Automate my life
  ["automate", "Every morning on my phone via {conn@Communication~telegram|whatsapp}: what my agents did overnight, what needs me, and one thing trending in {interest}."],
  ["automate", "Let {tool@AI~^claude code$|^codex$} watch {conn@Code~github} and fix small issues while I sleep, with proof it works before I wake up."],
  ["automate", "Everything I read or watch lands in {conn@Knowledge~llm wiki|obsidian} and gets linked to the project it helps."],
  ["automate", "Turn {conn@Communication~gmail|mail} into a to-do list my agents act on, with {tool~^jev$} deciding what deserves my time."],
  ["automate", "A calendar-aware assistant: {conn@Communication~calendar} + {project~stasclaw|hebrew-hermes} that plans my build time around my energy."],
  // Weird & wonderful
  ["weird", "What happens when {repo} meets {project#active}? Give me the strangest thing that actually works."],
  ["weird", "Make {interest~human design|astrology} audible: a generative soundscape driven by {project~hd-core|bodygraph-3d|astra}."],
  ["weird", "A game where {interest~esoteric|astrology|human design|osint} is the core mechanic, built with {conn@Media~godot}."],
  ["weird", "{project~gods-eye|worldscope} but for something joyful instead of intelligence. What would it watch?"],
  ["weird", "Turn {project~viktor|falafel} into a character who lives in {conn@Communication~telegram|whatsapp} and talks back."],
  ["weird", "An oracle in 3D: {project~esoteric-rag|hd-atlas} answers, {repo~splat|three|3d} renders the answer as a place you can walk into."],
  // Weekend hack
  ["weekend", "What can I build this weekend with only what I already have? Ready to show by Sunday night."],
  ["weekend", "A two-day prototype that fuses {repo} with {project#active}."],
  ["weekend", "The most impressive demo I can make in 48 hours with {conn@Media~elevenlabs|higgsfield|blender|godot} and {tool@Skills~frontend-design|mobile-web-game|hyperframes-animation}."],
  ["weekend", "Revive {project#stale} in one weekend: what's the smallest version worth shipping?"],
  // For my HD community
  ["hd", "Something the Hebrew HD Facebook group would share, built from {conn~facebook group} insights and {project~bodygraph-3d|hd-atlas|astra}."],
  ["hd", "A daily transit ritual for my HD audience on {conn@Communication~telegram|whatsapp}, calculated by {project~hd-core|human-design-core|astra}."],
  ["hd", "\"Ask the teacher\": answers in a creator's own voice for my HD community, from {conn~youtube rag} + {conn@Media~elevenlabs}."],
  ["hd", "A bodygraph moment people screenshot and post: {project~bodygraph-3d|react-bodygraph} + {conn@Media~hyperframes|cloudinary}."],
  ["hd", "Relationship readings people send to their partner: {project~future-match|zdainu} meets {project~hd-atlas|astra}."],
  ["hd", "Turn the 2027 prophecy into a countdown people check every day, powered by {project~astra|hd-core}."],
  // Ship something today
  ["ship", "What's the smallest useful thing I can ship today with {project#active} and {conn@Cloud~vercel|netlify|cloudflare}?"],
  ["ship", "Put a public version of {project#stale} live on {conn@Cloud~cloudflare|vercel|netlify} in three hours. What do I cut?"],
  ["ship", "Give {project#launched} one new feature today that users would notice."],
  ["ship", "Turn {project~herdr-deck|geo-audit|yt-transcriber|hd-core|bizgen} into a one-prompt install anyone can paste into their own agent."],
  // Remix a gem
  ["gem", "Fork {repo} and remix it into something for {interest}."],
  ["gem", "Which of my gems pairs best with {project#active}? Show me the build."],
  ["gem", "{repo} + {repo}: two open-source engines that were never meant to meet. What do they make together?"],
  ["gem", "Wrap {repo} as an MCP server my agents can call, and show me the first thing they'd do with it."],
  // Cross-machine power
  ["machines", "Use my Mac, my Linux laptop and my phone as one machine over {conn~^tailscale$}: heavy jobs on Linux, control from the phone. What should run where?"],
  ["machines", "A job queue that sends {project~yt-transcriber|story-reel} renders to whichever of my machines is idle."],
  ["machines", "Turn my Android phone into a sensor and remote for my agents with {conn~android sdk} + {conn~^tailscale$}."],
  ["machines", "What could {project~herdr-deck} show on a TV, a watch or a lock screen that I'd glance at every day?"],
  // Local & private
  ["local", "Something powerful that runs 100% local with {tool~^ollama$}: no cloud, no keys, nothing leaves the Mac."],
  ["local", "A private assistant for {interest} using {project~hebrew-hermes|stasclaw} and local models."],
  ["local", "A private archive of my own life: {conn@Communication~^messages$|^notes$|^mail$} + {conn@Knowledge~llm wiki|obsidian}, searchable and mine."],
  ["local", "A private RAG over {project~esoteric-rag|hd-atlas} that my phone can ask over {conn~^tailscale$}."],
];

// ── filling slots ───────────────────────────────────────────────────────────────
export type Part = { text: string } | { ing: { id: string; kind: IngKind; name: string } };
export type Starter = { id: string; intent: string; text: string; parts: Part[]; ids: string[] };
type Slot = { kind: IngKind; group?: string; status?: string; re?: RegExp };
const SLOT = /\{(project|repo|conn|tool|interest)(?:@([^}~#]+))?(?:#([a-z-]+))?(?:~([^}]+))?\}/g;

/** A small seeded PRNG: the same seed gives the same deck, so Shuffle is just a new seed. */
export function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
const h32 = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

function candidates(all: Ingredient[], s: Slot): Ingredient[] {
  return all.filter((x) => x.kind === s.kind && x.ready
    && (!s.group || (x.group ?? "").toLowerCase().startsWith(s.group.toLowerCase()))
    && (!s.status || x.group === s.status)
    && (!s.re || s.re.test(x.name) || s.re.test(`${x.desc} ${x.group ?? ""}`)));
}
/** Pick from the first few candidates (they come ranked: liveliest projects, best gems first). A name match beats a description match. */
function pick(all: Ingredient[], s: Slot, used: Set<string>, r: () => number): Ingredient | undefined {
  let xs = candidates(all, s).filter((x) => !used.has(x.id) && !used.has(`name:${x.name.toLowerCase()}`));
  if (s.re) { const byName = xs.filter((x) => s.re!.test(x.name)); if (byName.length) xs = byName; }
  if (!xs.length) return undefined;
  const top = xs.slice(0, s.re ? 3 : 6);
  return top[Math.floor(r() * top.length)];
}
const lite = (x: Ingredient) => ({ id: x.id, kind: x.kind, name: x.name });

/** One template, filled from the inventory; undefined when a slot has nothing to fill it. */
export function fillTemplate(tpl: string, all: Ingredient[], r: () => number): { text: string; parts: Part[]; ids: string[] } | undefined {
  const parts: Part[] = [];
  const used = new Set<string>();
  let last = 0;
  for (const m of tpl.matchAll(SLOT)) {
    const [, kind, group, status, re] = m;
    let rx: RegExp | undefined;
    try { rx = re ? new RegExp(re, "i") : undefined; } catch { return undefined; }
    const x = pick(all, { kind: kind as IngKind, group: group?.trim(), status, re: rx }, used, r);
    if (!x) return undefined;
    used.add(x.id); used.add(`name:${x.name.toLowerCase()}`);
    if (m.index! > last) parts.push({ text: tpl.slice(last, m.index) });
    parts.push({ ing: lite(x) });
    last = m.index! + m[0].length;
  }
  if (last < tpl.length) parts.push({ text: tpl.slice(last) });
  return { text: partsText(parts), parts, ids: parts.flatMap((p) => ("ing" in p ? [p.ing.id] : [])) };
}
export const partsText = (parts: Part[]) => parts.map((p) => ("ing" in p ? p.ing.name : p.text)).join("");

/** The whole deck for a seed: every template that fits your inventory, in a seeded order within each intent. */
export function fillStarters(all: Ingredient[], seed = 1): Starter[] {
  const out: Starter[] = [];
  STARTERS.forEach(([intent, tpl], i) => {
    const r = rng(h32(`${seed}|${i}`));
    const f = fillTemplate(tpl, all, r);
    if (f) out.push({ id: `s${i}-${(h32(`${seed}|${f.text}`) % 1e6).toString(36)}`, intent, ...f });
  });
  const r = rng(seed * 2654435761 + 7);
  const key = new Map(out.map((s) => [s.id, r()]));
  return out.sort((a, b) => INTENTS.findIndex((x) => x.id === a.intent) - INTENTS.findIndex((x) => x.id === b.intent) || key.get(a.id)! - key.get(b.id)!);
}

// ── Dice and Wildcard ─────────────────────────────────────────────────────────────
const GOALS = [
  "that makes money while I sleep", "my HD community would share", "I can ship this weekend", "that runs itself every morning",
  "that looks incredible on a phone", "that saves me an hour a day", "people would pay $19 for", "that grows an audience on its own",
  "I'd use every single day", "that works entirely on my own machines",
];
const TWISTS = [
  "but it has to be a game", "that only works at night", "for an audience of one: me, in 2027", "that turns data into sound",
  "that lives inside a chat as a character", "with no screen at all", "as a museum exhibit", "as a ritual 1,000 people do together",
  "where the bodygraph is the whole interface", "that a 10-year-old would love", "that prints on paper", "on a map of the real world",
  "that remembers everything and forgets on purpose", "that argues with me", "that speaks Hebrew, Russian and English", "that grows like a plant",
];
/** Store categories that make good second ingredients next to a project. */
const GOOD_CATS = /^(communication|media|commerce|cloud|knowledge|search|data)/i;
const NOISE = /background service|homebrew service|ssh host|profile$|on your tailnet|subscription|\bplan$|sign-in$/i;
/** Plain dev tooling (runtimes, editors, CLIs) makes a dull wildcard. */
const DULL = /^(code & git|browsers|devices)/i;

/**
 * Dice: a random but sensible combination (one of your liveliest projects, a service from a category that
 * complements it, and a gem, tool or interest), aimed at a goal. Wildcard: three things from three different
 * kinds, drawn from the whole inventory (stale projects and odd tools included), plus a twist.
 */
export function composeDice(all: Ingredient[], seed: number, wild = false): { text: string; parts: Part[]; ids: string[] } | undefined {
  const r = rng(h32(`dice|${seed}|${wild}`));
  const pickOf = (xs: Ingredient[], top: number) => (xs.length ? xs[Math.floor(r() * Math.min(xs.length, top))] : undefined);
  const ready = all.filter((x) => x.ready && !NOISE.test(`${x.desc} ${x.group ?? ""}`));
  const of = (k: IngKind) => ready.filter((x) => x.kind === k);
  let chosen: Ingredient[] = [];
  if (!wild) {
    const p = pickOf(of("project").filter((x) => x.group === "active" || x.group === "launched"), 14) ?? pickOf(of("project"), 20);
    const c = pickOf(of("conn").filter((x) => GOOD_CATS.test(x.group ?? "")), 60);
    const third = r() < 0.5 ? pickOf(of("repo"), 16) : r() < 0.5 ? pickOf(of("tool").filter((x) => /skills|mcp/i.test(x.group ?? "")), 60) : pickOf(of("interest"), 10);
    chosen = [p, c, third].filter((x): x is Ingredient => !!x);
  } else {
    const kinds: IngKind[] = ["project", "repo", "conn", "tool", "interest"].sort(() => r() - 0.5) as IngKind[];
    for (const k of kinds) { if (chosen.length >= 3) break; const x = pickOf(of(k).filter((y) => !DULL.test(y.group ?? "")), 400); if (x) chosen.push(x); }
  }
  chosen = chosen.filter((x, i) => chosen.findIndex((y) => y.id === x.id) === i);
  if (chosen.length < 2) return undefined;
  const parts: Part[] = [{ text: wild ? "Wildcard: fuse " : "Combine " }];
  chosen.forEach((x, i) => { if (i) parts.push({ text: i === chosen.length - 1 ? " and " : ", " }); parts.push({ ing: lite(x) }); });
  parts.push({ text: wild ? ` into one thing ${TWISTS[Math.floor(r() * TWISTS.length)]}. Make it strange, then make it work.` : ` into something ${GOALS[Math.floor(r() * GOALS.length)]}.` });
  return { text: partsText(parts), parts, ids: chosen.map((x) => x.id) };
}

/** Follow-ups the page offers after any answer, next to the model's own. */
export const RIFFS = ["Make it wilder", "What's the cheapest version?", "Which one ships fastest?", "Now make it earn money"];
