import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexControlError } from "./codex-ipc";
import { createCodexDelivery } from "./codex-delivery";
import type { CodexNativeAccess } from "./codex-settings";

export function codexEditableTurn(raw: any): { turnId: string; text: string } | undefined {
  if (!raw || raw.threadRuntimeStatus?.type === "active" || raw.requests?.length) return;
  const history = raw.turnHistory?.kind === "canonical" ? raw.turnHistory.history : null;
  const turns: any[] = history ? history.islands?.flatMap((i: any) => (i.entries ?? []).map((e: any) => history.entitiesByKey?.[e.value]).filter(Boolean))
    ?? Object.values(history.entitiesByKey ?? {}) : raw.turns ?? [];
  if (turns.some((t) => t.status === "inProgress")) return;
  const turn = [...turns].reverse().find((t) => t.params?.input?.length);
  if (!turn?.turnId || !turn.items?.some((i: any) => i.type === "userMessage")) return;
  const input = turn.params.input.find((i: any) => i.type === "text");
  if (typeof input?.text !== "string") return;
  // The desktop's edit handler preserves this attachment/context prefix itself.
  const marker = [...input.text.matchAll(/## My request(?: for Codex)?:/g)].at(-1);
  const text = marker ? input.text.slice(marker.index! + marker[0].length).trim() : input.text;
  return { turnId: turn.turnId, text };
}

export type CodexQueueView = { status: "ready" | "unavailable"; messages: { id: string; text: string; pausedReason?: string }[] };
export function codexQueuedMessages(value: any, id: string): CodexQueueView {
  const messages = value?.["queued-follow-ups"]?.[id] ?? [];
  if (!Array.isArray(messages)) return { status: "unavailable", messages: [] };
  return { status: "ready", messages: messages.filter((m) => m && typeof m.id === "string" && typeof m.text === "string").slice(0, 100)
    .map((m) => ({ id: m.id, text: m.text.slice(0, 200_000), ...(typeof m.pausedReason === "string" ? { pausedReason: m.pausedReason } : {}) })) };
}

export function createCodexConversation(access: CodexNativeAccess, options: {
  receiptsFile?: string; globalStateFile?: string; deliver?: ReturnType<typeof createCodexDelivery>;
} = {}) {
  const deliver = options.deliver ?? createCodexDelivery(options.receiptsFile);
  const file = options.globalStateFile ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), ".codex-global-state.json");
  let queueCache: { mtime: number; checked: number; value: any } | undefined;
  return {
    editable: (id: string) => codexEditableTurn(access.raw(id)),
    async queue(id: string): Promise<CodexQueueView> {
      try {
        if (!queueCache || Date.now() - queueCache.checked > 1000) {
          const info = await stat(file);
          if (info.size > 32 * 1024 * 1024) throw new Error("Desktop state is too large");
          if (queueCache?.mtime === info.mtimeMs) queueCache.checked = Date.now();
          else queueCache = { mtime: info.mtimeMs, checked: Date.now(), value: JSON.parse(await readFile(file, "utf8")) };
        }
        return codexQueuedMessages(queueCache.value, id);
      } catch { return { status: "unavailable", messages: [] }; }
    },
    async edit(id: string, turnId: string, text: string, receipt: string) {
      if (typeof text !== "string" || !text.trim() || text.length > 200_000) throw new CodexControlError("Enter a message under 200,000 characters.", "CODEX_INVALID");
      return deliver(receipt, { kind: "edit", id, turnId, text }, async () => {
        const state = await access.current(id), latest = codexEditableTurn(access.raw(id));
        if (state.status !== "idle" || !latest || latest.turnId !== turnId) throw new CodexControlError("Only the latest user message can be edited after Codex finishes.", "CODEX_STALE");
        await access.action(id, "thread-follower-edit-last-user-turn", { turnId, message: text, shouldSendPermissionOverrides: false }, 2);
        return { ok: true, delivery: "accepted" };
      });
    },
  };
}
