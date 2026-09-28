import { describe, expect, test } from "bun:test";
import { attempts, canClose, findRow, isNovel, labelFor, nextStep, overlap, plannerPrompt, repairJson, templatePlan, typeOf, vague, validatePlan, type RowLite } from "../autoresearch-core";
import { combined, frontmatter, keepRun, mergeNiches, nicheProblems, parseReport, reportProblems, rubric, sameNiche, score10 } from "../autoresearch-eval";
import { fixtureReport, researchPrompt } from "../autoresearch-prompts";
import { MIN, REPORT, T0, camp, run } from "./autoresearch-fixtures";

describe("planner", () => {
  test("repairJson reads fenced, chatty and sloppy JSON", () => {
    expect(repairJson('```json\n{"question":"a","type":"trend"}\n```').type).toBe("trend");
    expect(repairJson('Sure! Here it is: {"question": "x", "type": "combo",} Hope that helps').type).toBe("combo");
    expect(repairJson("{question: “x”, type: “sizing”}").type).toBe("sizing");
    expect(repairJson("no json here")).toBeUndefined();
    expect(repairJson('{"a": {"b": 1}} trailing {"c":2}').a.b).toBe(1);
  });
  test("types accept aliases", () => {
    expect(typeOf("Trend scan")).toBe("trend");
    expect(typeOf("competitor-teardown")).toBe("teardown");
    expect(typeOf("market sizing")).toBe("sizing");
    expect(typeOf("nonsense")).toBeUndefined();
  });
  test("validatePlan keeps a good plan and rejects bad type, short or repeated questions", () => {
    const prev = ["Trend scan: what is rising in AI video tools for podcasters right now?"];
    const ok = validatePlan('{"question":"Competitor teardown for AI podcast clip tools: prices and complaints","type":"teardown","why":"top niche","focus":"AI clip studio"}', prev);
    expect(ok?.type).toBe("teardown");
    expect(ok?.planner).toBe("claude");
    expect(ok?.focus).toBe("AI clip studio");
    expect(validatePlan('{"question":"Competitor teardown for podcast clip tools","type":"banana"}', prev)).toBeUndefined();
    expect(validatePlan('{"question":"short","type":"trend"}', prev)).toBeUndefined();
    expect(validatePlan('{"question":"Trend scan: what is rising in AI video tools for podcasters right now?","type":"trend"}', prev)).toBeUndefined();
    expect(validatePlan("I think you should research podcasts", prev)).toBeUndefined();
  });
  test("novelty: near-duplicates are not new, different angles are", () => {
    expect(overlap("AI clip tools for podcasters", "Podcasters' AI clip tools")).toBeGreaterThan(0.6);
    expect(isNovel("What AI clip tools do podcasters pay for?", ["What AI clip tools do podcasters pay for right now?"])).toBe(false);
    expect(isNovel("Where do Human Design coaches gather online?", ["What AI clip tools do podcasters pay for?"])).toBe(true);
  });
  test("the template planner explores first, then walks the best niche through the follow-ups without repeating", () => {
    const c = camp();
    const p1 = templatePlan(c);
    expect(p1.type).toBe("trend");
    c.runs.push(run({ question: p1.question, type: p1.type }));
    const { board } = mergeNiches([], parseReport(REPORT()).niches, 1, T0);
    c.board = board;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = templatePlan(c, ["yt-transcriber"]);
      expect(isNovel(p.question, c.runs.map((r) => r.question))).toBe(true);
      seen.push(`${p.type}:${p.focus ?? ""}`);
      c.runs.push(run({ id: `r${i + 2}`, n: i + 2, question: p.question, type: p.type, focus: p.focus }));
    }
    expect(seen[0]).toBe("deep_dive:AI clip studio for podcasters");
    expect(seen[1]).toBe("teardown:AI clip studio for podcasters");
    expect(new Set(seen).size).toBe(seen.length);
  });
  test("the planner prompt carries the goal, what was asked and the leaderboard", () => {
    const c = camp({ runs: [run()], board: mergeNiches([], parseReport(REPORT()).niches, 1, T0).board, seeds: ["podcasts"] });
    const { system, user } = plannerPrompt(c, ["yt-transcriber: clips"]);
    expect(system).toContain("strict JSON");
    expect(user).toContain(c.goal);
    expect(user).toContain("Trend scan: AI video tools");
    expect(user).toContain("AI clip studio for podcasters");
    expect(user).toContain("yt-transcriber");
  });
});

// ── reports ────────────────────────────────────────────────────────────────────────
describe("reports", () => {
  test("front matter with nested scores, word and fraction scores, and the JSON block", () => {
    const r = parseReport(REPORT());
    expect(r.ok).toBe(true);
    expect(r.question).toBe("What is rising in AI video?");
    expect(r.type).toBe("trend");
    expect(r.verdict).toStartWith("pursue");
    expect(r.scores).toEqual({ demand: 8, willingness_to_pay: 7, competition: 4, fit_with_user_assets: 9, timing: 8, confidence: 6 });
    expect(r.niches.length).toBe(2);
    expect(r.niches[0].pains[0].url).toContain("reddit.com");
    expect(r.niches[0].evidence.length).toBeGreaterThanOrEqual(3);
    expect(r.openQuestions).toEqual(["Would they pay yearly?"]);
    expect(r.title).toBe("Podcast clips are hot");
  });
  test("flat scores work; missing verdict or too few scores is invalid", () => {
    const flat = REPORT({ scores: "demand: 6\nwillingness_to_pay: 5\ncompetition: 3\nfit: 7\nheat: 8\nconfidence: 5" });
    expect(parseReport(flat).ok).toBe(true);
    expect(parseReport(flat).scores.fit_with_user_assets).toBe(7);
    expect(parseReport(REPORT({ verdict: "" })).error).toContain("verdict");
    expect(parseReport(REPORT({ scores: "scores:\n  demand: 6\n  timing: 4" })).ok).toBe(false);
    expect(parseReport("# no front matter").error).toBe("no front matter");
  });
  test("no JSON block: the report's own scores describe one niche named by its title", () => {
    const r = parseReport(REPORT({ json: "not json" }));
    expect(r.ok).toBe(true);
    expect(r.niches.length).toBe(1);
    expect(r.niches[0].name).toBe("Podcast clips are hot");
    expect(r.niches[0].scores.demand).toBe(8);
  });
  test("score10 normalizes the ways models write scores", () => {
    expect(score10("7/10")).toBe(7);
    expect(score10("3/5")).toBe(6);
    expect(score10("80%")).toBe(8);
    expect(score10(0.7)).toBe(7);
    expect(score10("high")).toBe(8);
    expect(score10(14)).toBe(10);
    expect(score10("n/a")).toBeUndefined();
  });
  test("front matter parses lists and inline objects", () => {
    const { data } = frontmatter("---\ntags: [a, b]\nscores: {demand: 5, competition: 2}\n---\nbody");
    expect(data.tags).toEqual(["a", "b"]);
    expect(data.scores.demand).toBe("5");
  });
  test("the fixture report is a valid report; the research prompt has the rules and the format", () => {
    const r = run({ question: "Trend scan: AI video", reportPath: "/Users/me/.config/herdr-deck/research/c1/01-x.md" });
    expect(parseReport(fixtureReport(r, camp())).ok).toBe(true);
    const p = researchPrompt(r, camp(), ["yt-transcriber"], { home: "/Users/me" });
    expect(p).toContain("~/.config/herdr-deck/research/c1/01-x.md");
    expect(p).toContain("/last30days");
    expect(p).toMatch(/Never contact, message/);
    expect(p).toContain("fit_with_user_assets");
    expect(p).toContain("```json");
    expect(p).toContain("AskUserQuestion");
  });
});

// ── evaluator ─────────────────────────────────────────────────────────────────────────
describe("evaluator", () => {
  test("rubric rewards demand, pay, fit and heat, and penalizes competition and thin evidence", () => {
    const base = { demand: 7, willingness_to_pay: 7, competition: 5, fit_with_user_assets: 7, timing: 7, confidence: 7 };
    expect(rubric({ ...base, demand: 9 }, 10)).toBeGreaterThan(rubric(base, 10));
    expect(rubric({ ...base, competition: 9 }, 10)).toBeLessThan(rubric(base, 10));
    expect(rubric(base, 0)).toBeLessThan(rubric(base, 10));
    expect(rubric({ ...base, confidence: 2 }, 10)).toBeLessThan(rubric(base, 10));
    expect(combined(60)).toBe(60);
    expect(combined(60, 0.9)).toBe(Math.round(0.65 * 60 + 0.35 * 90));
  });
  test("duplicates merge (scores averaged, evidence unioned) and the board is ranked", () => {
    expect(sameNiche("AI clip studio for podcasters", "Podcasters AI clip studio")).toBe(true);
    expect(sameNiche("AI clip studio for podcasters", "Human Design readings")).toBe(false);
    const a = parseReport(REPORT()).niches;
    const first = mergeNiches([], a, 1, T0);
    expect(first.board.length).toBe(2);
    expect(first.board[0].name).toBe("AI clip studio for podcasters");
    const again = [{ ...a[0], name: "Podcasters AI clip studio", evidence: ["https://example.com/new"], scores: { ...a[0].scores, demand: 6 } }];
    const second = mergeNiches(first.board, again, 2, T0 + MIN);
    const n = second.board.find((x) => x.id === first.board[0].id)!;
    expect(second.board.length).toBe(2);
    expect(n.seen).toBe(2);
    expect(n.runs).toEqual([1, 2]);
    expect(n.scores.demand).toBe(7);
    expect(n.evidence).toContain("https://example.com/new");
    expect(second.ids).toEqual([n.id]);
    // Sorted by score, best first.
    for (let i = 1; i < second.board.length; i++) expect(second.board[i - 1].score).toBeGreaterThanOrEqual(second.board[i].score);
  });
  test("keep a run that lands a strong niche in the top 10, discard one that adds nothing", () => {
    const { board, ids } = mergeNiches([], parseReport(REPORT()).niches, 1, T0);
    expect(keepRun([], board, ids)).toBe(true);
    const weak = mergeNiches(board, [{ ...parseReport(REPORT()).niches[1], name: "Obscure thing", evidence: [], scores: { demand: 1, willingness_to_pay: 1, competition: 9, fit_with_user_assets: 1, timing: 1, confidence: 1 } }], 2, T0);
    expect(keepRun(board, weak.board, weak.ids)).toBe(false);
  });
});

// ── slop filters ───────────────────────────────────────────────────────────────────────
describe("slop filters", () => {
  const good = () => parseReport(REPORT()).niches[0];
  test("a niche needs a named buyer, a place, an observed price and linked pains", () => {
    expect(nicheProblems(good())).toEqual([]);
    expect(nicheProblems({ ...good(), name: "AI platform for creators" })).toContain("buzzword niche, no specific product or job");
    expect(nicheProblems({ ...good(), name: "All-in-one clip studio" })).toContain("buzzword niche, no specific product or job");
    expect(nicheProblems({ ...good(), audience: "businesses and creators" })).toContain("no named buyer");
    expect(nicheProblems({ ...good(), where: [{ name: "Reddit", url: "" }] })).toContain("no linked place where the buyers gather");
    expect(nicheProblems({ ...good(), prices: ["affordable"], competitors: [{ name: "X", url: "" }] })).toContain("no price observed in the market");
    expect(nicheProblems({ ...good(), prices: ["₪49 a month"], competitors: [] })).not.toContain("no price observed in the market");
    expect(nicheProblems({ ...good(), pains: [{ quote: "people hate it", url: "" }] })).toContain("no linked pains");
  });
  test("a report with too few sources or generic filler is discarded whole", () => {
    const r = parseReport(REPORT());
    expect(reportProblems(r, REPORT())).toEqual([]);
    const thin = REPORT({ json: JSON.stringify({ niches: [] }) }).replace(/https:\/\/[^\s)]+/g, "https://www.reddit.com/r/x/");
    expect(reportProblems(parseReport(thin), thin)[0]).toMatch(/^unsourced/);
    const fluff = REPORT() + "\nIn today's fast-paced, ever-evolving landscape of creators, this game-changer will revolutionize everything with cutting-edge AI.";
    expect(reportProblems(parseReport(fluff), fluff).join()).toContain("generic language");
  });
  test("vague planner questions are refused", () => {
    expect(vague("Research the AI market")).toBe(true);
    expect(vague("Trends in general")).toBe(true);
    expect(vague("What do Etsy sellers of Human Design charts charge, and what do 1–3★ reviews complain about?")).toBe(false);
    expect(validatePlan('{"question":"Research everything about the AI market for creators","type":"trend"}', [])).toBeUndefined();
  });
});

// ── loop decisions ───────────────────────────────────────────────────────────────────
describe("loop decisions", () => {
  test("budget, failures, quiet hours, daily cap and the kill switch", () => {
    expect(nextStep(camp(), T0).act).toBe("plan");
    expect(nextStep(camp(), T0, true).act).toBe("none");
    expect(nextStep(camp({ status: "paused" }), T0).act).toBe("none");
    expect(nextStep(camp({ runs: [run({ state: "running" })] }), T0).act).toBe("none");
    expect(nextStep(camp({ budget: 1, runs: [run()] }), T0).act).toBe("done");
    expect(nextStep(camp({ failStreak: 2, runs: [run({ state: "failed" }), run({ id: "r2", n: 2, state: "failed" })] }), T0).act).toBe("pause");
    const q = nextStep(camp({ quiet: { on: true, from: "11:00", to: "13:00" } }), T0);
    expect(q.act).toBe("wait");
    expect(q.why).toContain("13:00");
    expect(nextStep(camp({ quiet: { on: true, from: "22:00", to: "07:00" } }), T0).act).toBe("plan");
    const capped = camp({ dailyCap: 2, runs: [run(), run({ id: "r2", n: 2 })] });
    expect(nextStep(capped, T0 + MIN).act).toBe("wait");
    expect(nextStep(capped, T0 + 24 * 60 * MIN).act).toBe("plan"); // tomorrow
    expect(attempts(camp({ runs: [run({ state: "skipped", startedAt: undefined }), run({ state: "failed" })] }))).toBe(1);
  });
  test("only the loop's own session may be closed", () => {
    const r = run({ key: "main/p1", cwd: "/w/c1", label: "research: AI video" });
    expect(canClose({ key: "main/p1", tab: "research: AI video", cwd: "/w/c1" }, r)).toBe(true);
    expect(canClose({ key: "main/p2", tab: "research: AI video", cwd: "/w/c1" }, r)).toBe(false); // another pane
    expect(canClose({ key: "main/p1", tab: "my real work", cwd: "/w/c1" }, r)).toBe(false); // renamed: not ours any more
    expect(canClose({ key: "main/p1", tab: "research: AI video", cwd: "/Users/me/project" }, r)).toBe(false); // somewhere else
    expect(canClose(undefined, r)).toBe(false);
    expect(canClose({ key: "main/p1", tab: "research: x", cwd: "/w/c1" }, { ...r, key: undefined })).toBe(false);
  });
  test("a run's row is found by key, else by label and folder, else by its report path", () => {
    const rows: RowLite[] = [{ key: "a", tab: "research: x", status: "idle", cwd: "/w" }, { key: "b", tab: "other", status: "idle", cwd: "/w", firstPrompt: "write to /r/01-x.md" }];
    expect(findRow(rows, { key: "a", label: "zzz", cwd: "/q", reportPath: "/none" })?.key).toBe("a");
    expect(findRow(rows, { label: "research: x", cwd: "/w", reportPath: "/none" })?.key).toBe("a");
    expect(findRow(rows, { label: "research: y", cwd: "/w", reportPath: "/r/01-x.md" })?.key).toBe("b");
    expect(findRow(rows, { label: "research: y", cwd: "/w", reportPath: "/r/02.md" })).toBeUndefined();
    expect(labelFor("Trend scan: what is rising in AI video tools for podcasters and more")).toMatch(/^research: what is rising/);
    expect(labelFor("x".repeat(80)).length).toBeLessThanOrEqual(46);
    expect(labelFor('Competitor teardown for "GEO audits": who sells what')).toBe("research: teardown GEO audits: who sells what");
  });
});
