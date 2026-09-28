// What of the rows goes out on the live stream. A row is resent whole only when something the page shows changed;
// memory, CPU and the process count are readings that drift on every `ps` read (every 3 s), so they travel apart, in
// a small `procs` event ({ key: [rssKB, cpu, procs] }) at most every 10 s, and only for readings that moved.
import type { Row } from "./deck";

export type Usage = [rssKB: number, cpu: number, procs: number];
const READINGS = new Set(["rssKB", "cpu", "procs"]);
/** The row without its readings (top level only: nested objects keep their fields). */
export const rowSig = (r: Row) => JSON.stringify(r, function (this: unknown, k, v) { return this === r && READINGS.has(k) ? undefined : v; });
export const usageOf = (r: Row): Usage => [r.rssKB ?? 0, r.cpu ?? 0, r.procs ?? 0];
/** The readings as the page prints them: MB (a tenth of a GB past 1 GB), CPU to a tenth, the process count. */
const shown = (u: Usage) => `${u[0] >= 1048576 ? (u[0] / 1048576).toFixed(1) + "G" : Math.round(u[0] / 1024)}|${u[1].toFixed(1)}|${u[2]}`;

const USAGE_EVERY = 10_000;
/** Readings that moved below what the page prints (the footer adds them up) still go out once a minute. */
const USAGE_ALL_EVERY = 60_000;

export class RowFeed {
  private sigs = new Map<string, string>();
  private starts = new Map<string, number | undefined>();
  private usage = new Map<string, Usage>();
  private usageAt = 0;
  private allAt = 0;

  /** Rows whose visible part changed since they were last sent, and (when `rows` is every row) the keys now gone. */
  diff(rows: Iterable<Row>, all = true): { upsert: Row[]; remove: string[] } {
    const upsert: Row[] = [], seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.key);
      // A start time that moved by under 2 s is the same process read again (one-second `ps` times on a millisecond
      // clock): a node on an older version sends it like that, and so do fake rows.
      const was = this.starts.get(r.key);
      if (was !== undefined && r.startedAt !== undefined && Math.abs(r.startedAt - was) < 2000) r.startedAt = was;
      const sig = rowSig(r);
      if (this.sigs.get(r.key) === sig) continue;
      this.sigs.set(r.key, sig);
      this.starts.set(r.key, r.startedAt);
      this.usage.set(r.key, usageOf(r));
      upsert.push(r);
    }
    const remove: string[] = [];
    if (all) for (const k of this.sigs.keys()) if (!seen.has(k)) { this.forget(k); remove.push(k); }
    return { upsert, remove };
  }
  forget(key: string) {
    this.sigs.delete(key);
    this.starts.delete(key);
    this.usage.delete(key);
  }
  /** The readings that moved since they were sent, keyed by row; undefined when none did or it isn't time yet. */
  takeUsage(rows: Iterable<Row>, now = Date.now()): Record<string, Usage> | undefined {
    if (now - this.usageAt < USAGE_EVERY) return;
    this.usageAt = now;
    const every = now - this.allAt >= USAGE_ALL_EVERY;
    if (every) this.allAt = now;
    const out: Record<string, Usage> = {};
    let any = false;
    for (const r of rows) {
      const was = this.usage.get(r.key);
      if (!was) continue; // not sent yet: its upsert will carry them
      const u = usageOf(r);
      if (every ? u.join() === was.join() : shown(u) === shown(was)) continue;
      this.usage.set(r.key, u);
      out[r.key] = u;
      any = true;
    }
    return any ? out : undefined;
  }
  /** Readings the page already got another way (a node's own `procs` event, mirrored as is). */
  noteUsage(key: string, u: Usage) {
    if (this.usage.has(key)) this.usage.set(key, u);
  }
}
