import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { CodexControlError } from "./codex-ipc";

type Receipt = { hash: string; at: number; status: "pending" | "sent" | "refused"; result?: any };
export function createCodexDelivery(file?: string) {
  let receipts: Record<string, Receipt> = Object.create(null);
  let loaded = false;
  const inflight = new Map<string, Promise<any>>();
  function load() {
    if (loaded) return;
    if (file) try { receipts = Object.assign(Object.create(null), JSON.parse(readFileSync(file, "utf8"))); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    loaded = true;
  }
  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + ".tmp", JSON.stringify(receipts), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  return async function deliver(id: string, payload: unknown, send: () => Promise<any>) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new CodexControlError("Invalid message receipt", "CODEX_INVALID");
    load();
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex"), previous = receipts[id];
    if (previous && previous.hash !== hash) throw new CodexControlError("This message receipt belongs to different content.", "CODEX_INVALID");
    if (inflight.has(id)) return inflight.get(id);
    if (previous?.status === "sent") return previous.result;
    if (previous?.status === "pending") throw new CodexControlError("Delivery is unconfirmed. Check the Codex conversation before sending again.", "CODEX_DELIVERY_UNKNOWN");
    // Persist before transmission: a restart cannot blindly replay a possibly delivered message.
    receipts[id] = { hash, at: Date.now(), status: "pending" }; save();
    const run = (async () => {
      try {
        const result = await send();
        receipts[id] = { hash, at: Date.now(), status: "sent", result }; save();
        return result;
      } catch (e: any) {
        if (e.code === "CODEX_UNAVAILABLE" || e.code === "CODEX_INVALID" || e.code === "CODEX_STALE") { receipts[id].status = "refused"; save(); }
        throw e;
      } finally { inflight.delete(id); }
    })();
    inflight.set(id, run);
    return run;
  };
}
