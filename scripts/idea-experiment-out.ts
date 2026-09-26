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
  const galleryFile = `${LAB}/gallery.json`;
  if (cmd === "gallery") {
    const all = x.scored().filter((i: any) => i.s.slop?.pass && i.s.jevP10 != null && i.s.rubric);
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
    for (const id of ids) {
      const kit = await buildStarterKit(id, deps);
      kit.judge ??= await judgeKit(kit, claude);
      const dir = `${LAB}/kits/${slugOf(g.ideas[id].name)}`;
      mkdirSync(dir, { recursive: true });
      const files = materializeKit(kit, g.ideas[id].name, dir, { overwrite: true });
      writeFileSync(`${dir}/kit.json`, JSON.stringify(kit, null, 1));
      console.log(`${g.ideas[id].name}: ${files.length} files → ${dir}; readiness ${kit.readiness.score}; judge ready ${kit.judge.ready}/5 — ${kit.judge.notes}\n  open questions: ${kit.judge.questions.join(" | ")}`);
    }
  }
}
