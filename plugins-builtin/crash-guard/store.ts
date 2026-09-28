// Snapshots on disk: one small JSON file each in <data>/crash-guard/, the newest `keep` kept. A snapshot a crash points
// at is pinned (never rotated out) until that crash is closed. crashes.json holds the crashes still worth showing.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Crash, Snapshot } from "./snapshot";

export function createStore(dir: string) {
  mkdirSync(dir, { recursive: true });
  const file = (id: string) => join(dir, `snap-${id}.json`);
  const crashFile = join(dir, "crashes.json");
  const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
  let crashes: Crash[] = readJson(crashFile) ?? [];

  /** Snapshot ids, oldest first (the id is its time, zero-padded, so names sort in time order). */
  const ids = () => { try { return readdirSync(dir).filter((f) => /^snap-\d+\.json$/.test(f)).map((f) => f.slice(5, -5)).sort(); } catch { return []; } };
  const get = (id: string): Snapshot | undefined => (/^\d+$/.test(id) ? readJson(file(id)) : undefined);
  const latest = () => { const all = ids(); return all.length ? get(all[all.length - 1]) : undefined; };
  const idFor = (at: number) => String(at).padStart(14, "0");

  type Head = { id: string; at: number; seenAt: number; count: number; agents: number };
  const heads = new Map<string, Head>();
  const headOf = (s: Snapshot): Head => ({ id: s.id, at: s.at, seenAt: s.seenAt, count: s.panes.length, agents: s.panes.filter((p) => !!p.resume).length });

  function save(s: Snapshot, keep: number) {
    writeFileSync(file(s.id), JSON.stringify(s));
    heads.set(s.id, headOf(s));
    const pinned = new Set(crashes.map((c) => c.snapshotId));
    const all = ids().filter((id) => !pinned.has(id));
    for (const id of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) remove(id);
  }
  function remove(id: string) { rmSync(file(id), { force: true }); heads.delete(id); }
  /** Every snapshot's header (no panes), newest first; each file is read once. */
  function list() {
    const out: (Head & { pinned: boolean })[] = [];
    for (const id of ids().reverse()) {
      let h = heads.get(id);
      if (!h) { const s = get(id); if (!s) continue; h = headOf(s); heads.set(id, h); }
      out.push({ ...h, pinned: crashes.some((c) => c.snapshotId === id) });
    }
    return out;
  }
  function setCrashes(next: Crash[]) {
    crashes = next.slice(-5);
    writeFileSync(crashFile, JSON.stringify(crashes, null, 1));
  }
  return { dir, ids, get, latest, idFor, save, remove, list, crashes: () => crashes, setCrashes, exists: () => existsSync(dir) };
}
export type Store = ReturnType<typeof createStore>;
