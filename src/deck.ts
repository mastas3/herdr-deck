// Live state engine: keeps every herdr server's snapshot in memory, enriches each pane
// (dates, memory, context, git, terminal tail) and emits row-level patches.
import { basename } from "node:path";
import { call, discoverSessions, subscribe, type HerdrSession } from "./herdr";
import { childrenIndex, readListening, readProcs, treePids, treeUsage, type Listen, type Proc } from "./procs";
import { claudeMeta, codexMeta, opencodeMeta, resumeCommand, type AgentMeta } from "./agents";
import { cleanTail, isShellOnly } from "./tail";
import { insightFor, type Insight } from "./insight";
import { projectRoot } from "./projects";
import { codexAppInstalled, listAppThreads, type AppThread } from "./codexapp";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const HIDDEN_FILE = `${homedir()}/.config/herdr-deck/codex-app-hidden.json`;
const SEEN_FILE = `${homedir()}/.config/herdr-deck/seen.json`;

export type Row = {
  key: string;
  machine?: string; // set by the server: which machine this pane lives on
  herdr: string;
  workspaceId: string;
  workspace: string;
  tabId: string;
  tab: string;
  tabNumber: number;
  tabPanes: number;
  paneId: string;
  agent: string; // claude | codex | opencode | … | shell | <process name>
  status: string; // working | blocked | done | idle | unknown | empty
  focused: boolean;
  title: string;
  firstPrompt?: string;
  lastMessage?: string;
  cwd: string;
  project: string; // what the session is really about (from the work it did), else its folder's project
  projectRoot?: string;
  launch?: string; // the folder's project, when it differs from `project` (sessions started from a hub)
  now?: string; // the tool call in flight
  step?: string; // the todo/plan item in progress
  todos?: { done: number; total: number };
  turnStartedAt?: number;
  subagents?: { id: string; type?: string; description?: string; model?: string; running: boolean; now?: string; startedAt?: number; lastActiveAt?: number; tools: number }[];
  branch?: string;
  dirty?: number;
  startedAt?: number;
  createdAt?: number;
  bornAt?: number; // first seen by this deck (only for panes opened while it runs)
  lastActiveAt?: number;
  model?: string;
  provider?: string;
  ctxTokens?: number;
  ctxWindow?: number;
  cost?: number;
  rssKB: number;
  cpu: number;
  procs: number;
  command?: string;
  sessionId?: string;
  resume?: string;
  tail: string[];
  cols?: number;
  rows?: number;
  empty: boolean;
  stale: boolean;
  duplicate: boolean;
  approx: boolean;
  seen?: boolean; // you opened it (in the deck) since it last changed: a finished session no longer needs you
  app?: "codex"; // a Codex desktop app thread: no pane, no terminal; open it in the app or resume in herdr
  ports?: { port: number; addr: string; cmd: string; url?: string }[]; // servers this session is running (url: shared on the tailnet)
  check?: any; // proof-of-done result for its project (verify.ts)
  hist?: string; // a past session from the history index: its transcript file
};

type FgProc = { pid: number; name?: string; argv0?: string; cmdline?: string };
type Sess = HerdrSession & {
  online: boolean;
  events: number;
  lastEventAt?: number;
  error?: string;
  snap?: any;
  procInfo: Map<string, { shellPid: number; fg: FgProc[] }>;
  tails: Map<string, string[]>;
  unsub?: () => void;
  refreshTimer?: Timer;
};

const STALE_MS = 48 * 3600_000;

export class Deck {
  sessions = new Map<string, Sess>();
  procs = new Map<number, Proc>();
  kids = new Map<number, number[]>();
  metas = new Map<string, AgentMeta>();
  git = new Map<string, { at: number; root?: string; branch?: string; dirty?: number }>();
  /** When each pane first appeared; panes that were already there when the deck started count as old. */
  born = new Map<string, number>();
  private bornReady = false;
  rows = new Map<string, Row>();
  private sent = new Map<string, string>();
  private listeners = new Set<(patch: Patch) => void>();
  private rebuildTimer?: Timer;
  insights = new Map<string, Insight>();
  appThreads: AppThread[] = [];
  hiddenApp = new Set<string>((() => { try { return JSON.parse(readFileSync(HIDDEN_FILE, "utf8")); } catch { return []; } })());
  private insightStamp = new Map<string, string>();
  listening: Listen[] = [];
  shared = new Map<number, string>(); // local port → tailnet URL (set by the server from `tailscale serve status`)
  checks = new Map<string, any>(); // project root → proof-of-done result (set by the server)

  onPatch(fn: (p: Patch) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start() {
    await this.discover();
    await Promise.all([this.refreshProcs(), ...[...this.sessions.values()].map((s) => this.refreshSnapshot(s))]);
    await this.refreshProcInfo(true);
    await Promise.all([this.refreshTails(), this.refreshMetas()]);
    this.rebuildNow();
    this.refreshGit();

    setInterval(() => this.discover(), 10_000);
    setInterval(() => { for (const s of this.sessions.values()) this.refreshSnapshot(s); }, 2_000);
    setInterval(() => this.refreshProcs(), 3_000);
    setInterval(() => this.refreshProcInfo(false), 15_000);
    setInterval(() => this.refreshTails(), 3_000);
    setInterval(() => this.refreshYoungProcInfo(), 2_000);
    setInterval(() => this.refreshMetas(), 4_000);
    setInterval(() => this.refreshGit(), 45_000);
    this.refreshPorts();
    setInterval(() => this.refreshPorts(), 6_000);
    if (codexAppInstalled()) {
      await this.refreshApp();
      setInterval(() => this.refreshApp(), 2_000);
    }
    this.refreshInsights(true);
    setInterval(() => this.refreshInsights(false), 1_500);
  }

  // ── dev servers ─────────────────────────────────────────────────────────
  private portsBusy = false;
  private async refreshPorts() {
    if (this.portsBusy) return;
    this.portsBusy = true;
    try {
      const l = await readListening();
      const sig = JSON.stringify(l.map((x) => [x.pid, x.port, x.cwd]));
      if (sig !== JSON.stringify(this.listening.map((x) => [x.pid, x.port, x.cwd]))) { this.listening = l; this.scheduleRebuild(); }
    } catch {}
    this.portsBusy = false;
  }
  /** Ports owned by the pane's process tree; then servers started from its project folder that no pane owns. */
  private attachPorts(rows: Map<string, Row>) {
    const self = Number(process.env.DECK_PORT ?? 4747);
    // Dev servers, not plumbing: no ephemeral ports (MCP servers and helpers), one entry per port.
    const listen = this.listening.filter((x, i, a) => a.findIndex((y) => y.port === x.port) === i).filter((x) => x.port !== self && x.port >= 1024 && x.port < 32768 && !/mcp|^iii$/i.test(x.cmd) && !/^(ollama|Tailscale|tailscaled|rapportd|ControlCenter|Spotify|Dropbox|com\.docker|figma_agent|redis-server|postgres|mysqld|herdr|OneDrive|Code Helper|Cursor|Electron|node_repl)$/i.test(x.cmd));
    const owned = new Set<number>();
    for (const s of this.sessions.values()) {
      for (const [paneId, pi] of s.procInfo) {
        const row = rows.get(`${s.name}/${paneId}`);
        if (!row) continue;
        const pids = new Set(treePids(pi.shellPid, this.kids));
        const mine = listen.filter((x) => pids.has(x.pid));
        mine.forEach((x) => owned.add(x.pid));
        if (mine.length) row.ports = mine.map((x) => ({ port: x.port, addr: x.addr, cmd: x.cmd }));
      }
    }
    const byRecent = [...rows.values()].filter((r) => r.projectRoot && !r.app).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    for (const x of listen) {
      if (owned.has(x.pid) || !x.cwd) continue;
      const r = byRecent.find((r) => x.cwd === r.projectRoot || x.cwd!.startsWith(r.projectRoot + "/") || x.cwd === r.cwd);
      if (r && !(r.ports ?? []).some((p) => p.port === x.port)) (r.ports ??= []).push({ port: x.port, addr: x.addr, cmd: x.cmd });
    }
    for (const r of rows.values()) {
      if (r.ports) { r.ports.sort((a, b) => a.port - b.port); for (const p of r.ports) p.url = this.shared.get(p.port); }
      if (r.projectRoot && this.checks.has(r.projectRoot)) r.check = this.checks.get(r.projectRoot);
    }
  }

  // ── Codex desktop app threads ────────────────────────────────────────────

  private appBusy = false;
  private async refreshApp() {
    if (this.appBusy) return;
    this.appBusy = true;
    try {
      this.appThreads = await listAppThreads(this.hiddenApp);
      await Promise.all(this.appThreads.map((t) => codexMeta(t.id).then((m) => { this.metas.set(`codex-app/${t.id}`, m); }).catch(() => {})));
      this.scheduleRebuild();
    } catch {}
    this.appBusy = false;
  }

  /** When you last looked at each session, by row key → its lastActiveAt at that moment. Shared by every device. */
  seen: Record<string, number> = (() => { try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); } catch { return {}; } })();
  markSeen(key: string) {
    const r = this.rows.get(key);
    if (!r) return false;
    this.seen[key] = r.lastActiveAt ?? Date.now();
    for (const k of Object.keys(this.seen)) if (!this.rows.has(k) && Object.keys(this.seen).length > 400) delete this.seen[k];
    try { writeFileSync(SEEN_FILE, JSON.stringify(this.seen)); } catch {}
    this.rebuildNow();
    return true;
  }
  private isSeen(key: string, lastActiveAt?: number) {
    const s = this.seen[key];
    return s != null && s >= (lastActiveAt ?? 0);
  }

  hideAppThread(id: string) {
    this.hiddenApp.add(id);
    try { writeFileSync(HIDDEN_FILE, JSON.stringify([...this.hiddenApp])); } catch {}
    this.appThreads = this.appThreads.filter((t) => t.id !== id);
    this.rebuildNow();
  }

  // ── transcripts: real project, live activity, subagents ──────────────────

  private insightBusy = false;
  /** Working sessions refresh every tick; the rest only when their activity stamp moves. */
  private async refreshInsights(all: boolean) {
    if (this.insightBusy) return;
    this.insightBusy = true;
    try {
      let changed = false;
      for (const r of [...this.rows.values()]) {
        if (!r.sessionId) continue;
        const live = r.status === "working" || r.status === "blocked" || !!r.subagents?.some((x) => x.running);
        const stamp = `${r.sessionId}:${r.lastActiveAt}:${r.status}`;
        if (!all && !live && this.insightStamp.get(r.key) === stamp) continue;
        this.insightStamp.set(r.key, stamp);
        const ins = await insightFor({ agent: r.agent, sessionId: r.sessionId, cwd: r.cwd });
        const before = JSON.stringify(this.insights.get(r.key) ?? null);
        if (ins) this.insights.set(r.key, ins); else this.insights.delete(r.key);
        if (JSON.stringify(ins ?? null) !== before) changed = true;
        if (all) await Bun.sleep(0); // let requests through while warming every transcript
      }
      for (const k of this.insights.keys()) if (!this.rows.has(k)) { this.insights.delete(k); this.insightStamp.delete(k); }
      if (changed) this.scheduleRebuild();
    } finally {
      this.insightBusy = false;
    }
  }

  // ── discovery & event stream ─────────────────────────────────────────────

  private async discover() {
    for (const h of discoverSessions()) {
      let s = this.sessions.get(h.name);
      if (!s) {
        s = { ...h, online: false, events: 0, procInfo: new Map(), tails: new Map() };
        this.sessions.set(h.name, s);
      }
      if (!s.unsub) this.connect(s);
    }
  }

  private async connect(s: Sess) {
    try {
      s.unsub = await subscribe(
        s.socket,
        () => {
          s.events++;
          s.lastEventAt = Date.now();
          this.scheduleSnapshot(s);
        },
        () => {
          s.unsub = undefined;
          s.online = false;
          this.scheduleRebuild();
        },
      );
      s.online = true;
      s.error = undefined;
    } catch (e: any) {
      s.online = false;
      s.error = e?.code === "ENOENT" || e?.code === "ECONNREFUSED" ? "stopped" : String(e?.message ?? e);
    }
  }

  /** Events arrive in bursts (a tab close emits several); coalesce into one snapshot. */
  private scheduleSnapshot(s: Sess) {
    if (s.refreshTimer) return;
    s.refreshTimer = setTimeout(async () => {
      s.refreshTimer = undefined;
      await this.refreshSnapshot(s);
      const missing = (s.snap?.panes ?? []).filter((p: any) => !s.procInfo.has(p.pane_id));
      if (missing.length) await this.refreshProcInfo(false, s, missing.map((p: any) => p.pane_id));
    }, 30);
  }

  private async refreshSnapshot(s: Sess) {
    try {
      const r = await call(s.socket, "session.snapshot");
      s.snap = r.snapshot;
      s.online = true;
      s.error = undefined;
    } catch (e: any) {
      if (s.online) s.error = String(e?.message ?? e);
      s.online = false;
      if (e?.code === "ENOENT" || e?.code === "ECONNREFUSED") s.error = "stopped";
    }
    this.scheduleRebuild();
  }

  // ── enrichment ───────────────────────────────────────────────────────────

  private async refreshProcs() {
    try {
      this.procs = await readProcs();
      this.kids = childrenIndex(this.procs);
      this.scheduleRebuild();
    } catch {}
  }

  private async refreshProcInfo(all: boolean, only?: Sess, paneIds?: string[]) {
    const jobs: Promise<void>[] = [];
    for (const s of only ? [only] : this.sessions.values()) {
      if (!s.online || !s.snap) continue;
      const ids: string[] = paneIds ?? s.snap.panes.map((p: any) => p.pane_id);
      for (const id of ids) {
        jobs.push(
          call(s.socket, "pane.process_info", { pane_id: id })
            .then((r) => { s.procInfo.set(id, { shellPid: r.process_info.shell_pid, fg: r.process_info.foreground_processes ?? [] }); })
            .catch(() => {}),
        );
      }
      const live = new Set(s.snap.panes.map((p: any) => p.pane_id));
      for (const id of s.procInfo.keys()) if (!live.has(id)) s.procInfo.delete(id);
    }
    await Promise.all(jobs);
    if (all || jobs.length) this.scheduleRebuild();
  }

  /** Shells take seconds to start; keep re-checking what young panes are running. */
  private async refreshYoungProcInfo() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.online || !s.snap) continue;
      const young = s.snap.panes
        .map((p: any) => p.pane_id)
        .filter((id: string) => {
          const pi = s.procInfo.get(id);
          const started = pi && this.procs.get(pi.shellPid)?.startedAt;
          return !pi || !started || now - started < 60_000;
        });
      if (young.length) await this.refreshProcInfo(false, s, young);
    }
  }

  private async refreshTails() {
    const jobs: Promise<void>[] = [];
    for (const s of this.sessions.values()) {
      if (!s.online || !s.snap) continue;
      for (const p of s.snap.panes) {
        jobs.push(
          call(s.socket, "pane.read", { pane_id: p.pane_id, source: "recent", lines: 80 })
            .then((r) => { s.tails.set(p.pane_id, cleanTail(r.read?.text ?? "", 4)); })
            .catch(() => {}),
        );
      }
    }
    await Promise.all(jobs);
    this.scheduleRebuild();
  }

  private async refreshMetas() {
    const claimed = new Set<string>();
    const jobs: Promise<void>[] = [];
    const opencodePanes: [string, any][] = [];
    for (const s of this.sessions.values()) {
      if (!s.online || !s.snap) continue;
      for (const p of s.snap.panes) {
        const key = `${s.name}/${p.pane_id}`;
        const id = p.agent_session?.value;
        if (p.agent === "claude" && id) jobs.push(claudeMeta(id).then((m) => { this.metas.set(key, m); }).catch(() => {}));
        else if (p.agent === "codex" && id) jobs.push(codexMeta(id).then((m) => { this.metas.set(key, m); }).catch(() => {}));
        else if (p.agent === "opencode") {
          if (id) claimed.add(id);
          opencodePanes.push([key, p]);
        } else this.metas.delete(key);
      }
    }
    await Promise.all(jobs);
    // Panes with a known id or an exact title claim their sessions before directory-only guesses run.
    opencodePanes.sort((a, b) => Number(!!b[1].agent_session?.value) - Number(!!a[1].agent_session?.value));
    for (const [key, p] of opencodePanes) {
      const m = opencodeMeta({ id: p.agent_session?.value, cwd: p.cwd, terminalTitle: p.terminal_title_stripped, claimed });
      if (m) {
        if (m.sessionId) claimed.add(m.sessionId);
        this.metas.set(key, m);
      } else this.metas.delete(key);
    }
    this.scheduleRebuild();
  }

  private async refreshGit() {
    const cwds = new Set<string>(this.appThreads.map((t) => t.cwd));
    for (const s of this.sessions.values()) for (const p of s.snap?.panes ?? []) cwds.add(p.cwd);
    const queue = [...cwds];
    const worker = async () => {
      for (let cwd; (cwd = queue.shift()); ) {
        try {
          const root = await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
          if (!root) { this.git.set(cwd, { at: Date.now() }); continue; }
          const st = await sh(["git", "-C", cwd, "status", "--porcelain=v1", "-b", "--untracked-files=no"]);
          const lines = st.split("\n").filter(Boolean);
          const branch = lines[0]?.replace(/^## /, "").split("...")[0].replace(/^No commits yet on /, "");
          this.git.set(cwd, { at: Date.now(), root, branch, dirty: Math.max(0, lines.length - 1) });
        } catch {}
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    this.scheduleRebuild();
  }

  // ── rows ─────────────────────────────────────────────────────────────────

  private scheduleRebuild() {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.rebuildNow();
    }, 25);
  }

  rebuildNow() {
    const rows = new Map<string, Row>();
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.online || !s.snap) continue;
      const tabs = new Map<string, any>(s.snap.tabs.map((t: any) => [t.tab_id, t]));
      const wss = new Map<string, any>(s.snap.workspaces.map((w: any) => [w.workspace_id, w]));
      const rects = new Map<string, { width: number; height: number }>();
      for (const l of s.snap.layouts ?? []) for (const lp of l.panes ?? []) rects.set(lp.pane_id, lp.rect);
      for (const p of s.snap.panes) {
        const key = `${s.name}/${p.pane_id}`;
        const tab = tabs.get(p.tab_id) ?? {};
        const pi = s.procInfo.get(p.pane_id);
        const meta = this.metas.get(key);
        const shell = pi ? this.procs.get(pi.shellPid) : undefined;
        const usage = pi ? treeUsage(pi.shellPid, this.procs, this.kids) : { rssKB: 0, cpu: 0, count: 0 };
        const fg = pi?.fg ?? [];
        const shellOnly = !p.agent && !!pi && isShellOnly(fg);
        const agentProc = fg.find((f) => f.argv0 === p.agent || f.name === p.agent) ?? fg.find((f) => /claude|codex|opencode/.test(f.cmdline ?? ""));
        const lead = fg[fg.length - 1];
        const g = this.git.get(p.cwd);
        const empty = shellOnly || (!!p.agent && !!meta?.empty);
        const lastActiveAt = meta?.lastActiveAt;
        let termTitle = cleanTitle(p.terminal_title_stripped, basename(p.cwd));
        // A title that is just the launch command ("claude --dangerously-…") says nothing about the work.
        if (p.agent && (termTitle === p.agent || termTitle.startsWith(`${p.agent} `))) termTitle = "";
        // A name you gave the pane (rename) beats every guess.
        const title = p.label?.trim() ? p.label.trim()
          : meta?.title && p.agent === "opencode" ? meta.title
          : termTitle || meta?.title || shortPrompt(meta?.firstPrompt) || p.label || (shellOnly ? "shell" : lead?.cmdline ?? "");
        const ins = this.insights.get(key);
        let status = empty && p.agent_status !== "working" ? "empty" : p.agent_status ?? "unknown";
        // herdr reads the screen; Codex also writes explicit turn markers. An open turn that started in the
        // last few hours is work in progress even when the screen looks quiet.
        if (p.agent === "codex" && (status === "idle" || status === "unknown" || status === "empty") && ins?.turnOpen && ins.turnStartedAt && Date.now() - ins.turnStartedAt < 3 * 3600_000) status = "working";
        const cwdRoot = projectRoot(p.cwd) ?? g?.root ?? p.cwd;
        const projRoot = ins?.project?.root ?? cwdRoot;
        if (!this.born.has(key)) this.born.set(key, this.bornReady ? Date.now() : 0);
        rows.set(key, {
          key,
          bornAt: this.born.get(key) || undefined,
          herdr: s.name,
          workspaceId: p.workspace_id,
          workspace: wss.get(p.workspace_id)?.label ?? p.workspace_id,
          tabId: p.tab_id,
          tab: tab.label ?? "",
          tabNumber: tab.number ?? 0,
          tabPanes: tab.pane_count ?? 1,
          paneId: p.pane_id,
          agent: p.agent ?? (shellOnly ? "shell" : lead?.name ?? "process"),
          status,
          focused: !!p.focused && s.snap.focused_pane_id === p.pane_id,
          title,
          firstPrompt: meta?.firstPrompt,
          lastMessage: meta?.lastMessage,
          cwd: p.cwd,
          project: basename(projRoot),
          projectRoot: projRoot,
          launch: projRoot !== cwdRoot ? basename(cwdRoot) : undefined,
          now: status === "working" || status === "blocked" ? ins?.now : undefined,
          step: ins?.todo, todos: ins?.todos,
          turnStartedAt: ins?.turnStartedAt,
          subagents: ins?.subagents?.length ? ins.subagents.map((x) => ({ id: x.id, type: x.type, description: x.description, model: x.model, running: x.running, now: x.running ? x.now : undefined, startedAt: x.startedAt, lastActiveAt: x.lastActiveAt, tools: x.tools })) : undefined,
          branch: g?.branch,
          dirty: g?.dirty,
          startedAt: (agentProc && this.procs.get(agentProc.pid)?.startedAt) ?? shell?.startedAt,
          createdAt: meta?.createdAt,
          lastActiveAt,
          model: meta?.model,
          provider: meta?.provider,
          ctxTokens: meta?.ctxTokens,
          ctxWindow: meta?.ctxWindow,
          cost: meta?.cost,
          rssKB: usage.rssKB,
          cpu: Math.round(usage.cpu * 10) / 10,
          procs: usage.count,
          command: p.agent ? agentProc?.cmdline : lead?.cmdline,
          sessionId: meta?.sessionId ?? p.agent_session?.value,
          resume: resumeCommand(p.agent, meta?.sessionId ?? p.agent_session?.value),
          tail: s.tails.get(p.pane_id) ?? [],
          cols: rects.get(p.pane_id)?.width,
          rows: rects.get(p.pane_id)?.height ?? p.scroll?.viewport_rows,
          empty,
          stale: !!lastActiveAt && now - lastActiveAt > STALE_MS && status !== "working" && status !== "blocked",
          seen: this.isSeen(key, lastActiveAt),
          duplicate: false,
          approx: !!meta?.approx,
        });
      }
    }
    for (const t of this.appThreads) {
      const key = `codex-app/${t.id}`;
      const meta = this.metas.get(key);
      const ins = this.insights.get(key);
      const g = this.git.get(t.cwd);
      // Threads started from the app's own scratch folders (~/Documents/Codex/<date-slug>) aren't about a project.
      const scratch = /\/Documents\/Codex\/[^/]+\/?$/.test(t.cwd);
      const cwdRoot = scratch ? "Codex chat" : projectRoot(t.cwd) ?? g?.root ?? t.cwd;
      const projRoot = ins?.project && ins.project.root !== projectRoot(t.cwd) ? ins.project.root : cwdRoot;
      const lastActiveAt = Math.max(meta?.lastActiveAt ?? 0, t.updatedAt ?? 0) || undefined;
      rows.set(key, {
        key, herdr: "codex-app", workspaceId: "codex-app", workspace: "Codex app", tabId: t.id, tab: "", tabNumber: 0, tabPanes: 1, paneId: t.id,
        agent: "codex", status: t.status, focused: false, title: t.title, firstPrompt: meta?.firstPrompt, lastMessage: meta?.lastMessage,
        cwd: t.cwd, project: basename(projRoot), projectRoot: scratch && projRoot === cwdRoot ? undefined : projRoot, launch: projRoot !== cwdRoot && !scratch ? basename(cwdRoot) : undefined,
        now: t.status === "working" ? ins?.now : undefined, step: ins?.todo, todos: ins?.todos, turnStartedAt: t.turnStartedAt ?? ins?.turnStartedAt,
        subagents: ins?.subagents?.length ? ins.subagents : undefined,
        branch: t.branch ?? g?.branch, dirty: g?.dirty, createdAt: t.createdAt ?? meta?.createdAt, lastActiveAt,
        model: meta?.model, ctxTokens: meta?.ctxTokens, ctxWindow: meta?.ctxWindow, cost: meta?.cost,
        rssKB: 0, cpu: 0, procs: 0, sessionId: t.id, resume: resumeCommand("codex", t.id), tail: [],
        empty: false, stale: !!lastActiveAt && now - lastActiveAt > STALE_MS && t.status === "idle", duplicate: false, approx: false, app: "codex",
        seen: this.isSeen(key, lastActiveAt),
      });
    }
    // Two panes on the same agent conversation: one of them is redundant.
    const bySession = new Map<string, Row[]>();
    for (const r of rows.values()) {
      if (!r.sessionId) continue;
      const k = `${r.agent}:${r.sessionId}`;
      bySession.set(k, [...(bySession.get(k) ?? []), r]);
    }
    for (const group of bySession.values()) if (group.length > 1) for (const r of group) r.duplicate = true;
    this.attachPorts(rows);

    this.rows = rows;
    this.bornReady = true;
    this.emit();
  }

  summary() {
    return {
      at: Date.now(),
      herdr: [...this.sessions.values()].map((s) => ({ name: s.name, online: s.online, error: s.error, version: s.snap?.version })),
    };
  }

  health() {
    return {
      rows: this.rows.size,
      herdr: [...this.sessions.values()].map((s) => ({ name: s.name, online: s.online, subscribed: !!s.unsub, events: s.events, lastEventAt: s.lastEventAt })),
    };
  }

  private emit() {
    const upsert: Row[] = [];
    const remove: string[] = [];
    for (const [k, r] of this.rows) {
      const json = JSON.stringify(r);
      if (this.sent.get(k) !== json) {
        this.sent.set(k, json);
        upsert.push(r);
      }
    }
    for (const k of this.sent.keys()) if (!this.rows.has(k)) { this.sent.delete(k); remove.push(k); }
    const summary = this.summary();
    const summaryJson = JSON.stringify(summary.herdr);
    if (!upsert.length && !remove.length && summaryJson === this.lastSummary) return;
    this.lastSummary = summaryJson;
    for (const fn of this.listeners) fn({ upsert, remove, summary });
  }
  private lastSummary = "";

  /** Public so the server can push new tailnet links / check results into the rows. */
  refresh() { this.scheduleRebuild(); }

  find(key: string) {
    const r = this.rows.get(key);
    const s = r && this.sessions.get(r.herdr);
    return r && s ? { row: r, sess: s } : undefined;
  }

  /** Force a fresh snapshot right after an action so the UI reflects it without waiting for events. */
  async kick(herdr: string) {
    const s = this.sessions.get(herdr);
    if (s) await this.refreshSnapshot(s);
  }
}

export type Patch = { upsert: Row[]; remove: string[]; summary: ReturnType<Deck["summary"]> };

function shortPrompt(p?: string) {
  if (!p) return "";
  return p.length > 80 ? p.slice(0, 79) + "…" : p;
}

/** Agents decorate terminal titles: OpenCode prefixes "OC | ", Codex appends " | <dir>". */
export function cleanTitle(t: string | undefined, dir: string) {
  let s = (t ?? "").replace(/^OC \| /, "").trim();
  if (s.endsWith(` | ${dir}`)) s = s.slice(0, -(dir.length + 3));
  return s === "OpenCode" || s === "Claude Code" ? "" : s;
}

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return p.exitCode === 0 ? out.trim() : "";
}
