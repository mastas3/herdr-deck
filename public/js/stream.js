"use strict";
// Keeping the page in step with the live stream (src/http/sse.ts). Every event but a notice is numbered
// "<boot>.<n>"; the page holds the last one it applied (S.seq, also inlined with the first state) and reconnects with
// ?since=, so the deck sends only what it missed. Nothing may be applied twice or skipped: an event out of step, or a
// `stale` answer (the deck restarted, or the missed events are gone), fetches the whole state once, gzipped.
/* @pure:stream-begin: no globals in here; test/stream.test.ts evaluates this block on its own. */
/** "<boot>.<n>" → [boot, n]. */
function splitSeq(s) {
  const i = s.lastIndexOf(".");
  return i > 0 ? [s.slice(0, i), Number(s.slice(i + 1))] : ["", NaN];
}
/** What to do with event `id` when everything up to `have` is applied: apply, skip (already in), or resync. */
function seqStep(have, id) {
  if (!id || !have) return "apply";
  const [hb, hn] = splitSeq(have), [b, n] = splitSeq(id);
  if (b !== hb || !Number.isInteger(n)) return "resync";
  return n <= hn ? "skip" : n === hn + 1 ? "apply" : "resync";
}
/* @pure:stream-end */
/** How long the state fetch may take: a half-open connection (a phone on a flaky link) would otherwise hold every
 *  event in `resyncing` for good. Past it the page reopens the stream from what it has, which replays or says stale. */
const RESYNC_MS = 8000;
/** Events that arrive while a fresh state is on its way wait here, then go through liveEvent again. */
let resyncing = null;
function liveEvent(fn, e) {
  if (resyncing) { resyncing.push([fn, e]); return; }
  const step = seqStep(S.seq, e.lastEventId);
  if (step === "skip") return;
  if (step === "resync") { resync(); resyncing.push([fn, e]); return; }
  if (e.lastEventId) S.seq = e.lastEventId;
  fn(JSON.parse(e.data));
}
async function resync() {
  if (resyncing) return;
  resyncing = [];
  try {
    const res = await fetch("/api/state", { cache: "no-store", signal: AbortSignal.timeout(RESYNC_MS) });
    if (!res.ok) throw new Error(`state ${res.status}`);
    applyFull(await res.json());
  } catch {
    // Start over from what the page has: the next connection replays or says stale again.
    resyncing = null;
    reconnectSoon(2000);
    return;
  }
  const waiting = resyncing;
  resyncing = null;
  for (const [fn, e] of waiting) {
    const step = seqStep(S.seq, e.lastEventId);
    if (step === "skip") continue;
    // Still out of step with a state this fresh: open the stream again from it (it replays the rest), never refetch.
    if (step === "resync") { reconnectSoon(1000); return; }
    if (e.lastEventId) S.seq = e.lastEventId;
    fn(JSON.parse(e.data));
  }
}
