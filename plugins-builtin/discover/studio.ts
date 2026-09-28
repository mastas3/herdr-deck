// Studio: a chat that assembles things out of everything you have (projects, gems, connections, tools, interests).
//
// The model sees a compact catalog of the inventory (names and one-liners only: no wiki bodies, no secrets, no
// session content), the trimmed conversation so far, and your message. It answers in plain text with rich blocks
// (<build>, <ask>, <next>) that are parsed and repaired while they stream, so the page can draw cards as they
// complete. Engines: headless Claude Code (fast Haiku or deeper Sonnet), a local Ollama model, or the instant
// template combiner from the Mixer. Every run has a time limit; when a model is missing, slow or unreadable,
// template builds fill in, so a question never ends in nothing. Conversations live in <dataDir>/studio/<id>.json.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hash, runClaude, runOllama, sanitizeIngredient, type Ingredient, type IngKind } from "./mix";
import { buildCatalog, redact } from "../../src/ingredients";
import { composeDice, fillStarters, INTENTS, RIFFS, SYSTEM } from "./studio-prompts";
import type { Comparables, Target } from "../../src/library-strategy";
import { buildComps, buildPromptFor, parseReply, templateReply, turnPrompt, type BotMsg, type Build, type Convo, type IngRef, type Msg } from "./studio-reply";

// Conversations, the reply parser and the build brief are pure (studio-reply.ts); importers get them from here too.
export * from "./studio-reply";
// The privacy filter and the inventory catalog are core (Opportunities sends them to a model too).
export { buildCatalog, redact } from "../../src/ingredients";
const clip = (s: unknown, n: number) => { const t = redact(s).replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };

// ── the store and the jobs ─────────────────────────────────────────────────────────────
export type StudioDeps = {
  dir: string; projectsDir: string;
  ingredients: (wait?: number) => Promise<Ingredient[]>;
  engines: () => Promise<{ claude: boolean; ollama: string[] }>;
  runClaude?: typeof runClaude; runOllama?: typeof runOllama;
  timeouts?: { haiku: number; sonnet: number; ollama: number };
  archive?: { put: (idea: any) => void };
  /** Founder Library evidence for a message (3–5 real founder cards with links), or "" (src/library.ts). */
  evidence?: (text: string) => Promise<string>;
  /** Comparable founders for a build (src/library-strategy.ts); the deck's shared library when not given. */
  comparables?: (t: Target) => Comparables | undefined;
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
        // What real founders did for something like this: grounds prices, channels and first-customer plans.
        const ev = text && deps.evidence ? await deps.evidence(text).catch(() => "") : "";
        const opts = {
          // A small local model reads a shorter catalog (faster to load, easier to follow).
          system: `${SYSTEM}\n\n${buildCatalog(all, job.engine === "ollama" ? 9000 : 18_000)}${ev ? `\n\n${ev}\nUse this evidence where it fits (prices, first-customer channels, what failed) and cite its links; don't copy a founder's business.` : ""}`, user: turnPrompt(history, text, use), timeoutMs: limit, signal: job.abort.signal, model: job.model, json: false,
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
      for (const b of got.blocks) if (b.t === "build") deps.archive?.put({ ...b.b, source: "studio" });
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
    // Each build shows what the founders most like it did (instant: word matching over the founder cards).
    msg.blocks = msg.blocks.map((b) => (b.t === "build" && !b.b.comps ? { ...b, b: { ...b.b, comps: buildComps(b.b, deps.comparables) } } : b));
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
