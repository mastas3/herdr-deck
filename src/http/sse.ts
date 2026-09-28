// Server-sent events: row patches, notices and the rest, to every open page and to a hub mirroring this deck.
// Every event but a notice is numbered ("<boot>.<n>"). A page opens the stream saying what it already has (?since=, or
// Last-Event-ID when the browser reconnects by itself) and gets only what it missed, replayed from a short buffer;
// when that is gone (a long sleep, a deck restart) a small `stale` event tells it to fetch the state (GET /api/state,
// gzipped). A connection that says nothing gets the whole state first, as before.
const enc = new TextEncoder();
/** Replay at most this much: past it, the state fetched gzipped (≈50 KB for 80 rows) is the cheaper way back. */
const RING_BYTES = 128 * 1024;

/** "<boot>.<n>" → [boot, n]. */
export function splitSeq(s: string): [string, number] {
  const i = s.lastIndexOf(".");
  return i > 0 ? [s.slice(0, i), Number(s.slice(i + 1))] : ["", NaN];
}
/** What to do with event `id` when everything up to `have` is applied: apply it, skip it (a replay can overlap a
 *  fetched state), or resync (one went missing, or the deck restarted). The page's copy is in public/js/stream.js. */
export function seqStep(have: string | undefined, id: string | undefined): "apply" | "skip" | "resync" {
  if (!id || !have) return "apply";
  const [hb, hn] = splitSeq(have), [b, n] = splitSeq(id);
  if (b !== hb || !Number.isInteger(n)) return "resync";
  return n <= hn ? "skip" : n === hn + 1 ? "apply" : "resync";
}

export function createSse(o: { ringBytes?: number } = {}) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const boot = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const maxRing = o.ringBytes ?? RING_BYTES;
  const ring: { n: number; chunk: Uint8Array }[] = [];
  // Every event after `floor` is still in the ring.
  let n = 0, floor = 0, ringBytes = 0;
  const seq = () => `${boot}.${n}`;
  const frame = (event: string, data: unknown, id?: string) => enc.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const send = (chunk: Uint8Array) => { for (const c of clients) try { c.enqueue(chunk); } catch { clients.delete(c); } };

  function broadcast(event: string, data: unknown) {
    // A notice is of the moment (a toast): not numbered, never replayed.
    if (event === "notice") return send(frame(event, data));
    n++;
    const chunk = frame(event, data, seq());
    ring.push({ n, chunk });
    ringBytes += chunk.length;
    while (ringBytes > maxRing && ring.length) { const x = ring.shift()!; ringBytes -= x.chunk.length; floor = x.n; }
    send(chunk);
  }
  /** The events after `since`, or undefined when they can't all be replayed (another boot, or older than the ring). */
  function missed(since: string): Uint8Array[] | undefined {
    const [b, k] = splitSeq(since);
    if (b !== boot || !Number.isInteger(k) || k < floor || k > n) return undefined;
    return ring.filter((x) => x.n > k).map((x) => x.chunk);
  }
  /** A comment every 15 s keeps idle connections open. */
  function startPing() {
    setInterval(() => send(enc.encode(`: ping\n\n`)), 15_000);
  }
  /** GET /events: the whole state first, or (`since`) what was missed and `ready`, or `stale`. Then every broadcast. */
  function stream(full: () => unknown, since?: string | null) {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        clients.add(c);
        const replay = since ? missed(since) : undefined;
        if (replay) c.enqueue(Buffer.concat([...replay, frame("ready", { seq: seq() })]));
        else if (since) c.enqueue(frame("stale", { seq: seq() }));
        else c.enqueue(frame("full", full(), seq()));
      },
      cancel() { clients.delete(ctrl); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }
  return { clients, broadcast, startPing, stream, seq };
}
export type Sse = ReturnType<typeof createSse>;
