// Pain search: what people wrote in public about an idea or an audience, scored for pain and grouped into themes.
// Leads (plugins-builtin/leads) searches with it, and so does Discover's problem gallery, which reads it without
// Leads being on; so it stays a shared part of the core, like the evidence notebook.
//
// Two directions, one engine. "Idea → people": describe an app or feature, get the pain points it answers and the
// people and communities who have them. "People → ideas": describe an audience, get its recurring pains and concrete
// app ideas that solve them, each with evidence.
//
// The instant pass searches open public sources in parallel (Hacker News, Reddit, GitHub issues, Stack Exchange,
// App Store reviews), each async with a timeout and its own rate-limit manners, and scores what people wrote for
// pain (phrases like "is there an app", "I wish", "would pay") × engagement × recency. Posts are deduped and
// clustered into pain themes by keyword overlap. No model, no keys; results stream in per source.
//
// Privacy: only the words of your query go to those sites. Nothing is ever posted, nobody is contacted, followed or
// signed up. Output keeps public usernames and post links only: emails and phone numbers are stripped.
import type { GhRes } from "./gh";
import { hasTerm, slugify } from "./text";

const DAY = 86_400_000;
export const UA = "herdr-deck-leads/0.1 (local research dashboard; reads public posts only; +https://github.com/mastas3/herdr-deck)";

// ── types ─────────────────────────────────────────────────────────────────────────
export type Dir = "idea" | "audience";
export type SourceId = "hn" | "reddit" | "github" | "se" | "appstore";
export const SOURCES: { id: SourceId; label: string }[] = [
  { id: "hn", label: "Hacker News" }, { id: "reddit", label: "Reddit" }, { id: "github", label: "GitHub" },
  { id: "se", label: "Stack Exchange" }, { id: "appstore", label: "App Store" },
];
export type PlaceKind = "subreddit" | "hn" | "repo" | "se" | "app";
export type Where = { id: string; label: string; url: string; kind: PlaceKind };
/** One public post, comment, issue, question or review, as a source returned it (before scoring). */
export type Raw = {
  id: string; source: SourceId; kind: "story" | "comment" | "post" | "issue" | "question" | "review";
  title: string; text: string; url: string; author?: string; where?: Where; at: number;
  points?: number; comments?: number; rating?: number;
};
export type Evidence = Omit<Raw, "text"> & { snippet: string; signals: string[]; pain: number; rel: number; score: number };
export type Place = Where & { source: SourceId; n: number; last: number; eng: number; desc?: string; rating?: number; ratings?: number; price?: string };
export type App = { id: string; name: string; url: string; rating?: number; ratings?: number; price?: string; genre?: string };
export type Theme = { id: string; title: string; label: string; cat: string; catLabel: string; terms: string[]; n: number; sources: SourceId[]; score: number; heat: number; idea: string; ids: string[]; quotes: Evidence[] };
/** Someone already building in this space (a Show HN / Launch HN post): competition, and proof of demand. */
export type Builder = { title: string; url: string; points: number; comments: number; at: number };
export type SrcStatus = { state: "pending" | "ok" | "error" | "skipped"; n: number; ms?: number; error?: string };
export type LeadsResult = {
  key: string; text: string; dir: Dir; keywords: string[]; at: number; done: boolean;
  sources: Record<SourceId, SrcStatus>; themes: Theme[]; evidence: Evidence[]; places: Place[]; apps: App[]; builders: Builder[];
  counts: { posts: number; pains: number; places: number };
};

// ── text: HTML → text, privacy scrub, snippets ────────────────────────────────────
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function decode(s: string) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") { const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENT[k] ?? m;
  });
}
/** HTML (or HTML escaped inside XML) → plain text on one line. */
export function htmlText(s: string) {
  let t = String(s ?? "");
  if (/&lt;\/?[a-z]/i.test(t)) t = decode(t); // Atom feeds escape the HTML once
  t = t.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|blockquote|pre)>/gi, "\n").replace(/<[^>]+>/g, " ");
  return decode(t).replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+|\b)\d[\d\s().\-–]{6,}\d\b/g;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
/** Private contact details never leave this function: emails and phone numbers are removed, links shortened. */
export function scrub(s: string) {
  return String(s ?? "")
    .replace(EMAIL, "[email hidden]")
    .replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 9 && !/^\d{4}-\d\d-\d\d(?:[ T]\d|$)/.test(m) ? "[phone hidden]" : m))
    .replace(URL_RE, "[link]");
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);

// ── pain signals ──────────────────────────────────────────────────────────────────────
/** What people write when something hurts or is missing, with how strongly it says "I'd use a product for this". */
export const SIGNALS: [RegExp, string, number][] = [
  [/\bis there (?:an?|any|some) (?:\w+ ){0,2}(?:app|tool|way|service|software|website|site|plugin|extension|program|platform|bot)\b/i, "is there an app", 3],
  [/\b(?:looking|searching|hunting) for (?:an? |some |any )?(?:good |simple |free |better )?(?:app|tool|way|service|software|solution|website|platform|alternative|plugin)/i, "looking for a tool", 3],
  [/\bi (?:really |just )?wish\b/i, "I wish", 2.5],
  [/\b(?:would|i'?d|happy to|willing to|gladly|i'?ll) (?:happily )?pay\b|\btake my money\b/i, "would pay", 3.5],
  [/\balternatives? (?:to|for)\b/i, "alternative to", 2],
  [/\bfrustrat\w*/i, "frustrating", 2],
  [/\bhate (?:that|how|when|it|the|this|having)\b/i, "hate that", 2],
  [/\bannoy\w*/i, "annoying", 1.5],
  [/\bpain(?:ful| point| in the)\b/i, "painful", 2],
  [/\bstruggl\w*/i, "struggling", 1.5],
  [/\b(?:can'?t|cannot|couldn'?t|unable to) (?:find|figure out)\b/i, "can't find", 2],
  [/\b(?:doesn'?t|does not) (?:seem to )?exist\b|\bnothing (?:like (?:this|that|it)|out there)\b/i, "doesn't exist", 2.5],
  [/\bhow (?:do|can|would|should) (?:you|i|we|people)\b/i, "how do you", 1],
  [/\b(?:any|anyone have (?:a|any)) (?:good )?recommendations?\b|\brecommend (?:an? |any )?(?:good )?(?:app|tool|software|service)/i, "recommendations?", 2],
  [/\b(?:tired|sick) of\b/i, "tired of", 2],
  [/\btedious\b|\btakes (?:forever|hours|ages)\b|\bwast(?:e|ing) (?:so much |a lot of )?time\b|\bmanually\b/i, "tedious", 1.5],
  [/\bfeature request\b|\bplease add\b|\bwould (?:love|be (?:great|nice|awesome)) (?:if|to (?:have|see))\b/i, "feature request", 2],
  [/\b(?:too|so|way too) expensive\b|\boverpriced\b|\bpaywall\w*|\bsubscription\b|\bprice (?:hike|increase)/i, "price", 1.5],
  [/\bconfus\w*|\bcomplicated\b|\boverwhelm\w*|\bhard to (?:use|understand|read|learn)\b/i, "confusing", 1.5],
  [/\bcrash\w*|\bbroken\b|\bbuggy\b|\b(?:doesn'?t|does not|won'?t) (?:work|load|sync|open)\b|\bstopped working\b/i, "broken", 1.5],
  [/\bneed (?:an? |some )?(?:app|tool|way|better|simple)\b/i, "need a tool", 2],
  [/\bwhy (?:is|isn'?t|doesn'?t|can'?t) (?:there|it)\b/i, "why isn't there", 1.5],
];
/** The signals a text shows and their combined strength (capped, so one rant can't dominate). */
export function painOf(text: string, rating?: number): { pain: number; signals: string[] } {
  const t = String(text).replace(/[’‘]/g, "'");
  const signals: string[] = [];
  let pain = 0;
  for (const [re, label, w] of SIGNALS) if (re.test(t)) { signals.push(label); pain += w; }
  if (rating != null && rating > 0) { if (rating <= 1) pain += 2.5; else if (rating <= 2) pain += 1.8; else if (rating <= 3) pain += 0.8; if (rating <= 2) signals.push(`${rating}★ review`); }
  return { pain: Math.min(pain, 7), signals };
}
/** The part of a post worth quoting: the sentence where the pain shows, ≤ 240 characters, scrubbed. */
export function snippetOf(text: string, title = "", n = 240) {
  const body = scrub(String(text || "").replace(/\s+/g, " ").trim());
  const src = body || scrub(title);
  if (src.length <= n) return src;
  const t = src.replace(/[’‘]/g, "'");
  let at = -1;
  for (const [re] of SIGNALS) { const m = re.exec(t); if (m && (at < 0 || m.index < at)) at = m.index; }
  if (at < 0) return clip(src, n);
  // Start at the beginning of that sentence (or a little before the match).
  let start = Math.max(0, t.lastIndexOf(". ", at) + 2, t.lastIndexOf("? ", at) + 2, t.lastIndexOf("! ", at) + 2);
  if (at - start > 150) start = Math.max(0, at - 60);
  const cut = src.slice(start);
  return (start > 0 ? "…" : "") + clip(cut, n - (start > 0 ? 1 : 0));
}

// ── parsers: each source's response → Raw[] (pure; tested with fixtures) ─────────────────────
export function parseHN(json: any): Raw[] {
  const out: Raw[] = [];
  for (const h of json?.hits ?? []) {
    const isComment = Array.isArray(h._tags) ? h._tags.includes("comment") : !!h.comment_text;
    const id = String(h.objectID ?? "");
    if (!id) continue;
    const storyId = String(h.story_id ?? id);
    const title = String(isComment ? h.story_title ?? "" : h.title ?? "");
    const text = htmlText(isComment ? h.comment_text ?? "" : h.story_text ?? "");
    if (!title && !text) continue;
    out.push({
      id: `hn:${id}`, source: "hn", kind: isComment ? "comment" : "story", title: clip(decode(title), 160), text, url: `https://news.ycombinator.com/item?id=${id}`,
      author: h.author ? String(h.author) : undefined, at: (Number(h.created_at_i) || Date.parse(h.created_at) / 1000 || 0) * 1000,
      points: Number(h.points) || 0, comments: Number(h.num_comments) || 0,
      where: { id: `hn:${storyId}`, label: clip(title || "Hacker News thread", 90), url: `https://news.ycombinator.com/item?id=${storyId}`, kind: "hn" },
    });
  }
  return out;
}
/** Reddit's search feed (Atom): subreddits (t5) come first, then posts (t3). */
export function parseRedditAtom(xml: string): { posts: Raw[]; subs: Place[] } {
  const posts: Raw[] = [], subs: Place[] = [];
  const tag = (e: string, name: string) => e.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
  for (const e of String(xml ?? "").split("<entry>").slice(1)) {
    const id = tag(e, "id").trim();
    const href = decode(e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? "");
    const title = htmlText(tag(e, "title"));
    const at = Date.parse(tag(e, "updated")) || 0;
    const author = htmlText(tag(tag(e, "author"), "name")).replace(/^\/u\//, "u/");
    if (id.startsWith("t5_")) {
      const name = href.match(/\/r\/([\w-]+)/)?.[1];
      if (name) subs.push({ id: `r/${name.toLowerCase()}`, label: `r/${name}`, url: `https://www.reddit.com/r/${name}/`, kind: "subreddit", source: "reddit", n: 0, last: 0, eng: 0, desc: clip(scrub(htmlText(tag(e, "content")).replace(/\[link\]/g, "").trim()), 160) });
      continue;
    }
    if (!id.startsWith("t3_") || !/\/comments\//.test(href)) continue;
    const sub = e.match(/<category[^>]*term="([^"]+)"/)?.[1] ?? href.match(/\/r\/([\w-]+)/)?.[1] ?? "";
    let text = htmlText(tag(e, "content")).replace(/submitted by\s+\/u\/[\s\S]*$/i, "").replace(/\[link\]|\[comments\]/g, "").trim();
    if (text === title) text = "";
    posts.push({
      id: `rd:${id}`, source: "reddit", kind: "post", title: clip(title, 160), text, url: href, author: author || undefined, at,
      where: sub ? { id: `r/${sub.toLowerCase()}`, label: `r/${sub}`, url: `https://www.reddit.com/r/${sub}/`, kind: "subreddit" } : undefined,
    });
  }
  return { posts, subs };
}
export function parseGitHubIssues(json: any): Raw[] {
  const out: Raw[] = [];
  for (const x of json?.items ?? []) {
    if (x.pull_request) continue; // pull requests are solutions, not pains
    const repo = String(x.repository_url ?? "").match(/repos\/([^/]+\/[^/]+)$/)?.[1] ?? String(x.html_url ?? "").match(/github\.com\/([^/]+\/[^/]+)/)?.[1] ?? "";
    out.push({
      id: `gh:${x.html_url ?? x.id}`, source: "github", kind: "issue", title: clip(String(x.title ?? ""), 160), text: htmlText(String(x.body ?? "").replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ")).slice(0, 4000),
      url: String(x.html_url ?? ""), author: x.user?.login ? String(x.user.login) : undefined, at: Date.parse(x.created_at) || 0,
      points: Number(x.reactions?.total_count) || 0, comments: Number(x.comments) || 0,
      where: repo ? { id: `gh:${repo.toLowerCase()}`, label: repo, url: `https://github.com/${repo}`, kind: "repo" } : undefined,
    });
  }
  return out;
}
const SE_NAMES: Record<string, string> = { softwarerecs: "Software Recommendations", stackoverflow: "Stack Overflow", webapps: "Web Applications", superuser: "Super User", gamedev: "Game Development", android: "Android Enthusiasts", apple: "Ask Different", ux: "User Experience", productivity: "Productivity" };
export function parseSE(json: any, site: string): Raw[] {
  const out: Raw[] = [];
  const name = SE_NAMES[site] ?? site;
  for (const q of json?.items ?? []) {
    if (!q.link) continue;
    out.push({
      id: `se:${site}:${q.question_id}`, source: "se", kind: "question", title: clip(decode(String(q.title ?? "")), 160), text: htmlText(String(q.body ?? "")).slice(0, 4000),
      url: String(q.link), author: q.owner?.display_name ? decode(String(q.owner.display_name)) : undefined, at: (Number(q.creation_date) || 0) * 1000,
      points: Math.max(0, Number(q.score) || 0) + Math.round(Math.log10(1 + (Number(q.view_count) || 0)) * 2), comments: Number(q.answer_count) || 0,
      where: { id: `se:${site}`, label: name, url: `https://${site === "stackoverflow" || site === "superuser" ? `${site}.com` : `${site}.stackexchange.com`}/`, kind: "se" },
    });
  }
  return out;
}
export function parseAppSearch(json: any): App[] {
  return (json?.results ?? []).filter((a: any) => a.trackId && a.trackName).map((a: any) => ({
    id: String(a.trackId), name: clip(String(a.trackName), 80), url: String(a.trackViewUrl ?? `https://apps.apple.com/app/id${a.trackId}`).replace(/\?.*$/, ""),
    rating: a.averageUserRating ? Math.round(Number(a.averageUserRating) * 10) / 10 : undefined, ratings: Number(a.userRatingCount) || 0,
    price: a.formattedPrice ?? (a.price ? `$${a.price}` : "Free"), genre: a.primaryGenreName, desc: String(a.description ?? "").slice(0, 600),
  }));
}
export function parseAppReviews(json: any, app: App): Raw[] {
  const out: Raw[] = [];
  const entries = json?.feed?.entry;
  for (const e of Array.isArray(entries) ? entries : entries ? [entries] : []) {
    if (!e?.["im:rating"]) continue; // the first entry of older feeds is the app itself
    const rating = Number(e["im:rating"]?.label) || 0;
    out.push({
      id: `as:${e.id?.label ?? `${app.id}:${e.author?.name?.label}:${e.updated?.label}`}`, source: "appstore", kind: "review", title: clip(String(e.title?.label ?? ""), 160), text: String(e.content?.label ?? "").slice(0, 3000),
      url: `${app.url}?see-all=reviews`, author: e.author?.name?.label ? String(e.author.name.label) : undefined, at: Date.parse(e.updated?.label) || 0,
      points: Number(e["im:voteSum"]?.label) || 0, rating,
      where: { id: `app:${app.id}`, label: app.name, url: app.url, kind: "app" },
    });
  }
  return out;
}

// ── scoring, dedupe, clustering ─────────────────────────────────────────────────────────────
/** Which of the query's keywords a text mentions (word-prefix match, so "clip" hits "clips"). */
export function keywordHits(text: string, keywords: string[]) {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+#]+/g, " ")} `;
  return keywords.filter((k) => {
    const n = k.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
    // A phrase is a name: "human design" is not "human designers".
    if (n.includes(" ")) return new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(t);
    return hasTerm(t, n) || (n.length >= 8 && /er$/.test(n) && hasTerm(t, n.slice(0, -2)));
  });
}
/** Pain × relevance × engagement × recency. App reviews count a little less: short, about one app, not the wider need. */
export function scoreOf(r: Pick<Raw, "at" | "points" | "comments"> & { source?: SourceId }, pain: number, rel: number, now: number) {
  const src = r.source;
  const age = Math.max(0, (now - (r.at || now - 400 * DAY)) / DAY);
  const rec = Math.max(0.2, 0.5 ** (age / 180));
  const eng = 1 + Math.log10(1 + (r.points ?? 0) + 2 * (r.comments ?? 0)) / 2;
  return (0.4 + 0.6 * rel) * (0.4 + pain) * eng * rec * (src === "appstore" ? 0.6 : 1);
}
/** The part of a post that is about the query (see toEvidence). */
export function topicalScope(r: Pick<Raw, "title" | "text" | "source" | "where">, keywords: string[]) {
  const text = r.text ?? "";
  if (!keywords.length || r.source === "appstore" || keywordHits(`${r.title} ${r.where?.label ?? ""}`, keywords).length) return text.slice(0, 2000);
  const sents = text.split(/(?<=[.!?])\s+|\n+/);
  const keep = new Set<number>();
  sents.forEach((x, i) => { if (keywordHits(x, keywords).length) { keep.add(i); keep.add(i + 1); } });
  return [...keep].filter((i) => i < sents.length).sort((a, b) => a - b).map((i) => sents[i]).join(" ").slice(0, 2000);
}
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 110);
/** Score every post, drop what isn't about the query, dedupe (same id, or the same text cross-posted). */
export function toEvidence(raws: Raw[], keywords: string[], now: number, opts: { home?: Set<string> } = {}): Evidence[] {
  const seen = new Set<string>();
  // A named thing ("human design", "youtube", "osint") anchors the search: a post has to mention it.
  const anchor = !!keywords[0] && (keywords[0].includes(" ") || K_TECH.has(keywords[0]));
  const out: Evidence[] = [];
  for (const r of raws) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const full = `${r.title}\n${r.text}`;
    // A review is of an app the query found, so it's on topic even when it never names the topic.
    const hits = r.source === "appstore" ? keywords : keywordHits(`${full} ${r.where?.label ?? ""}`, keywords);
    const need = keywords.length >= 2 ? hits.includes(keywords[0]) || (!anchor && hits.length >= Math.max(2, Math.ceil(keywords.length * 0.6))) : hits.length >= 1;
    if (keywords.length && !need) continue;
    // When the topic has its own subreddit ("human design" → r/humandesign) it's a name, and elsewhere the same words
    // are often just words ("good human design"): outside its home a post needs it in the title, or a second keyword.
    if (opts.home?.size && r.source !== "appstore" && !opts.home.has(r.where?.id ?? "") && hits.length < 2 && !keywordHits(`${r.title} ${r.where?.label ?? ""}`, keywords.slice(0, 1)).length) continue;
    const dupe = normKey(r.text || r.title);
    if (dupe.length > 40 && seen.has(`t:${dupe}`)) continue;
    seen.add(`t:${dupe}`);
    // Pain counts where the topic is: the whole post when its title (or thread) is on topic, otherwise only the
    // sentences that mention the query and the one after each. A long list post that names the topic once can't
    // borrow every complaint it contains.
    const scope = topicalScope(r, keywords);
    const { pain, signals } = painOf(`${r.title}\n${scope}`, r.rating);
    // Five-star praise tells you what works, not what hurts: it stays out of the evidence.
    if (r.source === "appstore" && (r.rating ?? 0) >= 4 && pain < 2) continue;
    const rel = keywords.length ? Math.min(1, hits.length / Math.min(3, keywords.length)) : 0.5;
    const { text, ...rest } = r;
    out.push({ ...rest, author: r.author ? scrub(r.author).slice(0, 40) : undefined, title: scrub(r.title), snippet: snippetOf(scope, r.title), signals, pain: Math.round(pain * 10) / 10, rel: Math.round(rel * 100) / 100, score: Math.round(scoreOf(r, pain, rel, now) * 100) / 100 });
  }
  // One loud app's reviews shouldn't drown out every other voice: its best dozen stay.
  const perApp = new Map<string, number>();
  return out.sort((a, b) => b.score - a.score).filter((e) => { if (e.source !== "appstore") return true; const k = e.where?.id ?? ""; const n = (perApp.get(k) ?? 0) + 1; perApp.set(k, n); return n <= 12; });
}

const STOP = new Set(("a an the and or but nor for to of in on at by with without from into onto over under about above below after before between through during is are was were be been being am it its it's this that these those there here what which who whom whose when where why how i me my mine we us our ours you your yours he she they them their theirs one two three also just only even ever never always really very so too then than as if else can could would should will shall may might must do does did done doing have has had having get gets got getting make makes made making want wants wanted need needs needed like likes let lets use uses using used via per etc app apps application tool tools thing things stuff way ways people person user users everyone anyone someone somebody everybody new better best good great nice cool lot lots much many more most less some any all each every other another same such own not no yes out up down off again still now today yesterday tomorrow day days week weeks month months year years time times back first last next well much im ive id youre dont doesnt didnt cant isnt wasnt arent wont thats theres whats heres lets http https www com org html reddit comment comments link submitted post posts thread question answer answers edit update hi hello thanks thank please sorry ok okay yeah maybe actually basically literally probably pretty quite little big bit kind sort something anything everything nothing know think thought feel feels felt see seen look looking find found try tried trying go going goes went come came give take took say said says tell told work works worked working way able sure right wrong thing long free help keep keeps start started around since while though although because whether either neither both let's i'm i've i'd you're don't doesn't can't isn't that's there's what's here's it'll bad fix fixed fixing show showing shows shown point points stop stopped hard easy open opened run running put call called move set turn keep anymore ever since love loved wanna gonna gotta lol guys yall yal pls plz omg app's stuff part place reason case version everyone whole half full real totally completely super yes also enough else instead already again away almost less least far close bring brought mean means meant seem seems seemed happen happens happened become became probably definitely especially simply fine okay seriously honestly exactly anyway literally put gave given ago lately recently sometimes often usually always never every once twice minute minutes hour second seconds end ends ended top bottom side left high low old young huge tons ton kinda sorta via title build built update updated app store review reviews star stars rating version iphone android ios phone device current based friend friends family kid kids life world home house car school job company thing morning night week weekend today guy girl man woman men women mom dad wife husband thanks source sources example examples list lists option options case cases result results problem problems issue issues question questions answer answers different similar whole instead able guess myself yourself himself herself themselves ourselves itself anybody somebody nobody whatever whenever wherever maybe cause".split(" ")));
/** Words that say "it hurts" rather than what hurts: they find the posts, they don't name the theme. */
const SIGNAL_WORDS = new Set("wish pay paying paid frustrating frustrated frustration hate hated annoying annoyed annoys painful pain struggle struggling struggled tired sick alternative alternatives recommend recommendation recommendations request feature features please add love would exist exists existing tedious manually confusing complicated overwhelming broken buggy crash crashes crashing issue issues problem problems bug bugs anyone someone suggestion suggestions idea ideas".split(" "));
const singular = (w: string) => (w.length >= 5 && /[^s]s$/.test(w) && !/(ss|us|is|ous|ics|ies)$/.test(w) ? w.slice(0, -1) : w);
/** Content words and adjacent pairs of a text, minus the query's own words (every post has those). */
export function termsOf(text: string, exclude: Set<string>): Set<string> {
  const words = text.toLowerCase().replace(/[’']/g, "").replace(/\[(?:link|email hidden|phone hidden)\]/g, " ").split(/[^a-z0-9+#]+/).filter(Boolean);
  const out = new Set<string>();
  let prev = "";
  for (const raw of words) {
    const w = singular(raw);
    const ok = w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(raw) && !STOP.has(w) && !exclude.has(w) && !exclude.has(raw);
    if (ok && !SIGNAL_WORDS.has(w)) { out.add(w); if (prev) out.add(`${prev} ${w}`); prev = w; }
    else prev = "";
  }
  return out;
}
const CATS: [string, string, RegExp][] = [
  ["price", "Price & paywalls", /\b(price|pricing|expensive|subscription|paywall|pay|paid|cost|costs|trial|refund|money|premium|overpriced)\b/],
  ["bugs", "Bugs & reliability", /\b(crash\w*|bug|bugs|buggy|broken|slow|freez\w*|error|errors|glitch\w*|won'?t load|stopped working|sync)\b/],
  ["find", "Searching for a tool", /\b(is there an?|looking for|alternative|recommend\w*|anyone know|suggest\w*)\b/],
  ["manual", "Manual busywork", /\b(manual\w*|tedious|hours|automat\w*|workflow|repetitive|spreadsheet|copy paste|by hand)\b/],
  ["confusing", "Hard to use", /\b(confus\w*|complicated|overwhelm\w*|hard to (?:use|understand|read|learn)|interface|unintuitive|clunky)\b/],
  ["privacy", "Privacy & accounts", /\b(privacy|private|tracking|ads|account|login|sign ?up|personal data|data)\b/],
  ["trust", "Accuracy & trust", /\b(accura\w*|inaccurate|wrong|trust|quality|reliable|fake|scam|hallucinat\w*)\b/],
  ["missing", "Missing features", /\b(wish|missing|add|support|option|export|import|integrat\w*|would love|feature)\b/],
];
const cap = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Ai|Api|Ui|Ux|Pdf|Ios|Mcp|Llm|Rag|Hn|Osint|Hd|Tts|Seo|Gpt|Rss|Csv|3d)\b/g, (m) => m.toUpperCase());
/** A theme's pain in words ("Doing captions by hand"), from its category and its main term. */
export function painTitle(cat: string, term: string) {
  const catRe = CATS.find(([id]) => id === cat)?.[2];
  const t = term.toLowerCase();
  const generic = !!catRe && catRe.test(t);
  if (generic) return ({ price: "Subscriptions and paywalls", bugs: "Things that keep breaking", find: "Can't find the right tool", manual: "Busywork done by hand", confusing: "Too hard to use", privacy: "Privacy and account worries", trust: "Hard to trust the results", missing: "Missing features" } as Record<string, string>)[cat] ?? `${cap(t)} keeps coming up`;
  // "Captions: done by hand" reads right whatever part of speech the shared word is.
  const say: Record<string, string> = { price: "costs too much", bugs: "keeps breaking", find: "no good tool for it", manual: "done by hand", confusing: "too confusing", privacy: "privacy worries", trust: "hard to trust", missing: "missing features", signal: "keeps coming up" };
  return `${cap(t)}: ${say[cat] ?? say.signal}`;
}
/** One-line product ideas that answer a theme: deterministic, so the instant pass needs no model. */
export function ideaFor(cat: string, term: string, who: string, dir: Dir = "audience") {
  // "Subscription" under "Price & paywalls" would read "no subscription wall around subscription".
  const catRe = CATS.find(([id]) => id === cat)?.[2];
  const t = catRe && catRe.test(term.toLowerCase()) ? (dir === "idea" ? "it" : "this") : term.toLowerCase();
  // For an idea, a theme is an angle on it: what to lead with so it answers what people complain about.
  if (dir === "idea") switch (cat) {
    case "price": return `Win on price: no subscription wall around ${t}; people here resent paying monthly`;
    case "bugs": return `Win on reliability: ${t} that just works, offline, without losing anything`;
    case "find": return `Lead with ${t}: people are actively asking for a tool that does this`;
    case "manual": return `Automate the ${t} busywork people describe doing by hand`;
    case "confusing": return `Make ${t} dead simple: a guided first run, no setup`;
    case "privacy": return `Local-first ${t}: no account, the data stays on the device`;
    case "trust": return `Show the source behind every ${t} answer, so people can trust it`;
    case "missing": return `Ship the ${t} feature people say is missing everywhere else`;
    default: return `Build it around ${t}: it keeps coming up when people talk about this`;
  }
  const generic = t === "this";
  const x = generic ? "" : ` ${t}`; // " export", or nothing when the theme is the category itself
  switch (cat) {
    case "price": return generic ? `A fair one-time-price app for ${who}: no subscription, no paywall` : `${cap(t)} without the paywall: a fair one-time-price app for ${who}`;
    case "bugs": return `A dependable${x} app for ${who} that works offline and never loses their data`;
    case "find": return `The${x} tool ${who} keep asking for, done simply and well`;
    case "manual": return generic ? `Automate the busywork ${who} do by hand, in one tap` : `One-tap ${t} for ${who}: automate the hours of busywork`;
    case "confusing": return generic ? `A beginner-friendly app for ${who}, with a guided first run` : `${cap(t)}, made simple: a guided, beginner-friendly flow for ${who}`;
    case "privacy": return `A private, local-first${x} app for ${who}, no account needed`;
    case "trust": return generic ? `An app ${who} can trust: every answer shows its source` : `${cap(t)} that ${who} can trust: every answer shows its source`;
    case "missing": return `The missing${x} feature ${who} want, as a small focused app`;
    default: return `${/^ [aeiou]/.test(x) ? "An" : "A"}${x} app built around what ${who} say they need`;
  }
}
/**
 * Cluster evidence into pain themes by keyword overlap: the terms (and word pairs) that several posts share,
 * weighted by those posts' scores, greedily; each theme takes the posts that mention its term.
 */
export function clusterThemes(ev: Evidence[], keywords: string[], who: string, max = 8, dir: Dir = "audience"): Theme[] {
  const exclude = new Set(keywords.flatMap((k) => k.toLowerCase().split(/\s+/)).flatMap((w) => [w, singular(w), `${w}s`]));
  const docs = ev.map((e) => ({ e, terms: termsOf(`${e.title}. ${e.snippet}`, exclude) }));
  const df = new Map<string, number>(), weight = new Map<string, number>();
  for (const d of docs) for (const t of d.terms) { df.set(t, (df.get(t) ?? 0) + 1); weight.set(t, (weight.get(t) ?? 0) + d.e.score * (0.5 + d.e.pain / 4)); }
  const N = docs.length;
  const maxDf = Math.max(3, Math.floor(N * 0.45));
  const minUni = N >= 15 ? 3 : 2;
  const cands = [...weight].filter(([t]) => (df.get(t) ?? 0) >= (t.includes(" ") ? 2 : minUni) && (df.get(t) ?? 0) <= maxDf)
    .map(([t, w]) => [t, w * (t.includes(" ") ? 1.6 : t.length >= 6 ? 1.2 : t.length <= 3 ? 0.6 : 1)] as const).sort((a, b) => b[1] - a[1]);
  const used = new Set<Evidence>();
  const themes: Theme[] = [];
  for (const [term] of cands) {
    if (themes.length >= max) break;
    if (themes.some((th) => th.terms.includes(term) || th.terms.some((x) => x.split(" ").includes(term) || term.split(" ").includes(x)))) continue;
    const members = docs.filter((d) => !used.has(d.e) && d.terms.has(term));
    if (members.length < 2) continue;
    // One app's reviews or one thread saying the same thing isn't a theme yet: it needs two places or four voices.
    if (members.length < 4 && new Set(members.map((m) => m.e.where?.id ?? m.e.id)).size < 2) continue;
    // A second term the members share makes the label specific ("birth time · accuracy").
    const co = new Map<string, number>();
    for (const m of members) for (const t of m.terms) if (t !== term && !term.includes(t) && !t.includes(term) && (df.get(t) ?? 0) <= maxDf) co.set(t, (co.get(t) ?? 0) + 1);
    const second = [...co].filter(([, n]) => n >= Math.max(2, Math.ceil(members.length * 0.4))).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0];
    const terms = [term, ...(second && !term.includes(" ") ? [second] : [])];
    for (const m of members) used.add(m.e);
    const es = members.map((m) => m.e).sort((a, b) => b.score - a.score);
    const text = es.map((e) => `${e.title} ${e.snippet}`).join(" \n ").toLowerCase().replace(/[’]/g, "'");
    const catHits = CATS.map(([id, label, re]) => [id, label, (text.match(new RegExp(re.source, "g")) ?? []).length] as const).sort((a, b) => b[2] - a[2]);
    const [cat, catLabel] = catHits[0][2] >= 2 ? [catHits[0][0], catHits[0][1]] : ["signal", "Recurring topic"];
    const score = es.reduce((a, e) => a + e.score, 0);
    themes.push({
      id: slugify(terms.join(" "), 40) || `t${themes.length}`, title: painTitle(cat, terms[0]), label: cap(terms.join(" · ")), cat, catLabel, terms, n: es.length,
      sources: [...new Set(es.map((e) => e.source))], score: Math.round(score * 100) / 100, heat: Math.round((es.reduce((a, e) => a + e.pain, 0) / es.length) * 10) / 10,
      idea: ideaFor(cat, terms[0], who, dir), ids: es.map((e) => e.id), quotes: es.slice(0, 3),
    });
  }
  return themes.sort((a, b) => b.score - a.score);
}
/** Where the people who wrote these hang out: subreddits, HN threads, repos, SE sites and apps, by activity. */
export function placesOf(ev: Evidence[], extra: Place[] = [], now = Date.now()): Place[] {
  const m = new Map<string, Place>();
  for (const e of ev) {
    if (!e.where) continue;
    const p = m.get(e.where.id) ?? { ...e.where, source: e.source, n: 0, last: 0, eng: 0 };
    p.n++; p.last = Math.max(p.last, e.at); p.eng += (e.points ?? 0) + 2 * (e.comments ?? 0);
    m.set(e.where.id, p);
  }
  for (const x of extra) { const p = m.get(x.id); if (p) Object.assign(p, { desc: p.desc ?? x.desc, rating: x.rating ?? p.rating, ratings: x.ratings ?? p.ratings, price: x.price ?? p.price }); else m.set(x.id, { ...x }); }
  const act = (p: Place) => (p.n + 0.6) * (1 + Math.log10(1 + p.eng) / 2) * (p.last ? Math.max(0.3, 0.5 ** ((now - p.last) / DAY / 120)) : 0.5);
  return [...m.values()].sort((a, b) => act(b) - act(a)).slice(0, 24);
}
/** Subreddits named after the query's main topic (r/humandesign for "human design"): where it's a name, not words. */
export function homeSubs(subs: Place[], keywords: string[]) {
  const k = (coreOf(keywords)[0] ?? "").replace(/[^a-z0-9]/g, "");
  return new Set(k.length >= 4 ? subs.filter((p) => p.id.replace(/^r\//, "").replace(/[^a-z0-9]/g, "").includes(k)).map((p) => p.id) : []);
}
const PROPER = /^(Human|Hebrew|Israeli|OSINT|Polymarket|TikTok|YouTube|Obsidian|Claude|Gumroad|Telegram|Reddit|Discord|I\b|AI\b)/;
/** "Podcasters who clip…" reads as "podcasters who clip…" mid-sentence; names keep their capitals. */
export function whoOf(text: string, dir: Dir, keywords: string[]) {
  if (dir === "idea") return `people who want ${keywords.slice(0, 2).join(" and ") || "this"}`;
  let t = text.trim().replace(/[.!?]+$/, "");
  if (t.length > 70) t = t.slice(0, 70).replace(/\s+\S*$/, "");
  return PROPER.test(t) ? t : t[0].toLowerCase() + t.slice(1);
}
export function analyze(inp: { raws: Raw[]; keywords: string[]; text: string; dir: Dir; subs?: Place[]; apps?: App[]; now?: number }) {
  const now = inp.now ?? Date.now();
  const home = homeSubs(inp.subs ?? [], inp.keywords);
  const all = toEvidence(inp.raws, inp.keywords, now, { home });
  const who = whoOf(inp.text, inp.dir, inp.keywords);
  const themes = clusterThemes(all.filter((e) => e.pain >= 1.5), inp.keywords, who, 8, inp.dir);
  const appPlaces: Place[] = (inp.apps ?? []).map((a) => ({ id: `app:${a.id}`, label: a.name, url: a.url, kind: "app", source: "appstore", n: 0, last: 0, eng: 0, rating: a.rating, ratings: a.ratings, price: a.price }));
  // A Hacker News thread is a place people gather only when several of them spoke there, or it's about the topic.
  const places = placesOf(all, [...(inp.subs ?? []), ...appPlaces], now).filter((p) => p.kind !== "hn" || p.n >= 2 || keywordHits(p.label, inp.keywords.slice(0, 2)).length > 0);
  // The page gets the best 60, plus every post a theme quotes.
  const keep = new Set([...all.slice(0, 60), ...themes.flatMap((t) => all.filter((e) => t.ids.slice(0, 12).includes(e.id)))]);
  const evidence = all.filter((e) => keep.has(e));
  const builders: Builder[] = all.filter((e) => e.source === "hn" && e.kind === "story" && /^(show|launch) hn\b/i.test(e.title) && keywordHits(e.title, inp.keywords.slice(0, 3)).length > 0)
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0)).slice(0, 8).map((e) => ({ title: e.title, url: e.url, points: e.points ?? 0, comments: e.comments ?? 0, at: e.at }));
  const bySource: Partial<Record<SourceId, number>> = {};
  for (const e of all) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  return { themes, evidence, places, builders, bySource, counts: { posts: all.length, pains: all.filter((e) => e.pain > 0).length, places: places.length } };
}

// ── queries: what goes to each site (only the query's words) ─────────────────────────────────
const K_PHRASES = ["human design", "i ching", "prediction market", "open source", "second brain", "self host", "coding agent", "ai agent", "knowledge base", "digital product", "small business", "indie game", "game dev", "browser game", "short form", "speech to text", "text to speech", "machine learning", "chrome extension", "browser extension", "mobile app", "real time", "birth chart", "natal chart", "home screen", "side project", "social media", "tarot reading", "explainer video", "youtube channel"];
const K_HYPHEN: Record<string, string> = { "right-to-left": "rtl", "burned-in": "burned", "hebrew-speaking": "hebrew", "english-speaking": "english", "self-hosters": "self host", "self-hoster": "self host", "self-hosted": "self host", "self-hosting": "self host", "open-source": "open source", "prediction-market": "prediction market", "short-form": "short form", "one-click": "", "day-by-day": "" };
const K_STOP = new Set(("a an the and or but for to of in on at by with from into over about after before is are was were be been it its this that these those there here what which who whom whose when where why how i me my we our you your he she they them their one two three five also just only even ever really very so too then than as if can could would should will may might must do does did have has had get gets make makes made want wants need needs like let use uses using used via per app apps application tool tools thing things stuff way people person user users everyone anyone someone new better best good great cool amazing awesome big small little tiny idea something anything everything automatically instantly easy easily every each all any some many much more most lot lots kind type day days time year years week today tomorrow now soon later know see show turn turns take takes put keep go come find look feel think tell say says said ask work working not no own same other another such while until because since though whether both around across along within onto toward entirely completely favourite favorite build builds building built create creates creating share shares sharing run runs running long several move moves follow past daily public online short personal base answer answers click post posts read reads proper speaking whole entire first last next machine machines once evening morning night explain explains explaining remember remembers question questions solo source sources ever everything said").split(" "));
/** What people actually type: "YouTube" more than "YouTuber", "my podcast" more than "podcaster". */
const K_CANON: Record<string, string> = { youtuber: "youtube", podcaster: "podcast", tiktoker: "tiktok", astrologer: "astrology", blogger: "blog", vlogger: "vlog", redditor: "reddit" };
const K_TECH = new Set("podcast podcaster youtube youtuber tiktok reel reels telegram osint astrology astrologer tarot hebrew obsidian gumroad polymarket voice video clip caption subtitle game dashboard agent chart transit bot ai llm rag mcp quiz funnel dub translation newsletter rtl faceless compatibility citation timestamp explainer notion discord whatsapp spotify shopify etsy twitch".split(" "));
/** Roles that say who, not what: in an audience they sort after the words that say what they care about. */
const K_ROLE = new Set("developer dev creator owner reader user fan founder maker builder seller buyer beginner enthusiast lover hobbyist practitioner student teacher coach trader writer artist designer marketer manager freelancer admin player customer".split(" "));
const K_KEEP_S = new Set("odds news series species analytics physics politics economics ethics graphics metrics lyrics statistics mathematics always".split(" "));
const kSingular = (w: string) => (w.length < 4 || K_KEEP_S.has(w) ? w : /(ch|sh|x|ss)es$/.test(w) ? w.slice(0, -2) : /ies$/.test(w) && w.length > 4 ? `${w.slice(0, -3)}y` : /[^s]s$/.test(w) && !/(us|is|ous)$/.test(w) ? w.slice(0, -1) : w);
/**
 * The words of an idea or an audience worth searching for. Ideas lead with named things (phrases, tech and domain
 * words); audiences keep the order you wrote them in, with generic roles ("readers", "owners") last.
 */
export function keywordsFor(text: string, dir: Dir, max = 6): string[] {
  let t = ` ${String(text).toLowerCase().replace(/[’']/g, "")} `;
  for (const [h, r] of Object.entries(K_HYPHEN)) t = t.split(h).join(` ${r} `);
  t = ` ${t.replace(/-/g, " ").replace(/[^a-z0-9+#\s]/g, " ").replace(/\s+/g, " ")} `;
  const found: { k: string; pos: number; score: number }[] = [];
  for (const p of K_PHRASES) {
    const m = new RegExp(` ${p.replace(/ /g, " ")}(?:s|es|ing|ed|ers?)? `).exec(t);
    if (m) { found.push({ k: p, pos: m.index, score: 3 }); t = t.slice(0, m.index) + " ".repeat(m[0].length - 1) + t.slice(m.index + m[0].length - 1); }
  }
  let next = 0;
  for (const raw of t.split(" ")) {
    const pos = next;
    next += raw.length + 1;
    if (!raw || K_STOP.has(raw) || /^\d+$/.test(raw)) continue;
    const w = K_CANON[kSingular(raw)] ?? kSingular(raw);
    if (K_STOP.has(w) || (w.length < 3 && !["ai", "3d", "hd", "vr", "ar", "ui"].includes(w))) continue;
    if (found.some((f) => f.k === w || f.k.split(" ").includes(w))) continue;
    found.push({ k: w, pos, score: K_TECH.has(w) ? 2 : w.length >= 7 ? 1.5 : 1 });
  }
  const role = (k: string) => K_ROLE.has(k);
  const sorted = dir === "audience"
    ? found.sort((a, b) => Number(role(a.k)) - Number(role(b.k)) || a.pos - b.pos)
    : found.sort((a, b) => b.score - a.score || a.pos - b.pos);
  return sorted.map((f) => f.k).slice(0, max);
}
/** The words that say what an audience cares about, without its roles: "human design", not "readers". */
export const coreOf = (kw: string[]) => { const c = kw.filter((k) => !K_ROLE.has(k)); return c.length ? c : kw; };
const phrase = (k: string) => (/\s/.test(k) ? `"${k}"` : k);

// ── the network side: timeouts, rate limits, per-source fetchers ─────────────────────────────
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; text(): Promise<string> }>;
type Http = { ok: boolean; status: number; body: string; headers: { get(k: string): string | null }; error?: string };
/** A GET with a hard deadline; a dropped connection (not a timeout) is retried once, since those are usually transient. */
async function httpGet(f: FetchLike, url: string, ms: number, headers: Record<string, string> = {}): Promise<Http> {
  const t0 = Date.now();
  const r = await httpGet1(f, url, ms, headers);
  if (r.status === 0 && r.error !== "didn't answer in time" && Date.now() - t0 < ms / 2) { await Bun.sleep(250); return httpGet1(f, url, ms - (Date.now() - t0), headers); }
  return r;
}
async function httpGet1(f: FetchLike, url: string, ms: number, headers: Record<string, string> = {}): Promise<Http> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await Promise.race([
      f(url, { headers: { "user-agent": UA, accept: "application/json, application/atom+xml;q=0.9, */*;q=0.5", ...headers }, signal: ctl.signal }),
      new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("timeout")))),
    ]);
    const body = await Promise.race([r.text(), new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("timeout"))))]);
    return { ok: r.ok, status: r.status, body, headers: r.headers };
  } catch (e: any) {
    return { ok: false, status: 0, body: "", headers: { get: () => null }, error: ctl.signal.aborted ? "didn't answer in time" : e?.message ?? String(e) };
  } finally { clearTimeout(timer); }
}
const parseJson = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
export type SourceOut = { raws: Raw[]; subs?: Place[]; apps?: App[]; error?: string; skipped?: string };
export type Limits = { redditUntil: number; ghRemaining: number; ghReset: number; seQuota: number; seUntil: number };

export type SourceCtx = { fetch: FetchLike; gh: (args: string[], timeoutMs?: number) => Promise<GhRes>; limits: Limits; now: number; timeout: number; note?: (s: SourceId, msg: string) => void };
/** The longest Reddit's per-search wait is sat out (the rest of the results are on screen meanwhile). */
export let REDDIT_WAIT = 35_000;
export const setRedditWait = (ms: number) => { REDDIT_WAIT = ms; };
/** Each fetcher: never throws, never waits past its timeout, says why when it has nothing. */
export const FETCHERS: Record<SourceId, (kw: string[], dir: Dir, c: SourceCtx) => Promise<SourceOut>> = {
  async hn(all, dir, c) {
    const kw = coreOf(all);
    const since = Math.floor((c.now - 540 * DAY) / 1000);
    const qs = [kw.slice(0, 3).join(" "), kw.slice(0, 2).join(" ")].filter((x, i, a) => x && a.indexOf(x) === i);
    const res = await Promise.all(qs.map((q) => httpGet(c.fetch, `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=40`, c.timeout)));
    const ok = res.filter((r) => r.ok);
    if (!ok.length) return { raws: [], error: res[0]?.error ?? `Hacker News said ${res[0]?.status}` };
    return { raws: ok.flatMap((r) => parseHN(parseJson(r.body))) };
  },
  async reddit(all, dir, c) {
    const kw = coreOf(all);
    // Reddit's JSON search is closed to keyless readers; its Atom search feed is open but allows about one read in
    // fifteen seconds. A search makes one request; when Reddit says "come back in a few seconds" it waits (the other
    // sources show meanwhile) and tries once more, and it never waits longer than REDDIT_WAIT.
    // An audience's own words bring back everything they post; asking for the ways people voice a need finds the pains.
    const q = dir === "audience" ? `${kw.slice(0, 2).map(phrase).join(" ")} (app OR tool OR wish OR frustrating OR "is there" OR struggling)` : kw.slice(0, 3).map(phrase).join(" ");
    const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=relevance&t=year&limit=60`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = c.limits.redditUntil - Date.now();
      if (wait > REDDIT_WAIT) return { raws: [], skipped: `Reddit asks to wait ${Math.ceil(wait / 1000)}s between searches` };
      if (wait > 0) { c.note?.("reddit", `Waiting ${Math.ceil(wait / 1000)}s for Reddit's rate limit`); await Bun.sleep(wait + 300); }
      const r = await httpGet(c.fetch, url, c.timeout);
      const reset = Number(r.headers.get("x-ratelimit-reset")) || 0;
      const remaining = Number(r.headers.get("x-ratelimit-remaining") ?? "1");
      if (r.status === 429) { const back = reset || 15; c.limits.redditUntil = Date.now() + back * 1000; if (attempt === 0 && back * 1000 <= REDDIT_WAIT) continue; return { raws: [], error: `Reddit is rate-limiting; try again in ${back}s` }; }
      if (r.status === 403) { c.limits.redditUntil = Date.now() + 60_000; return { raws: [], error: "Reddit refused the search (403)" }; }
      if (remaining < 1 && reset) c.limits.redditUntil = Date.now() + reset * 1000;
      if (!r.ok) return { raws: [], error: r.error ?? `Reddit said ${r.status}` };
      const { posts, subs } = parseRedditAtom(r.body);
      return { raws: posts, subs };
    }
    return { raws: [], error: "Reddit is rate-limiting" };
  },
  async github(all, dir, c) {
    const kw = coreOf(all);
    // Shares GitHub's 30-searches-a-minute budget with Discover: two searches, and none when the budget is low.
    if (c.limits.ghRemaining <= 6 && Date.now() < c.limits.ghReset) return { raws: [], skipped: `GitHub's search limit is busy; back in ${Math.ceil((c.limits.ghReset - Date.now()) / 1000)}s` };
    const base = kw.slice(0, dir === "audience" ? 2 : 3).map(phrase).join(" ");
    const since = new Date(c.now - 540 * DAY).toISOString().slice(0, 10);
    const queries: [string, string[]][] = [
      [`${base} is:issue`, ["sort=reactions", "order=desc", "per_page=30"]],
      [`${base} is:issue created:>${since}`, ["sort=comments", "order=desc", "per_page=30"]],
    ];
    const res = await Promise.all(queries.map(([q, extra]) => c.gh(["-X", "GET", "search/issues", "-f", `q=${q}`, ...extra.flatMap((x) => ["-f", x])], c.timeout)));
    for (const r of res) {
      if (r.remaining != null) { c.limits.ghRemaining = r.remaining; c.limits.ghReset = r.reset ?? Date.now() + 60_000; }
      if (!r.ok && (r.status === 403 || r.status === 429)) { c.limits.ghRemaining = 0; c.limits.ghReset = r.reset ?? Date.now() + 60_000; }
    }
    const ok = res.filter((r) => r.ok);
    if (!ok.length) return { raws: [], error: res[0]?.error ?? "GitHub search failed" };
    return { raws: ok.flatMap((r) => parseGitHubIssues(r.data)) };
  },
  async se(all, dir, c) {
    const kw = coreOf(all);
    // No key: 300 requests a day per address. Two sites a search, and it stops well before the quota runs out.
    if (Date.now() < c.limits.seUntil) return { raws: [], skipped: "Stack Exchange asked us to back off for a moment" };
    if (c.limits.seQuota < 25) return { raws: [], skipped: "Stack Exchange's daily quota is nearly used; skipped to save it" };
    const sites = ["softwarerecs", dir === "idea" ? "stackoverflow" : "webapps"];
    const q = kw.slice(0, 2).join(" ");
    const from = Math.floor((c.now - 3 * 365 * DAY) / 1000);
    const res = await Promise.all(sites.map((site) => httpGet(c.fetch, `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=${site}&pagesize=25&fromdate=${from}&filter=withbody`, c.timeout)));
    const raws: Raw[] = [];
    let err = "";
    res.forEach((r, i) => {
      const j = parseJson(r.body);
      if (j?.quota_remaining != null) c.limits.seQuota = Number(j.quota_remaining);
      if (j?.backoff) c.limits.seUntil = Date.now() + Number(j.backoff) * 1000;
      if (r.ok && j) raws.push(...parseSE(j, sites[i]));
      else err ||= j?.error_message ?? r.error ?? `Stack Exchange said ${r.status}`;
    });
    return raws.length || !err ? { raws } : { raws, error: err };
  },
  async appstore(all, dir, c) {
    const kw = coreOf(all);
    // The App Store's public search and review feeds: the apps people already use, and what they complain about.
    const term = kw.slice(0, dir === "audience" ? 1 : 2).join(" ");
    const s = await httpGet(c.fetch, `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=8&country=us`, c.timeout);
    if (!s.ok) return { raws: [], error: s.error ?? `The App Store said ${s.status}` };
    const found = parseAppSearch(parseJson(s.body));
    // An app counts when its name and description mention the query's main words (two of them, when there are two).
    const need = Math.min(2, kw.length);
    const apps = found.filter((a: any) => keywordHits(`${a.name} ${a.desc ?? ""}`, kw.slice(0, 3)).length >= need).map(({ desc, ...a }: any) => a as App);
    const top = [...apps].sort((a, b) => (b.ratings ?? 0) - (a.ratings ?? 0)).slice(0, 3);
    const res = await Promise.all(top.map((a) => httpGet(c.fetch, `https://itunes.apple.com/us/rss/customerreviews/page=1/id=${a.id}/sortby=mostrecent/json`, c.timeout)));
    const raws = res.flatMap((r, i) => (r.ok ? parseAppReviews(parseJson(r.body), top[i]) : []));
    return { raws, apps: apps.slice(0, 6) };
  },
};

