// MCP: what other agents can do through the deck (src/mcp.ts speaks the protocol; this is the deck behind it).
import { splitKey, type RemoteHost } from "../federation";
import { inventory, inventoryText } from "../connections";
import { needsYou, type Decision } from "../decisions";
import { appendAudit, mcpToken, readAudit, type McpCtx } from "../mcp";
import type { Row } from "../deck";
import type { Detail } from "../transcript";

type Deps = {
  selfId: string; remotes: Map<string, RemoteHost>; allRows: () => Row[]; localRow: (key: string) => Row | undefined;
  machineLabelOf: (id?: string) => string | undefined; detailFor: (row: Row) => Promise<Detail | undefined>;
  searchLocal: (q: string) => Promise<any[]>; historyEverywhere: (o: any) => Promise<any[]>; decisions: Map<string, Decision>;
  sendText: (key: string, text: string) => Promise<void>; startSession: (body: any) => Promise<any>;
  notice: (data: { key?: string; ok: boolean; message: string }) => void; broadcast: (event: string, data: unknown) => void;
  library: { evidence: (q: string, k: number, use: any) => Promise<{ text: string }> };
};

/** Reads (or makes) the MCP token, so call it where startup wants that to happen. */
export function createMcp(deps: Deps) {
  const { selfId, remotes, allRows, localRow, machineLabelOf, detailFor, searchLocal, historyEverywhere, decisions, sendText, startSession, notice, broadcast, library } = deps;
  const MCP_TOKEN = mcpToken();
  const brief = (r: Row) => ({
    key: r.key, title: r.title, project: r.project, machine: machineLabelOf(r.machine), agent: r.agent, status: r.status, needs_you: needsYou(r),
    now: r.step ?? r.now, last_active: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : undefined, branch: r.branch, uncommitted: r.dirty,
    last_message: r.lastMessage?.slice(0, 240), servers: r.ports?.map((p) => p.url ?? `localhost:${p.port}`),
  });
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
      if (machine && machine !== selfId) { const r = remotes.get(machine); if (!r) throw new Error("unknown machine"); return inventoryText((await r.post("/api/connections", {})).data); }
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
      const remote = o.machine && o.machine !== selfId ? [...remotes.values()].find((h) => h.conf.id === o.machine || h.conf.label.toLowerCase() === String(o.machine).toLowerCase()) : undefined;
      const r = remote ? { ...(await remote.post("/api/new", body)).data } : await startSession(body);
      notice({ key: r.key, ok: true, message: `An agent started a ${o.agent} session via MCP in ${o.cwd}` });
      return r;
    },
    audit: (e) => { appendAudit(e); broadcast("audit", readAudit(30)); },
    library: async (q, k) => (await library.evidence(q, k, "research")).text,
  };
  return { token: MCP_TOKEN, ctx: mcpCtx };
}
