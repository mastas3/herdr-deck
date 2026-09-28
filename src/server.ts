// HTTP front: one HTML page, one SSE stream of row patches, a handful of action endpoints.
// This deck is also a hub: machines listed in hosts.json are mirrored in and their actions forwarded.
// This file starts everything, in order; the parts live in src/http/ (routes.ts is where a request goes).
import { GROUPS, loadTools } from "./tools";
import { historyStats, stopHistory } from "./history";
import { warmSlash } from "./slash";
import { canShare } from "./share";
import { jevUsage } from "./jev";
import { Deck, type Row } from "./deck";
import { createCodexControl } from "./codex-control";
import { createCodexRecovery } from "./codex-recovery";
import { createCodexLifecycle } from "./codex-lifecycle";
import { call } from "./herdr";
import { PushStore } from "./push";
import { Automations } from "./automations";
import { createPlugins } from "./plugins";
import { createPluginHost } from "./plugin-host";
import { createCodePluginApi } from "./plugin-code-api";
import { watchPlugins } from "./plugin-dev";
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
  broadcast, scheduleDecisions: () => dec.scheduleDecisions(), observe: () => auto?.observe(),
  usageChanged: () => live.pushUsage(),
});
const { remotes, isNode, machines, summary, allRows, allGraves, tagLocal, machineLabelOf } = hosts;
/** One-off messages for the page (progress and failures of background work like starting a session). */
const notice = (data: { key?: string; ok: boolean; message: string }) => { if (!data.ok) console.warn(`notice: ${data.key ?? ""} ${data.message}`); broadcast("notice", data); };
const broadcastGraves = () => broadcast("graveyard", allGraves());
const chat = createChat({ deck, selfId: SELF.id });
const codex = createCodexControl({ receiptsFile: `${DATA_DIR}/codex-delivery.json`,
  activeThreads: () => deck.appThreads.filter((t) => t.status === "working" || t.status === "done").map((t) => t.id), changed: (id, state) => {
  deck.appControls.set(id, { ready: state.ready, status: state.status, activeTurnId: state.activeTurnId, error: state.error });
  deck.refresh();
} });
codex.start();
const codexRecovery = createCodexRecovery({ control: codex });
const codexLifecycle = createCodexLifecycle({ receiptsFile: `${DATA_DIR}/codex-lifecycle-delivery.json` });
const sessions = createSessions({ deck, graves, remotes, broadcastGraves, notice, codex });
const tools = createToolRuns({ deck, remotes, selfId: SELF.id, sendText: sessions.sendText, notice, extraTools: () => pluginHost.contributions("tools.entries") });
const forwardToMachine = createForward({ remotes, selfId: SELF.id, briefKey: chat.briefKey, closeLocal: sessions.closeLocal });

// Plugins (integrations and business packs): data only, reviewed and installed on the hub. Its own module.
const PLUGINS_DIR = process.env.DECK_PLUGINS_DIR || DATA_DIR;
const plugins = createPlugins({ dataDir: PLUGINS_DIR, catalogDir: new URL("../plugins-catalog", import.meta.url).pathname });
// ── push & automations (only the hub sends; a deck a hub talks to is a node) ──
const push = await new PushStore(PUSH_DIR, process.env.DECK_PUSH_SUBJECT ?? "mailto:rpsm90@gmail.com").init();
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
  digest: () => pluginHost.contributions("digest.lines"),
});
// Code plugins (plugins-builtin/<id>/, and approved installs under <data>/plugins/<id>/): each gets exactly what this
// lends it, and its routes, timers, services and contributions go away when it's turned off (src/plugin-host.ts).
const BUILTIN_DIR = new URL("../plugins-builtin", import.meta.url).pathname;
// Dev only: folders of plugins you're writing (DECK_DEV_PLUGINS=/a:/b), run like built-ins, never trust-checked.
const DEV_PLUGIN_DIRS = DEV ? (process.env.DECK_DEV_PLUGINS ?? "").split(":").filter(Boolean) : [];
const pluginHost = createPluginHost({
  builtinDir: BUILTIN_DIR, root: PLUGINS_DIR, dataDir: DATA_DIR, devDirs: DEV_PLUGIN_DIRS,
  // Built-ins start off: the core stays small until you turn an extra on in Plugins (DECK_PLUGINS_DEFAULT=on for tests/harness).
  builtinsOn: process.env.DECK_PLUGINS_DEFAULT === "on",
  reservedState: ["seq", "token", "self", "publicUrl", "rows", "summary", "graveyard", "tools", "toolGroups", "queue", "usage", "history", "decisions", "radar", "jev", "canShare", "auto", "push", "plugins"],
  core: {
    rows: () => allRows(), push, automations: () => auto, decisions: () => [...dec.decisions.values()], broadcast, notice, machines, isNode,
    history: (o) => tools.historyEverywhere(o), checks: () => deck.checks,
    sessions: {
      start: (o) => sessions.startSession(o), send: (key, text) => sessions.sendText(key, text), close: (keys, whole = false) => sessions.closeLocal(keys, whole),
      screen: async (key) => { const row = allRows().find((r) => r.key === key); return row ? ((await dec.screenOf(row)) ?? []).join("\n") : ""; },
      keys: async (key, keys) => { const f = deck.find(key); if (f) await call(f.sess.socket, "pane.send_keys", { pane_id: f.row.paneId, keys }); },
    },
  },
});
// What plugins need from the core that no plugin owns: the other machines' decks (the connections plugin reads their
// inventories) and recipes from enabled data plugins.
pluginHost.provideCore("remotes", { get: (id: string) => remotes.get(id), all: () => [...remotes.values()] });
pluginHost.provideCore("data-plugins", { recipes: () => plugins.recipes() });
const codePlugins = createCodePluginApi({ host: pluginHost, root: PLUGINS_DIR, broadcast, dataPluginIds: () => plugins.list().plugins.map((p) => p.id) });

(hostsConf.remotes ?? []).forEach((conf) => hosts.addRemote(conf));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { codex.close(); for (const h of remotes.values()) h.stop(); stopHistory(); await Promise.race([pluginHost.stop(), Bun.sleep(2000)]); process.exit(0); });

/** What a page starts from: inlined into the HTML, fetched (GET /api/state) or sent first on the stream. `seq` is the
 *  stream's last event in it, so a page asks only for what came after (src/http/sse.ts). */
function fullState() {
  return {
    ...pluginHost.state(),
    seq: sse.seq(), token: TOKEN, self: SELF.id, publicUrl: PUBLIC_URL, rows: allRows(), summary: summary(), graveyard: allGraves(),
    tools: [...loadTools(), ...pluginHost.contributions("tools.entries")], toolGroups: GROUPS, queue: queue.queues, usage: live.usage(), history: historyStats(), decisions: [...dec.decisions.values()], radar: dec.radar.list(), jev: jevUsage(), canShare: canShare(),
    auto: auto?.publicState(), push: { key: push.vapid.publicKey, node: isNode() }, plugins: { active: pluginHost.active() },
  };
}

deck.onPatch((patch) => { broadcast("patch", { upsert: patch.upsert.map(tagLocal), remove: patch.remove, summary: summary() }); auto?.observe(); });
deck.onUsage((u) => broadcast("procs", u));
// ── history, usage, sharing, proof of done, decisions ─────────────────────
// Passing checks also count on the quest board (the quests plugin's `game` service), while it's on.
const live = startLive({
  deck, broadcast, auto, game: { onCheck: (root, r) => pluginHost.service("game")?.onCheck(root, r) }, detailFor: chat.detailFor,
  selfId: SELF.id, remoteUsage: () => Object.fromEntries([...remotes.values()].map((h) => [h.conf.id, h.usage])),
});
const dec = createDecisions({ deck, remotes, allRows, detailFor: chat.detailFor, broadcast, isNode, push, auto, viewing });
deck.onPatch(dec.scheduleDecisions);
setInterval(dec.scheduleDecisions, 10_000);
sse.startPing();

const { assets, page } = createPage({ dev: DEV, fullState, plugins: () => pluginHost.assets() });
const queue = startQueue({ dataDir: DATA_DIR, broadcast, allRows, sendAny: sessions.sendAny });
const mcp = createMcp({
  selfId: SELF.id, remotes, allRows, localRow: hosts.localRow, machineLabelOf, detailFor: chat.detailFor, searchLocal: chat.searchLocal,
  historyEverywhere: tools.historyEverywhere, decisions: dec.decisions, sendText: sessions.sendText, startSession: sessions.startSession, notice, broadcast,
  tools: () => pluginHost.contributions("mcp.tools"),
});
const auth = createAuth({ port: PORT, host: HOST, apiToken: API_TOKEN, hubSeen: hosts.hubSeen });

const hub: Hub = {
  DEV, TOKEN, PORT, SELF, deck, hosts, graves, fakeRows, presence, push, auto, plugins, pluginHost, codePlugins,
  sse, fullState, page, assets, decisions: dec.decisions, scheduleDecisions: dec.scheduleDecisions, broadcastGraves, refreshShared: live.refreshShared,
  sessions, chat, tools, queue, mcp, auth, forwardToMachine, codex, codexRecovery, codexLifecycle,
};
// Plugins start before the port opens, so their routes exist for the first request.
await pluginHost.start();
// Plugin dev mode: an edited plugin restarts in place and the page reloads (src/plugin-dev.ts).
if (DEV && process.env.DECK_PLUGIN_DEV) watchPlugins({ host: pluginHost, dirs: [BUILTIN_DIR, ...DEV_PLUGIN_DIRS], onReload: (dev) => broadcast("plugins", { active: pluginHost.active(), dev }) });
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
// Warm the slow scan so the first "/" is instant (the connections plugin warms its own).
setTimeout(warmSlash, 8_000);

console.log(`herdr-deck "${SELF.label}" on http://${HOST}:${PORT}  (${deck.rows.size} panes across ${deck.sessions.size} herdr server(s); ${remotes.size} other machine(s))`);
