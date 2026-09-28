// The covers plugin: the painting job (covers.ts) on the host's clock, its files at /covers/<id>.webp, its controls
// at /api/covers, and the `covers` service Discover's replies go through to get coverUrl/coverCat on each idea.
// Its data stays where it always was: <discover data>/covers/ and covers.json in the deck's data folder
// (DECK_COVERS_DIR moves both, for tests).
import type { Host } from "../../src/plugin-api";
import { createCovers } from "./covers";

/** What other plugins (and the core, until Discover is a plugin) get from `use("covers")`. */
export type CoversService = { respond(data: unknown): Response; has(id: string): boolean; coverUrl(id: string): string | undefined };

export function activate(host: Host) {
  const discoverDir = host.env("DECK_DISCOVER_DIR") || host.dataDir;
  const custom = host.env("DECK_COVERS_DIR");
  const dir = custom || `${discoverDir}/covers`;
  const covers = createCovers({ dir, confFile: custom ? `${dir}/covers.json` : `${host.dataDir}/covers.json`, dataDir: discoverDir, enabled: () => !host.isNode() });
  host.onStop(() => covers.stop());
  host.provide<CoversService>("covers", { respond: covers.respond, has: covers.has, coverUrl: covers.coverUrl });
  host.routes("/covers/", ({ req, url }) => covers.route(req, url, false));
  host.routes("covers", async ({ path, body }) => {
    if (path !== "/api/covers") return undefined;
    try { return await covers.handle(body); } catch (e: any) { return Response.json({ error: e?.message ?? String(e) }, { status: 400 }); }
  });
  // First look 90 s after start (the deck is busy warming up), then once a minute.
  host.after(90_000, () => covers.tick());
  host.every(60_000, () => covers.tick());
}
