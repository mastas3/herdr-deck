// The quests plugin: the quest board (game*.ts) on the host's clock, its API at /api/game*, the header chip's numbers
// in the page's state (`game`), today's quests in the morning digest, and the `game` service the core asks about
// passing checks and a quest run's new folder. It reads the project pages' journeys (required), and saved leads
// (Discover) and your connections when those are on. Its data stays in <data>/game (DECK_GAME_DIR moves it).
import type { Host } from "../../src/plugin-api";
import { gameForServer, type ServerParts } from "./game-server";

type Connections = { inventory: () => Promise<{ sections: { id: string; items: { name: string; status?: string; hidden?: boolean }[] }[] }> };

export function activate(host: Host) {
  const journeys = () => host.use<ServerParts["journeys"]>("journeys")!;
  const game = gameForServer({
    dataDir: host.dataDir,
    journeys: { get: (p, o) => journeys().get(p, o), index: (o) => journeys().index(o), seedLadder: (p, l) => journeys().seedLadder?.(p, l) },
    discover: { leadsSaved: { get: () => host.use<ServerParts["discover"]>("discover")?.leadsSaved.get() ?? [] } },
    connections: async () => {
      const c = host.use<Connections>("connections");
      if (!c) return [];
      return (await c.inventory()).sections.filter((s) => ["services", "ai", "custom"].includes(s.id)).flatMap((s) => s.items).filter((i) => i.status !== "off" && !i.hidden).map((i) => i.name);
    },
    checks: () => host.checks() as Map<string, any>, push: host.push, isNode: () => host.isNode(), broadcast: (e, d) => host.broadcast(e, d),
  });
  host.provide("game", game);
  host.routes("game", async ({ path, body }) => { const g = await game.route(path, body); return g ? Response.json(g.data, { status: g.status }) : undefined; });
  host.extend("fullState", { key: "game", get: () => game.summary() });
  host.extend("digest.lines", { title: "Today's quests", pref: "questDigest", lines: game.questLines });
  host.every(60_000, () => game.tick());
}
