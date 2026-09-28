import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createOpportunities } from "../../../src/opportunities";
import { createDiscoverEvidence, discoverProof, evidenceLanes } from "../discover-evidence";
import { cachedProblems, currentProblemPosts, generateProblems, problemBriefs } from "../ideagen/problem-gallery";
import { createGalleryServer, dayOf } from "../gallery-server";
import type { GalleryDeps } from "../ideagen/gallery";
import type { IdeaCard, PainCorpus, PainPost } from "../ideagen/types";

const DAY = 86_400_000, now = Date.UTC(2026, 8, 27, 12);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
function temp() { const dir = mkdtempSync(`${tmpdir()}/discover-evidence-`); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function storeAt(clock = () => now) { const s = createOpportunities({ file: ":memory:", now: clock }); cleanups.push(() => s.close()); return s; }
const post = (extra: Partial<PainPost> = {}): PainPost => ({ id: "p1", source: "reddit", url: "https://reddit.com/r/trades/comments/a", title: "Finding job photos", snippet: "I spend an hour every Friday finding the job completion photos scattered across messages.", pain: 3, score: 10, signals: [], at: now - DAY, audience: "trades", ...extra });
const corpus = (posts = [post()]): PainCorpus => ({ at: now, posts, themes: [], queries: [] });
const card = (extra: Partial<IdeaCard> = {}): IdeaCard => ({ id: "idea-1", name: "Completion packet", hook: "An experiment with job photos", buyer: "Electrical contractors", pain: "Job photos scattered across messages", offer: "One completion packet", price: "$99", channel: "Local trade association", mvp: "Manually assemble one packet", stack: [], connectors: [], missing: [], timeToFirstDollarDays: 7, difficulty: "week", quality: 99, jevP10: 0.99, evidenceScore: 1, strategy: "C-audience", topics: [], play: { quests: [] }, ownedRatio: 0, evidence: [{ url: post().url, snippet: post().snippet, source: "reddit" }], ...extra });
function generation(posts = [post()], reply?: (input: any) => any) {
  const calls: any[] = [];
  const d: GalleryDeps = { cacheDir: temp(), inv: { at: now, assets: [], audiences: [], keys: [] }, corpus: corpus(posts), now: () => now,
    claude: async o => { calls.push(o); const input = JSON.parse(o.user); return { text: JSON.stringify(reply ? reply(input) : { ideas: input.briefs.map((b: any) => ({ brief: b.id, name: b.id, buyer: "Trades", pain: "Photos are scattered", offer: "A packet", evidence_ids: b.sources.map((s: any) => s.id), quality: 100, price: "$999", days_to_first_dollar: 1 })) }), model: "fixture", ms: 0 }; },
    jev: async () => { throw new Error("A model judge must never run"); } };
  return { d, calls };
}
describe("problem-first generation", () => {
  test("unknown/old/future dates, private URLs and duplicates cannot inflate the input pool", () => {
    const p = post();
    const c = corpus([p, { ...p, id: "copy", url: "https://news.example.org/copy" }, post({ id: "unknown", at: 0 }), post({ id: "old", at: now - 91 * DAY }), post({ id: "future", at: now + DAY }), post({ id: "private", url: "http://127.0.0.1/" })]);
    expect(currentProblemPosts(c, now)).toEqual([p]);
    expect(currentProblemPosts({ ...c, at: now - 8 * DAY }, now)).toEqual([]);
  });
  test("no qualifying problem means a valid empty result, zero model calls and no fallback ideas", async () => {
    const { d, calls } = generation([]);
    const g = await generateProblems(d);
    expect(Object.keys(g.ideas)).toHaveLength(0); expect(calls).toHaveLength(0);
    expect(cachedProblems(d.cacheDir, dayOf(now))?.version).toBe("evidence-v1");
    expect(g.stats.note).toContain("No current");
  });
  test("only supplied citations survive; generated prices and predictions cannot become facts", async () => {
    const { d, calls } = generation();
    const g = await generateProblems(d), c = Object.values(g.ideas)[0];
    expect(c.origin).toBe("problem-first"); expect(c.evidence[0].snippet).toBe(post().snippet);
    expect(c.evidence[0].publishedAt).toBe(post().at); expect(c.evidence[0].fetchedAt).toBe(now);
    expect(c.price).toBe(""); expect(c.timeToFirstDollarDays).toBe(-1); expect(c.jevP10).toBeUndefined();
    expect(c.quality).toBe(0); expect(g.stats.jevCalls).toBe(0);
    await generateProblems(d); expect(calls).toHaveLength(1);
    const bad = generation(undefined, input => ({ ideas: [{ brief: input.briefs[0].id, name: "Mismatch", buyer: "Trades", pain: "Photos", offer: "Packet", evidence_ids: ["bird-project"] }] }));
    expect(Object.keys((await generateProblems(bad.d)).ideas)).toHaveLength(0);
  });
  test("bounded sampling covers different audiences before repeating one", () => {
    const posts = Array.from({ length: 20 }, (_, i) => post({ id: `p${i}`, url: `https://example.org/${i}`, snippet: `${post().snippet} Distinct source ${i}`, audience: i < 17 ? "large" : "small", at: now - i * 1000 }));
    const b = problemBriefs(corpus(posts), now);
    expect(b).toHaveLength(6); expect(b[0].posts[0].audience).toBe("large"); expect(b[1].posts[0].audience).toBe("small");
  });
});
function reviewed(s: ReturnType<typeof storeAt>, id: string) {
  return s.addResearch(id, {
    sources: ["a", "b"].map((x, i) => ({ id: x, url: `https://${x}.example.org/report`, excerpt: `A different contractor describes lost photos ${i}`, independenceGroup: x, kind: "customer", access: "opened", publishedAt: now - DAY })),
    claims: [{ id: "problem", text: "These contractors report losing job photos", dimension: "problem", status: "observed", supportingSourceIds: ["a", "b"] }],
    reviews: ["buyer", "problem"].map(dimension => ({ dimension: dimension as "buyer" | "problem", sourceIds: ["a", "b"], notes: "Checked the exact buyer and problem" })),
  }, { actor: "user" });
}
const experiment = (kind = "paid-pilot") => ({ kind: kind as "paid-pilot" | "buying-signal", hypothesis: "Contractors buy a packet", segment: "Electrical contractors", channel: "Local association", offer: "One packet at 99", successCriteria: { minParticipants: 5, minSuccesses: 2 }, failureCriteria: "Fewer than two purchases", budget: 0 });
describe("shared notebook and observed stages", () => {
  test("old 99/100 cards become untested; imports are idempotent and preserve user edits", () => {
    const s = storeAt(), bridge = createDiscoverEvidence(s, () => now), c = card();
    expect(bridge.proof(c).stage).toBe("concept"); expect(s.list()).toHaveLength(0);
    const item = bridge.open(c);
    expect(item.buyer).toBe(c.buyer); expect(item.problem).toBe(c.pain);
    expect(item.sources[0].access).toBe("unverified"); expect(item.claims[0].status).toBe("inferred");
    s.update(item.id, { buyer: "Revised buyer" });
    expect(bridge.open(c).buyer).toBe("Revised buyer"); expect(s.list()).toHaveLength(1);
  });
  test("reviewed problem requires independent current sources; stale evidence, objections and pivots invalidate it", () => {
    let clock = now; const s = storeAt(() => clock), bridge = createDiscoverEvidence(s, () => clock), c = card();
    const item = bridge.open(c); let r = reviewed(s, item.id);
    // Different subdomains of one publisher are not independent groups.
    expect(discoverProof(r, now).stage).toBe("concept");
    r = s.addResearch(item.id, { sources: [{ ...r.sources.find(x => x.id === "b")!, url: "https://independent.org/report" }] }, { actor: "user" });
    r = s.addResearch(item.id, { claims: [{ ...r.claims.find(c => c.id === "problem")!, status: "observed" }], reviews: ["buyer", "problem"].map(dimension => ({ dimension: dimension as "buyer" | "problem", sourceIds: ["a", "b"], notes: "Checked after correction" })) }, { actor: "user" });
    expect(discoverProof(r, clock).stage).toBe("problem-documented");
    clock += 91 * DAY; expect(bridge.proof(c).stage).toBe("concept"); clock = now;
    s.addResearch(item.id, { claims: [{ id: "objection", text: "The existing tool already fixed it", dimension: "alternatives", status: "contradicted", supportingSourceIds: ["a"] }] }, { actor: "user" });
    expect(bridge.proof(c).stage).toBe("concept"); expect(bridge.proof(c).objections).toBe(1);
    s.update(item.id, { buyer: "A different buyer" }); expect(bridge.proof(c).stage).toBe("concept");
  });
  test("actual result fields and predeclared criteria control paid stage; failed tests stay visible", () => {
    const s = storeAt(), bridge = createDiscoverEvidence(s, () => now), c = card(), item = bridge.open(c);
    let o = s.addExperiment(item.id, experiment(), { actor: "user" });
    o = s.recordExperiment(item.id, o.experiments[0].id, { denominator: 5, successes: 5, payingCustomers: 0, evidenceReference: "test/interest" }, { actor: "user" });
    expect(bridge.proof(c).stage).toBe("concept"); expect(bridge.proof(c).failedTests).toBe(1);
    o = s.addExperiment(item.id, experiment(), { actor: "user" });
    s.recordExperiment(item.id, o.experiments[1].id, { denominator: 5, successes: 2, payingCustomers: 2, revenue: 198, evidenceReference: "test/payments" }, { actor: "user" });
    const proof = bridge.proof(c);
    expect(proof.stage).toBe("paid-pilot"); expect(proof.failedTests).toBe(1);
    expect(proof.latestTest?.payingCustomers).toBe(2);
    expect(evidenceLanes([{ ...c, proof }])[0].ideas).toEqual([]);
    s.update(item.id, { problem: "A different problem" });
    expect(bridge.proof(c).stage).toBe("concept"); expect(bridge.proof(c).latestTest).toBeNull();
  });
  test("high AI scores and large unreviewed link counts never earn shortlist placement", () => {
    const cards = [card(), card({ id: "trend", evidenceScore: 1 })].map(c => ({ ...c, proof: discoverProof(undefined, now) }));
    expect(evidenceLanes(cards)[0].ideas).toEqual([]); expect(evidenceLanes(cards)[2].ideas).toHaveLength(2);
  });
});
describe("Discover API", () => {
  test("opening is passive, scores are removed, saved snapshots remain, explicit research can finish empty", async () => {
    const dir = temp(), c = card(), s = storeAt(); let calls = 0;
    const legacy = { day: dayOf(now), at: now, version: "g1", lanes: [{ id: "top", ideas: [c.id] }], ideas: { [c.id]: c }, stats: {} };
    mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/gallery-${dayOf(now)}.json`, JSON.stringify(legacy));
    const g = createGalleryServer({ dir, projectsDir: `${dir}/projects`, now: () => now, evidenceStore: s,
      sections: async () => [], projects: async () => [], gems: () => [], gh: async () => ({ ok: false }),
      corpus: async () => { calls++; return corpus([]); }, trends: async () => { throw new Error("Trends must not substitute for problem reports"); },
      claudeRaw: async () => { throw new Error("No problem, no model call"); }, log: () => {} });
    const state: any = await g.handle("/api/ideas/state", { ensure: true });
    expect(calls).toBe(0); expect(state.job).toBeUndefined(); expect(state.lanes[0].ideas).toEqual([]);
    expect(state.ideas[c.id].quality).toBeUndefined(); expect(state.ideas[c.id].jevP10).toBeUndefined();
    expect((await g.handle("/api/ideas/card", { id: c.id }) as any).evidenceScore).toBeUndefined();
    expect(s.list()).toHaveLength(0);
    await g.handle("/api/ideas/save", { id: c.id });
    const linked: any = await g.handle("/api/ideas/dossier", { id: c.id }); expect(s.get(linked.id)?.stage).toBe("concept");
    await expect(g.handle("/api/ideas", {})).rejects.toThrow("Confirm");
    await g.handle("/api/ideas", { consent: true }); await g.whenIdle();
    expect(g._job()?.status).toBe("done"); expect(g.state().source).toBe("today");
    expect(g.state().saved[0].id).toBe(c.id); expect(g.state().ideas[c.id]).toBeDefined();
    expect(g.state().note).toContain("No current");
    await g.handle("/api/ideas/save", { id: c.id, op: "unsave" });
    rmSync(`${dir}/gallery-${dayOf(now)}.json`);
    expect(g.state().ideas[c.id]).toBeDefined();
    expect(g.cardAnywhere(c.id)?.id).toBe(c.id);
    s.update(linked.id, { title: "Owner correction" });
    expect((await g.handle("/api/ideas/card", { id: c.id }) as any).title).toBe("Owner correction");
  });
});
