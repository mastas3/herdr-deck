// /api/ideas/* for the Discover gallery. Not wired into server.ts yet; to wire it:
//   const ideas = createIdeasRoutes({ ...deps });  …  const r = await ideas.handle(path, body); if (r !== undefined) return json(r);
// Play/Begin is the only route that writes outside the cache, and only with confirm: true.
import { homedir } from "node:os";
import type { Gallery, Inventory, PainCorpus, StarterKit } from "./types";
import type { TrendSet } from "./trends";
import type { ClaudeRunner, JevRunner } from "./llm";
import type { GhRes } from "../discover";
import { cachedGallery, generateGallery, moreInLane, type GalleryDeps } from "./gallery";
import { buildStarterKit, judgeKit, slugOf } from "./kit";
import { materializeKit } from "./kit-files";
import { createRepoFinder } from "./connectors";

export type IdeasDeps = {
  cacheDir: string; projectsDir?: string;
  inventory: () => Promise<Inventory>; corpus: () => Promise<PainCorpus>; trends: () => Promise<TrendSet | undefined>;
  claude: ClaudeRunner; jev: JevRunner; gh: (args: string[], t?: number) => Promise<GhRes>;
};
export function createIdeasRoutes(d: IdeasDeps) {
  let running: Promise<Gallery> | undefined;
  const deps = async (): Promise<GalleryDeps> => ({ cacheDir: d.cacheDir, inv: await d.inventory(), corpus: await d.corpus(), trends: await d.trends(), claude: d.claude, jev: d.jev, findRepos: createRepoFinder(d.gh) });
  const today = () => new Date().toISOString().slice(0, 10);
  const cardOf = (id: string) => cachedGallery(d.cacheDir, today())?.ideas[id];
  async function handle(path: string, body: any): Promise<unknown> {
    switch (path) {
      case "/api/ideas": {
        // One generation at a time; everyone asking meanwhile shares it.
        running ??= deps().then((x) => generateGallery(x, { force: !!body?.force })).finally(() => { running = undefined; });
        return await running;
      }
      case "/api/ideas/more": return moreInLane(String(body?.lane ?? ""), await deps(), Math.min(12, Number(body?.n) || 6));
      case "/api/ideas/kit": {
        const kit = await buildStarterKit(String(body?.id ?? ""), { inv: await d.inventory(), claude: d.claude, gh: d.gh, cacheDir: d.cacheDir, card: cardOf });
        return body?.judge && !kit.judge ? { ...kit, judge: await judgeKit(kit, d.claude) } : kit;
      }
      case "/api/ideas/play": {
        if (body?.confirm !== true) throw new Error("Play writes a project folder; send confirm: true after the user says so");
        const card = cardOf(String(body?.id ?? ""));
        if (!card) throw new Error("That idea isn't in today's gallery");
        const kit: StarterKit = await buildStarterKit(card.id, { inv: await d.inventory(), claude: d.claude, gh: d.gh, cacheDir: d.cacheDir, card: cardOf });
        const dir = `${d.projectsDir ?? `${homedir()}/Documents/Projects`}/${slugOf(card.name)}`;
        return { dir, files: materializeKit(kit, card.name, dir) };
      }
    }
    return undefined;
  }
  return { handle };
}
