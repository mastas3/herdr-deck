// HTTP front: one HTML page, one SSE stream of row patches, a handful of action endpoints.
// This deck is also a hub: machines listed in hosts.json are mirrored in and their actions forwarded.
// This file starts everything, in order; the parts live in src/http/ (routes.ts is where a request goes).
import { homedir } from "node:os";
import { GROUPS, loadTools } from "./tools";
import { historyProjects, historyStats, stopHistory } from "./history";
import { inventory } from "./connections";
import { enrich } from "./store";
import { RECS } from "./catalog";
import { warmSlash } from "./slash";
import { canShare } from "./share";
import { jevUsage } from "./jev";
import { gameForServer } from "./game-server";
import { Deck, type Row } from "./deck";
import { createDiscover, gh } from "./discover";
import { createCovers } from "./covers";
import { galleryForServer } from "./gallery-server";
import { createLeads } from "./leads";
import { createLibrary, feedQuery } from "./library";
import { createJourneys, liveSessions, localHistory, projectSessions } from "./journey";
import { HISTORY_DB } from "./history-schema";
import { PushStore } from "./push";
import { Automations } from "./automations";
import { researchForServer } from "./autoresearch-server";
import { createOpportunityService } from "./opportunity-service";
import { runOpportunityWeb } from "./opportunity-web";
import { DATA_DIR, DEV, HOST, PORT, PUBLIC_URL, PUSH_DIR, TOKEN, loadApiToken, loadGraves, loadHosts, makeDataDirs } from "./http/config";
import { createSse } from "./http/sse";
import { createMachines } from "./http/machines";
import { createChat } from "./http/chat";
import { createSessions } from "./http/sessions";
import { createToolRuns } from "./http/run-tools";
import { createForward } from "./http/forward";
import { startLive } from "./http/live";
import { createDecisions } from "./http/decisions";
import { createPage } from "./http/page";
import { startQueue } from "./http/queue";
import { createMcp } from "./http/mcp-ctx";
import { createAuth } from "./http/auth";
import { createRoutes } from "./http/routes";
import type { Hub } from "./http/hub";

makeDataDirs();
const API_TOKEN = loadApiToken();
const { hostsConf, self: SELF } = loadHosts();
const graves = loadGraves();

const deck = new Deck();
await deck.start();

// These parts only take shape here: none of them touches the disk, a socket or a timer until it's called.
const sse = createSse();
const { broadcast } = sse;
/** Test-only rows (DECK_DEV): exercise alerts, the digest and the empty-session card without touching real sessions. */
const fakeRows = new Map<string, Row>();
const hosts = createMachines({
  deck, self: SELF, dataDir: DATA_DIR, hostsConf, graves, fakeRows,
  broadcast, fullState: () => fullState(), scheduleDecisions: () => dec.scheduleDecisions(), observe: () => auto?.observe(),
});
const { remotes, isNode, machines, summary, allRows, allGraves, tagLocal, machineLabelOf } = hosts;
/** One-off messages for the page (progress and failures of background work like starting a session). */
const notice = (data: { key?: string; ok: boolean; message: string }) => { if (!data.ok) console.warn(`notice: ${data.key ?? ""} ${data.message}`); broadcast("notice", data); };
const broadcastGraves = () => broadcast("graveyard", allGraves());
const chat = createChat({ deck, selfId: SELF.id });
const sessions = createSessions({ deck, graves, remotes, broadcastGraves, notice });
const tools = createToolRuns({ deck, remotes, selfId: SELF.id, sendText: sessions.sendText, notice });
const forwardToMachine = createForward({ remotes, selfId: SELF.id, briefKey: chat.briefKey, closeLocal: sessions.closeLocal });

// Founder Library (Discover → Library): its own module; the server routes /api/library/* to it, and the Studio, the
// ideas feed and the MCP tool read it as evidence. Its worker resumes only if you left it running.
const library = createLibrary();
if (!process.env.DECK_NO_LIBRARY) library.autostart();

// Discover (repos worth forking, idea lab, plans): its own module; the server only routes to it.
const discover = createDiscover(
  { dataDir: process.env.DECK_DISCOVER_DIR || DATA_DIR, wikiDir: process.env.DECK_WIKI_DIR || `${homedir()}/wiki`, projectsDir: process.env.DECK_PROJECTS_DIR || `${homedir()}/Documents/Projects` },
  {
    connections: async () => (await inventory()).sections.filter((s) => ["services", "ai", "custom"].includes(s.id)).flatMap((s) => s.items).filter((i) => i.status !== "off" && !i.hidden).map((i) => i.name),
    // The Mixer's ingredients: every store item with its category and state (names and one-line descriptions only).
    items: async () => { const inv = enrich(await inventory()); return { items: inv.sections.flatMap((s) => s.items).map(({ id, name, cat, state, detail, kind, hidden }) => ({ id, name, cat, state, detail, kind, hidden })), categories: inv.categories }; },
    rows: () => allRows().map((r) => ({ key: r.key, title: r.title, status: r.status, firstPrompt: r.firstPrompt })),
    studio: { evidence: async (text) => (await library.evidence(text, 4, "studio")).text },
    feed: { evidence: async (rows) => (await library.evidence(feedQuery(rows), 5, "ideas")).text },
  },
);
// Cover images for Discover ideas, a few a day from Codex on the hub (src/covers.ts). DECK_COVERS_DIR moves them and their covers.json (tests).
const COVERS_DIR = process.env.DECK_COVERS_DIR || `${process.env.DECK_DISCOVER_DIR || DATA_DIR}/covers`;
const covers = createCovers({ dir: COVERS_DIR, confFile: process.env.DECK_COVERS_DIR ? `${COVERS_DIR}/covers.json` : `${DATA_DIR}/covers.json`, dataDir: process.env.DECK_DISCOVER_DIR || DATA_DIR, enabled: () => !isNode() });
// The gallery ("For you": today's idea lanes, starter kits, Play), from the idea engine (src/gallery-server.ts, src/ideagen/).
const gallery = galleryForServer({ dataDir: process.env.DECK_DISCOVER_DIR || DATA_DIR, discover, connections: () => inventory(), gh, recs: () => RECS });
// Leads (Discover → Leads): public pain points and the people who have them. Its own module, like Discover.
const leads = createLeads(process.env.DECK_DISCOVER_DIR || DATA_DIR, {
  rows: () => allRows().map((r) => ({ key: r.key, title: r.title, status: r.status, firstPrompt: r.firstPrompt })),
  saved: discover.leadsSaved, interests: async () => (await discover.profile()).interests, projectsDir: process.env.DECK_PROJECTS_DIR || `${homedir()}/Documents/Projects`,
});
const opportunities = createOpportunityService({
  dir: process.env.DECK_DISCOVER_DIR || DATA_DIR,
  ingredients: async () => (await discover.ingredients(2500)).list,
  archive: async () => (await discover.handle("/api/discover/archive", { limit: 500, all: true })).ideas,
  research: (query, kind, force) => leads.search(query, kind, force),
  researchStatus: (id) => leads.handle("/api/leads/status", { id }),
  deepResearch: runOpportunityWeb,
});
// Project pages (journeys): their own module; the server only routes to it.
const journeyHist = localHistory(HISTORY_DB, SELF.id);
const journeys = createJourneys(
  { dataDir: DATA_DIR, cacheDir: process.env.DECK_JOURNEY_DIR || undefined, wikiDir: process.env.DECK_WIKI_DIR || `${homedir()}/wiki`, projectsDir: process.env.DECK_PROJECTS_DIR || `${homedir()}/Documents/Projects` },
  { sessions: (p) => projectSessions(p, tools.historyEverywhere), live: () => liveSessions(allRows(), journeyHist.started), historyProjects, local: journeyHist },
);
// ── push & automations (only the hub sends; a deck a hub talks to is a node) ──
const push = await new PushStore(PUSH_DIR, process.env.DECK_PUSH_SUBJECT ?? "mailto:rpsm90@gmail.com").init();
const game = gameForServer({ dataDir: DATA_DIR, journeys, discover, connections: async () => (await inventory()).sections.filter((s) => ["services", "ai", "custom"].includes(s.id)).flatMap((s) => s.items).filter((i) => i.status !== "off" && !i.hidden).map((i) => i.name), checks: () => deck.checks, push, isNode: () => isNode(), broadcast }); // the quest board (src/game*.ts)
/** Which session each open page is showing (and whether it's on screen): no push for what you're looking at. */
const presence = new Map<string, { key: string | null; at: number }>();
const viewing = (key: string) => [...presence.values()].some((p) => p.key === key && Date.now() - p.at < 70_000);
// Built now (its rules gate proof-of-done from the first patch on); its timers start once the server listens.
const auto: Automations | undefined = new Automations({
  file: `${PUSH_DIR}/automations.json`,
  rows: () => allRows(),
  deliver: (m, o) => push.deliver(m, o),
  changed: () => broadcast("auto", auto!.publicState()),
  viewing,
  ctx: () => ({ machineLabel: (id) => machineLabelOf(id) ?? "", multi: machines().filter((m) => m.kind !== "app").length > 1, question: (key) => dec.decisions.get(key)?.question }),
  canSend: () => !isNode(),
  questLines: game.questLines,
});
// Autoresearch (Discover → Research): its own modules (src/autoresearch*.ts); the server only lends it its machinery.
const research = researchForServer({ self: SELF.id, dataDir: DATA_DIR, deck, rows: allRows, startSession: sessions.startSession, closeLocal: sessions.closeLocal, sendText: sessions.sendText, screen: (r) => dec.screenOf(r), push, auto: () => auto, isNode, discover, machines });

(hostsConf.remotes ?? []).forEach((conf) => hosts.addRemote(conf));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { for (const h of remotes.values()) h.stop(); stopHistory(); process.exit(0); });

/** What a page starts from: inlined into the HTML, and sent first on every SSE connection. */
function fullState() {
  return {
    token: TOKEN, self: SELF.id, publicUrl: PUBLIC_URL, rows: allRows(), summary: summary(), graveyard: allGraves(),
    tools: loadTools(), toolGroups: GROUPS, queue: queue.queues, usage: live.usage(), history: historyStats(), decisions: [...dec.decisions.values()], radar: dec.radar.list(), jev: jevUsage(), canShare: canShare(),
    auto: auto?.publicState(), push: { key: push.vapid.publicKey, node: isNode() }, game: game.summary(),
  };
}

deck.onPatch((patch) => { broadcast("patch", { upsert: patch.upsert.map(tagLocal), remove: patch.remove, summary: summary() }); auto?.observe(); });
// ── history, usage, sharing, proof of done, decisions ─────────────────────
const live = startLive({ deck, broadcast, auto, game, detailFor: chat.detailFor });
const dec = createDecisions({ deck, remotes, allRows, detailFor: chat.detailFor, broadcast, isNode, push, auto, viewing });
deck.onPatch(dec.scheduleDecisions);
setInterval(dec.scheduleDecisions, 10_000);
sse.startPing();

const { assets, page } = createPage({ dev: DEV, fullState });
const queue = startQueue({ dataDir: DATA_DIR, broadcast, allRows, sendAny: sessions.sendAny });
const mcp = createMcp({
  selfId: SELF.id, remotes, allRows, localRow: hosts.localRow, machineLabelOf, detailFor: chat.detailFor, searchLocal: chat.searchLocal,
  historyEverywhere: tools.historyEverywhere, decisions: dec.decisions, sendText: sessions.sendText, startSession: sessions.startSession, notice, broadcast, library,
});
const auth = createAuth({ port: PORT, host: HOST, apiToken: API_TOKEN, hubSeen: hosts.hubSeen });

const hub: Hub = {
  DEV, TOKEN, PORT, SELF, deck, hosts, graves, fakeRows, presence, push, auto, game, covers, discover, gallery, library, leads, research, journeys, opportunities,
  sse, fullState, page, assets, decisions: dec.decisions, scheduleDecisions: dec.scheduleDecisions, broadcastGraves, refreshShared: live.refreshShared,
  sessions, chat, tools, queue, mcp, auth, forwardToMachine,
};
const serveOptions = { hostname: HOST, port: PORT, idleTimeout: 0, fetch: createRoutes(hub).fetch };

// A restart can race the previous instance for the port. Retry briefly; if it never frees up, exit so
// launchd/systemd restarts us, instead of lingering half-alive with tunnels open and nothing listening.
for (let attempt = 0; ; attempt++) {
  try {
    Bun.serve(serveOptions);
    break;
  } catch (e: any) {
    if (attempt >= 40) {
      console.error(`can't listen on ${HOST}:${PORT}: ${e?.message ?? e}`);
      process.exit(1);
    }
    await Bun.sleep(250);
  }
}
for (const h of remotes.values()) h.start();
auto.start();
setInterval(game.tick, 60_000);
research.start();
covers.start();
// Warm the slow scans so the first "/" and the first Connections view are instant.
setTimeout(() => { warmSlash(); inventory().catch(() => {}); }, 8_000);

console.log(`herdr-deck "${SELF.label}" on http://${HOST}:${PORT}  (${deck.rows.size} panes across ${deck.sessions.size} herdr server(s); ${remotes.size} other machine(s))`);
