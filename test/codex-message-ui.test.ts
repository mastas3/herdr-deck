import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/js/codex-message-actions.js", import.meta.url), "utf8");
function fixture(handler: (path: string, body: any) => Promise<any>) {
  const row = { key: "codex-app/original", app: "codex", capable: true };
  const state: any = { sub: null, rows: new Map([[row.key, row]]) };
  const toasts: any[] = [], selected: any[] = [], refreshed: any[] = [];
  const chats = new Map([[row.key, { original: true }]]), chatDom = { key: row.key };
  const result = new Function("rowOf", "codexHasCapability", "S", "crypto", "toast", "api", "select", "chatId", "chats", "chatDom", "chatTick", `
    let pendingSelect = null;
    ${source}
    return { button: codexForkPointButton, fork: forkCodexReply, pending: () => pendingSelect };
  `)(() => row, (r: any) => r?.app && r.capable, state, crypto,
    (text: string, error: boolean, action: any) => toasts.push({ text, error, action }), handler,
    (...args: any[]) => selected.push(args), (key: string) => key, chats, chatDom,
    (force: boolean) => refreshed.push(force));
  return { ...result, row, state, toasts, selected, chats, refreshed };
}
const reply = { role: "assistant", text: "The completed answer.", forkAfterTurnId: "turn-1", forkReplyHash: "a".repeat(64) };

test("native fork buttons require a completed assistant boundary and a task capability", () => {
  const f = fixture(async () => ({}));
  expect(f.button(reply, f.row.key)).toContain("Fork after this reply");
  expect(f.button({ ...reply, role: "user" }, f.row.key)).toBe("");
  expect(f.button({ ...reply, forkReplyHash: undefined }, f.row.key)).toBe("");
  f.state.sub = "child";
  expect(f.button(reply, f.row.key)).toBe("");
  f.state.sub = null; f.row.capable = false;
  expect(f.button(reply, f.row.key)).toBe("");
});

test("a lost fork acknowledgement waits for user retry and reuses the same receipt", async () => {
  const calls: any[] = [];
  const f = fixture(async (path, body) => {
    calls.push({ path, body });
    if (calls.length === 1) throw Object.assign(new Error("Delivery unknown"), { code: "CODEX_DELIVERY_UNKNOWN" });
    return { key: "codex-app/fork" };
  });
  await f.fork(f.row, reply);
  expect(calls).toHaveLength(1);
  expect(f.toasts.at(-1).action.label).toBe("Retry");
  await f.toasts.at(-1).action.run();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0].path).toBe("/api/codex-fork-point");
  expect(calls[0].body.lastTurnId).toBe("turn-1");
  expect(calls[0].body.replyHash).toBe(reply.forkReplyHash);
  expect(f.pending()).toBe("codex-app/fork");
  expect(f.chats.get(f.row.key)).toEqual({ original: true });
  expect(f.toasts.at(-1).action.label).toBe("Open original");
  f.toasts.at(-1).action.run();
  expect(f.selected[0][0]).toBe(f.row.key);
});

test("a stale fork point offers a refresh, with no automatic mutation", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Object.assign(new Error("Reply changed"), { code: "CODEX_STALE" }); });
  await f.fork(f.row, reply);
  expect(calls).toBe(1);
  expect(f.toasts.at(-1).action.label).toBe("Refresh chat");
  f.toasts.at(-1).action.run();
  expect(calls).toBe(1);
  expect(f.chats.has(f.row.key)).toBe(false);
  expect(f.refreshed).toEqual([true]);
});

test("double tapping a fork point cannot start a second request", async () => {
  let finish!: (value: any) => void, calls = 0;
  const f = fixture(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const first = f.fork(f.row, reply);
  await f.fork(f.row, reply);
  expect(calls).toBe(1);
  finish({ key: "codex-app/fork" });
  await first;
  expect(f.pending()).toBe("codex-app/fork");
});
