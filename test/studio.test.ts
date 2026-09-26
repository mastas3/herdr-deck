import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Ingredient, RunOpts } from "../src/mix";
import { buildCatalog, buildPromptFor, createStudio, historyText, isExecutable, isSlop, normalizeBuild, parseReply, planScore, redact, slugOf, templateReply, turnPrompt, type Msg } from "../src/studio";
import { composeDice, fillStarters, fillTemplate, INTENTS, partsText, rng, STARTERS, SYSTEM } from "../src/studio-prompts";

const root = mkdtempSync(`${tmpdir()}/deck-studio-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The inventory's real shape (kinds, store categories, project statuses, noise the store also lists), synthetic names.
const I = (id: string, kind: Ingredient["kind"], name: string, desc: string, group?: string, ready = true): Ingredient => ({ id, kind, name, desc, group, ready });
const ALL: Ingredient[] = [
  I("p:astra-apple", "project", "astra-apple", "Human Design + astrology engine and the 2027 Prophecy app base", "active"),
  I("p:yt-transcriber", "project", "yt-transcriber", "YouTube videos into transcripts, clips and a channel RAG", "active"),
  I("p:bodygraph-3d", "project", "bodygraph-3d", "A 3D bodygraph that derives itself from the real sky", "launched"),
  I("p:hd-core", "project", "hd-core", "Pure TypeScript Human Design calculation engine", "active"),
  I("p:story-reel", "project", "story-reel", "Deterministic vertical-video pipeline for HD shorts", "active"),
  I("p:gov-tender-sniper", "project", "gov-tender-sniper", "Israeli government tender scraper with AI analysis", "launched"),
  I("p:stasclaw", "project", "stasclaw", "Self-hosted personal AI assistant platform", "active"),
  I("p:hebrew-hermes", "project", "hebrew-hermes", "Local Hermes agent behind Open WebUI on the tailnet", "active"),
  I("p:esoteric-rag", "project", "esoteric-rag", "Local RAG over a 168-book occult library", "active"),
  I("p:herdr-deck", "project", "herdr-deck", "Dashboard and phone app for every agent session", "active"),
  I("p:chaos-os", "project", "chaos-os", "A web OS for chaos magick practitioners", "stale"),
  I("p:hdkit", "project", "hdkit", "Legacy Human Design toolkit", "legacy"),
  I("r:sparkjsdev/spark", "repo", "sparkjsdev/spark", "An advanced 3D Gaussian Splatting renderer for THREE.js", "TypeScript"),
  I("r:RunMaestro/Maestro", "repo", "RunMaestro/Maestro", "Agent orchestration command center", "TypeScript"),
  I("r:dturkuler/humandesign_api", "repo", "dturkuler/humandesign_api", "Python-based Human Design API", "Python"),
  I("c:svc:telegram", "conn", "Telegram", "Bots and messages", "Communication"),
  I("c:svc:whatsapp", "conn", "WhatsApp", "WhatsApp Business messages", "Communication"),
  I("c:svc:gmail", "conn", "Gmail", "Read and send email", "Communication"),
  I("c:svc:calendar", "conn", "Calendar", "Calendars on this Mac", "Communication"),
  I("c:svc:gumroad", "conn", "Gumroad", "Products, sales, offer codes", "Commerce & payments"),
  I("c:svc:stripe", "conn", "Stripe", "Payments, webhooks", "Commerce & payments", false),
  I("c:svc:elevenlabs", "conn", "ElevenLabs", "Voice, speech and sound effects", "Media & creative"),
  I("c:svc:hyperframes", "conn", "HyperFrames", "HTML video compositions rendered to MP4", "Media & creative"),
  I("c:svc:godot", "conn", "Godot", "Game engine", "Media & creative"),
  I("c:svc:vercel", "conn", "Vercel", "Deploys, domains, env vars", "Cloud & deploy"),
  I("c:svc:cloudflare", "conn", "Cloudflare", "Workers, Pages, DNS, R2", "Cloud & deploy"),
  I("c:svc:wiki", "conn", "LLM Wiki", "Your compiled, cross-linked knowledge base at /Users/someone/wiki", "Knowledge & notes"),
  I("c:svc:ytrag", "conn", "YouTube RAG (yt-transcriber)", "Channel transcripts in a local Chroma corpus", "Knowledge & notes"),
  I("c:svc:fb", "conn", "Facebook group archive", "Archived Facebook group posts you can search", "Search & OSINT"),
  I("c:svc:last30days", "conn", "last30days", "What people said in the last 30 days", "Search & OSINT"),
  I("c:svc:github", "conn", "GitHub", "Repos, PRs, issues, Actions", "Code & Git"),
  I("c:svc:tailscale", "conn", "Tailscale", "Private network; share dev servers to your phone", "Devices & network"),
  I("c:svc:android", "conn", "Android SDK", "Build and install Android apps", "Code & Git"),
  I("c:svc:launchd1", "conn", "stas.nightly-verify", "Background service (launchd)", "Automation"),
  I("c:svc:host", "conn", "conductor-linux", "SSH host", "Devices & network"),
  I("c:svc:leaky", "conn", "Leaky", "token OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx123 in notes, mail me at a@b.co", "Data & databases"),
  I("t:agent:claude", "tool", "Claude Code", "Anthropic's coding agent", "AI models & agents"),
  I("t:agent:codex", "tool", "Codex", "OpenAI's coding agent", "AI models & agents"),
  I("t:ollama", "tool", "Ollama", "Local models", "AI models & agents"),
  I("t:jev", "tool", "Jev", "Calibrated yes/no and pick-one decisions", "AI models & agents"),
  I("t:sub:claude", "tool", "Claude", "stripe subscription · default_claude_max_20x", "AI models & agents"),
  I("t:mcp:gumroad", "tool", "gumroad", "Local MCP server", "MCP servers"),
  I("t:skill:last30days", "tool", "last30days", "Research what people actually say about any topic", "Skills"),
  I("t:skill:hyperframes", "tool", "hyperframes", ">-", "Skills"),
  I("i:human-design", "interest", "Human Design", "From yt-transcriber, astra-apple", undefined),
  I("i:agents", "interest", "Agent orchestration", "From herdr-deck, stasclaw", undefined),
  I("i:games", "interest", "Browser games", "From falafel-rush", undefined),
];
const by = (id: string) => ALL.find((x) => x.id === id)!;

describe("catalog (what the model sees)", () => {
  const cat = buildCatalog(ALL);
  test("every kind, grouped by category, with the exact names", () => {
    for (const n of ["astra-apple", "sparkjsdev/spark", "Telegram", "Gumroad", "Claude Code", "last30days", "Human Design"]) expect(cat).toContain(n);
    expect(cat).toContain("- Communication: ");
    expect(cat).toContain("- MCP servers: gumroad");
    expect(cat).toContain("astra-apple [active]");
  });
  test("no secrets, no emails, no home paths, no plan details, no noise", () => {
    expect(cat).not.toMatch(/sk-proj|abcdefghijklmnop/);
    expect(cat).not.toContain("a@b.co");
    expect(cat).not.toContain("/Users/");
    expect(cat).not.toContain("default_claude_max");
    expect(cat).not.toContain("stas.nightly-verify");
    expect(cat).not.toContain("conductor-linux");
    expect(cat).not.toContain("Local MCP server");
    expect(cat).not.toContain(">-");
  });
  test("not-ready things and legacy projects stay out; the catalog stays under its budget", () => {
    expect(cat).not.toContain("Stripe");
    expect(cat).not.toContain("hdkit");
    const many = Array.from({ length: 400 }, (_, i) => I(`c:x${i}`, "conn", `Service ${i}`, "A long description of a service that goes on and on about what it does", `Cat ${i % 9}`));
    expect(buildCatalog([...ALL, ...many], 9000).length).toBeLessThanOrEqual(9000);
  });
  test("descriptions are one-liners (no wiki bodies)", () => {
    const long = I("p:long", "project", "long-one", "word ".repeat(500), "active");
    const line = buildCatalog([long]).split("\n").find((l) => l.includes("long-one"))!;
    expect(line.length).toBeLessThan(160);
  });
  test("redact", () => {
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted]");
    expect(redact("MY_API_KEY=supersecret value")).toBe("MY_API_KEY value");
    expect(redact("/Users/stas/x")).toBe("~/x");
    expect(redact("plain words stay")).toBe("plain words stay");
  });
  test("the system prompt describes every block", () => {
    for (const t of ["<build>", "<ask>", "<next>", "[[yt-transcriber]]"]) expect(SYSTEM).toContain(t);
  });
});

const REPLY = `Two strong moves here. [[yt-transcriber]] already does the hard part; pair it with [[Telegram]] and [[Nonexistent Thing]].

<build>{"title":"Clip Courier","pitch":"Daily HD clips delivered to a Telegram channel","ingredients":["yt-transcriber","Telegram","story-reel","Redis Streams"],"how":[{"name":"yt-transcriber","role":"finds the moments"},{"name":"[[Telegram]]","role":"delivers them"}],"new":["a cron"],"first_steps":["one","two","three"],"size":"weekend","wow":4,"why":"It reuses everything","project":"yt-transcriber","money":"$9/month channel"}</build>

<build>{"title":"Broken, repaired","pitch":"trailing commas",ingredients:["x"]}</build>
<build>{"title":"Sky Ritual","pitch":"a daily transit","ingredients":["hd-core","WhatsApp",],"first_steps":"1. calc\\n2. send","size":"week","wow":"5/5",}</build>
<ask>{"q":"Hebrew or English first?","options":["Hebrew","English","Both"]}</ask>
<next>["Make it wilder","Cheaper version"]</next>`;

describe("parsing replies", () => {
  test("text, builds, ask and next come out as blocks; inventory names resolve", () => {
    const { blocks, refs } = parseReply(REPLY, ALL, { final: true });
    expect(blocks.map((b) => b.t)).toEqual(["text", "build", "build", "ask", "next"]);
    const b = (blocks[1] as any).b;
    expect(b).toMatchObject({ title: "Clip Courier", ingredients: ["yt-transcriber", "Telegram", "story-reel"], ids: ["p:yt-transcriber", "c:svc:telegram", "p:story-reel"], difficulty: "weekend", wow: 4, project: "yt-transcriber", money: "$9/month channel" });
    expect(b.extra).toEqual(["Redis Streams", "a cron"]);
    expect(b.how.map((h: any) => h.name)).toEqual(["yt-transcriber", "Telegram"]);
    // A block with broken JSON is skipped; a block with trailing commas is repaired.
    expect((blocks[2] as any).b).toMatchObject({ title: "Sky Ritual", ingredients: ["hd-core", "WhatsApp"], first_steps: ["calc", "send"], difficulty: "week", wow: 5 });
    expect(blocks[3]).toEqual({ t: "ask", q: "Hebrew or English first?", options: ["Hebrew", "English", "Both"] });
    expect(blocks[4]).toEqual({ t: "next", items: ["Make it wilder", "Cheaper version"] });
    expect(refs["yt-transcriber"]).toEqual({ id: "p:yt-transcriber", kind: "project", name: "yt-transcriber" });
    expect(refs.Telegram.kind).toBe("conn");
    expect(refs["Nonexistent Thing"]).toBeUndefined();
  });
  test("while streaming: text shows at once, an open block is pending, a half-typed tag is hidden", () => {
    const cut = REPLY.indexOf('"first_steps"');
    const a = parseReply(REPLY.slice(0, cut), ALL);
    expect(a.blocks.map((b) => b.t)).toEqual(["text", "pending"]);
    expect((a.blocks[0] as any).md).toStartWith("Two strong moves here.");
    const b = parseReply("Hello there <bu", ALL);
    expect(b.blocks).toEqual([{ t: "text", md: "Hello there" }]);
    const c = parseReply(REPLY.slice(0, REPLY.indexOf("</build>") + 8), ALL);
    expect(c.blocks.map((x) => x.t)).toEqual(["text", "build"]);
  });
  test("forgotten closing tags: the next opening tag ends a block", () => {
    const b1 = { title: "One", pitch: "p", ingredients: ["Gumroad", "hd-core"] }, b2 = { title: "Two", pitch: "q", ingredients: ["Telegram", "hd-core"] };
    const text = `<build>${JSON.stringify(b1)}\n<build>${JSON.stringify(b2)}\n<next>["Go"]`;
    expect(parseReply(text, ALL, { final: true }).blocks.map((b: any) => b.b?.title ?? b.t)).toEqual(["One", "Two", "next"]);
    expect(parseReply(text.slice(0, text.indexOf("<next>") - 3), ALL).blocks.map((b: any) => b.b?.title ?? b.t)).toEqual(["One", "pending"]);
  });
  test("a forgotten closing tag at the very end is repaired", () => {
    const { blocks } = parseReply('Here.\n<next>["Go deeper","Ship it"]', ALL, { final: true });
    expect(blocks[1]).toEqual({ t: "next", items: ["Go deeper", "Ship it"] });
  });
  test("no tags, Mixer-shaped JSON: repaired into builds, and the JSON leaves the text", () => {
    const { blocks } = parseReply('Sure!\n```json\n{"builds":[{"title":"A","pitch":"p","ingredients":["Gumroad","astra-apple"]},{"title":"B","ingredients":["Ollama","esoteric-rag"]}]}\n```', ALL, { final: true });
    expect(blocks.filter((b) => b.t === "build").map((b: any) => b.b.title)).toEqual(["A", "B"]);
    const text = blocks.filter((b) => b.t === "text").map((b: any) => b.md).join(" ");
    expect(text).toContain("Sure!");
    expect(text).not.toContain('"title"');
  });
  test("normalizeBuild needs a title; strings and objects are tolerated", () => {
    expect(normalizeBuild({ pitch: "x" }, ALL, "claude")).toBeUndefined();
    expect(normalizeBuild("nope", ALL, "claude")).toBeUndefined();
    const b = normalizeBuild({ title: "T", ingredients: "Gumroad + Stripe Atlas", how: { Gumroad: "sells it" } }, ALL, "ollama")!;
    expect(b.ingredients).toEqual(["Gumroad"]);
    expect(b.extra).toEqual(["Stripe Atlas"]);
    expect(b.how).toEqual([{ name: "Gumroad", role: "sells it" }]);
    expect(b.source).toBe("ollama");
    expect(b.id).toMatch(/^[\w-]{1,40}$/);
  });
  test("names with a note in parentheses still match; [[brackets]] come off plain fields", () => {
    const b = normalizeBuild({ title: "[[Gumroad]] drops", pitch: "Sold on [[Gumroad]]", ingredients: ["Gumroad (recurring subscription product)", "YouTube RAG", "Stripe Atlas"], first_steps: ["Ask [[hd-core]] for the chart"] }, ALL, "claude")!;
    expect(b.ingredients).toEqual(["Gumroad", "YouTube RAG (yt-transcriber)"]);
    expect(b.extra).toEqual(["Stripe Atlas"]);
    expect(b.title).toBe("Gumroad drops");
    expect(b.pitch).toBe("Sold on Gumroad");
    expect(b.first_steps).toEqual(["Ask hd-core for the chart"]);
  });
});

describe("history", () => {
  const msgs: Msg[] = [
    { role: "user", text: "Something for my HD audience", use: [{ id: "c:svc:telegram", kind: "conn", name: "Telegram" }], at: 1 },
    { role: "assistant", blocks: parseReply(REPLY, ALL, { final: true }).blocks, refs: {}, engine: "claude", at: 2 },
  ];
  test("compact: builds become one line, ingredients are named", () => {
    const h = historyText(msgs);
    expect(h).toContain("Stas: Something for my HD audience");
    expect(h).toContain("(use these: Telegram)");
    expect(h).toContain("<build> Clip Courier: Daily HD clips delivered to a Telegram channel [yt-transcriber + Telegram + story-reel + Redis Streams + a cron]");
    expect(h).not.toContain('"first_steps"');
  });
  test("long conversations keep the latest turns within the budget", () => {
    const many: Msg[] = Array.from({ length: 30 }, (_, i) => ({ role: "user", text: `message ${i} ${"x".repeat(400)}`, use: [], at: i }));
    const h = historyText(many, 3000);
    expect(h.length).toBeLessThan(3600);
    expect(h).toContain("message 29");
    expect(h).not.toContain("message 0 ");
    expect(h).toStartWith("(");
  });
  test("the turn prompt: history, then the message, then the ingredients to use", () => {
    const p = turnPrompt(msgs, "Riff on Clip Courier", [{ id: "p:hd-core", kind: "project", name: "hd-core" }]);
    expect(p.indexOf("The conversation so far")).toBe(0);
    expect(p).toContain("Stas: Riff on Clip Courier");
    expect(p).toContain("Use these from my inventory");
    expect(p).toContain("hd-core (my project)");
    expect(turnPrompt([], "", [{ id: "p:hd-core", kind: "project", name: "hd-core" }])).toContain("Assemble something great");
  });
});

describe("starter deck", () => {
  test("fills from the real inventory shape: most templates fit, none keep a raw slot", () => {
    const deck = fillStarters(ALL, 7);
    expect(deck.length).toBeGreaterThan(STARTERS.length * 0.6);
    for (const s of deck) {
      expect(s.text).not.toMatch(/[{}]/);
      expect(s.text).toBe(partsText(s.parts));
      expect(INTENTS.some((i) => i.id === s.intent)).toBe(true);
      expect(new Set(s.ids).size).toBe(s.ids.length); // one slot, one different ingredient
      for (const id of s.ids) expect(by(id).ready).toBe(true);
    }
    for (const i of INTENTS) expect(deck.some((s) => s.intent === i.id)).toBe(true);
  });
  test("slots respect their filters", () => {
    const f = fillTemplate("Sell {project~2027|prophecy|astra} through {conn@Commerce}", ALL, rng(1))!;
    expect(f.ids).toEqual(["p:astra-apple", "c:svc:gumroad"]); // Stripe isn't ready
    expect(f.text).toBe("Sell astra-apple through Gumroad");
    expect(fillTemplate("{project#stale} revived", ALL, rng(2))!.ids).toEqual(["p:chaos-os"]);
    expect(fillTemplate("{conn@Communication~^calendar$}", ALL, rng(3))!.ids).toEqual(["c:svc:calendar"]);
    expect(fillTemplate("{repo} + {repo}", ALL, rng(4))!.ids).toHaveLength(2);
    expect(fillTemplate("{conn~nothing-like-this}", ALL, rng(5))).toBeUndefined();
  });
  test("the same seed gives the same deck; another seed shuffles it", () => {
    const a = fillStarters(ALL, 3).map((s) => s.text), b = fillStarters(ALL, 3).map((s) => s.text), c = fillStarters(ALL, 4).map((s) => s.text);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
  });
  test("an empty inventory still gives the no-slot starters, never a crash", () => {
    const deck = fillStarters([], 1);
    expect(deck.length).toBeGreaterThan(0);
    for (const s of deck) expect(s.ids).toEqual([]);
  });
});

describe("dice", () => {
  test("sensible: a live project, a complementary service, something else; never noise", () => {
    for (let seed = 1; seed < 40; seed++) {
      const d = composeDice(ALL, seed)!;
      expect(d.ids.length).toBeGreaterThanOrEqual(2);
      expect(new Set(d.ids).size).toBe(d.ids.length);
      const kinds = d.ids.map((id) => by(id).kind);
      expect(kinds[0]).toBe("project");
      expect(["active", "launched"]).toContain(by(d.ids[0]).group);
      expect(kinds[1]).toBe("conn");
      expect(by(d.ids[1]).group).toMatch(/^(Communication|Media|Commerce|Cloud|Knowledge|Search|Data)/);
      for (const id of d.ids) expect(id).not.toMatch(/launchd|host|sub:/);
      expect(d.text).toStartWith("Combine ");
    }
  });
  test("wildcard: three different kinds and a twist", () => {
    const d = composeDice(ALL, 11, true)!;
    expect(new Set(d.ids.map((id) => by(id).kind)).size).toBe(3);
    expect(d.text).toStartWith("Wildcard: fuse ");
    expect(d.text).toContain("Make it strange, then make it work.");
  });
  test("different seeds roll different combos; too little inventory gives nothing", () => {
    const rolls = new Set(Array.from({ length: 20 }, (_, i) => composeDice(ALL, i + 1)!.text));
    expect(rolls.size).toBeGreaterThan(10);
    expect(composeDice([by("p:hd-core")], 1)).toBeUndefined();
  });
});

const PLAN = { title: "Clip Courier", pitch: "Daily Human Design clips for coaches, delivered to Telegram", customer: "HD coaches with 1-10k Instagram followers, in HD Facebook groups", problem: "They need daily content and have no time to cut videos", offer: "Five captioned HD clips a week in their Telegram", price: "$29/month", model: "subscription", mvp: ["Pick moments from a channel", "Burn Hebrew captions", "Post to a Telegram channel"], ingredients: ["yt-transcriber", "Telegram", "Gumroad"], how: [{ name: "Telegram", role: "delivers" }, { name: "yt-transcriber", role: "finds and cuts moments" }], launch: ["Post a free sample in the Hebrew HD group", "DM 20 coaches with their own clip"], week: ["Wire the channel list", "Cut 5 sample clips", "Set up the Gumroad product", "Post the sample"], cost: "$15/month", first_dollar: "10 days", risks: ["Coaches may not pay monthly"], size: "week", wow: 4, project: "yt-transcriber" };
describe("execution-ready builds", () => {
  test("the plan is kept, repaired and scored; the quality gate passes it", () => {
    const b = normalizeBuild(PLAN, ALL, "claude")!;
    expect(b).toMatchObject({ customer: PLAN.customer, price: "$29/month", model: "subscription", cost: "$15/month", first_dollar: "10 days" });
    expect(b.mvp).toHaveLength(3);
    expect(b.week).toHaveLength(4);
    expect(b.first_steps).toEqual(PLAN.week.slice(0, 3)); // no first_steps given: the first week's tasks
    expect(b.ids).toEqual(["p:yt-transcriber", "c:svc:telegram", "c:svc:gumroad"]);
    expect(planScore(b)).toBe(1);
    expect(isExecutable(b)).toBe(true);
  });
  test("the gate drops vague, priceless, single-ingredient and generic ideas", () => {
    const ok = (p: any) => isExecutable(normalizeBuild({ ...PLAN, ...p }, ALL, "claude")!);
    expect(ok({ customer: "everyone" })).toBe(false);
    expect(ok({ price: "affordable" })).toBe(false);
    expect(ok({ ingredients: ["Telegram"], how: [] })).toBe(false);
    expect(ok({ mvp: ["one thing"] })).toBe(false);
    expect(ok({ week: [] })).toBe(false);
    expect(ok({ pitch: "An AI-powered platform that leverages synergies for creators" })).toBe(false);
    expect(ok({})).toBe(true);
  });
});

describe("build it now", () => {
  const b = normalizeBuild(PLAN, ALL, "claude")!;
  test("a complete brief, run in the project's own folder when it exists here", () => {
    const r = buildPromptFor(b, "/p", ["yt-transcriber", "other"]);
    expect(r.cwd).toBe("/p/yt-transcriber");
    expect(r.prompt).toStartWith('Build this: "Clip Courier" — Daily Human Design clips');
    for (const t of ["Customer: HD coaches", "Pricing: $29/month · subscription", "## MVP scope\n- Pick moments", "- Telegram: delivers", "## Launch: the first 10 customers", "## First week\n1. Wire the channel list", "## Risks", "Time to first dollar: 10 days", "You're in the yt-transcriber project", "PLAN.md", "Don't deploy, publish, message anyone or spend money without asking me first."]) expect(r.prompt).toContain(t);
    expect(r.label).toBe("Build Clip Courier");
  });
  test("a new idea gets a new folder under Projects (created by the session, which starts in Projects)", () => {
    const r = buildPromptFor({ ...b, project: undefined, ids: ["c:svc:telegram"] }, "/p", ["x", "clip-courier"]);
    expect(r.cwd).toBe("/p");
    expect(r.folder).toBe("/p/clip-courier-app");
    expect(r.prompt).toContain("Create /p/clip-courier-app and build it there");
    expect(buildPromptFor({ title: "T", ids: ["p:Story_Reel"] }, "/p", ["story-reel"]).cwd).toBe("/p/story-reel");
    expect(slugOf("Clip Courier: HD edition!")).toBe("clip-courier-hd-edition");
  });
});

describe("the studio: conversations, jobs, fallbacks", () => {
  const fake = (reply: string, opts: { delay?: number; fail?: string; hang?: boolean } = {}) => {
    const calls: RunOpts[] = [];
    const run = async (o: RunOpts) => {
      calls.push(o);
      if (opts.fail) throw new Error(opts.fail);
      const parts = reply.match(/[\s\S]{1,40}/g) ?? [];
      let all = "";
      for (const p of parts) {
        if (o.signal.aborted) throw new Error("cancelled");
        all += p; o.onText(all);
        await Bun.sleep(opts.delay ?? 1);
      }
      if (opts.hang) await new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("cancelled"))));
      return { text: all, model: o.model ?? "haiku" };
    };
    return { run, calls };
  };
  const mk = (run: any, dir = `${root}/s${Math.random().toString(36).slice(2, 8)}`, timeouts?: any) => ({ dir, s: createStudio({ dir, projectsDir: "/p", ingredients: async () => ALL, engines: async () => ({ claude: true, ollama: ["gemma"] }), runClaude: run, runOllama: run, timeouts }) });
  const wait = async (s: any, job: string) => { for (let i = 0; i < 400; i++) { const v = s.status(job); if (v.status !== "running") return v; await Bun.sleep(5); } throw new Error("never finished"); };

  test("a two-turn conversation is kept, persisted and sent back as history", async () => {
    const f = fake(REPLY);
    const { s, dir } = mk(f.run);
    const r1 = await s.send({ text: "Something for my HD audience", use: [{ id: "c:svc:telegram" }, { id: "bogus", kind: "nope", name: "x" }], engine: "claude" });
    expect(r1.convo.title).toBe("Something for my HD audience");
    const v1 = await wait(s, r1.job.id);
    expect(v1.status).toBe("done");
    expect(v1.firstMs).toBeGreaterThanOrEqual(0);
    expect(v1.message.blocks.filter((b: any) => b.t === "build")).toHaveLength(2);
    expect(f.calls[0].system).toContain("# His inventory");
    expect(f.calls[0].model).toBe("haiku");
    expect(f.calls[0].user).toContain("Telegram (a service I have)");
    const r2 = await s.send({ id: r1.convo.id, text: "Riff on Clip Courier", engine: "claude", model: "sonnet" });
    await wait(s, r2.job.id);
    expect(f.calls[1].model).toBe("sonnet");
    expect(f.calls[1].user).toContain("The conversation so far");
    expect(f.calls[1].user).toContain("<build> Clip Courier");
    const saved = JSON.parse(readFileSync(`${dir}/${r1.convo.id}.json`, "utf8"));
    expect(saved.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(saved.messages[0].use).toEqual([{ id: "c:svc:telegram", kind: "conn", name: "Telegram" }]);
    expect(s.list()[0]).toMatchObject({ id: r1.convo.id, turns: 2 });
  });
  test("rename, delete, list; bad ids are refused", async () => {
    const { s, dir } = mk(fake(REPLY).run);
    const a = await s.send({ text: "one" }); await wait(s, a.job.id);
    const b = await s.send({ text: "two" }); await wait(s, b.job.id);
    expect(s.list().map((c: any) => c.title)).toEqual(["two", "one"]);
    s.rename(a.convo.id, "  Renamed   thing ");
    expect(s.get(a.convo.id).title).toBe("Renamed thing");
    s.remove(b.convo.id);
    expect(existsSync(`${dir}/${b.convo.id}.json`)).toBe(false);
    expect(s.list().map((c: any) => c.id)).toEqual([a.convo.id]);
    expect(() => s.remove("../../etc/passwd")).toThrow();
    expect(() => s.get("../x")).toThrow();
    await expect(s.send({ text: "" })).rejects.toThrow(/Say what you want/);
    expect(readdirSync(dir).every((f) => /^[a-z0-9]+\.json$/.test(f))).toBe(true);
  });
  test("a model that fails still answers, with template builds and a note", async () => {
    const { s } = mk(fake("", { fail: "Claude Code (claude) isn't installed here" }).run);
    const r = await s.send({ text: "go", use: [{ id: "p:hd-core" }, { id: "c:svc:telegram" }, { id: "i:human-design" }] });
    const v = await wait(s, r.job.id);
    expect(v.status).toBe("done");
    expect(v.message.engine).toBe("claude");
    expect(v.message.note).toContain("isn't installed");
    expect(v.message.blocks.filter((b: any) => b.t === "build").length).toBeGreaterThan(0);
  });
  test("an unreadable answer falls back too; the template engine answers instantly", async () => {
    const { s } = mk(fake("ok").run);
    const v = await wait(s, (await s.send({ text: "go" })).job.id);
    expect(v.message.note).toContain("couldn't be read");
    const t = await wait(s, (await s.send({ text: "go", engine: "template", use: [{ id: "p:hd-core" }, { id: "c:svc:telegram" }] })).job.id);
    expect(t.message.engine).toBe("template");
    expect(t.message.blocks.some((b: any) => b.t === "build")).toBe(true);
  });
  test("Stop keeps what arrived; a slow model hits the time limit and keeps its partial answer", async () => {
    const { s } = mk(fake(REPLY, { delay: 15 }).run);
    const r = await s.send({ text: "go" });
    await Bun.sleep(80);
    const mid = s.status(r.job.id);
    expect(mid.status).toBe("running");
    expect(mid.blocks[0]?.t).toBe("text");
    s.stop(r.job.id);
    const v = await wait(s, r.job.id);
    expect(v.status).toBe("cancelled");
    expect(v.message.stopped).toBe(true);
    const slow = mk(fake(REPLY, { hang: true }).run, undefined, { haiku: 120, sonnet: 120, ollama: 120 }).s;
    const v2 = await wait(slow, (await slow.send({ text: "go" })).job.id);
    expect(v2.status).toBe("done");
    expect(v2.message.note).toContain("time limit");
    expect(v2.message.blocks.filter((b: any) => b.t === "build")).toHaveLength(2);
  });
  test("one answer at a time per conversation", async () => {
    const { s } = mk(fake(REPLY, { delay: 10 }).run);
    const r = await s.send({ text: "go" });
    await expect(s.send({ id: r.convo.id, text: "again" })).rejects.toThrow(/Still answering/);
    s.stop(r.job.id);
    await wait(s, r.job.id);
  });
  test("home: counts, the deck, the engines; dice", async () => {
    const { s } = mk(fake(REPLY).run);
    const h = await s.home({ seed: 5 });
    expect(h.counts).toMatchObject({ project: 12, repo: 3, interest: 3 });
    expect(h.starters.length).toBeGreaterThan(20);
    expect(h.engines.claude).toBe(true);
    const d = await s.dice(9, false);
    expect(d.ids.length).toBeGreaterThanOrEqual(2);
  });
  test("templateReply falls back to a dice combo when nothing was picked", () => {
    const m = templateReply([], ALL, 3);
    expect(m.blocks.some((b) => b.t === "build")).toBe(true);
    expect(Object.keys(m.refs).length).toBeGreaterThanOrEqual(2);
  });
});

describe("slop gate", () => {
  const good = { title: "HD Daily Digest", pitch: "A $9/month Telegram digest of today's transits for your own chart", customer: "Human Design readers in r/humandesign", offer: "a daily chart-specific note", problem: "generic transit posts", launch: ["Post a free week in r/humandesign"] };
  test("a specific idea passes", () => expect(isSlop(good)).toBe(false));
  test("hype words fail", () => expect(isSlop({ ...good, pitch: "Revolutionize your mornings with a seamless AI digest" })).toBe(true));
  test("a buyer nobody can message fails", () => expect(isSlop({ ...good, customer: "creators" })).toBe(true));
  test("a launch without a named place fails", () => expect(isSlop({ ...good, launch: ["Share it on social media"] })).toBe(true));
  test("emoji in the name fails", () => expect(isSlop({ ...good, title: "HD Digest 🚀" })).toBe(true));
});
