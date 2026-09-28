import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AVOID, categoryOf, codexBusy, coverPrompt, findBin, makeCovers, MAX_BYTES, PALETTES, pngSize } from "../cover-art";
import { afterRun, createCovers, decide, DEFAULTS, freshState, rollDay, selectCandidates, type CoverState } from "../covers";
import { Database } from "bun:sqlite";

/** Discover's ideas.db (plugins-builtin/discover/idea-archive.ts), written the way it writes it: the covers job only reads it. */
function ideasDb(file: string, rows: { id: string; title: string; score: number; dropped: boolean; row?: string; data: object }[]) {
  const db = new Database(file);
  db.exec(`CREATE TABLE ideas (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, row TEXT, score REAL,
    dropped INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`);
  const q = db.prepare(`INSERT INTO ideas VALUES (?, ?, 'feed', ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) q.run(r.id, r.title, r.row ?? null, r.score, r.dropped ? 1 : 0, Date.now(), Date.now(), JSON.stringify({ id: r.id, title: r.title, ...r.data }));
  db.close();
}

const dir = mkdtempSync(`${tmpdir()}/deck-covers-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const MIN = 60_000;
const T0 = new Date(2026, 8, 26, 10, 0).getTime();

/** A 1536×1024 PNG like the one Codex hands back (ffmpeg's test pattern; busy enough to be a fair size test). */
const FFMPEG = findBin("ffmpeg"), CWEBP = findBin("cwebp");
const FIXTURE = `${dir}/fixture.png`;
if (FFMPEG) Bun.spawnSync([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1536x1024", "-frames:v", "1", FIXTURE]);
/** Width and height of a WebP (lossy VP8, lossless VP8L or extended VP8X). */
function webpSize(file: string) {
  const b = readFileSync(file);
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
  return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
}

describe("which idea gets a cover next", () => {
  const saved = [{ id: "s-old", title: "Old save", savedAt: 1 }, { id: "s-new", title: "New save", savedAt: 5 }];
  const archive = [
    { id: "a6", title: "Six", score: 6 }, { id: "a9", title: "Nine", score: 9 }, { id: "a7", title: "Seven", score: 7 },
    { id: "a8x", title: "Dropped", score: 8, dropped: true }, { id: "tpl", title: "Template", score: 9, source: "template" },
  ];
  const feed = [
    { id: "f1", title: "Row A second", row: "money", score: 5 }, { id: "f2", title: "Row A top", row: "money", score: 6 },
    { id: "f3", title: "Row B only", row: "content" }, { id: "a9", title: "Nine again", row: "saas", score: 9 },
  ];
  test("saved first (newest save first), then kept ideas scoring 7 or more (best first), then the top of each feed row", () => {
    expect(selectCandidates({ saved, archive, feed }, () => false).map((x) => x.id)).toEqual(["s-new", "s-old", "a9", "a7", "f2", "f3"]);
  });
  test("ideas that already have a cover, or failed twice, are skipped; the threshold is configurable", () => {
    const has = (id: string) => id === "s-new" || id === "a9";
    expect(selectCandidates({ saved, archive, feed }, has, { a7: 2, "s-old": 1 }).map((x) => x.id)).toEqual(["s-old", "f2", "f3"]);
    expect(selectCandidates({ saved: [], archive, feed: [] }, () => false, {}, 6).map((x) => x.id)).toEqual(["a9", "a7", "a6"]);
  });
});

describe("when: cap, spacing, Codex busy, backoff, stop, pause", () => {
  const env = (o: Partial<{ running: boolean; busy: boolean; next: any }> = {}) => ({ running: !!o.running, busy: () => !!o.busy, next: () => ("next" in o ? o.next : { id: "x", title: "X" }) });
  const st0 = (o: Partial<CoverState> = {}): CoverState => ({ ...freshState(T0), ...o });
  test("runs the next idea when nothing holds it back", () => {
    expect(decide(st0(), DEFAULTS, T0, env())).toEqual({ run: { id: "x", idea: { id: "x", title: "X" }, manual: false } });
    expect(decide(st0(), DEFAULTS, T0, env({ next: undefined }))).toEqual({ wait: "none" });
  });
  test("the daily cap holds until midnight; a new day starts the count over", () => {
    const d = decide(st0({ today: 12 }), DEFAULTS, T0, env());
    expect(d).toMatchObject({ wait: "cap" });
    expect(new Date((d as any).at).getHours()).toBe(0);
    expect(decide(st0({ today: 3 }), { ...DEFAULTS, dailyCap: 3 }, T0, env())).toMatchObject({ wait: "cap" });
    expect(rollDay(st0({ today: 12 }), T0 + 86_400_000).today).toBe(0);
  });
  test("spaced out, and never while someone else's Codex is busy", () => {
    expect(decide(st0({ lastAt: T0 - 5 * MIN }), DEFAULTS, T0, env())).toEqual({ wait: "spacing", at: T0 + 15 * MIN });
    expect(decide(st0({ lastAt: T0 - 25 * MIN }), DEFAULTS, T0, env({ busy: true }))).toMatchObject({ wait: "busy" });
    expect(decide(st0(), DEFAULTS, T0, env({ running: true }))).toEqual({ wait: "painting" });
  });
  test("asked for by hand: goes first, past the cap, spacing, pause and a busy Codex", () => {
    const st = st0({ today: 99, lastAt: T0, paused: true, queue: [{ id: "m1", force: true }] });
    expect(decide(st, DEFAULTS, T0, env({ busy: true }))).toEqual({ run: { id: "m1", force: true, manual: true } });
  });
  test("failures back off 10, 20 min, then stop; a success clears the streak; a new day gives one fresh try", () => {
    let st = afterRun(st0(), DEFAULTS, T0, { id: "a", ok: false, manual: false, error: "Codex returned no image" });
    expect(st).toMatchObject({ fails: 1, retryAt: T0 + 10 * MIN, failed: { a: 1 } });
    expect(decide(st, DEFAULTS, T0 + 5 * MIN, env())).toEqual({ wait: "retry", at: T0 + 10 * MIN });
    st = afterRun(st, DEFAULTS, T0 + 11 * MIN, { id: "b", ok: false, manual: false });
    expect(st.retryAt).toBe(T0 + 31 * MIN);
    const ok = afterRun(st, DEFAULTS, T0 + 40 * MIN, { id: "a", ok: true, manual: false });
    expect(ok).toMatchObject({ fails: 0, retryAt: 0, today: 1, failed: { b: 1 } });
    st = afterRun(st, DEFAULTS, T0 + 40 * MIN, { id: "c", ok: false, manual: false, error: "login expired" });
    expect(st.stopped).toBe("Stopped after 3 failures in a row: login expired");
    expect(decide(st, DEFAULTS, T0 + 600 * MIN, env())).toEqual({ wait: "stopped" });
    const next = rollDay(st, T0 + 86_400_000);
    expect(next).toMatchObject({ stopped: undefined, fails: 0, today: 0 });
    expect(decide(st0({ paused: true }), DEFAULTS, T0, env())).toEqual({ wait: "paused" });
    expect(decide(st0(), { ...DEFAULTS, auto: false }, T0, env())).toEqual({ wait: "off" });
  });
});

describe("the prompt: house style, one metaphor, no text or clichés", () => {
  const idea = { id: "t1", title: "AI Brain Robot Tender Alerts", row: "automations", pitch: "A glowing AI agent watches Israeli government tenders and emails \"Perfect match!\" bids to one-person shops.", customer: "Freelance designers in Israel", offer: "A daily digest of tenders that fit, 49 ILS a month" };
  const { prompt, subject, category } = coverPrompt(idea, "/tmp/out/t1.png");
  test("uses the row's palette, and a guess from the words when there is no row", () => {
    expect(category).toBe("automations");
    for (const ink of PALETTES.automations.inks) expect(prompt).toContain(ink);
    expect(categoryOf({ title: "Russian Creator Clips Library", pitch: "Short video clips" })).toBe("content");
    expect(categoryOf({ title: "Tender scraper", pitch: "automated alerts" })).toBe("automations");
    expect(categoryOf({ title: "Something", pitch: "else" })).toBe("money");
    // No purple or violet ink anywhere (hue 255–315): the tech cliché stays out of the house style.
    const hueOf = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b); if (!d) return -1; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
    expect(Object.values(PALETTES).flatMap((p) => p.inks).filter((h) => hueOf(h) >= 255 && hueOf(h) <= 315)).toEqual([]);
  });
  test("the idea's own words are scrubbed of clichés and quotes, and never offered as text to draw", () => {
    expect(subject).not.toMatch(/\b(ai|robot|brain|glowing|agent)\b/i);
    expect(subject).not.toContain('"');
    expect(subject).toContain("draw none of these words");
    expect(prompt).toContain(AVOID);
    expect(prompt).toMatch(/No text of any kind/);
    expect(prompt).not.toContain(idea.title); // the title itself tempts a model to letter it
  });
  test("offers a concrete motif for the mechanism, asks for 16:9 with the subject centred, and names the output path", () => {
    expect(subject).toContain("lighthouse beam");
    expect(prompt).toContain("16:9");
    expect(prompt).toContain("central square");
    expect(prompt.trim().endsWith("Save the final PNG to /tmp/out/t1.png and reply with only that absolute path.")).toBe(true);
  });
});

test("Codex is busy when someone else runs `codex exec` or a Codex process works the CPU; our own children and the app's helpers don't count", () => {
  const ps = [
    "100 1 0.0 /Users/x/.nvm/versions/node/v20/bin/node /Users/x/.nvm/versions/node/v20/bin/codex resume 01a",
    "101 100 0.3 /Users/x/.nvm/.../codex-darwin-arm64/vendor/bin/codex resume 01a",
    "200 1 45.0 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service) --type=gpu",
    "300 1 0.1 /Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://",
    "500 1 0.0 bun src/server.ts", "501 500 0.0 node /x/bin/codex exec -C /covers", "502 501 60.0 /x/vendor/codex exec -C /covers",
  ].join("\n");
  expect(codexBusy(ps, 500)).toBe(false);
  expect(codexBusy(`${ps}\n600 1 0.0 /x/vendor/codex exec review`, 500)).toBe(true);
  expect(codexBusy(`${ps}\n700 1 35.2 /x/vendor/codex resume 01b`, 500)).toBe(true);
  expect(codexBusy(`${ps}\n700 1 35.2 /x/vendor/codex resume 01b`, 500, 50)).toBe(false);
});

describe.skipIf(!FFMPEG)("resize: a 16:9 card cover and a square thumb, small", () => {
  test("the fixture is what Codex returns", () => expect(pngSize(new Uint8Array(readFileSync(FIXTURE)))).toEqual({ w: 1536, h: 1024 }));
  for (const tool of ["ffmpeg", "cwebp"] as const) {
    test.skipIf(tool === "cwebp" && !CWEBP)(`with ${tool}`, async () => {
      const base = `${dir}/r-${tool}`;
      const sizes = await makeCovers(FIXTURE, base, tool);
      expect(webpSize(`${base}.webp`)).toEqual({ w: 960, h: 540 });
      expect(webpSize(`${base}_thumb.webp`)).toEqual({ w: 320, h: 320 });
      expect(sizes.main).toBeLessThanOrEqual(MAX_BYTES);
      expect(sizes.thumb).toBeLessThan(40_000);
      expect(sizes.main).toBe(statSync(`${base}.webp`).size);
    });
  }
});

describe.skipIf(!FFMPEG)("the job end to end (fake painter, real files and routes)", () => {
  const data = `${dir}/data`, cov = `${data}/covers`;
  mkdirSync(cov, { recursive: true });
  ideasDb(`${data}/ideas.db`, [
    { id: "hi8", title: "Hebrew Design Reports", row: "automations", score: 8, dropped: false, data: { source: "feed", row: "automations", pitch: "Reports", offer: "PDF reports" } },
    { id: "lo4", title: "Weak", score: 4, dropped: true, data: { source: "feed", pitch: "meh" } },
  ]);
  writeFileSync(`${data}/discover.json`, JSON.stringify({ mixes: [{ id: "sv1", title: "Saved Clip Courier", pitch: "Clips for creators", savedAt: 5 }] }));
  writeFileSync(`${data}/feed.json`, JSON.stringify({ ideas: [] }));
  let clock = T0, calls: string[] = [], fail = false, busy = false;
  const covers = createCovers({
    dir: cov, confFile: `${data}/covers.json`, dataDir: data, enabled: () => true, now: () => clock, tool: "ffmpeg", busy: () => busy,
    paint: async (prompt, out) => { calls.push(prompt); if (fail) throw new Error("Codex returned no image (exit 1)"); copyFileSync(FIXTURE, out); },
  });
  const url = (p: string) => new URL(`http://127.0.0.1${p}`);
  const post = (body: any, ok = true) => covers.route(new Request("http://127.0.0.1/api/covers", { method: "POST", body: JSON.stringify(body) }), url("/api/covers"), ok);

  test("paints the saved idea first, serves it with long cache headers, and decorates idea objects", async () => {
    expect(JSON.parse(readFileSync(`${data}/covers.json`, "utf8"))).toEqual(DEFAULTS);
    await covers.tick();
    expect(calls.length).toBe(1);
    expect(covers.has("sv1")).toBe(true);
    const res = (await covers.route(new Request("http://127.0.0.1/covers/sv1.webp?v=1"), url("/covers/sv1.webp?v=1"), false))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect((await covers.route(new Request("http://127.0.0.1/covers/nope.webp"), url("/covers/nope.webp"), false))!.status).toBe(404);
    expect((await covers.route(new Request("http://127.0.0.1/covers/..%2Fstate.json"), url("/covers/..%2Fstate.json"), false))!.status).toBe(404);
    const idea = { id: "sv1", title: "Saved Clip Courier", pitch: "Clips for creators" };
    const out = await covers.respond({ rows: [{ ideas: [idea, { id: "hi8", title: "H", pitch: "p", row: "saas" }] }], convo: { id: "c1", title: "A chat" } }).json();
    expect(out.rows[0].ideas[0]).toMatchObject({ coverUrl: expect.stringMatching(/^\/covers\/sv1\.webp\?v=\d+$/), thumbUrl: expect.stringMatching(/^\/covers\/sv1_thumb\.webp\?v=/), coverCat: "content" });
    expect(out.rows[0].ideas[1]).toEqual({ id: "hi8", title: "H", pitch: "p", row: "saas", coverCat: "saas" });
    expect(out.convo).toEqual({ id: "c1", title: "A chat" });
    expect(idea).not.toHaveProperty("coverUrl");
    expect(existsSync(`${cov}/work/sv1.png`)).toBe(false);
  });
  test("waits out the spacing and a busy Codex, then takes the critic's favourite; never the dropped one", async () => {
    clock += 5 * MIN;
    expect(covers.tick()).toBeUndefined();
    expect(covers.status().next).toMatchObject({ why: "spacing" });
    clock += 20 * MIN; busy = true;
    expect(covers.tick()).toBeUndefined();
    expect(covers.status().next.why).toBe("busy");
    busy = false;
    await covers.tick();
    expect(covers.has("hi8")).toBe(true);
    clock += 30 * MIN;
    expect(covers.tick()).toBeUndefined();
    expect(covers.status().next.why).toBe("none");
    expect(calls.length).toBe(2);
  });
  test("Generate cover: no repaint unless forced; Regenerate replaces the file with a new version; the token is checked", async () => {
    expect((await post({ op: "generate", id: "sv1" }, false))!.status).toBe(403);
    expect(await (await post({ op: "generate", id: "sv1" }))!.json()).toMatchObject({ note: "It already has a cover" });
    const v1 = covers.status().have.sv1;
    clock += MIN;
    await (await post({ op: "generate", id: "sv1", force: true }))!.json();
    await Bun.sleep(50);
    for (let i = 0; i < 100 && covers.status().running; i++) await Bun.sleep(20);
    expect(covers.status().have.sv1).toBeGreaterThan(v1);
    expect(calls.length).toBe(3);
    expect(await (await post({ op: "generate", id: "zz9" }))!.json()).toEqual({ error: "That idea isn't in the archive" });
  });
  test("repeated failures stop the job and survive a restart; Resume starts it again", async () => {
    fail = true;
    for (let i = 0; i < 3; i++) {
      writeFileSync(`${data}/discover.json`, JSON.stringify({ mixes: [{ id: `new${i}`, title: `New ${i}`, pitch: "p", savedAt: 9 + i }] }));
      clock += 3 * 60 * MIN;
      await covers.tick();
    }
    expect(covers.status().stopped).toMatch(/^Stopped after 3 failures in a row: Codex returned no image/);
    covers.stop();
    const again = createCovers({ dir: cov, confFile: `${data}/covers.json`, dataDir: data, enabled: () => true, now: () => clock, tool: "ffmpeg", busy: () => false, paint: async (_p, out) => copyFileSync(FIXTURE, out) });
    expect(again.status()).toMatchObject({ stopped: expect.stringMatching(/^Stopped/), count: 2 });
    expect(again.tick()).toBeUndefined();
    await (await again.route(new Request("http://127.0.0.1/api/covers", { method: "POST", body: JSON.stringify({ op: "resume" }) }), url("/api/covers"), true))!.json();
    for (let i = 0; i < 100 && again.status().running; i++) await Bun.sleep(20);
    expect(again.status()).toMatchObject({ stopped: undefined, count: 3, last: { id: "new2", ok: true } });
    again.stop();
  });
  test("a cover asked for while another is painting goes next, without waiting for the timer", async () => {
    const d2 = `${dir}/data2`;
    mkdirSync(`${d2}/covers`, { recursive: true });
    writeFileSync(`${d2}/discover.json`, JSON.stringify({ mixes: [{ id: "q1", title: "First", pitch: "p", savedAt: 2 }, { id: "q2", title: "Second", pitch: "p", savedAt: 1 }] }));
    const order: string[] = [];
    const c = createCovers({ dir: `${d2}/covers`, confFile: `${d2}/covers.json`, dataDir: d2, enabled: () => true, tool: "ffmpeg", busy: () => false,
      paint: async (p, out) => { order.push(p.includes("/q1.png") ? "q1" : "q2"); await Bun.sleep(150); copyFileSync(FIXTURE, out); } });
    const run = c.tick();
    expect(c.status().running?.id).toBe("q1");
    await c.route(new Request("http://127.0.0.1/api/covers", { method: "POST", body: JSON.stringify({ op: "generate", id: "q2" }) }), url("/api/covers"), true);
    expect(c.status().queue).toEqual(["q2"]);
    await run;
    for (let i = 0; i < 100 && !c.has("q2"); i++) await Bun.sleep(20);
    expect(order).toEqual(["q1", "q2"]);
    expect(c.status().queue).toEqual([]);
    c.stop();
  });
  test("a node never paints", async () => {
    const node = createCovers({ dir: cov, confFile: `${data}/covers.json`, dataDir: data, enabled: () => false, paint: async () => { throw new Error("must not run"); } });
    expect(node.tick()).toBeUndefined();
    expect(node.status().next.why).toBe("hub-only");
    node.stop();
  });
});
