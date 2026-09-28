// The Mixer: combine your projects, found repos, connections, tools and interests into project ideas.
//
// Engines: headless Claude Code (`claude -p`, a small fast model, no tools) or a local Ollama model. Either one
// runs async with a timeout, streams its JSON back (cards appear as each mix is complete), and is validated and
// repaired; when the model is missing, slow or talks nonsense, a deterministic combiner fills in, so the page
// never hangs. Only the names and one-line descriptions of the chosen ingredients (and your optional direction)
// are sent to the model: no wiki pages, no secrets, no session content.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Ingredient } from "../../src/ingredients";
import { claudeInstalled, ollamaModels, runClaude, runOllama } from "../../src/model-run";
import { dailyDue, dayOf, hash, mixKey, mixPrompt, parseMixes, templateMixes, type Daily, type Engine, type Mix } from "./mix-combine";

// Ingredients and the engines are core (Opportunities, Research and the Library use them too); what can be mixed, the
// prompt, the parser and the template combiner are mix-combine.ts. Importers get all of it from here.
export { KIND_LABEL, type IngKind, type Ingredient } from "../../src/ingredients";
export { ollamaModels, runClaude, runOllama, type RunOpts } from "../../src/model-run";
export * from "./mix-combine";

const DAY = 86_400_000;

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
  function flush() { clearTimeout(saveT); saveT = undefined; try { mkdirSync(deps.file.replace(/\/[^/]+$/, ""), { recursive: true }); const tmp = `${deps.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(store)); renameSync(tmp, deps.file); } catch {} }
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
    flush: () => { if (saveT) flush(); },
    _store: store,
  };
}
export type Mixer = ReturnType<typeof createMixer>;
