// Plan limits as the agents themselves write them on this machine: Claude Code's rate limits (cached by the user's
// statusline script, the only place Claude Code hands them out) and the newest Codex rollout's rate_limits. Pure
// parsers first, then the readers. Whose account they are is src/usage-accounts.ts; the connections scan reads the
// Codex plan from here too.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

export type Window = { id: string; label: string; pct?: number; resets?: number; minutes?: number };
export type Limits = { at?: number; windows: Window[]; plan?: string };

/** JSON, tolerating a BOM. */
export const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")); } catch { return undefined; } };
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const num = (v: unknown) => (v === "" || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
/** Seconds or milliseconds (or a string of either) to milliseconds. */
const ms = (v: unknown) => { const n = num(v); return n == null || n <= 0 ? undefined : n < 1e12 ? n * 1000 : n; };

/**
 * ~/.claude/rate-cache.json in either shape a statusline script writes:
 *   { five_hour, seven_day, five_hour_resets, seven_day_resets, at }   (strings or numbers, "" when absent)
 *   { r5, r7, r5_resets_at, r7_resets_at, ts, ... }                    (0 when absent, resets "" then)
 * A window with no number, or the second shape's 0 with no reset time, is unknown, never 0%.
 */
export function parseClaudeCache(rc: any, mtime?: number): Limits | undefined {
  if (!rc || typeof rc !== "object") return;
  const short = "r5" in rc || "r7" in rc;
  const win = (id: string, minutes: number, v: unknown, resets: unknown): Window => {
    let pct = num(v);
    const r = ms(resets);
    if (short && pct === 0 && !r) pct = undefined; // that script writes 0 when Claude Code sent no limits
    return { id, label: id, minutes, pct, resets: r };
  };
  const windows = short
    ? [win("5h", 300, rc.r5, rc.r5_resets_at), win("week", 10080, rc.r7, rc.r7_resets_at)]
    : [win("5h", 300, rc.five_hour, rc.five_hour_resets), win("week", 10080, rc.seven_day, rc.seven_day_resets)];
  const at = ms(rc.at ?? rc.ts) ?? mtime;
  return { at, windows: windows.some((w) => w.pct != null) ? windows : [] };
}

export function claudeLimits(home = homedir()): Limits | undefined {
  const f = `${home}/.claude/rate-cache.json`;
  let mtime: number | undefined;
  try { mtime = statSync(f).mtimeMs; } catch { return; }
  return parseClaudeCache(readJson(f), mtime);
}

const winLabel = (m: number) => (m >= 10000 ? "week" : m >= 250 ? `${Math.round(m / 60)}h` : `${m}m`);
/** One Codex rollout line's rate_limits, timed by the event itself (a resumed old rollout keeps old readings). */
export function parseCodexLine(line: string): Limits | undefined {
  if (!line.includes('"rate_limits":{')) return;
  let o: any;
  try { o = JSON.parse(line); } catch { return; }
  const rl = o?.payload?.rate_limits ?? o?.rate_limits;
  if (!rl || typeof rl !== "object") return;
  const w = (x: any): Window | undefined => x && { id: winLabel(x.window_minutes), label: winLabel(x.window_minutes), pct: num(x.used_percent), resets: ms(x.resets_at), minutes: x.window_minutes };
  const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
  return { at: Number.isFinite(at) ? at : undefined, plan: rl.plan_type ?? undefined, windows: [w(rl.primary), w(rl.secondary)].filter(Boolean) as Window[] };
}

// Every rollout's path, listed again every few minutes; each poll stats them to find the ones written lately.
let codexFiles: { list: string[]; at: number; root: string } = { list: [], at: 0, root: "" };
const codexParsed = new Map<string, { size: number; mtime: number; limits?: Limits }>();
function rollouts(root: string): string[] {
  if (codexFiles.root === root && Date.now() - codexFiles.at < 5 * 60_000) return codexFiles.list;
  const list: string[] = [];
  for (const y of ls(root)) for (const m of ls(`${root}/${y}`)) for (const d of ls(`${root}/${y}/${m}`)) {
    for (const n of ls(`${root}/${y}/${m}/${d}`)) if (n.endsWith(".jsonl")) list.push(`${root}/${y}/${m}/${d}/${n}`);
  }
  codexFiles = { list, at: Date.now(), root };
  return list;
}
function lastLimits(f: string, size: number): Limits | undefined {
  let tail = "";
  try {
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(f, "r");
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    tail = buf.toString("utf8");
  } catch { return; }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) { const l = parseCodexLine(lines[i]); if (l) return l; }
}

/** The newest Codex rate_limits reading on this machine, by the time Codex recorded it. */
export function latestCodexLimits(home = homedir()): Limits | undefined {
  const files: { f: string; m: number; size: number }[] = [];
  for (const f of rollouts(`${home}/.codex/sessions`)) { try { const s = statSync(f); files.push({ f, m: s.mtimeMs, size: s.size }); } catch {} }
  files.sort((a, b) => b.m - a.m);
  let best: Limits | undefined;
  for (const { f, m, size } of files.slice(0, 8)) {
    let hit = codexParsed.get(f);
    if (!hit || hit.size !== size || hit.mtime !== m) { hit = { size, mtime: m, limits: lastLimits(f, size) }; codexParsed.set(f, hit); }
    const l = hit.limits;
    if (l && (l.at ?? 0) >= (best?.at ?? -1)) best = l;
  }
  if (codexParsed.size > 64) for (const k of [...codexParsed.keys()].slice(0, codexParsed.size - 64)) codexParsed.delete(k);
  return best;
}
