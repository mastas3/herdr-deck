// Research and customer outcomes stay separate from generated pitches. Only people can attest review.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { calculateEconomics } from "./economics";

export const DISCOVERY_MODES = [
  { id: "assets", label: "Use my advantages" }, { id: "markets", label: "Explore new markets" }, { id: "novel", label: "Novel solutions" },
] as const;
export const INDUSTRIES = [
  { id: "construction", label: "Construction and trades" }, { id: "property", label: "Property operations" },
  { id: "logistics", label: "Logistics and field service" }, { id: "manufacturing", label: "Manufacturing and quality" },
  { id: "retail", label: "Retail and returns" }, { id: "hospitality", label: "Hospitality and events" },
  { id: "education", label: "Adult education and training" }, { id: "creators", label: "Creator operations" },
  { id: "professional-services", label: "Professional-service administration" }, { id: "household", label: "Household coordination" },
  { id: "accessibility", label: "Accessibility and language" }, { id: "developer", label: "Developer infrastructure" },
  { id: "other", label: "Other markets" },
] as const;
export const DIMENSIONS = ["buyer", "problem", "alternatives", "distribution", "feasibility", "economics"] as const;
export const OPPORTUNITY_STAGES = ["concept", "research-ready", "buying-signal", "paid-pilot", "repeat-use"] as const;
export type DiscoveryMode = typeof DISCOVERY_MODES[number]["id"];
export type OpportunityStage = typeof OPPORTUNITY_STAGES[number];
export type ResearchDimension = typeof DIMENSIONS[number];
export type ClaimStatus = "observed" | "inferred" | "assumed" | "unknown" | "contradicted";
type Actor = "model" | "retrieval" | "user";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type EvidenceSource = {
  id: string; url: string; title: string; publisher: string; publishedAt: number | null; fetchedAt: number;
  excerpt: string; independenceGroup: string; access: "opened" | "failed" | "unverified";
  kind: "customer" | "competitor" | "documentation" | "other"; error: string; checkedBy: "user" | "retrieval" | null; ownerEdited: boolean;
};
export type OpportunityClaim = {
  id: string; text: string; dimension: ResearchDimension; status: ClaimStatus; supportingSourceIds: string[];
  opposingSourceIds: string[]; material: boolean; notes: string; maxAgeDays: number; checkedBy: "user" | "retrieval" | null; ownerEdited: boolean;
};
export type ResearchReview = { dimension: ResearchDimension; sourceIds: string[]; notes: string; reviewedAt: number; reviewedBy: "user" | null };
export type ResearchSearch = { query: string; searchedAt: number; scope: string; result: string };
export type ExperimentKind = "buying-signal" | "paid-pilot" | "repeat-use";
export type ExperimentCriteria = { minParticipants: number; minSuccesses: number; minSuccessRate?: number; minNetRevenue?: number; minRepeatCustomers?: number };
export type ExperimentResult = {
  denominator: number; successes: number; payingCustomers: number; revenue: number; refunds: number; repeatCustomers: number;
  /** v1 API name: distinct returning customers who paid again, never transaction count. */
  repeatPayments: number; windowDays: number; evidenceReference: string; notes: string; observedAt: number;
  recordedAt: number; recordedBy: "user"; outcome: "pass" | "fail" | "inconclusive";
  qualifyingSuccesses: number; successMetric: string;
};
export type OpportunityExperiment = {
  id: string; kind: ExperimentKind; hypothesis: string; segment: string; channel: string; offer: string;
  successCriteria: ExperimentCriteria; failureCriteria: string; budget: number; currency: string;
  startsAt: number; endsAt: number | null; createdAt: number; result: ExperimentResult | null;
  context: Pick<Opportunity, "buyer" | "problem" | "mechanism">;
};
export type Opportunity = {
  id: string; version: number; title: string; summary: string; buyer: string; problem: string; outcome: string; mechanism: string;
  mode: DiscoveryMode; industry: typeof INDUSTRIES[number]["id"]; notes: string; stage: OpportunityStage;
  sources: EvidenceSource[]; claims: OpportunityClaim[]; reviews: ResearchReview[]; searches: ResearchSearch[];
  unknowns: string[]; experiments: OpportunityExperiment[]; economics: JsonObject | null; revenue: JsonObject | null;
  readiness: { ready: boolean; missing: string[]; independentGroups: number; policy: string };
  createdAt: number; updatedAt: number; legacyId?: string;
};
export type OpportunityInput = {
  id?: string; title: string; summary?: string; buyer?: string; problem?: string; outcome?: string; mechanism?: string;
  mode?: DiscoveryMode; industry?: Opportunity["industry"]; notes?: string; economics?: JsonObject | null; revenue?: JsonObject | null;
};
export type OpportunityPatch = Partial<Omit<OpportunityInput, "id">>;
export type ResearchInput = {
  sources?: Array<Partial<EvidenceSource> & Pick<EvidenceSource, "url" | "excerpt">>;
  claims?: Array<Partial<OpportunityClaim> & Pick<OpportunityClaim, "text" | "dimension" | "status">>;
  reviews?: Array<Partial<ResearchReview> & Pick<ResearchReview, "dimension" | "sourceIds" | "notes">>;
  searches?: Array<Partial<ResearchSearch> & Pick<ResearchSearch, "query" | "scope" | "result">>;
  unknowns?: string[];
};
export type ExperimentInput = {
  kind: ExperimentKind; hypothesis: string; segment: string; channel: string; offer: string; successCriteria: ExperimentCriteria;
  failureCriteria: string; budget?: number; currency?: string; startsAt?: number; endsAt?: number;
};
export type ExperimentResultInput = Pick<ExperimentResult, "denominator" | "successes" | "evidenceReference"> & Partial<Pick<ExperimentResult,
  "payingCustomers" | "revenue" | "refunds" | "repeatCustomers" | "repeatPayments" | "windowDays" | "notes" | "observedAt">>;

const DAY = 86_400_000;
const MAX_ITEMS = 200;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const idOf = (v: unknown, name = "id"): string => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,159}$/.test(v)) throw new Error(`Invalid ${name}`);
  return v;
};
function str(v: unknown, name: string, max = 5000, required = false): string {
  if (v === undefined || v === null) { if (required) throw new Error(`${name} is required`); return ""; }
  if (typeof v !== "string" || v.length > max) throw new Error(`Invalid ${name}`);
  const s = v.trim(); if (required && !s) throw new Error(`${name} is required`); return s;
}
function num(v: unknown, name: string, min: number, max: number, fallback?: number, integer = false): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error(`Invalid ${name}`);
  return v;
}
function choice<T extends string>(v: unknown, choices: readonly T[], name: string, fallback?: T): T {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !choices.includes(v as T)) throw new Error(`Invalid ${name}`);
  return v as T;
}
function obj(v: unknown, name: string): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`Invalid ${name}`);
  return v as Record<string, any>;
}
function array(v: unknown, name: string, max = MAX_ITEMS): any[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Invalid ${name}`); return v;
}
function keys(v: object, allowed: string[], name: string) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error(`Unsupported ${name} field: ${k}`);
}
function timestamp(v: unknown, name: string, now: number, fallback = now): number { return num(v, name, 0, now + 300_000, fallback, true); }
/** Only public HTTP(S) references: the research fetcher applies its own DNS/redirect restrictions. */
function sourceUrl(v: unknown): string {
  const raw = str(v, "source URL", 2048, true); let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Invalid source URL"); }
  const host = u.hostname.toLowerCase();
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || !host.includes(".") ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(host) || /^(172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    /\.(localhost|local|internal|test)$/.test(host) || /(^|\.)localhost$/.test(host)) throw new Error("Source URL must be public HTTP(S)");
  u.hash = ""; return u.href;
}
function refs(v: unknown, name: string): string[] { return [...new Set(array(v ?? [], name).map(x => idOf(x, name)))]; }
function jsonObject(v: unknown, name: string): JsonObject | null {
  if (v === null) return null;
  obj(v, name); let count = 0;
  const walk = (x: unknown, depth: number): JsonValue => {
    if (++count > 6000 || depth > 12) throw new Error(`${name} is too large`);
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "string") return str(x, name, 10000);
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (Array.isArray(x)) return array(x, name, 1000).map(y => walk(y, depth + 1));
    const o = obj(x, name); const out: JsonObject = {};
    for (const [k, y] of Object.entries(o)) {
      if (["__proto__", "constructor", "prototype"].includes(k) || k.length > 100) throw new Error(`Invalid ${name} key`);
      out[k] = walk(y, depth + 1);
    }
    return out;
  };
  return walk(v, 0) as JsonObject;
}
function hostGroup(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); const parts = host.split(".");
  return parts.slice(-(/\.(co|com|org|gov|ac)\.[a-z]{2}$/.test(host) ? 3 : 2)).join(".");
}
const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();
function sourceCurrent(s: EvidenceSource | undefined, now: number, days = 90): s is EvidenceSource {
  return !!s && s.access === "opened" && !!s.checkedBy && !!s.excerpt && s.fetchedAt <= now + 300_000 && now - s.fetchedAt <= days * DAY &&
    (s.kind !== "customer" || s.publishedAt === null || now - s.publishedAt <= days * DAY);
}
/** A syndicated excerpt or repeated publisher counts once, even with different user-supplied groups. */
function independentGroups(sources: EvidenceSource[]): number {
  const components = sources.map((_, i) => i);
  const root = (i: number): number => components[i] === i ? i : (components[i] = root(components[i]));
  for (let i = 0; i < sources.length; i++) for (let j = 0; j < i; j++) {
    const a = sources[i], b = sources[j];
    if (hostGroup(a.url) === hostGroup(b.url) || a.independenceGroup === b.independenceGroup || normalizeText(a.excerpt) === normalizeText(b.excerpt)) components[root(i)] = root(j);
  }
  return new Set(components.map((_, i) => root(i))).size;
}
function derive(o: Opportunity, now: number): Opportunity {
  const missing: string[] = [];
  const sourceMap = new Map(o.sources.map(s => [s.id, s]));
  const usable = (id: string, days = 90) => sourceCurrent(sourceMap.get(id), now, days);
  if (!o.buyer) missing.push("Name the customer and budget owner");
  if (!o.problem) missing.push("Describe the customer problem");
  if (!o.mechanism) missing.push("Describe the proposed product mechanism");
  const customerIds = new Set<string>();
  for (const claim of o.claims) {
    if (claim.material && claim.status === "contradicted") missing.push(`Resolve contradicted claim: ${claim.text}`);
    if (claim.material && claim.status === "unknown") missing.push(`Investigate material unknown: ${claim.text}`);
    if (claim.material && claim.opposingSourceIds.some(id => usable(id, claim.maxAgeDays))) missing.push(`Review opposing evidence: ${claim.text}`);
    if (claim.checkedBy && ["observed", "inferred"].includes(claim.status) && ["buyer", "problem"].includes(claim.dimension)) {
      for (const id of claim.supportingSourceIds) if (usable(id, claim.maxAgeDays) && sourceMap.get(id)?.kind === "customer") customerIds.add(id);
    }
  }
  const independent = independentGroups([...customerIds].map(id => sourceMap.get(id)!));
  if (independent < 2) missing.push("Check current customer evidence from at least 2 independent groups (screening policy)");
  for (const dimension of DIMENSIONS) {
    const days = ["alternatives", "feasibility", "economics"].includes(dimension) ? 30 : 90;
    const review = o.reviews.find(r => r.dimension === dimension);
    if (!review || review.reviewedBy !== "user" || now - review.reviewedAt > days * DAY || !review.notes ||
      !review.sourceIds.every(id => usable(id, days)) || (dimension !== "economics" && !review.sourceIds.length)) {
      missing.push(`Review ${dimension} with current supporting evidence`);
    }
  }
  const economics = calculateEconomics(o.economics ?? {});
  for (const [name, assumption] of Object.entries(economics.assumptions)) {
    for (const sourceId of assumption.sourceIds ?? []) if (!usable(sourceId, 30)) missing.push(`Check current financial evidence for ${name}: ${sourceId}`);
  }
  if (economics.errors.length || economics.missingInputs.length || economics.unitEconomics.economicContribution === null || economics.projection.endingCash === null) {
    missing.push(`Complete the economics homework${economics.errors.length ? `: ${economics.errors.join("; ")}` : economics.missingInputs.length ? `: missing ${economics.missingInputs.join(", ")}` : ": unit contribution or cash projection cannot be computed"}`);
  }
  const experiments = o.experiments.filter(e => e.result?.recordedBy === "user" && e.result.outcome === "pass" &&
    e.context?.buyer === o.buyer && e.context?.problem === o.problem && e.context?.mechanism === o.mechanism);
  const pilot = experiments.some(e => e.kind === "paid-pilot" && e.result!.payingCustomers > 0 && e.result!.revenue > e.result!.refunds);
  const repeat = pilot && experiments.some(e => e.kind === "repeat-use" && e.result!.repeatCustomers > 0 && e.result!.repeatPayments > 0 && e.result!.windowDays > 0 && e.result!.revenue > e.result!.refunds &&
    experiments.some(p => p.kind === "paid-pilot" && p.segment === e.segment && p.result!.payingCustomers > 0 && p.result!.revenue > p.result!.refunds &&
      p.result!.observedAt <= e.startsAt && e.result!.observedAt - p.result!.observedAt >= e.result!.windowDays * DAY));
  o.readiness = { ready: missing.length === 0, missing: [...new Set(missing)], independentGroups: independent,
    policy: "Two independent current customer evidence groups and human review of six dimensions. This is a screening policy, not proof of sales." };
  o.stage = repeat ? "repeat-use" : pilot ? "paid-pilot" : experiments.some(e => e.kind === "buying-signal") ? "buying-signal" : o.readiness.ready ? "research-ready" : "concept";
  return o;
}

function baseInput(input: unknown, partial = false): OpportunityPatch & { id?: string } {
  const x = obj(input, "opportunity");
  keys(x, ["id", "title", "summary", "buyer", "problem", "outcome", "mechanism", "mode", "industry", "notes", "economics", "revenue"], "opportunity");
  if (partial && own(x, "id")) throw new Error("Opportunity IDs are immutable");
  const out: any = {};
  if (own(x, "id")) out.id = idOf(x.id);
  for (const k of ["title", "summary", "buyer", "problem", "outcome", "mechanism", "notes"]) {
    if (!partial || own(x, k)) out[k] = str(x[k], k, k === "title" ? 240 : 10000, k === "title");
  }
  if (!partial || own(x, "mode")) out.mode = choice(x.mode, DISCOVERY_MODES.map(m => m.id), "mode", "markets");
  if (!partial || own(x, "industry")) out.industry = choice(x.industry, INDUSTRIES.map(m => m.id), "industry", "other");
  for (const k of ["economics", "revenue"]) if (own(x, k)) out[k] = jsonObject(x[k], k);
  return out;
}
function sourceInput(input: unknown, actor: Actor, now: number): EvidenceSource {
  const x = obj(input, "source"), url = sourceUrl(x.url);
  const access = choice(x.access, ["opened", "failed", "unverified"] as const, "source access", "unverified");
  const checkedBy = actor !== "model" && access === "opened" ? actor : null;
  const fetchedAt = timestamp(x.fetchedAt, "fetchedAt", now);
  const publishedAt = x.publishedAt === undefined || x.publishedAt === null ? null : timestamp(x.publishedAt, "publishedAt", now);
  if (publishedAt !== null && publishedAt > fetchedAt + 300_000) throw new Error("Publication date follows retrieval date");
  return { id: x.id === undefined ? `source-${crypto.randomUUID()}` : idOf(x.id, "source id"), url,
    title: str(x.title, "source title", 500), publisher: str(x.publisher, "publisher", 200), publishedAt, fetchedAt,
    excerpt: str(x.excerpt, "source excerpt", 10000, !!checkedBy), independenceGroup: str(x.independenceGroup, "independence group", 240) || hostGroup(url),
    access: actor === "model" && access === "opened" ? "unverified" : access,
    kind: choice(x.kind, ["customer", "competitor", "documentation", "other"] as const, "source kind", "other"),
    error: str(x.error, "source error", 1000), checkedBy, ownerEdited: actor === "user" };
}
function claimInput(input: unknown, actor: Actor, now: number, sources: EvidenceSource[]): OpportunityClaim {
  const x = obj(input, "claim"), text = str(x.text, "claim text", 5000, true);
  const supportingSourceIds = refs(x.supportingSourceIds, "supporting source id"), opposingSourceIds = refs(x.opposingSourceIds, "opposing source id");
  const sourceMap = new Map(sources.map(s => [s.id, s]));
  for (const id of [...supportingSourceIds, ...opposingSourceIds]) if (!sourceMap.has(id)) throw new Error(`Unknown source: ${id}`);
  const maxAgeDays = num(x.maxAgeDays, "maxAgeDays", 1, 365, 90, true);
  let status = choice(x.status, ["observed", "inferred", "assumed", "unknown", "contradicted"] as const, "claim status");
  const supported = supportingSourceIds.some(id => sourceCurrent(sourceMap.get(id), now, maxAgeDays));
  const exactRetrievedExcerpt = supportingSourceIds.some(id => {
    const s = sourceMap.get(id); return sourceCurrent(s, now, maxAgeDays) && s.checkedBy === "retrieval" &&
      [normalizeText(s.excerpt), `Public source reports: ${normalizeText(s.excerpt)}`].includes(normalizeText(text));
  });
  const checkedBy = actor === "user" ? "user" : actor === "retrieval" && exactRetrievedExcerpt ? "retrieval" : null;
  if (status === "observed" && (!supported || !checkedBy)) status = "inferred";
  if (x.material !== undefined && typeof x.material !== "boolean") throw new Error("Invalid material flag");
  return { id: x.id === undefined ? `claim-${crypto.randomUUID()}` : idOf(x.id, "claim id"), text,
    dimension: choice(x.dimension, DIMENSIONS, "claim dimension"), status, supportingSourceIds, opposingSourceIds,
    material: x.material !== false, notes: str(x.notes, "claim notes", 5000), maxAgeDays, checkedBy, ownerEdited: actor === "user" };
}
function experimentInput(input: unknown, now: number, context: OpportunityExperiment["context"]): OpportunityExperiment {
  const x = obj(input, "experiment");
  keys(x, ["kind", "hypothesis", "segment", "channel", "offer", "successCriteria", "failureCriteria", "budget", "currency", "startsAt", "endsAt"], "experiment");
  const c = obj(x.successCriteria, "success criteria");
  keys(c, ["minParticipants", "minSuccesses", "minSuccessRate", "minNetRevenue", "minRepeatCustomers"], "success criteria");
  const criteria: ExperimentCriteria = { minParticipants: num(c.minParticipants, "minimum participants", 1, 1e8, undefined, true),
    minSuccesses: num(c.minSuccesses, "minimum successes", 1, 1e8, undefined, true) };
  if (criteria.minSuccesses > criteria.minParticipants) throw new Error("Minimum successes exceed minimum participants");
  if (own(c, "minSuccessRate")) criteria.minSuccessRate = num(c.minSuccessRate, "minimum success rate", 0, 1);
  if (own(c, "minNetRevenue")) criteria.minNetRevenue = num(c.minNetRevenue, "minimum net revenue", 0, 1e12);
  if (own(c, "minRepeatCustomers")) criteria.minRepeatCustomers = num(c.minRepeatCustomers, "minimum repeat customers", 1, 1e8, undefined, true);
  const currency = str(x.currency ?? "USD", "currency", 3, true).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency");
  const startsAt = num(x.startsAt, "startsAt", now, now + 365 * DAY, now, true);
  const endsAt = x.endsAt === undefined ? null : num(x.endsAt, "endsAt", startsAt, now + 2 * 365 * DAY, undefined, true);
  return { id: `experiment-${crypto.randomUUID()}`, kind: choice(x.kind, ["buying-signal", "paid-pilot", "repeat-use"] as const, "experiment kind"),
    hypothesis: str(x.hypothesis, "hypothesis", 5000, true), segment: str(x.segment, "segment", 2000, true), channel: str(x.channel, "channel", 2000, true),
    offer: str(x.offer, "offer", 5000, true), successCriteria: criteria, failureCriteria: str(x.failureCriteria, "failure criteria", 3000, true),
    budget: num(x.budget, "budget", 0, 1e12, 0), currency, startsAt, endsAt, createdAt: now, result: null, context };
}
function resultInput(input: unknown, experiment: OpportunityExperiment, now: number): ExperimentResult {
  const x = obj(input, "experiment result");
  keys(x, ["denominator", "successes", "payingCustomers", "revenue", "refunds", "repeatCustomers", "repeatPayments", "windowDays", "evidenceReference", "notes", "observedAt"], "experiment result");
  const denominator = num(x.denominator, "denominator", 0, 1e8, undefined, true);
  const successes = num(x.successes, "successes", 0, denominator, undefined, true);
  const payingCustomers = num(x.payingCustomers, "paying customers", 0, denominator, 0, true);
  const repeatCustomers = num(x.repeatCustomers, "repeat customers", 0, denominator, 0, true);
  // Count distinct returning payers, not transactions: one buyer renewing repeatedly is still one buyer.
  const repeatPayments = num(x.repeatPayments, "returning customers who paid again", 0, Math.min(repeatCustomers, payingCustomers), 0, true);
  if (repeatPayments > 0 && (repeatCustomers === 0 || payingCustomers === 0)) throw new Error("Repeat payments require returning and paying customers");
  const revenue = num(x.revenue, "revenue", 0, 1e12, 0), refunds = num(x.refunds, "refunds", 0, revenue, 0);
  if (revenue > 0 && payingCustomers === 0) throw new Error("Revenue requires paying customers");
  const observedAt = timestamp(x.observedAt, "observedAt", now);
  if (observedAt < experiment.startsAt || observedAt < experiment.createdAt) throw new Error("Record results after the experiment plan and start date");
  const evidenceReference = str(x.evidenceReference, "evidence reference", 2000, true);
  if (/^https?:/i.test(evidenceReference)) sourceUrl(evidenceReference);
  const windowDays = num(x.windowDays, "observation window", 0, 3650, 0);
  if (windowDays * DAY > observedAt - experiment.startsAt) throw new Error("Observation window exceeds elapsed experiment time");
  const c = experiment.successCriteria, enough = denominator >= c.minParticipants;
  const behavioral = experiment.kind === "buying-signal" || (experiment.kind === "paid-pilot" ? payingCustomers > 0 && revenue > refunds :
    repeatCustomers > 0 && repeatPayments > 0 && windowDays > 0 && payingCustomers > 0 && revenue > refunds);
  const qualifyingSuccesses = experiment.kind === "paid-pilot" ? Math.min(successes, payingCustomers) : experiment.kind === "repeat-use" ? Math.min(successes, repeatPayments) : successes;
  const successMetric = experiment.kind === "paid-pilot" ? "successful paying customers" : experiment.kind === "repeat-use" ? "successful returning customers who paid again" : "successful target actions";
  const passed = enough && qualifyingSuccesses >= c.minSuccesses && qualifyingSuccesses / denominator >= (c.minSuccessRate ?? 0) &&
    revenue - refunds >= (c.minNetRevenue ?? 0) && repeatPayments >= (c.minRepeatCustomers ?? 0) && behavioral;
  return { denominator, successes, payingCustomers, repeatCustomers, repeatPayments, revenue, refunds, windowDays, evidenceReference,
    notes: str(x.notes, "result notes", 5000), observedAt, recordedAt: now, recordedBy: "user", qualifyingSuccesses, successMetric, outcome: !enough || denominator === 0 ? "inconclusive" : passed ? "pass" : "fail" };
}

export function createOpportunities(opts: { file: string; now?: () => number }) {
  const now = opts.now ?? Date.now;
  if (opts.file !== ":memory:") mkdirSync(dirname(opts.file), { recursive: true });
  const db = new Database(opts.file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS opportunities (id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS opportunity_versions (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, version));
    CREATE INDEX IF NOT EXISTS opportunities_updated ON opportunities(updated_at DESC);`);
  const select = db.prepare("SELECT data FROM opportunities WHERE id = ?");
  function decode(data: string): Opportunity | undefined {
    try {
      const o = obj(JSON.parse(data), "stored opportunity") as Opportunity;
      idOf(o.id); num(o.version, "stored version", 1, Number.MAX_SAFE_INTEGER, undefined, true);
      const basics = baseInput(Object.fromEntries(["title", "summary", "buyer", "problem", "outcome", "mechanism", "mode", "industry", "notes", "economics", "revenue"].map(k => [k, (o as any)[k]])));
      Object.assign(o, basics);
      for (const k of ["sources", "claims", "reviews", "searches", "unknowns", "experiments"] as const) array(o[k], `stored ${k}`);
      // Reject broken records instead of allowing one corrupt row to break the whole Discover page.
      for (const s of o.sources) { idOf(s.id); sourceUrl(s.url); str(s.excerpt, "stored excerpt", 10000); num(s.fetchedAt, "stored retrieval", 0, Number.MAX_SAFE_INTEGER); }
      for (const c of o.claims) { idOf(c.id); choice(c.dimension, DIMENSIONS, "stored dimension"); array(c.supportingSourceIds, "stored references"); array(c.opposingSourceIds, "stored references"); }
      for (const e of o.experiments) {
        idOf(e.id, "stored experiment id"); timestamp(e.createdAt, "experiment creation", now());
        const context = obj(e.context, "experiment context");
        for (const field of ["buyer", "problem", "mechanism"]) str(context[field], `experiment ${field}`, 10000);
        // Reapply current thresholds on reload; a persisted outcome flag never grants promotion by itself.
        const plan = experimentInput({ kind: e.kind, hypothesis: e.hypothesis, segment: e.segment, channel: e.channel, offer: e.offer,
          successCriteria: e.successCriteria, failureCriteria: e.failureCriteria, budget: e.budget, currency: e.currency,
          startsAt: e.startsAt, ...(e.endsAt === null ? {} : { endsAt: e.endsAt }) }, e.createdAt, e.context);
        if (e.result !== null) {
          if (e.result.recordedBy !== "user") throw new Error("Invalid recorded outcome provenance");
          const recordedAt = timestamp(e.result.recordedAt, "result recording", now());
          if (recordedAt < e.createdAt) throw new Error("Result precedes experiment creation");
          const fields = ["denominator", "successes", "payingCustomers", "revenue", "refunds", "repeatCustomers", "repeatPayments", "windowDays", "evidenceReference", "notes", "observedAt"];
          e.result = resultInput(Object.fromEntries(fields.map(k => [k, (e.result as any)[k]])), plan, recordedAt);
        }
      }
      return derive(o, now());
    } catch { return undefined; }
  }
  function get(id: string): Opportunity | undefined {
    idOf(id); const row = select.get(id) as { data: string } | null; return row ? decode(row.data) : undefined;
  }
  function requireOpportunity(id: string): Opportunity { const o = get(id); if (!o) throw new Error("Opportunity not found"); return o; }
  const persist = db.transaction((o: Opportunity, expectedVersion: number | null) => {
    const current = db.prepare("SELECT version FROM opportunities WHERE id = ?").get(o.id) as { version: number } | null;
    if (expectedVersion === null ? !!current : !current || current.version !== expectedVersion) throw new Error("Opportunity version conflict");
    o.updatedAt = now(); o.version = expectedVersion === null ? 1 : expectedVersion + 1; derive(o, o.updatedAt);
    const data = JSON.stringify(o);
    db.prepare("INSERT INTO opportunities(id, version, updated_at, data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at, data=excluded.data").run(o.id, o.version, o.updatedAt, data);
    db.prepare("INSERT INTO opportunity_versions(id, version, data) VALUES(?,?,?)").run(o.id, o.version, data);
    return structuredClone(o);
  });
  function create(input: OpportunityInput): Opportunity {
    const x = baseInput(input), at = now();
    const o: Opportunity = { ...x as Required<OpportunityInput>, id: x.id ?? `opportunity-${crypto.randomUUID()}`, version: 0,
      sources: [], claims: [], reviews: [], searches: [], unknowns: [], experiments: [], economics: x.economics ?? null, revenue: x.revenue ?? null,
      createdAt: at, updatedAt: at, stage: "concept", readiness: { ready: false, missing: [], independentGroups: 0, policy: "" } };
    return persist(o, null);
  }
  function update(id: string, patch: OpportunityPatch, options: { expectedVersion?: number } = {}): Opportunity {
    const o = requireOpportunity(id), x = baseInput(patch, true);
    if (options.expectedVersion !== undefined && num(options.expectedVersion, "expected version", 1, Number.MAX_SAFE_INTEGER, undefined, true) !== o.version) throw new Error("Opportunity version conflict");
    if (Object.keys(x).length === 0) return o;
    const version = o.version;
    const changedDimensions = new Set<ResearchDimension>();
    if (["buyer", "problem", "mechanism", "summary", "outcome", "mode", "industry"].some(k => own(x, k) && (x as any)[k] !== (o as any)[k])) for (const d of DIMENSIONS) changedDimensions.add(d);
    if (own(x, "economics") && JSON.stringify(x.economics) !== JSON.stringify(o.economics)) changedDimensions.add("economics");
    if (own(x, "revenue") && JSON.stringify(x.revenue) !== JSON.stringify(o.revenue)) { changedDimensions.add("economics"); changedDimensions.add("buyer"); }
    Object.assign(o, x);
    for (const r of o.reviews) if (changedDimensions.has(r.dimension)) r.reviewedBy = null;
    return persist(o, version);
  }
  function importBuild(build: any): Opportunity {
    obj(build, "legacy build");
    const legacyId = str(build.id, "legacy id", 160, true);
    // Hash only identifiers outside the new safe API grammar; always retain the original mapping.
    const id = /^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,159}$/.test(legacyId) ? legacyId : `legacy-${new Bun.CryptoHasher("sha256").update(legacyId).digest("hex").slice(0, 24)}`;
    const existing = get(id); if (existing) return existing;
    const created = create({ id, title: str(build.title, "title", 240, true), summary: str(build.pitch, "pitch", 10000),
      buyer: str(build.customer, "customer", 10000), problem: str(build.problem, "problem", 10000),
      outcome: str(build.offer, "offer", 10000), mechanism: str(build.why_novel || build.pitch, "mechanism", 10000),
      mode: DISCOVERY_MODES.some(m => m.id === build.mode) ? build.mode : "assets", industry: INDUSTRIES.some(i => i.id === build.industry) ? build.industry : "other" });
    created.legacyId = legacyId;
    return persist(created, created.version);
  }
  function addResearch(id: string, input: ResearchInput, options: { actor?: Actor } = {}): Opportunity {
    const o = requireOpportunity(id), version = o.version, at = now(), actor = choice(options.actor, ["model", "retrieval", "user"] as const, "actor", "model");
    const x = obj(input, "research"); keys(x, ["sources", "claims", "reviews", "searches", "unknowns"], "research");
    const financialSourceIds = new Set(Object.values(calculateEconomics(o.economics ?? {}).assumptions).flatMap(a => a.sourceIds ?? []));
    for (const raw of array(x.sources ?? [], "sources")) {
      const s = sourceInput(raw, actor, at), index = o.sources.findIndex(v => v.id === s.id);
      if (index >= 0) {
        const previous = o.sources[index];
        if (actor === "retrieval" && previous.ownerEdited) {
          s.kind = previous.kind; s.independenceGroup = previous.independenceGroup; s.ownerEdited = true;
        }
        const changed = previous.url !== s.url || previous.excerpt !== s.excerpt || previous.kind !== s.kind || previous.independenceGroup !== s.independenceGroup || !sourceCurrent(s, at);
        // Generated refreshes cannot erase a person's checked source. Actual failed retrievals can invalidate it.
        if (actor === "model" && previous.checkedBy) continue;
        o.sources[index] = s;
        if (changed) {
          for (const r of o.reviews) if (r.sourceIds.includes(s.id) || r.dimension === "economics" && financialSourceIds.has(s.id)) r.reviewedBy = null;
          for (const c of o.claims) if (c.supportingSourceIds.includes(s.id) || c.opposingSourceIds.includes(s.id)) { c.checkedBy = null; if (c.status === "observed") c.status = "inferred"; }
        }
      } else o.sources.push(s);
    }
    if (o.sources.length > MAX_ITEMS) throw new Error("Too many sources");
    for (const raw of array(x.claims ?? [], "claims")) {
      const c = claimInput(raw, actor, at, o.sources), index = o.claims.findIndex(v => v.id === c.id);
      if (index >= 0) { if (actor !== "user" && o.claims[index].ownerEdited || actor === "model" && o.claims[index].checkedBy) continue; o.claims[index] = c; } else o.claims.push(c);
    }
    if (o.claims.length > MAX_ITEMS) throw new Error("Too many claims");
    for (const raw of array(x.reviews ?? [], "reviews", 6)) {
      const r = obj(raw, "review"), dimension = choice(r.dimension, DIMENSIONS, "review dimension"), sourceIds = refs(r.sourceIds, "review source id");
      for (const sourceId of sourceIds) if (!o.sources.some(s => s.id === sourceId)) throw new Error(`Unknown source: ${sourceId}`);
      const review: ResearchReview = { dimension, sourceIds, notes: str(r.notes, "review notes", 5000, true), reviewedAt: timestamp(r.reviewedAt, "reviewedAt", at), reviewedBy: actor === "user" ? "user" : null };
      const index = o.reviews.findIndex(v => v.dimension === dimension);
      if (index >= 0) { if (actor !== "user" && o.reviews[index].reviewedBy === "user") continue; o.reviews[index] = review; } else o.reviews.push(review);
    }
    for (const raw of array(x.searches ?? [], "searches")) {
      const s = obj(raw, "search"); o.searches.push({ query: str(s.query, "search query", 2000, true), scope: str(s.scope, "search scope", 2000, true),
        result: str(s.result, "search result", 5000, true), searchedAt: timestamp(s.searchedAt, "searchedAt", at) });
    }
    o.searches = o.searches.slice(-MAX_ITEMS);
    if (own(x, "unknowns")) {
      const unknowns = array(x.unknowns, "unknowns").map(v => str(v, "unknown", 2000, true));
      o.unknowns = actor === "user" ? [...new Set(unknowns)] : [...new Set([...o.unknowns, ...unknowns])].slice(0, MAX_ITEMS);
    }
    return persist(o, version);
  }
  function addExperiment(id: string, input: ExperimentInput, options: { actor: "user" }): Opportunity {
    if (options?.actor !== "user") throw new Error("Only user-recorded experiments are accepted");
    const o = requireOpportunity(id), e = experimentInput(input, now(), { buyer: o.buyer, problem: o.problem, mechanism: o.mechanism });
    if (o.experiments.length >= MAX_ITEMS) throw new Error("Too many experiments");
    o.experiments.push(e); return persist(o, o.version);
  }
  function recordExperiment(id: string, experimentId: string, input: ExperimentResultInput, options: { actor: "user" }): Opportunity {
    if (options?.actor !== "user") throw new Error("Only user-recorded outcomes are accepted");
    const o = requireOpportunity(id); idOf(experimentId, "experiment id");
    const e = o.experiments.find(v => v.id === experimentId); if (!e) throw new Error("Experiment not found");
    if (e.result) throw new Error("Results are immutable; create a follow-up experiment to correct or retest");
    e.result = resultInput(input, e, now()); return persist(o, o.version);
  }
  return {
    get, create, update, importBuild, addResearch, addExperiment, recordExperiment,
    list(options: { mode?: DiscoveryMode; industry?: Opportunity["industry"]; stage?: OpportunityStage; limit?: number; offset?: number } = {}): Opportunity[] {
      if (options.mode !== undefined) choice(options.mode, DISCOVERY_MODES.map(m => m.id), "mode");
      if (options.industry !== undefined) choice(options.industry, INDUSTRIES.map(m => m.id), "industry");
      if (options.stage !== undefined) choice(options.stage, OPPORTUNITY_STAGES, "stage");
      const limit = num(options.limit, "limit", 1, 500, 100, true), offset = num(options.offset, "offset", 0, 100000, 0, true);
      const out: Opportunity[] = []; let matched = 0;
      for (const row of db.prepare("SELECT data FROM opportunities ORDER BY updated_at DESC, id ASC").iterate() as Iterable<{ data: string }>) {
        const o = decode(row.data); if (!o || options.mode && o.mode !== options.mode || options.industry && o.industry !== options.industry || options.stage && o.stage !== options.stage) continue;
        if (matched++ < offset) continue; out.push(o); if (out.length >= limit) break;
      }
      return out;
    },
    history(id: string): Opportunity[] {
      idOf(id); return (db.prepare("SELECT data FROM opportunity_versions WHERE id = ? ORDER BY version DESC LIMIT 200").all(id) as Array<{ data: string }>)
        .flatMap(row => { try { const o = JSON.parse(row.data); return o.id === id ? [o] : []; } catch { return []; } });
    },
    close() { db.close(); },
  };
}
export type Opportunities = ReturnType<typeof createOpportunities>;
