// The discover plugin: Discover (repos worth forking, the idea lab, plans, the Mixer, the Studio, the ideas feed) at
// /api/discover*, and the problem gallery at /api/ideas*. Its data stays where it always was: DECK_DISCOVER_DIR or the
// deck's data folder (discover.json, feed.json, ideas.db, ideas/, studio/, gallery/). Nothing runs on a clock: the
// daily feed, mixes and gallery start from a page's request, so a deck with Discover off makes no model calls for it.
// It runs on every machine, as it did in the core: Leads, Opportunities and Research read it on a node too.
// Other plugins add tabs to Discover's page through the page's "discover.tabs" point (js/discover.js).
import { homedir } from "node:os";
import type { Host } from "../../src/plugin-api";
import { createDiscover, gh } from "./discover";
import { feedQuery } from "./feed";
import { galleryForServer, type GalleryServerDeps } from "./gallery-server";

/** The services Discover works with when they're there: the library, connections and covers plugins, and Opportunities (core until phase 3). */
type Library = { evidence(q: string, k: number, use: "studio" | "ideas"): Promise<{ text: string; answers: any[] }> };
type Section = { id: string; items: any[] };
type Connections = { inventory(): Promise<{ sections: Section[] }>; enrich(inv: any): { sections: Section[]; categories: { id: string; label: string }[] }; recs(): any[] };
type Covers = { respond(data: unknown): Response };
type Opportunities = { store: Exclude<GalleryServerDeps["evidenceStore"], Function | undefined> };

export type DiscoverService = ReturnType<typeof createDiscover>;
export type GalleryService = ReturnType<typeof galleryForServer>;

export function activate(host: Host) {
  const dataDir = host.env("DECK_DISCOVER_DIR") || host.dataDir;
  const conns = () => host.use<Connections>("connections");
  const library = () => host.use<Library>("library");
  const discover = createDiscover(
    { dataDir, wikiDir: host.env("DECK_WIKI_DIR") || `${homedir()}/wiki`, projectsDir: host.env("DECK_PROJECTS_DIR") || `${homedir()}/Documents/Projects` },
    {
      connections: async () => {
        const c = conns();
        return c ? (await c.inventory()).sections.filter((s) => ["services", "ai", "custom"].includes(s.id)).flatMap((s) => s.items).filter((i) => i.status !== "off" && !i.hidden).map((i) => i.name) : [];
      },
      // The Mixer's ingredients: every store item with its category and state (names and one-line descriptions only).
      items: async () => {
        const c = conns();
        if (!c) return { items: [], categories: [] };
        const inv = c.enrich(await c.inventory());
        return { items: inv.sections.flatMap((s) => s.items).map(({ id, name, cat, state, detail, kind, hidden }) => ({ id, name, cat, state, detail, kind, hidden })), categories: inv.categories };
      },
      rows: () => host.rows().map((r) => ({ key: r.key, title: r.title, status: r.status, firstPrompt: r.firstPrompt })),
      studio: { evidence: async (text) => (await library()?.evidence(text, 4, "studio"))?.text ?? "" },
      feed: { evidence: async (rows) => (await library()?.evidence(feedQuery(rows), 5, "ideas"))?.text ?? "" },
    },
  );
  // Discover shares its evidence and experiment records with Opportunities: the gallery reads its store when it's there.
  const gallery = galleryForServer({
    dataDir, discover, gh,
    connections: async () => (await conns()?.inventory()) ?? { sections: [] },
    recs: () => conns()?.recs() ?? [],
    library: { evidence: async (q, k, use) => (await library()?.evidence(q, k, use)) ?? { answers: [] } },
    evidenceStore: () => host.use<Opportunities>("opportunities")?.store,
  });
  host.provide<DiscoverService>("discover", discover);
  host.provide<GalleryService>("gallery", gallery);
  host.onStop(() => discover.flush());

  // Replies that carry ideas get painted covers when the covers plugin is on; without it the page draws placeholders.
  const withCovers = (d: unknown) => host.use<Covers>("covers")?.respond(d) ?? d;
  host.routes("discover", async ({ path, body }) => { const d = await discover.handle(path, body); return d === undefined ? undefined : withCovers(d); });
  host.routes("ideas", async ({ path, body }) => { const d = await gallery.handle(path, body); return d === undefined ? undefined : withCovers(d); });
}
