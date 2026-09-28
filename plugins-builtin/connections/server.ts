// The connections plugin: the scan of what this machine can reach (connections.ts, in its own short-lived process; it
// also writes CONNECTIONS.md), the store's API (api.ts), the deck_connections MCP tool, and the `connections` service
// the rest of the deck reads inventories through (Discover, the gallery, the Studio, the quest board). It runs on
// nodes too: the hub reads a node's inventory from the node's own /api/connections.
import type { Host } from "../../src/plugin-api";
import { RECS } from "../../src/catalog";
import { inventory, inventoryText } from "./connections";
import { enrich } from "./store";
import { connectionsApi, type CoreRemotes } from "./api";

/** What others get from `use("connections")`: the inventory (cached 10 min; `force` rescans), the store's categories
 *  and states on top of it, and the recommended-services catalog. */
export type ConnectionsService = { inventory: typeof inventory; enrich: typeof enrich; recs: () => typeof RECS };

export function activate(host: Host) {
  host.provide<ConnectionsService>("connections", { inventory, enrich, recs: () => RECS });
  for (const r of ["connections", "connections-conf", "connections-text", "recipes", "suggest-projects"]) host.routes(r, ({ path, body }) => connectionsApi(host, path, body));
  host.extend("mcp.tools", {
    name: "deck_connections",
    description: "What this setup can reach: coding agents, AI subscriptions, MCP servers and connectors, signed-in CLIs, API key NAMES (never values), browser profiles, skills. Use it to plan work that spans services.",
    inputSchema: { type: "object", properties: { machine: { type: "string" } } },
    async call(a) {
      const machine = a?.machine, self = host.machines().find((m) => m.local && m.kind !== "app")?.id;
      if (machine && machine !== self) {
        const r = host.use<CoreRemotes>("remotes")?.get(machine);
        if (!r) throw new Error("unknown machine");
        return inventoryText((await r.post("/api/connections", {})).data);
      }
      return inventoryText(await inventory());
    },
  });
  // Warm the slow scan so the first Connections view is instant (after the deck's own start-up work).
  host.after(8_000, () => inventory().catch(() => {}));
}
