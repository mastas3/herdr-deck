// Discover and Opportunities share one evidence notebook. Generated text never grants a reviewed stage.
import { createHash } from "node:crypto";
import { createOpportunities, independentGroups, publicResearchUrl, sourceCurrent, type Opportunity } from "../../src/evidence-notebook";
import { coverIdOf } from "./idea-archive";
import type { IdeaCard } from "./ideagen/types";

export const DISCOVER_STAGES = ["concept", "problem-documented", "buying-signal", "paid-pilot", "repeat-use"] as const;
export const DISCOVER_LABELS = ["Untested idea", "Problem documented", "Buyers interested", "Customers paid", "Customers returned"];
type Store = ReturnType<typeof createOpportunities>;
export function discoverProof(item: Opportunity | undefined, now = Date.now()) {
  const usable = (id: string) => sourceCurrent(item?.sources.find(s => s.id === id), now);
  const problems = item?.claims.filter(c => c.dimension === "problem" && c.status === "observed" && c.checkedBy === "user" &&
    !c.opposingSourceIds.some(usable)) ?? [];
  const reviewedIds = new Set(problems.flatMap(c => c.supportingSourceIds.filter(id => sourceCurrent(item?.sources.find(s => s.id === id), now, c.maxAgeDays))));
  const reviewed = item?.sources.filter(s => reviewedIds.has(s.id) && s.kind === "customer" && s.publishedAt !== null && sourceCurrent(s, now)) ?? [];
  const groups = independentGroups(reviewed);
  const objections = item?.claims.filter(c => c.material && (c.status === "contradicted" || c.opposingSourceIds.some(usable))) ?? [];
  const reviews = ["buyer", "problem"].every(d => item?.reviews.some(r => r.dimension === d && r.reviewedBy === "user" && r.notes &&
    r.sourceIds.length > 0 && r.sourceIds.every(usable) && now - r.reviewedAt <= 90 * 86_400_000));
  const documented = !!item?.buyer && !!item?.problem && reviews && groups >= 2 && !objections.length;
  const stage = item && ["buying-signal", "paid-pilot", "repeat-use"].includes(item.stage) ? item.stage : documented ? "problem-documented" : "concept";
  const experiments = item?.experiments.filter(e => e.context.buyer === item.buyer && e.context.problem === item.problem && e.context.mechanism === item.mechanism) ?? [];
  const results = experiments.filter(e => e.result).reverse().sort((a, b) => b.result!.observedAt - a.result!.observedAt);
  // Do not sum across experiments: the same people may occur in several tests.
  const latest = results[0];
  return { stage, label: DISCOVER_LABELS[DISCOVER_STAGES.indexOf(stage as any)], opportunityId: item?.id,
    sourceCount: item?.sources.length ?? 0, reviewedSources: reviewed.length, independentGroups: groups,
    objections: objections.length, failedTests: results.filter(e => e.result!.outcome === "fail").length,
    inconclusiveTests: results.filter(e => e.result!.outcome === "inconclusive").length, plannedTests: experiments.filter(e => !e.result).length,
    latestTest: latest ? { kind: latest.kind, offer: latest.offer, segment: latest.segment, channel: latest.channel, currency: latest.currency, ...latest.result!, provenance: "Owner-reported; not verified with a payment provider" } : null,
    unknowns: item?.unknowns ?? [], updatedAt: item?.updatedAt ?? 0 };
}
export type DiscoverProof = ReturnType<typeof discoverProof>;
export function evidenceLanes(cards: (IdeaCard & { proof: DiscoverProof })[]) {
  const sort = (a: typeof cards[number], b: typeof cards[number]) => DISCOVER_STAGES.indexOf(b.proof.stage as any) - DISCOVER_STAGES.indexOf(a.proof.stage as any) || b.proof.updatedAt - a.proof.updatedAt || a.name.localeCompare(b.name);
  const shortlist = cards.filter(c => c.proof.stage !== "concept" && !c.proof.objections && !c.proof.failedTests).sort(sort).slice(0, 5);
  const chosen = new Set(shortlist.map(c => c.id));
  return [
    { id: "reviewed", title: "Evidence shortlist", subtitle: "Reviewed problems and recorded buyer tests; no success predictions", ideas: shortlist.map(c => c.id), more: false },
    { id: "problems", title: "Problem leads to review", subtitle: "Suggestions from collected excerpts. The connection still needs checking.", ideas: cards.filter(c => !chosen.has(c.id) && c.origin === "problem-first" && c.proof.stage === "concept").map(c => c.id), more: false },
    { id: "untested", title: "Untested ideas and earlier work", subtitle: "Preserved for reference. Source links and old AI ratings do not establish demand.", ideas: cards.filter(c => !chosen.has(c.id) && !(c.origin === "problem-first" && c.proof.stage === "concept")).sort(sort).map(c => c.id), more: false },
  ];
}
export function createDiscoverEvidence(store: Store, now: () => number = Date.now) {
  const lookup = (c: IdeaCard) => store.get(coverIdOf(c.id)) ?? store.get(c.id);
  function open(c: IdeaCard) {
    let item = lookup(c);
    if (item) return item; // Preserve every user edit, review and experiment on subsequent opens.
    item = store.importBuild({ id: coverIdOf(c.id), title: c.name, pitch: c.hook, customer: c.buyer, problem: c.pain, offer: c.offer, why_novel: c.mvp || c.offer });
    const sources = c.evidence.filter(e => publicResearchUrl(e.url) && e.snippet).map(e => ({
      id: `discover-${createHash("sha256").update(`${e.url}|${e.snippet}`).digest("hex").slice(0, 20)}`, url: e.url, title: e.title || e.source,
      excerpt: e.snippet, publisher: new URL(e.url).hostname, access: "unverified" as const, kind: "other" as const,
      ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}), ...(e.fetchedAt ? { fetchedAt: e.fetchedAt } : {}),
      error: "Imported excerpt. Open the original, check its date and relevance, and identify whether this is a customer report or a product promotion.",
    }));
    return store.addResearch(item.id, { sources, claims: sources.length ? [{ text: c.pain, dimension: "problem", status: "inferred", supportingSourceIds: sources.map(s => s.id), notes: "The generated link between this problem and these sources needs review." }] : [],
      unknowns: [...new Set([...(c.unknowns ?? []), "Does the original source concern this exact buyer and problem?", "Are existing or free alternatives already good enough? Has the reported problem been fixed?", "What do buyers currently spend? Distinguish self-reports from verified payments.", "Can you reach buyers, and will they pay for this offer?", "Check switching barriers, delivery costs and reasons this could fail."])] }, { actor: "model" });
  }
  return { open, lookup, proof: (c: IdeaCard) => discoverProof(lookup(c), now()) };
}
