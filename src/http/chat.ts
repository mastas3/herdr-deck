// A session's conversation for the page: its detail (brief, recap, turns, images), windows of the chat, and deep
// search across every live conversation.
import { detailFor as detailOf, imageFor as imageOf, subDetailFor } from "../insight";
import { cachedBrief } from "../brief";
import type { Deck, Row } from "../deck";
import type { Detail, Msg } from "../transcript";
import { isPrivatePath } from "../private-folder";

export function createChat(o: { deck: Deck; selfId: string }) {
  const { deck } = o;
  const who = (row: Row) => ({ agent: row.agent, sessionId: row.sessionId, cwd: row.cwd, file: (row as any).hist as string | undefined });
  const detailFor = (row: Row) => detailOf(who(row));
  const imageFor = (row: Row, id: string, sub?: string) => imageOf(who(row), id, sub);

  /** A window of the chat: the newest `limit` messages, those after a cursor (live updates) or before one (scrollback). */
  function chatSlice(d: Detail, q: { gen?: number; after?: number; before?: number; limit?: number; around?: number; from?: number; to?: number }) {
    const limit = Math.min(Math.max(Number(q.limit) || 120, 1), 400);
    const all = d.messages;
    let msgs: Msg[];
    const sameGen = q.gen === d.gen;
    if (q.around != null) {
      // Jumping to a search hit: a window around it, plus the newest messages so the chat still ends where it is.
      const a = Math.max(0, Math.min(all.length - 1, Number(q.around)));
      const win = all.slice(Math.max(0, a - 30), a + 120);
      const tail = all.slice(-60).filter((m) => m.i >= a + 120);
      return { gen: d.gen, total: all.length, reset: true, messages: [...win, ...tail] };
    }
    if (sameGen && q.from != null) msgs = all.slice(Math.max(0, Number(q.from)), Math.min(all.length, Number(q.to ?? Number(q.from) + limit)));
    else if (sameGen && q.after != null) {
      // Tool calls flip from running to done, so resend the tail window the client already has as well.
      const from = Math.max(0, Math.min(Number(q.after) + 1, all.length) - 12);
      msgs = all.slice(from);
    } else if (sameGen && q.before != null) msgs = all.slice(Math.max(0, Number(q.before) - limit), Number(q.before));
    else msgs = all.slice(-limit);
    return { gen: d.gen, total: all.length, reset: !sameGen && (q.after != null || q.before != null), messages: msgs };
  }

  // ── deep search across every conversation ────────────────────────────────

  /** Every word must appear in one message; hits rank by how many messages match and how recent the best one is. */
  async function searchLocal(q: string) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !/^(is|agent):/.test(w) && !w.startsWith("-"));
    if (!words.length || q.length < 3) return [];
    const hits: any[] = [];
    const t0 = performance.now();
    for (const row of deck.rows.values()) {
      if (!row.sessionId || isPrivatePath(row.cwd) || performance.now() - t0 > 400) continue; // private sessions stay out of search
      const d = await detailFor(row).catch(() => undefined);
      if (!d) continue;
      let best: Msg | undefined, count = 0;
      for (let i = d.messages.length - 1; i >= 0; i--) {
        const m = d.messages[i];
        const text = (m.text ?? `${m.tool ?? ""} ${m.summary ?? ""}`).toLowerCase();
        if (!words.every((w) => text.includes(w))) continue;
        count++;
        if (!best || (best.role === "tool" && m.role !== "tool")) best = m;
        if (count > 50) break;
      }
      if (!best) continue;
      const text = best.text ?? `${best.tool}: ${best.summary}`;
      const at = text.toLowerCase().indexOf(words[0]);
      const from = Math.max(0, at - 70);
      const snippet = (from > 0 ? "…" : "") + text.slice(from, at + 150).replace(/\s+/g, " ").trim() + (at + 150 < text.length ? "…" : "");
      hits.push({ key: row.key, i: best.i, role: best.role, at: best.at, count, snippet });
    }
    return hits.sort((a, b) => b.count - a.count || (b.at ?? 0) - (a.at ?? 0)).slice(0, 80);
  }

  async function chatFor(row: Row, body: any) {
    const d = body.sub ? await subDetailFor(who(row), String(body.sub)) : await detailFor(row);
    if (!d) return { gen: 0, total: 0, messages: [] };
    return chatSlice(d, body);
  }

  const briefKey = (row: Row) => (row.machine && row.machine !== o.selfId ? `${row.machine}-` : "") + `${row.agent}-${row.sessionId}`;

  /** Detail payload: newest turns first are what the page shows, so cap from the end. `lite` (the page) leaves the
   *  turns out: it only needs their count, while the hub's brief of another machine's session reads them. */
  function detailPayload(row: Row, d: Detail | undefined, lite = false) {
    const brief = row.sessionId ? cachedBrief(briefKey(row)) : undefined;
    if (!d) return { brief };
    return {
      brief,
      briefStale: !!brief && brief.asks !== d.asks,
      startedAt: d.startedAt,
      started: d.started,
      recap: d.recap,
      aiTitle: d.aiTitle,
      asks: d.asks,
      compactions: d.compactions,
      workMs: d.workMs,
      turnsCount: d.turns.length,
      ...(lite ? {} : { turns: d.turns.slice(-150), turnsOmitted: Math.max(0, d.turns.length - 150) }),
      images: d.images.slice(-60),
      imagesTotal: d.images.length,
    };
  }
  return { who, detailFor, imageFor, chatSlice, searchLocal, chatFor, briefKey, detailPayload };
}
export type Chat = ReturnType<typeof createChat>;
