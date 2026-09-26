import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createOpportunityService, generationPrompt, leadsEvidence, opportunityIdentity } from "../src/opportunity-service";
import { INDUSTRIES } from "../src/opportunities";

const disposables: (() => void)[] = [];
afterEach(() => { for (const f of disposables.splice(0).reverse()) f(); });
const now = Date.UTC(2026, 8, 26, 12);
function setup(over: Record<string, any> = {}) {
  const dir = mkdtempSync(`${tmpdir()}/opportunity-service-`);
  disposables.push(() => rmSync(dir, { recursive: true, force: true }));
  const service = createOpportunityService({ dir, now: () => now, pollMs: 1, runModel: async () => { throw new Error("Model unavailable"); }, ...over });
  disposables.push(() => service.close());
  return { ...service, dir };
}
const input = () => ({ title: "Closeout packets", buyer: "Small electrical contractors", problem: "Completion photos are scattered across chat messages", mode: "markets", industry: INDUSTRIES[0].id });
async function settled(s: ReturnType<typeof setup>, id: string) {
  for (let i = 0; i < 300; i++) {
    const r = await s.handle("/api/opportunities/status", { job: id });
    if (["done", "error", "cancelled"].includes(r.job?.state)) return r;
    await Bun.sleep(5);
  }
  throw new Error("Job did not settle");
}
const publicResult = () => ({ at: now, done: true, evidence: [{ url: "https://example.org/posts/1", title: "Job photos", snippet: "I spend an hour assembling completion photos after every installation.", at: now - 86400000 }], sources: { hn: { state: "ok", n: 1 }, reddit: { state: "error", n: 0, error: "rate limited" } }, apps: [] });

describe("opportunity jobs and trust boundaries", () => {
  test("opening the shortlist never invokes research or a model", async () => {
    let calls = 0;
    const s = setup({ runModel: async () => { calls++; }, research: async () => { calls++; } });
    const r = await s.handle("/api/opportunities", {});
    expect(r.items).toEqual([]); expect(calls).toBe(0);
    expect(r.industries.length).toBeGreaterThan(5);
  });
  test("model claims and invented proof are discarded during generation", async () => {
    const s = setup({ runModel: async () => ({ model: "fixture", text: JSON.stringify({ opportunities: [{ ...input(), stage: "paid-pilot", summary: "Completion packet", claims: [{ status: "observed", text: "Proven demand" }], sources: [{ url: "https://invented.example/proof" }], economics: { pricePerCustomer: 999 }, unknowns: ["Will the owner pay?"], revenue: { valuePattern: "episodic" } }] }) }) });
    await expect(s.handle("/api/opportunities/generate", { mode: "markets", industry: INDUSTRIES[0].id })).rejects.toThrow("Confirm");
    const { job } = await s.handle("/api/opportunities/generate", { mode: "markets", industry: INDUSTRIES[0].id, consent: true });
    const r = await settled(s, job.id);
    expect(r.job.state).toBe("done"); expect(r.items).toHaveLength(1);
    expect(r.items[0].stage).toBe("concept"); expect(r.items[0].sources).toHaveLength(0);
    expect(r.items[0].economics).toBeFalsy();
  });
  test("open-market mode does not leak inventory into its prompt", () => {
    expect(generationPrompt("markets", "Construction", "SECRET_PROJECT").user).not.toContain("SECRET_PROJECT");
    expect(generationPrompt("novel", "Construction").user).toContain("never claim the product does not exist");
  });
  test("real retrieval remains a public self-report with incomplete coverage, not validated demand", async () => {
    const queries: string[] = [];
    const s = setup({ research: async (q: string) => { queries.push(q); return { done: true, result: publicResult() }; } });
    const { item } = await s.handle("/api/opportunities/create", input());
    const { job } = await s.handle("/api/opportunities/research", { id: item.id, consent: true });
    const r = await settled(s, job.id);
    expect(r.job.state).toBe("done"); expect(queries.length).toBeLessThanOrEqual(2);
    const saved = (await s.handle("/api/opportunities/item", { id: item.id })).item;
    expect(saved.sources).toHaveLength(1); expect(saved.stage).toBe("concept");
    expect(saved.readiness.ready).toBe(false); expect(saved.unknowns.join(" ")).toContain("reddit");
  });
  test("total source failure is surfaced and cannot promote a dossier", async () => {
    const s = setup({ research: async () => ({ done: true, result: { at: now, evidence: [], apps: [], sources: { hn: { state: "error", error: "offline" } } } }) });
    const { item } = await s.handle("/api/opportunities/create", input());
    const { job } = await s.handle("/api/opportunities/research", { id: item.id, consent: true });
    expect((await settled(s, job.id)).job.state).toBe("error");
    expect(s.store.get(item.id)?.stage).toBe("concept");
  });
  test("cancellation discards late model output", async () => {
    let finish: any;
    const s = setup({ runModel: () => new Promise((resolve) => { finish = resolve; }) });
    const { job } = await s.handle("/api/opportunities/generate", { mode: "markets", industry: INDUSTRIES[0].id, consent: true });
    for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(2);
    await s.handle("/api/opportunities/cancel", { job: job.id });
    finish({ model: "fixture", text: JSON.stringify({ opportunities: [input()] }) });
    await Bun.sleep(15);
    expect(s.store.list()).toHaveLength(0);
    expect((await settled(s, job.id)).job.state).toBe("cancelled");
  });
  test("invalid economics is rejected and calculation alone never saves", async () => {
    const s = setup(); const { item } = await s.handle("/api/opportunities/create", input());
    await expect(s.handle("/api/opportunities/update", { id: item.id, patch: { economics: { monthlyChurn: 2 } } })).rejects.toThrow();
    await s.handle("/api/opportunities/calculate", { economics: { pricePerCustomer: 99 } });
    expect(s.store.get(item.id)?.economics).toBeFalsy();
  });
  test("owner attestation is explicit and a body actor cannot bypass it", async () => {
    const s = setup(); const { item } = await s.handle("/api/opportunities/create", input());
    await expect(s.handle("/api/opportunities/evidence", { id: item.id, actor: "user", research: {} })).rejects.toThrow("Confirm");
  });
  test("private strings are removed from external queries", async () => {
    const queries: string[] = [];
    const s = setup({ research: async (q: string) => { queries.push(q); return { done: true, result: publicResult() }; } });
    const { item } = await s.handle("/api/opportunities/create", { ...input(), problem: "Pictures /Users/alice/private/work.csv alice@example.com sk-abcdefghijklmnopqrstuv" });
    const { job } = await s.handle("/api/opportunities/research", { id: item.id, consent: true });
    await settled(s, job.id);
    expect(queries.join(" ")).not.toMatch(/alice|private\/work|sk-abc/);
  });
  test("duplicate source text has the same independence group and original fetch time", () => {
    const r: any = publicResult(); r.evidence.push({ ...r.evidence[0], url: "https://another.example/copy" });
    const out = leadsEvidence(r, now + 1000);
    expect(out.sources[0].independenceGroup).toBe(out.sources[1].independenceGroup);
    expect(out.sources[0].fetchedAt).toBe(now);
  });
});


test("a stalled provider times out and late output cannot write", async () => {
  let finish: any;
  const s = setup({ timeoutMs: 15, runModel: () => new Promise(resolve => { finish = resolve; }) });
  const { job } = await s.handle("/api/opportunities/generate", { mode: "markets", industry: INDUSTRIES[0].id, consent: true });
  const r = await settled(s, job.id);
  expect(r.job.state).toBe("error");
  expect(r.job.error).toContain("time limit");
  finish({ text: JSON.stringify({ opportunities: [input()] }), model: "fixture" });
  await Bun.sleep(10);
  expect(s.store.list()).toHaveLength(0);
});

test("restart exposes interrupted jobs for an explicit retry", async () => {
  const s = setup();
  writeFileSync(`${s.dir}/opportunity-jobs.json`, JSON.stringify([{ id: "interrupted", kind: "generate", state: "running", message: "Running", input: { mode: "markets", industry: INDUSTRIES[0].id }, itemIds: [], startedAt: now }]));
  const recovered = createOpportunityService({ dir: s.dir, now: () => now });
  disposables.push(() => recovered.close());
  const state = await recovered.handle("/api/opportunities/status", { job: "interrupted" });
  expect(state.job.state).toBe("error"); expect(state.job.error).toContain("restart");
  await expect(recovered.handle("/api/opportunities/retry", { job: "interrupted" })).rejects.toThrow("Confirm");
});

test("different names for the same buyer/job/mechanism deduplicate independently of stack", () => {
  const a = { ...input(), mechanism: "Collect photos into completion packets" };
  expect(opportunityIdentity(a)).toBe(opportunityIdentity({ ...a, title: "Different product name", ids: ["another stack"] }));
  expect(opportunityIdentity(a)).not.toBe(opportunityIdentity({ ...a, mechanism: "Predict job delays before scheduling" }));
});

test("distinct reviews on the same listing retain separate source identities", () => {
  const r: any = publicResult(); r.evidence[0].id = "review-1";
  r.evidence.push({ ...r.evidence[0], id: "review-2", snippet: "Our crews lose the photo attachments." });
  const out = leadsEvidence(r, now);
  expect(out.sources).toHaveLength(2); expect(out.sources[0].id).not.toBe(out.sources[1].id);
  expect(out.claims[0].id).not.toBe(out.claims[1].id);
});


test("deep research preserves access receipts but cannot assert observed demand", async () => {
  let args: any;
  const s = setup({ deepResearch: async (input: any) => {
    args = input;
    return { sources: [{ id: "web-1", url: "https://example.org/pricing", excerpt: "Listed price is $20", kind: "competitor", access: "opened" }], claims: [{ text: "Proven demand", dimension: "problem", status: "observed", supportingSourceIds: ["web-1"] }], unknowns: ["Who will actually pay?"], searches: [{ query: "competitors", scope: "public search", result: "one source" }] };
  } });
  const { item } = await s.handle("/api/opportunities/create", input());
  const { job } = await s.handle("/api/opportunities/research", { id: item.id, deep: true, consent: true });
  expect((await settled(s, job.id)).job.state).toBe("done");
  const saved = s.store.get(item.id)!;
  expect(args.signal).toBeInstanceOf(AbortSignal); expect(args.timeoutMs).toBeLessThan(150000);
  expect(saved.sources[0].access).toBe("opened"); expect(saved.claims[0].status).toBe("inferred");
  expect(saved.claims[0].checkedBy).toBe(null); expect(saved.stage).toBe("concept");
});

test("deep research with no opened sources reports coverage failure and saves gaps", async () => {
  const s = setup({ deepResearch: async () => ({ sources: [], claims: [], unknowns: ["No sources could be read"], searches: [] }) });
  const { item } = await s.handle("/api/opportunities/create", input());
  const { job } = await s.handle("/api/opportunities/research", { id: item.id, deep: true, consent: true });
  expect((await settled(s, job.id)).job.state).toBe("error");
  expect(s.store.get(item.id)!.unknowns).toContain("No sources could be read");
});

test("a changed hypothesis cannot receive late research for the previous buyer", async () => {
  let finish: any;
  const s = setup({ deepResearch: () => new Promise(resolve => { finish = resolve; }) });
  const { item } = await s.handle("/api/opportunities/create", input());
  const { job } = await s.handle("/api/opportunities/research", { id: item.id, deep: true, consent: true });
  for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(2);
  await s.handle("/api/opportunities/update", { id: item.id, patch: { buyer: "A different buyer" } });
  finish({ sources: [{ url: "https://example.org/old", excerpt: "Old buyer problem", access: "opened" }], claims: [], searches: [], unknowns: [] });
  const r = await settled(s, job.id);
  expect(r.job.state).toBe("error"); expect(r.job.error).toContain("hypothesis changed");
  expect(s.store.get(item.id)!.sources).toHaveLength(0);
});

test("manual concepts do not receive an assumed subscription recommendation", async () => {
  const s = setup(); const { item } = await s.handle("/api/opportunities/create", input());
  expect(item.revenueRecommendation.primary).toBe(null);
});

test("recording demand results requires explicit owner attestation", async () => {
  const s = setup(); const { item } = await s.handle("/api/opportunities/create", input());
  await expect(s.handle("/api/opportunities/experiment/result", { id: item.id, experimentId: "unknown", result: {}, actor: "user" })).rejects.toThrow("Confirm these are actual");
});
