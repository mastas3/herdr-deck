// Jev (TypeSafe's calibrated judgment model) through the local `jev` CLI, so every call lands in the
// same receipts (~/.jev) and `jev stats` as the rest of your Jev use. Advisory only: nothing the deck
// does waits on, or acts on, a Jev answer by itself.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const BIN = [`${HOME}/.local/bin/jev`, `${HOME}/.local/share/jev-kit/bin/jev.mjs`].find((p) => existsSync(p));
const KEY_FILE = process.env.JEV_KEY_FILE ?? `${HOME}/.config/typesafe/api-key`;
const COUNT_FILE = `${HOME}/.config/herdr-deck/jev-usage.json`;
export const JEV_DAILY = Number(process.env.DECK_JEV_DAILY ?? 80);

export const jevAvailable = () => !!BIN && (existsSync(KEY_FILE) || !!process.env.TYPESAFE_API_KEY) && !process.env.DECK_NO_JEV;

const today = () => new Date().toISOString().slice(0, 10);
let usage: { day: string; n: number } = { day: today(), n: 0 };
try { const u = JSON.parse(readFileSync(COUNT_FILE, "utf8")); if (u.day === today()) usage = u; } catch {}
export const jevUsage = () => ({ day: usage.day, calls: usage.day === today() ? usage.n : 0, cap: JEV_DAILY, available: jevAvailable() });

async function run(args: string[], stdin?: string, timeout = 30_000): Promise<any> {
  const env: Record<string, string> = { ...(process.env as any), JEV_AGENT: "herdr-deck", PATH: `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` };
  if (!env.TYPESAFE_API_KEY && existsSync(KEY_FILE)) env.JEV_KEY_FILE = KEY_FILE;
  // Bun runs the Node script fine, and doesn't depend on node being on the service's PATH.
  const p = Bun.spawn([process.execPath, BIN!, ...args], { stdin: stdin ? new TextEncoder().encode(stdin) : "ignore", stdout: "pipe", stderr: "pipe", env, cwd: HOME });
  const t = setTimeout(() => p.kill(9), timeout);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(t);
  try { return JSON.parse(out); } catch { return { fallback: "invalid_output" }; }
}

export type JevAnswer = { id?: string; answers?: Record<string, any>; fallback?: string | null; error?: string };

/** One typed request ({state, questions}); counts against the deck's daily cap. */
export async function jevAsk(state: unknown, questions: Record<string, any>, kind: string): Promise<JevAnswer> {
  if (!jevAvailable()) return { fallback: "unavailable" };
  if (usage.day !== today()) usage = { day: today(), n: 0 };
  if (usage.n >= JEV_DAILY) return { fallback: "deck_daily_cap" };
  usage.n++;
  try { writeFileSync(COUNT_FILE, JSON.stringify(usage)); } catch {}
  const r = await run(["ask"], JSON.stringify({ state, questions, kind, question_version: `herdr-deck-${kind}-v1` }));
  return { id: r.decision_id, answers: r.answers, fallback: r.fallback ?? null, error: r.error ?? undefined };
}

/** What you actually did with a suggestion: this is what makes Jev's stats mean something. */
export async function jevOutcome(id: string, followed: boolean, note: string) {
  if (!BIN || !id) return;
  await run(["outcome", id, "--result", followed ? "success" : "failure", "--followed", String(followed), "--note", note.slice(0, 300)], undefined, 10_000).catch(() => {});
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
