// Running tools on sessions (a prompt, or a sequence like handoff then compact), and "related past work": the
// history index on every machine, searched for a session's project.
import { fillTool, loadTools, type Tool } from "../tools";
import { searchHistory, type HistSession } from "../history";
import type { RemoteHost } from "../federation";
import type { Deck, Row } from "../deck";

type Deps = {
  deck: Deck; remotes: Map<string, RemoteHost>; selfId: string;
  sendText: (key: string, text: string) => Promise<void>; notice: (data: { key?: string; ok: boolean; message: string }) => void;
};
type HistHit = HistSession & { machine?: string };

export function createToolRuns(deps: Deps) {
  const { deck, remotes, selfId, sendText, notice } = deps;
  function resolveTool(body: any): Tool | undefined {
    if (body.tool && typeof body.tool === "object") return body.tool as Tool; // a hub already resolved it
    return loadTools().find((t) => t.id === body.id);
  }

  /** Waits for the agent to take the message and finish its turn (sequences: handoff, then compact). */
  async function afterTurn(key: string, timeoutMs = 20 * 60_000) {
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < timeoutMs) {
      await Bun.sleep(1500);
      const r = deck.rows.get(key);
      if (!r) return false;
      if (r.status === "working" || r.status === "blocked") started = true;
      else if (started || Date.now() - t0 > 20_000) return true;
    }
    return false;
  }

  async function runToolLocal(tool: Tool, keys: string[], extra: Record<string, string> = {}) {
    const results: any[] = [];
    for (const key of keys.slice(0, 50)) {
      const row = deck.rows.get(key);
      if (!row) { results.push({ key, ok: false, error: "gone" }); continue; }
      if (tool.agents && !tool.agents.includes(row.agent)) { results.push({ key, ok: false, error: `not for ${row.agent}` }); continue; }
      try {
        await sendText(key, fillTool(tool.prompt ?? "", row, extra));
        if (tool.kind === "sequence" && tool.then) {
          const then = row.agent === "claude" ? fillTool(tool.then, row, extra) : "/compact"; // only Claude's /compact takes instructions
          (async () => {
            if (await afterTurn(key)) { await sendText(key, then).catch(() => {}); notice({ key, ok: true, message: `${tool.label}: step 2 sent` }); }
            else notice({ key, ok: false, message: `${tool.label}: the agent didn’t finish step 1, so step 2 wasn’t sent` });
          })();
        }
        results.push({ key, ok: true });
      } catch (e: any) { results.push({ key, ok: false, error: e?.message ?? String(e) }); }
    }
    return results;
  }

  /** "Related past work": the history index, searched for this session's project, handed to the agent. */
  async function relatedFor(row: Row) {
    const q = [row.project, ...(row.title ?? "").split(/\s+/).filter((w) => w.length > 4).slice(0, 3)].join(" ");
    const byProject = await historyEverywhere({ project: row.project, limit: 12 });
    const byWords = await historyEverywhere({ q: row.title ?? row.project, limit: 8 });
    const seen = new Set<string>();
    const list = [...byProject, ...byWords].filter((h) => h.id !== row.sessionId && !seen.has(h.key) && seen.add(h.key)).slice(0, 12);
    if (!list.length) return { text: "", n: 0 };
    const lines = list.map((h) => `- ${new Date(h.last ?? 0).toISOString().slice(0, 10)} · ${h.agent} · ${h.title}${h.machine && h.machine !== selfId ? ` (on ${h.machine})` : ""}\n  transcript: ${h.file}${h.hit ? `\n  match: ${h.hit.snippet.replace(/[\u0002\u0003]/g, "")}` : ""}`);
    return { n: list.length, q, text: `Context from my past sessions on this project (newest first). Skim the ones that look relevant (they are JSONL transcripts; grep them rather than reading whole files) and tell me in 3 bullets what's useful for the current task, then continue:\n\n${lines.join("\n")}` };
  }

  async function historyEverywhere(o: { q?: string; project?: string; agent?: string; limit?: number; before?: number }): Promise<HistHit[]> {
    const live = new Set([...deck.rows.values()].map((r) => r.sessionId).filter(Boolean) as string[]);
    const local = searchHistory({ ...o, exclude: live }).sessions.map((h) => ({ ...h, machine: selfId }));
    const remote = await Promise.all([...remotes.values()].filter((h) => h.online).map((h) =>
      Promise.race([h.post("/api/history", { ...o, local: true }).then((r) => (r.data.sessions ?? []).map((x: any) => ({ ...x, key: `${h.conf.id}|${x.key}`, machine: h.conf.id }))), Bun.sleep(2000).then(() => [])]).catch(() => [])));
    const all = [...local, ...remote.flat()];
    if (o.q) return all.sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0) || (b.last ?? 0) - (a.last ?? 0)).slice(0, o.limit ?? 60);
    return all.sort((a, b) => (b.last ?? 0) - (a.last ?? 0)).slice(0, o.limit ?? 60);
  }
  return { resolveTool, runToolLocal, relatedFor, historyEverywhere };
}
export type ToolRuns = ReturnType<typeof createToolRuns>;
