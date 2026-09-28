// Limit handoff: when a session's account is nearly used up (the deck's usage readings, page side) or the agent printed
// its own limit line (watched here), the page offers "Continue in Codex" (or another agent). The note comes from the
// agent itself when it can still answer (sent only after a confirm), else from its transcript. The page then opens
// the New session dialog prefilled with it. Nothing switches by itself.
import type { Host } from "../../src/plugin-api";
import { askMessage, buildNote, findNote, limitLine } from "./handoff-note";

const AGENTS = new Set(["claude", "codex", "opencode"]);

export function activate(host: Host) {
  /** Sessions whose terminal or last reply shows a limit line: key → that line. */
  let hits: Record<string, string> = {};
  const scan = () => {
    const next: Record<string, string> = {};
    for (const r of host.rows()) {
      if (!AGENTS.has(r.agent)) continue;
      const line = limitLine([...(r.tail ?? []).slice(-12), r.lastMessage]);
      if (line) next[r.key] = line;
    }
    if (JSON.stringify(next) !== JSON.stringify(hits)) { hits = next; host.broadcast("limit-handoff", { hits }); }
  };
  host.after(5_000, scan);
  host.every(20_000, scan);
  const threshold = () => Math.min(100, Math.max(50, Number(host.setting("threshold")) || 90));
  host.extend("fullState", { key: "limitHandoff", get: () => ({ threshold: threshold(), hits }) });

  host.routes("limit-handoff", async ({ path, body }) => {
    if (path !== "/api/limit-handoff") return undefined;
    const op = String(body?.op ?? "state");
    const row = () => { const r = host.rows().find((x) => x.key === body.key); if (!r) throw new Error("That session is gone"); return r; };
    const target = AGENTS.has(body?.target) ? String(body.target) : "codex";
    try {
      if (op === "state") { scan(); return { threshold: threshold(), hits }; }
      if (op === "note") {
        const r = row();
        return { note: buildNote({ row: r, messages: Array.isArray(body.messages) ? body.messages : [], target, why: typeof body.why === "string" ? body.why.slice(0, 200) : undefined }) };
      }
      if (op === "ask") {
        const text = askMessage(target === "codex" ? "Codex" : target === "claude" ? "Claude" : "another agent");
        if (!body.send) return { text };
        if (body.confirmed !== true) throw new Error("Asking the agent needs your confirmation");
        await host.sessions.send(row().key, text);
        return { ok: true, askedAt: Date.now() };
      }
      if (op === "find") return { note: findNote(Array.isArray(body.messages) ? body.messages : [], Number(body.askedAt) || 0) ?? null };
      return Response.json({ error: "Unknown op" }, { status: 400 });
    } catch (e: any) { return Response.json({ error: e?.message ?? String(e) }, { status: 400 }); }
  });
}
