import { createCodexIpc, CodexControlError, type CodexIpc } from "./codex-ipc";
import { applyCodexPatches, codexControlState, type CodexControlState } from "./codex-control-state";
import { createCodexDelivery } from "./codex-delivery";

type Watched = { owner?: string; raw?: any; view?: CodexControlState; revision?: number; checked: number; touched: number; error?: string; signature?: string };
const unavailable = "Open this task in the Codex app, then reconnect.";
export function createCodexControl(options: {
  path?: string; receiptsFile?: string; timeoutMs?: number;
  changed?: (id: string, state: CodexControlState) => void;
  activeThreads?: () => string[];
  transport?: (handlers: { broadcast: (message: any) => void; disconnected: () => void }) => CodexIpc;
} = {}) {
  const watched = new Map<string, Watched>(), loading = new Map<string, Promise<CodexControlState>>();
  const snapshots = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const deliver = createCodexDelivery(options.receiptsFile);
  let timer: Timer | undefined;
  const state = (id: string): CodexControlState => {
    const w = watched.get(id);
    return w?.raw && w.owner && w.view ? w.view : { ready: false, requests: [], error: w?.error ?? unavailable };
  };
  const changed = (id: string) => options.changed?.(id, state(id));
  function invalidate(id: string, error = unavailable) {
    const w = watched.get(id);
    if (!w) return;
    w.raw = undefined; w.owner = undefined; w.revision = undefined; w.signature = undefined; w.error = error; w.checked = 0;
    snapshots.get(id)?.reject(new CodexControlError(error)); changed(id);
  }
  const handlers = {
    disconnected() { for (const id of watched.keys()) invalidate(id); },
    broadcast(message: any) {
      if (message.method === "client-status-changed" && message.params?.status === "disconnected") {
        for (const [id, w] of watched) if (w.owner === message.params.clientId) invalidate(id);
      }
      if (message.method !== "thread-stream-state-changed" || message.params?.hostId !== "local") return;
      const id = message.params.conversationId, w = watched.get(id), change = message.params.change;
      if (!w || w.owner !== message.sourceClientId) return;
      if (message.version !== 11) { invalidate(id, "This Codex app version uses a different control protocol."); return; }
      try {
        if (!Number.isInteger(change?.revision) || change.revision < 0) throw new Error("Missing revision");
        if (w.revision != null && change.revision < w.revision) return;
        if (change.type === "snapshot") {
          if (change.conversationState?.id !== id) throw new Error("Wrong conversation");
          w.raw = change.conversationState;
        } else if (change.type === "patches" && w.raw && change.baseRevision === w.revision && change.revision > change.baseRevision) {
          w.raw = applyCodexPatches(w.raw, change.patches);
        } else throw new Error("Missed desktop state update");
        w.revision = change.revision; w.error = undefined;
        // Text deltas belong to the existing transcript reader; don't rebuild every row per token.
        const visible = change.type === "snapshot" || change.patches.some((p: any) => !["text", "output", "diff", "aggregatedOutput"].includes(p.path?.at(-1)));
        if (visible || !w.view) w.view = codexControlState(w.raw);
        snapshots.get(id)?.resolve();
        const signature = JSON.stringify(w.view);
        if (w.signature !== signature) { w.signature = signature; changed(id); }
      } catch { invalidate(id, "The Codex state changed. Reconnect before acting."); }
    },
  };
  const ipc = options.transport?.(handlers) ?? createCodexIpc({ ...options, ...handlers });
  async function watch(id: string, force = false): Promise<CodexControlState> {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new CodexControlError("Invalid Codex task", "CODEX_INVALID");
    let w = watched.get(id);
    if (!w) { w = { checked: 0, touched: Date.now() }; watched.set(id, w); }
    w.touched = Date.now();
    if (loading.has(id)) return loading.get(id)!;
    if (!force && Date.now() - w.checked < (w.raw ? 20_000 : 5000)) return state(id);
    const entry = w;
    const run = (async () => {
      try {
        await ipc.ready();
        const result = await ipc.request("thread-owner-discovery", { hostId: "local", conversationId: id }, 1);
        const owner = result.handledByClientId;
        if (typeof owner !== "string") throw new CodexControlError(unavailable);
        if (entry.owner !== owner || !entry.raw) {
          if (entry.owner) ipc.follow(id, entry.owner, false);
          entry.owner = owner; entry.raw = undefined; entry.revision = undefined;
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new CodexControlError("The Codex app did not send its live state.")), options.timeoutMs ?? 10_000);
            snapshots.set(id, { resolve: () => { clearTimeout(timeout); resolve(); }, reject: (e) => { clearTimeout(timeout); reject(e); } });
            try { ipc.follow(id, owner, true); } catch (e) { clearTimeout(timeout); reject(e); }
          }).finally(() => snapshots.delete(id));
        }
        entry.checked = Date.now(); return state(id);
      } catch (e: any) { invalidate(id, e.message); entry.checked = Date.now(); return state(id); }
      finally { loading.delete(id); }
    })();
    loading.set(id, run); return run;
  }
  async function current(id: string) {
    const s = await watch(id, true);
    if (!s.ready) throw new CodexControlError(s.error ?? unavailable);
    return s;
  }
  async function action(id: string, method: string, params: any, version: number) {
    const w = watched.get(id);
    if (!w?.owner || !w.raw) throw new CodexControlError(unavailable);
    const response = await ipc.request(method, { conversationId: id, ...params }, version, w.owner, true);
    return response.result;
  }
  return {
    state, watch,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // Follow active app tasks for questions and notifications even when their detail isn't open.
        for (const id of options.activeThreads?.().slice(0, 12) ?? []) void watch(id).catch(() => {});
        for (const [id, w] of watched) if (Date.now() - w.touched > 90_000 && !loading.has(id)) {
          try { if (w.owner) ipc.follow(id, w.owner, false); } catch {}
          watched.delete(id); changed(id);
        }
      }, 15_000);
    },
    close() { clearInterval(timer); timer = undefined; ipc.close(); watched.clear(); },
    async send(id: string, text: string, receipt: string, onlyIdle = false, images: string[] = []) {
      if ((!text.trim() && !images.length) || text.length > 200_000) throw new CodexControlError("Enter a message under 200,000 characters.", "CODEX_INVALID");
      return deliver(receipt, { id, text, images }, async () => {
        const s = await current(id);
        if (s.status === "blocked" && s.requests.some((r) => r.method !== "deck/asyncQuestion")) throw new CodexControlError("Answer the pending Codex request first.", "CODEX_STALE");
        if (onlyIdle && (s.activeTurnId || s.status === "working" || s.status === "blocked")) throw new CodexControlError("Codex is still working or waiting for input.", "CODEX_STALE");
        const input: any[] = [{ type: "text", text, text_elements: [] }, ...images.map((path) => ({ type: "localImage", path }))];
        const turnStart = { request: { threadId: id, input, clientUserMessageId: receipt }, context: { inheritThreadSettings: true } };
        const result = s.activeTurnId
          ? await action(id, "thread-follower-steer-turn", { input, restoreMessage: turnStart, clientUserMessageId: receipt }, 1)
          : await action(id, "thread-follower-start-turn", { turnStart }, 2);
        return { ok: true, turnId: result?.result?.turn?.id ?? result?.result?.turnId, delivery: "accepted" };
      });
    },
    async stop(id: string, expectedTurnId: string) {
      const s = await current(id);
      if (!expectedTurnId || s.activeTurnId !== expectedTurnId) throw new CodexControlError("That turn has already ended. Refresh the task.", "CODEX_STALE");
      return action(id, "thread-follower-interrupt-turn", { mode: "user-stop", expectedTurnId }, 4);
    },
    async compact(id: string) {
      const s = await current(id);
      if (s.status !== "idle") throw new CodexControlError("Wait for Codex to finish before compacting.", "CODEX_STALE");
      return action(id, "thread-follower-compact-thread", {}, 1);
    },
    async respond(id: string, requestId: string | number, answer: any) {
      const s = await current(id), request = s.requests.find((r) => r.id === requestId);
      if (!request) throw new CodexControlError("This request was already answered or cleared in Codex.", "CODEX_STALE");
      let method: string, payload: any;
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
        const allowed = request.params.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(answer.decision) || !allowed.includes(answer.decision)) throw new CodexControlError("Invalid approval decision", "CODEX_INVALID");
        method = request.method.includes("commandExecution") ? "command-approval-decision" : "file-approval-decision";
        payload = { decision: answer.decision };
      } else if (request.method === "item/permissions/requestApproval") {
        if (!["accept", "decline"].includes(answer.decision)) throw new CodexControlError("Invalid permission decision", "CODEX_INVALID");
        method = "permissions-request-approval-response";
        payload = { response: { permissions: answer.decision === "accept" ? request.params.permissions : {}, scope: "turn" } };
      } else if (request.method === "item/tool/requestUserInput" || request.method === "deck/asyncQuestion") {
        method = "submit-user-input";
        const answers: Record<string, { answers: string[] }> = Object.create(null);
        for (const q of request.params.questions ?? []) {
          const values = answer.answers?.[q.id]?.answers;
          if (!Array.isArray(values) || !values.length || values.some((v: any) => typeof v !== "string" || v.length > 20_000)) throw new CodexControlError("Answer each question first.", "CODEX_INVALID");
          answers[q.id] = { answers: values };
        }
        if (request.method === "deck/asyncQuestion") {
          const text = request.params.questions.map((q: any) => `${q.question}\n${answers[q.id].answers.join(", ")}`).join("\n\n");
          const receipt = `async-${Bun.hash(`${id}:${requestId}`).toString(36)}`;
          return deliver(receipt, { id, requestId, text }, async () => {
            const input = [{ type: "text", text, text_elements: [] }];
            const turnStart = { request: { threadId: id, input, clientUserMessageId: receipt }, context: { inheritThreadSettings: true } };
            return s.activeTurnId ? action(id, "thread-follower-steer-turn", { input, restoreMessage: turnStart, clientUserMessageId: receipt }, 1)
              : action(id, "thread-follower-start-turn", { turnStart }, 2);
          });
        }
        payload = { response: { answers } };
      } else if (request.method === "mcpServer/elicitation/request") {
        if (!["accept", "decline", "cancel"].includes(answer.action)) throw new CodexControlError("Invalid response", "CODEX_INVALID");
        method = "submit-mcp-server-elicitation-response";
        payload = { response: { action: answer.action, content: answer.action === "accept" ? answer.content ?? null : null } };
      } else throw new CodexControlError("Answer this request in the Codex app.", "CODEX_INVALID");
      return action(id, `thread-follower-${method}`, { requestId, ...payload }, 1);
    },
  };
}
export type CodexControl = ReturnType<typeof createCodexControl>;
