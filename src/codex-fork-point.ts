import { createHash } from "node:crypto";
import { CodexControlError } from "./codex-ipc";
import type { CodexMetadataSession } from "./codex-app-server";

export type CodexForkPoint = { lastTurnId: string; replyHash: string };
export function codexReplyHash(text: string) { return createHash("sha256").update(text.trim()).digest("hex"); }
const stale = (message: string) => new CodexControlError(message, "CODEX_STALE");
export function validateCodexForkPoint(value: any): CodexForkPoint {
  if (typeof value?.lastTurnId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.lastTurnId)
    || typeof value.replyHash !== "string" || !/^[a-f0-9]{64}$/.test(value.replyHash)) {
    throw new CodexControlError("Choose a completed Codex reply to fork after.", "CODEX_INVALID");
  }
  return { lastTurnId: value.lastTurnId, replyHash: value.replyHash };
}

async function findTurn(session: CodexMetadataSession, threadId: string, turnId: string, mustBeLast: boolean) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const result = await session.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "notLoaded" });
    const turns = Array.isArray(result.data) ? result.data : [];
    if (mustBeLast && turns[0]?.id !== turnId) throw stale("The fork did not end at the selected reply. Check it in Codex.");
    const turn = turns.find((t: any) => t.id === turnId);
    if (turn) {
      if (turn.status !== "completed") throw stale("Wait for this Codex reply to finish before forking it.");
      return;
    }
    if (!result.nextCursor || seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw stale("This reply is no longer in the Codex conversation. Refresh it before forking.");
}

export async function verifyCodexForkPoint(session: CodexMetadataSession, threadId: string, point: CodexForkPoint, mustBeLast = false) {
  await findTurn(session, threadId, point.lastTurnId, mustBeLast);
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    // Fetch the tail one item at a time: an earlier huge tool result must not crowd out a short final reply.
    const result = await session.request("thread/items/list", { threadId, turnId: point.lastTurnId, cursor, limit: 1, sortDirection: "desc" });
    if (!Array.isArray(result.data) || result.data.some((entry: any) => entry.turnId !== point.lastTurnId)) throw stale("Codex returned a different reply. Refresh before forking.");
    const reply = result.data.find((entry: any) => entry.item?.type === "agentMessage" && typeof entry.item.text === "string" && entry.item.text.trim());
    if (reply) {
      if (codexReplyHash(reply.item.text) !== point.replyHash) throw stale("This Codex reply changed. Refresh the conversation before forking.");
      return;
    }
    if (!result.nextCursor || seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw stale("This turn has no completed assistant reply to fork after.");
}
