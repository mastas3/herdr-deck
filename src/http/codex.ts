import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hub } from "./hub";
import { json } from "./page";

// Only uploads made through the deck become native image inputs; other paths stay ordinary message text.
export function codexUploadImages(text: string) {
  const root = join(homedir(), ".cache/herdr-deck/uploads") + "/";
  return [...text.matchAll(/\[Attached: ([^\]\n]+)\]/g)].slice(0, 20).flatMap((m) => {
    try { const path = realpathSync(m[1]); return path.startsWith(root) && /\.(png|jpe?g|webp|gif)$/i.test(path) ? [path] : []; }
    catch { return []; }
  });
}
export async function codexApi(hub: Hub, path: string, body: any) {
  if (!["/api/codex-state", "/api/codex-stop", "/api/codex-respond", "/api/codex-compact"].includes(path)) return;
  const row = hub.hosts.localRow(body.key);
  if (!row?.app || !row.sessionId) return json({ error: "not a Codex app task" }, 400);
  const control = hub.codex;
  if (path === "/api/codex-state") return json(await control.watch(row.sessionId, !!body.reconnect));
  if (path === "/api/codex-stop") return json(await control.stop(row.sessionId, body.turnId));
  if (path === "/api/codex-respond") return json(await control.respond(row.sessionId, body.requestId, body.answer ?? {}));
  return json(await control.compact(row.sessionId));
}
