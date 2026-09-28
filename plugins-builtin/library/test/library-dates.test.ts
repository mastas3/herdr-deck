// The library plugin's dates: yt-dlp output, the backfill, and dates on the cards and the queue. (Comparables and
// evidence ranking are core: test/library-strategy.test.ts.)
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { backfillDates, fmtDuration, fmtMeta, fmtPublished, isoDate, metaStore, oldLabel, parsePrintLine, pendingIds, recencyWeight } from "../library-dates";
import { openCards } from "../library-cards";
import { applyResult } from "../library-queue";
import { CARDS } from "../../../test/strategy-fixtures";

const root = mkdtempSync(`${tmpdir()}/deck-strategy-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NOW = Date.parse("2026-09-26T12:00:00Z");

describe("dates: formats, recency and the backfill", () => {
  test("yt-dlp dates, publish labels and lengths", () => {
    expect(isoDate("20240315")).toBe("2024-03-15");
    expect(isoDate("2024-03-15T10:00:00Z")).toBe("2024-03-15");
    expect(isoDate(1710460800)).toBe("2024-03-15");
    expect(isoDate("NA")).toBeUndefined();
    expect(fmtPublished("2024-03-15")).toBe("Mar 2024");
    expect(fmtDuration(1080)).toBe("18 min");
    expect(fmtDuration(3900)).toBe("1 h 05 min");
    expect(fmtMeta("2024-03-15", 1080)).toBe("Published Mar 2024 · 18 min");
    expect(fmtMeta(undefined, 1080)).toBe("18 min");
  });
  test("a printed line: upload date, a premiere's release time wins, NA fields left out", () => {
    expect(parsePrintLine("uvIcGuN2iO8\t20260705\tNA\t1783270805\t1156\t368837", NOW)).toEqual(["uvIcGuN2iO8", { date: "2026-07-05", ts: 1783270805, duration: 1156, views: 368837, at: NOW }]);
    expect(parsePrintLine("abcdefghijk\tNA\t1710460800\tNA\tNA\tNA", NOW)?.[1].date).toBe("2024-03-15");
    expect(parsePrintLine("ERROR: [youtube] xxx: unavailable")).toBeUndefined();
  });
  test("recent stories weigh more; past three years they're labelled older", () => {
    expect(recencyWeight("2026-03-01", NOW)).toBe(1);
    expect(recencyWeight("2023-09-26", NOW)).toBeCloseTo(0.8, 1);
    expect(recencyWeight("2012-01-01", NOW)).toBe(0.5);
    expect(recencyWeight(undefined, NOW)).toBe(0.85);
    expect(oldLabel("2021-05-01", NOW)).toBe("older (2021)");
    expect(oldLabel("2024-05-01", NOW)).toBe("");
  });
  test("backfill: batches, saves as it goes, marks what didn't come back, and resumes without asking again", async () => {
    const store = metaStore(`${root}/meta.json`);
    const asked: string[][] = [];
    const fetch = async (ids: string[]) => { asked.push(ids); return ids.filter((id) => id !== "bbbbbbbbbbb").map((id) => `${id}\t20250101\tNA\tNA\t600\t10`).join("\n") + "\nERROR: bbbbbbbbbbb unavailable"; };
    const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
    const r = await backfillDates(ids, store, fetch, { batch: 2, now: () => NOW });
    expect(r).toEqual({ asked: 3, found: 2, failed: 1 });
    expect(asked).toEqual([["aaaaaaaaaaa", "bbbbbbbbbbb"], ["ccccccccccc"]]);
    const onDisk = JSON.parse(readFileSync(`${root}/meta.json`, "utf8"));
    expect(onDisk.aaaaaaaaaaa.date).toBe("2025-01-01");
    expect(onDisk.bbbbbbbbbbb.err).toBeTruthy();
    // Run again: nothing to ask (the failure waits a week), and a later failure never erases a known date.
    expect((await backfillDates(ids, store, fetch, { now: () => NOW })).asked).toBe(0);
    expect(pendingIds(ids, store.read(), NOW + 8 * 86_400_000)).toEqual(["bbbbbbbbbbb"]);
    store.merge({ aaaaaaaaaaa: { at: NOW, err: "later failure" } });
    expect(store.get("aaaaaaaaaaa")?.date).toBe("2025-01-01");
  });
  test("an ingest that reports the publish date records it on the queue from the start", () => {
    const v = applyResult({ id: "x", title: "t", url: "u", order: 0, status: "ingesting", attempts: 0 }, { status: "ingested", chunks: 3, meta: { date: "2026-09-01", duration: 700 } });
    expect(v.date).toBe("2026-09-01");
    expect(v.duration).toBe(700);
  });
  test("cards: dates set in place, filter since a day, newest first; old 20240315-style dates count as undated", () => {
    const db = openCards(`${root}/cards.db`);
    for (const c of CARDS) db.put({ ...c, date: c.id === "habitapp001" ? "20240201" : undefined });
    expect(db.undated().sort()).toEqual(CARDS.map((c) => c.id).sort());
    for (const c of CARDS) if (c.date) expect(db.setMeta(c.id, { date: c.date, duration: 900, views: 5 })).toBe(true);
    expect(db.setMeta("podclip0001", { date: "2025-11-02" })).toBe(false); // nothing new
    expect(db.get("podclip0001")?.duration).toBe(1080); // a known length is kept
    expect(db.list({ since: "2025-01-01" }).cards.map((c) => c.id).sort()).toEqual(["podclip0001", "podclip0002"]);
    expect(db.list({ sort: "published" }).cards.slice(0, 3).map((c) => c.id)).toEqual(["podclip0001", "podclip0002", "habitapp001"]);
    expect(db.list({ q: "podcast", sort: "published" }).cards[0].id).toBe("podclip0001");
    db.close();
  });
});
