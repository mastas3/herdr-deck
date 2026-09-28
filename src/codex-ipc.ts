// The desktop owns execution and app tools. This client only forwards the user's actions to that owner.
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export class CodexControlError extends Error {
  constructor(message: string, public code = "CODEX_UNAVAILABLE") { super(message); }
}
export function ipcFrame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export function ipcDecoder(receive: (message: any) => void) {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (size < 2 || size > 64 * 1024 * 1024) throw new Error("Invalid Codex IPC frame");
      if (buffer.length < size + 4) return;
      const message = JSON.parse(buffer.subarray(4, size + 4).toString("utf8"));
      buffer = buffer.subarray(size + 4);
      receive(message);
    }
  };
}

export function createCodexIpc(options: {
  path?: string; timeoutMs?: number; broadcast: (message: any) => void; disconnected: () => void;
}) {
  let socket: Socket | undefined, connecting: Promise<void> | undefined, clientId = "initializing-client";
  const pending = new Map<string, { resolve: (m: any) => void; reject: (e: Error) => void; timer: Timer; mutation: boolean }>();
  const unavailable = () => new CodexControlError("The Codex app connection closed. Open the task in Codex and reconnect.");
  function lost(s: Socket) {
    if (socket !== s) return;
    socket = undefined; clientId = "initializing-client";
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(p.mutation ? new CodexControlError("Delivery is unconfirmed. Check the Codex conversation before sending again.", "CODEX_DELIVERY_UNKNOWN") : unavailable());
    }
    pending.clear(); options.disconnected();
  }
  function write(message: any) {
    if (!socket || socket.destroyed) throw unavailable();
    socket.write(ipcFrame({ ...message, sourceClientId: clientId }));
  }
  function receive(message: any) {
    if (message.type === "client-discovery-request") {
      write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === "response") {
      const p = pending.get(message.requestId);
      if (!p) return;
      clearTimeout(p.timer); pending.delete(message.requestId);
      if (message.resultType === "success") p.resolve(message);
      else {
        const refused = ["no-client-found", "request-version-mismatch", "no-handler-for-request"].includes(message.error);
        p.reject(new CodexControlError(refused ? "Open this task in the Codex app, then reconnect." : String(message.error ?? "Codex request failed"),
          p.mutation && !refused ? "CODEX_DELIVERY_UNKNOWN" : "CODEX_UNAVAILABLE"));
      }
    } else if (message.type === "broadcast") options.broadcast(message);
  }
  function request(method: string, params: unknown, version: number, targetClientId?: string, mutation = false) {
    if (!socket || socket.destroyed) return Promise.reject(unavailable());
    const requestId = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new CodexControlError(mutation ? "Delivery is unconfirmed. Check the conversation before sending again." : "The Codex app did not respond. Open the task in Codex and reconnect.",
          mutation ? "CODEX_DELIVERY_UNKNOWN" : "CODEX_UNAVAILABLE"));
      }, options.timeoutMs ?? 12_000);
      pending.set(requestId, { resolve, reject, timer, mutation });
      try { write({ type: "request", requestId, method, params, version, targetClientId, timeoutMs: options.timeoutMs ?? 10_000 }); }
      catch (e) { clearTimeout(timer); pending.delete(requestId); reject(e); }
    });
  }
  async function ready() {
    if (socket && !socket.destroyed && clientId !== "initializing-client") return;
    if (connecting) return connecting;
    connecting = (async () => {
      const s = connect(options.path ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "ipc", "ipc.sock"));
      socket = s;
      const decode = ipcDecoder(receive);
      s.on("data", (data) => { try { decode(data); } catch { s.destroy(); } });
      s.on("close", () => lost(s));
      s.on("error", () => lost(s));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { s.destroy(); reject(unavailable()); }, options.timeoutMs ?? 12_000);
        s.once("connect", () => { clearTimeout(timer); resolve(); });
        s.once("error", () => { clearTimeout(timer); reject(unavailable()); });
      });
      const response = await request("initialize", { clientType: "herdr-deck" }, 0);
      if (typeof response.result?.clientId !== "string") throw unavailable();
      clientId = response.result.clientId;
    })().catch((e) => { socket?.destroy(); throw e; }).finally(() => { connecting = undefined; });
    return connecting;
  }
  return {
    ready, request,
    follow(threadId: string, owner: string, following: boolean) {
      write({ type: "broadcast", method: "thread-stream-following-changed", version: 1, targetClientIds: [owner],
        params: { hostId: "local", conversationId: threadId, following } });
    },
    close() { if (socket) { const s = socket; lost(s); s.destroy(); } },
  };
}
export type CodexIpc = ReturnType<typeof createCodexIpc>;
