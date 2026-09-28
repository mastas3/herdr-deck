// Two plugins that meet only through files and a service: the covers job (plugins-builtin/covers) finds the ideas the
// gallery (plugins-builtin/discover) archives, and covers.respond puts a painted cover on a gallery card.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createGalleryServer } from "../plugins-builtin/discover/gallery-server";
import { coverIdOf, openIdeaArchive } from "../plugins-builtin/discover/idea-archive";
import { createCovers } from "../plugins-builtin/covers/covers";

const root = mkdtempSync(`${tmpdir()}/deck-discover-covers-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const LAB = new URL("../docs/idea-lab/gallery.json", import.meta.url).pathname;
const lab = JSON.parse(readFileSync(LAB, "utf8"));
const topId: string = lab.lanes.find((l: any) => l.id === "top").ideas[0];

describe("discover and covers", () => {
  test("the covers job paints the best gallery idea first (by its cover id, with its hook as the pitch)", async () => {
    const dir = mkdtempSync(`${root}/paint-`);
    const archive = openIdeaArchive(`${dir}/ideas.db`);
    const g = createGalleryServer({ dir: `${dir}/gallery`, projectsDir: `${dir}/projects`, labFile: LAB, evidenceFirst: false, archive, sections: async () => [], projects: async () => [], gems: () => [], gh: async () => ({ ok: false, status: 0 }), log: () => {} });
    await g.handle("/api/ideas/state", {});
    const prompts: string[] = [];
    const covers = createCovers({ dir: `${dir}/covers`, confFile: `${dir}/c.json`, dataDir: dir, enabled: () => true, busy: () => false, paint: async (p) => { prompts.push(p); throw new Error("no painter in tests"); } });
    await covers.tick();
    const best = Object.values<any>(lab.ideas).sort((a, b) => b.quality - a.quality)[0];
    expect(covers._state().last?.id).toBe(coverIdOf(best.id));
    expect(prompts[0]).toContain(best.hook.slice(0, 30));
    covers.stop(); archive.close();
  });
  test("covers.respond puts the painted cover on a gallery card by its coverId", () => {
    const dir = mkdtempSync(`${root}/cov-`);
    const id = coverIdOf(topId);
    writeFileSync(`${dir}/${id}.webp`, "x"); writeFileSync(`${dir}/${id}_thumb.webp`, "x");
    const covers = createCovers({ dir, confFile: `${dir}/c.json`, dataDir: dir, enabled: () => false });
    return covers.respond({ ideas: { [topId]: { id: topId, coverId: id, title: "T", pitch: "P" } } }).json().then((j: any) => {
      expect(j.ideas[topId].coverUrl).toStartWith(`/covers/${id}.webp?v=`);
      expect(j.ideas[topId].thumbUrl).toContain("_thumb.webp");
      covers.stop();
    });
  });
});
