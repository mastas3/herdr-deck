// HTTP front: one HTML page, one SSE stream of row patches, a handful of action endpoints.
// This deck is also a hub: machines listed in hosts.json are mirrored in and their actions forwarded.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { RemoteHost, splitKey, type Machine, type RemoteConf } from "./federation";
import { fillRecipe, loadRecipes, saveRecipes } from "./recipes";
import { Deck, type Row } from "./deck";
import { call } from "./herdr";
import { detailFor as detailOf, imageFor as imageOf, subDetailFor, subagentsFor } from "./insight";
import type { Detail, Msg } from "./transcript";
import { cachedBrief, writeBrief } from "./brief";
import { agentArgs } from "./args";
import { codexAppInstalled, codexAppRunning } from "./codexapp";

const PORT = Number(process.env.DECK_PORT ?? 4747);
const HOST = process.env.DECK_HOST ?? "127.0.0.1";
const DEV = !!process.env.DECK_DEV;
const TOKEN = crypto.randomUUID();
const DATA_DIR = `${homedir()}/.config/herdr-deck`;
const GRAVE_FILE = `${DATA_DIR}/graveyard.json`;
const HTML_PATH = new URL("../public/index.html", import.meta.url).pathname;

mkdirSync(DATA_DIR, { recursive: true });

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

const remotes = new Map<string, RemoteHost>();
(hostsConf.remotes ?? []).forEach((conf, i) => {
  if (!conf?.id || !conf.ssh || conf.id === SELF.id) return;
  const host = new RemoteHost(conf, {
    patch: (upsert, remove) => broadcast("patch", { upsert, remove, summary: summary() }),
    full: () => broadcast("full", fullState()),
    graveyard: () => broadcast("graveyard", allGraves()),
    notice: (n) => broadcast("notice", n),
  });
  remotes.set(conf.id, host);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { for (const h of remotes.values()) h.stop(); process.exit(0); });

const tagLocal = (r: Row): Row => ({ ...r, machine: r.app ? "codex-app" : SELF.id });
function machines(): Machine[] {
  const app: Machine[] = codexAppInstalled() ? [{ id: "codex-app", label: "Codex app", local: true, online: codexAppRunning(), kind: "app" } as Machine] : [];
  return [{ id: SELF.id, label: SELF.label, local: true, online: true, herdr: deck.summary().herdr }, ...[...remotes.values()].map((h) => h.machine()), ...app];
}
/** Any local row, pane or Codex app thread (deck.find only knows panes). */
const localRow = (key: string) => deck.rows.get(key);
function summary() {
  return { ...deck.summary(), machines: machines() };
}
function allRows() {
  const out = [...deck.rows.values()].map(tagLocal);
  for (const h of remotes.values()) out.push(...h.rows.values());
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
  return { token: TOKEN, self: SELF.id, publicUrl: PUBLIC_URL, rows: allRows(), summary: summary(), graveyard: allGraves(), recipes: loadRecipes() };
}

function broadcast(event: string, data: unknown) {
  const chunk = sse(event, data);
  for (const c of clients) try { c.enqueue(chunk); } catch { clients.delete(c); }
}

deck.onPatch((patch) => broadcast("patch", { upsert: patch.upsert.map(tagLocal), remove: patch.remove, summary: summary() }));
/** One-off messages for the page (progress and failures of background work like starting a session). */
const notice = (data: { key?: string; ok: boolean; message: string }) => broadcast("notice", data);
const broadcastGraves = () => broadcast("graveyard", allGraves());
setInterval(() => {
  const ping = enc.encode(`: ping\n\n`);
  for (const c of clients) try { c.enqueue(ping); } catch { clients.delete(c); }
}, 15_000);

// ── HTML ─────────────────────────────────────────────────────────────────────
// app.js is served under a content hash so browsers (and the service worker) keep it forever.
const APP_PATH = new URL("../public/app.js", import.meta.url).pathname;
let appJs = { mtime: 0, body: new Uint8Array(), gz: new Uint8Array(), hash: "" };
/** Loaded once at startup, like the HTML, so a running service never mixes new JS with an old page. DEV reloads. */
function appAsset() {
  const m = appJs.mtime && !DEV ? appJs.mtime : statSync(APP_PATH).mtimeMs;
  if (m !== appJs.mtime) {
    const body = new Uint8Array(readFileSync(APP_PATH));
    appJs = { mtime: m, body, gz: Bun.gzipSync(body), hash: Bun.hash(body).toString(36) };
  }
  return appJs;
}
let htmlTemplate = readFileSync(HTML_PATH, "utf8");
function page() {
  if (DEV) htmlTemplate = readFileSync(HTML_PATH, "utf8");
  const boot = JSON.stringify(fullState()).replace(/</g, "\\u003c");
  return htmlTemplate.replace("/*__BOOT__*/", `window.__BOOT__=${boot};`).replace('src="/app.js"', `src="/app.js?v=${appAsset().hash}"`);
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

const who = (row: Row) => ({ agent: row.agent, sessionId: row.sessionId, cwd: row.cwd });
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
        await call(sess.socket, "agent.start", { name, kind, pane_id: paneId, args, timeout_ms: 90_000 }, 95_000);
        const prompt = String(body.prompt ?? "").trim();
        if (prompt) await call(sess.socket, "agent.prompt", { target: paneId, text: prompt }, 15_000);
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

/**
 * Actions on another machine's sessions go to that machine's deck. Briefs are the exception:
 * the hub writes them with its own local model from the node's conversation detail.
 */
async function forwardToMachine(path: string, body: any): Promise<Response | undefined> {
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
    const bin = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => existsSync(p));
    if (bin) {
      const st = JSON.parse(Bun.spawnSync([bin, "status", "--json"], { stderr: "ignore" }).stdout.toString());
      const login = st.User?.[String(st.Self?.UserID)]?.LoginName;
      if (login) tsUsers.add(login);
    }
  } catch {}
}

const hasApiToken = (req: Request) => req.headers.get("authorization") === `Bearer ${API_TOKEN}`;

function allowedHost(req: Request) {
  if (hasApiToken(req)) return true;
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

    if (req.method === "GET") {
      // "/" and every session link (/s/<machine>/<agent>/<session id>) serve the same page; the page resolves the link.
      if (url.pathname === "/" || url.pathname.startsWith("/s/")) return send(req, page(), "text/html; charset=utf-8");
      if (url.pathname === "/app.js") {
        const a = appAsset();
        const cache = url.searchParams.get("v") === a.hash ? "public, max-age=31536000, immutable" : "no-cache";
        const gz = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
        return new Response(gz ? a.gz : a.body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": cache, vary: "accept-encoding", ...(gz ? { "content-encoding": "gzip" } : {}) } });
      }
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
      if (url.pathname === "/health") return json({ ok: true, clients: clients.size, ...deck.health(), machines: machines().map(({ herdr, ...m }) => m) });
      return new Response("not found", { status: 404 });
    }

    if (req.method !== "POST" || (req.headers.get("x-deck-token") !== TOKEN && !hasApiToken(req))) return new Response("forbidden", { status: 403 });
    const body: any = await req.json().catch(() => ({}));
    try {
      const forwarded = await forwardToMachine(url.pathname, body);
      if (forwarded) return forwarded;
      switch (url.pathname) {
        case "/api/recipes":
          return json({ recipes: saveRecipes(body.recipes ?? []) });
        case "/api/recipe": {
          // One recipe (or free text) to many sessions, on any machine.
          const rows = new Map(allRows().map((r) => [r.key, r]));
          const results = [];
          for (const key of (body.keys ?? []).slice(0, 50)) {
            const row = rows.get(key);
            if (!row) { results.push({ key, ok: false, error: "gone" }); continue; }
            const text = fillRecipe(String(body.prompt ?? ""), row);
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
          const f = deck.find(body.key);
          if (!f) return json({ error: "gone" }, 404);
          await call(f.sess.socket, "tab.rename", { tab_id: f.row.tabId, label: String(body.label ?? "") });
          await deck.kick(f.row.herdr);
          return json({ ok: true });
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

console.log(`herdr-deck "${SELF.label}" on http://${HOST}:${PORT}  (${deck.rows.size} panes across ${deck.sessions.size} herdr server(s); ${remotes.size} other machine(s))`);
