// Acting on sessions through herdr: close (remembering them in the graveyard), reopen, start, and send text.
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { splitKey, type RemoteHost } from "../federation";
import { call } from "../herdr";
import { agentArgs } from "../args";
import type { Deck, Row } from "../deck";
import type { Graves } from "./config";
import { AGENT_KINDS } from "./new-session";

type Deps = {
  deck: Deck; graves: Graves; remotes: Map<string, RemoteHost>; broadcastGraves: () => void;
  notice: (data: { key?: string; ok: boolean; message: string }) => void;
};

export function createSessions(o: Deps) {
  const { deck, graves, remotes, broadcastGraves, notice } = o;

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

  async function reopen(id: string) {
    const g = graves.list.find((x) => x.id === id);
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
    graves.list = graves.list.filter((x) => x.id !== id);
    graves.save();
    broadcastGraves();
    await deck.kick(sess.name);
    return { ok: true, paneId };
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

  async function closeLocal(keys: string[], wholeTab: boolean) {
    const results = [];
    for (const k of keys) results.push(await closeRow(k, wholeTab));
    graves.save();
    broadcastGraves();
    for (const h of new Set(keys.map((k) => k.split("/")[0]))) await deck.kick(h);
    return results;
  }
  return { reopen, startSession, sendText, sendAny, closeLocal };
}
export type Sessions = ReturnType<typeof createSessions>;
