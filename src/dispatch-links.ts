// Which session dispatched which. A fleet tool (Conductor's `factoryctl dispatch launch`, through herdr-fleet-link)
// starts each worker in a pane of its own and records the link in a ledger, ~/.config/herdr/dispatch-map.json:
//   { "<worker's agent session id>": { "src": "<dispatcher's sidebar name>", "brief": "PS1", "src_sid"?: "<its session id>" } }
// "src" is what herdr's sidebar showed for the dispatcher (namesync's name, often with a status glyph in front and cut
// at ~31 characters); old entries may hold a short session id instead. Each deck reads the ledger for its own machine
// and puts `parent` on the worker's row; the page nests workers under that row. Any tool can write the same shape
// (to ~/.config/herdr-deck/dispatch-map.json, or a file named in DECK_DISPATCH_MAP).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

export type ParentLink = {
  brief?: string; // the brief's number or tag ("PS1")
  srcName: string; // the dispatcher's name as the ledger has it, without the status glyph or a trailing "…"
  sid?: string; // the dispatcher's session id, when the ledger knows it
  key?: string; // the dispatcher's row, when it is open on this machine
  via?: "sid" | "name"; // how it was found
  miss?: "closed" | "ambiguous" | "unknown"; // why it wasn't
  why?: string; // the same, in words (the page shows it on hover)
};
export type LedgerEntry = { src: string; brief?: string; sid?: string };
export type Ledger = Map<string, LedgerEntry>;

/** The ledger's entries, or null when the text isn't a JSON object (a torn write: the caller keeps its last good copy). */
export function parseLedger(text: string): Ledger | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const out: Ledger = new Map();
  for (const [worker, v] of Object.entries(o as Record<string, any>)) {
    if (!worker.trim() || !v || typeof v !== "object") continue;
    const src = typeof v.src === "string" ? v.src : "";
    // A future ledger can name the dispatcher exactly; both spellings are accepted.
    const sid = [v.src_sid, v.sid].find((x) => typeof x === "string" && x.trim())?.trim();
    if ((!src.trim() || src.trim() === "?") && !sid) continue;
    const brief = v.brief == null ? "" : String(v.brief).trim();
    out.set(worker.trim(), { src, brief: brief || undefined, sid });
  }
  return out;
}

/** herdr namesync's cache (~/.cache/herdr-namesync.json): each pane's sidebar name and `src` token, by pane id. */
export function parseNamesync(text: string): Map<string, { sname?: string; src?: string }> | null {
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || typeof o.names !== "object" || !o.names) return null;
  const out = new Map<string, { sname?: string; src?: string }>();
  for (const [pane, v] of Object.entries<any>(o.names)) if (v && typeof v === "object") out.set(pane, { sname: str(v.sname), src: str(v.src) });
  return out;
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** A JSON file read again only when it changes (checked at most every `everyMs`). A file that doesn't parse (caught
 *  mid-write) keeps the last good copy and is tried again on the next check; a file that's gone counts as empty. */
export class CachedJson<T> {
  private sig = "";
  private at = -Infinity;
  value: T;
  constructor(readonly path: string, private parse: (text: string) => T | null, private empty: T, private everyMs = 2000) { this.value = empty; }
  /** `fresh`: look at the file now, whenever it was last checked. */
  read(now = Date.now(), fresh = false): T {
    if (!fresh && now - this.at < this.everyMs) return this.value;
    this.at = now;
    let sig = "none";
    try { const st = statSync(this.path); sig = `${st.mtimeMs}:${st.size}`; } catch {}
    if (sig === this.sig) return this.value;
    this.sig = sig;
    if (sig === "none") { this.value = this.empty; return this.value; }
    let parsed: T | null = null;
    try { parsed = this.parse(readFileSync(this.path, "utf8")); } catch {}
    if (parsed) this.value = parsed;
    else this.sig = ""; // look again next time
    return this.value;
  }
}

/** Where ledgers are read from: DECK_DISPATCH_MAP (paths separated by ":"), else herdr's and the deck's own. */
export function ledgerPaths(env = process.env, home = homedir()): string[] {
  const own = env.DECK_DISPATCH_MAP?.split(":").map((p) => p.trim()).filter(Boolean);
  return own?.length ? own : [`${home}/.config/herdr/dispatch-map.json`, `${home}/.config/herdr-deck/dispatch-map.json`];
}
/** Every ledger, merged (a later file wins for the same worker). */
export function createLedgers(paths = ledgerPaths()) {
  const files = paths.map((p) => new CachedJson<Ledger>(p, parseLedger, new Map()));
  let last: Ledger[] = [], merged: Ledger = new Map();
  return {
    read(now = Date.now(), fresh = false): Ledger {
      const cur = files.map((f) => f.read(now, fresh));
      if (cur.some((l, i) => l !== last[i])) {
        merged = new Map();
        for (const l of cur) for (const [k, v] of l) merged.set(k, v);
        last = cur;
      }
      return merged;
    },
  };
}

// ── names ────────────────────────────────────────────────────────────────
/** A name as people read it: no status glyph in front ("◐ ", "✳ "), no "…" where it was cut. */
export function cleanName(s?: string): string {
  return String(s ?? "").normalize("NFC").replace(/^[\s\p{So}\p{Sm}\p{Sk}•·]+/u, "").replace(/(?:\s|…|\.\.\.)+$/u, "").trim();
}
const norm = (s?: string) => cleanName(s).toLowerCase().replace(/\s+/g, " ");
/** herdr's `$src` token ("← #QD6 ◑ Stage to QA version…"): the brief and the dispatcher's (shortened) name. */
export function parseTokenSrc(src?: string): { brief?: string; src: string } | null {
  const m = String(src ?? "").match(/^\s*←\s*(?:#(\S+)\s*)?(.*)$/u);
  if (!m) return null;
  const name = cleanName(m[2]);
  return name ? { brief: m[1] || undefined, src: name } : null;
}
/** How well a session's name fits the ledger's: 2 the same, 1 one starts the other (the ledger's or the sidebar's
 *  copy was cut short), 0 not at all. A cut sidebar name must still be long enough to say something. */
export function nameFit(want: string, have: string): number {
  if (!want || !have) return 0;
  if (want === have) return 2;
  if (have.startsWith(want)) return 1;
  if (want.startsWith(have) && have.length >= 12) return 1;
  return 0;
}

// ── linking ──────────────────────────────────────────────────────────────
/** What the linker needs of a row (a deck Row has all of it). */
export type LinkRow = { key: string; sessionId?: string; movedFrom?: string[]; title?: string; cwd?: string; projectRoot?: string; lastActiveAt?: number; stale?: boolean };
/** What else the pane is called (herdr's sidebar name, its terminal title, the session's own name) and herdr's `src`. */
export type LinkExtra = { names?: (string | undefined)[]; tokenSrc?: string };

const SHORT_SID = /^[0-9a-f]{8}$/i;
const clip = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Each worker's link to the session that dispatched it, by the worker's row key. Its parent is looked for among the
 *  same rows: by session id when the ledger has one (or held a short one as its name), else by name, preferring
 *  sessions that aren't workers themselves, then the worker's own folder, then ones that aren't stale. Anything still
 *  ambiguous stays unresolved, with the reason. */
export function linkParents(rows: LinkRow[], ledger: Ledger, extra: (r: LinkRow) => LinkExtra = () => ({})): Map<string, ParentLink> {
  const out = new Map<string, ParentLink>();
  const src = new Map<string, LedgerEntry>();
  for (const r of rows) {
    const ids = [r.sessionId, ...(r.movedFrom ?? [])].filter(Boolean) as string[];
    const e = ids.map((id) => ledger.get(id)).find(Boolean) ?? parseTokenSrc(extra(r).tokenSrc) ?? undefined;
    if (e) src.set(r.key, e);
  }
  if (!src.size) return out;
  const cands = rows.map((r) => ({ r, worker: src.has(r.key), names: [...new Set([r.title, ...(extra(r).names ?? [])].map(norm).filter(Boolean))] }));
  for (const w of rows) {
    const e = src.get(w.key);
    if (e) out.set(w.key, resolve(w, e, cands.filter((c) => c.r.key !== w.key && !(w.sessionId && c.r.sessionId === w.sessionId))));
  }
  return out;
}

type Cand = { r: LinkRow; worker: boolean; names: string[] };
function resolve(w: LinkRow, e: LedgerEntry, cands: Cand[]): ParentLink {
  const name = cleanName(e.src) || e.src.trim();
  const link: ParentLink = { brief: e.brief, srcName: name || (e.sid ? e.sid.slice(0, 8) : "?") };
  if (e.sid) link.sid = e.sid;
  const found = (c: Cand, via: "sid" | "name"): ParentLink => ({ ...link, key: c.r.key, via });
  const closed = (why: string): ParentLink => ({ ...link, miss: "closed", why });
  if (e.sid) {
    const hit = cands.filter((c) => c.r.sessionId === e.sid || c.r.movedFrom?.includes(e.sid!));
    return hit.length ? found(newest(hit), "sid") : closed("Its session isn’t open on this machine.");
  }
  if (SHORT_SID.test(name)) {
    const hit = cands.filter((c) => c.r.sessionId?.toLowerCase().startsWith(name.toLowerCase()));
    if (hit.length && hit.every((c) => c.r.sessionId === hit[0].r.sessionId)) return found(newest(hit), "sid");
    if (hit.length) return { ...link, miss: "ambiguous", why: `${hit.length} open sessions have an id starting ${name}.` };
    return closed(`No open session here has an id starting ${name}.`);
  }
  const want = norm(name);
  if (want.length < 3) return { ...link, miss: "unknown", why: "The ledger’s name is too short to find it by." };
  let hit = cands.map((c) => ({ c, fit: Math.max(0, ...c.names.map((n) => nameFit(want, n))) })).filter((x) => x.fit > 0);
  if (!hit.length) return closed(`No open session here is called “${name}”.`);
  // Narrow down only while something is left: dispatchers before workers, the closest name, the worker's own folder,
  // sessions still in use.
  const narrow = (keep: (x: (typeof hit)[number]) => boolean) => { const n = hit.filter(keep); if (n.length) hit = n; };
  narrow((x) => !x.c.worker);
  const best = Math.max(...hit.map((x) => x.fit));
  narrow((x) => x.fit === best);
  if (hit.length > 1) narrow((x) => !!w.cwd && (x.c.r.cwd === w.cwd || (!!x.c.r.projectRoot && x.c.r.projectRoot === w.projectRoot)));
  if (hit.length > 1) narrow((x) => !x.c.r.stale);
  // Two panes on one conversation are the same dispatcher.
  if (hit.length === 1 || hit.every((x) => x.c.r.sessionId && x.c.r.sessionId === hit[0].c.r.sessionId)) return found(newest(hit.map((x) => x.c)), "name");
  return { ...link, miss: "ambiguous", why: `${hit.length} open sessions match “${name}”: ${hit.slice(0, 3).map((x) => clip(x.c.r.title || x.c.r.key)).join(", ")}${hit.length > 3 ? "…" : ""}` };
}
const newest = (cs: Cand[]) => cs.reduce((a, b) => ((b.r.lastActiveAt ?? 0) > (a.r.lastActiveAt ?? 0) ? b : a));
