// This deck and the machines it mirrors (hosts.json): their sessions, graveyards and summary as one list, and
// whether this deck is a hub (it has machines, or nobody calls it) or a node (a hub talks to it).
import { writeFileSync } from "node:fs";
import { RemoteHost, type Machine, type RemoteConf } from "../federation";
import { historySession, type HistSession } from "../history";
import { codexAppInstalled, codexAppRunning } from "../codexapp";
import type { Deck, Row } from "../deck";
import type { Graves, HostsFile, Self } from "./config";

type Deps = {
  deck: Deck; self: Self; dataDir: string; hostsConf: HostsFile; graves: Graves; fakeRows: Map<string, Row>;
  // late-bound: they exist once the server has built everything
  broadcast: (event: string, data: unknown) => void; fullState: () => unknown; scheduleDecisions: () => void; observe: () => void;
};

export function createMachines(o: Deps) {
  const { deck, self: SELF, graves, fakeRows } = o;
  const remotes = new Map<string, RemoteHost>();
  let hubSeenAt = 0;
  const isNode = () => process.env.DECK_ROLE === "node" || (process.env.DECK_ROLE !== "hub" && remotes.size === 0 && Date.now() - hubSeenAt < 15 * 60_000);
  /** A request carried the node token: a hub is talking to this deck. */
  const hubSeen = () => { hubSeenAt = Date.now(); };

  function addRemote(conf: RemoteConf) {
    if (!conf?.id || !conf.ssh || conf.id === SELF.id || remotes.has(conf.id)) return;
    const host = new RemoteHost(conf, {
      patch: (upsert, remove) => { o.broadcast("patch", { upsert, remove, summary: summary() }); o.scheduleDecisions(); o.observe(); },
      full: () => o.broadcast("full", o.fullState()),
      graveyard: () => o.broadcast("graveyard", allGraves()),
      notice: (n) => o.broadcast("notice", n),
    });
    remotes.set(conf.id, host);
    return host;
  }
  const saveHosts = () => writeFileSync(`${o.dataDir}/hosts.json`, JSON.stringify({ ...o.hostsConf, remotes: [...remotes.values()].map((h) => h.conf) }, null, 2));

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
    const local = graves.list.slice(0, 100).map((g) => ({ ...g, machine: SELF.id }));
    const all = [...local, ...[...remotes.values()].flatMap((h) => h.graveyard)];
    return all.sort((a, b) => b.closedAt - a.closedAt).slice(0, 150);
  }
  const machineLabelOf = (id?: string) => machines().find((m) => m.id === id)?.label ?? id;
  return { remotes, isNode, hubSeen, addRemote, saveHosts, tagLocal, machines, localRow, summary, allRows, allGraves, machineLabelOf };
}
export type Machines = ReturnType<typeof createMachines>;
