// What /api/detail sends: the page's lite detail (no turns, their count) and a remote session's detail through the hub.
import { expect, test } from "bun:test";
import { createChat } from "../src/http/chat";
import { createForward } from "../src/http/forward";
import type { Detail } from "../src/transcript";

const turn = (i: number) => ({ at: i, ask: `ask ${i}`, images: [], reply: `reply ${i}` });
const detail = { gen: 1, messages: [], touch: new Map(), started: "hi", turns: Array.from({ length: 160 }, (_, i) => turn(i)), images: [], compactions: 0, asks: 160 } as unknown as Detail;
const row = { agent: "claude", cwd: "/tmp" } as any;

test("the page's lite detail leaves the turns out and keeps their count", () => {
  const { detailPayload } = createChat({ deck: {} as any, selfId: "mac" });
  const full = detailPayload(row, detail) as any, lite = detailPayload(row, detail, true) as any;
  expect(full.turns).toHaveLength(150);
  expect(full.turnsOmitted).toBe(10);
  expect(full.turnsCount).toBe(160);
  expect(lite.turns).toBeUndefined();
  expect(lite.turnsOmitted).toBeUndefined();
  expect(lite.turnsCount).toBe(160);
  expect({ ...lite, turnsCount: undefined }).toEqual({ ...full, turns: undefined, turnsOmitted: undefined, turnsCount: undefined });
});

test("the hub passes the page's detail options on to the session's machine, and asks it for turns only for a brief", async () => {
  const sent: any[] = [];
  const remote = { conf: { id: "linux" }, rows: new Map(), post: async (path: string, body: any) => { sent.push([path, body]); return { status: 200, data: { asks: 1, turns: [] } }; } } as any;
  const forward = createForward({ remotes: new Map([["linux", remote]]), selfId: "mac", briefKey: () => "k", closeLocal: async () => [] });
  await forward("/api/detail", { key: "linux|p1", lite: true, chat: false });
  await forward("/api/detail", { key: "linux|p1", lite: true, limit: 150 });
  await forward("/api/brief", { key: "linux|p1" });
  expect(sent).toEqual([
    ["/api/detail", { key: "p1", lite: true, chat: false, limit: undefined }],
    ["/api/detail", { key: "p1", lite: true, chat: undefined, limit: 150 }],
    ["/api/detail", { key: "p1", chat: false }],
  ]);
});
