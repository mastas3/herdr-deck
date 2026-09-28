import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function ui() {
  const calls: any[] = [];
  const context: any = vm.createContext({ URL, Date, Set, Map, console,
    S: { gal: { data: { lanes: [] }, kits: new Map(), full: new Map() }, opp: {}, disc: {} },
    esc: (x: unknown) => String(x ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)),
    galPlaying: () => undefined, galHasKit: () => false, galSaved: () => false, galCompHTML: () => "", galKitHTML: () => "Existing kit",
    ICON: { x: "", copy: "" }, agoText: () => "today", reduceMotion: { matches: true },
    api: async (path: string, body: unknown) => { calls.push({ path, body }); return path.endsWith("dossier") ? { id: "notebook-1" } : { item: { id: "notebook-1" } }; },
    oAccept: () => {}, store: () => {}, renderDiscover: () => {}, opportunitiesLoad: () => {}, $: () => ({ scrollTop: 0 }), toast: () => {},
  });
  for (const f of ["gallery-evidence", "gallery-cards", "gallery-detail"]) vm.runInContext(readFileSync(new URL(`../js/${f}.js`, import.meta.url), "utf8"), context);
  return { context, calls, run: (s: string) => vm.runInContext(s, context) };
}
test("legacy confidence and first-dollar claims are absent from rendered cards and details", () => {
  const u = ui();
  u.context.card = { id: "legacy", name: "A <script>pitch</script>", hook: "A pitch", buyer: "Trades", price: "$99", quality: 99, jevP10: 0.99, evidenceScore: 1, patterns: 1, timeToFirstDollarDays: 2, connectors: [], missing: [], stack: [], evidence: [], topics: [] };
  const card = u.run("galCardHTML(card, 0)"), detail = u.run("galSheetHTML(card, false)");
  for (const html of [card, detail]) {
    expect(html).toContain("Untested idea"); expect(html).not.toContain("<script>");
    for (const claim of ["99%", "quality", "First $", "2 days", "Success patterns"]) expect(html).not.toContain(claim);
  }
  expect(detail).toContain("AI suggestion, untested"); expect(detail).toContain("Plan a buyer test");
});
test("empty shortlist and incomplete source coverage are explained, not filled with a hero pitch", () => {
  const u = ui(); u.context.data = { lanes: [], coverage: [{ audience: "Trades", errors: ["Reddit unavailable"] }] };
  const html = u.run("galEvidenceIntro(data)");
  expect(html).toContain("Nothing has earned a place"); expect(html).toContain("Reddit unavailable");
  expect(html).toContain("data-galconsent"); expect(html).not.toContain("checked");
});
test("opening evidence links one idea and stays inside Discover without starting research", async () => {
  const u = ui(); await u.run('galOpenEvidence("legacy", "experiments")');
  expect(u.calls.map(c => c.path)).toEqual(["/api/ideas/dossier", "/api/opportunities/item"]);
  expect(u.context.S.disc.tab).toBe("evidence"); expect(u.context.S.opp.selected).toBe("notebook-1"); expect(u.context.S.opp.section).toBe("experiments");
});
test("recorded results show denominators, failed outcome and owner provenance", () => {
  const u = ui();
  u.context.card = { proof: { stage: "concept", independentGroups: 0, unknowns: ["Is the free alternative enough?"], latestTest: { denominator: 20, successes: 1, payingCustomers: 0, repeatPayments: 0, offer: "A pilot", segment: "Trades", channel: "Association", observedAt: Date.now(), outcome: "fail", provenance: "Owner-reported; not verified with a payment provider" } } };
  const html = u.run("galEvidenceDetails(card)");
  expect(html).toContain("People in test</dt><dd>20"); expect(html).toContain("· fail"); expect(html).toContain("Owner-reported"); expect(html).toContain("free alternative");
});
