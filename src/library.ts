// Founder Library: how real builders build and get customers, from YouTube channels (Starter Story and similar) and
// web pages you add. Discover → Library shows it; the Studio, the ideas feed and research agents read it as evidence.
//
// Pieces: library-config (channels.json), library-queue (what to ingest next), library-bridge (+ bin/library-bridge.py,
// which reuses yt-transcriber for captions, chunking and Chroma), library-runner (the background worker),
// library-extract + library-cards (founder cards, checked against the transcript), library-search (hybrid answers),
// library-web (polite page fetching) and library-playbooks. The server only routes /api/library/* here.
//
// Privacy: everything runs on this machine. YouTube is asked for captions and public listings; pages are fetched only
// when you add them, honouring robots.txt; cards are written by a local Ollama model.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createBridge, type Bridge } from "./library-bridge";
import { openCards, type CardFilter, type Cards } from "./library-cards";
import { addSource, loadConfig, parseSource, removeSource, saveConfig, setEnabled, type LibConfig } from "./library-config";
import { buildCard, EXTRACT_SYSTEM, EXTRACT_VERSION, extractUser, LISTS_USER, needsLists, parseCardJson, toLines, transcriptParts, type Segment } from "./library-extract";
import { listPlaybooks, readPlaybook, writePlaybooks } from "./library-playbooks";
import { applyRules, countQueue, queueStore, type Queue } from "./library-queue";
import { createRunner, sourceChannelId } from "./library-runner";
import { evidenceText, mergeResults, type Answer, type Passage } from "./library-search";
import { fetchPage } from "./library-web";

const OLLAMA_URL = process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "http://127.0.0.1:11434";
export const libraryDir = () => process.env.DECK_LIBRARY_DIR || `${homedir()}/.config/herdr-deck/library`;

/** One JSON answer from a local model (no streaming, low temperature: this is reading, not writing). */
export async function ollamaJson(model: string, system: string, user: string, timeoutMs = 240_000): Promise<string> {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, format: "json", think: false, keep_alive: "15m", options: { temperature: 0.1, num_ctx: 16384, num_predict: 2200 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Ollama said ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return String(((await r.json()) as any).message?.content ?? "");
}

export type LibraryDeps = { dir?: string; bridge?: Bridge; ask?: typeof ollamaJson; fetchPage?: typeof fetchPage };
export function createLibrary(deps: LibraryDeps = {}) {
  const dir = deps.dir ?? libraryDir();
  const cfgFile = `${dir}/channels.json`;
  const bridge = deps.bridge ?? createBridge({ dir });
  const queues = queueStore(`${dir}/queue`);
  const ask = deps.ask ?? ollamaJson;
  let cards: Cards | undefined;
  const db = () => (cards ??= openCards(`${dir}/cards.db`));
  let cfg: { at: number; c: LibConfig } | undefined;
  const config = () => {
    if (!cfg || Date.now() - cfg.at > 2000) {
      const c = loadConfig(cfgFile);
      if (!existsSync(cfgFile)) saveConfig(cfgFile, c); // the file you edit exists from the first run
      cfg = { at: Date.now(), c };
    }
    return cfg.c;
  };
  const save = (c: LibConfig) => { saveConfig(cfgFile, c); cfg = { at: Date.now(), c }; };

  const transcriptPath = (q: Queue, sourceId: string, vid: string) => {
    const s = config().sources.find((x) => x.id === sourceId);
    const ch = s ? sourceChannelId(q, s) : q.channelId ?? sourceId;
    return `${dir}/channels/${ch}/video_${vid}/${vid}_transcript.json`;
  };

  /** Extract the next founder card: the first ingested video, in source order, that has none yet. */
  async function extractNext(c: LibConfig): Promise<boolean> {
    const handled = db().handled();
    for (const s of c.sources) {
      const q = queues.read(s.id);
      const v = q.videos.find((x) => x.status === "ingested" && !handled.has(x.id));
      if (!v) continue;
      await extractVideo(q, s.id, v.id, c.extract.model);
      return true;
    }
    // Nothing new: bring one card from an older prompt up to date.
    const old = db().outdated(EXTRACT_VERSION)[0];
    const card = old ? db().get(old) : undefined;
    if (card) { await extractVideo(queues.read(card.source), card.source, card.id, c.extract.model); return true; }
    return false;
  }
  /** Extract these videos again now (after a prompt change, or to compare with a spot-check). */
  async function reextract(ids: string[], model = config().extract.model) {
    for (const id of ids) {
      const card = db().get(id);
      const s = card?.source ?? config().sources.find((x) => queues.read(x.id).videos.some((v) => v.id === id))?.id;
      if (s) await extractVideo(queues.read(s), s, id, model);
    }
  }
  async function extractVideo(q: Queue, sourceId: string, vid: string, model: string) {
    const v = q.videos.find((x) => x.id === vid)!;
    const started = Date.now();
    let segs: Segment[] = [];
    try { segs = JSON.parse(readFileSync(transcriptPath(q, sourceId, vid), "utf8")).segments ?? []; } catch {}
    const lines = toLines(segs);
    if (lines.length < 8) { db().mark(vid, "empty", "transcript too short or missing", model); return; }
    const parts = transcriptParts(lines);
    const raws: any[] = [];
    let lastErr = "";
    for (let i = 0; i < parts.length; i++) {
      try {
        const user = extractUser(v.title, q.title ?? sourceId, parts[i], i, parts.length);
        const got = parseCardJson(await ask(model, EXTRACT_SYSTEM, user));
        if (got) raws.push(got); else lastErr = "the model's answer wasn't JSON";
        // Stopped before the lists: ask once more for just those.
        if (needsLists(got)) { const more = parseCardJson(await ask(model, EXTRACT_SYSTEM, `${user}\n\n${LISTS_USER}`)); if (more) raws.push(more); }
      } catch (e: any) { lastErr = String(e?.message ?? e); }
    }
    if (!raws.length) { db().mark(vid, "failed", lastErr || "no answer", model, Date.now() - started); return; }
    const card = buildCard(raws, lines, { id: vid, source: sourceId, channelTitle: q.title, title: v.title, url: v.url, views: v.views, date: v.date, duration: v.duration }, model);
    db().put(card, Date.now() - started, raws);
  }
  /** Re-apply the current claim checks to every card from the model's stored answers (no model calls). */
  function recheck(): number {
    let n = 0;
    for (const c of db().all()) {
      const raws = db().raws(c.id);
      if (!raws) continue;
      const q = queues.read(c.source);
      let segs: Segment[] = [];
      try { segs = JSON.parse(readFileSync(transcriptPath(q, c.source, c.id), "utf8")).segments ?? []; } catch { continue; }
      const { id, source, channelTitle, title, url, views, date, duration } = c;
      db().put({ ...buildCard(raws, toLines(segs), { id, source, channelTitle, title, url, views, date, duration }, c.model, c.at) }, 0, raws);
      n++;
    }
    return n;
  }

  const runner = createRunner({ dir, bridge, queues, config, extractNext });

  let statusMemo: { at: number; v: any } | undefined;
  async function status() {
    if (statusMemo && Date.now() - statusMemo.at < 1500) return { ...statusMemo.v, runner: runner.status() };
    const c = config();
    const st = db().stats();
    const sources = c.sources.map((s) => {
      const q = queues.read(s.id);
      return { ...s, title: s.title ?? q.title?.replace(/ - (Videos|Shorts|Live)$/, "") ?? (s.kind === "channel" ? `@${s.id}` : s.id), channelId: q.channelId, enumeratedAt: q.enumeratedAt, error: q.error, counts: countQueue(q), cards: st.bySource[s.id] ?? 0 };
    });
    const v = { available: bridge.available(), dir, ingest: c.ingest, extract: c.extract, use: c.use, sources, cards: st };
    statusMemo = { at: Date.now(), v };
    return { ...v, runner: runner.status() };
  }

  /** The Library's answer to a question: videos (with their card and best clips) and web pages. */
  async function search(q: string, k = 8, f: CardFilter = {}): Promise<{ answers: Answer[]; ms: number; passages: number; error?: string }> {
    const t0 = Date.now();
    const text = String(q ?? "").trim().slice(0, 500);
    if (!text) return { answers: [], ms: 0, passages: 0 };
    let passages: Passage[] = [], error: string | undefined;
    const semantic = bridge.available().ok && existsSync(`${dir}/chroma`)
      ? bridge.call<{ hits: Passage[] }>("/search", { q: text, k: k * 3 }, 8000).then((r) => r.hits ?? []).catch((e) => { error = String(e?.message ?? e); return [] as Passage[]; })
      : Promise.resolve([] as Passage[]);
    const found = db().list({ ...f, q: text, limit: k * 2 }).cards;
    const pages = db().searchPages(text, 4);
    passages = await semantic;
    // Cards for videos that only a passage found, so every video answer can show its card.
    const extra = db().many([...new Set(passages.map((p) => p.video_id))].filter((id) => !found.some((c) => c.id === id)));
    return { answers: mergeResults(passages, found, pages, k, extra), ms: Date.now() - t0, passages: passages.length, error };
  }

  /**
   * Evidence for other prompts (the Studio, the ideas feed, pre-mortems, research agents): 3–5 relevant founder
   * cards and quotes as prompt text, each with its link. Empty text when the library is empty, switched off for
   * that use, or slow: callers add it only when it is there.
   */
  async function evidence(q: string, k = 5, use?: keyof LibConfig["use"]): Promise<{ text: string; answers: Answer[] }> {
    if (use && !config().use[use]) return { text: "", answers: [] };
    try {
      const r = await Promise.race([search(q, Math.max(k, 6)), Bun.sleep(4000).then(() => undefined)]);
      if (!r) return { text: "", answers: [] };
      return { text: evidenceText(r.answers, k), answers: r.answers };
    } catch { return { text: "", answers: [] }; }
  }

  /** Switch the worker on or off (remembered in channels.json). `start: false` only records it (the CLI runs it itself). */
  function setRunning(on: boolean, start = true) {
    const c = config();
    save({ ...c, ingest: { ...c.ingest, running: on } });
    if (on && start && !runner.status().running) runner.run().catch((e) => console.warn(`library: ${e?.message ?? e}`));
    if (!on) runner.stop();
  }

  async function add(url: string) {
    const p = parseSource(url);
    if (p.type === "web") {
      const page = await (deps.fetchPage ?? fetchPage)(p.url);
      db().putPage(page);
      // Semantic search over the page too, when the bridge is there (the page text is already stored either way).
      if (bridge.available().ok) await bridge.call("/ingest-text", { id: Bun.hash(page.url).toString(36), url: page.url, title: page.title, text: page.text }, 60_000).catch(() => {});
      statusMemo = undefined;
      return { added: "page", title: page.title, url: page.url, chars: page.text.length };
    }
    const r = addSource(config(), p);
    if (r.error) throw new Error(r.error);
    save(r.config);
    statusMemo = undefined;
    // A pasted source is listed right away, so its videos show up and go first.
    if (r.source && bridge.available().ok) await runner.refresh(r.source, true).catch(() => {});
    return { added: r.source!.kind, id: r.source!.id };
  }

  async function channels(body: any) {
    const c = config();
    const id = String(body.id ?? "");
    switch (body.op) {
      case "enable": case "disable": save(setEnabled(c, id, body.op === "enable")); break;
      case "remove": save(removeSource(c, id)); break;
      case "limit": {
        const limit = Number(body.limit) > 0 ? Math.floor(Number(body.limit)) : undefined;
        const next = { ...c, sources: c.sources.map((s) => (s.id === id ? { ...s, limit } : s)) };
        save(next);
        const s = next.sources.find((x) => x.id === id);
        if (s) { const q = queues.read(id); queues.write({ ...q, videos: applyRules(q.videos, s) }); }
        break;
      }
      case "start": setRunning(true); break;
      case "pause": setRunning(false); break;
      case "whisper": save({ ...c, ingest: { ...c.ingest, whisper: !!body.on } }); break;
      case "cards": save({ ...c, extract: { ...c.extract, running: !!body.on } }); break;
      case "use": if (["studio", "ideas", "research"].includes(body.what)) save({ ...c, use: { ...c.use, [body.what]: !!body.on } }); break;
      case "retry": db().retryFailed(); break;
      case "add": return { ...(await add(String(body.url ?? ""))), status: await status() };
      default: break;
    }
    statusMemo = undefined;
    return status();
  }

  async function handle(path: string, body: any): Promise<unknown> {
    switch (path) {
      case "/api/library/status": return status();
      case "/api/library/channels": return channels(body ?? {});
      case "/api/library/search": return search(String(body?.q ?? ""), Math.min(20, Math.max(1, Number(body?.k) || 8)), body?.filter ?? {});
      case "/api/library/cards": return db().list({ ...(body ?? {}), limit: Math.min(100, Number(body?.limit) || 40) });
      case "/api/library/card": return { card: db().get(String(body?.id ?? "")) ?? null };
      case "/api/library/add": return channels({ op: "add", url: body?.url });
      case "/api/library/pages": return body?.remove ? (db().removePage(String(body.remove)), { pages: db().pages() }) : { pages: db().pages() };
      case "/api/library/playbooks": {
        if (body?.op === "write") return { playbooks: await writePlaybooks(dir, db().all()) };
        if (body?.name) return { name: body.name, markdown: readPlaybook(dir, String(body.name)) };
        return { playbooks: listPlaybooks(dir) };
      }
      case "/api/library/evidence": { const r = await evidence(String(body?.q ?? ""), Math.min(8, Number(body?.k) || 5), "research"); return { text: r.text, answers: r.answers }; }
      default: return undefined;
    }
  }

  return {
    dir, config, handle, status, search, evidence, setRunning, runner, extractNext, reextract, recheck, add,
    cards: db, queues,
    writePlaybooks: () => writePlaybooks(dir, db().all()),
    /** Resume the worker if it was running when the deck last stopped (and this machine has yt-transcriber). */
    autostart() { if (config().ingest.running && bridge.available().ok) runner.run().catch(() => {}); },
    transcriptPath,
  };
}
export type Library = ReturnType<typeof createLibrary>;

/** The ideas feed's rows as a library question (what founders did for that kind of business). */
const FEED_Q: Record<string, string> = { money: "first paying customers small business pricing", saas: "saas first customers pricing", automations: "automation agency first clients",
  content: "content creator audience monetization", projects: "side project first revenue", gem: "open source project monetization", weekend: "simple app built in a weekend first revenue", wild: "unusual niche business first customers" };
export const feedQuery = (rows: string[]) => rows.map((r) => FEED_Q[r] ?? r).join(" ");

/** What research agents (autoresearch, pre-mortems) are told about the library: the MCP tool first, HTTP as backup. */
export const LIBRARY_AGENT_NOTE = "Founder Library: before judging an idea, look up how real founders did something similar. Call the herdr-deck MCP tool `deck_library` with a question (e.g. \"how did people get first customers for a Telegram bot?\"): it returns founder cards (claimed revenue, price, first-customer tactics) and transcript quotes, each with a YouTube timestamp link. Cite those links; treat numbers as the founders' claims.";
