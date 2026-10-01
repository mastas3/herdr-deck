import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CachedJson, cleanName, createLedgers, ledgerPaths, linkParents, nameFit, parseLedger, parseNamesync, parseTokenSrc, type LinkRow } from "../src/dispatch-links";
import { RemoteHost } from "../src/federation";
import type { Row } from "../src/deck";

const dir = mkdtempSync(`${tmpdir()}/deck-dispatch-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Shaped like the real Conductor box: dispatchers in "desk", workers in "ai-fleet", the ledger written by herdr-fleet-link.
const LEDGER = {
  "w-ps1": { src: "◐ Omnigit and tokomni-insights ", brief: "PS1" },
  "w-ps2": { src: "◐ Omnigit and tokomni-insights ", brief: "PS2" },
  "w-qd6": { src: "◑ Stage to QA version deployment", brief: "QD6" },
  "w-wn9": { src: "◑ Tokomni update feature extens", brief: "WN9" },
  "w-old": { src: "3bf0292f", brief: "251" },
  "w-gone": { src: "if-we-were-to-build-tokomni-from-the-beginning", brief: "250a" },
  "w-q": { src: "?", brief: "9" },
};
const at = (min: number) => 1_800_000_000_000 - min * 60_000;
const desk = (key: string, title: string, o: Partial<LinkRow> = {}): LinkRow => ({ key, title, sessionId: `s-${key}`, cwd: "/home/stas/Obsidian/Projects/Conductor", lastActiveAt: at(10), ...o });
const ROWS: LinkRow[] = [
  desk("w3:p9V", "Omnigit and tokomni-insights in"),
  desk("w3:pAK", "Stage to QA version deployment"),
  desk("w3:p9D", "Tokomni update feature extension"),
  desk("w3:pB3", "tokomni-birdseye", { sessionId: "3bf0292f-8bb1-4840-8af0-3631e4f181c3" }),
  { key: "w8:p4V", title: "PS1 webhook delivery retry", sessionId: "w-ps1", cwd: "/home/stas/Projects/server_event_api-PS1" },
  { key: "w8:p4W", title: "PS2 softphone stale session inv", sessionId: "w-ps2", cwd: "/home/stas/Projects/ccc-fe-PS2" },
  { key: "w8:p3W", title: "QD6 merged never deployed drift", sessionId: "w-qd6" },
  { key: "w8:p4Q", title: "WN9 backend announcements catch", sessionId: "w-wn9" },
  { key: "w8:pOld", title: "Old brief", sessionId: "w-old" },
  { key: "w8:pGone", title: "Gone brief", sessionId: "w-gone" },
  { key: "w8:p4X", title: "T26 tokomni deploy dev on new s", sessionId: "w-none" },
];

describe("ledger", () => {
  test("parses entries, skips '?' and junk, accepts a dispatcher session id under src_sid or sid", () => {
    const l = parseLedger(JSON.stringify({ ...LEDGER, "w-sid": { src: "x", brief: 3, src_sid: " abc " }, "w-sid2": { src: "?", sid: "def" }, bad: 5, "": { src: "y" }, "w-empty": { src: "  " } }))!;
    expect(l.get("w-ps1")).toEqual({ src: "◐ Omnigit and tokomni-insights ", brief: "PS1", sid: undefined });
    expect(l.has("w-q")).toBe(false);
    expect(l.has("bad")).toBe(false);
    expect(l.has("w-empty")).toBe(false);
    expect(l.get("w-sid")).toEqual({ src: "x", brief: "3", sid: "abc" });
    expect(l.get("w-sid2")?.sid).toBe("def");
  });
  test("a torn or wrong-shaped file is null, not empty", () => {
    expect(parseLedger('{"w-ps1": {"src": "◐ Omni')).toBeNull();
    expect(parseLedger("[]")).toBeNull();
    expect(parseLedger("null")).toBeNull();
  });
  test("the file is read again only when it changes; a torn write keeps the last good copy; a missing file is empty", () => {
    const p = `${dir}/map.json`;
    writeFileSync(p, JSON.stringify(LEDGER));
    const f = new CachedJson(p, parseLedger, new Map(), 0);
    expect(f.read(1).size).toBe(6);
    writeFileSync(p, '{"w-ps1": {"src": "◐ Om');
    expect(f.read(2).size).toBe(6);
    writeFileSync(p, JSON.stringify({ "w-x": { src: "Somebody" } }));
    expect([...f.read(3).keys()]).toEqual(["w-x"]);
    rmSync(p);
    expect(f.read(4).size).toBe(0);
  });
  test("checks the file at most every few seconds, unless asked to look now", () => {
    const p = `${dir}/slow.json`;
    writeFileSync(p, JSON.stringify(LEDGER));
    const f = new CachedJson(p, parseLedger, new Map(), 2000);
    expect(f.read(10_000).size).toBe(6);
    writeFileSync(p, "{}");
    expect(f.read(11_000).size).toBe(6);
    expect(f.read(11_000, true).size).toBe(0);
  });
  test("ledgers merge, the later one winning; DECK_DISPATCH_MAP names them", () => {
    const a = `${dir}/a.json`, b = `${dir}/b.json`;
    writeFileSync(a, JSON.stringify({ w1: { src: "A" }, w2: { src: "A" } }));
    writeFileSync(b, JSON.stringify({ w2: { src: "B", src_sid: "s-b" } }));
    const l = createLedgers([a, b, `${dir}/missing.json`]).read();
    expect(l.get("w1")?.src).toBe("A");
    expect(l.get("w2")).toEqual({ src: "B", brief: undefined, sid: "s-b" });
    expect(ledgerPaths({ DECK_DISPATCH_MAP: `${a}:${b}` }, "/h")).toEqual([a, b]);
    expect(ledgerPaths({}, "/h")).toEqual(["/h/.config/herdr/dispatch-map.json", "/h/.config/herdr-deck/dispatch-map.json"]);
  });
  test("namesync's cache gives each pane's sidebar name and src", () => {
    const n = parseNamesync(JSON.stringify({ server_key: "1:2", names: { "w8:p3W": { sname: "QD6 merged", src: "← #QD6 ◑ Stage to QA version…" }, "w3:x": { sname: "" } } }))!;
    expect(n.get("w8:p3W")).toEqual({ sname: "QD6 merged", src: "← #QD6 ◑ Stage to QA version…" });
    expect(n.get("w3:x")).toEqual({ sname: undefined, src: undefined });
    expect(parseNamesync("{}")).toBeNull();
  });
});

describe("names", () => {
  test("status glyphs and the cut mark go; the name stays", () => {
    expect(cleanName("◐ Omnigit and tokomni-insights ")).toBe("Omnigit and tokomni-insights");
    expect(cleanName("✳ Tokomni update feat…")).toBe("Tokomni update feat");
    expect(cleanName("⠂ Build it...")).toBe("Build it");
    expect(cleanName("דוח נציגים fixes in v2.15 versi")).toBe("דוח נציגים fixes in v2.15 versi");
  });
  test("herdr's src token gives the brief and a short name", () => {
    expect(parseTokenSrc("← #QD6 ◑ Stage to QA version…")).toEqual({ brief: "QD6", src: "Stage to QA version" });
    expect(parseTokenSrc("← herdr-manager")).toEqual({ brief: undefined, src: "herdr-manager" });
    expect(parseTokenSrc("Stage to QA")).toBeNull();
    expect(parseTokenSrc("← #QD6 ")).toBeNull();
  });
  test("a cut name on either side still fits; a short cut one doesn't", () => {
    expect(nameFit("omnigit and tokomni-insights", "omnigit and tokomni-insights in")).toBe(1);
    expect(nameFit("tokomni update feature extens", "tokomni update feature extension")).toBe(1);
    expect(nameFit("if-we-were-to-build-tokomni-from-the-beginning", "if-we-were-to-build-tokomni-fro")).toBe(1);
    expect(nameFit("stage to qa version deployment", "stage to qa version deployment")).toBe(2);
    expect(nameFit("tokomni reports", "tokomni")).toBe(0);
    expect(nameFit("omnigit", "tokomni")).toBe(0);
  });
});

describe("linking workers to their dispatcher", () => {
  const ledger = parseLedger(JSON.stringify(LEDGER))!;
  const links = linkParents(ROWS, ledger);
  test("cut names with glyphs find the open dispatcher", () => {
    expect(links.get("w8:p4V")).toMatchObject({ key: "w3:p9V", brief: "PS1", srcName: "Omnigit and tokomni-insights", via: "name" });
    expect(links.get("w8:p4W")?.key).toBe("w3:p9V");
    expect(links.get("w8:p3W")).toMatchObject({ key: "w3:pAK", brief: "QD6" });
    expect(links.get("w8:p4Q")?.key).toBe("w3:p9D");
  });
  test("an old entry holding a short session id finds that session", () => {
    expect(links.get("w8:pOld")).toMatchObject({ key: "w3:pB3", via: "sid", srcName: "3bf0292f" });
  });
  test("a dispatcher that isn't open stays unresolved, with the reason", () => {
    expect(links.get("w8:pGone")).toMatchObject({ miss: "closed", brief: "250a", srcName: "if-we-were-to-build-tokomni-from-the-beginning" });
    expect(links.get("w8:pGone")?.key).toBeUndefined();
  });
  test("sessions with no entry aren't workers, and dispatchers get no link", () => {
    expect(links.has("w8:p4X")).toBe(false);
    expect(links.has("w3:p9V")).toBe(false);
    expect(links.size).toBe(6);
  });
  test("two sessions that both fit stay unresolved rather than a guess", () => {
    const rows = [desk("a", "Omnigit and tokomni-insights in"), desk("b", "Omnigit and tokomni-insights v2"), ROWS[4]];
    const l = linkParents(rows, ledger).get("w8:p4V")!;
    expect(l.key).toBeUndefined();
    expect(l.miss).toBe("ambiguous");
    expect(l.why).toContain("2 open sessions match");
  });
  test("ties break by: not a worker, the exact name, the worker's folder, not stale; two panes on one session are one", () => {
    const w = ROWS[4];
    const worker = { key: "w8:other", title: "Omnigit and tokomni-insights in", sessionId: "w-ps2" };
    expect(linkParents([worker, desk("d", "Omnigit and tokomni-insights in"), w, ROWS[5]], ledger).get("w8:p4V")?.key).toBe("d");
    const exact = linkParents([desk("x", "Stage to QA version deployment"), desk("y", "Stage to QA version deployment 2"), ROWS[6]], ledger);
    expect(exact.get("w8:p3W")?.key).toBe("x");
    const folder = linkParents([desk("x", "Omnigit and tokomni-insights in"), desk("y", "Omnigit and tokomni-insights in", { cwd: w.cwd }), w], ledger);
    expect(folder.get("w8:p4V")?.key).toBe("y");
    const fresh = linkParents([desk("x", "Omnigit and tokomni-insights in", { stale: true }), desk("y", "Omnigit and tokomni-insights in"), w], ledger);
    expect(fresh.get("w8:p4V")?.key).toBe("y");
    const dup = linkParents([desk("x", "Omnigit and tokomni-insights in", { sessionId: "s1", lastActiveAt: at(30) }), desk("y", "Omnigit and tokomni-insights in", { sessionId: "s1", lastActiveAt: at(1) }), w], ledger);
    expect(dup.get("w8:p4V")?.key).toBe("y");
  });
  test("a ledger that names the dispatcher's session is exact, whatever the names say", () => {
    const l = parseLedger(JSON.stringify({ "w-ps1": { src: "◐ Omnigit and tokomni-insights ", brief: "PS1", src_sid: "s-w3:pAK" } }))!;
    expect(linkParents(ROWS, l).get("w8:p4V")).toMatchObject({ key: "w3:pAK", via: "sid", sid: "s-w3:pAK" });
    expect(linkParents(ROWS.filter((r) => r.key !== "w3:pAK"), l).get("w8:p4V")).toMatchObject({ miss: "closed" });
    // A Claude session that moved to a new transcript keeps its old id in movedFrom.
    const moved = ROWS.map((r) => (r.key === "w3:p9D" ? { ...r, sessionId: "new", movedFrom: ["s-w3:pAK"] } : r)).filter((r) => r.key !== "w3:pAK");
    expect(linkParents(moved, l).get("w8:p4V")?.key).toBe("w3:p9D");
  });
  test("without an entry, herdr's src token links it (the name it carries is cut shorter)", () => {
    const rows = [...ROWS.slice(0, 4), { key: "w8:p3W", title: "QD6 merged never deployed drift", sessionId: "unknown" }];
    const l = linkParents(rows, new Map(), (r) => (r.key === "w8:p3W" ? { tokenSrc: "← #QD6 ◑ Stage to QA version…" } : {}));
    expect(l.get("w8:p3W")).toMatchObject({ key: "w3:pAK", brief: "QD6", srcName: "Stage to QA version" });
  });
  test("a dispatcher is also found by its other names (herdr's sidebar name, the session's own)", () => {
    const rows = [desk("p", "Some terminal title"), ROWS[4]];
    expect(linkParents(rows, ledger, (r) => (r.key === "p" ? { names: ["◐ Omnigit and tokomni-insights in"] } : {})).get("w8:p4V")?.key).toBe("p");
  });
  test("a worker never links to itself or another pane on its own session", () => {
    const self = { key: "w8:self", title: "Omnigit and tokomni-insights in", sessionId: "w-ps1" };
    expect(linkParents([self], ledger).get("w8:self")?.key).toBeUndefined();
  });
});

describe("federation", () => {
  const row = (o: Partial<Row> = {}): Row => ({
    key: "h/1", herdr: "h", workspaceId: "w", workspace: "W", tabId: "t", tab: "", tabNumber: 1, tabPanes: 1, paneId: "1", agent: "claude",
    status: "idle", focused: false, title: "t", cwd: "/p", project: "p", rssKB: 0, cpu: 0, procs: 0, tail: [], empty: false, stale: false, duplicate: false, approx: false, ...o,
  });
  test("a worker's parent reaches the hub under the hub's keys, and a link that changes is sent again", async () => {
    const got: string[][] = [];
    const h = new RemoteHost({ id: "linux", label: "Linux", ssh: "unused" }, { patch: (u) => got.push(u.map((x) => x.key)), procs: () => {}, graveyard: () => {}, notice: () => {}, usage: () => {} });
    const recv = (event: string, data: any, id = "") => (h as any).receive(event, data, id);
    const parent = row({ key: "default/w3:p9V" });
    const worker = row({ key: "default/w8:p4V", parent: { brief: "PS1", srcName: "Omnigit", key: "default/w3:p9V", via: "name" } });
    await recv("full", { seq: "b.1", rows: [parent, worker], summary: { herdr: [] }, graveyard: [] }, "b.1");
    expect(h.rows.get("linux|default/w8:p4V")!.parent).toEqual({ brief: "PS1", srcName: "Omnigit", key: "linux|default/w3:p9V", via: "name" });
    // The node's own copy keeps its own key.
    expect(worker.parent!.key).toBe("default/w3:p9V");
    // The parent closes: the node sends the worker again, unresolved, and the hub passes it on.
    const orphan = row({ key: "default/w8:p4V", parent: { brief: "PS1", srcName: "Omnigit", miss: "closed", why: "x" } });
    await recv("patch", { upsert: [orphan], remove: ["default/w3:p9V"], summary: { herdr: [] } }, "b.2");
    expect(got.at(-1)).toEqual(["linux|default/w8:p4V"]);
    expect(h.rows.get("linux|default/w8:p4V")!.parent).toEqual({ brief: "PS1", srcName: "Omnigit", miss: "closed", why: "x" });
    // Sent again unchanged: nothing goes out.
    const n = got.length;
    await recv("patch", { upsert: [orphan], remove: [], summary: { herdr: [] } }, "b.3");
    expect(got.length).toBe(n);
  });
});
