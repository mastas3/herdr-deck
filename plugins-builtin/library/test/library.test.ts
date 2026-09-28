import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLibrary } from "../library";
import { ftsQuery, openCards } from "../library-cards";
import { addSource, defaultConfig, loadConfig, parseSource, removeSource, saveConfig, setEnabled } from "../library-config";
import { amounts, buildCard, checkClaim, checkItem, parseCardJson, parseT, perMonth, toLines, transcriptParts, type Card, type Line } from "../library-extract";
import { evidenceText, mergeResults, type Passage } from "../../../src/library-search";
import { handleMcp } from "../../../src/mcp";
import { libraryTool } from "../server";

const dir = mkdtempSync(`${tmpdir()}/deck-library-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LINES: Line[] = [
  { t: 0, text: "Today we talk to Tom who built Avenue, a widget for trades." },
  { t: 62, text: "We do $85,000 a month in revenue now in Australian dollars." },
  { t: 381, text: "How did you get the first customers? Door-to-door sales with an iPad demo to mechanics." },
  { t: 420, text: "We charge 299 a month for the widget and most shops pay yearly." },
  { t: 640, text: "Sell before you build: we had ten paying shops before writing code." },
];
const META = { id: "vid00000001", source: "starterstory", title: "I Make $50K/Month From This One Widget", url: "https://www.youtube.com/watch?v=vid00000001", duration: 900 };

describe("card extraction: parsing and repair", () => {
  test("reads JSON wrapped in fences and chatter, with trailing commas", () => {
    expect(parseCardJson('Sure!\n```json\n{"business":"Avenue","lessons":[{"text":"a","t":"1:00"},],}\n```')).toEqual({ business: "Avenue", lessons: [{ text: "a", t: "1:00" }] });
  });
  test("closes a cut-off answer instead of losing it", () => {
    const got = parseCardJson('{"business":"Avenue","first_customers":[{"channel":"reddit","tactic":"posted in r/smallbusiness","t":"2:10"},{"channel":"seo","tac');
    expect(got.business).toBe("Avenue");
    expect(got.first_customers[0].tactic).toBe("posted in r/smallbusiness");
  });
  test("gives up on text that has no JSON", () => { expect(parseCardJson("I can't help with that")).toBeUndefined(); });
  test("timestamps, amounts and monthly rates", () => {
    expect(parseT("6:21")).toBe(381);
    expect(parseT("[1:02:03]")).toBe(3723);
    expect(parseT("soon")).toBeNull();
    expect(amounts("$85,000 a month, 50K users, 1.2 million in 2024")).toEqual([85000, 50000, 1200000]);
    expect(perMonth("$1.2M a year")).toBe(100000);
    expect(perMonth("$50K/month")).toBe(50000);
    expect(perMonth("made $500K total")).toBeUndefined();
    expect(perMonth("11,000 MR")).toBe(11000);
  });
  test("captions become ~20 s lines without HTML entities or [music]", () => {
    const lines = toLines([{ start: 0, text: "Hi &gt;&gt; there" }, { start: 5, text: "[music] welcome" }, { start: 21, text: "next" }]);
    expect(lines).toEqual([{ t: 0, text: "Hi — there welcome" }, { t: 21, text: "next" }]);
    expect(transcriptParts(LINES, 150).length).toBeGreaterThan(1);
  });
});

describe("card extraction: every claim is checked against the transcript", () => {
  test("a number said near the cited time is kept there", () => {
    expect(checkClaim({ text: "$85,000 a month", quote: "$85,000 a month in revenue", t: "1:00" }, LINES, META.title)).toMatchObject({ t: 62, src: "transcript" });
  });
  test("a number said elsewhere moves the timestamp to where it was said", () => {
    expect(checkClaim({ text: "299 a month", t: "0:05" }, LINES, META.title)).toMatchObject({ t: 420, moved: true });
  });
  test("a number only the title says links to the start and says so", () => {
    expect(checkClaim({ text: "$50K/month", t: "0:10" }, LINES, META.title)).toMatchObject({ t: 0, src: "title" });
  });
  test("a number nobody said is dropped", () => {
    expect(checkClaim({ text: "$2M a year", t: "1:00" }, LINES, META.title)).toBeUndefined();
  });
  test("a timestamp past the end of the video is not trusted", () => {
    expect(checkClaim({ text: "$85,000 a month", t: "59:00" }, LINES, META.title, 900)).toMatchObject({ t: 62, moved: true });
  });
  test("tactics move to the matching line, and invented numbers drop them", () => {
    expect(checkItem("Door-to-door sales with an iPad demo", "0:10", LINES)).toMatchObject({ t: 381, moved: true });
    expect(checkItem("Door-to-door sales with an iPad demo", "6:30", LINES)).toEqual({ text: "Door-to-door sales with an iPad demo", t: 390 });
    expect(checkItem("Posted 45 times on Reddit", "6:21", LINES)).toBeUndefined();
  });
  test("a whole card: checked claims, known channels, dropped lines listed", () => {
    const raw = {
      kind: "founder_story", business: "Avenue", founder: "Tom", sells: "Website widget for trades", business_type: "SaaS", customer: "[null]",
      revenue: { text: "$85,000 a month", quote: "$85,000 a month", t: "1:02" }, price: { text: "$9,999 lifetime", t: "7:00" },
      first_customers: [{ channel: "door to door", tactic: "Door-to-door sales with an iPad demo", t: "6:21" }, { channel: "smoke signals", tactic: "Sell before you build", t: "10:40" }],
      stack: ["Twilio", "Twilio", ""], lessons: [{ text: "Sell before you build", t: "10:40" }, { text: "sell before you build", t: "10:40" }],
    };
    const c = buildCard([raw], LINES, META, "test-model", 5);
    expect(c).toMatchObject({ kind: "founder_story", business: "Avenue", btype: "saas", customer: null, model: "test-model", at: 5 });
    expect(c.revenue).toMatchObject({ t: 62, perMonth: 85000, currency: "AUD" });
    expect(c.price).toBeUndefined();
    expect(c.checks.dropped).toContain("price: $9,999 lifetime");
    expect(c.first.map((x) => x.channel)).toEqual(["door_to_door", "other"]);
    expect(c.stack).toEqual(["Twilio"]);
    expect(c.lessons).toHaveLength(1);
  });
  test("items given as plain strings or [text, time] pairs are read, not dropped", () => {
    const c = buildCard([{ kind: "advice", lessons: ["Sell before you build: ten paying shops first", ["Door-to-door sales with an iPad demo", "t:6:21"]] }], LINES, META, "m");
    expect(c.lessons.map((x) => x.t)).toEqual([640, 381]);
  });
  test("an answer that stopped before the lists is asked for them once more", async () => {
    const asks: string[] = [];
    const lib = createLibrary({ dir: `${dir}/lists`, bridge: { available: () => ({ ok: false }), call: async () => ({}) } as any,
      ask: async (_m, _s, user) => { asks.push(user); return user.includes("stopped before the lists") ? '{"lessons":[{"text":"Sell before you build","t":"10:40"}]}' : '{"kind":"founder_story","business":"Avenue"}'; } });
    const q = { source: "starterstory", videos: [{ id: "vid00000001", title: META.title, url: META.url, order: 0, status: "ingested" as const, attempts: 1 }] };
    lib.queues.write(q);
    const tp = lib.transcriptPath(q, "starterstory", "vid00000001");
    mkdirSync(tp.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(tp, JSON.stringify({ segments: [...LINES, ...LINES.map((l) => ({ ...l, t: l.t + 1000 }))].map((l) => ({ start: l.t, text: l.text })) }));
    expect(await lib.extractNext(lib.config())).toBe(true);
    expect(asks).toHaveLength(2);
    expect(lib.cards().get("vid00000001")).toMatchObject({ business: "Avenue", lessons: [{ text: "Sell before you build", t: 640 }] });
  });
    test("parts of a long video merge: first answer wins for facts, lists are joined", () => {
    const c = buildCard([{ kind: "advice", business: null, lessons: [{ text: "Sell before you build", t: "10:40" }] }, { kind: "founder_story", business: "Avenue", lessons: [{ text: "Door-to-door sales work for mechanics", t: "6:21" }] }], LINES, META, "m");
    expect(c.kind).toBe("founder_story");
    expect(c.business).toBe("Avenue");
    expect(c.lessons).toHaveLength(2);
  });
});

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id, source: "starterstory", title: `Video ${id}`, url: `https://www.youtube.com/watch?v=${id}`, kind: "founder_story", business: `Biz ${id}`, founder: null, sells: null, btype: "saas", customer: null,
  first: [], growth: [], stack: [], failed: [], lessons: [], model: "m", at: 1, checks: { dropped: [], moved: 0 }, ...over,
});

describe("card store: full-text search, filters, ranking", () => {
  const db = openCards(`${dir}/cards.db`);
  db.put(card("aaaaaaaaaaa", { business: "BotKit", sells: "Telegram bot for gyms", first: [{ channel: "reddit", text: "posted a demo in r/telegram", t: 30 }], revenue: { text: "$9K/month", t: 40, src: "transcript", perMonth: 9000 } }));
  db.put(card("bbbbbbbbbbb", { business: "Shopline", sells: "Shopify theme", btype: "ecommerce", first: [{ channel: "seo", text: "wrote comparison pages", t: 10 }], revenue: { text: "$40K/month", t: 5, src: "transcript", perMonth: 40000 } }));
  db.put(card("ccccccccccc", { business: "Tutorly", sells: "Tutoring marketplace", btype: "marketplace", lessons: [{ text: "a telegram group of parents found the first tutors", t: 90 }] }));
  test("words match business, tactics and lessons; the business name weighs more", () => {
    const r = db.list({ q: "how did people get first customers for a Telegram bot?" });
    expect(r.cards.map((c) => c.id)).toEqual(["aaaaaaaaaaa", "ccccccccccc"]);
    expect(r.total).toBe(2);
  });
  test("filters: revenue, channel, type; revenue sorts by default", () => {
    expect(db.list({ minRevenue: 10000 }).cards.map((c) => c.id)).toEqual(["bbbbbbbbbbb"]);
    expect(db.list({ channel: "reddit" }).cards.map((c) => c.id)).toEqual(["aaaaaaaaaaa"]);
    expect(db.list({ btype: "marketplace" }).total).toBe(1);
    expect(db.list({}).cards.map((c) => c.id)).toEqual(["bbbbbbbbbbb", "aaaaaaaaaaa", "ccccccccccc"]);
  });
  test("FTS syntax in the question is inert", () => {
    expect(ftsQuery('bot" OR * NEAR(')).toBe('"bot" OR "near"');
    expect(() => db.list({ q: '"; DROP TABLE cards; --' })).not.toThrow();
  });
  test("extraction state survives, and web pages are searchable", () => {
    db.mark("ddddddddddd", "failed", "timeout", "m");
    expect([...db.handled()].sort()).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]);
    db.retryFailed();
    expect(db.handled().has("ddddddddddd")).toBe(false);
    db.putPage({ url: "https://example.com/case", title: "How we priced our SaaS", site: "example.com", text: "We raised the price to $49 and churn fell.", fetchedAt: 1 });
    expect(db.searchPages("pricing saas price")[0].url).toBe("https://example.com/case");
    expect(db.stats()).toMatchObject({ cards: 3, withRevenue: 2, pages: 1 });
  });
});

describe("search merging", () => {
  const P = (id: string, video: string, score: number, t = 30): Passage => ({ id, score, text: `passage ${id} &gt;&gt; hi`, video_id: video, video_title: `Video ${video}`, video_url: `https://www.youtube.com/watch?v=${video}`, start_time_s: t });
  test("a video found by both a passage and its card comes first; weak passages are ignored", () => {
    const cards = [card("v2"), card("v1")];
    const r = mergeResults([P("p1", "v1", 0.8), P("p2", "v3", 0.7), P("p3", "v4", 0.2)], cards, [], 8);
    expect(r.map((a) => a.id)).toEqual(["v1", "v2", "v3"]);
    expect(r[0].why).toEqual(["passage", "card"]);
    expect(r[0].clips[0]).toMatchObject({ at: "0:30", link: "https://www.youtube.com/watch?v=v1&t=30s", text: "passage p1 — hi" });
  });
  test("sponsor reads and channel plugs are never answers", () => {
    const ad = { ...P("p9", "v9", 0.9), text: "to start your 9-day journey just hit that link in the description below" };
    expect(mergeResults([ad, P("p1", "v1", 0.6)], [], [], 8).map((a) => a.id)).toEqual(["v1"]);
  });
  test("web pages join the list; evidence text cites links and is empty without data", () => {
    const withRev = card("v1", { revenue: { text: "$9K/month", quote: "nine K a month, $9K", t: 40, src: "transcript" }, first: [{ channel: "reddit", text: "posted a demo", t: 30 }] });
    const r = mergeResults([P("p1", "v1", 0.8)], [withRev], [{ url: "https://x.dev/a", title: "A", snippet: "text", rank: -1 }], 8);
    expect(r.map((a) => a.kind)).toEqual(["video", "web"]);
    const text = evidenceText(r);
    expect(text).toContain('claimed revenue: "nine K a month, $9K" (https://www.youtube.com/watch?v=v1&t=40s)');
    expect(text).toContain("first customers (reddit): posted a demo (https://www.youtube.com/watch?v=v1&t=30s)");
    expect(evidenceText([])).toBe("");
  });
});

describe("channel config", () => {
  test("links are told apart: channel, playlist, video, web, private", () => {
    expect(parseSource("@starterstory")).toEqual({ type: "channel", url: "https://www.youtube.com/@starterstory", id: "starterstory" });
    expect(parseSource("https://www.youtube.com/@marc-lou/videos")).toMatchObject({ type: "channel", id: "marc-lou" });
    expect(parseSource("https://youtube.com/playlist?list=PLQ-uHSnFig5M9fW16o2l35jrfdsxGknNB")).toMatchObject({ type: "playlist" });
    expect(parseSource("https://youtu.be/oFtjKbXKqbg?si=x")).toEqual({ type: "video", url: "https://www.youtube.com/watch?v=oFtjKbXKqbg", id: "oFtjKbXKqbg" });
    expect(parseSource("https://www.youtube.com/watch?v=oFtjKbXKqbg&list=PL123456789")).toMatchObject({ type: "video" });
    expect(parseSource("indiehackers.com/post/abc#x")).toEqual({ type: "web", url: "https://indiehackers.com/post/abc" });
    expect(parseSource("http://192.168.1.4/admin").type).toBe("invalid");
    expect(parseSource("").type).toBe("invalid");
  });
  test("the file: defaults when missing, broken files kept aside, bad regexes dropped", () => {
    const f = `${dir}/cfg/channels.json`;
    expect(loadConfig(f).sources[0].id).toBe("starterstory");
    mkdirSync(`${dir}/cfg`, { recursive: true });
    writeFileSync(f, "{oops");
    expect(loadConfig(f).sources.length).toBe(defaultConfig().sources.length);
    saveConfig(f, { ...defaultConfig(), sources: [{ id: "x y", kind: "channel", url: "u", enabled: true, include: "(" } as any] });
    expect(loadConfig(f).sources).toEqual([{ id: "x-y", kind: "channel", url: "u", enabled: true }]);
    expect(JSON.parse(readFileSync(f, "utf8")).use).toEqual({ studio: true, ideas: true, research: true });
  });
  test("adding, enabling and removing sources", () => {
    let c = defaultConfig();
    const a = addSource(c, parseSource("https://www.youtube.com/@newchan"), 7);
    expect(a.config.sources[0]).toEqual({ id: "newchan", kind: "channel", url: "https://www.youtube.com/@newchan", enabled: true, addedAt: 7 });
    c = addSource(a.config, parseSource("https://youtu.be/aaaaaaaaaaa")).config;
    c = addSource(c, parseSource("https://youtu.be/bbbbbbbbbbb")).config;
    expect(c.sources[0]).toMatchObject({ id: "added-videos", videos: ["bbbbbbbbbbb", "aaaaaaaaaaa"] });
    expect(addSource(c, parseSource("@STARTERSTORY")).config.sources.filter((s) => s.id.toLowerCase() === "starterstory")).toHaveLength(1);
    expect(setEnabled(c, "newchan", false).sources.find((s) => s.id === "newchan")!.enabled).toBe(false);
    expect(removeSource(c, "newchan").sources.some((s) => s.id === "newchan")).toBe(false);
    expect(addSource(c, parseSource("https://example.com")).error).toContain("page fetcher");
  });
});

describe("libraryEvidence", () => {
  const bridge = { available: () => ({ ok: false, why: "test" }), call: async () => { throw new Error("no bridge in tests"); } };
  test("empty library → empty text; with a card → the card and its links; switched off → empty", async () => {
    const lib = createLibrary({ dir: `${dir}/lib`, bridge });
    expect((await lib.evidence("first customers telegram bot")).text).toBe("");
    lib.cards().put(card("eeeeeeeeeee", { business: "GymBot", sells: "Telegram bot for gyms", first: [{ channel: "reddit", text: "posted a demo to r/gym owners", t: 12 }] }));
    const e = await lib.evidence("first customers telegram bot", 3, "studio");
    expect(e.text).toContain("GymBot — Telegram bot for gyms");
    expect(e.text).toContain("https://www.youtube.com/watch?v=eeeeeeeeeee&t=12s");
    await lib.handle("/api/library/channels", { op: "use", what: "studio", on: false });
    expect((await lib.evidence("telegram bot", 3, "studio")).text).toBe("");
    expect((await lib.evidence("telegram bot", 3, "ideas")).text).not.toBe("");
  });
});

describe("research agents: the deck_library MCP tool", () => {
  const base = { sessions: () => [], session: async () => ({}), search: async () => ({}), history: async () => ({}), decisions: async () => [], send: async () => ({}), start: async () => ({}), audit: () => {} };
  test("listed only while the library plugin contributes it; answers with the evidence text", async () => {
    const names = async (ctx: any) => (await handleMcp({ id: 1, method: "tools/list" }, ctx)).result.tools.map((t: any) => t.name);
    expect(await names(base)).not.toContain("deck_library");
    const seen: any[] = [];
    const tool = libraryTool({ evidence: async (q: string, k?: number, use?: string) => { seen.push([q, k, use]); return { text: q.includes("bot") ? "Founder Library: 1. GymBot" : "", answers: [] }; } } as any);
    const ctx = { ...base, tools: () => [tool] };
    expect(await names(ctx)).toContain("deck_library");
    const r = await handleMcp({ id: 2, method: "tools/call", params: { name: "deck_library", arguments: { query: "telegram bot", limit: 50 } } }, ctx);
    expect(r.result.content[0].text).toBe("Founder Library: 1. GymBot");
    expect(seen).toEqual([["telegram bot", 8, "research"]]);
    const none = await handleMcp({ id: 3, method: "tools/call", params: { name: "deck_library", arguments: { query: "zzz" } } }, ctx);
    expect(none.result.content[0].text).toContain("nothing on that yet");
  });
});

describe("re-checking cards without the model", () => {
  test("stored answers are re-checked with today's rules; cards without them are left alone", () => {
    const lib = createLibrary({ dir: `${dir}/recheck`, bridge: { available: () => ({ ok: false }), call: async () => ({}) } as any });
    const q = { source: "starterstory", channelId: "ss_UC1", videos: [{ id: "vid00000001", title: META.title, url: META.url, order: 0, status: "ingested" as const, attempts: 1 }] };
    lib.queues.write(q);
    const tp = lib.transcriptPath(q, "starterstory", "vid00000001");
    mkdirSync(tp.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(tp, JSON.stringify({ segments: LINES.map((l) => ({ start: l.t, text: l.text })) }));
    const raw = { kind: "founder_story", business: "Avenue", customer: "stale", revenue: { text: "$85,000 a month", t: "1:02" } };
    lib.cards().put(buildCard([raw], LINES, META, "m"), 0, [{ ...raw, customer: "[null]" }]);
    lib.cards().put(card("zzzzzzzzzzz", { customer: "untouched" }));
    expect(lib.recheck()).toBe(1);
    expect(lib.cards().get("vid00000001")).toMatchObject({ customer: null, business: "Avenue", revenue: { t: 62 } });
    expect(lib.cards().get("zzzzzzzzzzz")!.customer).toBe("untouched");
  });
});
