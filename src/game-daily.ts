// The game layer: today's quests for the main quest. Written once a day (one model call, at most two if you switch
// the main quest), completed by new evidence of their kind, or checked off by hand with a link or a note.
import type { Runner } from "./journey-ai";
import { addDays, currentBoss, dayOf, hash, revokedIds, XP, type Boss, type JourneyLike, type Line, type Proof } from "./game-rules";
import { generateQuests, type Quest, type QuestCtx } from "./game-quests";
import { isUrl, leadsFor, normUrl, projectTerms } from "./game-runs";
import { questKey, type DayQuests, type Store } from "./game-store";
import { comparablesFor, tacticsText, type Comparables, type Target } from "./library-strategy";

export const REROLLS_PER_DAY = 2;
export const GENERATIONS_PER_DAY = 2;
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t; };

export type DailyDeps = {
  store: Store; now: () => number; stats: { claude: number };
  journeys: Map<string, JourneyLike & Record<string, any>>; loadJourney: (p: string) => Promise<unknown>; bossesOf: (p: string) => Boss[];
  runner?: Runner; discoverDir: string; leadsSaved?: () => any[]; connections?: () => Promise<string[]>;
  /** Comparable founders (src/library-strategy.ts); the deck's shared library when not given. */
  comparables?: (t: Target) => Comparables | undefined;
  changed: () => void;
};

export function createDaily(d: DailyDeps) {
  const { store } = d;
  const quests = store.quests;
  const generating = new Map<string, Promise<void>>();

  async function questCtx(p: string, day: string): Promise<QuestCtx> {
    if (!d.journeys.get(p)) await d.loadJourney(p);
    const j: any = d.journeys.get(p);
    const run = store.ensure().runs[p];
    const b = currentBoss(d.bossesOf(p));
    const contacted = new Set(store.ledger.filter((l) => l.kind === "lead" && l.link?.url).map((l) => normUrl(l.link!.url!)));
    const leads = leadsFor(projectTerms(p, j, run), store.readJson<any>(`${d.discoverDir}/leads-cache.json`, {}), d.leadsSaved?.() ?? [], contacted);
    const conns = await Promise.race([d.connections?.() ?? Promise.resolve([]), Bun.sleep(4000).then(() => [] as string[])]).catch(() => [] as string[]);
    const ms: JourneyLike["milestones"] = j?.milestones ?? [];
    const next = [...(j?.next ?? []).map((id: string) => ms.find((m) => m.id === id)), ...ms].filter((m, i, a): m is (typeof ms)[number] => !!m && m.state !== "unlocked" && a.indexOf(m) === i).slice(0, 4);
    const gum = j?.sources?.gumroad;
    // Tactics that worked for founders most like this project, for the milestone it's working toward.
    let comparables = "";
    try { comparables = tacticsText((d.comparables ?? comparablesFor)({ name: p, offer: run?.offer || j?.pitch, buyer: run?.buyer, price: run?.price != null ? String(run.price) : undefined, text: j?.pitch }), b?.title ?? next[0]?.title ?? "first paying customer"); } catch {}
    return {
      project: p, root: j?.root, pitch: j?.pitch || run?.pitch, heading: j?.heading?.direction, stage: j?.stage?.title, nature: j?.nature, day,
      next: next.map((m) => ({ id: m.id, title: m.title, metric: m.metric, target: m.target, value: m.value, unit: m.unit })),
      boss: b ? { title: b.title, source: b.source, value: b.value, target: b.target, unit: b.unit, measured: b.known } : undefined,
      urls: j?.urls ?? [], product: gum && !/^(unavailable|no matching)/.test(gum) ? gum : undefined,
      recent: store.ledger.filter((l) => l.project === p && l.kind !== "revoke").slice(-5).map((l) => l.title),
      leads, connections: conns, run: run ? { buyer: run.buyer, offer: run.offer, price: run.price } : undefined,
      done: Object.values(quests).filter((q) => q.project === p && q.day >= addDays(day, -7)).flatMap((q) => q.items.filter((x) => x.state === "done").map((x) => x.title)),
      comparables: comparables || undefined,
    };
  }
  /** Today's quests for the main quest: written once a day, with spares for Reroll. */
  function ensureQuests(opts: { wait?: boolean } = {}): Promise<void> {
    const s = store.ensure();
    const p = s.main?.project, day = store.today();
    const key = p ? questKey(day, p) : "";
    if (!p || quests[key]) return Promise.resolve();
    let job = generating.get(key);
    if (!job) {
      job = (async () => {
        const ctx = await questCtx(p, day);
        const budget = (s.generations[day] ?? 0) < GENERATIONS_PER_DAY;
        const gen = await generateQuests(ctx, budget && d.runner ? { runner: d.runner, onCall: () => { d.stats.claude++; s.generations[day] = (s.generations[day] ?? 0) + 1; store.saveState(); } } : {});
        if (!budget && d.runner) gen.note = "Today's model budget is used: these come from simple rules.";
        quests[key] = { day, project: p, createdAt: d.now(), source: gen.source, model: gen.model, note: gen.note, ms: gen.ms, items: gen.quests.slice(0, 3), spares: gen.quests.slice(3), rerolls: 0, rejected: gen.rejected };
        for (const [k, x] of Object.entries(quests)) if (x.day < addDays(day, -60)) delete quests[k];
        store.saveQuests();
        verifyQuests();
        d.changed();
      })().finally(() => generating.delete(key));
      generating.set(key, job);
    }
    return opts.wait ? job : Promise.resolve();
  }
  function reroll(id: string) {
    const main = store.state?.main?.project;
    const dq = main ? quests[questKey(store.today(), main)] : undefined;
    if (!dq) throw new Error("No quests today yet");
    if (dq.rerolls >= REROLLS_PER_DAY) throw new Error(`You've used today's ${REROLLS_PER_DAY} rerolls.`);
    const i = dq.items.findIndex((q) => q.id === id);
    if (i < 0) throw new Error("That quest isn't on today's board");
    if (dq.items[i].state === "done") throw new Error("It's already done");
    const next = dq.spares.shift();
    if (!next) throw new Error("No other quest for today: the spares are used up");
    dq.items[i] = next;
    dq.rerolls++;
    store.saveQuests();
    verifyQuests();
  }
  const matches = (q: Quest, l: Line) =>
    q.proof === "sell" ? l.type === "sell" : q.proof === "talk" ? l.kind === "talk" : q.proof === "lead" ? l.kind === "lead" : q.proof === "ship" ? l.type === "ship" && l.kind !== "metric" : q.proof === "milestone" ? l.kind === "milestone" : q.proof === "metric" ? l.kind === "metric" && (!q.metric || l.metric === q.metric) : l.kind === "check";
  /** A quest is done when new evidence of its kind shows up on its project after it was set (one proof completes one quest). */
  function verifyQuests(): { q: Quest; dq: DayQuests }[] {
    const done: { q: Quest; dq: DayQuests }[] = [];
    const revoked = revokedIds(store.ledger);
    const used = new Set(Object.values(quests).flatMap((x) => x.items.flatMap((q) => q.evidence?.ids ?? [])));
    let changed = false;
    for (const dq of Object.values(quests)) {
      if (dq.day < addDays(store.today(), -1)) continue; // yesterday's quests can still complete this morning
      for (const q of dq.items) {
        if (q.state === "done") continue;
        // New evidence only: dated after the quest was set, or dated that day (wiki entries carry a date, not a time)
        // and recorded after it. History found by a sweep never completes today's quest.
        const fits = store.ledger.filter((l) => l.project === dq.project && l.kind !== "revoke" && !revoked.has(l.id) && !used.has(l.id) && (l.t >= dq.createdAt || (dayOf(l.t, store.tz()) >= dq.day && l.at >= dq.createdAt)) && matches(q, l));
        const need = q.proof === "lead" ? q.count : 1;
        if (q.progress !== Math.min(need, fits.length)) { q.progress = Math.min(need, fits.length); changed = true; }
        if (fits.length < need) continue;
        const by = fits.sort((a, b) => Number(a.kind === "milestone") - Number(b.kind === "milestone") || a.t - b.t).slice(0, need); // the sale itself, not the milestone it unlocked
        by.forEach((l) => used.add(l.id));
        complete(dq, q, by);
        done.push({ q, dq });
        changed = true;
      }
    }
    if (changed) store.saveQuests();
    return done;
  }
  function complete(dq: DayQuests, q: Quest, by: Line[], manual = false) {
    q.state = "done"; q.doneAt = d.now();
    q.evidence = { title: by[0].title, evidence: by.map((l) => l.evidence).join(" · "), link: by[0].link, ids: by.map((l) => l.id), manual };
    store.record([{ id: `quest:${dq.day}:${q.id}`, project: dq.project, kind: "quest", type: "bonus", t: d.now(), title: `Quest done: ${q.title}`, evidence: `proved by ${by.map((l) => l.title).join(", ")}`, link: by[0].link, xp: q.xp }]);
  }
  /** Checking a quest off by hand: the link or note becomes the proof (and pays as that kind of proof). */
  function checkOff(id: string, body: { url?: string; note?: string }): { q: Quest; dq: DayQuests; line?: Line } {
    const dq = Object.values(quests).find((x) => x.items.some((q) => q.id === id));
    const q = dq?.items.find((x) => x.id === id);
    if (!dq || !q) throw new Error("That quest isn't on the board");
    if (q.state === "done") return { q, dq };
    const url = isUrl(body.url) ? body.url : undefined, note = clip(body.note, 240);
    if (q.proof === "lead") throw new Error("Log each lead you contacted with its link: that's the proof");
    if (q.proof === "sell" || q.proof === "metric") throw new Error("Log the number on the project page (with a note): the quest completes from it");
    if (q.proof === "milestone") throw new Error("Mark the milestone unlocked on the project page with a note: the quest completes from it");
    if (q.proof === "check") throw new Error("This one completes when the project's checks pass");
    if (q.proof === "ship" && !url) throw new Error("A ship needs the live link (a URL someone else can open)");
    if (!url && note.length < 8) throw new Error("Add a link, or a note saying what happened (who, where)");
    const p: Proof = q.proof === "ship"
      ? { id: `shiplink:${dq.project}:${normUrl(url!)}`, project: dq.project, kind: "shipnote", type: "ship", t: d.now(), title: `Shipped: ${q.title}`, evidence: `live link you logged: ${url}${note ? ` (${note})` : ""}`, link: { url, project: dq.project }, xp: XP.shipnote, tags: ["live"] }
      : { id: `talk:${dq.project}:${hash(`${url ?? ""}|${note}`)}:${dq.day}`, project: dq.project, kind: "talk", type: "talk", t: d.now(), title: clip(`Talked to users: ${note || q.title}`, 90), evidence: `logged by you${url ? `: ${url}` : ""}${note ? ` (${note})` : ""}`, link: url ? { url, project: dq.project } : { project: dq.project }, xp: XP.talk };
    const line = store.addManual(p) ?? store.ledger.find((l) => l.id === p.id);
    const used = Object.values(quests).some((x) => x.items.some((y) => y.evidence?.ids.includes(line?.id ?? "")));
    if (!line || used) throw new Error("That evidence already completed a quest");
    complete(dq, q, [line], true);
    store.saveQuests();
    return { q, dq, line };
  }
  /** Evidence undone: the quests it completed reopen, and their bonus is taken back. */
  function reopen(id: string) {
    for (const dq of Object.values(quests)) for (const q of dq.items) if (q.evidence?.ids.includes(id)) { store.revoke(`quest:${dq.day}:${q.id}`, "its evidence was undone"); q.state = "open"; q.evidence = undefined; q.doneAt = undefined; q.progress = 0; }
    store.saveQuests();
    verifyQuests();
  }

  return { questCtx, ensureQuests, reroll, verifyQuests, checkOff, reopen, generating };
}
