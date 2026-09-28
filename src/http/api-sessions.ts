// The deck's own API, part 3: one session (its detail, chat, terminal, files, sharing and checks) and acting on
// sessions (start, send, type, rename, close, reopen, queue, recipes).
import { splitKey } from "../federation";
import { fillTool } from "../tools";
import { approvalFor, detectCheck, resultFor, setApproval, verify } from "../verify";
import { share, unshare } from "../share";
import { writeBrief } from "../brief";
import { subagentsFor } from "../insight";
import { slashCommands } from "../slash";
import { call } from "../herdr";
import { json } from "./page";
import { readFileFor, resolveSafe } from "./files";
import { newSessionOptions } from "./new-session";
import type { Hub } from "./hub";
import { codexApi } from "./codex";
import { codexLifecycleApi } from "./codex-lifecycle";

export async function sessionsApi(hub: Hub, path: string, body: any): Promise<Response | undefined> {
  const lifecycle = await codexLifecycleApi(hub, path, body);
  if (lifecycle) return lifecycle;
  const native = await codexApi(hub, path, body);
  if (native) return native;
  const { deck, graves, broadcastGraves, refreshShared, pluginHost } = hub;
  const { remotes, allRows, localRow } = hub.hosts;
  const { reopen, startSession, sendText, sendAny, closeLocal } = hub.sessions;
  const { who, detailFor, chatSlice, chatFor, detailPayload, briefKey, searchLocal } = hub.chat;
  const { queues, saveQueues } = hub.queue;
  switch (path) {
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
    case "/api/queue": {
      const key = String(body.key ?? "");
      const q = (queues[key] ??= []);
      if (body.op === "add") {
        const text = String(body.text ?? "").trim();
        if (!text) return json({ error: "empty" }, 400);
        q.push({ id: crypto.randomUUID().slice(0, 8), text: text.slice(0, 200_000), at: Date.now() });
      } else if (body.op === "remove") queues[key] = q.filter((x) => x.id !== body.id);
      else if (body.op === "update") { const it = q.find((x) => x.id === body.id); if (it) { it.text = String(body.text ?? it.text).trim() || it.text; it.id = crypto.randomUUID(); delete it.error; } }
      else if (body.op === "now") {
        const it = q.find((x) => x.id === body.id);
        if (it) {
          try { await sendAny(key, it.text, { requestId: it.id }); }
          catch (e: any) { it.error = e.message; saveQueues(); throw e; }
          queues[key] = q.filter((x) => x !== it); saveQueues(); return json({ ok: true, queue: queues[key] ?? [] });
        }
      } else if (body.op === "clear") delete queues[key];
      saveQueues();
      return json({ ok: true, queue: queues[key] ?? [] });
    }
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
      if (process.platform !== "darwin") return json({ error: "Open this thread in the Codex app on its host machine." }, 400);
      Bun.spawn(["open", `codex://threads/${lr.sessionId}`]);
      return json({ ok: true });
    }
    case "/api/codex-resume": {
      // Continues an app thread in a new herdr tab with the Codex CLI.
      const lr = localRow(body.key);
      if (!lr?.app || !lr.sessionId) return json({ error: "not a Codex app thread" }, 400);
      if (lr.status === "working" || lr.status === "blocked") return json({ error: "Finish or stop this turn in the Codex app before continuing in herdr." }, 409);
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
      return json({ ...await newSessionOptions(deck, graves), codexApp: hub.codexLifecycle?.capabilities() });
    case "/api/new":
      pluginHost.service<{ mkdirRun(b: unknown): void }>("game")?.mkdirRun(body); // a quest run's new folder, only now that you confirmed the dialog
      return json(await startSession(body));
    case "/api/detail": {
      const lr = localRow(body.key);
      if (!lr) return json({ error: "gone" }, 404);
      const f = { row: lr };
      const d = await detailFor(f.row);
      const subagents = await subagentsFor(who(f.row), d).catch(() => []);
      // `chat: false`: the page already holds this chat and keeps it fresh with /api/chat.
      return json({ ...detailPayload(f.row, d, !!body.lite), subagents, chat: d && body.chat !== false ? chatSlice(d, { limit: body.limit }) : undefined });
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
      await sendText(body.key, String(body.text ?? ""), { requestId: body.requestId, onlyIdle: !!body.onlyIdle });
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
      graves.list = body.all ? [] : graves.list.filter((g) => g.id !== body.id);
      graves.save();
      broadcastGraves();
      return json({ ok: true });
    }
  }
}
