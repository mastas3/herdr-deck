// What a snapshot keeps of each pane, how two snapshots compare, when vanished panes look like a crash, and the command
// that brings a session back with the flags it ran with. Pure functions: server.ts feeds them rows and the clock.
import type { Row } from "../../src/deck";

export type SnapPane = {
  key: string; herdr: string; workspaceId: string; workspace: string; tabId: string; tab: string; tabNumber: number; paneId: string;
  cwd: string; agent: string; title: string; project: string; status: string; empty: boolean;
  sessionId?: string; resume?: string; command?: string; model?: string;
};
export type Snapshot = { id: string; machine: string; at: number; seenAt: number; panes: SnapPane[] };
export type Crash = {
  id: string; machine: string; at: number; snapshotId: string; snapshotAt: number;
  reason: "restarted" | "vanished" | "fewer";
  /** Panes of the snapshot worth restoring that are gone now (recounted every tick; 0 closes the crash). */
  lost: number; total: number; dismissed?: boolean;
};

/** A local herdr pane (not a Codex app thread, a past session or a test row). */
export const isPane = (r: Row) => !r.app && !r.hist && r.herdr !== "codex-app" && r.herdr !== "history";

export function paneOf(r: Row): SnapPane {
  return {
    key: r.key, herdr: r.herdr, workspaceId: r.workspaceId, workspace: r.workspace, tabId: r.tabId, tab: r.tab, tabNumber: r.tabNumber, paneId: r.paneId,
    cwd: r.cwd, agent: r.agent, title: r.title, project: r.project, status: r.status, empty: r.empty,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.resume ? { resume: r.resume } : {}),
    ...(r.command ? { command: r.command.slice(0, 400) } : {}), ...(r.model ? { model: r.model } : {}),
  };
}

/** What makes two snapshots different: panes, their conversations, folders and names (not status or activity). */
export const sigOf = (panes: SnapPane[]) => JSON.stringify(panes.map((p) => [p.key, p.sessionId ?? "", p.cwd, p.agent, p.workspace, p.tab]).sort());

/** An agent conversation can be resumed; a plain shell only reopens in its folder; an empty one isn't worth it. */
export const isAgent = (p: SnapPane) => !!p.resume;
export const worthRestoring = (p: SnapPane) => isAgent(p) || (!p.empty && p.agent !== "shell");

/** Still open now: the same conversation anywhere (panes move and get new ids), or the same pane in the same folder. */
export function stillOpen(p: SnapPane, now: SnapPane[]) {
  if (p.sessionId) return now.some((x) => x.sessionId === p.sessionId);
  return now.some((x) => x.key === p.key && x.cwd === p.cwd && x.agent === p.agent);
}

/** Panes of `before` worth restoring that aren't open now (and weren't closed on purpose from the deck). */
export function lostPanes(before: SnapPane[], now: SnapPane[], closed: Set<string> = new Set()) {
  return before.filter((p) => worthRestoring(p) && !stillOpen(p, now) && !(p.sessionId && closed.has(p.sessionId)));
}

/**
 * Does this drop look like a crash? When herdr went away (its socket dropped, or every pane vanished) a few lost
 * sessions are enough; otherwise it takes most of them at once, so closing one workspace by hand doesn't count.
 */
export function looksLikeCrash(o: { lost: number; before: number; restarted: boolean; minLost: number }) {
  if (o.lost < Math.max(1, o.minLost)) return false;
  return o.restarted || o.lost >= Math.max(5, Math.ceil(o.before * 0.6));
}

// Flags worth keeping on resume, per agent: `name: takes a value`. Anything else (a prompt, --resume, -c/--continue
// for Claude) is dropped.
const KEEP: Record<string, Record<string, boolean>> = {
  claude: { "--model": true, "--effort": true, "--permission-mode": true, "--dangerously-skip-permissions": false, "--allow-dangerously-skip-permissions": false, "--add-dir": true, "--fallback-model": true, "--agent": true },
  codex: { "-m": true, "--model": true, "-c": true, "--config": true, "-s": true, "--sandbox": true, "-a": true, "--ask-for-approval": true, "-p": true, "--profile": true, "--dangerously-bypass-approvals-and-sandbox": false, "--search": false, "--add-dir": true },
  opencode: { "-m": true, "--model": true, "--agent": true },
};
/** A shell word as typed: plain when it's safe, single-quoted otherwise. */
export const shq = (s: string) => (/^[\w./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The flags the agent was started with (from its command line), limited to the ones above. */
export function keptFlags(agent: string, command?: string): string[] {
  const keep = KEEP[agent];
  if (!keep || !command) return [];
  const words = command.trim().split(/\s+/);
  const start = words.findIndex((w) => w === agent || w.endsWith(`/${agent}`) || w.endsWith(`/${agent}.js`));
  const out: string[] = [];
  for (let i = start < 0 ? 0 : start + 1; i < words.length; i++) {
    const w = words[i];
    const [name, inline] = w.startsWith("--") && w.includes("=") ? [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)] : [w, undefined];
    if (!(name in keep)) continue;
    if (!keep[name]) { out.push(name); continue; }
    const v = inline ?? words[++i];
    if (v == null || (inline == null && v.startsWith("-"))) continue;
    out.push(name, shq(v));
  }
  return out;
}

/** The deck's resume command (src/agents.ts resumeCommand) plus the model and permission flags the pane ran with. */
export function restoreCommand(p: SnapPane): string | undefined {
  if (!p.resume) return;
  const flags = keptFlags(p.agent, p.command);
  if (!flags.length) return p.resume;
  if (p.agent === "codex") return p.resume.replace(/^codex resume /, `codex resume ${flags.join(" ")} `);
  return `${p.resume} ${flags.join(" ")}`;
}

/** The order to reopen them in: by workspace (as it was), then tab number, then pane. */
export function restoreOrder(panes: SnapPane[]) {
  const wsOrder = new Map<string, number>();
  for (const p of panes) if (!wsOrder.has(p.workspaceId)) wsOrder.set(p.workspaceId, wsOrder.size);
  return [...panes].sort((a, b) => (wsOrder.get(a.workspaceId)! - wsOrder.get(b.workspaceId)!) || a.tabNumber - b.tabNumber || a.paneId.localeCompare(b.paneId));
}
