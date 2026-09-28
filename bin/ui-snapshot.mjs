#!/usr/bin/env node
// UI snapshots of a throwaway deck: starts the deck from a source folder on its own port with a scratch HOME (so it
// sees no real sessions, data or herdr socket), adds synthetic sessions (DECK_DEV fake rows), then visits each view at
// desktop 1400×900 and Android 393×873 with the clock, Math.random and the SSE stream frozen and every mutating API
// blocked. For each view × viewport it writes <view>-<vp>.png and <view>-<vp>.json (DOM text, page errors, console
// errors, requests, blocked requests). Compare two runs with bin/ui-compare.mjs. Usage: bin/ui-snapshot.mjs --help
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH || "/Users/stas-2/.nvm/versions/node/v20.16.0/lib/node_modules/playwright/index.mjs";
const HERE = dirname(new URL(import.meta.url).pathname);
/** Frozen "now" for the page and the synthetic sessions: 2026-09-28 09:00 local time. */
const NOW = new Date(2026, 8, 28, 9, 0, 0).getTime();
const MIN = 60_000;

const HELP = `usage: bin/ui-snapshot.mjs --out <dir> [options]
  --out <dir>          where the screenshots and JSON go (created; old files overwritten)
  --repo <dir>         the deck source to run (default: this checkout)
  --port <n>           port for the throwaway deck (default 4771; must be free)
  --views a,b,c        which views (default: all; "all-but-new" skips the code-plugin views). Known: ${"VIEWS"}
  --viewports d,p      desktop and/or phone (default both)
  --seed <dir>         copy this folder into the scratch HOME first (fixture data)
  --plugins-off a,b    start with these code plugins turned off (writes the deck's plugin state)
  --env KEY=VAL        extra environment for the deck (repeatable)
  --keep               keep the scratch HOME (its path is printed)`;

// ── views: what to do in the page before the snapshot (plain JS run in the page, then the page settles) ──
export const VIEWS = {
  home: "",
  session: `select("fake:blocked", { scroll: true, open: true })`,
  "codex-session": `S.summary.machines.push({ id: "codex-app", kind: "app", label: "Codex app", local: true, online: true });
    codexViews.set("fake:codex", { ready: true, status: "working", activeTurnId: "synthetic-turn", requests: [] });
    select("fake:codex", { scroll: true, open: true });
    mergeChat(S.sel, { gen: 1, total: 2, messages: [{ i: 0, role: "user", text: "Improve Codex support in the deck." }, { i: 1, role: "assistant", text: "I’m checking the session index and subagent conversations." }] });
    S.details.set(S.sel, { stamp: rowOf(S.sel).lastActiveAt, data: { asks: 1, subagents: [{ id: "child", description: "Review the API", type: "explorer", running: true, tools: 3 }], turns: [], images: [] } });
    headSig = ""; renderDetail();
    if ($("composer").hidden || $("cSteer").hidden || $("cSend").textContent !== "Queue") throw new Error("Native Codex controls are missing");
    if (!document.querySelector('[data-tab="agents"]')) throw new Error("Codex subagents tab is missing");`,
  "codex-disconnected": `select("fake:codex", { scroll: true, open: true }); codexViews.set("fake:codex", { ready: false, canOpen: true, requests: [], error: "Open this task in the Codex app, then reconnect." }); renderDetail(); if (!$("composer").hidden) throw new Error("Disconnected composer is enabled"); if (!document.querySelector('[data-dact="codexconnect"]')) throw new Error("Native connection recovery is missing");`,
  "codex-approval": `select("fake:codex", { scroll: true, open: true }); rowOf(S.sel).status = "blocked"; codexViews.set(S.sel, { ready: true, status: "blocked", activeTurnId: "synthetic-turn", requests: [{ id: 42, method: "item/commandExecution/requestApproval", params: { command: "bun test", cwd: "/tmp/deck", reason: "Run the project tests", availableDecisions: ["accept", "decline"] } }] }); renderDetail();`,
  "codex-question": `select("fake:codex", { scroll: true, open: true }); rowOf(S.sel).status = "blocked"; codexViews.set(S.sel, { ready: true, status: "blocked", activeTurnId: "synthetic-turn", requests: [{ id: "async:question", method: "deck/asyncQuestion", params: { questions: [{ id: "q0", question: "Which test marker should be used?", options: [{ label: "Marker A" }, { label: "Marker B" }] }] } }] }); renderDetail();`,
  "codex-menu": `(async () => { select("fake:codex", { scroll: true, open: true }); rowOf(S.sel).status = "idle"; codexViews.set(S.sel, await api("/api/codex-state", { key: S.sel })); renderDetail(); moreMenu(document.querySelector('[data-dact="more"]')); if (!menuEl.textContent.includes("Rename Codex task") || !menuEl.textContent.includes("Edit last message")) throw new Error("Native task actions are missing"); })()`,
  "codex-settings": `(async () => { select("fake:codex", { scroll: true, open: true }); await openCodexSettings(rowOf(S.sel)); if (!document.querySelector('.native-settings select[name="permissionMode"]')) throw new Error("Native permissions picker is missing"); })()`,
  "codex-settings-managed": `(async () => { select("fake:codex", { scroll: true, open: true }); await openCodexSettings(rowOf(S.sel)); if (document.querySelector('.native-settings select[name="permissionMode"]')) throw new Error("Managed permissions can be overwritten"); })()`,
  "codex-settings-save": `(async () => { select("fake:codex", { scroll: true, open: true }); await openCodexSettings(rowOf(S.sel)); const form = document.querySelector('.native-settings form'); form.elements.model.value = "fixture-fast"; form.elements.model.dispatchEvent(new Event("change")); form.elements.effort.value = "low"; form.elements.permissionMode.value = "read-only"; form.requestSubmit(); })()`,
  "codex-edit": `select("fake:codex", { scroll: true, open: true }); void editCodexLastMessage(rowOf(S.sel));`,
  "codex-archives": `openCodexArchives(S.self)`,
  "codex-queue": `(async () => { select("fake:codex", { scroll: true, open: true }); codexViews.set(S.sel, await api("/api/codex-state", { key: S.sel })); S.queue[S.sel] = [{ id: "deck-queued", text: "Then summarize the test results." }]; renderDetail(); if (!$("qbar").textContent.includes("In Codex") || !$("qbar").textContent.includes("Deck ·")) throw new Error("The two queues are not distinguished"); })()`,
  "codex-new": `(async () => { newCodexTarget = "app"; await openNew({ kind: "codex", cwd: "/tmp/acme-api", project: "acme-api" }); if (!newCodexApp() || !$("nAgentOpts").hidden || !$("nArgsWrap").hidden) throw new Error("Native creation exposes CLI flags"); })()`,
  "codex-new-cli": `(async () => { newCodexTarget = "cli"; await openNew({ kind: "codex", cwd: "/tmp/acme-api", project: "acme-api" }); if (newCodexApp() || $("nArgsWrap").hidden) throw new Error("CLI creation is not available"); })()`,
  ...Object.fromEntries(["unsent", "unknown", "persisted", "stale", "retry"].map((scenario) => [`codex-create-${scenario}`, `(async () => {
    newCodexTarget = "app"; await openNew({ kind: "codex", cwd: "/tmp/acme-api", project: "acme-api", prompt: "Fixture first message." });
    await submitNewSession(); ${scenario === "retry" ? "await submitNewSession();" : ""} $("newDlg").close("cancel");
    if (${scenario === "unsent"} ? S.drafts.get("fake:created") !== "Fixture first message." : S.drafts.has("fake:created")) throw new Error("Unsafe initial-message draft after ${scenario} creation");
    ${scenario === "stale" ? 'if (!document.querySelector(".toast")?.textContent.includes("conversation has changed")) throw new Error("Stale creation incorrectly offers a first-message retry");' : ""}
  })()`])),
  "codex-fork-retry": `(async () => { const r = rowOf("fake:codex"); await codexTaskAction(r, "fork").catch(() => {}); await codexTaskAction(r, "fork"); })()`,
  "tools-menu": `select("fake:blocked", { scroll: true, open: true }); openToolMenu(document.querySelector('[data-dact="tools"]') ?? $("cRecipe"))`,
  inbox: `setMode("inbox")`,
  history: `setMode("history")`,
  tools: `setMode("tools")`,
  connections: `setMode("connections")`,
  discover: `setMode("discover")`,
  library: `setMode("discover"); discTab("lib")`,
  // Discover's other tabs (its own, and the ones Leads, Research, Library and Opportunities add to it).
  ...Object.fromEntries(["evidence", "mix", "lab", "leads", "research", "lib", "ideas", "saved"].map((t) => [`discover-${t}`, `setMode("discover"); discTab("${t}")`])),
  opportunities: `setMode("opportunities")`,
  quests: `setMode("quests")`,
  review: `setMode("review")`,
  workers: `setMode("workers")`,
  releases: `setMode("releases")`,
  shipped: `setMode("shipped")`,
  private: `setMode("private")`,
  projects: `openProjects()`,
  // Grouped by project: each project header carries its project page link (the projects plugin's "project.link").
  "by-project": `setGroup("project"); select("fake:blocked", { scroll: true, open: true })`,
  "project-page": `openJourney("acme-api")`,
  plugins: `setMode("plugins")`,
  "plugins-builtin": `setMode("plugins"); plugTab("code")`,
  "plugins-add": `setMode("plugins"); plugTab("add")`,
  // The red trust screen for a code plugin: a small demo plugin the harness puts in the scratch HOME ($HOME).
  "plugins-trust": `setMode("plugins"); plugTab("add"); codeInspect({ folder: "$HOME/demo-plugin" })`,
  palette: `openPalette()`,
};
/** Views that only exist once the deck has code plugins; --views all-but-new leaves them out (for older builds). */
const NEWER = ["plugins-builtin", "plugins-add", "plugins-trust", "review", "workers", "releases", "shipped", "private"];
const VIEWPORTS = {
  desktop: { viewport: { width: 1400, height: 900 }, colorScheme: "dark" },
  phone: {
    viewport: { width: 393, height: 873 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75, colorScheme: "dark",
    userAgent: "Mozilla/5.0 (Linux; Android 14; POCO X6 Pro 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
  },
};
/** Anything that starts, sends, changes or installs something. Answered 403 in the page, never reaches the deck. */
const BLOCK = [
  /^\/api\/(new|send|keys|close|rename|decide|seen|upload|queue|tool|verify|focus|share|standup|brief)$/,
  /^\/api\/ideas\/play/, /^\/api\/plugins\/(install|upload|remove|enable)/, /^\/api\/push\/(subscribe|unsubscribe|test)$/,
  /^\/api\/history-resume$/, /^\/api\/codex-/,
];
/** Paths that only change something for some ops: the covers job reads its status freely, but never paints. */
const BLOCK_OPS = { "/api/covers": (b) => (b?.op ?? "status") !== "status" };
const blocked = (path, body) => BLOCK.some((re) => re.test(path)) || !!BLOCK_OPS[path]?.(body);

/** Synthetic sessions, one per status, timed against the frozen clock. */
const FAKE_ROWS = [
  { key: "fake:working", title: "Refactor the billing module", project: "acme-api", status: "working", agent: "claude", now: "Editing src/billing.ts", lastActiveAt: NOW - 1 * MIN, startedAt: NOW - 50 * MIN, firstPrompt: "Split billing into smaller files", cwd: "/tmp/acme-api" },
  { key: "fake:blocked", title: "Migrate the database", project: "acme-api", status: "blocked", agent: "codex", now: "Waiting for approval", lastActiveAt: NOW - 3 * MIN, startedAt: NOW - 90 * MIN, firstPrompt: "Add the orders table", lastMessage: "Run the migration on the staging database?", cwd: "/tmp/acme-api" },
  { key: "fake:done", title: "Landing page copy", project: "acme-site", status: "done", agent: "claude", lastActiveAt: NOW - 20 * MIN, startedAt: NOW - 3 * 60 * MIN, firstPrompt: "Rewrite the hero section", lastMessage: "Done: the hero now leads with the outcome.", cwd: "/tmp/acme-site" },
  { key: "fake:idle", title: "Fix flaky test", project: "tools", status: "idle", agent: "opencode", lastActiveAt: NOW - 5 * 60 * MIN, startedAt: NOW - 26 * 60 * MIN, firstPrompt: "Why does ci fail on Mondays", cwd: "/tmp/tools" },
  { key: "fake:empty", title: "", project: "scratch", status: "empty", agent: "claude", empty: true, lastActiveAt: NOW - 2 * 60 * MIN, startedAt: NOW - 2 * 60 * MIN, cwd: "/tmp/scratch" },
];

function nativeFixtureState(view) {
  const capabilities = { settings: true, edit: true, create: true, rename: true, archive: true, restore: true, fork: true };
  if (view === "codex-disconnected") return { ready: false, canOpen: true, requests: [], capabilities, error: "Open this task in the Codex app, then reconnect." };
  const blocked = ["codex-approval", "codex-question"].includes(view), idle = ["codex-menu", "codex-edit", "codex-settings", "codex-settings-managed", "codex-settings-save"].includes(view);
  return { ready: true, status: blocked ? "blocked" : idle ? "idle" : "working", activeTurnId: idle ? null : "synthetic-turn", capabilities,
    editableTurn: idle ? { turnId: "synthetic-last-turn", text: "Improve Codex support in the deck." } : undefined,
    nativeQueue: { status: "ready", messages: view === "codex-queue" ? [{ id: "native-queued", text: "Review the API tests before continuing." }] : [] },
    requests: view === "codex-approval" ? [{ id: 42, method: "item/commandExecution/requestApproval", params: { command: "bun test", cwd: "/tmp/deck", reason: "Run the project tests", availableDecisions: ["accept", "decline"] } }] : view === "codex-question" ? [{ id: "async:question", method: "deck/asyncQuestion", params: { questions: [{ id: "q0", question: "Which test marker should be used?", options: [{ label: "Marker A" }, { label: "Marker B" }] }] } }] : [] };
}
function nativeFixtureSettings(managed = false) {
  return { model: "fixture-reasoner", effort: "high", version: "fixture-settings-v1", permissionMode: managed ? "managed-profile" : "workspace-write",
    models: [{ id: "fixture-reasoner", label: "Test reasoning model", efforts: ["medium", "high"], defaultEffort: "high" }, { id: "fixture-fast", label: "Test fast model", efforts: ["low", "medium"], defaultEffort: "medium" }],
    permissionModes: managed ? [] : [{ id: "read-only", label: "Read only", description: "Read files; ask before making changes." }, { id: "workspace-write", label: "Workspace access", description: "Allow changes inside this task’s workspace." }], permissionsNote: managed ? "This task uses a managed permission profile. Change it in Codex." : undefined };
}

function args(argv) {
  const o = { port: 4771, repo: resolve(HERE, ".."), views: Object.keys(VIEWS), viewports: ["desktop", "phone"], env: {}, pluginsOff: [], keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--out") o.out = resolve(v());
    else if (a === "--repo") o.repo = resolve(v());
    else if (a === "--port") o.port = Number(v());
    else if (a === "--views") { const x = v(); o.views = x === "all-but-new" ? Object.keys(VIEWS).filter((n) => !NEWER.includes(n)) : x.split(",").filter(Boolean); }
    else if (a === "--viewports") o.viewports = v().split(",").filter(Boolean);
    else if (a === "--seed") o.seed = resolve(v());
    else if (a === "--plugins-off") o.pluginsOff = v().split(",").filter(Boolean);
    else if (a === "--env") { const [k, ...rest] = v().split("="); o.env[k] = rest.join("="); }
    else if (a === "--keep") o.keep = true;
    else if (a === "--help" || a === "-h") { console.log(HELP.replace('"VIEWS"', Object.keys(VIEWS).join(", "))); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.out) throw new Error("--out is required (see --help)");
  for (const x of o.views) if (!(x in VIEWS)) throw new Error(`unknown view ${x}`);
  for (const x of o.viewports) if (!(x in VIEWPORTS)) throw new Error(`unknown viewport ${x}`);
  return o;
}

const portFree = (port) => new Promise((ok) => { const s = createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true))).listen(port, "127.0.0.1"); });

async function startDeck(o, home) {
  if (!(await portFree(o.port))) throw new Error(`port ${o.port} is in use: pick another with --port`);
  const log = openSync(join(o.out, "server.log"), "w");
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", TZ: process.env.TZ ?? "",
    DECK_PORT: String(o.port), DECK_DEV: "1", DECK_ROLE: "hub", DECK_PLUGINS_DEFAULT: "on",
    // No model calls, no Codex, no background workers that reach the network or this machine's real accounts.
    DECK_NO_JEV: "1", DECK_CLAUDE_BIN: "/usr/bin/false", DECK_CODEX_BIN: "/usr/bin/false", DECK_JEV_BIN: "/usr/bin/false",
    DECK_NO_LIBRARY: "1", DECK_NO_LOGINS: "1", DECK_NO_GUMROAD: "1", DECK_GAME_AI: "0", DECK_JOURNEY_AI: "0", OLLAMA_HOST: "http://127.0.0.1:9",
    DECK_PROJECTS_DIR: join(home, "Projects"), DECK_WIKI_DIR: join(home, "wiki"),
    ...o.env,
  };
  const child = spawn(process.env.BUN || "bun", ["src/server.ts"], { cwd: o.repo, env, stdio: ["ignore", log, log] });
  const base = `http://127.0.0.1:${o.port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`the deck exited (${child.exitCode}); see ${join(o.out, "server.log")}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const html = await (await fetch(`${base}/`)).text();
  const token = html.match(/"token":"([^"]+)"/)?.[1];
  if (!token) throw new Error("no action token in the page");
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-deck-token": token }, body: JSON.stringify(body) });
  const codex = o.views.some((v) => v.startsWith("codex-")) ? [{ ...FAKE_ROWS[0], key: "fake:codex", agent: "codex", app: "codex", title: "Improve the Codex integration", projectRoot: "/tmp/acme-api", sessionId: "fixture-codex" }] : [];
  const r = await post("/api/dev/fake-rows", { clear: true, rows: [...FAKE_ROWS, ...codex] });
  if (!r.ok) throw new Error(`fake rows: ${r.status}`);
  return { child, base, post };
}

/** Code plugins that start switched off: the same state file the Plugins view writes. */
function writePluginsOff(home, off) {
  if (!off.length) return;
  const dir = join(home, ".config", "herdr-deck");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-plugins.json"), JSON.stringify({ enabled: Object.fromEntries(off.map((id) => [id, false])), installed: [] }, null, 1));
}

/** A tiny code plugin to open the trust screen with (it is reviewed, never installed: install is blocked). */
function demoPlugin(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ deck: 1, kind: "code", id: "demo-hello", name: "Hello", version: "0.1.0", description: "Says hello at /api/hello.", server: "server.ts", client: ["hello.js"], routes: ["hello"] }, null, 1));
  writeFileSync(join(dir, "server.ts"), 'export function activate(host) { host.routes("hello", () => ({ hello: "world" })); }\n');
  writeFileSync(join(dir, "hello.js"), 'deckPlugins.register("demo-hello", {});\n');
}

/** Frozen page: fixed Date, seeded Math.random, and an EventSource that opens and then stays silent (state comes from
 *  the page's inlined boot data only), so two runs see the same thing. */
function freezeScript() {
  let seed = 42;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  class FrozenEventSource {
    constructor(url) { this.url = url; this.readyState = 1; setTimeout(() => this.onopen?.({}), 0); }
    addEventListener() {} removeEventListener() {} close() { this.readyState = 2; }
  }
  window.EventSource = FrozenEventSource;
}

const norm = (u) => {
  const url = new URL(u);
  for (const k of ["v", "t"]) if (url.searchParams.has(k)) url.searchParams.set(k, "*");
  return `${url.pathname}${url.search}`;
};

async function snap(browser, o, deck, view, vp) {
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(freezeScript);
  const out = { view, viewport: vp, errors: [], console: [], requests: new Set(), blocked: new Set() };
  const mutationReceipts = [];
  let inflight = 0, lastNet = Date.now();
  page.on("pageerror", (e) => out.errors.push(String(e.message ?? e)));
  page.on("console", (m) => { if (m.type() === "error") out.console.push(m.text()); });
  page.on("request", (r) => { inflight++; lastNet = Date.now(); if (r.url().startsWith(deck.base)) out.requests.add(`${r.method()} ${norm(r.url())}`); });
  const done = () => { inflight = Math.max(0, inflight - 1); lastNet = Date.now(); };
  page.on("requestfinished", done); page.on("requestfailed", done);
  await page.route((u) => u.origin === deck.base && u.pathname.startsWith("/api/"), (r) => {
    const req = r.request(), path = new URL(req.url()).pathname;
    let body;
    try { body = req.postDataJSON(); } catch {}
    // Native controls use only synthetic state in this harness, never the real desktop socket.
    if (path === "/api/codex-state") return r.fulfill({ contentType: "application/json", body: JSON.stringify(nativeFixtureState(view)) });
    if (path === "/api/codex-settings" && body?.expectedVersion == null) return r.fulfill({ contentType: "application/json", body: JSON.stringify(nativeFixtureSettings(view === "codex-settings-managed")) });
    // The form test acknowledges a fixture-only write; no mutation reaches a server or real task.
    if (path === "/api/codex-settings" && view === "codex-settings-save" && body?.key === "fake:codex") {
      if (body.expectedVersion !== "fixture-settings-v1" || body.model !== "fixture-fast" || body.effort !== "low" || body.permissionMode !== "read-only") out.errors.push("Settings form sent an incorrect model, effort, permission, or stale-form guard");
      out.settingsSaved = true;
      return r.fulfill({ contentType: "application/json", body: '{"ok":true}' });
    }
    if (path === "/api/codex-archived") return r.fulfill({ contentType: "application/json", body: JSON.stringify({ tasks: [{ key: "fake:archived", id: "fixture-archived", title: "Review the launch checklist", cwd: "/tmp/acme-api" }], nextCursor: null }) });
    if (path === "/api/new-options" && (view.startsWith("codex-new") || view.startsWith("codex-create-"))) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ recent: ["/tmp/acme-api"], projects: [], argHints: {}, choices: { codex: { models: [{ v: "", l: "Default" }], efforts: ["low", "medium", "high"], modes: [{ v: "", l: "Default" }, { v: "workspace-write", l: "Workspace" }] } }, codexApp: { available: true, create: true, restore: true } }) });
    if (path === "/api/codex-create" && view.startsWith("codex-create-") || path === "/api/codex-fork" && view === "codex-fork-retry" && body?.key === "fake:codex") {
      mutationReceipts.push(body?.requestId);
      if (path === "/api/codex-create" && (body?.cwd !== "/tmp/acme-api" || body?.prompt !== "Fixture first message.")) out.errors.push("Native create sent the wrong folder or first message");
      if (view.endsWith("retry") && mutationReceipts.length === 1) return r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Fixture acknowledgement lost","code":"CODEX_DELIVERY_UNKNOWN"}' });
      return r.fulfill({ contentType: "application/json", body: JSON.stringify({ key: "fake:created", promptSent: view.endsWith("retry"), canRetryPrompt: !view.endsWith("stale"), deliveryUnknown: view.endsWith("unknown"), promptPersisted: view.endsWith("persisted"), error: view.endsWith("retry") ? undefined : view.endsWith("stale") ? "Open this task in Codex to review its new conversation." : "Fixture connection lost" }) });
    }
    if (!blocked(path, body)) return r.fallback();
    out.blocked.add(`${r.request().method()} ${norm(r.request().url())}`);
    return r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"blocked by ui-snapshot"}' });
  });
  const settle = async (max = 12_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < max && (inflight > 0 || Date.now() - lastNet < 700)) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
  };
  await page.goto(`${deck.base}/`, { waitUntil: "load" });
  await settle();
  if (VIEWS[view]) { try { await page.evaluate(VIEWS[view].replaceAll("$HOME", o.home)); } catch (e) { out.errors.push(`setup: ${e.message}`); } }
  await settle();
  if (view === "codex-settings-save" && !out.settingsSaved) out.errors.push("Settings form did not submit");
  if (view.startsWith("codex-create-") || view === "codex-fork-retry") {
    if (mutationReceipts.length !== (view.endsWith("retry") ? 2 : 1) || mutationReceipts.some((id) => typeof id !== "string" || id !== mutationReceipts[0])) out.errors.push("Native create/fork did not reuse its receipt after uncertain delivery");
  }
  const name = `${view}-${vp}`;
  await page.screenshot({ path: join(o.out, `${name}.png`), animations: "disabled", caret: "hide" });
  const text = await page.evaluate(() => document.body.innerText);
  writeFileSync(join(o.out, `${name}.json`), JSON.stringify({ ...out, requests: [...out.requests].sort(), blocked: [...out.blocked].sort(), text }, null, 1));
  await ctx.close();
  return out;
}

async function main() {
  const o = args(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  // One scratch HOME per port, at a fixed path: pages that print their data folder read the same in every run.
  const home = join(tmpdir(), `deck-ui-home-${o.port}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  if (o.seed) cpSync(o.seed, home, { recursive: true });
  o.home = home;
  demoPlugin(join(home, "demo-plugin"));
  writePluginsOff(home, o.pluginsOff);
  let deck;
  const stop = () => { try { deck?.child.kill("SIGTERM"); } catch {} };
  process.on("exit", stop);
  try {
    deck = await startDeck(o, home);
    const { chromium } = await import(PLAYWRIGHT);
    const browser = await chromium.launch();
    const summary = [];
    for (const vp of o.viewports) for (const view of o.views) {
      const r = await snap(browser, o, deck, view, vp);
      summary.push({ view, viewport: vp, errors: r.errors.length, requests: r.requests.size, blocked: r.blocked.size });
      console.log(`${view}-${vp}: ${r.errors.length} page errors, ${r.requests.size} requests, ${r.blocked.size} blocked`);
    }
    await browser.close();
    // What the deck says about its plugins at the end (code plugins: state and running timers).
    const read = (path) => deck.post(path, {}).then((r) => (r.ok ? r.json() : { status: r.status })).catch((e) => ({ error: String(e) }));
    const plugins = { data: await read("/api/plugins"), code: await read("/api/plugins/code") };
    writeFileSync(join(o.out, "plugins.json"), JSON.stringify(plugins, null, 1));
    writeFileSync(join(o.out, "summary.json"), JSON.stringify({ at: NOW, repo: o.repo, pluginsOff: o.pluginsOff, views: summary }, null, 1));
  } finally {
    stop();
    if (o.keep) console.log(`scratch HOME kept: ${home}`);
    else rmSync(home, { recursive: true, force: true });
  }
  console.log(`snapshots in ${o.out}`);
}

main().catch((e) => { console.error(`ui-snapshot: ${e.message ?? e}`); process.exit(1); });
