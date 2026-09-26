// Hub-side rules: push when a session needs you or finishes, a morning digest, a nudge about empty
// sessions, and the proof-of-done switch. Rules and their last results live in automations.json.
// Everything here takes rows and a clock, so the rules are tested without a live deck.
import { readFileSync, writeFileSync } from "node:fs";
import type { Row } from "./deck";
import type { Device, Message } from "./push";

export type Rules = {
  alerts: { on: boolean; needs: boolean; done: boolean };
  digest: { on: boolean; time: string };
  empty: { on: boolean; minutes: number };
  proof: { on: boolean };
};
export type RuleId = keyof Rules;
export type RuleStatus = { lastRunAt?: number; lastResult?: string; ok?: boolean };
export type Item = { key: string; title: string; project: string; machine?: string; agent: string; at?: number; status: string };
export type Digest = {
  at: number;
  since: number;
  title: string;
  body: string;
  waiting: Item[];
  finished: Item[];
  running: Item[];
  idle: Item[];
  counts: { waiting: number; finished: number; running: number; idle: number };
  auto?: boolean;
};
export type AutoState = {
  rules: Rules;
  status: Partial<Record<RuleId, RuleStatus>>;
  digest?: Digest;
  digestDismissedAt?: number;
  digestDay?: string; // local date of the last scheduled digest
};

export const DEFAULT_RULES: Rules = {
  alerts: { on: true, needs: true, done: true },
  digest: { on: true, time: "08:30" },
  empty: { on: true, minutes: 60 },
  proof: { on: true },
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = 86_400_000;

export function cleanRules(p: any, base: Rules = DEFAULT_RULES): Rules {
  const b = (v: any, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    alerts: { on: b(p?.alerts?.on, base.alerts.on), needs: b(p?.alerts?.needs, base.alerts.needs), done: b(p?.alerts?.done, base.alerts.done) },
    digest: { on: b(p?.digest?.on, base.digest.on), time: HHMM.test(p?.digest?.time) ? p.digest.time : base.digest.time },
    empty: { on: b(p?.empty?.on, base.empty.on), minutes: Number.isFinite(Number(p?.empty?.minutes)) && Number(p.empty.minutes) >= 5 ? Math.min(Math.round(Number(p.empty.minutes)), 7 * 24 * 60) : base.empty.minutes },
    proof: { on: b(p?.proof?.on, base.proof.on) },
  };
}

export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The digest is due once a day, from its time until three hours later (a Mac asleep at 08:30 still gets it at 09:10). */
export function digestDue(now: Date, time: string, lastDay?: string) {
  if (!HHMM.test(time) || lastDay === localDay(now)) return false;
  const m = now.getHours() * 60 + now.getMinutes(), t = minutesOf(time);
  return m >= t && m < t + 180;
}

export const needsYou = (r: Row) => (r.status === "blocked" && !r.app) || (r.status === "done" && !r.seen);
export const linkPath = (r: Row) => r.sessionId
  ? `/s/${encodeURIComponent(r.machine ?? "")}/${encodeURIComponent(r.agent)}/${encodeURIComponent(r.sessionId)}`
  : `/s/${encodeURIComponent(r.machine ?? "")}/pane/${encodeURIComponent(r.key)}`;
const item = (r: Row): Item => ({ key: r.key, title: r.title || r.agent, project: r.project, machine: r.machine, agent: r.agent, at: r.lastActiveAt, status: r.status });
const byRecent = (a: Row, b: Row) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
const short = (t: string) => (t.length > 40 ? (t.slice(0, 41).replace(/\s+\S*$/, "") || t.slice(0, 39)) + "…" : t); // at a word break
const names = (rs: Row[], n = 3) => rs.slice(0, n).map((r) => short((r.title || r.agent).replace(/\s+/g, " ").trim())).join(", ") + (rs.length > n ? ` +${rs.length - n}` : "");

/**
 * Across machines: what's waiting on you, what finished since yesterday evening (18:00), what's still
 * running, and sessions idle for more than three days that could be closed.
 */
export function buildDigest(rows: Row[], now: Date): Digest {
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  y.setHours(18, 0, 0, 0);
  const since = y.getTime();
  const live = rows.filter((r) => !r.hist);
  const waiting = live.filter(needsYou).sort(byRecent);
  const running = live.filter((r) => r.status === "working").sort(byRecent);
  const finished = live.filter((r) => !waiting.includes(r) && !r.empty && (r.status === "done" || r.status === "idle") && (r.lastActiveAt ?? 0) >= since).sort(byRecent);
  const idle = live.filter((r) => !waiting.includes(r) && !r.empty && r.status !== "working" && r.status !== "blocked" && !!r.lastActiveAt && now.getTime() - r.lastActiveAt > 3 * DAY).sort(byRecent);
  const lines = [
    waiting.length ? `${waiting.length} waiting on you: ${names(waiting)}` : "Nothing waiting on you",
    finished.length ? `${finished.length} finished since last evening: ${names(finished)}` : "",
    running.length ? `${running.length} still running: ${names(running, 2)}` : "",
    idle.length ? `${idle.length} idle 3+ days, could be closed` : "",
  ].filter(Boolean);
  return {
    at: now.getTime(), since, title: "Morning digest", body: lines.join("\n"),
    waiting: waiting.slice(0, 12).map(item), finished: finished.slice(0, 12).map(item), running: running.slice(0, 12).map(item), idle: idle.slice(0, 40).map(item),
    counts: { waiting: waiting.length, finished: finished.length, running: running.length, idle: idle.length },
  };
}

export type AlertEvent = { kind: "needs" | "done"; key: string; dueAt: number; row?: Row };

/**
 * One push per session per state change: entering "needs input", or finishing a turn you haven't seen.
 * Each event waits a short grace period and is dropped if the session moved on, you looked at it, or
 * it's open on a screen right now. The same session and kind won't push again within the cooldown.
 */
export class AlertTracker {
  private last = new Map<string, { needs: boolean; doneSig?: string }>();
  private lastPush = new Map<string, number>();
  private primed = false;
  pending = new Map<string, AlertEvent>();
  constructor(public graceMs = 5_000, public cooldownMs = 90_000) {}

  observe(rows: Row[], now: number) {
    const present = new Set<string>();
    for (const r of rows) {
      if (r.hist) continue;
      present.add(r.key);
      const needs = r.status === "blocked" && !r.app;
      const doneSig = r.status === "done" && !r.seen ? String(r.lastActiveAt ?? 0) : undefined;
      const prev = this.last.get(r.key);
      // A row seen for the first time (startup, a machine reconnecting) is the baseline, unless the pane is brand new.
      const fresh = !prev && !!r.bornAt && now - r.bornAt < 60_000;
      if (this.primed && (prev || fresh)) {
        if (needs && !prev?.needs) this.queue("needs", r.key, now);
        if (doneSig && doneSig !== prev?.doneSig) this.queue("done", r.key, now);
      }
      this.last.set(r.key, { needs, doneSig });
    }
    for (const k of this.last.keys()) if (!present.has(k)) this.last.delete(k);
    this.primed = true;
  }
  private queue(kind: AlertEvent["kind"], key: string, now: number) {
    const id = `${kind}:${key}`;
    if (now - (this.lastPush.get(id) ?? -Infinity) < this.cooldownMs) return;
    if (kind === "done") this.pending.delete(`needs:${key}`); // it finished: the question is moot
    this.pending.set(id, { kind, key, dueAt: now + this.graceMs });
  }
  /** Events whose grace period is over and that still hold. */
  due(rows: Map<string, Row>, now: number, viewing: (key: string) => boolean = () => false): AlertEvent[] {
    const out: AlertEvent[] = [];
    for (const [id, ev] of this.pending) {
      if (ev.dueAt > now) continue;
      this.pending.delete(id);
      const r = rows.get(ev.key);
      if (!r) continue;
      const still = ev.kind === "needs" ? r.status === "blocked" : r.status === "done" && !r.seen;
      if (!still || viewing(ev.key)) continue;
      this.lastPush.set(id, now);
      out.push({ ...ev, row: r });
    }
    return out;
  }
}

/** When each session became empty (no conversation). Rows already empty at startup count from their start. */
export class EmptyTracker {
  since = new Map<string, number>();
  private known = new Set<string>();
  update(rows: Row[], now: number) {
    const present = new Set<string>();
    for (const r of rows) {
      if (r.hist) continue;
      present.add(r.key);
      const empty = r.empty && !r.app && r.status !== "working" && r.status !== "blocked";
      if (!empty) this.since.delete(r.key);
      else if (!this.since.has(r.key)) {
        const est = Math.max(r.startedAt ?? 0, r.lastActiveAt ?? 0, r.bornAt ?? 0);
        this.since.set(r.key, this.known.has(r.key) || !est ? now : Math.min(est, now));
      }
      this.known.add(r.key);
    }
    for (const k of [...this.since.keys()]) if (!present.has(k)) this.since.delete(k);
    for (const k of [...this.known]) if (!present.has(k)) this.known.delete(k);
  }
  stale(now: number, minutes: number) {
    return [...this.since].filter(([, t]) => now - t >= minutes * 60_000).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  }
}

// ── push messages ──────────────────────────────────────────────────────────
const clip = (s: string | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export type Ctx = { machineLabel: (id?: string) => string; multi: boolean; question?: (key: string) => string | undefined; badge?: number };
const where = (r: Row, c: Ctx) => `${r.project}${c.multi ? ` · ${c.machineLabel(r.machine)}` : ""}`;

export function alertMessage(e: AlertEvent, c: Ctx): Message {
  const r = e.row!;
  const name = clip(r.title || r.agent, 60);
  if (e.kind === "needs") {
    const q = c.question?.(r.key) ?? [...(r.tail ?? [])].reverse().find((l) => l.trim());
    return { kind: "needs", key: r.key, title: `Needs you: ${name}`, body: [where(r, c), clip(q, 160)].filter(Boolean).join("\n"), tag: `s:${r.key}`, url: linkPath(r), badge: c.badge };
  }
  return { kind: "done", key: r.key, title: `Finished: ${name}`, body: [where(r, c), clip(r.lastMessage, 160)].filter(Boolean).join("\n"), tag: `s:${r.key}`, url: linkPath(r), badge: c.badge };
}

/** Three or more at once become one notification. */
export function burstMessage(evs: AlertEvent[], c: Ctx): Message {
  const needs = evs.filter((e) => e.kind === "needs"), done = evs.filter((e) => e.kind === "done");
  const title = [needs.length ? `${needs.length} need${needs.length === 1 ? "s" : ""} you` : "", done.length ? `${done.length} finished` : ""].filter(Boolean).join(", ");
  const body = evs.slice(0, 5).map((e) => `${e.kind === "needs" ? "⏳" : "✓"} ${clip(e.row!.title || e.row!.agent, 50)}`).join("\n") + (evs.length > 5 ? `\n+${evs.length - 5} more` : "");
  return { kind: "burst", title: `${title} · herdr deck`, body, tag: "burst", url: "/", badge: c.badge };
}

export const digestMessage = (d: Digest, badge?: number): Message => ({ kind: "digest", title: d.title, body: d.body, tag: "digest", url: "/?digest=1", badge });

// ── the rules engine on the hub ──────────────────────────────────────────
export type Deliver = (m: Message, o?: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; filter?: (d: Device) => boolean }) => Promise<{ sent: number; targets: number; dropped: number }>;
export type AutoDeps = {
  file: string;
  rows: () => Row[];
  deliver: Deliver;
  changed: () => void; // the public state changed: tell the pages
  viewing: (key: string) => boolean;
  ctx: () => Ctx;
  canSend: () => boolean; // false on a node: only the hub sends pushes
  /** Today's quests for the digest (the game, src/game.ts): pushed to devices that keep "quests in the digest" on. */
  questLines?: () => Promise<string[]>;
  now?: () => number;
};

export class Automations {
  state: AutoState;
  alerts = new AlertTracker();
  empties = new EmptyTracker();
  private emptyKeys: string[] = [];
  private lastTick = 0;
  private timer?: Timer;
  constructor(private d: AutoDeps) {
    let raw: any = {};
    try { raw = JSON.parse(readFileSync(d.file, "utf8")); } catch {}
    this.state = { ...raw, rules: cleanRules(raw.rules), status: raw.status ?? {} };
  }
  now() { return this.d.now?.() ?? Date.now(); }
  save() { try { writeFileSync(this.d.file, JSON.stringify(this.state, null, 1)); } catch {} }
  get rules() { return this.state.rules; }
  record(id: RuleId, lastResult: string, ok = true) {
    this.state.status[id] = { lastRunAt: this.now(), lastResult, ok };
    this.save();
    this.d.changed();
  }
  start(everyMs = 5_000) {
    this.observe();
    this.timer = setInterval(() => this.tick().catch((e) => console.warn("automations:", e?.message ?? e)), everyMs);
  }
  stop() { clearInterval(this.timer); }
  /** Called on every row patch (cheap: a pass over the rows). */
  observe() {
    const rows = this.d.rows(), now = this.now();
    this.alerts.observe(rows, now);
    this.empties.update(rows, now);
  }
  async tick() {
    this.observe();
    const now = this.now();
    this.lastTick = now;
    const rows = this.d.rows();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    // needs you / finished
    const due = this.alerts.due(byKey, now, this.d.viewing);
    const r = this.rules.alerts;
    const want = due.filter((e) => r.on && (e.kind === "needs" ? r.needs : r.done));
    if (want.length && this.d.canSend()) {
      const c = { ...this.d.ctx(), badge: rows.filter(needsYou).length };
      const msgs = want.length >= 3 ? [burstMessage(want, c)] : want.map((e) => alertMessage(e, c));
      let sent = 0, targets = 0;
      for (const m of msgs) {
        const res = await this.d.deliver(m, { urgency: m.kind === "needs" || m.kind === "burst" ? "high" : "normal", ttl: 6 * 3600, topic: m.key ? `s${Bun.hash(m.key).toString(36)}` : m.tag });
        sent += res.sent; targets = Math.max(targets, res.targets);
      }
      this.record("alerts", targets ? `“${msgs[0].title}”${msgs.length > 1 ? ` and ${msgs.length - 1} more` : ""} → ${sent ? `${sent} delivered` : "not delivered"}` : `“${msgs[0].title}”: no device wants it right now`, !targets || sent > 0);
    }
    // morning digest
    const nowD = new Date(now);
    if (this.rules.digest.on && digestDue(nowD, this.rules.digest.time, this.state.digestDay)) {
      this.state.digestDay = localDay(nowD);
      await this.runDigest(true, true);
    }
    // empty sessions
    const keys = this.rules.empty.on ? this.empties.stale(now, this.rules.empty.minutes) : [];
    if (keys.join("\n") !== this.emptyKeys.join("\n")) {
      this.emptyKeys = keys;
      this.record("empty", keys.length ? `${keys.length} empty for over ${this.rules.empty.minutes >= 120 ? `${Math.round(this.rules.empty.minutes / 60)} hours` : this.rules.empty.minutes === 60 ? "an hour" : `${this.rules.empty.minutes} minutes`}` : "No empty sessions over the limit");
    }
  }
  /** Build the digest; show it on the board, and push it when asked (the scheduled run always pushes). */
  async runDigest(push: boolean, auto = false) {
    const rows = this.d.rows();
    const dg = { ...buildDigest(rows, new Date(this.now())), auto };
    this.state.digest = dg;
    this.state.digestDismissedAt = undefined;
    let note = "shown on the board";
    if (push) {
      if (!this.d.canSend()) note += "; not pushed (this machine is a node)";
      else {
        const badge = rows.filter(needsYou).length;
        const quests = await this.d.questLines?.().catch(() => [] as string[]) ?? [];
        const o = { ttl: 12 * 3600, urgency: "normal" as const, topic: "digest" };
        let res = await this.d.deliver(digestMessage(dg, badge), quests.length ? { ...o, filter: (d) => d.prefs.questDigest === false } : o);
        if (quests.length) {
          const q = await this.d.deliver({ ...digestMessage(dg, badge), body: `${dg.body}\n\nToday's quests\n${quests.join("\n")}` }, { ...o, filter: (d) => d.prefs.questDigest !== false });
          res = { sent: res.sent + q.sent, targets: res.targets + q.targets, dropped: res.dropped + q.dropped };
          note += ", with today's quests";
        }
        note += res.targets ? `, pushed to ${res.sent} of ${res.targets} device${res.targets === 1 ? "" : "s"}` : "; no device wants digest pushes";
      }
    }
    this.record("digest", `${dg.counts.waiting} waiting, ${dg.counts.finished} finished, ${dg.counts.running} running, ${dg.counts.idle} idle: ${note}`);
    return dg;
  }
  dismissDigest() { this.state.digestDismissedAt = this.now(); this.save(); this.d.changed(); }
  setRules(patch: any) {
    this.state.rules = cleanRules({ ...this.state.rules, ...patch, alerts: { ...this.state.rules.alerts, ...patch?.alerts }, digest: { ...this.state.rules.digest, ...patch?.digest }, empty: { ...this.state.rules.empty, ...patch?.empty }, proof: { ...this.state.rules.proof, ...patch?.proof } }, this.state.rules);
    this.save();
    this.tick().catch(() => {});
    this.d.changed();
  }
  /** What the pages get: rules, statuses, the digest card (unless dismissed or a day old), empty sessions. */
  publicState() {
    const dg = this.state.digest;
    const showDigest = dg && !this.state.digestDismissedAt && this.now() - dg.at < 20 * 3600_000;
    const st = this.state.status;
    const status = {
      ...st,
      alerts: st.alerts ?? { lastRunAt: this.lastTick || undefined, lastResult: "Watching; nothing sent yet" },
      empty: { lastRunAt: this.lastTick || st.empty?.lastRunAt, lastResult: st.empty?.lastResult ?? "No empty sessions over the limit", ok: true },
    };
    return { rules: this.rules, status, digest: showDigest ? dg : null, empty: { keys: this.rules.empty.on ? this.emptyKeys : [], minutes: this.rules.empty.minutes } };
  }
}
