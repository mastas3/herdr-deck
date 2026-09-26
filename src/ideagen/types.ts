// Idea engine types: inventory, demand evidence, briefs, ideas, judging, connectors, the gallery and starter kits.
// Everything here is plain data (JSON-safe), so the gallery can be cached per day and served as-is.

import type { Comparable } from "../library-strategy";

// ── inventory ───────────────────────────────────────────────────────────────────────
/** What an ingredient can do inside an idea. A coherent idea fills roles, not random slots. */
export type Role = "audience" | "channel" | "engine" | "data" | "monetization" | "distribution" | "build";
export type AssetKind = "project" | "repo" | "service" | "account" | "mcp" | "skill" | "ai" | "key" | "rec" | "interest";
/** One thing the user has (owned) or could add (rec, gem repo). Caps are capability ids from CAPS. */
export type Asset = {
  id: string; kind: AssetKind; name: string; desc: string;
  caps: string[]; roles: Role[]; topics: string[];
  owned: boolean; ready: boolean;
  /** 0..1: how strong and how unique the asset is (a launched project with a rare capability is near 1). */
  strength: number;
  url?: string; where?: string; stars?: number;
};
/** An audience the user can plausibly reach, with the assets that reach it. */
export type Audience = {
  id: string; label: string; who: string; topics: string[];
  /** Asset ids (accounts, groups, projects with users) that reach these people. */
  reach: string[];
  /** Where they gather in public (subreddits, groups, channels), for launch posts. */
  places: string[];
  /** 0..1: how well the user can actually reach them today. */
  access: number;
  /** Leads search text for pain evidence. */
  query: string;
  /** Jobs to be done: what they hire a product for. */
  jobs: string[];
  /** Capabilities that serve these people (what an engine for them has to be able to do). */
  caps: string[];
};
export type Inventory = { at: number; assets: Asset[]; audiences: Audience[]; keys: { name: string; where: string }[] };

// ── demand evidence ─────────────────────────────────────────────────────────────────────
export type PainPost = {
  id: string; source: string; url: string; title: string; snippet: string;
  pain: number; score: number; signals: string[]; at: number; audience: string; where?: string;
};
export type PainTheme = {
  id: string; audience: string; title: string; label: string; idea: string; n: number; heat: number; score: number;
  terms: string[]; quotes: PainPost[]; topics: string[];
};
export type PainCorpus = { at: number; posts: PainPost[]; themes: PainTheme[]; queries: { audience: string; text: string; posts: number; themes: number; errors: string[] }[] };

// ── briefs (what the sampler hands the generator) ────────────────────────────────────────────
export type StrategyId =
  | "A0-template" | "A1-mixer" | "A2-random-schema"
  | "B-pain" | "C-audience" | "D-asset" | "E-remix" | "F-gem" | "G-constraint" | "H-boring"
  | "W-hybrid" | "T-hot" | "T-early";
export type ProvenModel = { id: string; name: string; pattern: string; examples: string; price: string; fits: string[] };
export type Brief = {
  id: string; strategy: StrategyId;
  audience?: Audience; pain?: PainTheme; engine?: Asset; support?: Asset[]; gem?: Asset; model?: ProvenModel;
  channel?: Asset; constraint?: string; angle?: string;
  /** Trend strategies: the trend and its signals (see trends.ts). */
  trend?: { id: string; label: string; heat: number; earliness: number; signals: { id: string; source: string; title: string; url: string; at: number; metric: number; rank: number }[] };
  /** Sampler bookkeeping: compatibility and demand weight at pick time. */
  compat: number; demand: number;
};

// ── ideas ─────────────────────────────────────────────────────────────────────────────
export type Difficulty = "weekend" | "week" | "month";
export type StackItem = { name: string; role: string; assetId?: string; owned: boolean };
export type Idea = {
  id: string; strategy: StrategyId; promptVersion: string; round: number; briefId?: string;
  name: string; hook: string; buyer: string; pain: string; offer: string; price: string; channel: string;
  mvp: string; stack: StackItem[]; needs: string[];
  timeToFirstDollarDays: number; difficulty: Difficulty;
  evidenceIds: string[]; firstQuests: string[]; topics: string[];
  source: "claude" | "template";
  /** Why this builder wins (prompt v2+). */
  edge?: string;
  /** Trend ideas: the trend they ride, the signals cited, why now; heat/earliness come from the cited signals. */
  trend?: { label: string; whyNow: string; signals: { id: string; source: string; title: string; url: string }[]; heat: number; earliness: number };
  /** Why it could fail and what the kept version fixes (premortem.ts); pivotedFrom is set when the revision won. */
  premortem?: { failures: { reason: string; pattern?: string; evidence?: string }[]; fix: string; verdict: "improve" | "abandon"; pivotedFrom?: { name: string; hook: string } };
  raw?: any;
};

// ── judging ─────────────────────────────────────────────────────────────────────────────
export type Rubric = { spec: number; feasible: number; buyer: number; distribution: number; novelty: number; fun: number; p10: number; flaw: string; generic?: number };
export type EvidenceMatch = { postId: string; url: string; snippet: string; source: string; overlap: number; cited: boolean };
export type Scores = {
  rubric?: Rubric; rubricNorm?: number;
  jevP10?: number; jevShip?: number; jevNorm?: number; jevSingleP10?: number;
  evidence: number; evidenceMatches: EvidenceMatch[];
  elo?: number; wins?: number; games?: number;
  /** The slop gate: a failing idea gets quality 0 and is never shown; qualityRaw keeps what the judges said. */
  slop?: { pass: boolean; reasons: string[] }; jevGeneric?: number; patterns?: number;
  quality: number; qualityNoEvidence: number; qualityRaw: number;
};
export type ConnectorType = "repo" | "service" | "business" | "prompt" | "graphics" | "project" | "mcp";
export type ConnectorSuggestion = { type: ConnectorType; name: string; url?: string; why: string; how: string; free?: string; verified?: boolean };
export type CapNeed = { cap: string; label: string; have: { id: string; name: string }[]; missing: boolean; suggestions: ConnectorSuggestion[] };

// ── gallery ───────────────────────────────────────────────────────────────────────────
export type PlayBrief = { quests: { title: string; verify: string }[] };
export type IdeaCard = {
  id: string; name: string; hook: string; buyer: string; pain: string;
  evidence: { url: string; snippet: string; source: string }[];
  offer: string; price: string; channel: string; mvp: string;
  stack: StackItem[]; connectors: CapNeed[]; missing: CapNeed[];
  timeToFirstDollarDays: number; difficulty: Difficulty;
  quality: number; jevP10?: number; rubric?: Rubric; evidenceScore: number;
  strategy: StrategyId; topics: string[]; play: PlayBrief;
  trend?: Idea["trend"]; premortem?: Idea["premortem"];
  /** 0..1: how many of the success patterns (success.ts) Jev says it has. */
  patterns?: number;
  ownedRatio: number;
};
export type Lane = { id: string; title: string; subtitle: string; ideas: string[]; more: boolean };
export type Gallery = {
  day: string; at: number; version: string;
  lanes: Lane[]; ideas: Record<string, IdeaCard>;
  stats: { ideas: number; claudeCalls: number; jevCalls: number; ms: number; note?: string; refills?: Record<string, number> };
};

// ── starter kits ───────────────────────────────────────────────────────────────────────
export type KitTask = { id: string; title: string; size: "S" | "M" | "L"; prompt: string; accept: string[]; dependsOn: string[] };
export type KitReadiness = { label: string; status: "ready" | "needs-user" | "missing"; how?: string };
export type StarterKit = {
  ideaId: string; slug: string; at: number; version: string;
  spec: { problem: string; buyer: string; jobs: string[]; scopeIn: string[]; scopeOut: string[]; metrics: { metric: string; target: string; milestone: string }[] };
  architecture: { summary: string; components: { name: string; does: string; uses: string }[]; dataModel: { entity: string; fields: string[] }[]; flows: { name: string; steps: string[] }[] };
  buildPlan: KitTask[];
  connectors: {
    repos: { name: string; url: string; why: string; verified: boolean }[];
    services: { name: string; url: string; why: string; free?: string; have: boolean }[];
    keys: { name: string; purpose: string; have: boolean; where?: string }[];
    mcpAndSkills: { name: string; use: string }[];
    missing: CapNeed[];
  };
  scaffold: { folder: string; base: string; files: { path: string; purpose: string }[]; deploy: string };
  gtm: {
    landing: { headline: string; subhead: string; benefits: string[]; cta: string };
    pricing: { tier: string; price: string; includes: string[] }[];
    launchPosts: { channel: string; text: string }[];
    outreach: string;
    graphics: { asset: string; prompt: string }[];
    /** Grounded in comparable founders: why this price, the first ten customers, the launch weeks (each cites one or "none"). */
    pricingWhy?: string; first10?: { step: string; cites: string }[]; launchPlan?: { when: string; what: string; cites: string }[];
  };
  /** Comparable founders from the Founder Library, as found when the kit was written (src/library-strategy.ts). */
  comparables?: { items: Comparable[]; summary: string[]; checks: string[] };
  quests: { title: string; verify: string; done: boolean }[];
  readiness: { score: number; items: KitReadiness[] };
  judge?: { ready: number; questions: string[]; notes: string };
  cost: { claudeCalls: number; ms: number };
};
