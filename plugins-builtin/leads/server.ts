// The leads plugin: Discover → Leads at /api/leads*, and the `leads` service Opportunities collects public sources
// through. Its files stay in Discover's data folder, as before (DECK_DISCOVER_DIR or the deck's data folder:
// leads-cache.json, leads/). Saved leads and interests come from Discover while it's on; its page is a Discover tab
// only, so with Discover off it shows nothing. It runs on every machine, as it did in the core.
import { homedir } from "node:os";
import type { Host } from "../../src/plugin-api";
import { createLeads } from "./leads";

/** The part of Discover's service Leads reads. */
type Discover = { leadsSaved: { get(): any[]; set(v: any[]): void }; profile(): Promise<{ interests: { id: string; label: string; score?: number }[] }> };
export type LeadsService = ReturnType<typeof createLeads>;

export function activate(host: Host) {
  const discover = () => host.use<Discover>("discover");
  const leads = createLeads(host.env("DECK_DISCOVER_DIR") || host.dataDir, {
    rows: () => host.rows().map((r) => ({ key: r.key, title: r.title, status: r.status, firstPrompt: r.firstPrompt })),
    saved: { get: () => discover()?.leadsSaved.get() ?? [], set: (v) => discover()?.leadsSaved.set(v) },
    interests: async () => (await discover()?.profile())?.interests ?? [],
    projectsDir: host.env("DECK_PROJECTS_DIR") || `${homedir()}/Documents/Projects`,
  });
  host.provide<LeadsService>("leads", leads);
  host.routes("leads", ({ path, body }) => leads.handle(path, body));
  host.onStop(() => leads.flush());
}
