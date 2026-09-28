// Metadata operations use Codex's canonical API; execution stays with the desktop owner.
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CodexControlError } from "./codex-ipc";

export function codexLifecycleBinary() {
  const configured = process.env.DECK_CODEX_APP_BINARY;
  if (configured) return isAbsolute(configured) && existsSync(configured) ? configured : undefined;
  for (const path of ["/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"])
    if (existsSync(path)) return path;
  // A standalone CLI can manage history, but cannot supply desktop ownership or app tools.
  return undefined;
}
const allowed = new Set(["initialize", "thread/start", "thread/read", "thread/list", "thread/turns/list", "thread/items/list", "thread/name/set", "thread/archive", "thread/unarchive", "thread/fork", "thread/inject_items", "thread/unsubscribe"]);
export type CodexMetadataSession = {
  request(method: string, params: any, mutation?: boolean): Promise<any>;
  close(): Promise<void>;
};
export async function openCodexMetadataSession(binary: string, timeoutMs = 20_000): Promise<CodexMetadataSession> {
  const child = Bun.spawn([binary, "app-server", "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  let serial = 0, closed = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer; mutation: boolean }>();
  function lost() {
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CodexControlError(p.mutation ? "Codex did not confirm this change. Check the task before trying again." : "The Codex metadata connection closed.", p.mutation ? "CODEX_DELIVERY_UNKNOWN" : "CODEX_UNAVAILABLE"));
    }
    pending.clear();
  }
  function write(message: unknown) {
    if (closed) throw new CodexControlError("The Codex metadata connection closed.");
    child.stdin.write(JSON.stringify(message) + "\n"); child.stdin.flush();
  }
  function receive(message: any) {
    // This auxiliary process never executes tools or grants permission requests.
    if (message.method && message.id != null) {
      write({ id: message.id, error: { code: -32601, message: "This client only manages task metadata." } }); return;
    }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new CodexControlError(String(message.error.message ?? "Codex metadata operation failed"), "CODEX_INVALID"));
    else p.resolve(message.result);
  }
  void (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 16 * 1024 * 1024) throw new Error("Oversized Codex response");
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (line.trim()) receive(JSON.parse(line));
        }
      }
    } catch { child.kill(); } finally { reader.releaseLock(); lost(); }
  })();
  void child.exited.then(lost);
  const session: CodexMetadataSession = {
    request(method, params, mutation = false) {
      if (!allowed.has(method)) return Promise.reject(new CodexControlError("Unsupported Codex metadata operation", "CODEX_INVALID"));
      if (closed) return Promise.reject(new CodexControlError("The Codex metadata connection closed."));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CodexControlError(mutation ? "Codex did not confirm this change. Check the task before trying again." : "The Codex metadata request timed out.", mutation ? "CODEX_DELIVERY_UNKNOWN" : "CODEX_UNAVAILABLE"));
          child.kill();
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, mutation });
        try { write({ id, method, params }); } catch (e: any) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    },
    async close() {
      lost(); child.stdin.end(); child.kill();
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await child.exited; } finally { clearTimeout(kill); }
    },
  };
  try {
    await session.request("initialize", { clientInfo: { name: "herdr-deck", version: "1" }, capabilities: { experimentalApi: true } });
    write({ method: "initialized" }); return session;
  } catch (e) { await session.close(); throw e; }
}
