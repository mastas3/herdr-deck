import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { CodexControlError } from "../codex-ipc";
import type { Hub } from "./hub";
import { json } from "./page";

const paths = new Set(["/api/codex-create", "/api/codex-rename", "/api/codex-archive", "/api/codex-fork", "/api/codex-archived"]);
export async function codexLifecycleApi(hub: Hub, path: string, body: any) {
  if (!paths.has(path)) return;
  const lifecycle = hub.codexLifecycle;
  if (!lifecycle?.available()) throw new CodexControlError("Native Codex task management is unavailable on this host.");
  if (path === "/api/codex-archived") {
    const result = await lifecycle.archived(body.cursor);
    return json({ ...result, tasks: result.tasks.map((t) => ({ ...t, key: `codex-app/${t.id}` })) });
  }
  if (path === "/api/codex-create") {
    const cwd = typeof body.cwd === "string" ? body.cwd.replace(/^~(?=\/|$)/, homedir()) : "";
    if (!isAbsolute(cwd) || cwd.includes("\0")) throw new CodexControlError("Choose an absolute project folder.", "CODEX_INVALID");
    if (body.mkdir === true) await mkdir(cwd, { recursive: true });
    const task = await lifecycle.create({ cwd, title: body.title, prompt: body.prompt, requestId: body.requestId });
    await hub.deck.syncAppThread(task.id);
    const key = `codex-app/${task.id}`;
    try {
      const state: any = await hub.codexRecovery.connect(task.id);
      if (!state.ready) throw new CodexControlError(state.error ?? "Open the new task in Codex to continue.");
      const receipt = `first-${Bun.hash(body.requestId).toString(36)}`;
      if (body.prompt?.trim()) await hub.codex.sendInitial(task.id, body.prompt, receipt);
      return json({ key, id: task.id, promptSent: true });
    } catch (e: any) {
      // Unknown delivery must never become a second composer draft.
      return json({ key, id: task.id, promptSent: false, promptPersisted: !!task.initialPromptPersisted,
        canRetryPrompt: !["CODEX_DELIVERY_UNKNOWN", "CODEX_STALE"].includes(e.code),
        deliveryUnknown: e.code === "CODEX_DELIVERY_UNKNOWN", error: e.message, code: e.code });
    }
  }
  const key = typeof body.key === "string" ? body.key : "";
  const id = /^codex-app\/([a-zA-Z0-9_-]{8,100})$/.exec(key)?.[1];
  if (!id) throw new CodexControlError("Not a local Codex app task.", "CODEX_INVALID");
  // The lifecycle adapter additionally checks canonical source membership before any mutation.
  if (path === "/api/codex-rename") {
    await lifecycle.rename(id, body.title); await hub.deck.syncAppThread(id);
    return json({ ok: true, key });
  }
  if (path === "/api/codex-archive" && typeof body.archived !== "boolean") throw new CodexControlError("Choose archive or restore.", "CODEX_INVALID");
  if (path === "/api/codex-fork" || body.archived) {
    const state = await hub.codex.watch(id, true), row = hub.hosts.localRow(key);
    if (state.activeTurnId || ["working", "blocked"].includes(state.status ?? row?.status ?? "")) {
      throw new CodexControlError("Finish or stop this Codex turn first.", "CODEX_STALE");
    }
  }
  if (path === "/api/codex-fork") {
    const task = await lifecycle.fork(id, body.requestId);
    await hub.deck.syncAppThread(task.id);
    return json({ ok: true, id: task.id, key: `codex-app/${task.id}` });
  }
  await lifecycle.archive(id, body.archived);
  if (body.archived) hub.codex.forget(id);
  await hub.deck.syncAppThread(id, body.archived);
  return json({ ok: true, key, archived: body.archived });
}
