import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createCodexDelivery } from "./codex-delivery";
import { CodexControlError } from "./codex-ipc";
import { codexLifecycleBinary, openCodexMetadataSession, type CodexMetadataSession } from "./codex-app-server";
import { archivedCodexTasks } from "./codex-lifecycle-index";

export type CodexLifecycleTask = { id: string; cwd: string; title: string };
const invalid = (message: string) => new CodexControlError(message, "CODEX_INVALID");
function taskId(id: string) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw invalid("Invalid Codex task id");
  return id;
}
function title(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw invalid("Enter a task title under 200 characters.");
  return value.trim();
}
function task(thread: any): CodexLifecycleTask {
  if (thread?.source !== "vscode") throw invalid("This task was not created for the Codex app.");
  return { id: taskId(thread.id), cwd: thread.cwd, title: thread.name?.trim() || thread.preview?.trim().slice(0, 100) || "Codex task" };
}
export function createCodexLifecycle(options: {
  receiptsFile?: string; binary?: string; timeoutMs?: number; indexHome?: string;
  transport?: () => Promise<CodexMetadataSession>;
} = {}) {
  const deliver = createCodexDelivery(options.receiptsFile);
  const available = () => !!options.transport || !!(options.binary ?? codexLifecycleBinary());
  async function run<T>(operation: (session: CodexMetadataSession) => Promise<T>) {
    const binary = options.binary ?? codexLifecycleBinary();
    if (!options.transport && !binary) throw new CodexControlError("Install the Codex desktop app on this machine first.");
    const session = await (options.transport?.() ?? openCodexMetadataSession(binary!, options.timeoutMs));
    try { return await operation(session); } finally { await session.close(); }
  }
  async function read(session: CodexMetadataSession, id: string) {
    const result = task((await session.request("thread/read", { threadId: taskId(id), includeTurns: false })).thread);
    if (result.id !== id) throw invalid("Codex returned a different task. Refresh before acting.");
    return result;
  }
  function incomplete(id: string, e: any) {
    return new CodexControlError(`Codex task ${id} was created, but setup was not confirmed. Check it in Codex before trying again. ${e.message ?? ""}`, "CODEX_DELIVERY_UNKNOWN");
  }
  return {
    available,
    capabilities() { const ready = available(); return { available: ready, create: ready, rename: ready, archive: ready, restore: ready, fork: ready }; },
    read(id: string) { return run((s) => read(s, id)); },
    async create(input: { cwd: string; title?: string; prompt?: string; requestId: string }) {
      if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw invalid("Choose an absolute project folder.");
      let cwd: string;
      try { cwd = realpathSync(input.cwd); if (!statSync(cwd).isDirectory()) throw new Error(); }
      catch { throw invalid("That project folder does not exist."); }
      const prompt = input.prompt ?? "";
      if (typeof prompt !== "string" || prompt.length > 200_000) throw invalid("Enter a first message under 200,000 characters.");
      if (input.title != null && typeof input.title !== "string") throw invalid("Enter a task title under 200 characters.");
      const name = title(input.title?.trim() || prompt.trim().split("\n")[0].slice(0, 100) || "New Codex task");
      return deliver(input.requestId, { action: "create", cwd, name, prompt }, () => run(async (s) => {
        let id: string | undefined;
        try {
          const response = await s.request("thread/start", { cwd, threadSource: "herdr-deck", ephemeral: false }, true);
          id = response.thread?.id ?? "unknown";
          const created = task(response.thread);
          // Empty rollouts are deferred. A neutral protocol item materializes history without a message or model turn.
          await s.request("thread/inject_items", { threadId: id, items: [{ type: "other" }] }, true);
          await s.request("thread/name/set", { threadId: id, name }, true);
          await s.request("thread/unsubscribe", { threadId: id });
          return { ...created, title: name, initialPromptPersisted: false };
        } catch (e) { if (id) throw incomplete(id, e); throw e; }
      }));
    },
    rename(id: string, value: string) {
      const name = title(value);
      return run(async (s) => { const current = await read(s, id); await s.request("thread/name/set", { threadId: current.id, name }, true); return { ...current, title: name }; });
    },
    archive(id: string, archived: boolean) {
      if (typeof archived !== "boolean") throw invalid("Choose archive or restore.");
      return run(async (s) => {
        const current = await read(s, id);
        try { await s.request(archived ? "thread/archive" : "thread/unarchive", { threadId: current.id }, true); }
        catch (e: any) {
          if (/already has an active writer/i.test(e.message)) throw new CodexControlError("Codex still has this task loaded. Archive it in the Codex app.", "CODEX_STALE");
          throw e;
        }
        return { ...current, archived };
      });
    },
    fork(id: string, requestId: string) {
      taskId(id);
      return deliver(requestId, { action: "fork", id }, () => run(async (s) => {
        await read(s, id); let createdId: string | undefined;
        try {
          const response = await s.request("thread/fork", { threadId: id, excludeTurns: true, threadSource: "herdr-deck" }, true);
          createdId = response.thread?.id ?? "unknown";
          const created = task(response.thread);
          await s.request("thread/unsubscribe", { threadId: created.id });
          return created;
        } catch (e) { if (createdId) throw incomplete(createdId, e); throw e; }
      }));
    },
    async archived(cursor?: string) { return archivedCodexTasks(cursor, options.indexHome); },
  };
}
export type CodexLifecycle = ReturnType<typeof createCodexLifecycle>;
