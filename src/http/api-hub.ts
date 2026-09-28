// The deck's own API, part 1: push and automations, history, tools, machines, decisions, Jev and MCP.
// Each function answers the paths it knows and returns undefined for the rest (src/http/routes.ts tries them in turn).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { splitKey, type RemoteHost } from "../federation";
import { saveCustomTools } from "../tools";
import { historyProjects, historySession, historyStats, rescanHistory, searchHistory } from "../history";
import { recordOutcome } from "../decisions";
import { RECEIPTS_FILE, cachedById, jevUsage, setJevCap, setJevFeature } from "../jev";
import { statsFor } from "../jevstats";
import { readAudit } from "../mcp";
import { endpointOk, type Message } from "../push";
import { routeMessage } from "../route";
import type { Row } from "../deck";
import { json } from "./page";
import type { Hub } from "./hub";

export async function hubApi(hub: Hub, path: string, body: any): Promise<Response | undefined> {
  const { DEV, PORT, SELF, deck, push, auto, fakeRows, presence, decisions, scheduleDecisions, fullState } = hub;
  const { remotes, isNode, allRows, machines, localRow, addRemote, saveHosts, fakeRowsChanged } = hub.hosts;
  const { broadcast } = hub.sse;
  const { startSession, sendText } = hub.sessions;
  const { resolveTool, runToolLocal, relatedFor, historyEverywhere } = hub.tools;
  const MCP_TOKEN = hub.mcp.token;
  switch (path) {
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
      const m: Message = { kind: "test", title: "herdr deck", body: `Push works on “${dev.label}”. ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`, tag: "test", url: body.url ? String(body.url).slice(0, 300) : "/" };
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
      if (body.clear) fakeRows.clear();
      for (const r of body.rows ?? []) fakeRows.set(String(r.key), { machine: "fake", herdr: "fake", workspaceId: "fake", workspace: "Fake", tabId: String(r.key), tab: "", tabNumber: 0, tabPanes: 1, paneId: String(r.key), agent: "claude", status: "idle", focused: false, title: "fake", cwd: "/tmp", project: "fake", rssKB: 0, cpu: 0, procs: 0, tail: [], empty: false, stale: false, duplicate: false, approx: false, ...r } as Row);
      fakeRowsChanged();
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
            results.push({ key, ok: true, n: rel.n, text: rel.text });
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
    case "/api/machines": {
      if (body.op === "add") {
        const ssh = String(body.ssh ?? "").trim();
        if (!/^[\w.@-]+$/.test(ssh)) return json({ error: "Use an SSH host from your ~/.ssh/config, like my-server or me@host" }, 400);
        const label = String(body.label ?? "").trim().slice(0, 40) || ssh;
        const id = (String(body.id ?? "") || label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "machine";
        if (id === SELF.id || remotes.has(id)) return json({ error: `There's already a machine called “${id}”` }, 400);
        const p = Bun.spawn([`${import.meta.dir}/../../bin/deploy-node.sh`, ssh], { stdout: "pipe", stderr: "pipe" });
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
  }
}
