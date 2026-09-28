// Model calls for the idea engine, with a hard budget and a ledger. Claude runs headless exactly like the Mixer
// (print mode, no tools, no MCP, no settings/plugins, nothing saved, low effort) but returns usage and cost too.
// Jev goes through the deck's own wrapper (src/jev.ts), so every call lands in the same receipts.
// Replies are cached by prompt hash: re-running an experiment step never spends twice.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { jevAsk, type JevAnswer } from "../../../src/jev";

const HOME = homedir();
const BIN_DIRS = [`${HOME}/.local/bin`, `${HOME}/.claude/local`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH ?? "").split(":")];
const CLAUDE = process.env.DECK_CLAUDE_BIN || BIN_DIRS.map((d) => `${d}/claude`).find((p) => existsSync(p));
export const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

type LedgerEntry = { at: number; kind: "claude" | "jev"; tag: string; model?: string; ms: number; costUsd?: number; inTok?: number; outTok?: number; ok: boolean; cached?: boolean; id?: string; error?: string };
type Ledger = { claude: { calls: number; max: number; costUsd: number; inTok: number; outTok: number; ms: number }; jev: { calls: number; max: number; ms: number; ids: string[] }; entries: LedgerEntry[] };
class BudgetError extends Error {}

/** A spending guard + ledger, optionally persisted (so separate runs of an experiment share one budget). */
export function createBudget(o: { file?: string; claudeMax: number; jevMax: number; cacheDir?: string }) {
  const load = (): Ledger | undefined => { try { return o.file ? JSON.parse(readFileSync(o.file, "utf8")) : undefined; } catch { return undefined; } };
  const l: Ledger = load() ?? { claude: { calls: 0, max: o.claudeMax, costUsd: 0, inTok: 0, outTok: 0, ms: 0 }, jev: { calls: 0, max: o.jevMax, ms: 0, ids: [] }, entries: [] };
  l.claude.max = o.claudeMax; l.jev.max = o.jevMax;
  const save = () => { if (!o.file) return; mkdirSync(o.file.replace(/\/[^/]+$/, ""), { recursive: true }); writeFileSync(o.file, JSON.stringify(l, null, 1)); };
  const cachePath = (k: string) => (o.cacheDir ? `${o.cacheDir}/${k}.json` : "");
  return {
    ledger: l, save,
    claudeLeft: () => l.claude.max - l.claude.calls,
    jevLeft: () => l.jev.max - l.jev.calls,
    cacheGet(k: string): any { const p = cachePath(k); if (!p) return undefined; try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } },
    cachePut(k: string, v: any) { const p = cachePath(k); if (!p) return; mkdirSync(o.cacheDir!, { recursive: true }); writeFileSync(p, JSON.stringify(v)); },
    spend(kind: "claude" | "jev") {
      if (kind === "claude" && l.claude.calls >= l.claude.max) throw new BudgetError(`Claude budget used up (${l.claude.calls}/${l.claude.max})`);
      if (kind === "jev" && l.jev.calls >= l.jev.max) throw new BudgetError(`Jev budget used up (${l.jev.calls}/${l.jev.max})`);
      l[kind].calls++;
    },
    record(e: LedgerEntry) {
      l.entries.push(e);
      if (e.kind === "claude" && !e.cached) { l.claude.costUsd += e.costUsd ?? 0; l.claude.inTok += e.inTok ?? 0; l.claude.outTok += e.outTok ?? 0; l.claude.ms += e.ms; }
      if (e.kind === "jev" && !e.cached) { l.jev.ms += e.ms; if (e.id) l.jev.ids.push(e.id); }
      save();
    },
  };
}
type Budget = ReturnType<typeof createBudget>;

type ClaudeResult = { text: string; model: string; ms: number; costUsd: number; inTok: number; outTok: number; cached: boolean };
export type ClaudeRunner = (o: { system: string; user: string; model?: string; timeoutMs?: number; tag: string }) => Promise<ClaudeResult>;

/** One headless Claude call → the reply text plus usage. Throws on errors (the caller decides what to fall back to). */
async function claudeOnce(o: { system: string; user: string; model?: string; timeoutMs?: number }): Promise<Omit<ClaudeResult, "cached">> {
  if (!CLAUDE) throw new Error("Claude Code (claude) isn't installed here");
  const model = o.model ?? "haiku";
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", MAX_THINKING_TOKENS: "0", NO_COLOR: "1" };
  delete env.CLAUDECODE;
  const t0 = Date.now();
  const p = Bun.spawn([CLAUDE, "-p", "--safe-mode", "--model", model, "--effort", "low", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "",
    "--output-format", "json", "--system-prompt", o.system], { cwd: tmpdir(), stdin: new Blob([o.user]), stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => { try { p.kill(9); } catch {} }, o.timeoutMs ?? 240_000);
  const out = await new Response(p.stdout as ReadableStream).text();
  const err = await new Response(p.stderr as ReadableStream).text().catch(() => "");
  await p.exited; clearTimeout(timer);
  let j: any; try { j = JSON.parse(out); } catch {}
  if (!j) throw new Error(`Claude returned no JSON envelope: ${(err || out).trim().split("\n").pop()?.slice(0, 200)}`);
  if (j.is_error) throw new Error(`Claude error: ${String(j.result ?? j.subtype ?? "").slice(0, 200)}`);
  const u = j.usage ?? {};
  return { text: String(j.result ?? ""), model, ms: Date.now() - t0, costUsd: Number(j.total_cost_usd ?? 0), inTok: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outTok: u.output_tokens ?? 0 };
}

/** A budgeted, cached, ledgered Claude runner. */
export function budgetedClaude(b: Budget, run: typeof claudeOnce = claudeOnce): ClaudeRunner {
  return async (o) => {
    const key = `claude-${hashOf(`${o.model ?? "haiku"}\n${o.system}\n${o.user}`)}`;
    const hit = b.cacheGet(key);
    if (hit?.text) { b.record({ at: Date.now(), kind: "claude", tag: o.tag, model: hit.model, ms: 0, ok: true, cached: true }); return { ...hit, cached: true }; }
    b.spend("claude");
    try {
      const r = await run(o);
      b.cachePut(key, r);
      b.record({ at: Date.now(), kind: "claude", tag: o.tag, model: r.model, ms: r.ms, costUsd: r.costUsd, inTok: r.inTok, outTok: r.outTok, ok: true });
      return { ...r, cached: false };
    } catch (e: any) {
      b.record({ at: Date.now(), kind: "claude", tag: o.tag, model: o.model, ms: 0, ok: false, error: String(e?.message ?? e).slice(0, 200) });
      throw e;
    }
  };
}

export type JevRunner = (state: unknown, questions: Record<string, any>, kind: string, tag: string) => Promise<JevAnswer & { ms: number; cached?: boolean }>;
/** A budgeted, cached, ledgered Jev asker (through the deck's jevAsk, so its daily cap and receipts apply). */
export function budgetedJev(b: Budget, ask: typeof jevAsk = jevAsk): JevRunner {
  return async (state, questions, kind, tag) => {
    const key = `jev-${hashOf(JSON.stringify({ kind, state, questions }))}`;
    const hit = b.cacheGet(key);
    if (hit?.answers) { b.record({ at: Date.now(), kind: "jev", tag, ms: 0, ok: true, cached: true, id: hit.id }); return { ...hit, cached: true, ms: 0 }; }
    b.spend("jev");
    const t0 = Date.now();
    const r = await ask(state, questions, kind);
    const ms = Date.now() - t0;
    const ok = !r.fallback && !!r.answers;
    if (ok) b.cachePut(key, r);
    b.record({ at: Date.now(), kind: "jev", tag, ms, ok, id: r.id, error: r.fallback ?? r.error });
    return { ...r, ms };
  };
}

/** Token usage of Jev decisions, from the jev CLI's receipts (by decision id). */
export function jevUsageFor(ids: string[], file = process.env.DECK_JEV_RECEIPTS ?? `${process.env.JEV_HOME ?? `${HOME}/.jev`}/receipts.jsonl`) {
  const want = new Set(ids);
  let inTok = 0, outTok = 0, n = 0, lat = 0;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("decision_id")) continue;
      let r: any; try { r = JSON.parse(line); } catch { continue; }
      if (!want.has(r.decision_id) || !r.usage) continue;
      inTok += r.usage.input_tokens ?? 0; outTok += r.usage.output_tokens ?? 0; lat += r.latency_ms ?? 0; n++;
    }
  } catch {}
  return { n, inTok, outTok, latencyMs: lat, usd: (inTok / 1e6) * 0.042 };
}
