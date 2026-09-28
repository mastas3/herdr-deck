import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { defaultConfig, type LibConfig, type LibSource } from "../library-config";
import { buildCard, inferChannel, type Card } from "../library-extract";
import { buildPlaybooks } from "../library-playbooks";
import { applyResult, applyRules, countQueue, mergeEnumeration, nextVideo, queueStore, rankVideos, recover, skipReason, type Queue, type QVideo } from "../library-queue";
import { createRunner } from "../library-runner";
import { fetchPage, htmlToText, robotsAllows, robotsRules } from "../library-web";

const dir = mkdtempSync(`${tmpdir()}/deck-library-ingest-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SRC: LibSource = { id: "chan", kind: "channel", url: "https://www.youtube.com/@chan", enabled: true };
const vid = (i: number, over: object = {}) => ({ video_id: `v${String(i).padStart(10, "0")}`, title: `Video ${i}`, duration_s: 900, view_count: 1000 * (10 - i), order: i, ...over });

describe("ingestion queue: what gets ingested, in which order", () => {
  test("shorts, very short and very long videos, and title filters are skipped with a reason", () => {
    expect(skipReason({ title: "x", short: true }, {})).toBe("short");
    expect(skipReason({ title: "x", duration: 60 }, {})).toBe("too short");
    expect(skipReason({ title: "x", duration: 5 * 3600 }, {})).toBe("over 4 hours");
    expect(skipReason({ title: "Elon plays games", duration: 900 }, { exclude: "elon" })).toBe("title filter");
    expect(skipReason({ title: "Pricing your offer", duration: 900 }, { include: "offer|pric" })).toBeUndefined();
  });
  test("ranking mixes most viewed and most recent; without view counts, recency alone", () => {
    const vs = [{ id: "new-few", views: 10, order: 0 }, { id: "mid", views: 500, order: 1 }, { id: "old-viral", views: 9000, order: 2 }, { id: "old-few", views: 5, order: 3 }];
    // new-few, mid and old-viral all score 0.25 (a recency rank traded for a views rank); ties go to the newer one.
    expect(rankVideos(vs).map((v) => v.id)).toEqual(["new-few", "mid", "old-viral", "old-few"]);
    expect(rankVideos([...vs, { id: "new-viral", views: 99999, order: -1 }])[0].id).toBe("new-viral");
    expect(rankVideos(vs.map((v) => ({ ...v, views: undefined }))).map((v) => v.id)).toEqual(["new-few", "mid", "old-viral", "old-few"]);
  });
  test("a limit keeps only the best N queued; raising it later re-queues the rest", () => {
    const q = mergeEnumeration({ source: "chan", videos: [] }, { channel_id: "chan_UC1", channel_title: "Chan", videos: [0, 1, 2, 3, 4].map((i) => vid(i)) }, { ...SRC, limit: 2 }, 5);
    expect(countQueue(q)).toMatchObject({ total: 5, queued: 2, skipped: 3 });
    expect(q.videos.filter((v) => v.status === "skipped").every((v) => v.why === "beyond limit")).toBe(true);
    expect(countQueue({ ...q, videos: applyRules(q.videos, { ...SRC, limit: 4 }) }).queued).toBe(4);
  });
  test("re-listing keeps what was done, adds new uploads and keeps ingested videos that vanished", () => {
    let q = mergeEnumeration({ source: "chan", videos: [] }, { videos: [vid(0), vid(1)] }, SRC);
    q = { ...q, videos: q.videos.map((v) => (v.id === vid(1).video_id ? { ...v, status: "ingested", chunks: 20 } : v)) };
    const again = mergeEnumeration(q, { videos: [vid(9, { order: 0 }), vid(0, { order: 1 })] }, SRC);
    expect(again.videos.map((v) => [v.id, v.status])).toEqual(expect.arrayContaining([[vid(9).video_id, "queued"], [vid(0).video_id, "queued"], [vid(1).video_id, "ingested"]]));
    expect(again.videos).toHaveLength(3);
  });
  test("next video: sources in order, failed ones only after their backoff, no-caption ones only with Whisper on", () => {
    const a: Queue = { source: "a", videos: [{ id: "a1", title: "", url: "", order: 0, status: "queued", attempts: 1, retryAt: 2000 }] };
    const b: Queue = { source: "b", videos: [{ id: "b1", title: "", url: "", order: 0, status: "no_captions", attempts: 1 }, { id: "b2", title: "", url: "", order: 1, status: "queued", attempts: 0 }] };
    expect(nextVideo([a, b], ["a", "b"], 1000)?.v.id).toBe("b2");
    expect(nextVideo([a, b], ["a", "b"], 3000)?.v.id).toBe("a1");
    expect(nextVideo([{ ...b, videos: [b.videos[0]] }], ["b"], 0)).toBeUndefined();
    expect(nextVideo([{ ...b, videos: [b.videos[0]] }], ["b"], 0, true)?.v.id).toBe("b1");
    expect(nextVideo([a, b], ["b"], 3000)?.v.id).toBe("b2");
  });
  test("results: ingested, no captions, failures retried with backoff (bot checks wait an hour), then given up", () => {
    const v: QVideo = { id: "x", title: "", url: "", order: 0, status: "ingesting", attempts: 0 };
    expect(applyResult(v, { status: "ingested", chunks: 12 }, 7)).toMatchObject({ status: "ingested", chunks: 12, attempts: 1, at: 7 });
    expect(applyResult(v, { status: "no_captions" })).toMatchObject({ status: "no_captions", attempts: 1 });
    const f1 = applyResult(v, { status: "failed", error: "HTTP 500" }, 0);
    expect(f1).toMatchObject({ status: "queued", attempts: 1, retryAt: 10 * 60_000 });
    expect(applyResult(v, { status: "failed", error: "Sign in to confirm you're not a bot" }, 0).retryAt).toBe(3600_000);
    expect(applyResult({ ...f1, attempts: 2 }, { status: "failed", error: "again" }, 0)).toMatchObject({ status: "failed", attempts: 3, error: "again" });
  });
  test("after a crash, a video left 'ingesting' goes back to the queue", () => {
    expect(recover({ source: "a", videos: [{ id: "x", title: "", url: "", order: 0, status: "ingesting", attempts: 0 }] }).videos[0].status).toBe("queued");
  });
});

describe("runner: resume, skip, fail, one process at a time", () => {
  const cfgOf = (running = true): LibConfig => ({ ...defaultConfig(), sources: [SRC, { ...SRC, id: "off", enabled: false }], ingest: { running, whisper: false, pauseMs: 0 } });
  test("lists the source, ingests every queued video, records failures, stops when paused", async () => {
    const d = `${dir}/run1`;
    const qs = queueStore(`${d}/queue`);
    let cfg = cfgOf();
    const calls: string[] = [];
    const bridge = {
      available: () => ({ ok: true }),
      call: async (path: string, body: any) => {
        calls.push(`${path} ${body.video?.video_id ?? body.url ?? ""}`);
        if (path === "/enumerate") return { channel_id: "chan_UC1", channel_title: "Chan", videos: [vid(0), vid(1), vid(2, { duration_s: 30 })] };
        if (body.video.video_id === vid(1).video_id) return { status: "failed", error: "boom" };
        return { status: "ingested", chunks: 9 };
      },
    };
    let sleeps = 0;
    const r = createRunner({ dir: d, bridge, queues: qs, config: () => cfg, sleep: async () => { if (++sleeps > 3) cfg = cfgOf(false); }, log: () => {} });
    require("node:fs").mkdirSync(d, { recursive: true });
    await r.run();
    const q = qs.read("chan");
    expect(q.channelId).toBe("chan_UC1");
    expect(q.videos.map((v) => [v.status, v.why ?? v.error ?? v.chunks])).toEqual([["ingested", 9], ["queued", "boom"], ["skipped", "too short"]]);
    expect(calls.filter((c) => c.startsWith("/ingest"))).toEqual([`/ingest ${vid(0).video_id}`, `/ingest ${vid(1).video_id}`]);
    expect(r.status()).toMatchObject({ running: false, run: { ingested: 1, failed: 1 } });
    expect(existsSync(`${d}/runner.lock`)).toBe(false);
  });
  test("a second runner doesn't start while another process holds the lock", async () => {
    const d = `${dir}/run2`;
    require("node:fs").mkdirSync(d, { recursive: true });
    writeFileSync(`${d}/runner.lock`, JSON.stringify({ pid: process.ppid, at: 1 }));
    const r = createRunner({ dir: d, bridge: { available: () => ({ ok: true }), call: async () => ({}) }, queues: queueStore(`${d}/queue`), config: () => cfgOf(), log: () => {} });
    expect(await r.run()).toEqual({ ok: false, owner: process.ppid });
  });
});

describe("cards and playbooks", () => {
  test("channels are inferred from the tactic when the model names none from the list", () => {
    expect(inferChannel("influencer marketing", "sent DMs")).toBe("influencers");
    expect(inferChannel("reddit", "")).toBe("reddit");
    expect(inferChannel("organic", "posted in r/SaaS every day")).toBe("reddit");
    expect(inferChannel("", "paid micro streamers $120 per video")).toBe("influencers");
    expect(inferChannel("", "just worked hard")).toBe("other");
  });
  test("milestones aren't kept as tactics", () => {
    const lines = [{ t: 10, text: "the first sale came in very late January and then we scaled to 60,000 a month" }, { t: 40, text: "we posted in r/SaaS every day" }];
    const c = buildCard([{ kind: "founder_story", first_customers: [{ tactic: "The first sale came in very late January", t: "0:10" }, { tactic: "Posted in r/SaaS every day", t: "0:40" }] }], lines, { id: "v", source: "s", title: "t", url: "u" }, "m");
    expect(c.first.map((x) => x.channel)).toEqual(["reddit"]);
    expect(c.checks.dropped[0]).toContain("not a tactic");
  });
  const card = (id: string, over: Partial<Card>): Card => ({ id, source: "starterstory", title: `T ${id}`, url: `https://www.youtube.com/watch?v=${id}`, kind: "founder_story", business: `B${id}`, founder: null, sells: "an app", btype: "mobile_app", customer: null, first: [], growth: [], stack: [], failed: [], lessons: [], model: "m", at: 1, checks: { dropped: [], moved: 0 }, ...over });
  const cards = [
    card("a", { revenue: { text: "$50K/month", t: 60, src: "transcript", perMonth: 50000 }, first: [{ channel: "tiktok", text: "posted 3 videos a day", t: 100 }], price: { text: "$9.99 a month", t: 120, src: "transcript" }, team: { text: "solo", t: 5, src: "transcript" }, failed: [{ text: "built for a year without talking to anyone", t: 200 }] }),
    card("b", { revenue: { text: "$2K/month", t: 60, src: "transcript", perMonth: 2000 }, first: [{ channel: "tiktok", text: "slideshows on TikTok", t: 30 }, { channel: "reddit", text: "posted in r/apps", t: 40 }], btype: "saas" }),
    card("c", { btype: "local_business", sells: "pressure washing", first: [{ channel: "door_to_door", text: "knocked on doors", t: 10 }], lessons: [{ text: "Boring works", t: 11 }] }),
  ];
  const pbs = buildPlaybooks(cards);
  test("six playbooks, with counts and every example linked to its moment", () => {
    expect(pbs.map((p) => p.name)).toEqual(["first-10-customers", "pricing-that-worked", "distribution-by-business-type", "failures-and-regrets", "traits-of-successful-founders", "boring-businesses"]);
    const first = pbs[0].md;
    expect(first).toContain("| TikTok | 2 | 67% |");
    expect(first).toContain("**Ba** (an app): posted 3 videos a day [1:40](https://www.youtube.com/watch?v=a&t=100s)");
    expect(pbs[1].md).toContain("| subscription | 1 | 100% |");
    expect(pbs[3].md).toContain("Built before checking anyone wanted it");
    expect(pbs[4].md).toContain("| Solo founder | 1 (100%) | 0 (0%) |");
    expect(pbs[5].md).toContain("### Bc — pressure washing");
    for (const p of pbs) expect(p.md).toContain("their own claims, unverified");
  });
});

describe("web pages: polite fetching", () => {
  test("robots.txt: our group or *, longest match wins, Allow breaks ties", () => {
    const rules = robotsRules("User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: Googlebot\nDisallow: /");
    expect(robotsAllows(rules, "/blog/post")).toBe(true);
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/private/ok/1")).toBe(true);
    expect(robotsAllows(robotsRules("User-agent: herdr-deck-library\nDisallow: /\nUser-agent: *\nAllow: /"), "/a")).toBe(false);
    expect(robotsAllows(robotsRules("User-agent: *\nDisallow: /*.pdf$"), "/a.pdf")).toBe(false);
  });
  test("HTML to text: the article, without scripts and menus", () => {
    const r = htmlToText("<html><head><title>Case &amp; study</title><script>x()</script></head><body><nav>Menu</nav><article><h1>How we got 100 customers</h1><p>We emailed&nbsp;50 shops.</p></article><footer>©</footer></body></html>");
    expect(r).toEqual({ title: "Case & study", text: "How we got 100 customers\nWe emailed 50 shops." });
  });
  const fake = (pages: Record<string, { status?: number; body?: string; type?: string }>) => async (url: string) => {
    const p = pages[url] ?? { status: 404, body: "" };
    return new Response(p.body ?? "", { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html" } });
  };
  const long = `<article>${"We sold to dentists by calling them. ".repeat(20)}</article>`;
  test("fetches an allowed page; refuses disallowed, login-walled and unreadable ones", async () => {
    const ok = await fetchPage("https://a.test/story", fake({ "https://a.test/robots.txt": { status: 404 }, "https://a.test/story": { body: `<title>Story</title>${long}` } }) as any);
    expect(ok).toMatchObject({ title: "Story", site: "a.test" });
    await expect(fetchPage("https://b.test/x", fake({ "https://b.test/robots.txt": { body: "User-agent: *\nDisallow: /x", type: "text/plain" } }) as any)).rejects.toThrow("robots.txt");
    await expect(fetchPage("https://c.test/x", fake({ "https://c.test/robots.txt": { status: 404 }, "https://c.test/x": { status: 403 } }) as any)).rejects.toThrow("login");
    await expect(fetchPage("https://d.test/x", fake({ "https://d.test/robots.txt": { status: 503 } }) as any)).rejects.toThrow("robots.txt");
  });
});
