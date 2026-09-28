// The deck as an MCP server (streamable HTTP, JSON responses): any agent can see the whole fleet,
// search everything ever done, read another session, message an agent, or start one.
// Closing panes is deliberately not offered. Every write is logged and shown in the deck.
import { appendFileSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

const DIR = `${homedir()}/.config/herdr-deck`;
export const MCP_TOKEN_FILE = `${DIR}/mcp.token`;
const AUDIT = `${DIR}/mcp-audit.jsonl`;

export function mcpToken(): string {
  let t = "";
  try { t = readFileSync(MCP_TOKEN_FILE, "utf8").trim(); } catch {}
  if (!/^[a-f0-9]{32,}$/.test(t)) {
    t = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    writeFileSync(MCP_TOKEN_FILE, t + "\n", { mode: 0o600 });
  }
  if (existsSync(MCP_TOKEN_FILE)) chmodSync(MCP_TOKEN_FILE, 0o600);
  return t;
}

export type McpCtx = {
  sessions: (f: { status?: string; machine?: string; project?: string; query?: string; limit?: number }) => any[];
  session: (key: string, messages: number) => Promise<any>;
  search: (q: string, history: boolean, limit: number) => Promise<any>;
  history: (f: { query?: string; project?: string; agent?: string; limit?: number }) => Promise<any>;
  decisions: () => Promise<any[]>;
  connections: (machine?: string) => Promise<string>;
  send: (key: string, text: string) => Promise<any>;
  start: (o: { agent: string; cwd: string; prompt?: string; model?: string; effort?: string; machine?: string; label?: string }) => Promise<any>;
  audit: (entry: { tool: string; target?: string; text?: string }) => void;
  /** Founder Library evidence as text (src/library.ts). Optional: a deck without it doesn't list the tool. */
  library?: (q: string, k: number) => Promise<string>;
  /** Tools running plugins add (the "mcp.tools" extension point). */
  tools?: () => McpTool[];
};
export type McpTool = { name: string; description: string; inputSchema: object; call: (args: any) => Promise<unknown> };

const TOOLS = [
  { name: "deck_sessions", description: "List live agent sessions across all machines (herdr panes and Codex app threads): key, title, project, machine, agent, status (working|blocked|done|idle|empty), what it's doing now, last activity. Use the key with the other tools.",
    inputSchema: { type: "object", properties: { status: { type: "string", description: "Filter: working, blocked, done, idle, needs_you" }, machine: { type: "string" }, project: { type: "string" }, query: { type: "string", description: "Words to match in title/project/branch/last message" }, limit: { type: "number" } } } },
  { name: "deck_session", description: "One session in detail: facts, its first request, and the last N chat messages (text trimmed; tool calls as one-liners).",
    inputSchema: { type: "object", properties: { key: { type: "string" }, messages: { type: "number", description: "How many recent messages (default 20, max 80)" } }, required: ["key"] } },
  { name: "deck_search", description: "Full-text search across live sessions and (optionally) every past Claude Code / Codex conversation on every machine. Returns sessions with the best matching snippet.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, history: { type: "boolean", description: "Include past sessions (default true)" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "deck_history", description: "Browse past Claude Code and Codex sessions (newest first), optionally filtered by project/agent or matching words. Past sessions can be read with deck_session using their key.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" }, agent: { type: "string", enum: ["claude", "codex"] }, limit: { type: "number" } } } },
  { name: "deck_decisions", description: "The user's decision inbox: sessions blocked on a prompt, asking a question, or claiming to be done, with options and any Jev suggestion.",
    inputSchema: { type: "object", properties: {} } },
  { name: "deck_connections", description: "What this setup can reach: coding agents, AI subscriptions, MCP servers and connectors, signed-in CLIs, API key NAMES (never values), browser profiles, skills. Use it to plan work that spans services.",
    inputSchema: { type: "object", properties: { machine: { type: "string" } } } },
  { name: "deck_send", description: "Send a message to another live agent session (it arrives as if the user typed it). Use sparingly; the user sees every message in the deck.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, text: { type: "string" } }, required: ["key", "text"] } },
  { name: "deck_library", description: "The Founder Library: how real builders built and got customers, from YouTube interviews (Starter Story, My First Million, Y Combinator and more) the user collected. Ask a question (\"how did people get first customers for a Telegram bot?\", \"pricing for a B2B Chrome extension\"); get founder cards (claimed revenue, price, first-customer tactics, lessons) and transcript quotes, each with a YouTube timestamp link. Use it for idea research and pre-mortems; cite the links; numbers are the founders' claims.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", description: "How many videos (default 5, max 8)" } }, required: ["query"] } },
  { name: "deck_start", description: "Start a new agent session in a herdr tab (claude, codex or opencode) in a folder, optionally with a first prompt. It starts in the agent's normal permission mode; skip-permission modes can't be requested here.",
    inputSchema: { type: "object", properties: { agent: { type: "string", enum: ["claude", "codex", "opencode"] }, cwd: { type: "string" }, prompt: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, machine: { type: "string" }, label: { type: "string" } }, required: ["agent", "cwd"] } },
];

const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });

export async function handleMcp(msg: any, ctx: McpCtx): Promise<any | undefined> {
  const { id, method, params } = msg ?? {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined || id === null) return; // notifications (initialized, cancelled) get no reply
  try {
    switch (method) {
      case "initialize":
        return ok({ protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "herdr-deck", version: "1.0.0" },
          instructions: "herdr deck: the user's live view of every coding-agent session across their machines. Read freely; message or start agents only when it clearly helps the user's request." });
      case "ping": return ok({});
      case "tools/list": {
        const extra = (ctx.tools?.() ?? []).filter((t) => !TOOLS.some((x) => x.name === t.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        return ok({ tools: [...(ctx.library ? TOOLS : TOOLS.filter((t) => t.name !== "deck_library")), ...extra] });
      }
      case "tools/call": {
        const a = params?.arguments ?? {};
        switch (params?.name) {
          case "deck_sessions": return ok(text(ctx.sessions(a)));
          case "deck_library": if (ctx.library) return ok(text((await ctx.library(String(a.query ?? ""), Math.min(Number(a.limit) || 5, 8))) || "The Founder Library has nothing on that yet.")); break;
          case "deck_session": return ok(text(await ctx.session(String(a.key), Math.min(Number(a.messages) || 20, 80))));
          case "deck_search": return ok(text(await ctx.search(String(a.query ?? ""), a.history !== false, Math.min(Number(a.limit) || 20, 60))));
          case "deck_history": return ok(text(await ctx.history(a)));
          case "deck_decisions": return ok(text(await ctx.decisions()));
          case "deck_connections": return ok(text(await ctx.connections(a.machine)));
          case "deck_send": {
            const t = String(a.text ?? "").trim();
            if (!t) return ok({ ...text("text is empty"), isError: true });
            const r = await ctx.send(String(a.key), t);
            ctx.audit({ tool: "deck_send", target: String(a.key), text: t.slice(0, 300) });
            return ok(text(r));
          }
          case "deck_start": {
            const r = await ctx.start({ agent: String(a.agent), cwd: String(a.cwd), prompt: a.prompt, model: a.model, effort: a.effort, machine: a.machine, label: a.label });
            ctx.audit({ tool: "deck_start", target: `${a.agent} in ${a.cwd}`, text: String(a.prompt ?? "").slice(0, 300) });
            return ok(text(r));
          }
        }
        const plugin = ctx.tools?.().find((t) => t.name === params?.name && !TOOLS.some((x) => x.name === t.name));
        if (plugin) return ok(text(await plugin.call(a)));
        return fail(-32602, `unknown tool ${params?.name}`);
      }
    }
    return fail(-32601, `method not found: ${method}`);
  } catch (e: any) {
    return ok({ ...text(`Error: ${e?.message ?? e}`), isError: true });
  }
}

export function appendAudit(entry: object) {
  try { appendFileSync(AUDIT, JSON.stringify({ at: Date.now(), ...entry }) + "\n"); } catch {}
}
export function readAudit(n = 50) {
  try { return readFileSync(AUDIT, "utf8").trim().split("\n").slice(-n).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
}
