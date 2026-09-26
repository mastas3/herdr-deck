// Server-sent events: each open page gets the full state when it connects, then row patches, notices and the rest.
const enc = new TextEncoder();

export function createSse() {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function broadcast(event: string, data: unknown) {
    const chunk = sse(event, data);
    for (const c of clients) try { c.enqueue(chunk); } catch { clients.delete(c); }
  }
  /** A comment every 15 s keeps idle connections open. */
  function startPing() {
    setInterval(() => {
      const ping = enc.encode(`: ping\n\n`);
      for (const c of clients) try { c.enqueue(ping); } catch { clients.delete(c); }
    }, 15_000);
  }
  /** GET /events: the full state first, then whatever is broadcast. */
  function stream(full: () => unknown) {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        clients.add(c);
        c.enqueue(sse("full", full()));
      },
      cancel() { clients.delete(ctrl); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }
  return { clients, broadcast, startPing, stream };
}
export type Sse = ReturnType<typeof createSse>;
