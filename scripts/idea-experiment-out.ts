// Experiment outputs: the gallery built from every judged idea (no new model calls), and two starter kits
// materialized into docs/idea-lab/kits/ and judged for completeness (one Claude call each to build, one to judge).
import { mkdirSync, writeFileSync } from "node:fs";
import { gh } from "../src/discover";
import { buildGallery } from "../src/ideagen/gallery";
import { createRepoFinder } from "../src/ideagen/connectors";
import { buildStarterKit, judgeKit, slugOf } from "../src/ideagen/kit";
import { materializeKit } from "../src/ideagen/kit-files";
import type { Gallery } from "../src/ideagen/types";

export async function run(cmd: string, x: any) {
  const { LAB, inv, claude, args } = x;
  if (cmd === "premortem") return premortem(x);
  if (cmd === "archive") {
    // Every idea the lab generated goes into the deck's archive: gated ones as dropped, with the reasons in their data.
    const { openIdeaArchive } = await import("../src/idea-archive");
    const file = args.includes("--file") ? args[args.indexOf("--file") + 1] : `${process.env.HOME}/.config/herdr-deck/ideas.db`;
    const a = openIdeaArchive(file);
    const all = x.scored();
    for (const i of all) {
      const { s, ...idea } = i;
      a.put({ ...idea, title: i.name, source: "idea-lab", row: i.strategy, scores: { quality: s.quality, raw: s.qualityRaw, jevP10: s.jevP10, rubric: s.rubric, evidence: s.evidence, slop: s.slop, patterns: s.patterns } } as any, i.round ? Date.now() : undefined);
      a.score(i.id, s.quality, !s.slop?.pass);
    }
    console.log(`archived ${all.length} ideas to ${file}: ${JSON.stringify(a.count())}`);
    a.close();
    return;
  }
  const galleryFile = `${LAB}/gallery.json`;
  if (cmd === "gallery") {
    // After a pre-mortem only the winning version of each idea stays (revisions have no rubric; they compete on Jev,
    // patterns and evidence, see premortem()).
    const pm: any[] = await Bun.file(`${LAB}/premortem.json`).json().catch(() => []);
    const { ABANDON } = await import("../src/ideagen/premortem");
    const kept = new Set(pm.filter((r) => r.keep === "revised").map((r) => r.revId));
    // Out: originals whose rewrite won, and (the live gallery's rule) originals the critic says to abandon.
    const out = new Set(pm.filter((r) => r.keep === "revised" || ABANDON.test(r.premortem?.fix ?? "")).map((r) => r.id));
    const byId = new Map(x.scored().map((i: any) => [i.id, i]));
    const all = [...byId.values()].filter((i: any) => i.s.slop?.pass && i.s.jevP10 != null && (i.s.rubric || kept.has(i.id)) && !out.has(i.id));
    // A kept rewrite has no rubric score of its own: it takes its original's quality plus the pre-mortem's measured gain,
    // so it ranks against rubric-judged ideas on the same scale.
    for (const r of pm.filter((r) => r.keep === "revised")) { const i: any = byId.get(r.revId), o: any = byId.get(r.id); if (i && o) i.s = { ...i.s, quality: Math.round((o.s.quality + 100 * (r.rev - r.orig)) * 10) / 10 }; }
    const g = await buildGallery(all.map((i: any) => ({ idea: i, s: i.s })), inv, { day: new Date().toISOString().slice(0, 10), at: Date.now(), findRepos: createRepoFinder(gh, 10), stats: { note: "built from the experiment's judged ideas" } });
    writeFileSync(galleryFile, JSON.stringify(g, null, 1));
    console.log(`gallery: ${Object.keys(g.ideas).length} cards in ${g.lanes.length} lanes`);
    for (const l of g.lanes) console.log(`\n## ${l.title} (${l.ideas.length})\n` + l.ideas.slice(0, 5).map((id) => { const c = g.ideas[id]; return `  q${c.quality} ${c.name} — ${c.price} — missing: ${c.missing.map((m) => m.label).join(", ") || "none"}${c.trend ? ` — trend: ${c.trend.label}` : ""}`; }).join("\n"));
    return;
  }
  if (cmd === "kits") {
    const g: Gallery = JSON.parse(await Bun.file(galleryFile).text());
    const ids = (args.includes("--ids") ? args[args.indexOf("--ids") + 1].split(",") : [g.lanes.find((l) => l.id === "top")!.ideas[0], g.lanes.find((l) => l.id === "hot")?.ideas[0]]).filter(Boolean);
    const deps = { inv, claude, gh, cacheDir: `${LAB}/.cache`, card: (id: string) => g.ideas[id] };
    const { refreshKit } = await import("../src/ideagen/kit");
    for (const id of ids) {
      // Built once (cached); the inventory-derived parts are recomputed every time, as the deck would on open.
      const kit = refreshKit(await buildStarterKit(id, deps), g.ideas[id], inv);
      const dir = `${LAB}/kits/${slugOf(g.ideas[id].name)}`;
      kit.judge ??= (await Bun.file(`${dir}/kit.json`).json().catch(() => ({}))).judge ?? (await judgeKit(kit, claude));
      mkdirSync(dir, { recursive: true });
      const files = materializeKit(kit, g.ideas[id].name, dir, { overwrite: true });
      writeFileSync(`${dir}/kit.json`, JSON.stringify(kit, null, 1));
      console.log(`${g.ideas[id].name}: ${files.length} files → ${dir}; readiness ${kit.readiness.score}; judge ready ${kit.judge.ready}/5 — ${kit.judge.notes}\n  open questions: ${kit.judge.questions.join(" | ")}`);
    }
  }
}

/** Pre-mortem the best surviving ideas (one Claude call), judge each revision like its original, keep the better one. */
export async function premortem(x: any) {
  const { inv, claude, jev, args, store, judged, saveStore, saveJudged, postsById, LAB } = x;
  const { runPremortems, keepRevised } = await import("../src/ideagen/premortem");
  const { jevPatterns, patternScore } = await import("../src/ideagen/success");
  const { jevBatch, jevGenericBatch, jevNorm } = await import("../src/ideagen/judge");
  const { libraryEvidence, researchEvidence } = await import("../src/ideagen/library");
  const { laneize, toCard } = await import("../src/ideagen/gallery");
  const top = Number(args.includes("--top") ? args[args.indexOf("--top") + 1] : 12);
  const pool = x.scored().filter((i: any) => i.s.slop?.pass && i.s.rubric && i.round < 5).sort((a: any, b: any) => b.s.quality - a.s.quality);
  // Distinct ideas only (the gallery's near-duplicate rule), plus the best two trend ideas so the hot lanes get a pass too.
  const cards = pool.map((i: any) => toCard(i, i.s, []));
  const ids = new Set<string>(laneize(cards, top).find((l: any) => l.id === "top")!.ideas);
  for (const l of laneize(cards, 2).filter((l: any) => l.id === "hot" || l.id === "early")) for (const id of l.ideas) ids.add(id);
  const picked = pool.filter((i: any) => ids.has(i.id));
  const items = await Promise.all(picked.map(async (i: any) => ({
    idea: i, posts: i.s.evidenceMatches.map((m: any) => postsById.get(m.postId)).filter(Boolean).slice(0, 3),
    outside: [...researchEvidence(`${i.name} ${i.buyer} ${i.offer}`), ...(await libraryEvidence(`${i.name} ${i.offer}`))],
  })));
  console.log(`pre-mortem on ${items.length} ideas; outside evidence for ${items.filter((it) => it.outside.length).length}`);
  const { results, run } = await runPremortems(items, inv, claude, "premortem:1");
  console.log(`  claude: $${run.costUsd.toFixed(4)}, ${(run.ms / 1000).toFixed(0)} s, ${results.size} parsed`);
  const revised = [...results.values()].map((r) => r.revised).filter(Boolean);
  for (const r of revised) { r.round = 5; if (!store.ideas.some((y: any) => y.id === r.id)) store.ideas.push(r); }
  saveStore();
  const chunk = (xs: any[], k: number) => Array.from({ length: Math.ceil(xs.length / k) }, (_, i) => xs.slice(i * k, i * k + k));
  const both = [...picked, ...revised];
  await Promise.all([
    ...chunk(revised, 4).map(async (b, i) => { for (const [id, v] of await jevBatch(b, inv, jev, `pm-p10:${i}`)) judged[id] = { ...judged[id], jevP10: v.p10, jevShip: v.ship }; }),
    ...chunk(revised, 6).map(async (b, i) => { for (const [id, v] of await jevGenericBatch(b, inv, jev, `pm-generic:${i}`)) judged[id] = { ...judged[id], jevGeneric: v }; }),
    ...chunk(both.filter((i: any) => !judged[i.id]?.patterns), 3).map(async (b, i) => { for (const [id, v] of await jevPatterns(b, inv, jev, `patterns:${i}`)) judged[id] = { ...judged[id], patterns: v }; }),
  ]);
  saveJudged();
  const S = new Map(x.scored().map((i: any) => [i.id, i]));
  const comparable = (i: any) => (i.s.slop?.pass ? 0.45 * jevNorm(i.s.jevP10 ?? 0) + 0.3 * (patternScore(judged[i.id]?.patterns) ?? 0) + 0.25 * i.s.evidence : 0);
  const rows: any[] = [];
  for (const o of picked) {
    const r = results.get(o.id);
    const orig = S.get(o.id) as any, rev = r?.revised ? (S.get(r.revised.id) as any) : undefined;
    const co = comparable(orig), cr = rev ? comparable(rev) : 0;
    const keep = rev && keepRevised(co, cr) ? "revised" : "original";
    // The kept version carries the pre-mortem; the original keeps it too, so the card can say what could go wrong.
    const so = store.ideas.find((y: any) => y.id === o.id);
    if (so && r) so.premortem = r.premortem;
    rows.push({ id: o.id, revId: rev?.id, name: o.name, revised: rev?.name, keep, orig: Math.round(co * 1000) / 1000, rev: Math.round(cr * 1000) / 1000, origP10: orig.s.jevP10, revP10: rev?.s.jevP10, origPatterns: patternScore(judged[o.id]?.patterns), revPatterns: rev ? patternScore(judged[rev.id]?.patterns) : undefined, revGate: rev?.s.slop, premortem: r?.premortem, revisedIdea: r?.revised && { hook: r.revised.hook, buyer: r.revised.buyer, offer: r.revised.offer, price: r.revised.price, channel: r.revised.channel } });
  }
  saveStore();
  Bun.write(`${LAB}/premortem.json`, JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`${r.keep === "revised" ? "PIVOT" : "keep "} ${r.orig} → ${r.rev}  ${r.name}  ⇒  ${r.revised ?? "-"}\n   fails: ${r.premortem?.failures.map((f: any) => f.reason).join(" | ")}\n   fix: ${r.premortem?.fix}`);
  console.log(`kept revised: ${rows.filter((r) => r.keep === "revised").length}/${rows.length}; mean comparable ${(rows.reduce((a, r) => a + r.orig, 0) / rows.length).toFixed(3)} → best-of ${(rows.reduce((a, r) => a + Math.max(r.orig, r.rev), 0) / rows.length).toFixed(3)}`);
}
