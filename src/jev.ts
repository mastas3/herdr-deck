// Jev (TypeSafe's calibrated judgment model) through the local `jev` CLI, so every call lands in the
// same receipts (~/.jev) and `jev stats` as the rest of your Jev use. Advisory only: nothing the deck
// does waits on, or acts on, a Jev answer by itself.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
let BIN = process.env.DECK_JEV_BIN ?? [`${HOME}/.local/bin/jev`, `${HOME}/.local/share/jev-kit/bin/jev.mjs`].find((p) => existsSync(p));
const KEY_FILE = process.env.JEV_KEY_FILE ?? `${HOME}/.config/typesafe/api-key`;
// Where the deck keeps its own Jev state (counter, cap, answer cache). Tests point this at a scratch dir.
let DIR = process.env.DECK_JEV_STATE_DIR ?? `${HOME}/.config/herdr-deck`;
let COUNT_FILE = "", SETTINGS_FILE = "", CACHE_FILE = "";
/** The receipts log the jev CLI writes (read-only for the deck). */
export const RECEIPTS_FILE = process.env.DECK_JEV_RECEIPTS ?? `${process.env.JEV_HOME ?? `${HOME}/.jev`}/receipts.jsonl`;
export const PRICE_PER_M_INPUT = 0.042; // USD per million input tokens; output is free

// TypeSafe itself has no daily limit (1,200 requests/min, 250k tokens/s). This is only the deck's own
// spending guard: ~1k input tokens a call at $0.042/M, so 1,000 calls is about $0.05 a day.
// Set in the Inbox's Jev panel (saved to jev-settings.json); DECK_JEV_DAILY is the default before that.
const DEFAULT_DAILY = 1000;
let settings: { daily?: number } = {};
export const jevCap = () => settings.daily ?? (process.env.DECK_JEV_DAILY ? Number(process.env.DECK_JEV_DAILY) : DEFAULT_DAILY);
const capSource = () => (settings.daily != null ? "settings" : process.env.DECK_JEV_DAILY ? "env" : "default");
export function setJevCap(n: number) {
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new Error("The cap is a whole number from 0 to 100,000");
  settings = { ...settings, daily: n };
  try { mkdirSync(DIR, { recursive: true }); } catch {}
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1));
}

export const jevAvailable = () => !!BIN && (existsSync(KEY_FILE) || !!process.env.TYPESAFE_API_KEY) && !process.env.DECK_NO_JEV;

/** Local calendar day: "today" resets at your midnight, not UTC's. */
export const localDay = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
let usage: { day: string; n: number } = { day: localDay(), n: 0 };
export const jevUsage = () => ({ day: localDay(), calls: usage.day === localDay() ? usage.n : 0, cap: jevCap(), capSource: capSource(), available: jevAvailable() });

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
/** Tests swap the CLI for a fake; returns the previous runner. */
export function _setRunner(fn: Runner | null) { const prev = run; run = fn ?? spawnJev; return prev; }

export type JevAnswer = { id?: string; answers?: Record<string, any>; fallback?: string | null; error?: string; cached?: boolean };

/** One typed request ({state, questions}); counts against the deck's daily cap. Prefer jevAskOnce. */
export async function jevAsk(state: unknown, questions: Record<string, any>, kind: string): Promise<JevAnswer> {
  if (!jevAvailable()) return { fallback: "unavailable" };
  if (usage.day !== localDay()) usage = { day: localDay(), n: 0 };
  if (usage.n >= jevCap()) return { fallback: "deck_daily_cap" };
  usage.n++;
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(COUNT_FILE, JSON.stringify(usage)); } catch {}
  const r = await run(["ask"], JSON.stringify({ state, questions, kind, question_version: `herdr-deck-${kind}-v1` }));
  return { id: r.decision_id, answers: r.answers, fallback: r.fallback ?? null, error: r.error ?? undefined };
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
const inflight = new Map<string, Promise<JevAnswer>>();

/** (Re)read the deck's Jev state from DIR. */
function loadState() {
  COUNT_FILE = `${DIR}/jev-usage.json`; SETTINGS_FILE = `${DIR}/jev-settings.json`; CACHE_FILE = `${DIR}/jev-cache.json`;
  settings = {}; usage = { day: localDay(), n: 0 }; cache = new Map(); cacheMtime = 0;
  try { settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) ?? {}; } catch {}
  try { const u = JSON.parse(readFileSync(COUNT_FILE, "utf8")); if (u.day === localDay()) usage = u; } catch {}
  loadCache();
}
loadState();
/** Tests: point the deck's Jev state at a scratch dir and the CLI at a stand-in (the runner is swapped separately). */
export function _configure(o: { dir?: string; bin?: string }) { if (o.dir) DIR = o.dir; if (o.bin) BIN = o.bin; inflight.clear(); loadState(); }

export const fingerprint = (kind: string, state: unknown, questions: unknown) => createHash("sha256").update(JSON.stringify({ kind, state, questions })).digest("hex").slice(0, 32);

/** Ask once per fingerprint. `meta` (a short label, option titles) is kept with the answer for the Jev panel. */
export function jevAskOnce(state: unknown, questions: Record<string, any>, kind: string, meta: { label?: string; opts?: Record<string, string> } = {}): Promise<JevAnswer> {
  const fp = fingerprint(kind, state, questions);
  loadCache();
  const hit = cache.get(fp);
  if (hit) return Promise.resolve({ id: hit.id, answers: hit.answers, fallback: null, cached: true });
  let p = inflight.get(fp);
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
