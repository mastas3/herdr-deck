// The Jev panel's numbers, from the receipts log the jev CLI writes (~/.jev/receipts.jsonl, schema
// jev-receipt-v1). The log is append-only, so it's read once and then only its new bytes; the panel's
// summary is recomputed only when the file (or the cap) changes. Read-only: the deck never writes it.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { PRICE_PER_M_INPUT, localDay, type CacheEntry } from "./jev";

export type Kind = "prompt" | "question" | "done";
const KINDS: Record<string, Kind> = { "deck-prompt": "prompt", "deck-choice": "question", "deck-done": "done" };

type Dec = {
  id: string; t: number; kind: Kind; group: string; calls: number; inTok: number; outTok: number; fallback: string | null; repeat: boolean;
  pick?: string; pickP?: number; done?: number; next?: string; low?: number;
};
type Out = { followed: boolean | null; note: string; result: string; t: number };

/** Parsed receipts, grown incrementally as the file grows. */
export class Receipts {
  decs: Dec[] = []; // the deck's own asks (agent herdr-deck), in file order
  outcomes = new Map<string, Out>();
  all: { t: number; calls: number; inTok: number }[] = []; // every agent's asks, for the "all Jev use" line
  rows = 0;
  private offset = 0;
  private rest = "";
  private seen = new Set<string>();
  private stamp = "";
  constructor(public file: string) {}

  /** Read what's new; true when anything changed. */
  refresh(): boolean {
    let st;
    try { st = statSync(this.file); } catch { if (this.offset) this.reset(); return false; }
    const stamp = `${st.size}|${st.mtimeMs}`;
    if (stamp === this.stamp) return false;
    if (st.size < this.offset) this.reset(); // rotated or truncated: start over
    this.stamp = stamp;
    if (st.size === this.offset) return true;
    const fd = openSync(this.file, "r");
    try {
      const buf = Buffer.alloc(st.size - this.offset);
      let got = 0;
      while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, this.offset + got); if (!n) break; got += n; }
      this.offset += got;
      const text = this.rest + buf.subarray(0, got).toString("utf8");
      const lines = text.split("\n");
      this.rest = lines.pop() ?? "";
      for (const l of lines) this.add(l);
    } finally { closeSync(fd); }
    return true;
  }
  private reset() { this.decs = []; this.outcomes.clear(); this.all = []; this.rows = 0; this.offset = 0; this.rest = ""; this.seen.clear(); this.stamp = ""; }
  private add(line: string) {
    if (!line.trim()) return;
    let r: any;
    try { r = JSON.parse(line); } catch { return; }
    if (r?.schema !== "jev-receipt-v1" || !r.decision_id) return;
    this.rows++;
    const t = Date.parse(r.ts);
    if (r.event === "outcome") { this.outcomes.set(r.decision_id, { followed: typeof r.followed === "boolean" ? r.followed : null, note: String(r.note ?? ""), result: String(r.result ?? ""), t }); return; }
    if (r.event !== "decision") return;
    const calls = Number(r.calls_used ?? 0) || 0, inTok = Number(r.usage?.input_tokens ?? 0) || 0, outTok = Number(r.usage?.output_tokens ?? 0) || 0;
    this.all.push({ t, calls, inTok });
    const kind = r.agent === "herdr-deck" ? KINDS[r.kind] : undefined;
    if (!kind) return;
    const group = `${r.kind}|${r.state_fingerprint ?? ""}|${r.questions_fingerprint ?? ""}`;
    const repeat = calls > 0 && this.seen.has(group);
    if (calls > 0 && !r.fallback) this.seen.add(group);
    const a = r.answers ?? {};
    const pick = a.pick?.choice;
    this.decs.push({
      id: r.decision_id, t, kind, group, calls, inTok, outTok, fallback: r.fallback ?? null, repeat,
      pick: pick != null ? String(pick).replace(/^o(?=\d$)/, "") : undefined, pickP: pick != null ? a.pick?.probabilities?.[pick] : undefined,
      done: typeof a.done?.noul === "number" ? a.done.noul : undefined, next: a.next?.choice, low: typeof a.low?.noul === "number" ? a.low.noul : undefined,
    });
  }
}

const cost = (inTok: number) => Math.round((inTok / 1e6) * PRICE_PER_M_INPUT * 1e6) / 1e6;
const rate = (hits: number, n: number) => (n ? Math.round((hits / n) * 1000) / 1000 : null);
const pct = (p?: number) => (p == null ? "" : `${Math.round(p * 100)}%`);

/** What the note of an outcome says you did: "answer:b" → b, "accept", "sendback", "reply:other". */
function actualOf(o: Out) {
  const [action, choice] = o.note.split(":");
  return { action, choice };
}
/** Accepted a "done" claim? From the note when the deck wrote it, else from followed + Jev's side of 50%. */
function accepted(d: Dec, o: Out): boolean | null {
  const { action } = actualOf(o);
  if (action === "accept") return true;
  if (action === "sendback") return false;
  if (o.followed == null || d.done == null) return null;
  return o.followed ? d.done >= 0.5 : d.done < 0.5;
}

export type JevStats = ReturnType<typeof summarize>;

/** The panel's numbers. `now` and the labels (from the deck's answer cache) are inputs so tests can pin them. */
export function summarize(rc: Receipts, opts: { now?: number; cap: number; used: number; capSource?: string; available?: boolean; labels?: Map<string, CacheEntry> }) {
  const now = opts.now ?? Date.now();
  const today = localDay(now), weekAgo = now - 7 * 86_400_000;
  const span = (ds: Dec[]) => {
    const inTok = ds.reduce((s, d) => s + d.inTok, 0);
    return { calls: ds.reduce((s, d) => s + d.calls, 0), inputTokens: inTok, outputTokens: ds.reduce((s, d) => s + d.outTok, 0), cost: cost(inTok), repeats: ds.filter((d) => d.repeat).length };
  };
  const decs = rc.decs;
  const allToday = rc.all.filter((x) => localDay(x.t) === today);

  // Hit rate: of the decisions you answered, how often Jev's suggestion was what you did.
  const hit = { prompt: { n: 0, hits: 0 }, question: { n: 0, hits: 0 }, done: { n: 0, hits: 0 } } as Record<Kind, { n: number; hits: number; rate?: number | null }>;
  const bands = [[0.7, 1.01, "≥70%"], [0.4, 0.7, "40–69%"], [0, 0.4, "<40%"]] as const;
  const calDone = bands.map(([, , label]) => ({ band: label, n: 0, accepted: 0, rate: null as number | null }));
  const calPick = bands.map(([, , label]) => ({ band: label, n: 0, hits: 0, rate: null as number | null }));
  const band = (p: number) => bands.findIndex(([lo, hi]) => p >= lo && p < hi);
  let answered = 0;
  for (const d of decs) {
    const o = rc.outcomes.get(d.id);
    if (!o) continue;
    answered++;
    if (o.followed != null) { hit[d.kind].n++; if (o.followed) hit[d.kind].hits++; }
    if (d.kind === "done" && d.done != null) {
      const acc = accepted(d, o);
      if (acc != null) { const b = calDone[band(d.done)]; b.n++; if (acc) b.accepted++; }
    } else if (d.pickP != null && o.followed != null) { const b = calPick[band(d.pickP)]; b.n++; if (o.followed) b.hits++; }
  }
  for (const k of Object.keys(hit) as Kind[]) hit[k].rate = rate(hit[k].hits, hit[k].n);
  for (const b of calDone) b.rate = rate(b.accepted, b.n);
  for (const b of calPick) b.rate = rate(b.hits, b.n);
  const tot = Object.values(hit).reduce((a, h) => ({ n: a.n + h.n, hits: a.hits + h.hits }), { n: 0, hits: 0 });

  // The last ten distinct decisions (repeats of the same request folded in), newest first.
  const groups = new Map<string, Dec[]>();
  for (const d of decs) { if (d.fallback) continue; const g = groups.get(d.group); if (g) g.push(d); else groups.set(d.group, [d]); }
  const recent = [...groups.values()].sort((a, b) => b[b.length - 1].t - a[a.length - 1].t).slice(0, 10).map((g) => {
    const last = g[g.length - 1];
    const withOut = [...g].reverse().find((d) => rc.outcomes.has(d.id));
    const src = withOut ?? last;
    const o = withOut ? rc.outcomes.get(withOut.id)! : undefined;
    const label = g.map((d) => opts.labels?.get(d.id)).find(Boolean);
    const title = (id?: string) => (id != null ? label?.opts?.[id] : undefined);
    const suggestion = src.kind === "done"
      ? `${pct(src.done)} done${src.next ? ` · ${src.next === "send_back" ? "send back" : src.next === "accept" ? "accept" : "ask"}` : ""}`
      : `${String(src.pick ?? "?").toUpperCase()}${src.pickP != null ? ` (${pct(src.pickP)})` : ""}`;
    let actual: string | null = null;
    if (o) {
      const { action, choice } = actualOf(o);
      actual = action === "accept" ? "accepted" : action === "sendback" ? "sent back" : choice === "other" ? "own reply" : choice === "esc" ? "denied (Esc)" : choice ? choice.toUpperCase() : action || (o.followed ? "followed" : "didn’t follow");
    }
    return {
      at: last.t, kind: last.kind, label: label?.label ?? null, suggestion, pickTitle: title(src.pick) ?? null, actual,
      actualTitle: o ? title(actualOf(o).choice) ?? null : null, followed: o?.followed ?? null, repeats: g.length - 1,
    };
  });

  return {
    receipts: { file: rc.file, rows: rc.rows },
    since: decs[0]?.t ?? null,
    today: span(decs.filter((d) => localDay(d.t) === today)),
    week: span(decs.filter((d) => d.t >= weekAgo)),
    total: span(decs),
    allAgentsToday: { calls: allToday.reduce((s, x) => s + x.calls, 0), inputTokens: allToday.reduce((s, x) => s + x.inTok, 0), cost: cost(allToday.reduce((s, x) => s + x.inTok, 0)) },
    asked: groups.size, answered,
    hit: { ...hit, all: { ...tot, rate: rate(tot.hits, tot.n) } },
    calibration: { done: calDone, pick: calPick },
    recent,
    cap: { cap: opts.cap, used: opts.used, source: opts.capSource ?? "default", available: opts.available ?? false },
    price: { perMillionInput: PRICE_PER_M_INPUT },
  };
}

/** One parsed log per file, and the last summary until the log, the cap or the day changes. */
const logs = new Map<string, Receipts>();
let memo: { key: string; value: JevStats } | undefined;
export function statsFor(file: string, opts: Parameters<typeof summarize>[1]) {
  let rc = logs.get(file);
  if (!rc) { rc = new Receipts(file); logs.set(file, rc); }
  const changed = rc.refresh();
  const key = `${file}|${rc.rows}|${opts.cap}|${opts.used}|${opts.capSource}|${opts.available}|${localDay(opts.now)}|${opts.labels?.size ?? 0}`;
  if (!changed && memo?.key === key) return memo.value;
  memo = { key, value: summarize(rc, opts) };
  return memo.value;
}
