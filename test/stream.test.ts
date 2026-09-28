import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSse, seqStep } from "../src/http/sse";

// The page's copy of seqStep lives in a browser script (no build step): evaluate just its marked block.
const src = readFileSync(new URL("../public/js/stream.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("/* @pure:stream-begin"), src.indexOf("/* @pure:stream-end */"));
const page = new Function(`${block}; return { seqStep };`)();

type Ev = { id?: string; event: string; data: any };
/** Opens /events on a test sse and collects what arrives synchronously on connect, plus later broadcasts. */
async function open(sse: ReturnType<typeof createSse>, since?: string | null) {
  const res = sse.stream(() => ({ seq: sse.seq(), rows: ["whole state"] }), since);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Everything that has arrived: the first chunk, then whatever follows within 20 ms.
  let wait: Promise<any> | undefined;
  const read = async (): Promise<Ev[]> => {
    wait ??= reader.read();
    for (;;) {
      const r = await Promise.race([wait, Bun.sleep(20).then(() => null)]);
      if (!r || r.done) break;
      buf += dec.decode(r.value);
      wait = reader.read();
    }
    const out: Ev[] = [];
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const b = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev: Ev = { event: "", data: null };
      for (const l of b.split("\n")) { if (l.startsWith("id: ")) ev.id = l.slice(4); else if (l.startsWith("event: ")) ev.event = l.slice(7); else if (l.startsWith("data: ")) ev.data = JSON.parse(l.slice(6)); }
      out.push(ev);
    }
    return out;
  };
  return { read, close: () => reader.releaseLock() };
}

describe("sequence steps", () => {
  const cases: [string | undefined, string | undefined, string][] = [
    ["b.4", "b.5", "apply"], ["b.4", "b.4", "skip"], ["b.4", "b.2", "skip"], ["b.4", "b.6", "resync"],
    ["b.4", "c.5", "resync"], [undefined, "b.1", "apply"], ["b.4", "", "apply"], ["x.y.4", "x.y.5", "apply"],
  ];
  test("server and page agree", () => {
    for (const [have, id, want] of cases) {
      expect(seqStep(have, id)).toBe(want as any);
      expect(page.seqStep(have, id)).toBe(want);
    }
  });
});

describe("live stream", () => {
  test("a connection that says nothing gets the whole state, numbered with the last event", async () => {
    const sse = createSse();
    sse.broadcast("patch", { n: 1 });
    const c = await open(sse);
    const [full] = await c.read();
    expect(full).toMatchObject({ event: "full", id: sse.seq(), data: { seq: sse.seq() } });
    c.close();
  });

  test("a page that is up to date gets nothing but ready; one that missed events gets just those, in order", async () => {
    const sse = createSse();
    const have = sse.seq();
    sse.broadcast("patch", { n: 1 });
    sse.broadcast("notice", { message: "toast" });
    sse.broadcast("queue", { n: 2 });
    const up = await open(sse, sse.seq());
    expect(await up.read()).toEqual([{ event: "ready", data: { seq: sse.seq() } }]);
    const behind = await open(sse, have);
    const got = await behind.read();
    // Notices aren't numbered or replayed.
    expect(got.map((e) => e.event)).toEqual(["patch", "queue", "ready"]);
    expect(got.map((e) => e.id).slice(0, 2).every((id, i, a) => i === 0 || seqStep(a[i - 1], id) === "apply")).toBe(true);
    expect(seqStep(have, got[0].id)).toBe("apply");
    up.close(); behind.close();
  });

  test("live events after the replay follow on", async () => {
    const sse = createSse();
    const c = await open(sse, sse.seq());
    await c.read();
    sse.broadcast("patch", { n: 1 });
    const [e] = await c.read();
    expect(e).toMatchObject({ event: "patch", id: sse.seq() });
    c.close();
  });

  test("another boot (the deck restarted), an unknown or future number, or events gone from the buffer: stale", async () => {
    const sse = createSse({ ringBytes: 200 });
    const old = sse.seq();
    for (const since of ["otherboot.3", "garbage", `${old.split(".")[0]}.99`]) {
      const c = await open(sse, since);
      expect((await c.read()).map((e) => e.event)).toEqual(["stale"]);
      c.close();
    }
    for (let i = 0; i < 10; i++) sse.broadcast("patch", { pad: "x".repeat(40), i });
    const c = await open(sse, old);
    expect((await c.read()).map((e) => e.event)).toEqual(["stale"]);
    c.close();
    // What still fits the buffer is replayed.
    const [b, n] = [sse.seq().split(".")[0], Number(sse.seq().split(".")[1])];
    const recent = await open(sse, `${b}.${n - 1}`);
    expect((await recent.read()).map((e) => e.event)).toEqual(["patch", "ready"]);
    recent.close();
  });
});

describe("page resync", () => {
  // The page's resync (not pure: it fetches and reconnects), with its globals handed in.
  const code = src.slice(src.indexOf("/** Events that arrive"));
  function pageWith(fetchImpl: (url: string, o: any) => Promise<any>, ms = 30) {
    const calls = { reconnect: [] as number[], applied: [] as any[] };
    const S: any = { seq: "b.1" };
    const applyFull = (d: any) => { calls.applied.push(d); S.seq = d.seq; };
    const reconnectSoon = (n: number) => calls.reconnect.push(n);
    // The browser's AbortSignal.timeout (Bun 1.2's never fires, so the test brings a faithful one).
    const Signal = { timeout: (t: number) => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), t); return c.signal; } };
    const p = new Function("S", "fetch", "applyFull", "reconnectSoon", "seqStep", "RESYNC_MS", "AbortSignal", `${code}; return { resync, liveEvent, busy: () => !!resyncing };`)(
      S, fetchImpl, applyFull, reconnectSoon, page.seqStep, ms, Signal);
    return { ...p, S, calls };
  }
  /** A fetch that never answers, except by rejecting when its signal aborts (like the browser's). */
  const hang = (_url: string, o: any) => new Promise((_, rej) => o?.signal?.addEventListener("abort", () => rej(o.signal.reason)));

  test("a state fetch that hangs gives up after the timeout and reopens the stream", async () => {
    const p = pageWith(hang);
    const done = p.resync();
    expect(p.busy()).toBe(true);
    await done;
    expect(p.calls.reconnect).toEqual([2000]);
    expect(p.busy()).toBe(false);
    // Events apply again rather than waiting forever behind the dead fetch.
    const got: any[] = [];
    p.liveEvent((d: any) => got.push(d), { lastEventId: "b.2", data: '{"x":1}' });
    expect(got).toEqual([{ x: 1 }]);
  });
  test("a state that comes in time applies, and the events held meanwhile follow it", async () => {
    let answer!: (v: any) => void;
    const p = pageWith((_u, o) => { expect(o.signal).toBeDefined(); return new Promise((r) => (answer = r)); }, 1000);
    const got: any[] = [];
    p.liveEvent((d: any) => got.push(d), { lastEventId: "b.5", data: '{"n":5}' }); // out of step: resyncs
    p.liveEvent((d: any) => got.push(d), { lastEventId: "b.6", data: '{"n":6}' }); // held
    answer({ ok: true, json: async () => ({ seq: "b.4" }) });
    await Bun.sleep(5);
    expect(p.calls.applied).toEqual([{ seq: "b.4" }]);
    expect(got).toEqual([{ n: 5 }, { n: 6 }]);
    expect(p.calls.reconnect).toEqual([]);
  });
});
