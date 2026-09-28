import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createOpportunities, DIMENSIONS, INDUSTRIES, type ResearchInput, type ExperimentInput, type ExperimentResultInput } from "../src/evidence-notebook";

const dir = mkdtempSync(`${tmpdir()}/deck-opportunities-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const START = Date.UTC(2026, 8, 26);
const DAY = 86_400_000;
const economicsFixture = () => ({ currency: "USD", model: "subscription", activeCustomers: 50, pricePerCustomer: { value: 99, basis: "assumed" },
  variableCostPerCustomer: 25, fixedMonthlyCost: 300, founderHoursPerMonth: 10, founderHourlyRate: 100, cac: 240, monthlyChurn: .04,
  newCustomersPerMonth: 5, startupCost: 500, availableHoursPerMonth: 80 });
function setup() {
  let time = START;
  const file = `${dir}/${crypto.randomUUID()}.db`;
  const service = createOpportunities({ file, now: () => time });
  const o = service.create({ title: "Field completion packet", mode: "markets", industry: "construction", buyer: "Owner of a small roofing crew", problem: "Photo handoff takes hours", mechanism: "Convert worksite photos into a completion packet", economics: economicsFixture() });
  return { service, o, file, now: () => time, advance: (days: number) => { time += days * DAY; } };
}
function research(): ResearchInput {
  return {
    sources: [
      { id: "c1", url: "https://roofingassociation.org/crew-one", excerpt: "Our crew spends two hours preparing each job packet.", access: "opened", kind: "customer", independenceGroup: "crew-one" },
      { id: "c2", url: "https://fieldworkjournal.com/crew-two", excerpt: "Job packet preparation requires a second administrator.", access: "opened", kind: "customer", independenceGroup: "crew-two" },
      { id: "alt", url: "https://workflowvendor.com/pricing", excerpt: "A competing product offers completion packets for $99 monthly.", access: "opened", kind: "competitor" },
    ],
    claims: [
      { id: "p1", text: "Two hours are spent on the packet.", dimension: "problem", status: "observed", supportingSourceIds: ["c1"] },
      { id: "p2", text: "An administrator is needed.", dimension: "buyer", status: "observed", supportingSourceIds: ["c2"] },
    ],
    reviews: DIMENSIONS.map(dimension => ({ dimension, sourceIds: dimension === "economics" ? [] : [dimension === "alternatives" ? "alt" : "c1"], notes: `Checked ${dimension}; unknowns and assumptions recorded.` })),
  };
}
function plan(kind: ExperimentInput["kind"]): ExperimentInput {
  return { kind, hypothesis: "Roofing owners will pay for a completed packet", segment: "Roofing crew owners", channel: "Customer interviews", offer: "$99 completion packet", failureCriteria: "Fewer than 2 of 5 take the offer", successCriteria: { minParticipants: 5, minSuccesses: 2, minSuccessRate: .4 }, currency: "USD", budget: 100 };
}
function result(extra: Partial<ExperimentResultInput> = {}): ExperimentResultInput {
  return { denominator: 5, successes: 2, payingCustomers: 2, revenue: 198, refunds: 0, evidenceReference: "Local receipt ledger, September, rows 1 and 2", ...extra };
}

test("unrelated concepts require no portfolio ingredients and preserve stable IDs and edits across restarts", () => {
  const { service, o, file, now } = setup();
  expect(o.mode).toBe("markets"); expect(o.stage).toBe("concept"); expect(o.readiness.ready).toBe(false);
  expect(INDUSTRIES.some(i => i.id === "hospitality")).toBe(true);
  const updated = service.update(o.id, { notes: "Interview roofing owners before building", economics: { price: 149, basis: "assumed" } }, { expectedVersion: o.version });
  expect(updated.version).toBe(2); expect(updated.createdAt).toBe(o.createdAt);
  service.close();
  const again = createOpportunities({ file, now });
  expect(again.get(o.id)).toMatchObject({ version: 2, notes: updated.notes, economics: updated.economics });
  expect(again.history(o.id).map(h => h.version)).toEqual([2, 1]);
  expect(again.history(o.id)[1].economics).toEqual(o.economics);
  again.close();
});

test("legacy Build imports remain unverified and cannot overwrite edited dossiers", () => {
  const { service } = setup();
  const b = { id: "feed-123", title: "A generated pitch", pitch: "Novel software", customer: "Owners", problem: "Slow processes", why_novel: "New mechanism", stage: "paid-pilot", verified: true, score: 10, price: "$1000" };
  const imported = service.importBuild(b);
  expect(imported.id).toBe("feed-123"); expect(imported.legacyId).toBe("feed-123"); expect(imported.stage).toBe("concept");
  expect(imported.claims).toEqual([]); expect(imported.economics).toBeNull();
  service.update(imported.id, { title: "Owner-edited title" });
  expect(service.importBuild(b).title).toBe("Owner-edited title");
  const unusual = service.importBuild({ ...b, id: "old project / unicode ▧" });
  expect(unusual.legacyId).toBe("old project / unicode ▧"); expect(unusual.id).toMatch(/^legacy-/);
  expect(service.importBuild({ ...b, id: "old project / unicode ▧" }).id).toBe(unusual.id);
  service.close();
});

test("model supplied citations and observed flags never confer human verification", () => {
  const { service, o } = setup();
  const generated = service.addResearch(o.id, research());
  expect(generated.stage).toBe("concept"); expect(generated.sources.every(s => s.checkedBy === null && s.access === "unverified")).toBe(true);
  expect(generated.claims.every(c => c.status === "inferred" && c.checkedBy === null)).toBe(true);
  expect(generated.reviews.every(r => r.reviewedBy === null)).toBe(true);
  expect(() => service.update(o.id, { stage: "paid-pilot" } as any)).toThrow("Unsupported");
  expect(() => service.create({ title: "Pitch", stage: "research-ready" } as any)).toThrow("Unsupported");
  service.close();
});

test("retrieval attests exact excerpts, not invented conclusions or dimension review", () => {
  const { service, o } = setup();
  const input = research(); input.claims![0].text = `Public source reports: ${input.sources![0].excerpt}`;
  input.claims![1].text = "There are 50,000 ready buyers each paying $100";
  const read = service.addResearch(o.id, input, { actor: "retrieval" });
  expect(read.claims[0]).toMatchObject({ status: "observed", checkedBy: "retrieval" });
  expect(read.claims[1]).toMatchObject({ status: "inferred", checkedBy: null });
  expect(read.stage).toBe("concept"); expect(read.reviews.every(r => r.reviewedBy === null)).toBe(true);
  service.close();
});

test("research readiness requires independent current evidence and explicit human dimension reviews", () => {
  const { service, o } = setup();
  const ready = service.addResearch(o.id, research(), { actor: "user" });
  expect(ready.stage).toBe("research-ready"); expect(ready.readiness.ready).toBe(true); expect(ready.readiness.independentGroups).toBe(2);
  expect(ready.readiness.policy).toContain("screening policy");
  const revised = service.update(o.id, { economics: { price: 199, basis: "assumed" } });
  expect(revised.stage).toBe("concept"); expect(revised.readiness.missing.some(s => s.includes("economics"))).toBe(true);
  service.close();
});

test("reposts, same publisher and reused excerpts do not multiply source independence", () => {
  for (const mode of ["publisher", "event", "excerpt"]) {
    const { service, o } = setup(); const input = research();
    if (mode === "publisher") input.sources![1].url = "https://news.roofingassociation.org/crew-two";
    if (mode === "event") input.sources![1].independenceGroup = "crew-one";
    if (mode === "excerpt") input.sources![1].excerpt = input.sources![0].excerpt;
    const actual = service.addResearch(o.id, input, { actor: "user" });
    expect(actual.readiness.independentGroups).toBe(1); expect(actual.stage).toBe("concept"); service.close();
  }
});

test("aging, failed retrieval and changed source text invalidate readiness without wiping user edits", () => {
  const { service, o, advance } = setup();
  service.update(o.id, { notes: "Preserve me", revenue: { primary: "service", rationale: "Test episodic value" } });
  service.addResearch(o.id, research(), { actor: "user" });
  advance(31);
  expect(service.get(o.id)?.stage).toBe("concept");
  expect(service.get(o.id)?.readiness.missing.some(s => s.includes("alternatives"))).toBe(true);
  const refreshed = service.addResearch(o.id, { sources: [{ id: "c1", url: "https://roofingassociation.org/crew-one", excerpt: "", access: "failed", error: "Page unavailable" }], unknowns: ["Customer frequency still unknown"] }, { actor: "retrieval" });
  expect(refreshed.notes).toBe("Preserve me"); expect(refreshed.economics).toEqual(o.economics);
  expect(refreshed.revenue?.primary).toBe("service"); expect(refreshed.claims[0].checkedBy).toBeNull();
  expect(service.history(o.id).some(h => h.stage === "research-ready")).toBe(true);
  service.close();
});

test("material contradictions and current opposing evidence block research readiness", () => {
  const { service, o } = setup();
  service.addResearch(o.id, research(), { actor: "user" });
  const opposed = service.addResearch(o.id, { claims: [{ id: "p1", text: "Two hours are spent on packets", dimension: "problem", status: "observed", supportingSourceIds: ["c1"], opposingSourceIds: ["alt"] }] }, { actor: "user" });
  expect(opposed.stage).toBe("concept"); expect(opposed.readiness.missing.some(s => s.includes("opposing evidence"))).toBe(true);
  const contradiction = service.addResearch(o.id, { claims: [{ id: "p1", text: "No workaround exists", dimension: "alternatives", status: "contradicted", supportingSourceIds: [] }] }, { actor: "user" });
  expect(contradiction.readiness.missing.some(s => s.includes("contradicted"))).toBe(true);
  service.close();
});

test("untrusted refresh cannot overwrite checked sources, claims or economics and arbitrary source IDs fail", () => {
  const { service, o } = setup(); const first = service.addResearch(o.id, research(), { actor: "user" });
  const attack = research(); attack.sources![0].excerpt = "Fabricated revised quote"; attack.claims![0].text = "Guaranteed trillion-dollar market";
  const refreshed = service.addResearch(o.id, attack);
  expect(refreshed.sources[0]).toEqual(first.sources[0]); expect(refreshed.claims[0]).toEqual(first.claims[0]);
  expect(refreshed.stage).toBe("research-ready");
  expect(() => service.addResearch(o.id, { claims: [{ text: "Fake", dimension: "buyer", status: "observed", supportingSourceIds: ["nonexistent"] }] }, { actor: "user" })).toThrow("Unknown source");
  expect(() => service.addResearch(o.id, { economics: { price: 999 } } as any)).toThrow("Unsupported");
  expect(service.get(o.id)?.version).toBe(refreshed.version);
  service.close();
});

test("experiments separate immutable plans from recorded outcomes, including inconclusive and failed tests", () => {
  const { service, o } = setup();
  expect(() => service.addExperiment(o.id, plan("paid-pilot"), { actor: "model" } as any)).toThrow("user-recorded");
  const planned = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" }), eid = planned.experiments[0].id;
  expect(() => service.recordExperiment(o.id, eid, result(), { actor: "model" } as any)).toThrow("user-recorded");
  const inconclusive = service.recordExperiment(o.id, eid, result({ denominator: 0, successes: 0, payingCustomers: 0, revenue: 0 }), { actor: "user" });
  expect(inconclusive.experiments[0].result?.outcome).toBe("inconclusive"); expect(inconclusive.stage).toBe("concept");
  expect(() => service.recordExperiment(o.id, eid, result(), { actor: "user" })).toThrow("immutable");
  const next = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  const failed = service.recordExperiment(o.id, next.experiments[1].id, result({ successes: 1, payingCustomers: 1, revenue: 99 }), { actor: "user" });
  expect(failed.experiments[1].result?.outcome).toBe("fail"); expect(failed.stage).toBe("concept");
  service.close();
});

test("interest cannot masquerade as payment, and retention needs positive payment and a cohort window", () => {
  const { service, o, advance } = setup();
  const interest = service.addExperiment(o.id, plan("buying-signal"), { actor: "user" });
  expect(service.recordExperiment(o.id, interest.experiments[0].id, result({ payingCustomers: 0, revenue: 0 }), { actor: "user" }).stage).toBe("buying-signal");
  const refunded = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  expect(service.recordExperiment(o.id, refunded.experiments[1].id, result({ refunds: 198 }), { actor: "user" }).stage).toBe("buying-signal");
  const paid = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  expect(service.recordExperiment(o.id, paid.experiments[2].id, result(), { actor: "user" }).stage).toBe("paid-pilot");
  const repeat = service.addExperiment(o.id, plan("repeat-use"), { actor: "user" });
  advance(30);
  const retained = service.recordExperiment(o.id, repeat.experiments[3].id, result({ repeatCustomers: 2, repeatPayments: 2, windowDays: 30 }), { actor: "user" });
  expect(retained.stage).toBe("repeat-use"); expect(retained.readiness.ready).toBe(false);
  expect(retained.experiments.every(e => e.result?.recordedBy === "user")).toBe(true);
  service.close();
});

test("invalid fields, references, dates, bounds and optimistic concurrency fail atomically", () => {
  const { service, o } = setup();
  expect(() => service.create({ title: "  " })).toThrow("required");
  expect(() => service.get("../bad")).toThrow("Invalid id");
  expect(() => service.create({ title: "Bad", mode: "anything" } as any)).toThrow("Invalid mode");
  expect(() => service.list({ limit: -1 })).toThrow("Invalid limit");
  expect(() => service.update(o.id, { notes: "edit" }, { expectedVersion: 100 })).toThrow("version conflict");
  expect(() => service.update(o.id, { economics: { price: Infinity } } as any)).toThrow("Invalid economics");
  expect(() => service.update(o.id, { economics: JSON.parse('{"__proto__":{"polluted":true}}') })).toThrow("key");
  for (const url of ["javascript:alert(1)", "http://localhost/path", "http://127.0.0.1/p", "http://10.0.0.2/p", "https://user:pass@example.com/p"]) {
    expect(() => service.addResearch(o.id, { sources: [{ url, excerpt: "x", access: "opened" }] }, { actor: "user" })).toThrow("URL");
  }
  expect(() => service.addResearch(o.id, { sources: [{ url: "https://example.com/p", excerpt: "x", access: "opened", fetchedAt: START + DAY }] }, { actor: "user" })).toThrow("fetchedAt");
  const p = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  expect(() => service.recordExperiment(o.id, p.experiments[0].id, result({ successes: 7 }), { actor: "user" })).toThrow("successes");
  expect(() => service.recordExperiment(o.id, p.experiments[0].id, result({ evidenceReference: "  " }), { actor: "user" })).toThrow("required");
  expect(() => service.recordExperiment(o.id, p.experiments[0].id, result({ observedAt: START - 1 }), { actor: "user" })).toThrow("after");
  expect(service.get(o.id)?.version).toBe(p.version);
  service.close();
});

test("safe loads skip corrupt rows without losing intact dossiers", () => {
  const { service, o, file, now } = setup(); service.close();
  const db = new Database(file);
  db.prepare("INSERT INTO opportunities(id,version,updated_at,data) VALUES(?,?,?,?)").run("bad-json", 1, START + 1, "{broken");
  db.prepare("INSERT INTO opportunities(id,version,updated_at,data) VALUES(?,?,?,?)").run("bad-shape", 1, START + 1, '{"id":"bad-shape","version":1,"title":"shape"}');
  db.close();
  const reopened = createOpportunities({ file, now });
  expect(reopened.list().map(x => x.id)).toEqual([o.id]); expect(reopened.get("bad-json")).toBeUndefined();
  expect(reopened.list({ mode: "assets" })).toEqual([]); expect(reopened.list({ industry: "construction" })).toHaveLength(1);
  reopened.close();
});


test("old published customer reports are stale even after a fresh retrieval", () => {
  const { service, o } = setup(); const input = research();
  input.sources![0].publishedAt = START - 120 * DAY;
  input.sources![1].publishedAt = START - 120 * DAY;
  const current = service.addResearch(o.id, input, { actor: "user" });
  expect(current.readiness.independentGroups).toBe(0); expect(current.stage).toBe("concept");
  expect(current.claims.every(c => c.status === "inferred")).toBe(true);
  service.close();
});

test("retention cannot claim an unelapsed observation window or a different paying segment", () => {
  const { service, o, advance } = setup();
  const paid = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  service.recordExperiment(o.id, paid.experiments[0].id, result(), { actor: "user" });
  const repeat = service.addExperiment(o.id, { ...plan("repeat-use"), segment: "Unrelated travel agencies" }, { actor: "user" });
  expect(() => service.recordExperiment(o.id, repeat.experiments[1].id, result({ repeatCustomers: 2, repeatPayments: 2, windowDays: 30 }), { actor: "user" })).toThrow("elapsed");
  advance(30);
  const otherSegment = service.recordExperiment(o.id, repeat.experiments[1].id, result({ repeatCustomers: 2, repeatPayments: 2, windowDays: 30 }), { actor: "user" });
  expect(otherSegment.stage).toBe("paid-pilot");
  expect(otherSegment.experiments[1].result?.outcome).toBe("pass");
  service.close();
});


test("reviewed empty or invalid financial objects cannot count as completed economic homework", () => {
  for (const economics of [{ foo: 1 }, { pricePerCustomer: null }, { ...economicsFixture(), monthlyChurn: 2 }]) {
    const { service, o } = setup();
    service.update(o.id, { economics });
    const reviewed = service.addResearch(o.id, research(), { actor: "user" });
    expect(reviewed.stage).toBe("concept");
    expect(reviewed.readiness.missing.some(s => s.includes("economics homework"))).toBe(true);
    service.close();
  }
});


test("retrieval refresh preserves owner interpretations and classification even when a quote changes", () => {
  const { service, o } = setup();
  service.addResearch(o.id, research(), { actor: "user" });
  service.addResearch(o.id, { claims: [{ id: "p1", text: "This is a rare administrative exception", dimension: "problem", status: "contradicted", supportingSourceIds: ["c1"], notes: "Owner interview refutes generalizing this report" }] }, { actor: "user" });
  const refreshed = service.addResearch(o.id, { sources: [{ id: "c1", url: "https://roofingassociation.org/crew-one", excerpt: "Updated post says the crew solved its administrative exception", access: "opened", kind: "other" }],
    claims: [{ id: "p1", text: "Public source reports: Updated post says the crew solved its administrative exception", dimension: "problem", status: "observed", supportingSourceIds: ["c1"] }] }, { actor: "retrieval" });
  expect(refreshed.claims[0]).toMatchObject({ status: "contradicted", checkedBy: null, notes: "Owner interview refutes generalizing this report" });
  expect(refreshed.sources[0].kind).toBe("customer");
  expect(refreshed.sources[0].independenceGroup).toBe("crew-one");
  expect(refreshed.stage).toBe("concept");
  service.close();
});

test("pivoting the buyer, problem or mechanism does not transfer historical paid evidence", () => {
  const { service, o } = setup();
  const planned = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  const paid = service.recordExperiment(o.id, planned.experiments[0].id, result(), { actor: "user" });
  expect(paid.stage).toBe("paid-pilot");
  const pivot = service.update(o.id, { buyer: "Travel agencies" });
  expect(pivot.stage).toBe("concept"); expect(pivot.experiments).toHaveLength(1);
  expect(pivot.experiments[0].result?.revenue).toBe(198);
  expect(pivot.experiments[0].context.buyer).toBe(o.buyer);
  expect(service.history(o.id).some(h => h.stage === "paid-pilot")).toBe(true);
  service.close();
});


test("paid criteria count successful paying customers instead of unrelated target actions", () => {
  const { service, o } = setup();
  const planned = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  const recorded = service.recordExperiment(o.id, planned.experiments[0].id, result({ successes: 4, payingCustomers: 1, revenue: 99 }), { actor: "user" });
  expect(recorded.experiments[0].result).toMatchObject({ outcome: "fail", qualifyingSuccesses: 1, successMetric: "successful paying customers" });
  expect(recorded.stage).toBe("concept");
  service.close();
});

test("retention criteria require distinct returning payers, not visits or repeated charges to one buyer", () => {
  const { service, o, advance } = setup();
  const pilot = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  service.recordExperiment(o.id, pilot.experiments[0].id, result(), { actor: "user" });
  const repeated = service.addExperiment(o.id, plan("repeat-use"), { actor: "user" });
  advance(30);
  expect(() => service.recordExperiment(o.id, repeated.experiments[1].id, result({ successes: 5, repeatCustomers: 5, payingCustomers: 1, repeatPayments: 5, windowDays: 30 }), { actor: "user" })).toThrow("returning customers who paid again");
  const recorded = service.recordExperiment(o.id, repeated.experiments[1].id, result({ successes: 5, repeatCustomers: 5, payingCustomers: 1, repeatPayments: 1, windowDays: 30 }), { actor: "user" });
  expect(recorded.experiments[1].result).toMatchObject({ outcome: "fail", qualifyingSuccesses: 1 });
  expect(recorded.stage).toBe("paid-pilot");
  service.close();
});


test("reloading recalculates outcome flags under current payment thresholds", () => {
  const { service, o, file, now } = setup();
  const planned = service.addExperiment(o.id, plan("paid-pilot"), { actor: "user" });
  service.recordExperiment(o.id, planned.experiments[0].id, result({ successes: 4, payingCustomers: 1, revenue: 99 }), { actor: "user" });
  service.close();
  const db = new Database(file);
  const row = db.prepare("SELECT data FROM opportunities WHERE id = ?").get(o.id) as { data: string };
  const saved = JSON.parse(row.data);
  saved.experiments[0].result.outcome = "pass";
  saved.experiments[0].result.qualifyingSuccesses = 4;
  saved.stage = "paid-pilot";
  db.prepare("UPDATE opportunities SET data = ? WHERE id = ?").run(JSON.stringify(saved), o.id);
  const reopened = createOpportunities({ file, now });
  expect(reopened.get(o.id)?.stage).toBe("concept");
  expect(reopened.get(o.id)?.experiments[0].result).toMatchObject({ outcome: "fail", qualifyingSuccesses: 1 });
  reopened.close();
  saved.experiments[0].result.denominator = -1;
  db.prepare("UPDATE opportunities SET data = ? WHERE id = ?").run(JSON.stringify(saved), o.id);
  db.close();
  const malformed = createOpportunities({ file, now });
  expect(malformed.get(o.id)).toBeUndefined();
  malformed.close();
});


test("financial citations stay current and invalidate review even when omitted from review references", () => {
  const { service, o, advance } = setup();
  const financials = { ...economicsFixture(), pricePerCustomer: { value: 99, basis: "observed", sourceIds: ["alt"], observedAt: "2026-09-26" } };
  service.update(o.id, { economics: financials });
  const ready = service.addResearch(o.id, research(), { actor: "user" });
  expect(ready.stage).toBe("research-ready");
  expect(ready.reviews.find(r => r.dimension === "economics")?.sourceIds).toEqual([]);
  const changed = service.addResearch(o.id, { sources: [{ id: "alt", url: "https://workflowvendor.com/pricing", excerpt: "The price has changed to $199", access: "opened", kind: "competitor" }] }, { actor: "retrieval" });
  expect(changed.reviews.find(r => r.dimension === "economics")?.reviewedBy).toBeNull();
  expect(changed.stage).toBe("concept");
  expect(changed.economics?.pricePerCustomer).toEqual(financials.pricePerCustomer);
  service.addResearch(o.id, { reviews: [{ dimension: "economics", sourceIds: [], notes: "Explicitly reviewed price discrepancy; keeping a $99 test scenario" }] }, { actor: "user" });
  advance(31);
  expect(service.get(o.id)?.readiness.missing).toContain("Check current financial evidence for pricePerCustomer: alt");
  service.update(o.id, { economics: { ...financials, pricePerCustomer: { value: 99, basis: "observed", sourceIds: ["unopened-price-page"] } } });
  expect(service.get(o.id)?.readiness.missing).toContain("Check current financial evidence for pricePerCustomer: unopened-price-page");
  service.close();
});
