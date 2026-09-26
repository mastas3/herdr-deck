// Fetch today's trend signals (once a day, cached) → docs/idea-lab/data/trends.json.   bun scripts/idea-trends.ts [--force]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gatherTrends } from "../src/ideagen/trends";
const FILE = `${import.meta.dir}/../docs/idea-lab/data/trends.json`;
const prev = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : undefined;
const today = new Date().toISOString().slice(0, 10);
if (prev && prev.day?.slice(0, 10) === today && !process.argv.includes("--force") && !process.argv.includes("--recluster") && !process.argv.includes("--subs")) { console.log(`cached: ${prev.signals.length} signals, ${prev.trends.length} trends`); process.exit(0); }
const { clusterTrends, parseAtom, rankWithinSource } = await import("../src/ideagen/trends");
// --subs a,b: re-read just these subreddits (e.g. after a rate limit) and merge them into today's signals.
if (process.argv.includes("--subs") && prev) {
  const subs = process.argv[process.argv.indexOf("--subs") + 1].split(",");
  for (let i = 0; i < subs.length; i++) {
    if (i) await Bun.sleep(30_000);
    const r = await fetch(`https://www.reddit.com/r/${subs[i]}/top/.rss?t=week&limit=25`, { headers: { "user-agent": "herdr-deck-trends/0.1 (local research dashboard)" }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    const xs = r?.ok ? parseAtom(await r.text(), "reddit", prev.at, `r/${subs[i]}`) : [];
    console.log(`r/${subs[i]}: ${r?.status ?? "error"} → ${xs.length}`);
    for (const x of xs) if (!prev.signals.some((y: any) => y.id === x.id)) prev.signals.push(x);
  }
}
if (prev) for (const x of prev.signals) if (x.source === "producthunt" && x.text && !x.title.includes(" — ")) x.title = `${x.title} — ${x.text}`.slice(0, 180);
const t = (process.argv.includes("--recluster") || process.argv.includes("--subs")) && prev ? { ...prev, trends: clusterTrends(rankWithinSource(prev.signals), prev.at) } : await gatherTrends({ log: (s) => console.log("  " + s) });
writeFileSync(FILE, JSON.stringify(t, null, 1));
console.log(`${t.signals.length} signals → ${t.trends.length} trends`);
for (const x of t.trends.slice(0, 48)) console.log(`heat ${x.heat.toFixed(2)} early ${x.earliness.toFixed(2)} [${x.sources.join(",")}] ${x.label} — ${x.signals.slice(0, 3).map((s) => s.title.slice(0, 60)).join(" | ")}`);
