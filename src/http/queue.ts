// Queued messages: held by the hub, sent when the agent finishes its turn. Loaded and started at startup.
import { readFileSync, writeFileSync } from "node:fs";
import type { Row } from "../deck";

type Queued = { id: string; text: string; at: number };

export function startQueue(o: { dataDir: string; broadcast: (event: string, data: unknown) => void; allRows: () => Row[]; sendAny: (key: string, text: string) => Promise<void> }) {
  const { broadcast, allRows, sendAny } = o;
  const QUEUE_FILE = `${o.dataDir}/queue.json`;
  let queues: Record<string, Queued[]> = {};
  try { queues = JSON.parse(readFileSync(QUEUE_FILE, "utf8")); } catch {}
  const saveQueues = () => { for (const k of Object.keys(queues)) if (!queues[k]?.length) delete queues[k]; try { writeFileSync(QUEUE_FILE, JSON.stringify(queues)); } catch {} broadcast("queue", queues); };
  const quietSince = new Map<string, number>();
  let draining = false;
  setInterval(async () => {
    if (draining || !Object.keys(queues).length) return;
    draining = true;
    try {
      const rows = new Map(allRows().map((r) => [r.key, r]));
      for (const key of Object.keys(queues)) {
        const row = rows.get(key);
        if (!row || !queues[key]?.length) continue;
        if (row.status === "working" || row.status === "blocked") { quietSince.delete(key); continue; }
        if (!quietSince.has(key)) quietSince.set(key, Date.now());
        if (Date.now() - quietSince.get(key)! < 2500) continue; // quiet for a moment: the turn really ended
        const item = queues[key].shift()!;
        saveQueues();
        try {
          await sendAny(key, item.text);
          quietSince.set(key, Date.now() + 12_000); // give it time to start before the next one
          broadcast("notice", { key, ok: true, message: `Sent your queued message to “${row.title}”` });
        } catch (e: any) {
          queues[key] = [item, ...(queues[key] ?? [])];
          saveQueues();
          broadcast("notice", { key, ok: false, message: `Couldn’t send the queued message: ${e?.message ?? e}` });
        }
      }
    } finally { draining = false; }
  }, 1000);
  return { queues, saveQueues };
}
