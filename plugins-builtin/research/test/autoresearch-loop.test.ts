import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RowLite } from "../autoresearch-core";
import { combined } from "../autoresearch-eval";
import { createAutoresearch, type Deps } from "../autoresearch";
import { MIN, REPORT, T0 } from "./autoresearch-fixtures";

const root = mkdtempSync(`${tmpdir()}/deck-research-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirN = 0;
const scratch = () => { const d = `${root}/t${++dirN}`; mkdirSync(d, { recursive: true }); return d; };

// ── the engine, end to end with stand-in deps ───────────────────────────────────────────
function harness(o: { plan?: Deps["plan"]; jev?: Deps["jev"]; conf?: any; startHang?: boolean } = {}) {
  const dir = scratch();
  let t = T0;
  const rows: (RowLite & { tab: string })[] = [
    { key: "main/w1", tab: "my real work", title: "real work", status: "done", cwd: "/Users/me/proj" }, // never to be touched
    { key: "main/w2", tab: "research: not ours", title: "someone else", status: "idle", cwd: "/elsewhere" },
  ];
  const calls = { start: [] as any[], close: [] as string[], keys: [] as any[], send: [] as any[], notify: [] as any[], plan: 0, jev: 0 };
  let pane = 0;
  const deps: Deps = {
    rows: () => rows,
    start: async (s) => {
      calls.start.push(s);
      if (o.startHang) await new Promise(() => {});
      await Bun.sleep(5);
      const key = `main/r${++pane}`;
      rows.push({ key, tab: s.label, title: s.label, status: "working", cwd: s.cwd, firstPrompt: s.prompt });
      return { key };
    },
    close: async (key) => { calls.close.push(key); const i = rows.findIndex((r) => r.key === key); if (i >= 0) rows.splice(i, 1); return { ok: true }; },
    keys: async (key, keys) => { calls.keys.push({ key, keys }); },
    send: async (key, text) => { calls.send.push({ key, text }); },
    screen: async () => "Do you trust the files in this folder?\n❯ 1. Yes, proceed",
    plan: o.plan ? async (...a) => { calls.plan++; return o.plan!(...a); } : undefined,
    jev: o.jev ? async (...a) => { calls.jev++; return o.jev!(...a); } : undefined,
    notify: (m) => { calls.notify.push(m); },
  };
  const ar = createAutoresearch({ dir: `${dir}/state`, workRoot: `${dir}/work`, self: "mac", now: () => t, planner: o.plan ? "claude" : "template", ...o.conf }, deps);
  const h = {
    ar, rows, calls, dir, deps,
    advance: (ms: number) => { t += ms; },
    now: () => t,
    create: (b: any = {}) => ar.create({ goal: "Best niches for AI video tools", budget: 3, dailyCap: 10, confirm: true, ...b }),
    c: () => ar.store.campaigns[0],
    active: () => ar.store.campaigns[0].runs.find((r) => ["starting", "running", "evaluating"].includes(r.state)),
    /** The agent finishes: writes its report and goes idle. */
    finish: (report = REPORT()) => {
      const r = h.active()!;
      writeFileSync(r.reportPath, report);
      const row = rows.find((x) => x.key === r.key);
      if (row) row.status = "done";
    },
  };
  return h;
}

describe("engine", () => {
  test("nothing runs without a confirmed campaign", async () => {
    const h = harness();
    expect(() => h.ar.create({ goal: "Best niches for AI video tools", budget: 3 })).toThrow(/Confirm/);
    expect(() => h.ar.create({ goal: "x", confirm: true })).toThrow(/goal/);
    await h.ar.tick();
    expect(h.calls.start.length).toBe(0);
  });

  test("plan → run → evaluate → keep → close its own session → next run → done, with a push", async () => {
    const h = harness({ jev: async () => ({ answers: { customers: { noul: 0.8 } }, fallback: null }) });
    h.create({ budget: 2 });
    await h.ar.tick();
    expect(h.calls.start.length).toBe(1);
    const s = h.calls.start[0];
    expect(s.label).toMatch(/^research: /);
    expect(s.cwd).toBe(`${h.dir}/work/${h.c().slug}`);
    expect(existsSync(s.cwd)).toBe(true);
    expect(s.prompt).toContain(h.c().runs[0].reportPath);
    expect(h.c().runs[0].state).toBe("running");
    // Still working, no report: nothing happens.
    h.advance(MIN); await h.ar.tick();
    expect(h.c().runs[0].state).toBe("running");
    // Report written but the agent is still working: wait for it to finish its turn.
    writeFileSync(h.c().runs[0].reportPath, REPORT());
    await h.ar.tick();
    expect(h.c().runs[0].state).toBe("running");
    h.rows.find((r) => r.key === h.c().runs[0].key)!.status = "done";
    await h.ar.tick();
    const r1 = h.c().runs[0];
    expect(r1.state).toBe("kept");
    expect(r1.merged).toBe(true);
    expect(r1.best?.name).toBe("AI clip studio for podcasters");
    expect(h.calls.jev).toBe(1); // only niches that pass the bar are scored and ranked
    expect(r1.rejected).toEqual([{ name: "Faceless explainers for course creators", why: "no named buyer; no linked place where the buyers gather; no price observed in the market; no linked pains" }]);
    expect(h.c().board.map((n) => n.name)).toEqual(["AI clip studio for podcasters"]);
    expect(h.c().board[0].jev).toBe(0.8);
    expect(h.c().board[0].score).toBe(combined(h.c().board[0].rubric, 0.8));
    expect(h.calls.close).toEqual([r1.key!]);
    expect(r1.closed).toBe("closed");
    expect(h.calls.notify.some((m: any) => /Top niche/.test(m.title))).toBe(true);
    // Next tick plans and starts run 2 (a follow-up on the best niche), and so on to the budget.
    h.advance(MIN); await h.ar.tick();
    expect(h.calls.start.length).toBe(2);
    expect(h.c().runs[1].type).toBe("deep_dive");
    h.finish(REPORT({ question: "deep dive" }));
    await h.ar.tick();
    expect(h.c().runs[1].state).toMatch(/kept|discarded/);
    await h.ar.tick();
    expect(h.c().status).toBe("done");
    expect(h.calls.start.length).toBe(2);
    expect(h.calls.notify.some((m: any) => /Research finished/.test(m.title))).toBe(true);
    // The user's other sessions were never touched.
    expect(h.calls.close).not.toContain("main/w1");
    expect(h.calls.close).not.toContain("main/w2");
    expect(h.rows.some((r) => r.key === "main/w1")).toBe(true);
    // Persisted.
    const disk = JSON.parse(readFileSync(`${h.dir}/state/campaigns.json`, "utf8"));
    expect(disk.campaigns[0].runs.length).toBe(2);
    expect(disk.campaigns[0].board.length).toBeGreaterThan(0);
  });

  test("idempotent start: concurrent ticks start exactly one session", async () => {
    const h = harness();
    h.create();
    await Promise.all([h.ar.tick(), h.ar.tick(), h.ar.tick()]);
    await h.ar.tick();
    expect(h.calls.start.length).toBe(1);
    expect(h.c().runs.length).toBe(1);
  });

  test("resume after a restart: a run caught mid-start is adopted if its session exists, never started twice", async () => {
    const h = harness({ startHang: true });
    h.create();
    const p = h.ar.tick(); // start() hangs: the deck "dies" here with the run persisted as starting
    await Bun.sleep(20);
    expect(h.c().runs[0].state).toBe("starting");
    const persisted = readFileSync(`${h.dir}/state/campaigns.json`, "utf8");
    void p;
    // The session did get created before the crash.
    const r0 = JSON.parse(persisted).campaigns[0].runs[0];
    h.rows.push({ key: "main/late", tab: r0.label, title: r0.label, status: "working", cwd: r0.cwd });
    // A fresh engine on the same state, with working deps.
    const calls: any[] = [];
    const ar2 = createAutoresearch({ dir: `${h.dir}/state`, workRoot: `${h.dir}/work`, self: "mac", now: () => h.now(), planner: "template" }, { ...h.deps, start: async (s) => { calls.push(s); return { key: "main/new" }; } });
    await ar2.tick();
    expect(ar2.store.campaigns[0].runs[0].state).toBe("running");
    expect(ar2.store.campaigns[0].runs[0].key).toBe("main/late");
    expect(calls.length).toBe(0);
  });

  test("resume after a restart: no session to adopt → failed as interrupted (no failure streak), then the next run", async () => {
    const h = harness({ startHang: true });
    h.create();
    void h.ar.tick();
    await Bun.sleep(20);
    const calls: any[] = [];
    const ar2 = createAutoresearch({ dir: `${h.dir}/state`, workRoot: `${h.dir}/work`, self: "mac", now: () => h.now(), planner: "template" }, { ...h.deps, start: async (s) => { calls.push(s); return { key: "main/new" }; } });
    await ar2.tick(); // too soon to give up on it
    expect(ar2.store.campaigns[0].runs[0].state).toBe("starting");
    expect(calls.length).toBe(0);
    h.advance(3 * MIN);
    await ar2.tick();
    const c = ar2.store.campaigns[0];
    expect(c.runs[0].state).toBe("failed");
    expect(c.runs[0].interrupted).toBe(true);
    expect(c.failStreak).toBe(0);
    await ar2.tick();
    expect(calls.length).toBe(1); // a NEW run (#2), not the old one again
    expect(c.runs[1].n).toBe(2);
  });

  test("timeout: no report in time → failed, its session closed; two failures in a row → paused with a push", async () => {
    const h = harness({ conf: { timeoutMs: 10 * MIN } });
    h.create({ budget: 5 });
    await h.ar.tick();
    h.advance(11 * MIN); await h.ar.tick();
    expect(h.c().runs[0].state).toBe("failed");
    expect(h.c().runs[0].error).toContain("No valid report");
    expect(h.calls.close).toEqual([h.c().runs[0].key!]);
    await h.ar.tick(); // run 2
    expect(h.calls.start.length).toBe(2);
    h.advance(11 * MIN); await h.ar.tick();
    await h.ar.tick();
    expect(h.c().status).toBe("paused");
    expect(h.c().reason).toContain("Two runs in a row");
    expect(h.calls.start.length).toBe(2);
    expect(h.calls.notify.some((m: any) => /paused/i.test(m.title))).toBe(true);
    // Resuming clears the streak and runs again.
    await h.ar.control(h.c().id, "resume");
    await h.ar.tick();
    expect(h.calls.start.length).toBe(3);
  });

  test("a weak report is discarded, says why, and leaves the leaderboard as it was", async () => {
    const h = harness();
    h.create();
    await h.ar.tick();
    h.finish(); await h.ar.tick();
    const board = JSON.stringify(h.c().board);
    await h.ar.tick();
    const weak = { name: "Transcript search for local journalists", summary: "search", audience: "local newspaper journalists", where: [{ name: "r/Journalism", url: "https://www.reddit.com/r/Journalism/" }], pains: [{ quote: "I can't find what the mayor said", url: "https://www.reddit.com/r/Journalism/comments/x/" }], price_points: ["$12/mo"], scores: { demand: 2, willingness_to_pay: 2, competition: 9, fit_with_user_assets: 3, timing: 2, confidence: 3 } };
    h.finish(REPORT({ json: JSON.stringify({ niches: [weak] }) }));
    await h.ar.tick();
    const r2 = h.c().runs[1];
    expect(r2.state).toBe("discarded");
    expect(r2.discardWhy).toMatch(/^its best niche scored \d+; the bar is 50$/);
    expect(r2.best?.name).toBe(weak.name);
    expect(JSON.stringify(h.c().board)).toBe(board);
  });

  test("an invalid report is not accepted; the session closing early fails the run", async () => {
    const h = harness();
    h.create();
    await h.ar.tick();
    writeFileSync(h.active()!.reportPath, REPORT({ verdict: "" }));
    h.rows.find((r) => r.key === h.active()!.key)!.status = "done";
    await h.ar.tick();
    expect(h.c().runs[0].state).toBe("running");
    h.rows.splice(h.rows.findIndex((r) => r.key === h.c().runs[0].key), 1);
    h.advance(2 * MIN); await h.ar.tick();
    expect(h.c().runs[0].state).toBe("failed");
    expect(h.c().runs[0].closed).toBe("gone");
    expect(h.calls.close.length).toBe(0);
  });

  test("quiet hours and the daily cap hold new runs", async () => {
    const h = harness();
    const hh = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const nowMin = new Date(T0).getHours() * 60;
    h.create({ quiet: { on: true, from: hh(nowMin - 60), to: hh(nowMin + 60) } });
    await h.ar.tick();
    expect(h.calls.start.length).toBe(0);
    expect(h.c().waiting).toContain("Quiet hours");
    h.advance(61 * MIN); await h.ar.tick();
    expect(h.calls.start.length).toBe(1);
    const h2 = harness();
    h2.create({ dailyCap: 1, budget: 3 });
    await h2.ar.tick();
    h2.finish(); await h2.ar.tick();
    await h2.ar.tick();
    expect(h2.calls.start.length).toBe(1);
    expect(h2.c().waiting).toContain("cap");
    h2.advance(24 * 60 * MIN); await h2.ar.tick();
    expect(h2.calls.start.length).toBe(2);
  });

  test("pause lets the current run finish but starts nothing new; skip and stop close only its own session", async () => {
    const h = harness();
    h.create({ budget: 5 });
    await h.ar.tick();
    await h.ar.control(h.c().id, "pause");
    h.finish(); await h.ar.tick();
    expect(h.c().runs[0].state).toBe("kept");
    await h.ar.tick();
    expect(h.calls.start.length).toBe(1);
    await h.ar.control(h.c().id, "resume");
    await h.ar.tick();
    expect(h.calls.start.length).toBe(2);
    const k2 = h.active()!.key!;
    await h.ar.control(h.c().id, "skip");
    expect(h.c().runs[1].state).toBe("skipped");
    expect(h.calls.close).toEqual([h.c().runs[0].key!, k2]);
    await h.ar.tick();
    const k3 = h.active()!.key!;
    // The user renamed the research tab to adopt it: stop no longer closes it.
    h.rows.find((r) => r.key === k3)!.tab = "keep this one";
    await h.ar.control(h.c().id, "stop");
    expect(h.c().status).toBe("stopped");
    expect(h.c().runs[2].closed).toBe("left-open");
    expect(h.calls.close).not.toContain(k3);
    expect(h.calls.close).not.toContain("main/w1");
  });

  test("the kill switch stops everything and blocks resume until it's off", async () => {
    const h = harness();
    h.create();
    await h.ar.tick();
    await h.ar.kill(true);
    expect(h.c().status).toBe("paused");
    expect(h.c().runs[0].state).toBe("skipped");
    expect(h.calls.close.length).toBe(1);
    await expect(h.ar.control(h.c().id, "resume")).rejects.toThrow(/kill switch/);
    await h.ar.tick();
    expect(h.calls.start.length).toBe(1);
    await h.ar.kill(false);
    await h.ar.control(h.c().id, "resume");
    await h.ar.tick();
    expect(h.calls.start.length).toBe(2);
  });

  test("its own folder's trust question is answered once; other blocked sessions are left alone", async () => {
    const h = harness();
    h.create();
    await h.ar.tick();
    const row = h.rows.find((r) => r.key === h.active()!.key)!;
    row.status = "blocked";
    h.rows[0].status = "blocked";
    await h.ar.tick();
    await h.ar.tick();
    expect(h.calls.keys).toEqual([{ key: row.key, keys: ["enter"] }]);
  });

  test("a first message lost to a restart is re-sent once to the same session", async () => {
    const h = harness();
    h.create();
    await h.ar.tick();
    const row = h.rows.find((r) => r.key === h.active()!.key)!;
    row.status = "idle"; delete row.firstPrompt;
    h.advance(5 * MIN); await h.ar.tick(); await h.ar.tick();
    expect(h.calls.send.length).toBe(1);
    expect(h.calls.send[0].key).toBe(row.key);
    expect(h.calls.start.length).toBe(1);
  });

  test("the Claude planner is used when it answers well, the template when it doesn't", async () => {
    const answers = ['{"question":"Where do podcasters who pay for clip tools gather online?","type":"channel","why":"reach","focus":""}', "garbage", '{"question":"Where do podcasters who pay for clip tools gather online?","type":"channel"}'];
    let i = 0;
    const h = harness({ plan: async () => answers[i++] ?? "garbage" });
    h.create({ budget: 3 });
    await h.ar.tick();
    expect(h.c().runs[0].planner).toBe("claude");
    expect(h.c().runs[0].type).toBe("channel");
    h.finish(); await h.ar.tick(); await h.ar.tick();
    expect(h.c().runs[1].planner).toBe("template"); // garbage
    h.finish(); await h.ar.tick(); await h.ar.tick();
    expect(h.c().runs[2].planner).toBe("template"); // a repeat of run 1
    expect(h.calls.plan).toBe(3);
    expect(h.ar.store.stats.planner).toBe(3);
    expect(h.ar.store.stats.plannerFallback).toBe(2);
  });

  test("fake runner mode runs the whole loop on fixture reports, failures included", async () => {
    const dir = scratch();
    let t = T0;
    const closes: string[] = [];
    const ar = createAutoresearch({ dir, workRoot: `${dir}/work`, self: "mac", now: () => t, planner: "template", fake: { ms: 20, fail: [2] }, timeoutMs: 5 * MIN },
      { rows: () => [{ key: "main/w1", tab: "research: fake-looking but real", status: "done", cwd: `${dir}/work` }], start: async () => { throw new Error("real start in fake mode"); }, close: async (k) => { closes.push(k); return { ok: true }; } });
    const campaign = ar.create({ goal: "Hot AI-video businesses", budget: 3, confirm: true });
    // Fixture scores depend on the campaign ID; this seed clears the rubric's keep threshold.
    campaign.id = "fixture-0";
    for (let i = 0; i < 40 && ar.store.campaigns[0].status === "running"; i++) { await ar.tick(); await Bun.sleep(30); t += MIN; }
    const c = ar.store.campaigns[0];
    expect(c.status).toBe("done");
    expect(c.runs.map((r) => r.state)).toEqual([expect.stringMatching(/kept|discarded/), "failed", expect.stringMatching(/kept|discarded/)]);
    expect(c.board.length).toBeGreaterThan(0);
    expect(closes).toEqual([]); // fake sessions are closed in the fake runner, real ones never
    expect(ar.fakes.size).toBe(0);
    const st = await ar.state();
    expect(st.fake).toBe(true);
    expect(st.campaigns[0].runs[0].reportPath).toContain("01-");
  });

  test("switched off mid-run: its timers are cancelled, nothing starts or saves; the next start carries on", async () => {
    const h = harness();
    let cancelled = 0;
    h.ar.start({ every: () => () => { cancelled++; }, after: () => () => {} });
    h.create(); await h.ar.tick();
    expect(h.active()?.state).toBe("running");
    const file = `${h.dir}/state/campaigns.json`, before = readFileSync(file, "utf8");
    h.ar.stop();
    expect(cancelled).toBe(1);
    h.finish(); h.advance(MIN); await h.ar.tick();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(h.calls.start.length).toBe(1);
    // Switched on again: a new loop over the same folder evaluates the run the session finished meanwhile.
    const again = createAutoresearch({ dir: `${h.dir}/state`, workRoot: `${h.dir}/work`, self: "mac", now: h.now, planner: "template" }, h.deps);
    await again.tick();
    expect(again.store.campaigns[0].runs[0].state).toBe("kept");
  });
  test("state and report endpoints", async () => {
    const h = harness();
    h.create();
    await h.ar.tick();
    h.finish(); await h.ar.tick();
    const st = await h.ar.handle("/api/research", {});
    expect(st.campaigns[0].runs[0].prompt).toBeUndefined();
    expect(st.presets.length).toBeGreaterThanOrEqual(6);
    const rep = await h.ar.handle("/api/research/report", { id: h.c().id, n: 1 });
    expect(rep.text).toStartWith("# Podcast clips are hot");
    const pp = await h.ar.handle("/api/research/plan-prompt", { id: h.c().id, niche: h.c().board[0].id }, { ideasDir: `${h.dir}/ideas`, projectsDir: h.dir });
    expect(pp.prompt).toContain("AI clip studio for podcasters");
    expect(pp.prompt).toContain("don't contact");
    const d = await h.ar.handle("/api/research/draft", { goal: "Human Design products", budget: 10, dailyCap: 4 });
    expect(d.estimate.days).toBe(3);
    await expect(h.ar.handle("/api/research/draft", { goal: "Human Design products", machine: "linux" })).rejects.toThrow(/Unknown machine/);
  });
});
