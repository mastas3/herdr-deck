import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { GhRes } from "../src/gh";
import {
  analyze, clusterThemes, createLeads, deepPrompt, htmlText, ideaFor, keywordHits, keywordsFor, listReports, painOf, parseAppReviews, parseAppSearch,
  parseGitHubIssues, parseHN, parseRedditAtom, parseSE, planPrompt, scrub, setRedditWait, snippetOf, starters, surprise, toEvidence, whoOf, type Evidence, type FetchLike, type Raw,
} from "../src/leads";

const root = mkdtempSync(`${tmpdir()}/deck-leads-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86_400_000;
const sec = (daysAgo: number) => Math.floor((NOW - daysAgo * DAY) / 1000);
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

// ── fixtures: what each source really returns (trimmed) ─────────────────────────────
const HN = {
  hits: [
    { _tags: ["story", "author_ann", "story_101", "show_hn"], objectID: "101", title: "Show HN: A podcast clip finder", url: "https://x.dev", author: "ann", points: 120, num_comments: 40, created_at_i: sec(20), story_text: null },
    { _tags: ["comment", "author_bob", "story_101"], objectID: "102", story_id: 101, story_title: "Show HN: A podcast clip finder", author: "bob", created_at_i: sec(10),
      comment_text: "I wish this existed last year. Clipping my podcast by hand is so tedious &amp; I&#x27;d pay for it. Mail me at bob.smith@example.com or call +1 (415) 555-0133." },
    { _tags: ["comment", "author_cy", "story_200"], objectID: "103", story_id: 200, story_title: "Ask HN: What are you working on?", author: "cy", created_at_i: sec(400), comment_text: "Mostly gardening. Nothing about audio." },
  ],
};
const REDDIT = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><author><name>/u/modteam</name></author><content type="html">&lt;div&gt; A place for podcasters &lt;/div&gt;</content><id>t5_abc</id><link href="https://www.reddit.com/r/podcasting/" /><updated>2012-10-26T06:50:01+00:00</updated><title>podcasting</title></entry>
<entry><author><name>/u/clipper42</name><uri>https://www.reddit.com/user/clipper42</uri></author><category term="podcasting" label="r/podcasting"/><content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Is there an app that cuts my podcast into short clips? I&amp;#39;m tired of doing it manually in Premiere.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; submitted by &lt;a href="https://www.reddit.com/user/clipper42"&gt; /u/clipper42 &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href="https://www.reddit.com/r/podcasting/comments/1abc/x/"&gt;[link]&lt;/a&gt;&lt;/span&gt;</content><id>t3_1abc</id><link href="https://www.reddit.com/r/podcasting/comments/1abc/is_there_an_app/" /><updated>${iso(5)}</updated><title>Is there an app to clip podcast episodes?</title></entry>
<entry><author><name>/u/other</name></author><category term="gaming" label="r/gaming"/><content type="html">&lt;p&gt;Great game clip&lt;/p&gt;</content><id>t3_2xyz</id><link href="https://www.reddit.com/r/gaming/comments/2xyz/clip/" /><updated>${iso(3)}</updated><title>Look at this clip</title></entry>
</feed>`;
const GH = {
  items: [
    { html_url: "https://github.com/acme/clipper/issues/7", repository_url: "https://api.github.com/repos/acme/clipper", title: "Feature request: export podcast clips as vertical video", body: "Would be great if I could export 9:16 clips.\n```js\nsecret code\n```", user: { login: "dev1" }, comments: 12, reactions: { total_count: 30 }, created_at: iso(30) },
    { html_url: "https://github.com/acme/clipper/pull/8", repository_url: "https://api.github.com/repos/acme/clipper", title: "Add vertical export", pull_request: { url: "x" }, body: "", user: { login: "dev2" }, created_at: iso(29) },
  ],
};
const SE = { quota_remaining: 280, items: [{ question_id: 55, link: "https://softwarerecs.stackexchange.com/questions/55/x", title: "Tool to cut podcast episodes into clips?", body: "<p>I'm looking for a tool that finds the best moments in a podcast.</p>", owner: { display_name: "Q&amp;A fan" }, score: 4, view_count: 900, answer_count: 2, creation_date: sec(100) }] };
const APPS = { results: [
  { trackId: 1, trackName: "ClipCast: podcast clips", trackViewUrl: "https://apps.apple.com/us/app/clipcast/id1?uo=4", averageUserRating: 3.9, userRatingCount: 1200, formattedPrice: "Free", primaryGenreName: "Productivity", description: "Turn your podcast into clips" },
  { trackId: 2, trackName: "Candy Blast", trackViewUrl: "https://apps.apple.com/us/app/candy/id2", averageUserRating: 4.8, userRatingCount: 99999, description: "A match-3 game" },
] };
const REVIEWS = { feed: { entry: [
  { author: { name: { label: "ann_b" } }, updated: { label: iso(2) }, "im:rating": { label: "1" }, id: { label: "r1" }, title: { label: "Subscription trap" }, content: { label: "Too expensive and the export keeps crashing. I'd pay once, not monthly." }, "im:voteSum": { label: "3" } },
  { author: { name: { label: "happy" } }, updated: { label: iso(2) }, "im:rating": { label: "5" }, id: { label: "r2" }, title: { label: "Love it" }, content: { label: "Works great." } },
] } };

describe("text", () => {
  test("htmlText decodes entities and escaped HTML", () => {
    expect(htmlText("&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;")).toBe("Hi & bye");
    expect(htmlText("<p>It&#x27;s <b>ok</b></p><p>next</p>")).toBe("It's ok\nnext");
  });
  test("scrub removes emails and phone numbers, keeps dates and small numbers", () => {
    const s = scrub("mail a.b+c@mail.example.org, call +44 20 7946 0958 or (415) 555-0133; on 2026-09-26 I paid 49 dollars for 1,000 clips; see https://x.com/a?token=1");
    expect(s).not.toMatch(/@/);
    expect(s).not.toMatch(/7946|555-0133/);
    expect(s).toContain("2026-09-26");
    expect(s).toContain("49 dollars");
    expect(s).toContain("[link]");
  });
  test("snippet starts at the pain and stays short", () => {
    const long = `${"Some background about my week. ".repeat(12)}Honestly I wish there was an app for this, it's so tedious. ${"More filler text here. ".repeat(10)}`;
    const sn = snippetOf(long);
    expect(sn.length).toBeLessThanOrEqual(240);
    expect(sn).toContain("I wish");
  });
});

describe("pain signals", () => {
  test("strong phrases score higher than weak ones", () => {
    const strong = painOf("Is there an app for this? I'd pay for it.");
    const weak = painOf("How do you do this?");
    const none = painOf("Here is my new blog post.");
    expect(strong.signals).toEqual(expect.arrayContaining(["is there an app", "would pay"]));
    expect(strong.pain).toBeGreaterThan(weak.pain);
    expect(weak.pain).toBeGreaterThan(0);
    expect(none.pain).toBe(0);
  });
  test("curly apostrophes and low ratings count", () => {
    expect(painOf("I’d pay for this").signals).toContain("would pay");
    const r = painOf("meh", 1);
    expect(r.pain).toBeGreaterThan(2);
    expect(r.signals).toContain("1★ review");
  });
  test("capped so one rant can't dominate", () => expect(painOf("I wish. Frustrating. I hate that. Annoying. Is there an app? I'd pay. Tired of it. Tedious. Doesn't exist.").pain).toBeLessThanOrEqual(7));
});

describe("parsers", () => {
  test("Hacker News: stories and comments, thread as the place", () => {
    const r = parseHN(HN);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ id: "hn:101", kind: "story", points: 120, url: "https://news.ycombinator.com/item?id=101" });
    expect(r[1]).toMatchObject({ kind: "comment", author: "bob", where: { id: "hn:101", kind: "hn" } });
    expect(r[1].text).toContain("I'd pay");
    expect(parseHN({})).toEqual([]);
  });
  test("Reddit Atom: subreddits and posts, footer stripped", () => {
    const { posts, subs } = parseRedditAtom(REDDIT);
    expect(subs).toEqual([expect.objectContaining({ id: "r/podcasting", label: "r/podcasting", kind: "subreddit" })]);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ id: "rd:t3_1abc", author: "u/clipper42", where: { label: "r/podcasting" }, url: "https://www.reddit.com/r/podcasting/comments/1abc/is_there_an_app/" });
    expect(posts[0].text).toContain("I'm tired of doing it manually");
    expect(posts[0].text).not.toContain("submitted by");
    expect(parseRedditAtom("<html>blocked</html>")).toEqual({ posts: [], subs: [] });
  });
  test("GitHub issues: pull requests and code blocks left out", () => {
    const r = parseGitHubIssues(GH);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: "github", points: 30, comments: 12, author: "dev1", where: { label: "acme/clipper", kind: "repo" } });
    expect(r[0].text).not.toContain("secret code");
  });
  test("Stack Exchange", () => {
    const r = parseSE(SE, "softwarerecs");
    expect(r[0]).toMatchObject({ source: "se", author: "Q&A fan", where: { label: "Software Recommendations" } });
    expect(r[0].text).toContain("looking for a tool");
  });
  test("App Store search and reviews", () => {
    const apps = parseAppSearch(APPS);
    expect(apps[0]).toMatchObject({ id: "1", name: "ClipCast: podcast clips", url: "https://apps.apple.com/us/app/clipcast/id1", rating: 3.9, ratings: 1200 });
    const rv = parseAppReviews(REVIEWS, apps[0]);
    expect(rv).toHaveLength(2);
    expect(rv[0]).toMatchObject({ rating: 1, author: "ann_b", where: { id: "app:1", kind: "app" } });
    expect(parseAppReviews({ feed: {} }, apps[0])).toEqual([]);
  });
});

describe("keywords", () => {
  test("audiences keep their order, generic roles last, and what people type", () => {
    expect(keywordsFor("Human Design readers and coaches", "audience")).toEqual(["human design", "reader", "coach"]);
    expect(keywordsFor("Podcasters who clip episodes for TikTok", "audience").slice(0, 2)).toEqual(["podcast", "clip"]);
    expect(keywordsFor("Hebrew-speaking small business owners", "audience")).toEqual(["hebrew", "small business", "owner"]);
  });
  test("ideas lead with named things", () => {
    expect(keywordsFor("A morning voice note that explains today's transits for my Human Design chart", "idea")[0]).toBe("human design");
    expect(keywordsFor("Chat with everything a YouTuber ever said", "idea")[0]).toBe("youtube");
  });
  test("matching is word-prefix, with a stem for -er words", () => {
    expect(keywordHits("Clipping my podcasts", ["clip", "podcast"])).toEqual(["clip", "podcast"]);
    expect(keywordHits("our YouTube channel", ["youtuber"])).toEqual(["youtuber"]);
    expect(keywordHits("storage", ["rag"])).toEqual([]);
  });
});

describe("evidence, themes, places", () => {
  const raws: Raw[] = [...parseHN(HN), ...parseRedditAtom(REDDIT).posts, ...parseGitHubIssues(GH), ...parseSE(SE, "softwarerecs"), ...parseAppReviews(REVIEWS, parseAppSearch(APPS)[0])];
  const kw = ["podcast", "clip"];
  test("off-topic posts drop out, five-star praise too, pain ranks first", () => {
    const ev = toEvidence(raws, kw, NOW);
    const ids = ev.map((e) => e.id);
    expect(ids).not.toContain("hn:103"); // gardening
    expect(ids).not.toContain("rd:t3_2xyz"); // a game clip: no podcast
    expect(ids).not.toContain("as:r2"); // 5★ "works great"
    expect(ids).toContain("as:r1");
    expect(ev[0].pain).toBeGreaterThan(0);
    for (let i = 1; i < ev.length; i++) expect(ev[i - 1].score).toBeGreaterThanOrEqual(ev[i].score);
  });
  test("dedupe: the same id or the same text cross-posted counts once", () => {
    const base = parseRedditAtom(REDDIT).posts[0];
    const cross = { ...base, id: "rd:t3_other", where: { id: "r/podcasts", label: "r/podcasts", url: "u", kind: "subreddit" as const } };
    expect(toEvidence([base, base, cross], kw, NOW)).toHaveLength(1);
  });
  test("no email or phone number survives into the output", () => {
    const withAuthor: Raw = { ...parseHN(HN)[1], author: "call me 415 555 0133" };
    const res = analyze({ raws: [...raws, withAuthor], keywords: kw, text: "podcast clips", dir: "idea", now: NOW });
    const out = JSON.stringify(res);
    expect(out).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(out).not.toMatch(/555[\s-]?0133/);
  });
  test("themes cluster posts that share a term, across places", () => {
    const mk = (id: string, where: string, text: string, pain = 3): Evidence => ({ id, source: "reddit", kind: "post", title: "", snippet: text, url: `https://r/${id}`, at: NOW - DAY, signals: ["I wish"], pain, rel: 1, score: pain, where: { id: where, label: where, url: "", kind: "subreddit" } });
    const ev = [
      mk("a", "r/a", "I wish the podcast app could export captions as SRT files"),
      mk("b", "r/b", "Exporting captions is broken, captions drift every time"),
      mk("c", "r/c", "Frustrating: captions never line up after export"),
      mk("d", "r/a", "The pricing is too expensive for hobby podcasters, subscription again"),
      mk("e", "r/d", "Another subscription, overpriced pricing for a simple tool"),
      mk("f", "r/a", "Random: my cat likes the microphone"),
    ];
    const themes = clusterThemes(ev, ["podcast"], "podcasters");
    expect(themes.length).toBeGreaterThanOrEqual(2);
    const cap = themes.find((t) => t.terms.includes("caption"))!;
    expect(cap.ids.sort()).toEqual(["a", "b", "c"]);
    const price = themes.find((t) => t.ids.includes("d"))!;
    expect(price.cat).toBe("price");
    expect(price.title).toBe("Subscriptions and paywalls");
    expect(cap.title).toMatch(/^Caption: /);
    expect(price.idea).toContain("podcasters");
    expect(themes.flatMap((t) => t.ids)).not.toContain("f");
  });
  test("one thread repeating itself isn't a theme", () => {
    const mk = (id: string): Evidence => ({ id, source: "appstore", kind: "review", title: "", snippet: "the sync keeps failing", url: "", at: NOW, signals: [], pain: 2, rel: 1, score: 2, where: { id: "app:1", label: "X", url: "", kind: "app" } });
    expect(clusterThemes([mk("1"), mk("2"), mk("3")], ["podcast"], "x")).toEqual([]);
  });
  test("places: where the posts came from, plus discovered subreddits and apps", () => {
    const res = analyze({ raws, keywords: kw, text: "podcast clips", dir: "idea", subs: parseRedditAtom(REDDIT).subs, apps: parseAppSearch(APPS).slice(0, 1), now: NOW });
    const labels = res.places.map((p) => p.label);
    expect(labels).toContain("r/podcasting");
    expect(labels).toContain("acme/clipper");
    expect(labels).toContain("ClipCast: podcast clips");
    expect(res.places.find((p) => p.label === "r/podcasting")!.n).toBe(1);
    expect(res.builders.map((b) => b.title)).toEqual(["Show HN: A podcast clip finder"]);
    expect(res.counts.pains).toBeGreaterThan(0);
  });
  test("where the topic has a home subreddit, stray uses of its words elsewhere drop out", () => {
    const post = (id: string, sub: string, title: string, text: string): Raw => ({ id, source: "reddit", kind: "post", title, text, url: `https://reddit.com/r/${sub}/comments/${id}/`, at: NOW - DAY, where: { id: `r/${sub.toLowerCase()}`, label: `r/${sub}`, url: "", kind: "subreddit" } });
    const raws = [
      post("1", "humandesign", "Is there an app for my chart?", "I wish my human design app explained transits"),
      post("2", "mylittlepony", "New fan art", "I love the human design of this pony, frustrating that it's gone"),
      post("3", "astrology", "Human Design vs astrology apps", "Frustrating that every app wants a subscription"),
    ];
    const subs = parseRedditAtom(`<entry><id>t5_x</id><link href="https://www.reddit.com/r/humandesign/" /><title>humandesign</title></entry>`).subs;
    const res = analyze({ raws, keywords: ["human design", "reader"], text: "Human Design readers", dir: "audience", subs, now: NOW });
    expect(res.evidence.map((e) => e.id).sort()).toEqual(["1", "3"]);
    expect(res.bySource.reddit).toBe(2);
    // Without a home subreddit the words alone are enough.
    expect(analyze({ raws, keywords: ["human design", "reader"], text: "x", dir: "audience", now: NOW }).evidence).toHaveLength(3);
  });
  test("ideas read naturally", () => {
    expect(ideaFor("price", "subscription", "podcasters")).toBe("A fair one-time-price app for podcasters: no subscription, no paywall");
    expect(ideaFor("missing", "srt", "podcasters")).toContain("srt");
    expect(ideaFor("signal", "export", "podcasters")).toMatch(/^An export app/);
    expect(ideaFor("price", "subscription", "x", "idea")).toContain("around it");
    expect(whoOf("Podcasters who clip", "audience", [])).toBe("podcasters who clip");
    expect(whoOf("Human Design readers", "audience", [])).toBe("Human Design readers");
  });
});

// ── the service, with a fake network ─────────────────────────────────────────────
type Route = { match: RegExp; status?: number; body?: string; headers?: Record<string, string>; hang?: boolean };
function fakeFetch(routes: Route[], log: string[]): FetchLike {
  return async (url, init) => {
    log.push(url);
    const r = routes.find((x) => x.match.test(url));
    if (!r) return new Response("not found", { status: 404 }) as any;
    if (r.hang) return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))) as any;
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? {} }) as any;
  };
}
const OK_ROUTES: Route[] = [
  { match: /hn\.algolia/, body: JSON.stringify(HN) },
  { match: /reddit\.com\/search\.rss/, body: REDDIT, headers: { "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "12" } },
  { match: /api\.stackexchange/, body: JSON.stringify(SE) },
  { match: /itunes\.apple\.com\/search/, body: JSON.stringify(APPS) },
  { match: /customerreviews/, body: JSON.stringify(REVIEWS) },
];
const fakeGh = (calls: string[][], res: Partial<GhRes> = {}) => async (args: string[]): Promise<GhRes> => { calls.push(args); return { ok: true, status: 200, data: GH, remaining: 25, reset: Date.now() + 60_000, ...res }; };
async function finish(L: ReturnType<typeof createLeads>, first: any) {
  let r = first;
  for (let i = 0; i < 300 && !r.done; i++) { await Bun.sleep(20); r = await L.handle("/api/leads/status", { id: first.id }); }
  return r;
}

describe("createLeads", () => {
  test("streams per source, then caches: the second search makes no requests", async () => {
    const dir = `${root}/svc1`, log: string[] = [], gh: string[][] = [];
    const L = createLeads(dir, { fetch: fakeFetch(OK_ROUTES, log), gh: fakeGh(gh), timeout: 500 });
    const first = await L.handle("/api/leads/search", { text: "Podcast clips for TikTok", dir: "idea" });
    expect(first.done).toBe(false);
    expect(Object.keys(first.result.sources)).toEqual(["hn", "reddit", "github", "se", "appstore"]);
    const r = await finish(L, first);
    expect(r.done).toBe(true);
    for (const s of ["hn", "reddit", "github", "se", "appstore"]) expect(r.result.sources[s].state).toBe("ok");
    expect(r.result.sources.hn.n).toBeGreaterThan(0);
    expect(r.result.evidence.length).toBeGreaterThan(3);
    expect(gh).toHaveLength(2); // two GitHub searches, no more
    expect(gh[0].join(" ")).toContain("search/issues");
    expect(log.filter((u) => u.includes("reddit")).length).toBe(1); // exactly one Reddit request
    // Only the query's words went out.
    for (const u of log) expect(decodeURIComponent(u)).not.toMatch(/tiktok.*tiktok/i);
    L.flush();
    expect(existsSync(`${dir}/leads-cache.json`)).toBe(true);
    const n = log.length;
    const again = await L.handle("/api/leads/search", { text: "podcast  clips for tiktok", dir: "idea" });
    expect(again).toMatchObject({ done: true, cached: true, id: null });
    expect(log.length).toBe(n);
    // A fresh process reads the cache file.
    const L2 = createLeads(dir, { fetch: fakeFetch([], log), gh: fakeGh(gh) });
    expect((await L2.handle("/api/leads/search", { text: "Podcast clips for TikTok", dir: "idea" })).cached).toBe(true);
    expect((await L2.handle("/api/leads", {})).recent[0]).toMatchObject({ text: "Podcast clips for TikTok", dir: "idea" });
    expect((await L2.handle("/api/leads", {})).recent).toHaveLength(1); // the same search, once
  });
  test("Reddit's rate limit is remembered; 429s and timeouts fail one source, never the search", async () => {
    const log: string[] = [];
    const routes: Route[] = [
      { match: /hn\.algolia/, hang: true },
      { match: /reddit/, status: 429, headers: { "x-ratelimit-reset": "40" } },
      { match: /api\.stackexchange/, status: 400, body: JSON.stringify({ error_message: "throttle violation", backoff: 30 }) },
      { match: /itunes\.apple\.com\/search/, body: "not json" },
    ];
    const L = createLeads(`${root}/svc2`, { fetch: fakeFetch(routes, log), gh: fakeGh([], { ok: false, status: 403, error: "API rate limit exceeded", remaining: 0 }), timeout: 150 });
    const t0 = Date.now();
    const r = await finish(L, await L.handle("/api/leads/search", { text: "podcast clips", dir: "idea" }));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.result.sources.hn).toMatchObject({ state: "error", error: "didn't answer in time" });
    expect(r.result.sources.reddit.state).toBe("error");
    expect(r.result.sources.reddit.error).toContain("rate-limiting");
    expect(r.result.sources.github.state).toBe("error");
    expect(r.result.sources.se.state).toBe("error");
    expect(L.limits.redditUntil).toBeGreaterThan(Date.now() + 30_000);
    expect(L.limits.seUntil).toBeGreaterThan(Date.now());
    // The next search skips Reddit, GitHub and Stack Exchange politely instead of hammering them.
    const n = log.filter((u) => u.includes("reddit")).length;
    const r2 = await finish(L, await L.handle("/api/leads/search", { text: "podcast editing", dir: "idea" }));
    expect(r2.result.sources.reddit.state).toBe("skipped");
    expect(r2.result.sources.github.state).toBe("skipped");
    expect(r2.result.sources.se.state).toBe("skipped");
    expect(log.filter((u) => u.includes("reddit")).length).toBe(n);
  });
  test("a short Reddit wait is sat out and retried, while the other sources show", async () => {
    setRedditWait(3000);
    const log: string[] = [];
    let n = 0;
    const f: FetchLike = async (url, init) => {
      if (/reddit/.test(url) && n++ === 0) { log.push(url); return new Response("", { status: 429, headers: { "x-ratelimit-reset": "1" } }) as any; }
      if (/reddit/.test(url)) log.push(url);
      return fakeFetch(OK_ROUTES, [])(url, init);
    };
    const L = createLeads(`${root}/svc2b`, { fetch: f, gh: fakeGh([]), timeout: 300 });
    const first = await L.handle("/api/leads/search", { text: "podcast clips", dir: "idea" });
    await Bun.sleep(400);
    const mid = await L.handle("/api/leads/status", { id: first.id });
    expect(mid.done).toBe(false);
    expect(mid.result.sources.hn.state).toBe("ok"); // the rest is on screen meanwhile
    expect(mid.result.sources.reddit.state).toBe("pending");
    const r = await finish(L, first);
    expect(r.result.sources.reddit.state).toBe("ok");
    expect(r.result.sources.reddit.n).toBeGreaterThan(0);
    expect(log).toHaveLength(2);
    setRedditWait(35_000);
  });
  test("force refreshes; stale cache shows at once while the new search streams", async () => {
    const log: string[] = [];
    let now = NOW;
    const L = createLeads(`${root}/svc3`, { fetch: fakeFetch(OK_ROUTES, log), gh: fakeGh([]), timeout: 300, now: () => now });
    await finish(L, await L.handle("/api/leads/search", { text: "podcast clips", dir: "idea" }));
    now += 13 * 3600_000;
    L.limits.redditUntil = 0;
    const s = await L.handle("/api/leads/search", { text: "podcast clips", dir: "idea" });
    expect(s).toMatchObject({ done: false, cached: true });
    expect(s.result.evidence.length).toBeGreaterThan(0);
    await finish(L, s);
    L.limits.redditUntil = 0;
    const forced = await L.handle("/api/leads/search", { text: "podcast clips", dir: "idea", force: true });
    expect(forced.done).toBe(false);
    await finish(L, forced);
  });
  test("validation", async () => {
    const L = createLeads(`${root}/svc4`, { fetch: fakeFetch([], []), gh: fakeGh([]) });
    await expect(L.handle("/api/leads/search", { text: "a" })).rejects.toThrow();
    await expect(L.handle("/api/leads/search", { text: "the and of it" })).rejects.toThrow(/say a little more/i);
    await expect(L.handle("/api/leads/status", { id: "nope" })).rejects.toThrow();
    expect(await L.handle("/api/unknown", {})).toBeUndefined();
  });
  test("saves go through the saved store, scrubbed", async () => {
    let store: any[] = [];
    const L = createLeads(`${root}/svc5`, { fetch: fakeFetch([], []), gh: fakeGh([]), saved: { get: () => store, set: (v) => { store = v; } } });
    await L.handle("/api/leads/save", { op: "save", lead: { id: "idea|caption", label: "Captions · Export", text: "podcast clips", dir: "idea", quotes: [{ snippet: "mail me x@y.com", url: "https://r/1", source: "reddit", author: "u/a" }] } });
    expect(store).toHaveLength(1);
    expect(store[0].quotes[0].snippet).not.toContain("@");
    expect((await L.handle("/api/leads", {})).saved).toHaveLength(1);
    await L.handle("/api/leads/save", { op: "unsave", id: "idea|caption" });
    expect(store).toHaveLength(0);
  });
  test("deep-dive and plan prompts; reports listed with their session", async () => {
    const dir = `${root}/svc6`;
    const L = createLeads(dir, { fetch: fakeFetch(OK_ROUTES, []), gh: fakeGh([]), timeout: 300, projectsDir: "/tmp/p", rows: () => [{ key: "m:1", title: "Leads", status: "working", firstPrompt: "… ~/leads/for-human-design-coach-reader.md …" }] });
    const deep = await L.handle("/api/leads/prompt", { kind: "deep", text: "Human Design readers and coaches", dir: "audience" });
    expect(deep.slug).toBe("for-human-design-reader-coach");
    expect(deep.cwd).toBe("/tmp/p");
    expect(deep.prompt).toContain(`leads/${deep.slug}.md`);
    expect(deep.prompt).toContain("`/last30days Human Design readers and coaches`");
    expect(deep.prompt).toContain("never contact, message, follow");
    expect(deep.prompt).toContain("Propose 5 app or feature ideas");
    expect(deep.prompt).toContain("kind: audience");
    const idea = deepPrompt("podcast clips", "idea", "leads-x", { leadsDir: "/d/leads" });
    expect(idea).toContain("Verdict");
    const plan = await L.handle("/api/leads/prompt", { kind: "plan", text: "podcast clips", dir: "idea", item: { label: "Captions", idea: "Captions that line up", quotes: [{ snippet: "captions drift, email a@b.co", url: "https://r/1", source: "reddit" }] }, places: ["r/podcasting"] });
    expect(plan.prompt).toContain("ideas/");
    expect(plan.prompt).toContain("status: plan");
    expect(plan.prompt).toContain("https://r/1");
    expect(plan.prompt).not.toContain("a@b.co");
    expect(plan.prompt).toContain("r/podcasting");
    expect(planPrompt({ label: "x" }, { ideasDir: "/i", slug: "s", text: "t", dir: "audience" })).toContain("Who: t");
    // A report being written shows as pending, then as written with its session.
    await L.handle("/api/leads/report-started", { slug: deep.slug, text: "Human Design readers and coaches", dir: "audience" });
    let st = await L.handle("/api/leads", {});
    expect(st.reports[0]).toMatchObject({ slug: deep.slug, pending: true, kind: "audience" });
    mkdirSync(`${dir}/leads`, { recursive: true });
    writeFileSync(`${dir}/leads/for-human-design-coach-reader.md`, "---\nkind: audience\nquery: Human Design readers\ndate: 2026-09-26\n---\n# HD readers want answers\n\nThey want plain-language readings.\n\n## Pain points\n- x\n");
    st = await L.handle("/api/leads", {});
    const rep = st.reports.find((x: any) => x.slug === "for-human-design-coach-reader");
    expect(rep).toMatchObject({ title: "HD readers want answers", kind: "audience", summary: "They want plain-language readings.", session: { key: "m:1" } });
    const file = await L.handle("/api/leads/report", { slug: "for-human-design-coach-reader" });
    expect(file.text).toContain("## Pain points");
    await expect(L.handle("/api/leads/report", { slug: "../etc" })).rejects.toThrow();
    const forgot = await L.handle("/api/leads/report-forget", { slug: deep.slug });
    expect(forgot.reports.some((x: any) => x.slug === deep.slug)).toBe(false);
    expect(listReports(`${dir}/nope`)).toEqual([]);
  });
  test("starters and surprise", async () => {
    const s = starters(3);
    expect(s.idea).toHaveLength(5);
    expect(s.audience).toHaveLength(5);
    expect(starters(3)).toEqual(s);
    expect(starters(4)).not.toEqual(s);
    expect(surprise([{ id: "osint", label: "OSINT", score: 10 }], 1)).toMatch(/^(OSINT hobbyists|Citizen journalists)/);
    expect(surprise([], 1).length).toBeGreaterThan(5);
    const L = createLeads(`${root}/svc7`, { fetch: fakeFetch([], []), gh: fakeGh([]), interests: async () => [{ id: "games", label: "Browser games", score: 5 }] });
    const r = await L.handle("/api/leads/surprise", { seed: 2 });
    expect(r.dir).toBe("audience");
    expect(r.text).toMatch(/^(Indie browser-game devs|Game jam participants)/);
  });
});

test("the cache file never holds an email or phone number", () => {
  const f = `${root}/svc1/leads-cache.json`;
  const text = readFileSync(f, "utf8");
  expect(text).not.toMatch(/bob\.smith@example\.com/);
  expect(text).not.toMatch(/555-0133/);
});
