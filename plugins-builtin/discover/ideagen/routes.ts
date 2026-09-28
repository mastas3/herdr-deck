// /api/ideas/* for the Discover gallery (wired through src/gallery-server.ts, which adds the daily background job,
// the fallback cards and covers). Play is the only route that writes outside the cache: without confirm: true it only
// says what it would do (the folder, the files, task 1); with it, it writes the kit into a new project folder.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Gallery, IdeaCard, Inventory, PainCorpus, StarterKit, StrategyId } from "./types";
import type { TrendSet } from "./trends";
import type { ClaudeRunner, JevRunner } from "./llm";
import type { GhRes } from "../discover";
import type { IdeaArchive } from "../idea-archive";
import type { LibrarySearch } from "./library";
import type { Comparables, Target } from "../../../src/library-strategy";
import { cachedProblems, generateProblems } from "./problem-gallery";
import { cachedGallery, generateGallery, moreInLane, type GalleryDeps } from "./gallery";
import { buildStarterKit, judgeKit, slugOf } from "./kit";
import { materializeKit, KIT_FILES } from "./kit-files";
import { createRepoFinder } from "./connectors";

export type IdeasDeps = {
  cacheDir: string; projectsDir?: string;
  inventory: () => Promise<Inventory>; corpus: () => Promise<PainCorpus>; trends: () => Promise<TrendSet | undefined>;
  claude: ClaudeRunner; jev: JevRunner; gh: (args: string[], t?: number) => Promise<GhRes>;
  /** A card the page is showing that isn't in today's gallery (yesterday's, the lab's seed, a saved one). */
  card?: (id: string) => IdeaCard | undefined;
  archive?: Pick<IdeaArchive, "put" | "score">; library?: LibrarySearch; comparables?: (t: Target) => Comparables | undefined;
  recipe?: [StrategyId, number][]; premortems?: number; rubric?: boolean; evidenceFirst?: boolean;
  now?: () => number;
};
/** The folder Play would write: <projects>/<slug>, or <slug>-2, -3… when that one is taken (never a non-empty folder). */
export function playDir(projectsDir: string, name: string): { dir: string; slug: string } {
  const base = slugOf(name).slice(0, 36).replace(/-+$/, "") || "idea";
  for (let i = 1; i < 100; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const dir = `${projectsDir.replace(/\/+$/, "")}/${slug}`;
    if (!existsSync(dir) || !readdirSync(dir).length) return { dir, slug };
  }
  throw new Error(`Too many folders named ${base}`);
}
/** Task 1 of the kit as a prompt for the New session dialog, in the new folder. */
export function firstTask(kit: StarterKit, name: string, dir: string) {
  const t = kit.buildPlan[0];
  const home = dir.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  const title = t ? `${t.id} ${t.title}` : `Read the starter kit for ${name}`;
  const prompt = [
    `This is ${home}, the starter kit for “${name}”. Read CLAUDE.md, SPEC.md, ARCHITECTURE.md and TASKS.md first.`, "",
    t ? `Do task ${t.id} from TASKS.md: ${t.title}` : "Pick the first task in TASKS.md.", "",
    ...(t ? [t.prompt, "", "Done when:", ...t.accept.map((a) => `- ${a}`), ""] : []),
    `Tick ${t?.id ?? "it"} off in TASKS.md when the checks pass, then stop and show me.`,
    "Don't post, message, email or buy anything on my behalf, and don't deploy without asking me first.",
  ].join("\n");
  return { title, prompt };
}
export function createIdeasRoutes(d: IdeasDeps) {
  let running: Promise<Gallery> | undefined;
  const deps = async (): Promise<GalleryDeps> => ({
    cacheDir: d.cacheDir, inv: await d.inventory(), corpus: await d.corpus(), trends: d.evidenceFirst ? undefined : await d.trends(), claude: d.claude, jev: d.jev, findRepos: createRepoFinder(d.gh),
    archive: d.archive, library: d.library, comparables: d.comparables, recipe: d.recipe, premortems: d.premortems, rubric: d.rubric, now: d.now,
  });
  const today = () => { const t = new Date(d.now?.() ?? Date.now()); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
  const cardOf = (id: string) => (d.evidenceFirst ? cachedProblems(d.cacheDir, today()) : cachedGallery(d.cacheDir, today()))?.ideas[id] ?? d.card?.(id);
  const kitDeps = async () => ({ inv: await d.inventory(), claude: d.claude, gh: d.gh, cacheDir: d.cacheDir, card: cardOf, comparables: d.comparables });
  /** Today's gallery, generated once; everyone asking meanwhile shares the one run. */
  const generate = (force = false) => (running ??= deps().then((x) => d.evidenceFirst ? generateProblems(x, force) : generateGallery(x, { force })).finally(() => { running = undefined; }));
  async function handle(path: string, body: any): Promise<unknown> {
    switch (path) {
      case "/api/ideas": return await generate(!!body?.force);
      case "/api/ideas/more": {
        if (d.evidenceFirst) throw new Error("Review the current leads before starting another bounded problem search.");
        if (!cachedGallery(d.cacheDir, today())) throw new Error("Today's ideas are still being written; More works once they're in");
        return moreInLane(String(body?.lane ?? ""), await deps(), Math.min(12, Number(body?.n) || 6));
      }
      case "/api/ideas/kit": {
        const kit = await buildStarterKit(String(body?.id ?? ""), await kitDeps());
        return body?.judge && !kit.judge ? { ...kit, judge: await judgeKit(kit, d.claude) } : kit;
      }
      case "/api/ideas/play": {
        const card = cardOf(String(body?.id ?? ""));
        if (!card) throw new Error("That idea isn't in the gallery any more");
        const { dir, slug } = playDir(d.projectsDir ?? `${homedir()}/Documents/Projects`, card.name);
        // Without confirm: what would happen, and nothing else (no folder, no files, no model call).
        if (body?.confirm !== true) return { preview: true, id: card.id, name: card.name, dir, slug, files: KIT_FILES };
        const kit: StarterKit = await buildStarterKit(card.id, await kitDeps());
        return { id: card.id, name: card.name, dir, slug, files: materializeKit(kit, card.name, dir), firstTask: firstTask(kit, card.name, dir) };
      }
    }
    return undefined;
  }
  return { handle, generate, cardOf };
}
