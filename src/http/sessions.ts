// Acting on sessions through herdr: close (remembering them in the graveyard), reopen, start, and send text.
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { splitKey, type RemoteHost } from "../federation";
import { call } from "../herdr";
import { agentArgs } from "../args";
import type { Deck, Row } from "../deck";
import type { Graves } from "./config";
import { AGENT_KINDS } from "./new-session";
import { claudeProfileEnv } from "../claude-profiles";
import type { CodexControl } from "../codex-control";
import { codexUploadImages } from "./codex";
import { isShellOnly } from "../tail";
import { installCommand } from "../wt-git";
import { discardWorktree, makeWorktree } from "../wt-create";
import { createStartStore, type StartRecord, type StartStore } from "../session-starts";
import { claudeRecordedPrompt } from "../claude-first-message";

type SendOptions = { requestId?: string; onlyIdle?: boolean };
/** Where to reopen a session (a graveyard entry, or a crash-guard snapshot's pane). */
export type ReopenSpec = { herdr?: string; workspaceId?: string; workspace?: string; createWorkspace?: boolean; cwd: string; tab?: string; project?: string; resume?: string };

type Deps = {
  deck: Deck; graves: Graves; remotes: Map<string, RemoteHost>; broadcastGraves: () => void;
  notice: (data: { key?: string; ok: boolean; message: string }) => void;
  codex?: CodexControl;
  starts?: StartStore;
};

export function createSessions(o: Deps) {
  const { deck, graves, remotes, broadcastGraves, notice } = o;
  const starts = o.starts ?? createStartStore();
  const starting = new Map<string, Promise<any>>();
  const noteStart = (id: string, patch: Partial<StartRecord>) => { const r = starts.update(id, patch); deck.refresh?.(); return r; };

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
    const ids: string[] = []; // the page's Undo reopens exactly these
    for (const v of victims) {
      if (v.empty && !v.resume) continue; // nothing worth remembering
      const id = crypto.randomUUID();
      ids.push(id);
      graves.list.unshift({
        id,
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
    return { key, ok: true, closed: closeTab ? "tab" : "pane", graves: ids };
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

  /** Resolves once a command typed into the pane has finished: only the shell is in front again (15 minutes at most). */
  async function waitForShell(socket: string, paneId: string, timeoutMs = 15 * 60_000) {
    const start = Date.now();
    let seen = false, idle = 0;
    while (Date.now() - start < timeoutMs) {
      await Bun.sleep(1000);
      const r = await call(socket, "pane.process_info", { pane_id: paneId }).catch(() => null);
      const shellOnly = isShellOnly(r?.process_info?.foreground_processes);
      if (!shellOnly) { seen = true; idle = 0; continue; }
      // A command that never showed up in front (it was that quick) counts as done after a few seconds.
      if (++idle >= 2 && (seen || Date.now() - start > 4000)) return;
    }
  }

  /**
   * Opens a tab where a session used to be and resumes it there: the Closed list's Reopen, and plugins (crash-guard
   * restores many this way). Its workspace by id, else by name; when neither exists any more and `createWorkspace` is
   * set, a new workspace by that name (its first tab is the session's). Then waits for the shell's prompt and types
   * the resume command.
   */
  async function openTab(g: ReopenSpec) {
    const sess = (g.herdr ? deck.sessions.get(g.herdr) : undefined) ?? [...deck.sessions.values()].find((s) => s.online);
    if (!sess) throw new Error("no herdr server running");
    const wss: any[] = sess.snap?.workspaces ?? [];
    let ws: string | undefined = wss.find((w) => w.workspace_id === g.workspaceId)?.workspace_id ?? (g.workspace ? wss.find((w) => w.label === g.workspace)?.workspace_id : undefined);
    const label = g.tab || g.project;
    let paneId: string | undefined;
    if (!ws && g.workspace && g.createWorkspace) {
      const r = await call(sess.socket, "workspace.create", { cwd: g.cwd, label: g.workspace, focus: false });
      ws = r.workspace?.workspace_id;
      paneId = r.root_pane?.pane_id;
      if (label && r.tab?.tab_id) await call(sess.socket, "tab.rename", { tab_id: r.tab.tab_id, label }).catch(() => {});
    }
    if (!paneId) {
      const r = await call(sess.socket, "tab.create", { cwd: g.cwd, label, workspace_id: ws ?? null, focus: false });
      paneId = r.root_pane?.pane_id;
    }
    if (g.resume && paneId) {
      // A slow .zshrc can drop input typed before the first prompt, so wait for it.
      await waitForPrompt(sess.socket, paneId);
      await call(sess.socket, "pane.send_input", { pane_id: paneId, text: g.resume, keys: ["enter"] });
    }
    await deck.kick(sess.name);
    return { key: paneId ? `${sess.name}/${paneId}` : undefined, paneId, workspaceId: ws };
  }

  async function reopen(id: string) {
    const g = graves.list.find((x) => x.id === id);
    if (!g) throw new Error("not in graveyard");
    const { paneId } = await openTab(g);
    graves.list = graves.list.filter((x) => x.id !== id);
    graves.save();
    broadcastGraves();
    return { ok: true, paneId };
  }

  async function startSession(body: any) {
    const { record, fresh } = starts.begin(body);
    if (!fresh) {
      if (starting.has(record.id)) return starting.get(record.id);
      if (record.result?.key) return { ...record.result, requestId: record.id, startState: record.state, error: record.error };
      throw new Error(record.error || "This session start is already in progress. Check Saved starts.");
    }
    const work = runStart(body, record).catch(e => { noteStart(record.id, { state: ["timeout", "closed"].includes(e.code) ? "unknown" : "failed", error: e.message }); throw e; }).finally(() => starting.delete(record.id));
    starting.set(record.id, work);
    return work;
  }

  async function confirmClaude(socket: string, paneId: string, prompt: string, since: number) {
    const until = Date.now() + 60_000;
    do {
      const a = await call(socket, "agent.get", { target: paneId }).then(r => r.agent).catch(() => null);
      const id = a?.agent === "claude" && a.agent_session?.agent === "claude" ? a.agent_session.value : undefined;
      if (id && await claudeRecordedPrompt(id, prompt, since)) return id as string;
      await Bun.sleep(1000);
    } while (Date.now() < until);
  }

  async function runStart(body: any, receipt: StartRecord) {
    const kind = String(body.kind ?? "claude");
    if (kind !== "shell" && !AGENT_KINDS.has(kind)) throw new Error(`unknown agent "${kind}"`);
    const env = kind === "claude" ? claudeProfileEnv(body.claudeProfile) : undefined;
    let cwd = String(body.cwd ?? "").replace(/^~(?=\/|$)/, homedir());
    try {
      if (!statSync(cwd).isDirectory()) throw 0;
    } catch {
      throw new Error(`folder not found: ${cwd}`);
    }
    const sess = deck.sessions.get(body.herdr) ?? [...deck.sessions.values()].find((s) => s.online);
    if (!sess?.online) throw new Error("no herdr server running");
    // Own worktree: made before the tab, and taken away again if the tab can't be opened in it.
    const wt = body.worktree?.branch ? await makeWorktree(cwd, body.worktree) : undefined;
    if (wt) cwd = wt.cwd;
    // Only the command the lockfile calls for, never text from the request.
    const install = wt && body.worktree.install ? installCommand(wt.path)?.cmd : undefined;
    const ws = body.workspaceId ?? sess.snap?.focused_workspace_id ?? null;
    const label = String(body.label ?? "").trim() || cwd.split("/").pop() || kind;
    let r;
    try { r = await call(sess.socket, "tab.create", { cwd, label, workspace_id: ws, focus: false, ...(env ? { env } : {}) }); }
    catch (e: any) {
      // A lost reply can still have created the pane. Preserve its checkout until the user checks it.
      if (wt && !["timeout", "closed"].includes(e.code)) await discardWorktree(wt);
      throw e;
    }
    const paneId: string = r.root_pane?.pane_id;
    if (!paneId) throw new Error("herdr did not return the new pane. The first message is saved; check Saved starts before retrying.");
    const key = `${sess.name}/${paneId}`;
    const result = { key, paneId, requestId: receipt.id, ...(wt ? { worktree: { path: wt.path, branch: wt.branch, base: wt.base, cwd: wt.cwd } } : {}) };
    noteStart(receipt.id, { key, result, state: "starting" });
    await deck.kick(sess.name);

    // The rest waits on a slow shell and the agent's own startup; report progress over SSE.
    (async () => {
      try {
        if (install) {
          notice({ key, ok: true, message: `Waiting for the shell in “${label}”…` });
          await waitForPrompt(sess.socket, paneId, 30_000);
          notice({ key, ok: true, message: `Installing dependencies in the worktree (${install})…` });
          await call(sess.socket, "pane.send_input", { pane_id: paneId, text: install, keys: ["enter"] });
          await waitForShell(sess.socket, paneId);
        }
        if (kind !== "shell") {
          notice({ key, ok: true, message: `Waiting for the shell in “${label}”…` });
          await waitForPrompt(sess.socket, paneId, 30_000);
          const base = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 24) || kind;
          const name = `${base}-${Math.random().toString(36).slice(2, 6)}`;
          const args = agentArgs(kind, body);
          const prompt = String(body.prompt ?? "").trim();
          // Claude accepts its first message as one positional argument. This avoids the separate named-agent
          // handoff that herdr 0.7.5 can refuse after Claude has already opened successfully.
          const initialArg = kind === "claude" && !!prompt;
          if (initialArg) { args.push("--", prompt); noteStart(receipt.id, { state: "sending" }); }
          notice({ key, ok: true, message: `Starting ${kind}…` });
          let asked = false;
          let launchError: Error | undefined;
          try { await call(sess.socket, "agent.start", { name, kind, pane_id: paneId, args, timeout_ms: 90_000 }, 95_000); }
          catch (e: any) {
            if (initialArg) launchError = e;
            // The agent is up but opened on a question (Claude's "trust this folder?"): that's not a failure.
            else if (!/blocked|interactive input/i.test(String(e?.message ?? e))) throw e;
            await deck.kick(sess.name);
            asked = /blocked|interactive input/i.test(String(e?.message ?? e));
            if (asked) notice({ key, ok: true, message: `“${label}” is asking something first. Answer it in the terminal; your first message is saved.` });
          }
          if (initialArg) {
            const sessionId = await confirmClaude(sess.socket, paneId, prompt, receipt.createdAt);
            if (!sessionId) throw new Error(`First-message delivery is unconfirmed. Check the terminal before using the saved message again.${launchError ? ` ${launchError.message}` : ""}`);
            noteStart(receipt.id, { sessionId });
          } else if (prompt) {
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
              try { noteStart(receipt.id, { state: "sending" }); await call(sess.socket, "agent.prompt", { target: paneId, text: prompt }, 15_000); break; }
              catch (e: any) {
                if (Date.now() > until || !/not an active|not found|not ready|no agent/i.test(String(e?.message ?? e))) throw e;
                await Bun.sleep(1000);
              }
            }
          }
          notice({ key, ok: true, message: prompt ? `${kind} is running and has your first message` : `${kind} is ready` });
        }
        noteStart(receipt.id, { state: "ready", error: undefined });
        if (body.focus) await call(sess.socket, "pane.focus", { pane_id: paneId });
      } catch (e: any) {
        noteStart(receipt.id, { state: starts.get(receipt.id)?.state === "sending" ? "unknown" : "failed", error: e?.message ?? String(e) });
        notice({ key, ok: false, message: `Couldn’t start ${kind}: ${e?.message ?? e}` });
      }
      await deck.kick(sess.name);
    })();
    return result;
  }

  async function sendText(key: string, text: string, options: SendOptions = {}) {
    const row = deck.rows.get(key);
    if (row?.app && row.sessionId) {
      if (!o.codex) throw new Error("Codex app controls are unavailable");
      if (text.trim() === "/compact") { await o.codex.compact(row.sessionId); return; }
      await o.codex.send(row.sessionId, text, options.requestId ?? crypto.randomUUID(), options.onlyIdle, codexUploadImages(text));
      return;
    }
    const f = deck.find(key);
    if (!f) throw new Error("that session is gone");
    if (["claude", "codex", "opencode"].includes(f.row.agent)) await call(f.sess.socket, "agent.prompt", { target: f.row.paneId, text });
    else await call(f.sess.socket, "pane.send_input", { pane_id: f.row.paneId, text, keys: ["enter"] });
  }

  /** Send to a session on any machine. */
  async function sendAny(key: string, text: string, options: SendOptions = {}) {
    const route = splitKey(key, remotes);
    if (route.remote) {
      const r = await route.remote.post("/api/send", { key: route.key, text, ...options });
      if (r.status >= 300) throw Object.assign(new Error(r.data?.error ?? "send failed"), { code: r.data?.code });
    } else await sendText(key, text, options);
  }

  async function closeLocal(keys: string[], wholeTab: boolean) {
    const results = [];
    for (const k of keys) results.push(await closeRow(k, wholeTab));
    graves.save();
    broadcastGraves();
    for (const h of new Set(keys.map((k) => k.split("/")[0]))) await deck.kick(h);
    return results;
  }
  return { reopen, openTab, startSession, sendText, sendAny, closeLocal, starts };
}
export type Sessions = ReturnType<typeof createSessions>;
