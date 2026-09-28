// Codex records parent/child relationships in its state index, including children in other day folders.
import { codexStore } from "./codex-store";
import { codexMeta } from "./agents";
import { turnState } from "./codex-turn";
import { codexDetail, type Sub } from "./transcript";

export function codexSubFile(parentId: string, childId: string, store = codexStore) {
  if (!store.subagents(parentId).some((r) => r.id === childId)) return;
  return store.file(childId);
}

export async function codexSubagents(parentId: string, store = codexStore): Promise<Sub[]> {
  return (await Promise.all(store.subagents(parentId).map(async (r) => {
    const file = store.file(r.id);
    const [detail, turn, meta] = await Promise.all([
      file ? codexDetail(file).catch(() => undefined) : undefined,
      file ? turnState(file).catch(() => undefined) : undefined,
      store === codexStore ? codexMeta(r.id).catch(() => undefined) : undefined,
    ]);
    const tool = detail?.messages.findLast((m) => m.role === "tool" && m.state === "running");
    return {
      id: r.id, description: r.name || r.title || r.agent_nickname || "Codex subagent", type: r.agent_role || "Codex",
      model: meta?.model ?? r.model, startedAt: meta?.createdAt ?? (r.created_at ? r.created_at * 1000 : undefined),
      lastActiveAt: meta?.lastActiveAt ?? turn?.mtime ?? (r.updated_at ? r.updated_at * 1000 : undefined),
      running: !r.archived && !!turn?.open && Date.now() - turn.mtime < 20 * 60_000,
      now: tool ? `${tool.tool}: ${tool.summary ?? ""}` : undefined,
      tools: detail?.messages.filter((m) => m.role === "tool").length ?? 0,
    };
  }))).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}
