// Demand evidence: real public posts where people say something hurts (from the Leads engine), gathered per audience
// the user can reach, and matched back to ideas. An idea's evidence score says "people are already asking for this",
// with links, and is the same for every strategy: cited posts count more, but only when they're actually on topic.
import { analyze, FETCHERS, keywordsFor, SOURCES, type Dir, type Limits, type Raw, type SourceCtx, type SourceId } from "../leads";
import { gh as ghDefault } from "../discover";
import type { Audience, EvidenceMatch, Idea, PainCorpus, PainPost, PainTheme } from "./types";
import { topicsOf } from "./inventory";

// ── gathering ─────────────────────────────────────────────────────────────────────────────
type GatherOpts = {
  fetch?: SourceCtx["fetch"]; gh?: SourceCtx["gh"]; timeout?: number; now?: number;
  sources?: SourceId[]; log?: (s: string) => void;
  /** Leads results already on disk (the deck's leads-cache.json entries), reused instead of searching again. */
  cached?: Record<string, { text: string; dir: Dir; evidence: any[]; themes: any[] }>;
  /** "audience" (who they are → their pains) or "idea" (a product → who needs it). */
  dir?: Dir;
};
/** Search each audience's pains on the public sources (sequentially, so Reddit's one-read-per-15s is respected). */
export async function gatherPains(audiences: Audience[], o: GatherOpts = {}): Promise<PainCorpus> {
  const now = o.now ?? Date.now();
  const limits: Limits = { redditUntil: 0, ghRemaining: 30, ghReset: 0, seQuota: 300, seUntil: 0 };
  const ctx: SourceCtx = { fetch: o.fetch ?? ((u, i) => fetch(u, i as any) as any), gh: o.gh ?? ghDefault, limits, now, timeout: o.timeout ?? 9000 };
  const corpus: PainCorpus = { at: now, posts: [], themes: [], queries: [] };
  for (const au of audiences) {
    const hit = Object.values(o.cached ?? {}).find((c) => c.text.toLowerCase() === au.query.toLowerCase());
    let evidence: any[], themes: any[];
    const errors: string[] = [];
    if (hit) { evidence = hit.evidence; themes = hit.themes; o.log?.(`${au.id}: reused cached leads for "${au.query}"`); }
    else {
      const dir: Dir = o.dir ?? "audience";
      const keywords = keywordsFor(au.query, dir);
      const raws: Raw[] = [];
      const subs: any[] = [], apps: any[] = [];
      for (const s of (o.sources ?? SOURCES.map((x) => x.id))) {
        const t0 = Date.now();
        try {
          const out = await FETCHERS[s](keywords, dir, ctx);
          raws.push(...out.raws); if (out.subs) subs.push(...out.subs); if (out.apps) apps.push(...out.apps);
          if (out.error || out.skipped) errors.push(`${s}: ${out.error ?? out.skipped}`);
          o.log?.(`${au.id}/${s}: ${out.raws.length} posts in ${Date.now() - t0}ms${out.error ? ` (${out.error})` : ""}`);
        } catch (e: any) { errors.push(`${s}: ${e?.message ?? e}`); }
      }
      const a = analyze({ raws, keywords, text: au.query, dir, subs, apps, now });
      evidence = a.evidence; themes = a.themes;
    }
    const posts = evidence.filter((e: any) => e.pain > 0).map((e: any): PainPost => ({
      id: `${e.source}:${e.id}`, source: e.source, url: e.url, title: String(e.title ?? "").slice(0, 200), snippet: String(e.snippet ?? "").slice(0, 260),
      pain: e.pain, score: e.score, signals: e.signals ?? [], at: e.at, audience: au.id, where: e.where?.label,
    }));
    for (const p of posts) if (!corpus.posts.some((x) => x.id === p.id)) corpus.posts.push(p);
    for (const t of themes) {
      const quotes = (t.quotes ?? []).map((q: any) => corpus.posts.find((p) => p.id === `${q.source}:${q.id}`)).filter(Boolean) as PainPost[];
      corpus.themes.push({ id: `${au.id}:${t.id}`, audience: au.id, title: t.title, label: t.label, idea: t.idea, n: t.n, heat: t.heat, score: t.score, terms: t.terms, quotes, topics: [...new Set([...au.topics, ...topicsOf(`${t.label} ${t.title}`)])] });
    }
    corpus.queries.push({ audience: au.id, text: au.query, posts: posts.length, themes: themes.length, errors });
  }
  return corpus;
}

// ── matching ideas to posts ────────────────────────────────────────────────────────────────
const STOP = new Set("a an the and or but for to of in on at by with from into over about is are was were be been it its this that these those there here what which who when where why how i me my we our you your they them their one also just only even really very so too then than as if can could would should will may might must do does did have has had get gets make makes want wants need needs like use uses using used via per app apps tool tools thing things way people person user users new better best good great more most some any all each every other own not no out up now day days time year years their help lets let simple easy free first without every".split(" "));
const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 4 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
export function terms(text: string): string[] {
  const ws = String(text ?? "").toLowerCase().replace(/[’']/g, "").replace(/human design/g, "humandesign").replace(/i ching/g, "iching").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
  return [...new Set(ws)];
}
export type PostIndex = { posts: PainPost[]; tf: Set<string>[]; idf: Map<string, number>; df: Map<string, number> };
export function indexPosts(posts: PainPost[]): PostIndex {
  const tf = posts.map((p) => new Set(terms(`${p.title} ${p.snippet}`)));
  const df = new Map<string, number>();
  for (const m of tf) for (const t of m) df.set(t, (df.get(t) ?? 0) + 1);
  const N = Math.max(1, posts.length);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + N / n)]));
  return { posts, tf, idf, df };
}
/**
 * Posts that back an idea. The idea's pain + buyer words are matched against each post; a post counts only when it
 * shares at least three distinctive words (rare in the corpus) with them, and a very short post ("This is the WORST")
 * never counts. Overlap = the share of the idea's pain vocabulary (idf-weighted) the post covers.
 */
export function matchEvidence(idea: Pick<Idea, "buyer" | "pain" | "hook" | "offer" | "evidenceIds">, ix: PostIndex, max = 5): EvidenceMatch[] {
  const q = terms(`${idea.pain} ${idea.buyer}`);
  const N = Math.max(1, ix.posts.length);
  const idfOf = (t: string) => ix.idf.get(t) ?? Math.log(1 + N);
  const distinctive = (t: string) => (ix.df.get(t) ?? 0) <= Math.max(2, N * 0.06);
  const qw = q.reduce((a, t) => a + idfOf(t), 0) || 1;
  const cited = new Set((idea.evidenceIds ?? []).map(String));
  const out: EvidenceMatch[] = [];
  ix.posts.forEach((p, i) => {
    const pt = ix.tf[i];
    const shared = q.filter((t) => pt.has(t));
    const isCited = cited.has(p.id);
    const strong = shared.filter(distinctive).length >= 3 && p.snippet.length >= 60;
    if (!strong && !isCited) return;
    const overlap = Math.min(1, shared.reduce((a, t) => a + idfOf(t), 0) / Math.min(qw, 40));
    out.push({ postId: p.id, url: p.url, snippet: p.snippet, source: p.source, overlap: Math.round(overlap * 1000) / 1000, cited: isCited && shared.length >= 1 });
  });
  return out.sort((a, b) => Number(b.cited) - Number(a.cited) || b.overlap - a.overlap).slice(0, max);
}
/** 0..1: how well real posts back the idea. A cited post counts more, but only when it shares words with the idea. */
export function evidenceScore(ms: EvidenceMatch[], posts: Map<string, PainPost>): number {
  let miss = 1;
  for (const m of ms.slice(0, 5)) {
    const p = posts.get(m.postId);
    const onTopic = Math.min(1, m.overlap / 0.25);
    const q = (m.cited ? 0.4 : 0.25) * onTopic * (0.6 + 0.4 * Math.min(1, (p?.pain ?? 1) / 4));
    miss *= 1 - q;
  }
  const sources = new Set(ms.filter((m) => m.overlap >= 0.15).map((m) => m.source)).size;
  return Math.round(Math.min(1, 1 - miss + (sources >= 2 ? 0.05 : 0)) * 1000) / 1000;
}
