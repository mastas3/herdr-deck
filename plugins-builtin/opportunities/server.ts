// The opportunities plugin: Opportunities (its own view at /?view=opportunities, and Discover → Evidence & tests) at
// /api/opportunities*, and the `opportunities` service. Its files stay in Discover's data folder, as before
// (DECK_DISCOVER_DIR or the deck's data folder: opportunities.db, the evidence notebook, and opportunity-jobs.json).
// Discover's gallery reads the same notebook: this lends it through Discover's "discover.evidence" point rather than a
// service, because Opportunities already uses Discover and a dependency both ways would stop both.
// Generation reads Discover's ingredients, import reads its archive, and research collects public sources through
// Leads; with either off those actions say so and nothing else changes. It runs on every machine, as it did in the core.
import type { Host } from "../../src/plugin-api";
import { createOpportunityService } from "./opportunity-service";
import { runOpportunityWeb } from "./opportunity-web";

/** The parts of Discover's and Leads' services Opportunities reads. */
type Discover = { ingredients(max: number): Promise<{ list: any[] }>; handle(path: string, body: any): Promise<any> };
type Leads = { search(query: string, kind: "audience" | "idea", force: boolean): any; handle(path: string, body: any): Promise<any> };
export type OpportunitiesService = ReturnType<typeof createOpportunityService>;

export function activate(host: Host) {
  const discover = () => host.use<Discover>("discover");
  const leads = () => {
    const l = host.use<Leads>("leads");
    if (!l) throw new Error("Leads is off: turn it on in Plugins to collect public sources");
    return l;
  };
  const opportunities = createOpportunityService({
    dir: host.env("DECK_DISCOVER_DIR") || host.dataDir,
    ingredients: async () => (await discover()?.ingredients(2500))?.list ?? [],
    archive: async () => (await discover()?.handle("/api/discover/archive", { limit: 500, all: true }))?.ideas ?? [],
    research: (query, kind, force) => leads().search(query, kind, force),
    researchStatus: (id) => leads().handle("/api/leads/status", { id }),
    deepResearch: runOpportunityWeb,
  });
  host.provide<OpportunitiesService>("opportunities", opportunities);
  host.extend("discover.evidence", { store: opportunities.store });
  host.routes("opportunities", ({ path, body }) => opportunities.handle(path, body));
  // Running jobs stop (their saved evidence stays) and the notebook's database closes.
  host.onStop(() => opportunities.close());
}
