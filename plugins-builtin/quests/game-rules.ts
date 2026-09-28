// The game layer, part 1: the rules. Pure functions only (no files, no clock unless passed in), so every rule is
// tested on its own: which evidence pays XP and how much, the main-quest double and the side-quest cap, streaks by
// local day, bosses from real business metrics, founder levels, achievements and the weekly season scoreboard.
//
// The one idea everything rests on: XP only comes from a *proof*, a piece of evidence someone else could check (a
// tag, a deploy the wiki records, a milestone unlocked by a measured number, a Gumroad sale, a check that passed, a
// lead you contacted with its link, a conversation you logged with a note). Commits, sessions and lines of code are
// never proofs. Every proof has a stable id, so the same evidence never pays twice.

// ── vocabulary ─────────────────────────────────────────────────────────────────────
export type Link = { url?: string; commit?: string; wiki?: string; session?: string; machine?: string; file?: string; github?: string; project?: string };
/** What kind of progress a proof is. Streaks count ship, sell and talk. */
export type ProofType = "ship" | "sell" | "talk" | "build" | "prune" | "bonus";
export type ProofKind = "release" | "deploy" | "shipnote" | "merge" | "milestone" | "sale" | "metric" | "check" | "lead" | "talk" | "quest" | "prune" | "revoke";
export type Proof = {
  id: string; project: string; kind: ProofKind; type: ProofType; t: number; title: string; evidence: string; link?: Link; xp: number;
  /** Business flags the levels read: live (users can use it), money, recurring, mrr1k. */
  tags?: string[];
  amount?: number; metric?: string; value?: number; delta?: number;
};
/** A ledger line: the proof as it paid, when it was recorded, and whether it was on the main quest then (null: before the game). */
export type Line = Proof & { at: number; main: boolean | null; quest?: string; revokes?: string };
export type EffLine = Line & { eff: number; capped?: boolean };

export const XP = {
  sale: 150, saleDollarCap: 300, release: 120, shipnote: 100, deploy: 30, merge: 15, check: 10,
  milestoneBase: 100, milestoneTier: 60, milestoneCap: 400, lead: 40, talk: 80, metricSell: 120, metricShip: 60, metricOther: 30, prune: 40,
  mainMultiplier: 2, sideFloor: 50, sideRatio: 0.3,
} as const;
export const STREAK_TYPES = new Set<ProofType>(["ship", "sell", "talk"]);

/** Milestones measured by effort, not by business: never worth XP. A deploy *setup* (a Dockerfile appeared) isn't a deploy. */
export const VANITY = /^(git\.(commits|active_days|contributors|side_quests)|sessions\.|wiki\.|deploy\.setups)/;
/** Code proofs count a little, and only a few times a day per project: merges and passing checks. */
export const PER_DAY: Partial<Record<ProofKind, number>> = { merge: 3, check: 3 };
export const MONEY = /(paying|customer|mrr|revenue|sales?\b|sold|orders?\b|income|arr\b|dollars?)/;
export const USERS = /(users?\b|dau|mau|active|signups?|downloads?|installs?|views?|readers?|subscribers?|followers?|waitlist|members?|visitors?|players?)/;
/** A wiki entry that says something reached users: past-tense ship words, and not a draft, preview, rehearsal or plan. */
export const SHIPPED = /\b(deployed|shipped|went live|is (now )?live|live at|released|published|in production|production release)\b|\blaunched\b(?=.*\b(on|at|publicly)\b|.*\b[a-z0-9-]+\.(com|app|io|net|org|dev|ai|co)\b)/i; // "launched" only when it says where
export const NOT_SHIPPED = /\b(draft|preview|rehearsal|staging|private(ly)?|internal|audit|plan(ned|ning)?|pre-?launch|local(ly)?|consultation|(session|agent|worker|job)s? (was |were )?launched)\b/i;

const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };
export function hash(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
const d10 = (t: number) => new Date(t).toISOString().slice(0, 10);

// ── days, weeks, time zones ──────────────────────────────────────────────────────────────
const dayFmt = new Map<string, Intl.DateTimeFormat>();
/** The calendar day of `t` where you are ("2026-09-26"). `tz` is an IANA zone; without it, this machine's zone. */
export function dayOf(t: number, tz?: string): string {
  if (!tz) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  let f = dayFmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); dayFmt.set(tz, f); }
  return f.format(new Date(t));
}
export const validTz = (tz: unknown): tz is string => { try { return typeof tz === "string" && !!tz && !!new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return false; } };
const keyUtc = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
export const addDays = (k: string, n: number) => new Date(keyUtc(k) + n * 86_400_000).toISOString().slice(0, 10);
/** The Monday of the week a day is in: weeks run Monday to Sunday. */
export function weekOf(k: string) { const dow = new Date(keyUtc(k)).getUTCDay(); return addDays(k, -((dow + 6) % 7)); }
export const dayOfWeek = (k: string) => new Date(keyUtc(k)).getUTCDay(); // 0 = Sunday

// ── proofs from a project's journey (the projects plugin's journey.ts is the source of truth) ──────
/** The parts of a Journey the game reads. */
export type JourneyLike = {
  project: string; root?: string; status?: string; nature?: string; pitch?: string; tags?: string[];
  events: { id: string; t: number; kind: string; title: string; detail?: string; link?: Link }[];
  metrics: { key: string; label?: string; unit?: string; value: number; at?: number; series?: [number, number][]; evidence: string; link?: Link }[];
  milestones: { id: string; title: string; metric: string; unit: string; target: number; source: string; tier: number; state: string; value?: number; pct?: number; at?: number; evidence?: string; link?: Link; manual?: boolean }[];
  next?: string[]; heading?: { direction?: string }; now?: { t: number; last?: number; github?: string }; sources?: { gumroad?: string };
};
const version = (title: string) => title.replace(/^(Tagged|Released)\s+/i, "").trim().toLowerCase().replace(/^v(?=\d)/, "");
const linkOf = (l: Link | undefined, j: JourneyLike): Link | undefined => (l ? { ...l, github: l.commit && j.now?.github ? j.now.github : undefined, project: j.project } : undefined);
export const metricKind = (name: string): "money" | "users" | "other" => (MONEY.test(name.replace(/_/g, " ")) ? "money" : USERS.test(name.replace(/_/g, " ")) ? "users" : "other");

/**
 * Every proof a journey holds, each with an id that stays the same across rebuilds (so re-reading never pays twice):
 * releases/tags (one per version), deploy setups, wiki entries that say it shipped, merges, milestones unlocked by a
 * business number (never by commits or sessions), each Gumroad sale, and each logged metric that went up with a note.
 * Git and wiki proofs are keyed by the commit or the wiki entry, not the project: two worktrees of one repo (or two
 * projects named in one log line) share them, and the first project read keeps them.
 */
export function proofsFromJourney(j: JourneyLike): Proof[] {
  const p = j.project, out: Proof[] = [];
  const add = (x: Proof) => { if (x.t > 0 && Number.isFinite(x.t)) out.push(x); };
  const seenVer = new Set<string>();
  for (const e of j.events ?? []) {
    if (e.kind === "tag" || e.kind === "release") {
      const v = version(e.title);
      if (!v || seenVer.has(v)) continue;
      seenVer.add(v);
      add({ id: e.link?.commit ? `rel:${e.link.commit.slice(0, 12)}:${v}` : `rel:${p}:${v}`, project: p, kind: "release", type: "ship", t: e.t, title: `Released ${e.title.replace(/^(Tagged|Released)\s+/i, "")}`, evidence: `${e.kind === "tag" ? "git tag" : "GitHub release"}: ${clip(e.title, 80)}${e.detail ? ` (${clip(e.detail, 80)})` : ""}`, link: linkOf(e.link, j), xp: XP.release, tags: ["live"] });
    } else if (e.kind === "deploy") {
      add({ id: `deploy:${e.link?.commit?.slice(0, 12) ?? p}:${e.link?.file ?? e.id}`, project: p, kind: "deploy", type: "build", t: e.t, title: clip(e.title, 90), evidence: clip(e.detail ?? e.title, 140), link: linkOf(e.link, j), xp: XP.deploy });
    } else if ((e.kind === "log" || e.kind === "wiki") && SHIPPED.test(e.title) && !NOT_SHIPPED.test(e.title)) {
      add({ id: `ship:${e.id}`, project: p, kind: "shipnote", type: "ship", t: e.t, title: `Shipped: ${clip(e.title, 80)}`, evidence: `wiki ${e.kind === "log" ? "log" : "page"} (${d10(e.t)}): “${clip(e.title, 110)}”`, link: linkOf(e.link, j), xp: XP.shipnote, tags: ["live"] });
    } else if (e.kind === "merge") {
      const sha = e.link?.commit ?? e.id;
      add({ id: `merge:${sha.slice(0, 12)}`, project: p, kind: "merge", type: "build", t: e.t, title: clip(e.title, 90), evidence: `merge commit ${sha.slice(0, 8)}`, link: linkOf(e.link, j), xp: XP.merge });
    }
  }
  // Milestones: unlocked by evidence (a measured number at its target, or your mark with a note). Keyed by what they
  // measure, not their id, so an AI re-read that renames the ladder doesn't pay again.
  for (const m of j.milestones ?? []) {
    if (m.state !== "unlocked" || !m.at || VANITY.test(m.source) || !m.evidence) continue;
    const name = m.source.replace(/^manual\./, "").replace(/^gumroad\./, "");
    const mk = m.source.startsWith("gumroad.") ? "money" : metricKind(m.source.startsWith("manual.") ? name : "");
    const money = mk === "money";
    const live = m.source === "deploy.live" || m.source.startsWith("git.tags") || m.source.startsWith("github.") || mk === "users";
    const tags = [money ? "money" : "", live ? "live" : "", /mrr|monthly|recurring|arr/.test(m.source) ? "recurring" : "", /mrr|monthly/.test(m.source) && m.target >= 1000 ? "mrr1k" : ""].filter(Boolean);
    add({ id: `ms:${p}:${m.source}:${m.target}`, project: p, kind: "milestone", type: money ? "sell" : live || m.source.startsWith("deploy.") ? "ship" : "build", t: m.at, title: `Unlocked: ${clip(m.title, 70)}`, evidence: clip(m.evidence, 160), link: linkOf(m.link, j), xp: Math.min(XP.milestoneCap, XP.milestoneBase + XP.milestoneTier * Math.max(0, m.tier)), metric: m.source, value: m.value, tags });
  }
  // Gumroad: each sale is its own proof (the n-th sale of this project), with the revenue it brought.
  const sales = j.metrics?.find((m) => m.key === "gumroad.sales"), rev = j.metrics?.find((m) => m.key === "gumroad.revenue");
  if (sales?.series?.length) {
    let prev = 0;
    const revAt = (t: number) => { let v = 0; for (const [tt, vv] of rev?.series ?? []) if (tt <= t) v = vv; return v; };
    let prevRev = 0;
    for (const [t, n] of sales.series) {
      const r = revAt(t), amount = Math.max(0, r - prevRev) / Math.max(1, n - prev);
      for (let k = prev + 1; k <= n; k++) add({ id: `sale:${p}:${k}`, project: p, kind: "sale", type: "sell", t, title: k === 1 ? "First sale!" : `Sale #${k}`, evidence: `${clip(sales.evidence, 120)}${amount ? ` · about $${Math.round(amount)}` : ""}`, link: { url: "https://app.gumroad.com/sales", project: p }, xp: XP.sale + Math.min(XP.saleDollarCap, Math.round(amount)), amount: Math.round(amount * 100) / 100, tags: ["money"] });
      prev = Math.max(prev, n); prevRev = Math.max(prevRev, r);
    }
  }
  // What you logged: a reading higher than the one before, with a note saying what happened, is a proof.
  const notes = new Map<string, string>();
  for (const e of j.events ?? []) if (e.kind === "manual" && e.detail) notes.set(`${e.t}|${e.title.split(" = ")[0]}`, e.detail);
  for (const m of j.metrics ?? []) {
    if (!m.key.startsWith("manual.")) continue;
    const name = m.key.slice(7), label = name.replace(/_/g, " ");
    const mk = metricKind(name);
    let prev = 0;
    for (const [t, v] of (m.series ?? []).slice().sort((a, b) => a[0] - b[0])) {
      const note = notes.get(`${t}|${label}`);
      if (v > prev && note) {
        const money = mk === "money", users = mk === "users";
        const tags = [money ? "money" : "", users ? "live" : "", money && /mrr|monthly|recurring|arr/.test(name) ? "recurring" : "", money && /mrr|monthly/.test(name) && v >= 1000 ? "mrr1k" : ""].filter(Boolean);
        add({ id: `metric:${p}:${name}:${t}`, project: p, kind: "metric", type: money ? "sell" : users ? "ship" : "build", t, title: `${label} ${prev ? `${prev} → ${v}` : `= ${v}`}`, evidence: `logged by you: ${clip(note, 140)}`, link: { project: p }, xp: money ? XP.metricSell : users ? XP.metricShip : XP.metricOther, metric: `manual.${name}`, value: v, delta: v - prev, tags });
      }
      prev = Math.max(prev, v);
    }
  }
  return out;
}

// ── the ledger: append-only, idempotent ─────────────────────────────────────────────────
/** Who was the main quest at time t (null: no game yet, or before the first pick counts as "before"). */
export function mainAt(history: { project: string | null; from: number }[], t: number): string | null | undefined {
  let cur: string | null | undefined = undefined;
  for (const h of history.slice().sort((a, b) => a.from - b.from)) if (h.from <= t) cur = h.project;
  return cur;
}
/**
 * New ledger lines for the proofs not paid yet. The same evidence id never pays twice, whatever order it arrives in.
 * Proofs from before the game started are paid once, plainly (no double, no cap): your history counts, at face value.
 */
export function appendProofs(ledger: Line[], proofs: Proof[], ctx: { now: number; startedAt: number; history: { project: string | null; from: number }[]; tz?: string }): Line[] {
  const have = new Set(ledger.map((l) => l.id));
  const perDay = new Map<string, number>();
  const dk = (p: Proof) => `${p.kind}|${p.project}|${dayOf(p.t, ctx.tz)}`;
  for (const l of ledger) if (PER_DAY[l.kind]) perDay.set(dk(l), (perDay.get(dk(l)) ?? 0) + 1);
  const out: Line[] = [];
  for (const p of proofs.slice().sort((a, b) => a.t - b.t)) {
    if (!p.id || have.has(p.id) || !(p.xp >= 0) || !p.evidence) continue;
    const cap = PER_DAY[p.kind];
    if (cap) { const n = perDay.get(dk(p)) ?? 0; if (n >= cap) continue; perDay.set(dk(p), n + 1); }
    have.add(p.id);
    const before = p.t < ctx.startedAt;
    const m = mainAt(ctx.history, p.t);
    out.push({ ...p, at: ctx.now, main: before ? null : m === p.project });
  }
  return out;
}
export const revokedIds = (lines: Line[]) => new Set(lines.filter((l) => l.kind === "revoke" && l.revokes).map((l) => l.revokes!));

/**
 * What each line is really worth. Main-quest lines count double. Side-quest lines share a daily allowance: 30% of that
 * day's main-quest XP, and never less than 50, paid first come first served. Lines from before the game pay as they are.
 */
export function score(lines: Line[], opts: { tz?: string } = {}) {
  const revoked = revokedIds(lines);
  const live = lines.filter((l) => l.kind !== "revoke" && !revoked.has(l.id)).slice().sort((a, b) => a.t - b.t || a.at - b.at || a.id.localeCompare(b.id));
  const byDay = new Map<string, Line[]>();
  for (const l of live) { const d = dayOf(l.t, opts.tz); byDay.set(d, [...(byDay.get(d) ?? []), l]); }
  const eff: EffLine[] = [];
  const days = new Map<string, { main: number; side: number; allowance: number; sideRaw: number; before: number }>();
  for (const [d, ls] of byDay) {
    const main = ls.filter((l) => l.main === true).reduce((a, l) => a + l.xp * XP.mainMultiplier, 0);
    const allowance = Math.max(XP.sideFloor, Math.round(main * XP.sideRatio));
    let left = allowance, side = 0, sideRaw = 0, before = 0;
    for (const l of ls) {
      if (l.main === null) { eff.push({ ...l, eff: l.xp }); before += l.xp; continue; }
      if (l.main) { eff.push({ ...l, eff: l.xp * XP.mainMultiplier }); continue; }
      const got = Math.max(0, Math.min(l.xp, left));
      left -= got; side += got; sideRaw += l.xp;
      eff.push({ ...l, eff: got, capped: got < l.xp });
    }
    days.set(d, { main, side, allowance, sideRaw, before });
  }
  eff.sort((a, b) => a.t - b.t || a.at - b.at);
  const total = eff.reduce((a, l) => a + l.eff, 0);
  return { lines: eff, total, days };
}

// ── streaks ────────────────────────────────────────────────────────────────────────
/** Consecutive days with a ship, a sale or a conversation. Opening the deck doesn't count. Today still open keeps it alive. */
export function streak(lines: Line[], today: string, tz?: string) {
  const revoked = revokedIds(lines);
  const days = new Set(lines.filter((l) => STREAK_TYPES.has(l.type) && l.kind !== "revoke" && !revoked.has(l.id)).map((l) => dayOf(l.t, tz)));
  const run = (from: string) => { let n = 0, d = from; while (days.has(d)) { n++; d = addDays(d, -1); } return n; };
  const shippedToday = days.has(today);
  const current = shippedToday ? run(today) : run(addDays(today, -1));
  let best = 0;
  for (const d of days) if (!days.has(addDays(d, -1))) { let n = 0, x = d; while (days.has(x)) { n++; x = addDays(x, 1); } best = Math.max(best, n); }
  return { current, best: Math.max(best, current), today: shippedToday, atRisk: !shippedToday && current > 0, days };
}

// ── bosses: business milestones with a health bar tied to the real number ───────────────────
export type Sigil = "cart" | "coin" | "people" | "crown";
export type Hit = { id: string; t: number; title: string; dmg: number; link?: Link; evidence: string };
/** `known`: the number is measured (Gumroad, or logged); otherwise value is 0 and the page says "not measured yet". */
export type Boss = { id: string; project: string; title: string; source: string; target: number; value: number; known: boolean; unit: string; hp: number; state: "alive" | "defeated"; at?: number; sigil: Sigil; hits: Hit[]; measured: string; standard?: boolean };
const STANDARD: { title: string; source: string; target: number; unit: string }[] = [
  { title: "First paying customer", source: "manual.paying_customers", target: 1, unit: "customers" },
  { title: "10 paying users", source: "manual.paying_customers", target: 10, unit: "customers" },
  { title: "$100 a month", source: "manual.mrr", target: 100, unit: "$" },
  { title: "100 active users", source: "manual.users", target: 100, unit: "users" },
  { title: "$1k a month", source: "manual.mrr", target: 1000, unit: "$" },
];
const bossSource = (s: string) => s.startsWith("gumroad.") || (s.startsWith("manual.") && metricKind(s.slice(7)) !== "other");
const sigilOf = (source: string, target: number): Sigil => (/mrr|monthly|revenue/.test(source) ? (target >= 1000 ? "crown" : "coin") : /paying|customer|sales/.test(source) ? "cart" : "people");
/** Revenue in the 30 days before `now`, from a cumulative revenue series. */
export function last30(series: [number, number][] | undefined, now: number) {
  if (!series?.length) return 0;
  let end = 0, start = 0;
  for (const [t, v] of series) { if (t <= now) end = v; if (t <= now - 30 * 86_400_000) start = v; }
  return Math.max(0, end - start);
}
/**
 * The project's bosses, in ladder order: its money and user milestones (plus standard ones when the ladder has none).
 * Health is what's left to the target in the real number: Gumroad sales and revenue, or what you logged. A proof that
 * moved the number is a hit.
 */
export function bossesFor(j: JourneyLike, lines: Line[], now: number): Boss[] {
  const M = new Map((j.metrics ?? []).map((m) => [m.key, m]));
  const value = (source: string): { v: number; measured: string; known: boolean } => {
    const m = M.get(source);
    if (m) return { v: m.value, measured: m.evidence, known: true };
    if (/paying_customers|customers$/.test(source) && M.get("gumroad.sales")) return { v: M.get("gumroad.sales")!.value, measured: M.get("gumroad.sales")!.evidence, known: true };
    if (/mrr|monthly/.test(source) && M.get("gumroad.revenue")) return { v: last30(M.get("gumroad.revenue")!.series, now), measured: "Gumroad revenue in the last 30 days", known: true };
    return { v: 0, measured: "not measured yet: log it on the project page", known: false };
  };
  const fromLadder = (j.milestones ?? []).filter((m) => bossSource(m.source)).map((m) => ({ title: m.title, source: m.source, target: m.target, unit: m.unit, ms: m }));
  const list = fromLadder.length ? fromLadder : STANDARD.map((s) => ({ ...s, ms: undefined as undefined | JourneyLike["milestones"][number] }));
  const revoked = revokedIds(lines);
  const mine = lines.filter((l) => l.project === j.project && !revoked.has(l.id) && (l.kind === "sale" || l.kind === "metric" || (l.kind === "milestone" && l.tags?.includes("money"))));
  const seen = new Set<string>();
  const out: Boss[] = [];
  for (const b of list.sort((a, b) => (a.ms?.tier ?? 0) - (b.ms?.tier ?? 0) || a.target - b.target)) {
    const id = `${j.project}:${b.source}:${b.target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const { v, measured, known } = value(b.source);
    const done = b.ms?.state === "unlocked" || v >= b.target;
    const related = (l: Line) => l.kind === "sale" ? /paying|customer|sales|revenue|mrr|monthly/.test(b.source) : l.metric === b.source || (l.metric?.startsWith("manual.") && metricKind(l.metric.slice(7)) === metricKind(b.source.replace(/^(manual|gumroad)\./, "")) && /users|dau|mau|active/.test(b.source) === /users|dau|mau|active/.test(l.metric));
    const hits: Hit[] = mine.filter(related).map((l) => ({ id: l.id, t: l.t, title: l.title, dmg: l.kind === "sale" ? (/revenue|mrr|monthly/.test(b.source) ? l.amount ?? 0 : 1) : l.delta ?? 1, link: l.link, evidence: l.evidence })).sort((a, b) => b.t - a.t || b.id.localeCompare(a.id, undefined, { numeric: true }));
    const at = done ? (b.ms?.at ?? hits.at(-1)?.t ?? hits[0]?.t) : undefined;
    out.push({ id, project: j.project, title: b.title, source: b.source, target: b.target, value: v, known, unit: b.unit, hp: done ? 0 : Math.max(0, Math.min(1, 1 - v / b.target)), state: done ? "defeated" : "alive", at, sigil: sigilOf(b.source, b.target), hits, measured, standard: !fromLadder.length });
  }
  return out;
}
export const currentBoss = (bs: Boss[]) => bs.find((b) => b.state === "alive");

// ── founder levels: business milestones decide the level; XP only fills the bar inside it ────────
export const LEVELS = [
  { id: "maker", name: "Maker", step: 250, need: "" },
  { id: "shipper", name: "Shipper", step: 500, need: "Put something live for users: a release, or a deploy the wiki records" },
  { id: "seller", name: "Seller", step: 800, need: "Make your first sale" },
  { id: "founder", name: "Founder", step: 1200, need: "Recurring revenue: sales in two different months, or monthly revenue logged" },
  { id: "operator", name: "Operator", step: 2000, need: "$1k+ in a month" },
] as const;
export type LevelId = (typeof LEVELS)[number]["id"];
/** When each level was reached, across every project (undefined: not yet). */
export function levelReach(lines: Line[]): Partial<Record<LevelId, { at: number; by: Line }>> {
  const revoked = revokedIds(lines);
  const ls = lines.filter((l) => l.kind !== "revoke" && !revoked.has(l.id)).slice().sort((a, b) => a.t - b.t);
  const first = (f: (l: Line) => boolean) => { const l = ls.find(f); return l ? { at: l.t, by: l } : undefined; };
  const out: Partial<Record<LevelId, { at: number; by: Line }>> = { maker: { at: 0, by: undefined as any } };
  const shipper = first((l) => !!l.tags?.includes("live"));
  const seller = first((l) => !!l.tags?.includes("money"));
  // Recurring: monthly revenue logged, or sales in two different calendar months.
  let founder = first((l) => !!l.tags?.includes("recurring"));
  const months = new Map<string, Line>();
  for (const l of ls) if (l.tags?.includes("money")) { const k = d10(l.t).slice(0, 7); if (!months.has(k)) months.set(k, l); if (months.size >= 2 && (!founder || l.t < founder.at)) { founder = { at: l.t, by: l }; break; } }
  // $1k in a month: monthly revenue logged at 1k+, or sales adding up to $1k within any 30 days.
  let operator = first((l) => !!l.tags?.includes("mrr1k"));
  const sales = ls.filter((l) => l.kind === "sale" && l.amount);
  for (let i = 0, a = 0, sum = 0; i < sales.length; i++) {
    sum += sales[i].amount!;
    while (sales[i].t - sales[a].t > 30 * 86_400_000) sum -= sales[a++].amount!;
    if (sum >= 1000) { if (!operator || sales[i].t < operator.at) operator = { at: sales[i].t, by: sales[i] }; break; }
  }
  // Levels are a chain: selling means someone could use it, so a sale also makes you a Shipper.
  if (shipper || seller) out.shipper = shipper && (!seller || shipper.at <= seller.at) ? shipper : seller;
  if (seller) out.seller = seller;
  if (out.seller && founder) out.founder = founder;
  if (out.founder && operator) out.operator = operator;
  return out;
}
export type Level = { id: LevelId; name: string; index: number; since: number; by?: { title: string; evidence: string; link?: Link }; rank: number; xpIn: number; step: number; toNext: number; pct: number; next?: { name: string; need: string } };
/** The level (from business milestones) and the XP bar inside it: rank goes up every `step` XP earned at this level. */
export function levelOf(eff: EffLine[], reach = levelReach(eff)): Level {
  let index = 0;
  LEVELS.forEach((L, i) => { if (reach[L.id]) index = i; });
  const L = LEVELS[index], r = reach[L.id]!;
  const since = index ? r.at : 0;
  const xpIn = eff.filter((l) => l.t >= since).reduce((a, l) => a + l.eff, 0);
  const rank = 1 + Math.floor(xpIn / L.step);
  const into = xpIn % L.step;
  const nx = LEVELS[index + 1];
  return { id: L.id, name: L.name, index, since, by: index && r.by ? { title: r.by.title, evidence: r.by.evidence, link: r.by.link } : undefined, rank, xpIn, step: L.step, toNext: L.step - into, pct: into / L.step, next: nx ? { name: nx.name, need: nx.need } : undefined };
}

// ── achievements ───────────────────────────────────────────────────────────────────
export type Achievement = { id: string; title: string; desc: string; icon: string; at?: number; evidence?: string; link?: Link; project?: string };
export const ACHIEVEMENTS: { id: string; title: string; desc: string; icon: string }[] = [
  { id: "first-deploy", title: "First deploy", desc: "Something went out: a release, or a deploy the wiki records", icon: "rocket" },
  { id: "first-user", title: "First user", desc: "A users number went up, with a note", icon: "user" },
  { id: "first-dollar", title: "First dollar", desc: "Your first sale", icon: "coin" },
  { id: "first-talk", title: "First conversation", desc: "You talked to a user and logged it", icon: "chat" },
  { id: "ten-talks", title: "10 conversations", desc: "Ten logged conversations with users", icon: "chats" },
  { id: "first-lead", title: "First lead contacted", desc: "Replied to someone who has the problem, and logged the link", icon: "send" },
  { id: "streak-7", title: "7-day streak", desc: "Shipped, sold or talked to users seven days running", icon: "flame" },
  { id: "zombie", title: "Killed a zombie project", desc: "Retired a project that was going nowhere", icon: "skull" },
  { id: "first-boss", title: "First boss defeated", desc: "A money or users milestone, unlocked", icon: "sword" },
  { id: "first-quest", title: "First quest done", desc: "Finished a daily quest, with evidence", icon: "check" },
  { id: "ten-quests", title: "10 quests done", desc: "Ten daily quests finished, with evidence", icon: "scroll" },
  { id: "five-ships", title: "5 ships", desc: "Five releases or deploys the wiki records", icon: "ship" },
];
export function achievements(lines: Line[], extra: { bosses: Boss[]; quests: { at: number; title: string; id: string }[]; tz?: string }): Achievement[] {
  const revoked = revokedIds(lines);
  const ls = lines.filter((l) => l.kind !== "revoke" && !revoked.has(l.id)).slice().sort((a, b) => a.t - b.t);
  const nth = (f: (l: Line) => boolean, n = 1) => ls.filter(f)[n - 1];
  const got: Record<string, { at: number; evidence: string; link?: Link; project?: string } | undefined> = {};
  const fromLine = (l?: Line) => (l ? { at: l.t, evidence: `${l.title}: ${l.evidence}`, link: l.link, project: l.project } : undefined);
  got["first-deploy"] = fromLine(nth((l) => l.type === "ship" && (l.kind === "release" || l.kind === "shipnote" || l.kind === "milestone")));
  got["first-user"] = fromLine(nth((l) => (l.kind === "metric" || l.kind === "milestone") && !!l.metric && metricKind(l.metric.replace(/^(manual|gumroad)\./, "")) === "users"));
  got["first-dollar"] = fromLine(nth((l) => !!l.tags?.includes("money")));
  got["first-talk"] = fromLine(nth((l) => l.kind === "talk"));
  got["ten-talks"] = fromLine(nth((l) => l.kind === "talk", 10));
  got["first-lead"] = fromLine(nth((l) => l.kind === "lead"));
  got["zombie"] = fromLine(nth((l) => l.kind === "prune"));
  got["five-ships"] = fromLine(nth((l) => l.type === "ship" && (l.kind === "release" || l.kind === "shipnote"), 5));
  // Seven days running: the 7th day of the first such run.
  const days = [...new Set(ls.filter((l) => STREAK_TYPES.has(l.type)).map((l) => dayOf(l.t, extra.tz)))].sort();
  for (let i = 6; i < days.length; i++) if (addDays(days[i - 6], 6) === days[i]) { const l = ls.find((x) => STREAK_TYPES.has(x.type) && dayOf(x.t, extra.tz) === days[i]); got["streak-7"] = l ? { at: l.t, evidence: `7 days in a row, ${days[i - 6]} to ${days[i]}`, link: l.link, project: l.project } : undefined; break; }
  const beaten = extra.bosses.filter((b) => b.state === "defeated" && b.at).sort((a, b) => a.at! - b.at!)[0];
  if (beaten) got["first-boss"] = { at: beaten.at!, evidence: `${beaten.title} (${beaten.project}): ${beaten.measured}`, project: beaten.project };
  const qs = extra.quests.slice().sort((a, b) => a.at - b.at);
  if (qs[0]) got["first-quest"] = { at: qs[0].at, evidence: qs[0].title };
  if (qs[9]) got["ten-quests"] = { at: qs[9].at, evidence: qs[9].title };
  return ACHIEVEMENTS.map((a) => ({ ...a, ...got[a.id] }));
}

// ── the weekly season ──────────────────────────────────────────────────────────────
export type Scoreboard = { week: string; days: string[]; shipped: { title: string; project: string; link?: Link }[]; sold: number; revenue: number; talks: number; leads: number; xp: number; streak: number; hits: number; defeated: string[]; quests: number; lines: number };
export function seasonFor(week: string, eff: EffLine[], ctx: { tz?: string; bosses: Boss[]; quests: { at: number }[]; streak: number }): Scoreboard {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const inWeek = (t: number) => days.includes(dayOf(t, ctx.tz));
  const ls = eff.filter((l) => inWeek(l.t) && l.kind !== "revoke");
  const hitIds = new Set(ctx.bosses.flatMap((b) => b.hits.filter((h) => inWeek(h.t)).map((h) => h.id)));
  return {
    week, days,
    shipped: ls.filter((l) => l.type === "ship").map((l) => ({ title: l.title, project: l.project, link: l.link })),
    sold: ls.filter((l) => l.kind === "sale" || (l.kind === "metric" && l.type === "sell")).length,
    revenue: Math.round(ls.filter((l) => l.kind === "sale").reduce((a, l) => a + (l.amount ?? 0), 0) * 100) / 100,
    talks: ls.filter((l) => l.kind === "talk").length, leads: ls.filter((l) => l.kind === "lead").length,
    xp: ls.reduce((a, l) => a + l.eff, 0), streak: ctx.streak, hits: hitIds.size,
    defeated: ctx.bosses.filter((b) => b.state === "defeated" && b.at && inWeek(b.at)).map((b) => b.title),
    quests: ctx.quests.filter((q) => inWeek(q.at)).length, lines: ls.length,
  };
}
/** The scoreboard as short evidence lines, for Jev and for the page. */
export function scoreLines(s: Scoreboard): string[] {
  return [
    s.shipped.length ? `Shipped ${s.shipped.length}: ${s.shipped.slice(0, 6).map((x) => `${x.title} (${x.project})`).join("; ")}` : "Shipped nothing with evidence",
    s.sold ? `Sold ${s.sold}${s.revenue ? ` ($${s.revenue})` : ""}` : "No sales",
    `${s.talks} conversation${s.talks === 1 ? "" : "s"} with users logged, ${s.leads} lead${s.leads === 1 ? "" : "s"} contacted`,
    `${s.quests} daily quest${s.quests === 1 ? "" : "s"} done, ${s.hits} boss hit${s.hits === 1 ? "" : "s"}${s.defeated.length ? `, defeated: ${s.defeated.join(", ")}` : ""}`,
    `${s.xp} XP; streak ${s.streak} day${s.streak === 1 ? "" : "s"}`,
  ];
}
