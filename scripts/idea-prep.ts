// Snapshot the inputs for the idea experiment: the user's inventory (read-only POST /api/connections on the live
// deck, or a saved snapshot), wiki projects and gem repos from the Discover cache, and a pain corpus per audience
// (public posts via the Leads engine, reusing the deck's cached leads). Writes docs/idea-lab/data/*.json (gitignored).
//   bun scripts/idea-prep.ts [--no-pains] [--only aud1,aud2]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { RECS } from "../src/catalog";
import { AUDIENCES, buildInventory } from "../src/ideagen/inventory";
import { gatherPains } from "../src/ideagen/evidence";
import type { PainCorpus } from "../src/ideagen/types";

const HOME = homedir();
const DATA = `${import.meta.dir}/../docs/idea-lab/data`;
mkdirSync(DATA, { recursive: true });
const args = process.argv.slice(2);
const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };

async function connections() {
  const token = (() => { try { return readFileSync(`${HOME}/.config/herdr-deck/api.token`, "utf8").trim(); } catch { return ""; } })();
  try {
    const r = await fetch("http://127.0.0.1:4747/api/connections", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
    if (r.ok) { const j: any = await r.json(); if (j.sections) return j.sections; }
  } catch {}
  return readJson(`${DATA}/connections.json`) ?? [];
}

const disc = readJson(`${HOME}/.config/herdr-deck/discover-cache.json`) ?? {};
const sections = (await connections()).map((s: any) => ({ id: s.id, items: (s.items ?? []).map((i: any) => ({ id: i.id, name: i.name, state: i.state, cat: i.cat, kind: i.kind, detail: i.detail, hidden: i.hidden })) }));
writeFileSync(`${DATA}/connections.json`, JSON.stringify(sections));
const gems = Object.values<any>({ ...(disc.gems ?? {}), ...(disc.trend ?? {}) }).flatMap((g) => g.items ?? []);
const seen = new Set<string>();
const uniqGems = gems.filter((g: any) => (seen.has(g.full) ? false : (seen.add(g.full), true)));
const inv = buildInventory({ sections, projects: disc.profile?.projects ?? [], gems: uniqGems, recs: RECS.map((r) => ({ id: r.id, name: r.name, url: r.url, free: r.free, what: r.what, cat: r.cat })) });
writeFileSync(`${DATA}/inventory.json`, JSON.stringify(inv, null, 1));
const count = (k: string) => inv.assets.filter((a) => a.kind === k).length;
console.log(`inventory: ${inv.assets.length} assets (projects ${count("project")}, repos ${count("repo")}, services ${count("service")}, accounts ${count("account")}, mcp ${count("mcp")}, skills ${count("skill")}, recs ${count("rec")}), ${inv.keys.length} key names, ${inv.audiences.length} audiences`);

if (!args.includes("--no-pains")) {
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : undefined;
  const leads = readJson(`${HOME}/.config/herdr-deck/leads-cache.json`)?.entries ?? {};
  const prev: PainCorpus | undefined = readJson(`${DATA}/pains.json`);
  const todo = AUDIENCES.filter((a) => (!only || only.includes(a.id)) && !prev?.queries.some((q) => q.audience === a.id && q.posts > 0));
  console.log(`pains: searching ${todo.map((a) => a.id).join(", ") || "nothing new"}`);
  const got = await gatherPains(todo, { cached: leads, log: (s) => console.log("  " + s) });
  // The deck's "idea" searches are demand evidence too (e.g. "chat with a YouTuber's archive" → creators).
  const merged: PainCorpus = { at: Date.now(), posts: [...(prev?.posts ?? [])], themes: [...(prev?.themes ?? [])], queries: [...(prev?.queries ?? []).filter((q) => !todo.some((a) => a.id === q.audience))] };
  for (const p of got.posts) if (!merged.posts.some((x) => x.id === p.id)) merged.posts.push(p);
  merged.themes = [...merged.themes.filter((t) => !todo.some((a) => a.id === t.audience)), ...got.themes];
  merged.queries.push(...got.queries);
  for (const [k, e] of Object.entries<any>(leads)) {
    if (!k.startsWith("idea|") || !/youtube/i.test(k)) continue;
    for (const x of e.evidence ?? []) if (x.pain > 0 && !merged.posts.some((p) => p.id === `${x.source}:${x.id}`)) merged.posts.push({ id: `${x.source}:${x.id}`, source: x.source, url: x.url, title: x.title, snippet: x.snippet, pain: x.pain, score: x.score, signals: x.signals ?? [], at: x.at, audience: "creators", where: x.where?.label });
  }
  writeFileSync(`${DATA}/pains.json`, JSON.stringify(merged, null, 1));
  console.log(`pains: ${merged.posts.length} posts, ${merged.themes.length} themes`);
  for (const q of merged.queries) console.log(`  ${q.audience}: "${q.text}" → ${q.posts} posts, ${q.themes} themes${q.errors.length ? ` [${q.errors.join("; ")}]` : ""}`);
}
// Extra, product-shaped searches ("idea" direction): what people say about the things the user's assets already do.
if (args.includes("--extra")) {
  const { setRedditWait } = await import("../src/leads");
  setRedditWait(75_000);
  const EXTRA: { audience: string; text: string }[] = [
    { audience: "hd-global", text: "human design app subscription" },
    { audience: "hd-pros", text: "human design reading report" },
    { audience: "fb-admins", text: "search old facebook group posts" },
    { audience: "creators", text: "search youtube channel transcripts" },
    { audience: "creators", text: "podcast clips shorts captions" },
    { audience: "devs-agents", text: "manage multiple claude code sessions" },
    { audience: "couples", text: "relationship compatibility app" },
    { audience: "il-smb", text: "government tenders bid" },
    { audience: "ru-israel", text: "aliyah israel hebrew" },
    { audience: "indie-hackers", text: "how to find first paying customers" },
  ];
  const corpus: PainCorpus = readJson(`${DATA}/pains.json`);
  const done = new Set((corpus.queries ?? []).map((q) => q.text));
  for (const x of EXTRA.filter((e) => !done.has(e.text))) {
    const au = AUDIENCES.find((a) => a.id === x.audience)!;
    const got = await gatherPains([{ ...au, query: x.text }], { log: (s) => console.log("  " + s), dir: "idea" } as any);
    for (const p of got.posts) if (!corpus.posts.some((y) => y.id === p.id)) corpus.posts.push(p);
    corpus.themes.push(...got.themes.map((t) => ({ ...t, id: `${t.id}:${x.text.replace(/\W+/g, "-")}` })));
    corpus.queries.push(...got.queries);
    writeFileSync(`${DATA}/pains.json`, JSON.stringify(corpus, null, 1));
    console.log(`${x.audience}: "${x.text}" → ${got.posts.length} posts, ${got.themes.length} themes ${got.queries[0]?.errors.join("; ") ?? ""}`);
  }
}
if (!existsSync(`${DATA}/../.gitignore`)) writeFileSync(`${DATA}/../.gitignore`, "data/\n.cache/\n.jev/\n");
