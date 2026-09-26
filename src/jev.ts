// Jev (TypeSafe's calibrated judgment model) through the local jev kit, so every call lands in the same
// receipts (~/.jev) and `jev stats` as the rest of your Jev use. Asks run in-process with the kit's own
// validation and redaction (starting the CLI cost up to a second per call); the CLI is the fallback.
// Advisory only: nothing the deck does waits on, or acts on, a Jev answer by itself.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = homedir();
let BIN = process.env.DECK_JEV_BIN ?? [`${HOME}/.local/bin/jev`, `${HOME}/.local/share/jev-kit/bin/jev.mjs`].find((p) => existsSync(p));
const KEY_FILE = process.env.JEV_KEY_FILE ?? `${HOME}/.config/typesafe/api-key`;
// Where the deck keeps its own Jev state (counter, cap, answer cache). Tests point this at a scratch dir.
let DIR = process.env.DECK_JEV_STATE_DIR ?? `${HOME}/.config/herdr-deck`;
let COUNT_FILE = "", SETTINGS_FILE = "", CACHE_FILE = "";
/** The receipts log shared with the jev CLI: the deck appends its own asks, `jev stats` reads them all. */
export let RECEIPTS_FILE = process.env.DECK_JEV_RECEIPTS ?? `${process.env.JEV_HOME ?? `${HOME}/.jev`}/receipts.jsonl`;
export const PRICE_PER_M_INPUT = 0.042; // USD per million input tokens; output is free

// TypeSafe itself has no daily limit (1,200 requests/min, 250k tokens/s). This is only the deck's own
// spending guard: ~1k input tokens a call at $0.042/M, so 1,000 calls is about $0.05 a day.
// Set in the Inbox's Jev panel (saved to jev-settings.json); DECK_JEV_DAILY is the default before that.
const DEFAULT_DAILY = 1000;
let settings: { daily?: number; features?: Partial<Record<JevFeature, boolean>> } = {};
export const jevCap = () => settings.daily ?? (process.env.DECK_JEV_DAILY ? Number(process.env.DECK_JEV_DAILY) : DEFAULT_DAILY);
const capSource = () => (settings.daily != null ? "settings" : process.env.DECK_JEV_DAILY ? "env" : "default");
function saveSettings() {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1));
}
export function setJevCap(n: number) {
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new Error("The cap is a whole number from 0 to 100,000");
  settings = { ...settings, daily: n };
  saveSettings();
}

// What each feature sends is its own choice, so each can be switched off in the Jev panel.
export const JEV_FEATURES = ["risk", "radar", "route"] as const;
export type JevFeature = (typeof JEV_FEATURES)[number];
/** On unless switched off (a missing switch means on). */
export const jevFeature = (name: JevFeature) => settings.features?.[name] !== false;
export function setJevFeature(name: string, on: boolean) {
  if (!(JEV_FEATURES as readonly string[]).includes(name)) throw new Error("Unknown Jev feature");
  if (typeof on !== "boolean") throw new Error("A feature is either on or off");
  settings = { ...settings, features: { ...settings.features, [name]: on } };
  saveSettings();
}
const jevFeatures = () => Object.fromEntries(JEV_FEATURES.map((f) => [f, jevFeature(f)])) as Record<JevFeature, boolean>;

export const jevAvailable = () => !!BIN && (existsSync(KEY_FILE) || !!process.env.TYPESAFE_API_KEY) && !process.env.DECK_NO_JEV;

/** Local calendar day: "today" resets at your midnight, not UTC's. */
export const localDay = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
let usage: { day: string; n: number } = { day: localDay(), n: 0 };
export const jevUsage = () => ({ day: localDay(), calls: usage.day === localDay() ? usage.n : 0, cap: jevCap(), capSource: capSource(), available: jevAvailable(), features: jevFeatures() });

// ── typed questions ──────────────────────────────────────────────────────────
// The builders return exactly the objects the deck always sent (same keys, same order), so the answer
// cache's fingerprints stay valid. The answer types follow from the questions you pass.
export type NoulQ = { type: "noul"; instructions: string };
export type ChoiceQ<K extends string = string> = { type: "choice"; instructions: string; criteria: Record<K, string> };
export type ScoreQ = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = NoulQ | ChoiceQ | ScoreQ;
/** What jevAsk accepts: the builders' questions, or hand-written ones (checked by the kit at send time). */
export type JevQuestions = Record<string, JevQuestion | { type: string; instructions: string; criteria?: unknown }>;
/** Yes/no: the answer is the probability of yes (0..1). */
export const noul = (instructions: string): NoulQ => ({ type: "noul", instructions });
/** One of the criteria ids (1-64 of [A-Za-z0-9_.-], at most 255), with a probability for each. */
export const choice = <K extends string>(instructions: string, criteria: Record<K, string>): ChoiceQ<K> => ({ type: "choice", instructions, criteria });
/** 2-10 ordered levels, lowest first; the score is the probability-weighted level index. */
export const score = (instructions: string, levels: string[]): ScoreQ => ({ type: "score", instructions, criteria: levels });

export type JevAnswerOf<Q> = 0 extends 1 & Q ? any // untyped questions: untyped answers
  : Q extends ChoiceQ<infer K> ? { choice: K; probabilities: Record<K, number>; confidence?: number }
  : Q extends ScoreQ ? { score: number; probabilities: Record<string, number>; confidence?: number }
  : Q extends NoulQ ? { noul: number }
  : any; // a hand-written question object: build it with noul/choice/score to get typed answers
/** The answers to a question map; any may be missing (a fallback, an older cached answer). */
export type JevAnswers<QS> = { [K in keyof QS]?: JevAnswerOf<QS[K]> };

export type JevAnswer<A = Record<string, any>> = { id?: string; answers?: A; fallback?: string | null; error?: string; cached?: boolean; ms?: number };

// ── the CLI (fallback, outcomes, stats) ──────────────────────────────────────
type Runner = (args: string[], stdin?: string, timeout?: number) => Promise<any>;
async function spawnJev(args: string[], stdin?: string, timeout = 30_000): Promise<any> {
  // The jev kit's own default guard (300 calls/day, shared by all your Jev use) mustn't starve the deck;
  // the deck's cap above is the one that applies to its calls.
  const env: Record<string, string> = { ...(process.env as any), JEV_AGENT: "herdr-deck", JEV_DAILY_BUDGET: String(Math.max(Number(process.env.JEV_DAILY_BUDGET ?? 300), jevCap() + 5000)), PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` };
  if (!env.TYPESAFE_API_KEY && existsSync(KEY_FILE)) env.JEV_KEY_FILE = KEY_FILE;
  // Bun runs the Node script fine, and doesn't depend on node being on the service's PATH.
  const p = Bun.spawn([process.execPath, BIN!, ...args], { stdin: stdin ? new TextEncoder().encode(stdin) : "ignore", stdout: "pipe", stderr: "pipe", env, cwd: HOME });
  const t = setTimeout(() => p.kill(9), timeout);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(t);
  try { return JSON.parse(out); } catch { return { fallback: "invalid_output" }; }
}
let run: Runner = spawnJev;
/** Tests swap the CLI for a fake (which then also answers asks); returns the previous runner. */
export function _setRunner(fn: Runner | null) { const prev = run; run = fn ?? spawnJev; return prev; }

// ── in-process asks ──────────────────────────────────────────────────────────
// The kit module (its main is guarded, so importing it is safe) supplies validation, redaction and the
// key lookup. The request and the receipt are the deck's own: the kit's ask() runs git synchronously and
// rereads the whole receipts log on every call, which would stall the event loop.
const ENDPOINT = "https://api.typesafe.ai/v1/systemone"; // the only place the key is ever sent
let TIMEOUT_MS = 8_000; // the deck is realtime; the kit's 25 s is far too long to wait
const MAX_REQUEST_BYTES = 90_000, MAX_RESPONSE_BYTES = 64 * 1024; // the kit's limits
const HTTP_FALLBACK: Record<number, string> = { 401: "credential_rejected", 403: "credential_rejected", 422: "request_rejected", 429: "rate_limited", 529: "overloaded" };
type Kit = {
  validateQuestions(q: unknown): void;
  validateAnswers(q: unknown, body: unknown, model: string): unknown;
  deepRedact<T>(v: T): T;
  resolveKey(): { key: string | null };
};
let kitP: Promise<Kit | null> | undefined;
/** The kit module, imported once; null (use the CLI) when BIN isn't a JS module or lacks what's needed. */
function loadKit(): Promise<Kit | null> {
  return (kitP ??= (async () => {
    try {
      const real = realpathSync(BIN!); // ~/.local/bin/jev is a symlink to the .mjs
      if (!/\.m?js$/.test(real)) return null;
      const m = await import(pathToFileURL(real).href);
      return ["validateQuestions", "validateAnswers", "deepRedact", "resolveKey"].every((f) => typeof m[f] === "function") ? (m as Kit) : null;
    } catch { return null; }
  })());
}
let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Tests: answer requests without the network; returns the previous fetch. */
export function _setFetch(fn: typeof fetch | null) { const prev = fetchImpl; fetchImpl = fn ?? ((...a) => fetch(...a)); return prev; }

// The key lives in memory only: never written, logged or returned. Re-resolved after a 401/403.
let apiKey: string | null = null;
function resolveApiKey(kit: Kit) {
  if (apiKey) return apiKey;
  // The deck's key file isn't one the kit looks for by itself; point it there, as the CLI's env does.
  const prev = process.env.JEV_KEY_FILE, useFile = !process.env.TYPESAFE_API_KEY && existsSync(KEY_FILE);
  if (useFile) process.env.JEV_KEY_FILE = KEY_FILE;
  try { apiKey = kit.resolveKey()?.key || null; } catch { apiKey = null; }
  finally { if (useFile) { if (prev === undefined) delete process.env.JEV_KEY_FILE; else process.env.JEV_KEY_FILE = prev; } }
  return apiKey;
}

/** Same format as the kit's receipt fingerprints. */
const kitFingerprint = (v: unknown) => `v1:${createHash("sha256").update(JSON.stringify(v)).digest("hex")}`;
async function appendReceipt(r: Record<string, unknown>) {
  // A log that can't be written never fails the decision.
  try {
    await mkdir(dirname(RECEIPTS_FILE), { recursive: true, mode: 0o700 });
    await appendFile(RECEIPTS_FILE, `${JSON.stringify(r)}\n`, { mode: 0o600 });
  } catch {}
}

async function askDirect(kit: Kit, state: unknown, questions: Record<string, unknown>, kind: string): Promise<JevAnswer> {
  const model = process.env.JEV_MODEL ?? "jev-1.13.0";
  // The kit's jev-receipt-v1 fields, without the input (the kit stores it only when asked to).
  const rec: Record<string, unknown> = {
    schema: "jev-receipt-v1", event: "decision", type: "ask", decision_id: randomUUID(), ts: new Date().toISOString(), agent: "herdr-deck", kind,
    cwd: process.cwd(), repo: null, model_requested: model, question_version: `herdr-deck-${kind}-v1`, calls_used: 0,
    state_fingerprint: null, questions_fingerprint: null, http_status: null, latency_ms: null, model_returned: null, usage: null, answers: null, fallback: null, error: null,
  };
  let ms: number | undefined;
  const finish = async (patch: Record<string, unknown>): Promise<JevAnswer> => {
    const r = { ...rec, ...patch };
    await appendReceipt(r);
    return { id: r.decision_id as string, answers: (r.answers as any) ?? undefined, fallback: (r.fallback as string) ?? null, error: (r.error as string) ?? undefined, ms };
  };
  try { kit.validateQuestions(questions); } catch (e: any) { return finish({ fallback: "invalid_input", error: e?.detail?.why ?? null }); }
  const s = kit.deepRedact(state ?? ""), q = kit.deepRedact(questions);
  rec.state_fingerprint = kitFingerprint(s);
  rec.questions_fingerprint = kitFingerprint(q);
  // Whatever JEV_ENDPOINT says, the credential only ever goes to the official service.
  if (process.env.JEV_ENDPOINT && process.env.JEV_ENDPOINT !== ENDPOINT) return finish({ fallback: "endpoint_rejected" });
  const key = resolveApiKey(kit);
  if (!key) return finish({ fallback: "credential_unavailable" });
  const body = JSON.stringify({ model, state: s, questions: q });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return finish({ fallback: "request_too_large" });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  const took = () => (ms = Math.round(performance.now() - t0));
  let status: number | null = null;
  try {
    const res = await fetchImpl(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: ctl.signal, redirect: "error" });
    status = res.status;
    if (!res.ok) {
      if (status === 401 || status === 403) apiKey = null; // maybe rotated: look it up again next time
      // Provider error bodies can echo the input: keep only the status.
      await res.body?.cancel().catch(() => {});
      took();
      return finish({ fallback: HTTP_FALLBACK[status] ?? "http_error", calls_used: 1, http_status: status });
    }
    const text = await res.text();
    took();
    let json: any;
    try {
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("response too large");
      json = JSON.parse(text);
      kit.validateAnswers(q, json, model);
    } catch (e: any) { return finish({ fallback: "invalid_response", calls_used: 1, http_status: status, error: e?.detail?.why ?? null }); }
    return finish({ http_status: status, latency_ms: ms, calls_used: 1, model_returned: json.model, usage: json.usage ?? null, answers: json.answers });
  } catch (e: any) {
    took();
    return finish({ fallback: ctl.signal.aborted || e?.name === "AbortError" ? "timeout" : "transport_error", calls_used: 1, http_status: status });
  } finally { clearTimeout(timer); }
}

/** One typed request ({state, questions}); counts against the deck's daily cap. Prefer jevAskOnce. */
export async function jevAsk<QS extends JevQuestions>(state: unknown, questions: QS, kind: string): Promise<JevAnswer<JevAnswers<QS>>> {
  if (!jevAvailable()) return { fallback: "unavailable" };
  if (usage.day !== localDay()) usage = { day: localDay(), n: 0 };
  if (usage.n >= jevCap()) return { fallback: "deck_daily_cap" };
  usage.n++;
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(COUNT_FILE, JSON.stringify(usage)); } catch {}
  // A runner set by a test answers instead of the kit.
  const kit = run === spawnJev ? await loadKit() : null;
  if (kit) return askDirect(kit, state, questions, kind) as Promise<JevAnswer<JevAnswers<QS>>>;
  const r = await run(["ask"], JSON.stringify({ state, questions, kind, question_version: `herdr-deck-${kind}-v1` }));
  return { id: r.decision_id, answers: r.answers, fallback: r.fallback ?? null, error: r.error ?? undefined, ms: r.latency_ms ?? undefined };
}

// ── one answer per question ──────────────────────────────────────────────────
// The same request (kind + state + questions) is asked at most once: concurrent askers share the call in
// flight, and answers are kept (across restarts, and across decks on this machine) by fingerprint.
export type CacheEntry = { id: string; answers: Record<string, any>; kind: string; at: number; label?: string; opts?: Record<string, string>; outcome?: string };
const CACHE_MAX = 2000, CACHE_DAYS = 45;
let cache = new Map<string, CacheEntry>();
let cacheMtime = 0;
function loadCache() {
  try {
    const m = statSync(CACHE_FILE).mtimeMs;
    if (m === cacheMtime) return;
    const disk: Record<string, CacheEntry> = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    for (const [fp, e] of Object.entries(disk)) { const mine = cache.get(fp); cache.set(fp, mine ? { ...e, ...mine, outcome: mine.outcome ?? e.outcome } : e); }
    cacheMtime = m;
  } catch {}
}
function saveCache() {
  const cut = Date.now() - CACHE_DAYS * 86_400_000;
  const keep = [...cache.entries()].filter(([, e]) => e.at >= cut).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
  cache = new Map(keep);
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(keep))); cacheMtime = statSync(CACHE_FILE).mtimeMs; } catch {}
}
const inflight = new Map<string, Promise<JevAnswer<any>>>();

/** (Re)read the deck's Jev state from DIR. */
function loadState() {
  COUNT_FILE = `${DIR}/jev-usage.json`; SETTINGS_FILE = `${DIR}/jev-settings.json`; CACHE_FILE = `${DIR}/jev-cache.json`;
  settings = {}; usage = { day: localDay(), n: 0 }; cache = new Map(); cacheMtime = 0;
  try { settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) ?? {}; } catch {}
  try { const u = JSON.parse(readFileSync(COUNT_FILE, "utf8")); if (u.day === localDay()) usage = u; } catch {}
  loadCache();
}
loadState();
/** Tests: point the deck's Jev state at a scratch dir, the kit/CLI at a stand-in and the receipts at a scratch file (the runner and fetch are swapped separately). */
export function _configure(o: { dir?: string; bin?: string; receipts?: string; timeoutMs?: number }) {
  if (o.dir) DIR = o.dir;
  if (o.timeoutMs) TIMEOUT_MS = o.timeoutMs;
  if (o.bin) { BIN = o.bin; kitP = undefined; }
  if (o.receipts) RECEIPTS_FILE = o.receipts;
  apiKey = null; inflight.clear(); loadState();
}

export const fingerprint = (kind: string, state: unknown, questions: unknown) => createHash("sha256").update(JSON.stringify({ kind, state, questions })).digest("hex").slice(0, 32);

/** Ask once per fingerprint. `meta` (a short label, option titles) is kept with the answer for the Jev panel. */
export function jevAskOnce<QS extends JevQuestions>(state: unknown, questions: QS, kind: string, meta: { label?: string; opts?: Record<string, string> } = {}): Promise<JevAnswer<JevAnswers<QS>>> {
  const fp = fingerprint(kind, state, questions);
  loadCache();
  const hit = cache.get(fp);
  if (hit) return Promise.resolve({ id: hit.id, answers: hit.answers as JevAnswers<QS>, fallback: null, cached: true });
  let p = inflight.get(fp) as Promise<JevAnswer<JevAnswers<QS>>> | undefined;
  if (!p) {
    p = jevAsk(state, questions, kind).then((r) => {
      if (!r.fallback && r.id && r.answers) { cache.set(fp, { id: r.id, answers: r.answers, kind, at: Date.now(), ...meta }); saveCache(); }
      return r;
    }).finally(() => inflight.delete(fp));
    inflight.set(fp, p);
  }
  return p;
}
/** The cached answers by Jev decision id (labels for the panel). */
export function cachedById() { loadCache(); return new Map([...cache.values()].map((e) => [e.id, e])); }

/** What you actually did with a suggestion: this is what makes Jev's stats mean something. Once per decision id. */
export async function jevOutcome(id: string, followed: boolean, note: string) {
  if (!BIN || !id) return false;
  loadCache();
  const e = [...cache.values()].find((x) => x.id === id);
  if (e?.outcome) return false;
  if (e) { e.outcome = note.slice(0, 60); saveCache(); }
  await run(["outcome", id, "--result", followed ? "success" : "failure", "--followed", String(followed), "--note", note.slice(0, 300)], undefined, 10_000).catch(() => {});
  return true;
}

export async function jevStats() {
  if (!BIN) return;
  const r = await run(["stats", "--days", "30"], undefined, 10_000).catch(() => undefined);
  return r;
}

/** Scrub what leaves the machine: secrets (jev also redacts), home paths, emails. */
export function scrub(s: string, n: number) {
  const t = String(s ?? "")
    .replace(/(?:\/Users|\/home)\/[\w.-]+/g, "~")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "<key>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (/^[a-f0-9-]{32,40}$/.test(m) ? m : "<token>"));
  return t.length > n ? "…" + t.slice(-n) : t;
}
