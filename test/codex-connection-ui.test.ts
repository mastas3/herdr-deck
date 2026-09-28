import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const controls = readFileSync(new URL("../public/js/codex-controls.js", import.meta.url), "utf8").split("async function stopCodex")[0];
const composer = readFileSync(new URL("../public/js/composer.js", import.meta.url), "utf8");
const send = composer.slice(composer.indexOf("async function sendMessage"), composer.indexOf("async function sendReadyMessage"));
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture() {
  const requests: any[] = [], sends: any[] = [], notices: any[] = [];
  const timers = new Map<number, () => Promise<void>>(); let serial = 0;
  const state = { sel: "chat-a", board: false, mode: null };
  const rows = new Map(["chat-a", "chat-b"].map((key) => [key, { key, app: true }]));
  const drafts = new Map<string, any[]>();
  const result = new Function("S", "rowOf", "api", "renderDetail", "renderQueue", "setTimeout", "clearTimeout", "toast", "esc", "pasteList", `
    ${controls}
    ${send}
    const sendReadyMessage = (...args) => readySend(...args);
    let readySend;
    return { sync: syncCodexControl, connect: connectCodex, html: codexConnectionHTML, views: codexViews, sending: codexSending,
      send: sendMessage, onSend: (fn) => { readySend = fn; } };
  `)(state, (key: string) => rows.get(key), (path: string, body: any) => {
    const pending = deferred(); requests.push({ path, body, ...pending }); return pending.promise;
  }, () => {}, () => {}, (fn: () => Promise<void>) => { timers.set(++serial, fn); return serial; }, (id: number) => timers.delete(id),
  (...args: any[]) => notices.push(args), (text: string) => text, (key: string) => drafts.get(key) ?? []);
  result.onSend((...args: any[]) => sends.push(args));
  return { ...result, state, row: rows.get("chat-a"), rows, requests, sends, notices, drafts, timers,
    tick() { const [id, fn] = timers.entries().next().value!; timers.delete(id); return fn(); } };
}

test("initial checks and unloaded chats do not show a wall of recovery buttons", () => {
  const f = fixture();
  expect(f.html(f.row)).toContain("Checking Codex");
  expect(f.html(f.row)).not.toContain("<button");
  f.views.set(f.row.key, { ready: false, canOpen: true, connectionIssue: "not-loaded" });
  expect(f.html(f.row)).toContain("Send a reply");
  expect(f.html(f.row)).not.toContain("<button");
  f.views.set(f.row.key, { ready: true });
  expect(f.html(f.row)).toBe("");
  f.views.set(f.row.key, { ready: false, canOpen: true, error: "Offline" });
  expect(f.html(f.row).match(/<button/g)).toHaveLength(1);
  expect(f.html(f.row)).not.toContain("Open in Codex");
});

test("an old poll cannot replace a successful explicit connection, including a late failure", async () => {
  for (const failure of [false, true]) {
    const f = fixture(); f.sync(f.row); const poll = f.tick();
    const connecting = f.connect(f.row);
    expect(f.connect(f.row)).toBe(connecting);
    expect(f.requests.map((r: any) => r.path)).toEqual(["/api/codex-state", "/api/codex-connect"]);
    f.requests[1].resolve({ ready: true }); await connecting;
    if (failure) f.requests[0].reject(new Error("Old failure")); else f.requests[0].resolve({ ready: false });
    await poll;
    expect(f.views.get(f.row.key).ready).toBe(true);
    expect(f.timers.size).toBe(1);
  }
});

test("leaving and returning to the same chat cannot resurrect an old polling loop", async () => {
  const f = fixture(); f.sync(f.row); const first = f.tick();
  f.sync(f.rows.get("chat-b")); f.sync(f.row); const current = f.tick();
  f.requests[1].resolve({ ready: true }); await current;
  f.requests[0].resolve({ ready: false }); await first;
  expect(f.views.get(f.row.key).ready).toBe(true);
  expect(f.timers.size).toBe(1);
});

test("Send connects an unloaded chat once and double taps cannot duplicate the message", async () => {
  const f = fixture(), input = { value: "My reply" };
  const sending = f.send(input.value, input);
  await f.send(input.value, input);
  expect(f.sends).toHaveLength(0);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ path: "/api/codex-connect", body: { key: f.row.key } });
  f.requests[0].resolve({ ready: true }); await sending;
  expect(f.sends).toEqual([[f.row, "My reply", input, undefined]]);
  expect(f.sending.size).toBe(0);
});

test("a connection failure preserves the draft and attachments and never sends", async () => {
  const f = fixture(), input = { value: "My reply" }, pastes = [{ id: "attachment" }];
  f.drafts.set(f.row.key, pastes);
  const sending = f.send(input.value, input);
  f.requests[0].resolve({ ready: false, error: "Offline" }); await sending;
  expect(f.sends).toHaveLength(0);
  expect(input.value).toBe("My reply");
  expect(f.drafts.get(f.row.key)).toEqual(pastes);
  expect(f.notices.at(-1)[2].label).toBe("Retry");
});

test("navigation or draft edits while connecting require a fresh Send", async () => {
  for (const change of ["navigate", "text", "attachment"]) {
    const f = fixture(), input = { value: "Original draft" };
    const sending = f.send(input.value, input);
    if (change === "navigate") { f.state.sel = "chat-b"; input.value = "Other chat draft"; }
    if (change === "text") input.value = "Revised draft";
    if (change === "attachment") f.drafts.set(f.row.key, [{ id: "new" }]);
    f.requests[0].resolve({ ready: true }); await sending;
    expect(f.sends).toHaveLength(0);
    expect(input.value).toContain("draft");
    expect(f.views.get(f.row.key).ready).toBe(true);
  }
});

test("already connected chats send directly without opening the app", async () => {
  const f = fixture(), input = { value: "My reply" };
  f.views.set(f.row.key, { ready: true });
  await f.send(input.value, input);
  expect(f.requests).toHaveLength(0);
  expect(f.sends).toHaveLength(1);
});
