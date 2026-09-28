// The projects plugin: project pages (journey*.ts) at /p and /p/<project>, their API at /api/journey*, and the
// `journeys` service the quest board reads. Journeys come from each project's git history, wiki page, sessions on
// every machine (the deck's history search) and what you log. Cached in <data>/journeys (DECK_JOURNEY_DIR moves it).
import { homedir } from "node:os";
import type { Host } from "../../src/plugin-api";
import { historyProjects } from "../../src/history";
import { HISTORY_DB } from "../../src/history-schema";
import { createJourneys } from "./journey-service";
import { liveSessions, localHistory, projectSessions } from "./journey-sessions";

export function activate(host: Host) {
  const self = host.machines().find((m) => m.local && m.kind !== "app")?.id ?? "";
  const hist = localHistory(HISTORY_DB, self);
  host.onStop(() => hist.close());
  const journeys = createJourneys(
    { dataDir: host.dataDir, cacheDir: host.env("DECK_JOURNEY_DIR") || undefined, wikiDir: host.env("DECK_WIKI_DIR") || `${homedir()}/wiki`, projectsDir: host.env("DECK_PROJECTS_DIR") || `${homedir()}/Documents/Projects` },
    { sessions: (p) => projectSessions(p, (o) => host.history(o)), live: () => liveSessions(host.rows(), hist.started), historyProjects, local: hist },
  );
  host.provide("journeys", journeys);
  const route = ({ path, body }: { path: string; body: any }) => journeys.handle(path, body);
  host.routes("journey", route);
  host.routes("journeys", route);
}
