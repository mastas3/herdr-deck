// Devices that get push alerts from this hub: their subscriptions, labels and per-device choices.
// Lives in push-subs.json next to the VAPID key (push.json). Only the hub sends; see server.ts.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadVapid, sendWebPush, type SendResult, type Vapid } from "./webpush";

export type Prefs = {
  needs: boolean; // a session is waiting for input
  done: boolean; // a session finished a turn you haven't seen
  digest: boolean; // the morning digest
  quiet: { on: boolean; from: string; to: string }; // "22:00" → "07:30": no needs/finished alerts in between
  /** Plugins' own choices, kept by name (e.g. the quests plugin's questDigest and quests): a digest section with a
   *  `pref` skips devices that set it false, a message with a `pref` goes only to devices that set it true. */
  [pref: string]: unknown;
};
export type Device = {
  id: string; // chosen by the device, kept in its localStorage: re-subscribing replaces its old endpoint
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  prefs: Prefs;
  createdAt: number;
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  sent?: number;
};
/** The deck's own kinds, or a plugin's (e.g. "quest"), which goes out by its `pref`. */
export type Kind = "needs" | "done" | "digest" | "test" | "burst" | (string & {});
export type Message = { title: string; body: string; tag?: string; url?: string; badge?: number; kind: Kind; key?: string; at?: number; pref?: string };

export const DEFAULT_PREFS: Prefs = { needs: true, done: true, digest: true, quiet: { on: false, from: "22:00", to: "07:30" } };
/** A plugin preference's name: letters, digits and underscores, not one of the deck's own. */
const PLUGIN_PREF = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const CORE_PREFS = new Set(["needs", "done", "digest", "quiet"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Inside [from, to) in local time; a window that wraps midnight (22:00 → 07:30) works too. */
export function inQuiet(now: Date, q: Prefs["quiet"] | undefined) {
  if (!q?.on || !HHMM.test(q.from) || !HHMM.test(q.to)) return false;
  const m = now.getHours() * 60 + now.getMinutes(), a = minutesOf(q.from), b = minutesOf(q.to);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Which devices a message goes to: test only to the one asked, the rest by each device's own choices. */
export function wants(d: Device, m: Message, now: Date, only?: string) {
  if (only) return d.id === only;
  if (m.kind === "test") return false;
  if (m.kind === "digest") return d.prefs.digest;
  if (inQuiet(now, d.prefs.quiet)) return false;
  if (m.kind === "burst") return d.prefs.needs || d.prefs.done;
  if (m.pref) return d.prefs[m.pref] === true;
  return !!d.prefs[m.kind];
}

export function cleanPrefs(p: any, base: Prefs = DEFAULT_PREFS): Prefs {
  const q = p?.quiet ?? {};
  // Plugins' preferences survive a save from a page where that plugin is off: the device's earlier choice stays.
  const extra: Record<string, boolean> = {};
  for (const src of [base, p]) for (const [k, v] of Object.entries(src ?? {})) if (!CORE_PREFS.has(k) && PLUGIN_PREF.test(k) && typeof v === "boolean") extra[k] = v;
  return {
    ...extra,
    needs: typeof p?.needs === "boolean" ? p.needs : base.needs,
    done: typeof p?.done === "boolean" ? p.done : base.done,
    digest: typeof p?.digest === "boolean" ? p.digest : base.digest,
    quiet: {
      on: typeof q.on === "boolean" ? q.on : base.quiet.on,
      from: HHMM.test(q.from) ? q.from : base.quiet.from,
      to: HHMM.test(q.to) ? q.to : base.quiet.to,
    },
  };
}

/** Push endpoints are https on a real push service; plain http only for a local mock in dev. */
export function endpointOk(endpoint: string, dev: boolean) {
  try {
    const u = new URL(endpoint);
    if (u.protocol === "https:") return !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/.test(u.hostname);
    return dev && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch { return false; }
}

export class PushStore {
  devices: Device[] = [];
  vapid!: Vapid;
  youngMs = 5 * 60_000;
  retryMs = 1500;
  constructor(readonly dir: string, readonly subject: string, readonly send = sendWebPush) {
    try { this.devices = JSON.parse(readFileSync(this.file, "utf8")); } catch {}
    if (!Array.isArray(this.devices)) this.devices = [];
  }
  get file() { return `${this.dir}/push-subs.json`; }
  async init() { this.vapid = await loadVapid(`${this.dir}/push.json`); return this; }
  save() {
    writeFileSync(this.file, JSON.stringify(this.devices, null, 1), { mode: 0o600 });
    if (existsSync(this.file)) chmodSync(this.file, 0o600);
  }
  /** Add or update a device. The same device id with a new endpoint replaces the old subscription. */
  upsert(o: { id: string; endpoint: string; keys: { p256dh: string; auth: string }; label?: string; prefs?: any }, now = Date.now()) {
    const prev = this.devices.find((d) => d.id === o.id) ?? this.devices.find((d) => d.endpoint === o.endpoint);
    const dev: Device = {
      id: o.id,
      endpoint: o.endpoint,
      keys: { p256dh: String(o.keys.p256dh), auth: String(o.keys.auth) },
      label: String(o.label ?? prev?.label ?? "Device").replace(/\s+/g, " ").trim().slice(0, 40) || "Device",
      prefs: cleanPrefs(o.prefs, prev?.prefs ?? DEFAULT_PREFS),
      createdAt: prev?.createdAt ?? now,
      lastOkAt: prev?.endpoint === o.endpoint ? prev.lastOkAt : undefined,
      sent: prev?.endpoint === o.endpoint ? prev.sent : 0,
    };
    this.devices = [...this.devices.filter((d) => d !== prev && d.endpoint !== o.endpoint), dev];
    this.save();
    return dev;
  }
  remove(by: { id?: string; endpoint?: string }) {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => !(by.id && d.id === by.id) && !(by.endpoint && d.endpoint === by.endpoint));
    if (this.devices.length !== n) this.save();
    return n - this.devices.length;
  }
  /** What the page may see: never the keys. */
  list() {
    return this.devices.map(({ keys, endpoint, ...d }) => ({ ...d, service: (() => { try { return new URL(endpoint).hostname; } catch { return "?"; } })() }));
  }
  /** Sends to every device that wants it. Dead subscriptions (404/410) are dropped. */
  async deliver(m: Message, o: { only?: string; now?: Date; ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; filter?: (d: Device) => boolean } = {}) {
    const now = o.now ?? new Date();
    const targets = this.devices.filter((d) => wants(d, m, now, o.only) && (!o.filter || o.filter(d)));
    const payload = JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: m.url, badge: m.badge, kind: m.kind, at: m.at ?? now.getTime() });
    const results: { id: string; label: string; ok: boolean; gone: boolean; error?: string }[] = [];
    await Promise.all(targets.map(async (d) => {
      const go = () => this.send({ endpoint: d.endpoint, keys: d.keys }, payload, this.vapid, { subject: this.subject, ttl: o.ttl, urgency: o.urgency, topic: o.topic });
      let r: SendResult = await go();
      // A push service can call a subscription made seconds ago "gone" before it has settled (seen with FCM):
      // retry young ones a few times before believing it.
      for (let i = 0; r.gone && Date.now() - d.createdAt < this.youngMs && i < 3; i++) { await Bun.sleep(this.retryMs * (i + 1)); r = await go(); }
      results.push({ id: d.id, label: d.label, ok: r.ok, gone: r.gone, error: r.error });
      if (r.ok) { d.lastOkAt = Date.now(); d.sent = (d.sent ?? 0) + 1; d.lastError = undefined; }
      else { d.lastError = r.error; d.lastErrorAt = Date.now(); }
    }));
    const gone = results.filter((r) => r.gone).map((r) => r.id);
    if (gone.length) this.devices = this.devices.filter((d) => !gone.includes(d.id));
    if (targets.length) this.save();
    return { sent: results.filter((r) => r.ok).length, targets: targets.length, dropped: gone.length, results };
  }
}
