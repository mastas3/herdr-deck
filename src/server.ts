// HTTP front: one HTML page, one SSE stream of row patches, a handful of action endpoints.
// This deck is also a hub: machines listed in hosts.json are mirrored in and their actions forwarded.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { RemoteHost, splitKey, type Machine, type RemoteConf } from "./federation";
import { BUILTIN, GROUPS, fillTool, loadTools, saveCustomTools, type Tool } from "./tools";
import { historyProjects, historySession, historyStats, rescanHistory, searchHistory, startHistory, stopHistory, type HistSession } from "./history";
import { claimsDone, onCheck, resultFor, setApproval, verify, detectCheck, approvalFor, type CheckResult } from "./verify";
import { inventory, inventoryText, loadConnConf, saveConnConf, usage, type Item as ConnItem } from "./connections";
import { CATEGORIES, enrich } from "./store";
import { RECS } from "./catalog";
import { allRecipes, deleteCustom, fillPrompt, rankRecipes, recipeIds, saveCustom } from "./recipes";
import { upsertAccount } from "./accounts";
import { slashCommands, warmSlash } from "./slash";
import { canShare, servedPorts, share, unshare } from "./share";
import { buildDecision, choiceFromInput, judge, recordOutcome, needsYou, type Decision } from "./decisions";
import { RECEIPTS_FILE, cachedById, jevAvailable, jevFeature, jevUsage, setJevCap, setJevFeature } from "./jev";
import { gameForServer } from "./game-server";
import { statsFor } from "./jevstats";
import { appendAudit, handleMcp, mcpToken, readAudit, type McpCtx } from "./mcp";
import { Deck, type Row } from "./deck";
import { call } from "./herdr";
import { detailFor as detailOf, imageFor as imageOf, subDetailFor, subagentsFor } from "./insight";
import type { Detail, Msg } from "./transcript";
import { cachedBrief, writeBrief } from "./brief";
import { agentArgs } from "./args";
import { codexAppInstalled, codexAppRunning } from "./codexapp";
import { createDiscover, gh } from "./discover";
import { createCovers } from "./covers";
import { galleryForServer } from "./gallery-server";
import { createAssets } from "./assets";
import { createLeads } from "./leads";
import { createLibrary, feedQuery } from "./library";
import { createJourneys, liveSessions, localHistory, projectSessions } from "./journey";
import { HISTORY_DB } from "./history-schema";
import { PushStore, endpointOk, type Message } from "./push";
import { Automations, linkPath } from "./automations";
import { Radar } from "./radar";
import { routeMessage } from "./route";
import { researchForServer } from "./autoresearch-server";
import { createOpportunityService } from "./opportunity-service";
import { runOpportunityWeb } from "./opportunity-web";

const PORT = Number(process.env.DECK_PORT ?? 4747);
const HOST = process.env.DECK_HOST ?? "127.0.0.1";
const DEV = !!process.env.DECK_DEV;
const TOKEN = crypto.randomUUID();
const DATA_DIR = `${homedir()}/.config/herdr-deck`;
const GRAVE_FILE = `${DATA_DIR}/graveyard.json`;
const HTML_PATH = new URL("../public/index.html", import.meta.url).pathname;

mkdirSync(DATA_DIR, { recursive: true });
// Push keys, subscribed devices and automation rules (DECK_PUSH_DIR moves them, e.g. for a test instance).
const PUSH_DIR = process.env.DECK_PUSH_DIR ?? DATA_DIR;
mkdirSync(PUSH_DIR, { recursive: true });

// Nodes authenticate hub requests with this token. Only someone who can already log in to this
// machine (the hub reads it over SSH) can obtain it.
const API_TOKEN_FILE = `${DATA_DIR}/api.token`;
let API_TOKEN = "";
try { API_TOKEN = readFileSync(API_TOKEN_FILE, "utf8").trim(); } catch {}
if (!/^[a-f0-9]{32,}$/.test(API_TOKEN)) {
  API_TOKEN = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  writeFileSync(API_TOKEN_FILE, API_TOKEN + "\n", { mode: 0o600 });
}
chmodSync(API_TOKEN_FILE, 0o600);

// hosts.json: { "self": { "id", "label" }, "remotes": [{ "id", "label", "ssh" }] }
type HostsFile = { self?: { id?: string; label?: string }; remotes?: RemoteConf[] };
let hostsConf: HostsFile = {};
try { hostsConf = JSON.parse(readFileSync(`${DATA_DIR}/hosts.json`, "utf8")); } catch {}
const SELF = {
  id: (hostsConf.self?.id ?? "local").replace(/[^\w-]/g, "") || "local",
  label: hostsConf.self?.label ?? hostname().replace(/\.local$/, ""),
};

type Grave = {
  id: string;
  closedAt: number;
  herdr: string;
  workspaceId: string;
  title: string;
  agent: string;
  cwd: string;
  project: string;
  tab: string;
  sessionId?: string;
  resume?: string;
  lastActiveAt?: number;
};

let graveyard: Grave[] = [];
try { graveyard = JSON.parse(readFileSync(GRAVE_FILE, "utf8")); } catch {}
const saveGraves = () => writeFileSync(GRAVE_FILE, JSON.stringify(graveyard.slice(0, 300), null, 1));

const deck = new Deck();
await deck.start();

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
  { sessions: (p) => projectSessions(p, historyEverywhere), live: () => liveSessions(allRows(), journeyHist.started), historyProjects, local: journeyHist },
);
// ── push & automations (only the hub sends; a deck a hub talks to is a node) ──
const push = await new PushStore(PUSH_DIR, process.env.DECK_PUSH_SUBJECT ?? "mailto:rpsm90@gmail.com").init();
const game = gameForServer({ dataDir: DATA_DIR, journeys, discover, connections: async () => (await inventory()).sections.filter((s) => ["services", "ai", "custom"].includes(s.id)).flatMap((s) => s.items).filter((i) => i.status !== "off" && !i.hidden).map((i) => i.name), checks: () => deck.checks, push, isNode: () => isNode(), broadcast }); // the quest board (src/game*.ts)
let hubSeenAt = 0;
const isNode = () => process.env.DECK_ROLE === "node" || (process.env.DECK_ROLE !== "hub" && remotes.size === 0 && Date.now() - hubSeenAt < 15 * 60_000);
/** Which session each open page is showing (and whether it's on screen): no push for what you're looking at. */
const presence = new Map<string, { key: string | null; at: number }>();
const viewing = (key: string) => [...presence.values()].some((p) => p.key === key && Date.now() - p.at < 70_000);
// Built now (its rules gate proof-of-done from the first patch on); its timers start once the server listens.
let auto: Automations | undefined = new Automations({
  file: `${PUSH_DIR}/automations.json`,
  rows: () => allRows(),
  deliver: (m, o) => push.deliver(m, o),
  changed: () => broadcast("auto", auto!.publicState()),
  viewing,
  ctx: () => ({ machineLabel: (id) => machineLabelOf(id) ?? "", multi: machines().filter((m) => m.kind !== "app").length > 1, question: (key) => decisions.get(key)?.question }),
  canSend: () => !isNode(),
  questLines: game.questLines,
});
/** Test-only rows (DECK_DEV): exercise alerts, the digest and the empty-session card without touching real sessions. */
const fakeRows = new Map<string, Row>();
// Autoresearch (Discover → Research): its own modules (src/autoresearch*.ts); the server only lends it its machinery.
const research = researchForServer({ self: SELF.id, dataDir: DATA_DIR, deck, rows: allRows, startSession, closeLocal, sendText, screen: (r) => screenOf(r), push, auto: () => auto, isNode, discover, machines });

const remotes = new Map<string, RemoteHost>();
function addRemote(conf: RemoteConf) {
  if (!conf?.id || !conf.ssh || conf.id === SELF.id || remotes.has(conf.id)) return;
  const host = new RemoteHost(conf, {
    patch: (upsert, remove) => { broadcast("patch", { upsert, remove, summary: summary() }); scheduleDecisions(); auto?.observe(); },
    full: () => broadcast("full", fullState()),
    graveyard: () => broadcast("graveyard", allGraves()),
    notice: (n) => broadcast("notice", n),
  });
  remotes.set(conf.id, host);
  return host;
}
(hostsConf.remotes ?? []).forEach((conf) => addRemote(conf));
const saveHosts = () => writeFileSync(`${DATA_DIR}/hosts.json`, JSON.stringify({ ...hostsConf, remotes: [...remotes.values()].map((h) => h.conf) }, null, 2));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { for (const h of remotes.values()) h.stop(); stopHistory(); process.exit(0); });

const tagLocal = (r: Row): Row => ({ ...r, machine: r.app ? "codex-app" : SELF.id });
function machines(): Machine[] {
  const app: Machine[] = codexAppInstalled() ? [{ id: "codex-app", label: "Codex app", local: true, online: codexAppRunning(), kind: "app" } as Machine] : [];
  return [{ id: SELF.id, label: SELF.label, local: true, online: true, herdr: deck.summary().herdr }, ...[...remotes.values()].map((h) => h.machine()), ...app];
}
/** Any local row: a pane, a Codex app thread, or a past session from the history index ("h:<agent>:<id>"). */
const localRow = (key: string): Row | undefined => deck.rows.get(key) ?? (key?.startsWith("h:") ? histRow(historySession(key)) : undefined);
function histRow(h: HistSession | undefined): Row | undefined {
  if (!h) return;
  return {
    key: h.key, herdr: "history", workspaceId: "history", workspace: "History", tabId: h.id, tab: "", tabNumber: 0, tabPanes: 1, paneId: h.id,
    agent: h.agent, status: "history", focused: false, title: h.title || "(untitled)", firstPrompt: h.first, cwd: h.cwd, project: h.project, projectRoot: h.root,
    startedAt: h.started, createdAt: h.started, lastActiveAt: h.last, model: h.model, rssKB: 0, cpu: 0, procs: 0, sessionId: h.id,
    tail: [], empty: false, stale: false, duplicate: false, approx: false, hist: h.file,
  } as Row;
}
function summary() {
  return { ...deck.summary(), machines: machines() };
}
function allRows() {
  const out = [...deck.rows.values()].map(tagLocal);
  for (const h of remotes.values()) out.push(...h.rows.values());
  if (fakeRows.size) out.push(...fakeRows.values());
  return out;
}
function allGraves() {
  const local = graveyard.slice(0, 100).map((g) => ({ ...g, machine: SELF.id }));
  const all = [...local, ...[...remotes.values()].flatMap((h) => h.graveyard)];
  return all.sort((a, b) => b.closedAt - a.closedAt).slice(0, 150);
}

// ── SSE ──────────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const PUBLIC_URL = (process.env.DECK_PUBLIC_URL ?? "").replace(/\/$/, "");
function fullState() {
  return {
    token: TOKEN, self: SELF.id, publicUrl: PUBLIC_URL, rows: allRows(), summary: summary(), graveyard: allGraves(),
    tools: loadTools(), toolGroups: GROUPS, queue: queues, usage: currentUsage, history: historyStats(), decisions: [...decisions.values()], radar: radar.list(), jev: jevUsage(), canShare: canShare(),
    auto: auto?.publicState(), push: { key: push.vapid.publicKey, node: isNode() }, game: game.summary(),
  };
}

function broadcast(event: string, data: unknown) {
  const chunk = sse(event, data);
  for (const c of clients) try { c.enqueue(chunk); } catch { clients.delete(c); }
}

deck.onPatch((patch) => { broadcast("patch", { upsert: patch.upsert.map(tagLocal), remove: patch.remove, summary: summary() }); auto?.observe(); });
// ── history, usage, sharing, proof of done, decisions ─────────────────────
startHistory({ changed: () => broadcast("history", historyStats()) });
setInterval(() => broadcast("history", historyStats()), 5_000);

let currentUsage = usage();
setInterval(() => {
  const u = usage();
  if (JSON.stringify(u) !== JSON.stringify(currentUsage)) { currentUsage = u; broadcast("usage", u); }
}, 20_000);

async function refreshShared() {
  const m = await servedPorts().catch(() => new Map());
  if (JSON.stringify([...m]) !== JSON.stringify([...deck.shared])) { deck.shared = m; deck.refresh(); }
}
refreshShared();
setInterval(refreshShared, 15_000);

// A finished session that claims it's done gets its project's checks re-run (once you've approved them).
for (const row of deck.rows.values()) { const r = row.projectRoot && resultFor(row.projectRoot); if (r) deck.checks.set(row.projectRoot!, r); }
onCheck((root, r) => {
  game.onCheck(root, r);
  deck.checks.set(root, r);
  deck.refresh();
  if (["pass", "fail", "error"].includes(r.state)) auto?.record("proof", `${root.split("/").pop()}: ${r.state === "pass" ? "checks passed" : r.state === "fail" ? `checks failed (exit ${r.exit})` : `couldn’t run (${r.reason ?? "error"})`} · ${r.cmd ?? ""}`, r.state === "pass");
});
const claimSeen = new Map<string, number>();
async function maybeVerify(row: Row) {
  if (row.app || !row.projectRoot || row.status !== "done" || row.seen || !row.sessionId) return;
  if (auto && !auto.rules.proof.on) return; // Settings → Automations → Proof of done
  if (claimSeen.get(row.key) === row.lastActiveAt) return;
  claimSeen.set(row.key, row.lastActiveAt ?? 0);
  const d = await detailFor(row).catch(() => undefined);
  const last = [...(d?.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.text)?.text;
  if (!claimsDone(last)) return;
  const r = await verify(row.projectRoot).catch(() => undefined);
  if (r) { deck.checks.set(row.projectRoot, r); deck.refresh(); }
}
deck.onPatch((patch) => { for (const r of patch.upsert) maybeVerify(r); });

const decisions = new Map<string, Decision>();
const chatTail = async (row: Row) => {
  const route = splitKey(row.key, remotes);
  if (route.remote) return (await route.remote.post("/api/chat", { key: route.key, limit: 40 })).data;
  const d = await detailFor(row);
  return d ? { messages: d.messages.slice(-40) } : undefined;
};
/** What a waiting pane shows right now (full screen, blank lines kept), on whichever machine it's on. */
const screenOf = async (row: Row): Promise<string[] | undefined> => {
  const route = splitKey(row.key, remotes);
  let text: string | undefined;
  if (route.remote) text = (await route.remote.post("/api/read", { key: route.key, lines: 60 })).data?.text;
  else {
    const f = deck.find(row.key);
    if (!f) return;
    text = (await call(f.sess.socket, "pane.read", { pane_id: f.row.paneId, source: "visible" }))?.read?.text;
  }
  return text ? String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").slice(-60) : undefined;
};
let decTimer: Timer | undefined;
// The radar runs on the same beat but on its own: the decisions rebuild never waits for it.
const scheduleDecisions = () => { clearTimeout(decTimer); decTimer = setTimeout(() => { rebuildDecisions(); radar.pass(allRows()).catch(() => {}); }, 350); };
async function rebuildDecisions() {
  const rows = allRows().filter(needsYou);
  const next = new Map<string, Decision>();
  await Promise.all(rows.map(async (r) => {
    const d = await buildDecision(r, chatTail, screenOf).catch(() => undefined);
    if (!d) return;
    next.set(r.key, d);
    judge(d, r, chatTail, scheduleDecisions).catch(() => {});
  }));
  const before = JSON.stringify([...decisions.values()]);
  decisions.clear();
  for (const [k, v] of next) decisions.set(k, v);
  if (JSON.stringify([...decisions.values()]) !== before) broadcast("decisions", [...decisions.values()]);
  const u = jevUsage();
  if (u.calls !== lastJevCalls) { lastJevCalls = u.calls; broadcast("jev", u); }
}
let lastJevCalls = jevUsage().calls;
// Stuck and drift radar: running sessions that look stuck get a Jev read, shown as a chip; two confident
// "stuck" reads in a row push once (as a "needs you" alert, so device choices and quiet hours apply).
const radar = new Radar({
  chat: chatTail,
  changed: (list) => broadcast("radar", list),
  enabled: () => !isNode() && jevFeature("radar") && jevAvailable(), // only the hub asks
  push: (m, r) => {
    const rules = auto?.rules.alerts;
    if (isNode() || (rules && !(rules.on && rules.needs)) || viewing(r.key)) return;
    push.deliver({ ...m, url: linkPath(r) }, { urgency: "high", ttl: 6 * 3600, topic: `r${Bun.hash(r.key).toString(36)}` }).catch(() => {});
  },
});
deck.onPatch(scheduleDecisions);
setInterval(scheduleDecisions, 10_000);

/** One-off messages for the page (progress and failures of background work like starting a session). */
const notice = (data: { key?: string; ok: boolean; message: string }) => { if (!data.ok) console.warn(`notice: ${data.key ?? ""} ${data.message}`); broadcast("notice", data); };
const broadcastGraves = () => broadcast("graveyard", allGraves());
setInterval(() => {
  const ping = enc.encode(`: ping\n\n`);
  for (const c of clients) try { c.enqueue(ping); } catch { clients.delete(c); }
}, 15_000);

// ── HTML ─────────────────────────────────────────────────────────────────────
// app.js and the files public/assets.json names are served under content hashes (src/assets.ts).
const assets = createAssets(new URL("../public", import.meta.url).pathname, { dev: DEV, log: (s) => console.warn(s) });
let htmlTemplate = readFileSync(HTML_PATH, "utf8");
function page() {
  if (DEV) htmlTemplate = readFileSync(HTML_PATH, "utf8");
  const boot = JSON.stringify(fullState()).replace(/</g, "\\u003c");
  return assets.inject(htmlTemplate.replace("/*__BOOT__*/", `window.__BOOT__=${boot};`));
}

/** gzip for anything text-like and big enough to matter (the tailnet path is the slow one). */
function send(req: Request, body: string | Uint8Array, type: string, cache = "no-store", status = 200) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers: Record<string, string> = { "content-type": type, "cache-control": cache, vary: "accept-encoding" };
  if (bytes.length > 1400 && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
    headers["content-encoding"] = "gzip";
    return new Response(Bun.gzipSync(bytes, { level: 4 }), { status, headers });
  }
  return new Response(bytes, { status, headers });
}

// ── actions ──────────────────────────────────────────────────────────────────
async function closeRow(key: string, whole: boolean) {
  const f = deck.find(key);
  if (!f) return { key, ok: false, error: "already gone" };
  const { row, sess } = f;
  const closeTab = whole || row.tabPanes <= 1;
  try {
    if (closeTab) await call(sess.socket, "tab.close", { tab_id: row.tabId });
    else await call(sess.socket, "pane.close", { pane_id: row.paneId });
  } catch (e: any) {
    return { key, ok: false, error: e?.message ?? String(e) };
  }
  // Closing a whole tab kills its sibling panes too; record every one of them.
  const victims: Row[] = closeTab ? [...deck.rows.values()].filter((r) => r.herdr === row.herdr && r.tabId === row.tabId) : [row];
  for (const v of victims) {
    if (v.empty && !v.resume) continue; // nothing worth remembering
    graveyard.unshift({
      id: crypto.randomUUID(),
      closedAt: Date.now(),
      herdr: v.herdr,
      workspaceId: v.workspaceId,
      title: v.title,
      agent: v.agent,
      cwd: v.cwd,
      project: v.project,
      tab: v.tab,
      sessionId: v.sessionId,
      resume: v.resume,
      lastActiveAt: v.lastActiveAt,
    });
  }
  return { key, ok: true, closed: closeTab ? "tab" : "pane" };
}

/** Resolves once the pane shows output that has stopped changing: the shell has drawn its prompt. */
async function waitForPrompt(socket: string, paneId: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let last = "";
  let stableSince = 0;
  while (Date.now() < until) {
    const r = await call(socket, "pane.read", { pane_id: paneId, source: "visible" }).catch(() => null);
    const text = (r?.read?.text ?? "").trim();
    if (text && text === last) {
      if (Date.now() - stableSince > 400) return;
    } else {
      last = text;
      stableSince = Date.now();
    }
    await Bun.sleep(100);
  }
}

async function reopen(id: string) {
  const g = graveyard.find((x) => x.id === id);
  if (!g) throw new Error("not in graveyard");
  const sess = deck.sessions.get(g.herdr) ?? [...deck.sessions.values()].find((s) => s.online);
  if (!sess) throw new Error("no herdr server running");
  const ws = sess.snap?.workspaces?.some((w: any) => w.workspace_id === g.workspaceId) ? g.workspaceId : undefined;
  const r = await call(sess.socket, "tab.create", { cwd: g.cwd, label: g.tab || g.project, workspace_id: ws ?? null, focus: false });
  const paneId = r.root_pane?.pane_id;
  if (g.resume && paneId) {
    // A slow .zshrc can drop input typed before the first prompt, so wait for it.
    await waitForPrompt(sess.socket, paneId);
    await call(sess.socket, "pane.send_input", { pane_id: paneId, text: g.resume, keys: ["enter"] });
  }
  graveyard = graveyard.filter((x) => x.id !== id);
  saveGraves();
  broadcastGraves();
  await deck.kick(sess.name);
  return { ok: true, paneId };
}

const who = (row: Row) => ({ agent: row.agent, sessionId: row.sessionId, cwd: row.cwd, file: (row as any).hist as string | undefined });
const detailFor = (row: Row) => detailOf(who(row));
const imageFor = (row: Row, id: string, sub?: string) => imageOf(who(row), id, sub);

/** A window of the chat: the newest `limit` messages, those after a cursor (live updates) or before one (scrollback). */
function chatSlice(d: Detail, q: { gen?: number; after?: number; before?: number; limit?: number; around?: number; from?: number; to?: number }) {
  const limit = Math.min(Math.max(Number(q.limit) || 120, 1), 400);
  const all = d.messages;
  let msgs: Msg[];
  const sameGen = q.gen === d.gen;
  if (q.around != null) {
    // Jumping to a search hit: a window around it, plus the newest messages so the chat still ends where it is.
    const a = Math.max(0, Math.min(all.length - 1, Number(q.around)));
    const win = all.slice(Math.max(0, a - 30), a + 120);
    const tail = all.slice(-60).filter((m) => m.i >= a + 120);
    return { gen: d.gen, total: all.length, reset: true, messages: [...win, ...tail] };
  }
  if (sameGen && q.from != null) msgs = all.slice(Math.max(0, Number(q.from)), Math.min(all.length, Number(q.to ?? Number(q.from) + limit)));
  else if (sameGen && q.after != null) {
    // Tool calls flip from running to done, so resend the tail window the client already has as well.
    const from = Math.max(0, Math.min(Number(q.after) + 1, all.length) - 12);
    msgs = all.slice(from);
  } else if (sameGen && q.before != null) msgs = all.slice(Math.max(0, Number(q.before) - limit), Number(q.before));
  else msgs = all.slice(-limit);
  return { gen: d.gen, total: all.length, reset: !sameGen && (q.after != null || q.before != null), messages: msgs };
}

// ── deep search across every conversation ────────────────────────────────

/** Every word must appear in one message; hits rank by how many messages match and how recent the best one is. */
async function searchLocal(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !/^(is|agent):/.test(w) && !w.startsWith("-"));
  if (!words.length || q.length < 3) return [];
  const hits: any[] = [];
  const t0 = performance.now();
  for (const row of deck.rows.values()) {
    if (!row.sessionId || performance.now() - t0 > 400) continue;
    const d = await detailFor(row).catch(() => undefined);
    if (!d) continue;
    let best: Msg | undefined, count = 0;
    for (let i = d.messages.length - 1; i >= 0; i--) {
      const m = d.messages[i];
      const text = (m.text ?? `${m.tool ?? ""} ${m.summary ?? ""}`).toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
      count++;
      if (!best || (best.role === "tool" && m.role !== "tool")) best = m;
      if (count > 50) break;
    }
    if (!best) continue;
    const text = best.text ?? `${best.tool}: ${best.summary}`;
    const at = text.toLowerCase().indexOf(words[0]);
    const from = Math.max(0, at - 70);
    const snippet = (from > 0 ? "…" : "") + text.slice(from, at + 150).replace(/\s+/g, " ").trim() + (at + 150 < text.length ? "…" : "");
    hits.push({ key: row.key, i: best.i, role: best.role, at: best.at, count, snippet });
  }
  return hits.sort((a, b) => b.count - a.count || (b.at ?? 0) - (a.at ?? 0)).slice(0, 80);
}

// ── files the agents mention ───────────────────────────────────────────────

const DENY = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud|Library\/Keychains)(\/|$)|(^|\/)\.env(\.|$)|\.(pem|key|p12|keychain)$|api\.token$|id_(rsa|ed25519)/;
/** Paths an agent mentioned, resolved against its folder; only files in your home, and never keys or secrets. */
function resolveSafe(cwd: string | undefined, raw: string): string | undefined {
  let p = raw.trim().replace(/^file:\/\//, "").replace(/:\d+(:\d+)?$/, "");
  if (!p) return;
  // [[wiki-page]]: the LLM wiki's page folders, first match wins
  const wiki = p.match(/^wiki:([\w.-]+)$/);
  if (wiki) {
    const base = process.env.DECK_WIKI_DIR ?? `${homedir()}/wiki`;
    p = ["projects", "concepts", "entities", "synthesis", "sources", ""].map((d) => `${base}/${d ? d + "/" : ""}${wiki[1]}.md`).find((f) => existsSync(f)) ?? `${base}/${wiki[1]}.md`;
  }
  if (p.startsWith("~/")) p = homedir() + p.slice(1);
  else if (!p.startsWith("/")) { if (!cwd) return; p = `${cwd}/${p}`; }
  p = new URL("file://" + p).pathname; // normalises ../
  p = decodeURIComponent(p);
  if (!p.startsWith(homedir() + "/") && !p.startsWith("/tmp/") && !p.startsWith("/private/tmp/")) return;
  if (DENY.test(p)) return;
  return p;
}
async function readFileFor(cwd: string | undefined, raw: string) {
  const p = resolveSafe(cwd, raw);
  if (!p) return { error: "That path isn’t one the deck will show (outside your home folder, or a secret)." };
  let st;
  try { st = statSync(p); } catch { return { error: `Not found: ${p.replace(homedir(), "~")}` }; }
  const line = Number(raw.match(/:(\d+)(?::\d+)?$/)?.[1]) || undefined;
  if (st.isDirectory()) {
    const entries = readdirSync(p, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).slice(0, 300).map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    return { path: p, kind: "dir", entries, mtime: st.mtimeMs };
  }
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (/^(png|jpe?g|gif|webp|svg|avif)$/.test(ext)) return { path: p, kind: "image", size: st.size, mtime: st.mtimeMs };
  if (st.size > 1_500_000) return { path: p, kind: "binary", size: st.size, mtime: st.mtimeMs };
  const buf = new Uint8Array(await Bun.file(p).arrayBuffer());
  if (buf.subarray(0, 8000).includes(0)) return { path: p, kind: "binary", size: st.size, mtime: st.mtimeMs };
  return { path: p, kind: /^(md|markdown|mdx)$/.test(ext) ? "markdown" : "text", ext, size: st.size, mtime: st.mtimeMs, line, content: new TextDecoder().decode(buf) };
}

async function chatFor(row: Row, body: any) {
  const d = body.sub ? await subDetailFor(who(row), String(body.sub)) : await detailFor(row);
  if (!d) return { gen: 0, total: 0, messages: [] };
  return chatSlice(d, body);
}

const briefKey = (row: Row) => (row.machine && row.machine !== SELF.id ? `${row.machine}-` : "") + `${row.agent}-${row.sessionId}`;

/** Detail payload: newest turns first are what the page shows, so cap from the end. */
function detailPayload(row: Row, d: Detail | undefined) {
  const brief = row.sessionId ? cachedBrief(briefKey(row)) : undefined;
  if (!d) return { brief };
  return {
    brief,
    briefStale: !!brief && brief.asks !== d.asks,
    startedAt: d.startedAt,
    started: d.started,
    recap: d.recap,
    aiTitle: d.aiTitle,
    asks: d.asks,
    compactions: d.compactions,
    workMs: d.workMs,
    turns: d.turns.slice(-150),
    turnsOmitted: Math.max(0, d.turns.length - 150),
    images: d.images.slice(-60),
    imagesTotal: d.images.length,
  };
}

// ── new-session choices ────────────────────────────────────────────────────

type Opt = { v: string; l?: string; efforts?: string[] };
let ocModels: { at: number; list: Opt[] } = { at: 0, list: [] };
async function opencodeModels(): Promise<Opt[]> {
  if (Date.now() - ocModels.at < 10 * 60_000 && ocModels.list.length) return ocModels.list;
  try {
    const p = Bun.spawn(["opencode", "models"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, NO_COLOR: "1" } });
    const t = setTimeout(() => p.kill(), 15_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(t);
    const list = out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:/@-]+$/.test(l)).map((v) => ({ v }));
    if (list.length) ocModels = { at: Date.now(), list };
  } catch {}
  return ocModels.list;
}

function codexChoices() {
  let models: Opt[] = [], defModel = "", defEffort = "";
  try {
    const d = JSON.parse(readFileSync(`${homedir()}/.codex/models_cache.json`, "utf8"));
    const arr = Array.isArray(d) ? d : d.models ?? [];
    models = arr.map((m: any) => ({ v: m.slug ?? m.id, l: m.display_name ?? undefined, efforts: (m.supported_reasoning_levels ?? []).map((x: any) => x.effort ?? x).filter(Boolean) })).filter((m: Opt) => m.v);
  } catch {}
  try {
    const cfg = readFileSync(`${homedir()}/.codex/config.toml`, "utf8");
    defModel = cfg.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    defEffort = cfg.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  } catch {}
  return { models, defModel, defEffort };
}

async function agentChoices() {
  const cx = codexChoices();
  return {
    claude: {
      models: [{ v: "", l: "Default" }, { v: "fable", l: "Fable" }, { v: "opus", l: "Opus" }, { v: "sonnet", l: "Sonnet" }, { v: "haiku", l: "Haiku" }],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      modes: [{ v: "", l: "Ask first" }, { v: "acceptEdits", l: "Accept edits" }, { v: "auto", l: "Auto" }, { v: "plan", l: "Plan only" }, { v: "bypassPermissions", l: "Skip all checks" }],
    },
    codex: {
      models: [{ v: "", l: `Default${cx.defModel ? ` (${cx.defModel})` : ""}` }, ...cx.models],
      efforts: [...new Set(cx.models.flatMap((m) => m.efforts ?? []))],
      defaultEffort: cx.defEffort,
      modes: [{ v: "", l: "Default" }, { v: "read-only", l: "Read only" }, { v: "workspace-write", l: "Workspace write" }, { v: "yolo", l: "No sandbox, no approvals" }],
    },
    opencode: {
      models: [{ v: "", l: "Default" }, ...(await opencodeModels())],
      efforts: [],
      modes: [{ v: "", l: "Build (default)" }, { v: "plan", l: "Plan" }],
    },
  };
}



const AGENT_KINDS = new Set(["claude", "codex", "opencode", "gemini", "cursor", "copilot", "amp", "grok", "hermes", "qwen", "kimi", "droid", "pi"]);

/** Folder suggestions and the flags the user tends to start each agent with. */
async function newSessionOptions() {
  const recent = new Map<string, number>();
  for (const r of deck.rows.values()) recent.set(r.cwd, Math.max(recent.get(r.cwd) ?? 0, r.lastActiveAt ?? r.startedAt ?? 0));
  for (const g of graveyard) recent.set(g.cwd, Math.max(recent.get(g.cwd) ?? 0, g.closedAt));
  // Common homes for code; DECK_PROJECT_DIRS (colon-separated) overrides.
  const roots = (process.env.DECK_PROJECT_DIRS ?? ["Documents/Projects", "Projects", "projects", "code", "src", "dev", "repos", "work"].map((d) => `${homedir()}/${d}`).join(":")).split(":");
  let projects: { path: string; mtime: number }[] = [];
  for (const root of roots) {
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        projects.push({ path: `${root}/${d.name}`, mtime: statSync(`${root}/${d.name}`).mtimeMs });
      }
    } catch {}
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  const argHints: Record<string, Record<string, number>> = {};
  for (const r of deck.rows.values()) {
    if (!AGENT_KINDS.has(r.agent) || !r.command) continue;
    // "node /…/bin/codex --yolo" or "claude --resume <id>": keep the flags, drop paths and resume ids.
    const words = r.command.split(/\s+/);
    const i = words.findIndex((w) => w === r.agent || w.endsWith(`/${r.agent}`));
    const flags = words.slice(i + 1).filter((w, j, a) => w.startsWith("-") && !/^--?(resume|r|session|s)$/.test(w) && !/^--?(resume|session)$/.test(a[j - 1] ?? ""));
    const k = flags.join(" ");
    (argHints[r.agent] ??= {})[k] = (argHints[r.agent][k] ?? 0) + 1;
  }
  const workspaces = [...deck.sessions.values()].filter((s) => s.online).flatMap((s) =>
    (s.snap?.workspaces ?? []).map((w: any) => ({ herdr: s.name, id: w.workspace_id, label: w.label, focused: s.snap.focused_workspace_id === w.workspace_id })),
  );
  return {
    recent: [...recent.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 30),
    projects: projects.map((p) => p.path).slice(0, 80),
    choices: await agentChoices(),
    argHints: Object.fromEntries(Object.entries(argHints).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1]).map(([a]) => a).filter(Boolean).slice(0, 3)])),
    workspaces,
  };
}

async function startSession(body: any) {
  const kind = String(body.kind ?? "claude");
  if (kind !== "shell" && !AGENT_KINDS.has(kind)) throw new Error(`unknown agent "${kind}"`);
  const cwd = String(body.cwd ?? "").replace(/^~(?=\/|$)/, homedir());
  try {
    if (!statSync(cwd).isDirectory()) throw 0;
  } catch {
    throw new Error(`folder not found: ${cwd}`);
  }
  const sess = deck.sessions.get(body.herdr) ?? [...deck.sessions.values()].find((s) => s.online);
  if (!sess?.online) throw new Error("no herdr server running");
  const ws = body.workspaceId ?? sess.snap?.focused_workspace_id ?? null;
  const label = String(body.label ?? "").trim() || cwd.split("/").pop() || kind;
  const r = await call(sess.socket, "tab.create", { cwd, label, workspace_id: ws, focus: false });
  const paneId: string = r.root_pane?.pane_id;
  const key = `${sess.name}/${paneId}`;
  await deck.kick(sess.name);

  // The rest waits on a slow shell and the agent's own startup; report progress over SSE.
  (async () => {
    try {
      if (kind !== "shell") {
        notice({ key, ok: true, message: `Waiting for the shell in “${label}”…` });
        await waitForPrompt(sess.socket, paneId, 30_000);
        const base = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 24) || kind;
        const name = `${base}-${Math.random().toString(36).slice(2, 6)}`;
        const args = agentArgs(kind, body);
        notice({ key, ok: true, message: `Starting ${kind}…` });
        let asked = false;
        try { await call(sess.socket, "agent.start", { name, kind, pane_id: paneId, args, timeout_ms: 90_000 }, 95_000); }
        catch (e: any) {
          // The agent is up but opened on a question (Claude's "trust this folder?"): that's not a failure.
          if (!/blocked|interactive input/i.test(String(e?.message ?? e))) throw e;
          await deck.kick(sess.name);
          asked = true;
          notice({ key, ok: true, message: `“${label}” is asking something first. Answer it (in the list, Inbox or terminal)${String(body.prompt ?? "").trim() ? " and your message follows" : ""}.` });
        }
        const prompt = String(body.prompt ?? "").trim();
        if (prompt) {
          // A new folder can open on a prompt (Claude's "trust this folder?"), and herdr only registers the
          // agent a moment after it starts. Hold the message until the agent can take it: while it's asking
          // you something, wait (up to 10 minutes); otherwise keep retrying until herdr is ready.
          await deck.kick(sess.name);
          const until = Date.now() + 10 * 60_000;
          let told = asked;
          for (;;) {
            if (deck.rows.get(key)?.status === "blocked") {
              if (!told) { notice({ key, ok: true, message: `“${label}” is asking something first. Answer it (in the list, Inbox or terminal) and your message follows.` }); told = true; }
              if (Date.now() > until) throw new Error("it was still waiting for an answer after 10 minutes");
              await Bun.sleep(1500);
              continue;
            }
            try { await call(sess.socket, "agent.prompt", { target: paneId, text: prompt }, 15_000); break; }
            catch (e: any) {
              if (Date.now() > until || !/not an active|not found|not ready|no agent/i.test(String(e?.message ?? e))) throw e;
              await Bun.sleep(1000);
            }
          }
        }
        notice({ key, ok: true, message: prompt ? `${kind} is running and has your first message` : `${kind} is ready` });
      }
      if (body.focus) await call(sess.socket, "pane.focus", { pane_id: paneId });
    } catch (e: any) {
      notice({ key, ok: false, message: `Couldn’t start ${kind}: ${e?.message ?? e}` });
    }
    await deck.kick(sess.name);
  })();
  return { key, paneId };
}

async function sendText(key: string, text: string) {
  const f = deck.find(key);
  if (!f) throw new Error("that session is gone");
  if (["claude", "codex", "opencode"].includes(f.row.agent)) await call(f.sess.socket, "agent.prompt", { target: f.row.paneId, text });
  else await call(f.sess.socket, "pane.send_input", { pane_id: f.row.paneId, text, keys: ["enter"] });
}

/** Send to a session on any machine. */
async function sendAny(key: string, text: string) {
  const route = splitKey(key, remotes);
  if (route.remote) {
    const r = await route.remote.post("/api/send", { key: route.key, text });
    if (r.status >= 300) throw new Error(r.data?.error ?? "send failed");
  } else await sendText(key, text);
}

// ── queued messages: held by the hub, sent when the agent finishes its turn ─
type Queued = { id: string; text: string; at: number };
const QUEUE_FILE = `${DATA_DIR}/queue.json`;
let queues: Record<string, Queued[]> = {};
try { queues = JSON.parse(readFileSync(QUEUE_FILE, "utf8")); } catch {}
const saveQueues = () => { for (const k of Object.keys(queues)) if (!queues[k]?.length) delete queues[k]; try { writeFileSync(QUEUE_FILE, JSON.stringify(queues)); } catch {} broadcast("queue", queues); };
const quietSince = new Map<string, number>();
let draining = false;
setInterval(async () => {
  if (draining || !Object.keys(queues).length) return;
  draining = true;
  try {
    const rows = new Map(allRows().map((r) => [r.key, r]));
    for (const key of Object.keys(queues)) {
      const row = rows.get(key);
      if (!row || !queues[key]?.length) continue;
      if (row.status === "working" || row.status === "blocked") { quietSince.delete(key); continue; }
      if (!quietSince.has(key)) quietSince.set(key, Date.now());
      if (Date.now() - quietSince.get(key)! < 2500) continue; // quiet for a moment: the turn really ended
      const item = queues[key].shift()!;
      saveQueues();
      try {
        await sendAny(key, item.text);
        quietSince.set(key, Date.now() + 12_000); // give it time to start before the next one
        broadcast("notice", { key, ok: true, message: `Sent your queued message to “${row.title}”` });
      } catch (e: any) {
        queues[key] = [item, ...(queues[key] ?? [])];
        saveQueues();
        broadcast("notice", { key, ok: false, message: `Couldn’t send the queued message: ${e?.message ?? e}` });
      }
    }
  } finally { draining = false; }
}, 1000);

// ── tools ────────────────────────────────────────────────────────────────
function resolveTool(body: any): Tool | undefined {
  if (body.tool && typeof body.tool === "object") return body.tool as Tool; // a hub already resolved it
  return loadTools().find((t) => t.id === body.id);
}

/** Waits for the agent to take the message and finish its turn (sequences: handoff, then compact). */
async function afterTurn(key: string, timeoutMs = 20 * 60_000) {
  const t0 = Date.now();
  let started = false;
  while (Date.now() - t0 < timeoutMs) {
    await Bun.sleep(1500);
    const r = deck.rows.get(key);
    if (!r) return false;
    if (r.status === "working" || r.status === "blocked") started = true;
    else if (started || Date.now() - t0 > 20_000) return true;
  }
  return false;
}

async function runToolLocal(tool: Tool, keys: string[], extra: Record<string, string> = {}) {
  const results: any[] = [];
  for (const key of keys.slice(0, 50)) {
    const row = deck.rows.get(key);
    if (!row) { results.push({ key, ok: false, error: "gone" }); continue; }
    if (tool.agents && !tool.agents.includes(row.agent)) { results.push({ key, ok: false, error: `not for ${row.agent}` }); continue; }
    try {
      await sendText(key, fillTool(tool.prompt ?? "", row, extra));
      if (tool.kind === "sequence" && tool.then) {
        const then = row.agent === "claude" ? fillTool(tool.then, row, extra) : "/compact"; // only Claude's /compact takes instructions
        (async () => {
          if (await afterTurn(key)) { await sendText(key, then).catch(() => {}); notice({ key, ok: true, message: `${tool.label}: step 2 sent` }); }
          else notice({ key, ok: false, message: `${tool.label}: the agent didn’t finish step 1, so step 2 wasn’t sent` });
        })();
      }
      results.push({ key, ok: true });
    } catch (e: any) { results.push({ key, ok: false, error: e?.message ?? String(e) }); }
  }
  return results;
}

/** "Related past work": the history index, searched for this session's project, handed to the agent. */
async function relatedFor(row: Row) {
  const q = [row.project, ...(row.title ?? "").split(/\s+/).filter((w) => w.length > 4).slice(0, 3)].join(" ");
  const byProject = await historyEverywhere({ project: row.project, limit: 12 });
  const byWords = await historyEverywhere({ q: row.title ?? row.project, limit: 8 });
  const seen = new Set<string>();
  const list = [...byProject, ...byWords].filter((h) => h.id !== row.sessionId && !seen.has(h.key) && seen.add(h.key)).slice(0, 12);
  if (!list.length) return { text: "", n: 0 };
  const lines = list.map((h) => `- ${new Date(h.last ?? 0).toISOString().slice(0, 10)} · ${h.agent} · ${h.title}${h.machine && h.machine !== SELF.id ? ` (on ${h.machine})` : ""}\n  transcript: ${h.file}${h.hit ? `\n  match: ${h.hit.snippet.replace(/[\u0002\u0003]/g, "")}` : ""}`);
  return { n: list.length, q, text: `Context from my past sessions on this project (newest first). Skim the ones that look relevant (they are JSONL transcripts; grep them rather than reading whole files) and tell me in 3 bullets what's useful for the current task, then continue:\n\n${lines.join("\n")}` };
}

type HistHit = HistSession & { machine?: string };
async function historyEverywhere(o: { q?: string; project?: string; agent?: string; limit?: number; before?: number }): Promise<HistHit[]> {
  const live = new Set([...deck.rows.values()].map((r) => r.sessionId).filter(Boolean) as string[]);
  const local = searchHistory({ ...o, exclude: live }).sessions.map((h) => ({ ...h, machine: SELF.id }));
  const remote = await Promise.all([...remotes.values()].filter((h) => h.online).map((h) =>
    Promise.race([h.post("/api/history", { ...o, local: true }).then((r) => (r.data.sessions ?? []).map((x: any) => ({ ...x, key: `${h.conf.id}|${x.key}`, machine: h.conf.id }))), Bun.sleep(2000).then(() => [])]).catch(() => [])));
  const all = [...local, ...remote.flat()];
  if (o.q) return all.sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0) || (b.last ?? 0) - (a.last ?? 0)).slice(0, o.limit ?? 60);
  return all.sort((a, b) => (b.last ?? 0) - (a.last ?? 0)).slice(0, o.limit ?? 60);
}

const UPLOAD_DIR = `${homedir()}/.cache/herdr-deck/uploads`;
async function saveUpload(req: Request, name: string) {
  const safe = name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(-120) || "file";
  const d = new Date();
  const dir = `${UPLOAD_DIR}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${Date.now().toString(36)}-${safe}`;
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > 100 * 1024 * 1024) throw new Error("Files up to 100 MB");
  await Bun.write(path, buf);
  return { path, size: buf.length, name: safe };
}

/**
 * Actions on another machine's sessions go to that machine's deck. Briefs are the exception:
 * the hub writes them with its own local model from the node's conversation detail.
 */
async function forwardToMachine(path: string, body: any): Promise<Response | undefined> {
  if (path.startsWith("/api/push/") || path === "/api/automations" || path.startsWith("/api/dev/")) return;
  if (path === "/api/queue" || path === "/api/machines" || path === "/api/decide" || path === "/api/tool" || path === "/api/history" || path === "/api/connections" || path === "/api/suggest-projects" || path === "/api/mcp-info") return;
  const proxy = async (remote: RemoteHost, payload: unknown) => {
    const r = await remote.post(path, payload);
    return json(r.data, r.status);
  };
  if (path === "/api/close" && Array.isArray(body.keys)) {
    const groups = new Map<RemoteHost | undefined, string[]>();
    for (const k of body.keys) { const r = splitKey(k, remotes); groups.set(r.remote, [...(groups.get(r.remote) ?? []), r.key]); }
    if (![...groups.keys()].some(Boolean)) return;
    const results: any[] = [];
    for (const [remote, keys] of groups) {
      if (!remote) { results.push(...(await closeLocal(keys, !!body.wholeTab))); continue; }
      try {
        const r = await remote.post(path, { ...body, keys });
        results.push(...(r.data.results ?? []).map((x: any) => ({ ...x, key: `${remote.conf.id}|${x.key}` })));
      } catch (e: any) { results.push(...keys.map((k) => ({ key: `${remote.conf.id}|${k}`, ok: false, error: e?.message }))); }
    }
    return json({ results });
  }
  if (path === "/api/new" || path === "/api/new-options") {
    const remote = body.machine && body.machine !== SELF.id ? remotes.get(body.machine) : undefined;
    if (!remote) return;
    const r = await remote.post(path, { ...body, machine: undefined });
    if (path === "/api/new" && r.data?.key) r.data.key = `${remote.conf.id}|${r.data.key}`;
    return json(r.data, r.status);
  }
  if (path === "/api/reopen" || path === "/api/forget") {
    const r = splitKey(body.id, remotes);
    return r.remote ? proxy(r.remote, { ...body, id: r.key }) : undefined;
  }
  if (!body.key) return;
  const route = splitKey(body.key, remotes);
  if (!route.remote) return;
  if (path === "/api/brief") {
    const row = route.remote.rows.get(body.key);
    const d = (await route.remote.post("/api/detail", { key: route.key })).data;
    if (!row || !d?.turns?.length) return json({ error: "This pane has no conversation to summarise" }, 400);
    const detail: Detail = { gen: 0, messages: [], touch: new Map(), started: d.started, recap: d.recap, turns: d.turns, images: [], compactions: d.compactions ?? 0, asks: d.asks ?? d.turns.length, startedAt: d.startedAt };
    return json({ brief: await writeBrief(briefKey(row), row.title, row.project, detail) });
  }
  if (path === "/api/detail") {
    const row = route.remote.rows.get(body.key);
    const r = await route.remote.post(path, { key: route.key });
    const brief = row?.sessionId ? cachedBrief(briefKey(row)) : undefined;
    return json({ ...r.data, brief, briefStale: !!brief && brief.asks !== r.data?.asks }, r.status);
  }
  return proxy(route.remote, { ...body, key: route.key });
}

async function closeLocal(keys: string[], wholeTab: boolean) {
  const results = [];
  for (const k of keys) results.push(await closeRow(k, wholeTab));
  saveGraves();
  broadcastGraves();
  for (const h of new Set(keys.map((k) => k.split("/")[0]))) await deck.kick(h);
  return results;
}

// ── MCP: what other agents can do through the deck ─────────────────────────
const MCP_TOKEN = mcpToken();
const brief = (r: Row) => ({
  key: r.key, title: r.title, project: r.project, machine: machineLabelOf(r.machine), agent: r.agent, status: r.status, needs_you: needsYou(r),
  now: r.step ?? r.now, last_active: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : undefined, branch: r.branch, uncommitted: r.dirty,
  last_message: r.lastMessage?.slice(0, 240), servers: r.ports?.map((p) => p.url ?? `localhost:${p.port}`),
});
const machineLabelOf = (id?: string) => machines().find((m) => m.id === id)?.label ?? id;
const fmtMsgs = (msgs: any[]) => msgs.map((m) => m.role === "tool" ? `  [tool] ${m.tool}: ${m.summary ?? ""}` : `${m.role === "user" ? "USER" : m.role === "assistant" ? "AGENT" : m.role.toUpperCase()}${m.at ? ` (${new Date(m.at).toISOString().slice(0, 16)})` : ""}: ${String(m.text ?? "").slice(0, 1500)}`).join("\n");
const mcpCtx: McpCtx = {
  sessions: (f) => {
    const q = String(f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return allRows()
      .filter((r) => !f.status || (f.status === "needs_you" ? needsYou(r) : r.status === f.status))
      .filter((r) => !f.machine || r.machine === f.machine || machineLabelOf(r.machine)?.toLowerCase() === String(f.machine).toLowerCase())
      .filter((r) => !f.project || r.project.toLowerCase() === String(f.project).toLowerCase())
      .filter((r) => !q.length || q.every((w) => `${r.title} ${r.project} ${r.branch ?? ""} ${r.lastMessage ?? ""}`.toLowerCase().includes(w)))
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)).slice(0, Math.min(Number(f.limit) || 60, 200)).map(brief);
  },
  session: async (key, n) => {
    const route = splitKey(key, remotes);
    const row = allRows().find((r) => r.key === key) ?? (route.remote ? (await route.remote.post("/api/history-row", { key: route.key })).data?.row : localRow(key));
    if (!row) throw new Error(`no session ${key}`);
    const chat = route.remote ? (await route.remote.post("/api/chat", { key: route.key, limit: n })).data : await (async () => { const d = await detailFor(row); return d ? { messages: d.messages.slice(-n) } : { messages: [] }; })();
    return `${JSON.stringify({ ...brief(row), first_request: row.firstPrompt?.slice(0, 1500), cwd: row.cwd }, null, 1)}\n\nLast ${chat.messages?.length ?? 0} messages:\n${fmtMsgs(chat.messages ?? [])}`;
  },
  search: async (q, history, limit) => {
    const live = await searchLocal(q);
    const remoteLive = (await Promise.all([...remotes.values()].filter((h) => h.online).map((h) => h.post("/api/search", { q, local: true }).then((r) => (r.data.hits ?? []).map((x: any) => ({ ...x, key: `${h.conf.id}|${x.key}` }))).catch(() => [])))).flat();
    const rows = new Map(allRows().map((r) => [r.key, r]));
    const out: any = { live: [...live, ...remoteLive].slice(0, limit).map((h) => ({ key: h.key, title: rows.get(h.key)?.title, project: rows.get(h.key)?.project, matches: h.count, snippet: h.snippet })) };
    if (history) out.past = (await historyEverywhere({ q, limit })).map((h) => ({ key: h.key, title: h.title, project: h.project, agent: h.agent, machine: h.machine, last: h.last ? new Date(h.last).toISOString().slice(0, 10) : undefined, matches: h.hits, snippet: h.hit?.snippet.replace(/[\u0002\u0003]/g, "") }));
    return out;
  },
  history: async (f) => (await historyEverywhere({ q: f.query, project: f.project, agent: f.agent, limit: Math.min(Number(f.limit) || 30, 100) })).map((h) => ({ key: h.key, title: h.title, project: h.project, agent: h.agent, machine: h.machine, started: h.started ? new Date(h.started).toISOString().slice(0, 10) : undefined, last: h.last ? new Date(h.last).toISOString().slice(0, 10) : undefined, requests: h.asks, cwd: h.cwd })),
  decisions: async () => [...decisions.values()].map((d) => ({ ...d, session: brief(allRows().find((r) => r.key === d.key)!) })),
  connections: async (machine) => {
    if (machine && machine !== SELF.id) { const r = remotes.get(machine); if (!r) throw new Error("unknown machine"); return inventoryText((await r.post("/api/connections", {})).data); }
    return inventoryText(await inventory());
  },
  send: async (key, text) => {
    const route = splitKey(key, remotes);
    if (route.remote) { const r = await route.remote.post("/api/send", { key: route.key, text }); if (r.status >= 300) throw new Error(r.data?.error ?? "send failed"); }
    else await sendText(key, text);
    notice({ key, ok: true, message: `An agent sent this session a message via MCP: “${text.slice(0, 80)}${text.length > 80 ? "…" : ""}”` });
    return { ok: true };
  },
  start: async (o) => {
    if (!["claude", "codex", "opencode"].includes(o.agent)) throw new Error("agent must be claude, codex or opencode");
    const body = { kind: o.agent, cwd: o.cwd, prompt: o.prompt, model: o.model, effort: o.effort, label: o.label }; // no mode/args: normal permissions only
    const remote = o.machine && o.machine !== SELF.id ? [...remotes.values()].find((h) => h.conf.id === o.machine || h.conf.label.toLowerCase() === String(o.machine).toLowerCase()) : undefined;
    const r = remote ? { ...(await remote.post("/api/new", body)).data } : await startSession(body);
    notice({ key: r.key, ok: true, message: `An agent started a ${o.agent} session via MCP in ${o.cwd}` });
    return r;
  },
  audit: (e) => { appendAudit(e); broadcast("audit", readAudit(30)); },
  library: async (q, k) => (await library.evidence(q, k, "research")).text,
};

const DAY = "public, max-age=86400";
const STATIC: Record<string, [string, string]> = {
  "/manifest.webmanifest": ["application/manifest+json", DAY],
  "/icon.svg": ["image/svg+xml", DAY],
  "/icon-180.png": ["image/png", DAY],
  "/icon-192.png": ["image/png", DAY],
  "/icon-512.png": ["image/png", DAY],
  "/icon-maskable-512.png": ["image/png", DAY],
  "/offline.html": ["text/html; charset=utf-8", "no-cache"],
  "/sw.js": ["text/javascript; charset=utf-8", "no-cache"],
};

const json = (data: unknown, status = 200) => Response.json(data, { status });

// Remote access goes through `tailscale serve`, which proxies tailnet HTTPS to this loopback port and
// stamps each request with the caller's Tailscale login. Only the machine owner's login (or DECK_TS_USERS) is let in.
const tsUsers = new Set((process.env.DECK_TS_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
if (!tsUsers.size) {
  try {
    const bin = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => existsSync(p));
    if (bin) {
      const st = JSON.parse(Bun.spawnSync([bin, "status", "--json"], { stderr: "ignore" }).stdout.toString());
      const login = st.User?.[String(st.Self?.UserID)]?.LoginName;
      if (login) tsUsers.add(login);
    }
  } catch {}
}

const hasApiToken = (req: Request) => req.headers.get("authorization") === `Bearer ${API_TOKEN}`;

function allowedHost(req: Request) {
  if (hasApiToken(req)) { hubSeenAt = Date.now(); return true; }
  const host = req.headers.get("host") ?? "";
  if (host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`) return true;
  // A cross-site page can't add this header without a CORS preflight, which is never answered.
  const tsLogin = req.headers.get("tailscale-user-login");
  if (tsLogin && tsUsers.has(tsLogin)) return true;
  return HOST !== "127.0.0.1" && !!process.env.DECK_ALLOW_ANY_HOST;
}

/** JSON replies (detail, chat, terminal reads) compress well; streams and binaries pass through. */
async function gzipJson(req: Request, res: Response): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json") || res.headers.get("content-encoding")) return res;
  if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 1400) return new Response(bytes, { status: res.status, headers: res.headers });
  const headers = new Headers(res.headers);
  headers.set("content-encoding", "gzip");
  headers.set("vary", "accept-encoding");
  return new Response(Bun.gzipSync(bytes, { level: 4 }), { status: res.status, headers });
}

const serveOptions = {
  hostname: HOST,
  port: PORT,
  idleTimeout: 0,
  async fetch(req: Request) {
    return gzipJson(req, await handle(req));
  },
};

async function handle(req: Request): Promise<Response> {
    // Host check blocks DNS-rebinding; the token blocks cross-site POSTs.
    if (!allowedHost(req)) return new Response("forbidden host", { status: 403 });
    const url = new URL(req.url);
    const cover = await covers.route(req, url, req.headers.get("x-deck-token") === TOKEN || hasApiToken(req));
    if (cover) return cover;

    if (req.method === "GET") {
      // "/" and every session link (/s/<machine>/<agent>/<session id>) serve the same page; the page resolves the link.
      if (url.pathname === "/" || url.pathname.startsWith("/s/") || url.pathname === "/p" || url.pathname.startsWith("/p/")) return send(req, page(), "text/html; charset=utf-8");
      { const a = assets.serve(req, url); if (a) return a; }
      if (url.pathname === "/events") {
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            clients.add(c);
            c.enqueue(sse("full", fullState()));
          },
          cancel() { clients.delete(ctrl); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
      }
      if (url.pathname.startsWith("/fonts/") && /^\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) {
        const f = Bun.file(new URL(`../public${url.pathname}`, import.meta.url).pathname);
        if (await f.exists()) return new Response(f, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
      }
      const asset = STATIC[url.pathname];
      if (asset) {
        return new Response(Bun.file(new URL(`../public${url.pathname}`, import.meta.url).pathname), {
          headers: { "content-type": asset[0], "cache-control": asset[1], ...(url.pathname === "/sw.js" ? { "service-worker-allowed": "/" } : {}) },
        });
      }
      if (url.pathname === "/api/image") {
        // <img> can't send headers, so the token rides in the query string.
        if (url.searchParams.get("t") !== TOKEN && !hasApiToken(req)) return new Response("forbidden", { status: 403 });
        const route = splitKey(url.searchParams.get("key") ?? "", remotes);
        if (route.remote) {
          const q = new URLSearchParams({ key: route.key, id: url.searchParams.get("id") ?? "", sub: url.searchParams.get("sub") ?? "" });
          const res = await route.remote.get(`/api/image?${q}`).catch(() => null);
          if (!res?.ok) return new Response("image not found", { status: 404 });
          return new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "image/png", "cache-control": "private, max-age=86400" } });
        }
        const lr = localRow(route.key);
        const img = lr && (await imageFor(lr, url.searchParams.get("id") ?? "", url.searchParams.get("sub") || undefined).catch(() => undefined));
        if (!img) return new Response("image not found", { status: 404 });
        return new Response(img.data, { headers: { "content-type": img.type, "cache-control": "private, max-age=86400" } });
      }
      if (url.pathname === "/api/file-raw") {
        if (url.searchParams.get("t") !== TOKEN && !hasApiToken(req)) return new Response("forbidden", { status: 403 });
        const route = splitKey(url.searchParams.get("key") ?? "", remotes);
        if (route.remote) {
          const res = await route.remote.get(`/api/file-raw?${new URLSearchParams({ key: route.key, path: url.searchParams.get("path") ?? "" })}`).catch(() => null);
          return res?.ok ? new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream", "cache-control": "private, max-age=300" } }) : new Response("not found", { status: 404 });
        }
        const p = resolveSafe(localRow(route.key)?.cwd, url.searchParams.get("path") ?? "");
        const f = p && Bun.file(p);
        if (!f || !(await f.exists())) return new Response("not found", { status: 404 });
        return new Response(f, { headers: { "cache-control": "private, max-age=300" } });
      }
      if (url.pathname === "/api/push/key") return json({ key: push.vapid.publicKey, node: isNode() });
      if (url.pathname === "/health") return json({ ok: true, clients: clients.size, ...deck.health(), machines: machines().map(({ herdr, ...m }) => m) });
      return new Response("not found", { status: 404 });
    }

    if (url.pathname === "/mcp") {
      if (req.headers.get("authorization") !== `Bearer ${MCP_TOKEN}`) return new Response("unauthorized", { status: 401 });
      if (req.method === "GET") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const msg: any = await req.json().catch(() => null);
      if (!msg) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
      if (Array.isArray(msg)) { const out = (await Promise.all(msg.map((m) => handleMcp(m, mcpCtx)))).filter(Boolean); return out.length ? json(out) : new Response(null, { status: 202 }); }
      const out = await handleMcp(msg, mcpCtx);
      return out ? json(out) : new Response(null, { status: 202 });
    }
    if (req.method !== "POST" || (req.headers.get("x-deck-token") !== TOKEN && !hasApiToken(req))) return new Response("forbidden", { status: 403 });
    if (url.pathname === "/api/upload") {
      // Raw body; the file lands on the machine where the session runs, and the agent gets its path.
      const key = url.searchParams.get("key") ?? "";
      const name = url.searchParams.get("name") ?? "file";
      try {
        const route = splitKey(key, remotes);
        if (route.remote) {
          const r = await route.remote.raw(`/api/upload?${new URLSearchParams({ key: route.key, name })}`, new Uint8Array(await req.arrayBuffer()));
          return json(r.data, r.status);
        }
        return json(await saveUpload(req, name));
      } catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); }
    }
    const body: any = await req.json().catch(() => ({}));
    try {
      // An answer typed in the reply box or pressed in the terminal answers the decision on screen too:
      // record it for Jev before the input goes anywhere (the inbox's own /api/decide then finds it done).
      if ((url.pathname === "/api/send" || url.pathname === "/api/keys") && body.key) {
        const d = decisions.get(String(body.key));
        const choice = d && choiceFromInput(d, { text: body.text, keys: body.keys });
        if (d && choice) recordOutcome(d.key, choice === "other" ? "reply" : "answer", choice, d);
      }
      if (url.pathname.startsWith("/api/opportunities")) { const d = await opportunities.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/discover")) { const d = await discover.handle(url.pathname, body); if (d !== undefined) return covers.respond(d); }
      if (url.pathname.startsWith("/api/ideas")) { const d = await gallery.handle(url.pathname, body); if (d !== undefined) return covers.respond(d); }
      if (url.pathname.startsWith("/api/library/")) { const d = await library.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/leads")) { const d = await leads.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/research")) { const d = await research.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/journey")) { const d = await journeys.handle(url.pathname, body); if (d !== undefined) return json(d); }
      { const g = await game.route(url.pathname, body); if (g) return json(g.data, g.status); }
      const forwarded = await forwardToMachine(url.pathname, body);
      if (forwarded) return forwarded;
      switch (url.pathname) {
        case "/api/push/key":
          return json({ key: push.vapid.publicKey, node: isNode(), devices: push.list() });
        case "/api/push/subscribe": {
          if (isNode()) return json({ error: "This machine is a node: its sessions already reach you through the hub. Turn notifications on in the hub’s deck." }, 409);
          const sub = body.subscription ?? {};
          const id = String(body.id ?? "").replace(/[^\w-]/g, "").slice(0, 64);
          if (!id) return json({ error: "missing device id" }, 400);
          if (!endpointOk(String(sub.endpoint ?? ""), DEV)) return json({ error: "That isn’t a push service address" }, 400);
          if (!sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "The subscription has no encryption keys" }, 400);
          const dev = push.upsert({ id, endpoint: String(sub.endpoint), keys: sub.keys, label: body.label, prefs: body.prefs });
          return json({ ok: true, device: push.list().find((d) => d.id === dev.id), devices: push.list() });
        }
        case "/api/push/unsubscribe":
          push.remove({ id: body.id ? String(body.id) : undefined, endpoint: body.endpoint ? String(body.endpoint) : undefined });
          return json({ ok: true, devices: push.list() });
        case "/api/push/test": {
          const dev = push.devices.find((d) => d.id === String(body.id ?? ""));
          if (!dev) return json({ error: "This device isn’t subscribed" }, 404);
          const m: Message = { kind: "test", title: "herdr deck", body: `Push works on “${dev.label}”. ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, tag: "test", url: body.url ? String(body.url).slice(0, 300) : "/" };
          const r = await push.deliver(m, { only: dev.id, ttl: 600, urgency: "high" });
          const res = r.results[0];
          return json({ ok: !!res?.ok, error: res?.error, dropped: r.dropped, devices: push.list() }, res?.ok ? 200 : 502);
        }
        case "/api/push/presence": {
          const page = String(body.page ?? "").slice(0, 64);
          if (!page) return json({ ok: false }, 400);
          if (body.visible === false || !body.key) presence.set(page, { key: null, at: Date.now() });
          else presence.set(page, { key: String(body.key), at: Date.now() });
          for (const [k, v] of presence) if (Date.now() - v.at > 10 * 60_000) presence.delete(k);
          return json({ ok: true });
        }
        case "/api/automations": {
          if (!auto) return json({ error: "starting up" }, 503);
          if (body.op === "set") auto.setRules(body.rules ?? {});
          else if (body.op === "digest") await auto.runDigest(!!body.push);
          else if (body.op === "dismiss-digest") auto.dismissDigest();
          else if (body.op === "tick") await auto.tick();
          return json({ ...auto.publicState(), node: isNode(), devices: push.list() });
        }
        case "/api/dev/fake-rows": {
          // DECK_DEV only: rows that exist nowhere but here, so the automations can be driven end to end.
          if (!DEV) return json({ error: "dev only" }, 403);
          const remove = [...fakeRows.keys()];
          if (body.clear) fakeRows.clear();
          for (const r of body.rows ?? []) fakeRows.set(String(r.key), { machine: "fake", herdr: "fake", workspaceId: "fake", workspace: "Fake", tabId: String(r.key), tab: "", tabNumber: 0, tabPanes: 1, paneId: String(r.key), agent: "claude", status: "idle", focused: false, title: "fake", cwd: "/tmp", project: "fake", rssKB: 0, cpu: 0, procs: 0, tail: [], empty: false, stale: false, duplicate: false, approx: false, ...r } as Row);
          broadcast("patch", { upsert: [...fakeRows.values()], remove: remove.filter((k) => !fakeRows.has(k)), summary: summary() });
          auto?.observe();
          return json({ ok: true, rows: fakeRows.size });
        }
        case "/api/history": {
          if (body.local) {
            const live = new Set([...deck.rows.values()].map((r) => r.sessionId).filter(Boolean) as string[]);
            return json({ ...searchHistory({ q: body.q, project: body.project, agent: body.agent, before: body.before, limit: body.limit, exclude: live }), stats: historyStats() });
          }
          const sessions = await historyEverywhere({ q: body.q, project: body.project, agent: body.agent, before: body.before, limit: body.limit ?? 80 });
          const machine = body.machine && body.machine !== "all" ? body.machine : undefined;
          return json({ sessions: machine ? sessions.filter((h) => h.machine === machine) : sessions, stats: historyStats(), projects: historyProjects().slice(0, 80) });
        }
        case "/api/history-row": {
          // A past session as a row the page can open (chat, images, resume).
          return json({ row: localRow(String(body.key)) ?? null });
        }
        case "/api/history-resume": {
          const h = historySession(String(body.key));
          if (!h) return json({ error: "not in the history index" }, 404);
          if (!h.cwd || !existsSync(h.cwd)) return json({ error: `its folder is gone: ${h.cwd}` }, 400);
          return json(await startSession({ kind: h.agent, cwd: h.cwd, args: h.agent === "claude" ? ["--resume", h.id] : ["resume", h.id], label: h.title.slice(0, 40), focus: !!body.focus }));
        }
        case "/api/history-rescan":
          rescanHistory();
          return json({ ok: true });
        case "/api/tools":
          return json({ tools: saveCustomTools(body.tools ?? []) });
        case "/api/tool": {
          const tool = resolveTool(body);
          if (!tool) return json({ error: "unknown tool" }, 400);
          const keys: string[] = (body.keys ?? []).slice(0, 50);
          if (tool.action === "related") {
            const results: any[] = [];
            for (const key of keys) {
              const row = allRows().find((r) => r.key === key);
              if (!row) { results.push({ key, ok: false, error: "gone" }); continue; }
              const rel = await relatedFor(row);
              if (!rel.n) { results.push({ key, ok: false, error: "No past sessions found for this project" }); continue; }
              const route = splitKey(key, remotes);
              try {
                if (route.remote) await route.remote.post("/api/send", { key: route.key, text: rel.text });
                else await sendText(key, rel.text);
                results.push({ key, ok: true, n: rel.n });
              } catch (e: any) { results.push({ key, ok: false, error: e?.message }); }
            }
            return json({ results });
          }
          const groups = new Map<RemoteHost | undefined, string[]>();
          for (const k of keys) { const r = splitKey(k, remotes); groups.set(r.remote, [...(groups.get(r.remote) ?? []), r.key]); }
          const results: any[] = [];
          for (const [remote, ks] of groups) {
            if (!remote) { results.push(...(await runToolLocal(tool, ks))); continue; }
            try {
              const r = await remote.post("/api/tool", { tool, keys: ks });
              results.push(...(r.data.results ?? []).map((x: any) => ({ ...x, key: `${remote.conf.id}|${x.key}` })));
            } catch (e: any) { results.push(...ks.map((k) => ({ key: `${remote.conf.id}|${k}`, ok: false, error: e?.message }))); }
          }
          return json({ results });
        }
        case "/api/share": {
          const row = deck.rows.get(body.key);
          if (!row) return json({ error: "gone" }, 404);
          const port = Number(body.port) || row.ports?.[0]?.port;
          if (!port) return json({ error: "This session isn’t running a server the deck can see. Ask it to start one (the “Show me what you built” tool does)." }, 400);
          if (body.off) { await unshare(port); await refreshShared(); return json({ ok: true }); }
          const addr = row.ports?.find((p) => p.port === port)?.addr ?? "127.0.0.1";
          const url = await share(port, addr);
          await refreshShared();
          return json({ ok: true, url, port });
        }
        case "/api/verify": {
          const row = deck.rows.get(body.key);
          if (!row?.projectRoot) return json({ error: "This session has no project folder to check" }, 400);
          if (body.approve !== undefined) setApproval(row.projectRoot, String(body.cmd ?? approvalFor(row.projectRoot)?.cmd ?? detectCheck(row.projectRoot) ?? ""), !!body.approve);
          const r = body.approve === false ? resultFor(row.projectRoot) : await verify(row.projectRoot, { force: !!body.force });
          if (r) { deck.checks.set(row.projectRoot, r); deck.refresh(); }
          return json({ ok: true, check: r, detected: detectCheck(row.projectRoot), approval: approvalFor(row.projectRoot) });
        }
        case "/api/connections": {
          if (body.machine && body.machine !== SELF.id) {
            const remote = remotes.get(body.machine);
            if (!remote) return json({ error: "unknown machine" }, 404);
            const r = await remote.post("/api/connections", { refresh: body.refresh });
            return json(r.data?.sections ? enrich(r.data) : r.data, r.status);
          }
          return json(enrich(await inventory(!!body.refresh)));
        }
        case "/api/recipes": {
          // The store's recipes, ranked by what the chosen machine has. Yours live on the hub.
          const m = body.machine && body.machine !== SELF.id ? String(body.machine) : SELF.id;
          const inv = await (async () => {
            if (m === SELF.id) return inventory();
            const remote = remotes.get(m);
            if (!remote?.online) return undefined;
            try { const r = await remote.post("/api/connections", {}); return r.data?.sections ? r.data : undefined; } catch { return undefined; }
          })();
          try {
            if (body.op === "save") saveCustom(body.recipe);
            else if (body.op === "delete") deleteCustom(String(body.id ?? ""));
            else if (body.op === "prompt") {
              const r = allRecipes().find((x) => x.id === body.id);
              if (!r) return json({ error: "No such recipe" }, 404);
              const picked = (Array.isArray(body.picked) ? body.picked : []).map(String).slice(0, 200);
              const own = recipeIds(r, inv);
              const extra = picked.filter((x: string) => !own.includes(x));
              const connections = inv ? inventoryText(inv, new Set(own)) : "";
              const selected = inv && extra.length ? inventoryText(inv, new Set(extra)).split("\n").slice(3).join("\n").trim() : "";
              return json({ prompt: fillPrompt(r, { connections, machine: inv?.machine ?? m, selected }), folder: r.folder ?? "", agent: r.agent ?? "claude", machine: r.machine ?? "hub", title: r.title });
            }
          } catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); }
          return json({ machine: m, reachable: !!inv, recipes: rankRecipes(allRecipes(), inv) });
        }
        case "/api/connections-conf": {
          if (body.machine && body.machine !== SELF.id) {
            const remote = remotes.get(body.machine);
            if (!remote) return json({ error: "unknown machine" }, 404);
            const r = await remote.post("/api/connections-conf", { ...body, machine: undefined });
            return json(r.data?.sections ? enrich(r.data) : r.data, r.status);
          }
          const c = loadConnConf();
          const id = String(body.id ?? "");
          if (body.op === "hide") c.hidden = [...new Set([...c.hidden, id])];
          else if (body.op === "unhide") c.hidden = c.hidden.filter((x) => x !== id);
          else if (body.op === "note") { const t = String(body.text ?? "").trim().slice(0, 1000); if (t) c.notes[id] = t; else delete c.notes[id]; }
          else if (body.op === "add") {
            const it = body.item ?? {};
            const name = String(it.name ?? "").trim().slice(0, 80);
            if (!name) return json({ error: "A name is required" }, 400);
            const item: ConnItem = { id: `custom:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name, kind: "custom", status: "ready", detail: String(it.detail ?? "").slice(0, 200), use: String(it.use ?? "").slice(0, 1000), via: String(it.via ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6), ...(CATEGORIES.some((x) => x.id === it.cat) ? { cat: it.cat } : {}) };
            c.custom = [...c.custom.filter((x) => x.id !== item.id), item];
          } else if (body.op === "remove") c.custom = c.custom.filter((x) => x.id !== id);
          else if (body.op === "account") { try { c.accounts = upsertAccount(c.accounts, body.account); } catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); } }
          else if (body.op === "unaccount") c.accounts = c.accounts.filter((x) => x.id !== id);
          else return json({ error: "unknown op" }, 400);
          saveConnConf(c);
          return json(enrich(await inventory(true)));
        }
        case "/api/connections-text": {
          const inv = body.machine && body.machine !== SELF.id
            ? (await (remotes.get(body.machine) ?? { post: async () => ({ data: null }) } as any).post("/api/connections", {})).data
            : await inventory();
          if (!inv?.sections) return json({ error: "That machine isn’t reachable" }, 502);
          const ids = Array.isArray(body.ids) && body.ids.length ? new Set<string>(body.ids.map(String)) : undefined;
          const text = inventoryText(inv, ids);
          return json({ text, file: inv.file });
        }
        case "/api/queue": {
          const key = String(body.key ?? "");
          const q = (queues[key] ??= []);
          if (body.op === "add") {
            const text = String(body.text ?? "").trim();
            if (!text) return json({ error: "empty" }, 400);
            q.push({ id: crypto.randomUUID().slice(0, 8), text: text.slice(0, 200_000), at: Date.now() });
          } else if (body.op === "remove") queues[key] = q.filter((x) => x.id !== body.id);
          else if (body.op === "update") { const it = q.find((x) => x.id === body.id); if (it) it.text = String(body.text ?? it.text).trim() || it.text; }
          else if (body.op === "now") {
            const it = q.find((x) => x.id === body.id);
            if (it) { queues[key] = q.filter((x) => x !== it); saveQueues(); await sendAny(key, it.text); return json({ ok: true, queue: queues[key] ?? [] }); }
          } else if (body.op === "clear") delete queues[key];
          saveQueues();
          return json({ ok: true, queue: queues[key] ?? [] });
        }
        case "/api/machines": {
          if (body.op === "add") {
            const ssh = String(body.ssh ?? "").trim();
            if (!/^[\w.@-]+$/.test(ssh)) return json({ error: "Use an SSH host from your ~/.ssh/config, like my-server or me@host" }, 400);
            const label = String(body.label ?? "").trim().slice(0, 40) || ssh;
            const id = (String(body.id ?? "") || label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "machine";
            if (id === SELF.id || remotes.has(id)) return json({ error: `There's already a machine called “${id}”` }, 400);
            const p = Bun.spawn([`${import.meta.dir}/../bin/deploy-node.sh`, ssh], { stdout: "pipe", stderr: "pipe" });
            const timer = setTimeout(() => p.kill(9), 240_000);
            const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
            await p.exited;
            clearTimeout(timer);
            if (p.exitCode !== 0) return json({ error: (err || out).trim().split("\n").slice(-4).join("\n") || `install failed (exit ${p.exitCode})` }, 500);
            const host = addRemote({ id, label, ssh });
            saveHosts();
            host?.start();
            broadcast("full", fullState());
            return json({ ok: true, id, log: out.trim().split("\n").slice(-3).join("\n") });
          }
          if (body.op === "remove") {
            const h = remotes.get(String(body.id));
            if (!h) return json({ error: "unknown machine" }, 404);
            h.stop();
            remotes.delete(h.conf.id);
            saveHosts();
            broadcast("full", fullState());
            return json({ ok: true });
          }
          if (body.op === "rename") {
            const h = remotes.get(String(body.id));
            const label = String(body.label ?? "").trim().slice(0, 40);
            if (!h || !label) return json({ error: "unknown machine" }, 404);
            (h.conf as any).label = label;
            saveHosts();
            broadcast("full", fullState());
            return json({ ok: true });
          }
          const sshHosts = [...(existsSync(`${homedir()}/.ssh/config`) ? readFileSync(`${homedir()}/.ssh/config`, "utf8") : "").matchAll(/^\s*Host\s+(.+)$/gim)].flatMap((m) => m[1].trim().split(/\s+/)).filter((h) => !/[*?!]/.test(h));
          return json({ machines: machines(), remotes: [...remotes.values()].map((h) => ({ ...h.conf, online: h.online, error: h.error })), sshHosts });
        }
        case "/api/suggest-projects": {
          // A fresh Claude session gets the map of everything reachable and proposes ambitious projects.
          const maps = [inventoryText(await inventory())];
          for (const h of remotes.values()) if (h.online) { try { const r = await h.post("/api/connections", {}); if (r.data?.sections) maps.push(inventoryText(r.data)); } catch {} }
          const recent = [...new Set(allRows().filter((r) => !r.empty).map((r) => r.project))].slice(0, 25).join(", ");
          const prompt = `You are helping me plan ambitious work. Below is everything my machines can reach (agents, subscriptions, MCP servers, signed-in CLIs, API key names, skills). My active projects: ${recent}.\n\nPropose 6 "mega projects" that are only possible because of this combination: for each, the outcome, which of my connections it uses, the first 3 concrete steps an agent could start today, rough effort, and the main risk. Rank them by value to me. Also list any connection I'm missing that would unlock something big. Don't start building; wait for me to pick.\n\n${maps.join("\n\n---\n\n")}`;
          return json(await startSession({ kind: "claude", cwd: body.cwd || process.env.DECK_HUB_DIR || (existsSync(`${homedir()}/wiki`) ? `${homedir()}/wiki` : homedir()), prompt, label: "Mega project ideas", focus: false }));
        }
        case "/api/decide": {
          // You acted on a decision in the inbox: record it for Jev, and mark the session seen.
          recordOutcome(String(body.key), String(body.action ?? ""), body.choice != null ? String(body.choice) : undefined, decisions.get(String(body.key)));
          scheduleDecisions();
          return json({ ok: true });
        }
        case "/api/jev/stats": {
          const u = jevUsage();
          return json(statsFor(RECEIPTS_FILE, { cap: u.cap, used: u.calls, capSource: u.capSource, available: u.available, labels: cachedById() }));
        }
        case "/api/jev/cap": {
          try { setJevCap(Number(body.cap)); } catch (e: any) { return json({ error: e.message }, 400); }
          broadcast("jev", jevUsage());
          return json({ ok: true, jev: jevUsage() });
        }
        case "/api/jev/feature": {
          try { setJevFeature(String(body.name), body.on); } catch (e: any) { return json({ error: e.message }, 400); }
          broadcast("jev", jevUsage());
          return json({ ok: true, jev: jevUsage() });
        }
        case "/api/jev/route": {
          // Jev suggests which session a message is for; the palette asks you before anything is sent.
          const r = await routeMessage(body.text, allRows());
          return json(r.body, r.status);
        }
        case "/api/mcp-info":
          return json({ url: `http://127.0.0.1:${PORT}/mcp`, token: MCP_TOKEN, audit: readAudit(30), claude: `claude mcp add --scope user --transport http herdr-deck http://127.0.0.1:${PORT}/mcp --header "Authorization: Bearer ${MCP_TOKEN}"` });
        case "/api/recipe": {
          // One recipe (or free text) to many sessions, on any machine.
          const rows = new Map(allRows().map((r) => [r.key, r]));
          const results = [];
          for (const key of (body.keys ?? []).slice(0, 50)) {
            const row = rows.get(key);
            if (!row) { results.push({ key, ok: false, error: "gone" }); continue; }
            const text = fillTool(String(body.prompt ?? ""), row);
            try {
              const route = splitKey(key, remotes);
              if (route.remote) {
                const r = await route.remote.post("/api/send", { key: route.key, text });
                results.push({ key, ok: r.status < 300, error: r.data?.error });
              } else {
                await sendText(key, text);
                results.push({ key, ok: true });
              }
            } catch (e: any) { results.push({ key, ok: false, error: e?.message ?? String(e) }); }
          }
          return json({ results });
        }
        case "/api/seen": {
          return json({ ok: deck.markSeen(String(body.key)) });
        }
        case "/api/search": {
          const q = String(body.q ?? "").trim();
          const local = await searchLocal(q);
          // Other machines search their own transcripts; their hits come back with their key prefix.
          const remoteHits = await Promise.all([...remotes.values()].filter((h) => h.online).map((h) =>
            Promise.race([h.post("/api/search", { q, local: true }).then((r) => (r.data.hits ?? []).map((x: any) => ({ ...x, key: `${h.conf.id}|${x.key}` }))), Bun.sleep(1500).then(() => [])]).catch(() => [])));
          return json({ q, hits: [...local, ...(body.local ? [] : remoteHits.flat())] });
        }
        case "/api/file": {
          const lr = localRow(body.key);
          const r = await readFileFor(lr?.cwd, String(body.path ?? ""));
          return json(r, r.error ? 400 : 200);
        }
        case "/api/file-open": {
          const lr = localRow(body.key);
          const p = resolveSafe(lr?.cwd, String(body.path ?? ""));
          if (!p) return json({ error: "That path isn’t one the deck will open." }, 400);
          if (process.platform !== "darwin") return json({ error: "Opening files only works on a Mac." }, 400);
          Bun.spawn(body.reveal ? ["open", "-R", p] : ["open", p]);
          return json({ ok: true });
        }
        case "/api/codex-open": {
          // Opens the thread in the Codex app on this machine.
          const lr = localRow(body.key);
          if (!lr?.app || !lr.sessionId) return json({ error: "not a Codex app thread" }, 400);
          Bun.spawn(["open", `codex://threads/${lr.sessionId}`]);
          return json({ ok: true });
        }
        case "/api/codex-resume": {
          // Continues an app thread in a new herdr tab with the Codex CLI.
          const lr = localRow(body.key);
          if (!lr?.app || !lr.sessionId) return json({ error: "not a Codex app thread" }, 400);
          return json(await startSession({ kind: "codex", cwd: lr.cwd, args: ["resume", lr.sessionId], label: lr.title.slice(0, 40), focus: !!body.focus }));
        }
        case "/api/codex-hide": {
          const lr = localRow(body.key);
          if (!lr?.app || !lr.sessionId) return json({ error: "not a Codex app thread" }, 400);
          deck.hideAppThread(lr.sessionId);
          return json({ ok: true });
        }
        case "/api/read": {
          if (localRow(body.key)?.app) return json({ text: "", hash: "app" });
          const f = deck.find(body.key);
          if (!f) return json({ error: "gone" }, 404);
          const r = await call(f.sess.socket, "pane.read", {
            pane_id: f.row.paneId,
            source: "recent",
            lines: Math.min(Number(body.lines) || 200, 2000),
            format: "ansi",
            strip_ansi: false,
          });
          const text: string = r.read?.text ?? "";
          const hash = Bun.hash(text).toString(36);
          return json(body.hash === hash ? { same: true, hash } : { text, hash });
        }
        case "/api/new-options":
          return json(await newSessionOptions());
        case "/api/new":
          game.mkdirRun(body); // a new run's folder, only now that you confirmed the dialog
          return json(await startSession(body));
        case "/api/detail": {
          const lr = localRow(body.key);
          if (!lr) return json({ error: "gone" }, 404);
          const f = { row: lr };
          const d = await detailFor(f.row);
          const subagents = await subagentsFor(who(f.row), d).catch(() => []);
          return json({ ...detailPayload(f.row, d), subagents, chat: d ? chatSlice(d, { limit: body.limit }) : undefined });
        }
        case "/api/chat": {
          const lr = localRow(body.key);
          if (!lr) return json({ error: "gone" }, 404);
          const f = { row: lr };
          return json(await chatFor(f.row, body));
        }
        case "/api/brief": {
          const lr = localRow(body.key);
          if (!lr) return json({ error: "gone" }, 404);
          const f = { row: lr };
          const d = await detailFor(f.row);
          if (!d || !f.row.sessionId || !d.turns.length) return json({ error: "This pane has no conversation to summarise" }, 400);
          return json({ brief: await writeBrief(briefKey(f.row), f.row.title, f.row.project, d) });
        }
        case "/api/type": {
          // Keystrokes from the page's terminal, batched: [{ text }, { keys: [...] }, ...] in order.
          const f = deck.find(body.key);
          if (!f) return json({ error: "gone" }, 404);
          for (const op of (body.ops ?? []).slice(0, 200)) {
            if (typeof op.text === "string" && op.text) await call(f.sess.socket, "pane.send_text", { pane_id: f.row.paneId, text: op.text });
            else if (Array.isArray(op.keys) && op.keys.length) await call(f.sess.socket, "pane.send_keys", { pane_id: f.row.paneId, keys: op.keys });
          }
          return json({ ok: true });
        }
        case "/api/close":
          return json({ results: await closeLocal(body.keys ?? [], !!body.wholeTab) });
        case "/api/focus": {
          const f = deck.find(body.key);
          if (!f) return json({ error: "gone" }, 404);
          await call(f.sess.socket, "pane.focus", { pane_id: f.row.paneId });
          if (body.raise && process.platform === "darwin") Bun.spawn(["open", "-a", process.env.DECK_TERMINAL ?? "WezTerm"]);
          return json({ ok: true });
        }
        case "/api/send":
          await sendText(body.key, String(body.text ?? ""));
          return json({ ok: true });
        case "/api/keys": {
          const f = deck.find(body.key);
          if (!f) return json({ error: "gone" }, 404);
          await call(f.sess.socket, "pane.send_keys", { pane_id: f.row.paneId, keys: body.keys });
          return json({ ok: true });
        }
        case "/api/rename": {
          // herdr: the pane label, the agent name, and the tab when the pane has it to itself.
          // The agent's own "/rename" is returned to the caller, which sends it now or queues it.
          const f = deck.find(body.key);
          if (!f) return json({ error: "gone" }, 404);
          const label = String(body.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
          const done: string[] = [];
          if (f.row.tabPanes <= 1 || body.tab) { await call(f.sess.socket, "tab.rename", { tab_id: f.row.tabId, label }); done.push("tab"); }
          try { await call(f.sess.socket, "pane.rename", { pane_id: f.row.paneId, label: label || null }); done.push("pane"); } catch {}
          if (["claude", "codex", "opencode"].includes(f.row.agent)) { try { await call(f.sess.socket, "agent.rename", { target: f.row.paneId, name: label ? label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32) || null : null }); done.push("agent"); } catch {} }
          await deck.kick(f.row.herdr);
          const slash = label && (f.row.agent === "claude" || f.row.agent === "codex") ? `/rename ${label}` : undefined;
          return json({ ok: true, done, slash, busy: f.row.status === "working" || f.row.status === "blocked" });
        }
        case "/api/slash": {
          const row = localRow(body.key);
          if (!row) return json({ error: "gone" }, 404);
          return json({ agent: row.agent, commands: await slashCommands(row.agent, row.projectRoot ?? row.cwd ?? "") });
        }
        case "/api/reopen":
          return json(await reopen(body.id));
        case "/api/forget": {
          graveyard = body.all ? [] : graveyard.filter((g) => g.id !== body.id);
          saveGraves();
          broadcastGraves();
          return json({ ok: true });
        }
      }
    } catch (e: any) {
      return json({ error: e?.message ?? String(e), code: e?.code }, 500);
    }
    return new Response("not found", { status: 404 });
}

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
