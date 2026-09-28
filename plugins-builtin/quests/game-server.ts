// The quest board as the deck runs it: which deck services it reads, and the hub-only guard. This object is the `game`
// service; server.ts hooks it up (the route, the digest's quest lines, the header chip's state, the timer), and the
// core calls it for passing checks and a run's folder.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { jevAskOnce, jevAvailable, jevOutcome } from "../../src/jev";
import { runClaude } from "../../src/model-call";
import { createGame, type GameDeps, type GameMessage } from "./game";
import { runFolderOk } from "./game-runs";

type PushLike = { deliver: (m: any, o?: { ttl?: number; urgency?: "normal"; topic?: string }) => Promise<unknown> };
export type ServerParts = {
  dataDir: string; journeys: GameDeps["journeys"]; discover: { leadsSaved: { get: () => any[] } };
  connections: () => Promise<string[]>; checks: () => Map<string, any>;
  push: PushLike; isNode: () => boolean; broadcast: (event: string, data: unknown) => void;
};

export function gameForServer(s: ServerParts) {
  const projectsDir = process.env.DECK_PROJECTS_DIR || `${homedir()}/Documents/Projects`;
  const game = createGame({
    dir: process.env.DECK_GAME_DIR || `${s.dataDir}/game`, projectsDir, discoverDir: process.env.DECK_DISCOVER_DIR || s.dataDir,
    journeys: s.journeys, runner: process.env.DECK_GAME_AI === "0" ? undefined : runClaude,
    jev: { available: jevAvailable, ask: jevAskOnce, outcome: jevOutcome },
    leadsSaved: () => s.discover.leadsSaved.get(), connections: s.connections,
    checks: () => [...s.checks().entries()].map(([root, r]) => ({ ...r, root })),
    // Quest pushes go to devices that turned "Quest wins" on (the `quests` preference this plugin adds).
    deliver: (m: GameMessage) => (s.isNode() ? Promise.resolve() : s.push.deliver({ ...m, pref: "quests" }, { ttl: 12 * 3600, urgency: "normal", topic: `g${Bun.hash(m.tag ?? "quests").toString(36)}` })),
    changed: (sum) => s.broadcast("game", sum),
  });
  return {
    /** /api/game*: the board lives on the hub. */
    route: async (path: string, body: any): Promise<{ data: any; status: number } | undefined> => {
      if (!path.startsWith("/api/game")) return undefined;
      if (s.isNode()) return { data: { error: "The quest board lives on the hub: open it in the hub’s deck." }, status: 409 };
      const d = await game.handle(path, body);
      return d === undefined ? undefined : { data: d, status: 200 };
    },
    questLines: () => (game.started() && !s.isNode() ? game.digestLines() : Promise.resolve([] as string[])),
    onCheck: (root: string, r: any) => game.onCheck(root, r),
    summary: () => (s.isNode() ? undefined : game.summary()),
    tick: () => { if (game.started() && !s.isNode()) game.tick().catch(() => {}); },
    /** A new run's folder, made only when you confirmed the New session dialog (startRun asks for it with `mkdir`). */
    mkdirRun: (body: any) => { const cwd = String(body?.cwd ?? "").replace(/^~(?=\/|$)/, homedir()); if (body?.mkdir && runFolderOk(cwd, projectsDir) && !existsSync(cwd)) mkdirSync(cwd, { recursive: true }); },
  };
}
