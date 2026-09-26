// The game layer's files, on the hub only (~/.config/herdr-deck/game/, DECK_GAME_DIR moves it): state.json (main quest
// and its history, runs, retired projects, week goals and reviews), ledger.json (append-only XP lines, each with its
// evidence), proofs.json (append-only: what you logged here, checks that passed), quests.json (quests by day and project).
// Nothing is written until the board is first opened.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendProofs, dayOf, revokedIds, type Line, type Proof } from "./game-rules";
import type { Quest, Rejected } from "./game-quests";
import type { Run } from "./game-runs";

export type Week = { goal?: string; goalAt?: number; lessons?: string; judge?: { id?: string; p?: number; choice?: string; reason?: string; at: number; fallback?: string; sig: string; cached?: boolean }; dispute?: { note: string; at: number } };
export type State = {
  v: 1; startedAt: number; tz?: string;
  main: { project: string; since: number } | null; history: { project: string | null; from: number }[];
  candidate?: string; runs: Record<string, Run>; retired: Record<string, { at: number; note: string }>;
  weeks: Record<string, Week>; notified: string[]; generations: Record<string, number>;
};
export type DayQuests = { day: string; project: string; createdAt: number; source: string; model?: string; note?: string; ms?: number; items: Quest[]; spares: Quest[]; rerolls: number; rejected?: Rejected[] };
export type StoredProof = Proof & { at?: number };
/** Quests are kept per day and project: switching the main quest away and back brings its quests back. */
export const questKey = (day: string, project: string) => `${day}|${project}`;
export type Store = ReturnType<typeof createStore>;

export function createStore(dir: string, now: () => number) {
  const F = { state: `${dir}/state.json`, ledger: `${dir}/ledger.json`, proofs: `${dir}/proofs.json`, quests: `${dir}/quests.json` };
  const read = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) ?? d; } catch { return d; } };
  const write = (f: string, v: unknown) => { mkdirSync(dir, { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v, null, 1)); renameSync(tmp, f); };
  let state: State | undefined = existsSync(F.state) ? read<State | undefined>(F.state, undefined) : undefined;
  const ledger: Line[] = read(F.ledger, [] as Line[]);
  let proofs: StoredProof[] = read(F.proofs, [] as StoredProof[]);
  const quests: Record<string, DayQuests> = read(F.quests, {} as Record<string, DayQuests>);

  function ensure(): State {
    if (!state) { state = { v: 1, startedAt: now(), main: null, history: [], runs: {}, retired: {}, weeks: {}, notified: [], generations: {} }; saveState(); }
    return state;
  }
  const saveState = () => write(F.state, state);
  const tz = () => state?.tz;

  /** Pays the proofs not paid yet (the same evidence id never pays twice). */
  function record(ps: Proof[]) {
    const s = ensure();
    const add = appendProofs(ledger, ps, { now: now(), startedAt: s.startedAt, history: s.history, tz: tz() });
    if (add.length) { ledger.push(...add); write(F.ledger, ledger); }
    return add;
  }
  /** Takes a line back by appending a revoke line: the ledger only grows. */
  function revoke(id: string, reason: string) {
    const l = ledger.find((x) => x.id === id && x.kind !== "revoke");
    if (!l || revokedIds(ledger).has(id)) return false;
    ledger.push({ ...l, id: `revoke:${id}:${now()}`, kind: "revoke", type: "bonus", title: `Undone: ${l.title}`, evidence: reason, xp: 0, at: now(), t: l.t, revokes: id });
    write(F.ledger, ledger);
    return true;
  }
  const manualProofs = () => { const gone = new Set(proofs.filter((p) => p.kind === "revoke").map((p) => p.id.replace(/^revoke:/, ""))); return proofs.filter((p) => p.kind !== "revoke" && !gone.has(p.id)); };
  /** What you logged here (a lead, a conversation, a live link, a retired project), paid at once. Undefined: already logged. */
  function addManual(p: Proof) {
    if (proofs.some((x) => x.id === p.id) && !proofs.some((x) => x.id === `revoke:${p.id}`)) return undefined;
    proofs = proofs.filter((x) => x.id !== p.id && x.id !== `revoke:${p.id}`);
    // Undone earlier and logged again: its old ledger line was revoked, so it pays under a new id.
    const q = ledger.some((l) => l.id === p.id) ? { ...p, id: `${p.id}#${now()}` } : p;
    proofs.push({ ...q, at: now() });
    write(F.proofs, proofs);
    return record([q])[0];
  }
  function unlog(id: string) {
    const p = proofs.find((x) => x.id === id);
    if (!p) return false;
    proofs.push({ ...p, id: `revoke:${id}`, kind: "revoke", at: now() });
    write(F.proofs, proofs);
    return revoke(id, "undone by you");
  }
  /** A check that passed, kept here (checks.json only remembers the latest result). */
  function keepCheck(p: Proof) {
    if (proofs.some((x) => x.id === p.id)) return false;
    proofs.push({ ...p, at: now() });
    write(F.proofs, proofs);
    return true;
  }

  return {
    get state() { return state; }, ensure, saveState, tz, today: () => dayOf(now(), tz()),
    ledger, quests, get proofs() { return proofs; },
    record, revoke, manualProofs, addManual, unlog, keepCheck,
    saveQuests: () => write(F.quests, quests),
    readJson: read,
  };
}
