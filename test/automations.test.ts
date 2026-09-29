import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { AlertTracker, Automations, EmptyTracker, alertMessage, buildDigest, burstMessage, cleanRules, digestDue, linkPath, type AutoDeps } from "../src/automations";
import { PushStore, cleanPrefs, endpointOk, inQuiet, wants, type Device, type Message } from "../src/push";
import type { Row } from "../src/deck";

const H = 3600_000, DAY = 24 * H;
const T0 = new Date(2026, 8, 26, 8, 30).getTime(); // a Saturday morning, local time
let n = 0;
function row(p: Partial<Row> = {}): Row {
  n++;
  return {
    key: `h/p${n}`, machine: "mac", herdr: "h", workspaceId: "w", workspace: "W", tabId: `t${n}`, tab: "", tabNumber: 1, tabPanes: 1, paneId: `p${n}`,
    agent: "claude", status: "idle", focused: false, title: `Session ${n}`, cwd: "/x", project: "proj", rssKB: 0, cpu: 0, procs: 1, tail: [],
    empty: false, stale: false, duplicate: false, approx: false, sessionId: `sid-${n}`, lastActiveAt: T0 - H, ...p,
  } as Row;
}
const map = (rows: Row[]) => new Map(rows.map((r) => [r.key, r]));

describe("alert debouncing", () => {
  test("rows present at startup are the baseline: no alerts for what was already waiting", () => {
    const t = new AlertTracker(5000, 90_000);
    const rows = [row({ status: "blocked" }), row({ status: "done" })];
    t.observe(rows, T0);
    expect(t.pending.size).toBe(0);
    expect(t.due(map(rows), T0 + 10_000)).toEqual([]);
  });
  test("becoming blocked pushes once after the grace period; staying blocked doesn't push again", () => {
    const t = new AlertTracker(5000, 90_000);
    const r = row({ status: "working" });
    t.observe([r], T0);
    const b = { ...r, status: "blocked" };
    t.observe([b], T0 + 1000);
    expect(t.due(map([b]), T0 + 2000)).toEqual([]); // still in grace
    t.observe([b], T0 + 3000);
    const out = t.due(map([b]), T0 + 7000);
    expect(out.map((e) => e.kind)).toEqual(["needs"]);
    t.observe([b], T0 + 8000);
    expect(t.due(map([b]), T0 + 20_000)).toEqual([]);
  });
  test("answered within the grace period: nothing is sent", () => {
    const t = new AlertTracker(5000, 90_000);
    const r = row({ status: "working" });
    t.observe([r], T0);
    t.observe([{ ...r, status: "blocked" }], T0 + 1000);
    const back = { ...r, status: "working" };
    t.observe([back], T0 + 3000);
    expect(t.due(map([back]), T0 + 7000)).toEqual([]);
  });
  test("flapping blocked/working within the cooldown collapses to one push", () => {
    const t = new AlertTracker(1000, 90_000);
    const r = row({ status: "working" });
    t.observe([r], T0);
    let sent = 0;
    for (let i = 0; i < 6; i++) {
      const at = T0 + i * 10_000;
      const b = { ...r, status: "blocked" };
      t.observe([b], at);
      sent += t.due(map([b]), at + 2000).length;
      t.observe([{ ...r, status: "working" }], at + 5000);
    }
    expect(sent).toBe(1);
    // after the cooldown a new question pushes again
    const b = { ...r, status: "blocked" };
    t.observe([b], T0 + 200_000);
    expect(t.due(map([b]), T0 + 202_000).length).toBe(1);
  });
  test("finishing a turn pushes once per turn; looking at it (seen) cancels it", () => {
    const t = new AlertTracker(4000, 1000);
    const r = row({ status: "working", lastActiveAt: T0 });
    t.observe([r], T0);
    const d1 = { ...r, status: "done", lastActiveAt: T0 + 1000 };
    t.observe([d1], T0 + 1000);
    expect(t.due(map([d1]), T0 + 6000).map((e) => e.kind)).toEqual(["done"]);
    t.observe([d1], T0 + 7000); // same turn: nothing new
    expect(t.pending.size).toBe(0);
    // the next turn finishes, but you open it before the grace period ends
    const d2 = { ...r, status: "done", lastActiveAt: T0 + 60_000 };
    t.observe([d2], T0 + 60_000);
    const seen = { ...d2, seen: true };
    expect(t.due(map([seen]), T0 + 65_000)).toEqual([]);
  });
  test("a session open on a screen right now isn't pushed", () => {
    const t = new AlertTracker(1000, 1000);
    const r = row({ status: "working" });
    t.observe([r], T0);
    const b = { ...r, status: "blocked" };
    t.observe([b], T0 + 100);
    expect(t.due(map([b]), T0 + 2000, (k) => k === r.key)).toEqual([]);
  });
  test("a brand-new pane that opens on a question does alert; a machine reconnecting doesn't", () => {
    const t = new AlertTracker(0, 0);
    t.observe([], T0);
    const fresh = row({ status: "blocked", bornAt: T0 - 5000 });
    const old = row({ status: "blocked", bornAt: undefined });
    t.observe([fresh, old], T0);
    expect(t.due(map([fresh, old]), T0).map((e) => e.key)).toEqual([fresh.key]);
  });
  test("Codex app threads never count as needing input", () => {
    const t = new AlertTracker(0, 0);
    const r = row({ status: "working", app: "codex" });
    t.observe([r], T0);
    t.observe([{ ...r, status: "blocked" }], T0 + 1);
    expect(t.pending.size).toBe(0);
  });
});

describe("messages", () => {
  const ctx = { machineLabel: (id?: string) => (id === "mac" ? "MacBook" : String(id)), multi: true, question: () => "Allow Bash: rm -rf build?", badge: 3 };
  test("needs-you: title, where, the question, a session link, a per-session tag", () => {
    const r = row({ title: "Fix login", project: "astra", status: "blocked", sessionId: "abc-1" });
    const m = alertMessage({ kind: "needs", key: r.key, dueAt: 0, row: r }, ctx);
    expect(m.title).toBe("Needs you: Fix login");
    expect(m.body).toBe("astra · MacBook\nAllow Bash: rm -rf build?");
    expect(m.url).toBe("/s/mac/claude/abc-1");
    expect(m.tag).toBe(`s:${r.key}`);
    expect(m.badge).toBe(3);
  });
  test("panes without a session id link by pane key", () => {
    expect(linkPath(row({ key: "h/p9", sessionId: undefined }))).toBe("/s/mac/pane/h%2Fp9");
  });
  test("bursts become one notification", () => {
    const evs = [1, 2, 3, 4].map((i) => ({ kind: (i % 2 ? "needs" : "done") as any, key: `k${i}`, dueAt: 0, row: row({ title: `T${i}` }) }));
    const m = burstMessage(evs, ctx);
    expect(m.title).toBe("2 need you, 2 finished · herdr deck");
    expect(m.body.split("\n").length).toBe(4);
    expect(m.tag).toBe("burst");
  });
});

describe("morning digest", () => {
  const now = new Date(T0);
  const rows = [
    row({ title: "Waiting A", status: "blocked", lastActiveAt: T0 - 10 * 60_000 }),
    row({ title: "Done unseen", status: "done", seen: false, lastActiveAt: T0 - 2 * H }),
    row({ title: "Done overnight", status: "idle", seen: true, lastActiveAt: T0 - 9 * H }), // 23:30 yesterday
    row({ title: "Done last afternoon", status: "idle", lastActiveAt: T0 - 17 * H }), // 15:30 yesterday: before the evening
    row({ title: "Still running", status: "working", lastActiveAt: T0 - 60_000 }),
    row({ title: "Old one", status: "idle", lastActiveAt: T0 - 4 * DAY }),
    row({ title: "Empty shell", status: "empty", empty: true, agent: "shell", lastActiveAt: T0 - 5 * DAY }),
  ];
  const d = buildDigest(rows, now);
  test("sorts sessions into waiting, finished since yesterday 18:00, running and idle 3+ days", () => {
    expect(new Date(d.since).getHours()).toBe(18);
    expect(d.since).toBe(new Date(2026, 8, 25, 18, 0).getTime());
    expect(d.waiting.map((x) => x.title)).toEqual(["Waiting A", "Done unseen"]);
    expect(d.finished.map((x) => x.title)).toEqual(["Done overnight"]);
    expect(d.running.map((x) => x.title)).toEqual(["Still running"]);
    expect(d.idle.map((x) => x.title)).toEqual(["Old one"]);
  });
  test("the push text is short and says it all", () => {
    expect(d.body).toBe("2 waiting on you: Waiting A, Done unseen\n1 finished since last evening: Done overnight\n1 still running: Still running\n1 idle 3+ days, could be closed");
  });
  test("long titles are clipped so the push stays short", () => {
    const long = buildDigest([row({ status: "blocked", title: "Please tell me the current status of all human design related projects that we have" })], now);
    expect(long.body).toBe("1 waiting on you: Please tell me the current status of all…");
  });
  test("an empty deck still gets a sensible digest", () => {
    expect(buildDigest([], now).body).toBe("Nothing waiting on you");
  });
  test("due once a day from its time, for three hours", () => {
    const at = (h: number, m: number) => new Date(2026, 8, 26, h, m);
    expect(digestDue(at(8, 29), "08:30")).toBe(false);
    expect(digestDue(at(8, 30), "08:30")).toBe(true);
    expect(digestDue(at(11, 29), "08:30")).toBe(true);
    expect(digestDue(at(11, 30), "08:30")).toBe(false);
    expect(digestDue(at(9, 0), "08:30", "2026-09-26")).toBe(false);
    expect(digestDue(at(9, 0), "08:30", "2026-09-25")).toBe(true);
  });
});

describe("empty sessions", () => {
  test("empty at startup counts from when the pane started; newly emptied counts from now", () => {
    const t = new EmptyTracker();
    const oldShell = row({ empty: true, status: "empty", startedAt: T0 - 3 * H, lastActiveAt: undefined });
    const newShell = row({ empty: true, status: "empty", startedAt: T0 - 10 * 60_000, lastActiveAt: undefined });
    const agent = row({ status: "idle" });
    t.update([oldShell, newShell, agent], T0);
    expect(t.stale(T0, 60)).toEqual([oldShell.key]);
    // the agent's conversation goes away (it was cleared): its hour starts now
    const cleared = { ...agent, empty: true, status: "empty" };
    t.update([oldShell, newShell, cleared], T0 + 1000);
    expect(t.stale(T0 + 55 * 60_000, 60)).toEqual([oldShell.key, newShell.key]);
    expect(t.stale(T0 + 61 * 60_000, 60)).toEqual([oldShell.key, newShell.key, cleared.key]);
  });
  test("a session that starts working again leaves the list; closed ones disappear", () => {
    const t = new EmptyTracker();
    const s = row({ empty: true, status: "empty", startedAt: T0 - 5 * H });
    t.update([s], T0);
    expect(t.stale(T0, 60)).toEqual([s.key]);
    t.update([{ ...s, empty: false, status: "working" }], T0 + 1);
    expect(t.stale(T0 + 2, 60)).toEqual([]);
    t.update([], T0 + 3);
    expect(t.since.size).toBe(0);
  });
  test("Codex app threads are never flagged", () => {
    const t = new EmptyTracker();
    t.update([row({ empty: true, status: "empty", app: "codex", startedAt: T0 - 9 * H })], T0);
    expect(t.stale(T0, 60)).toEqual([]);
  });
});

describe("rules config", () => {
  test("defaults, and junk is ignored", () => {
    expect(cleanRules({})).toEqual({ alerts: { on: true, needs: true, done: true }, digest: { on: true, time: "08:30" }, empty: { on: true, minutes: 60 }, proof: { on: true } });
    expect(cleanRules({ digest: { time: "25:99" }, empty: { minutes: -3 }, proof: { on: "no" } }).digest.time).toBe("08:30");
    expect(cleanRules({ empty: { minutes: "90" } }).empty.minutes).toBe(90);
  });
});

describe("devices", () => {
  const dev = (prefs: any): Device => ({ id: "d", endpoint: "https://x", keys: { p256dh: "", auth: "" }, label: "", prefs: cleanPrefs(prefs), createdAt: 0 });
  const m = (kind: Message["kind"]): Message => ({ kind, title: "", body: "" });
  test("quiet hours wrap midnight", () => {
    const q = { on: true, from: "22:00", to: "07:30" };
    const at = (h: number, mi: number) => new Date(2026, 8, 26, h, mi);
    expect(inQuiet(at(23, 0), q)).toBe(true);
    expect(inQuiet(at(3, 0), q)).toBe(true);
    expect(inQuiet(at(7, 30), q)).toBe(false);
    expect(inQuiet(at(12, 0), q)).toBe(false);
    expect(inQuiet(at(23, 0), { ...q, on: false })).toBe(false);
    expect(inQuiet(at(13, 0), { on: true, from: "12:00", to: "14:00" })).toBe(true);
  });
  test("each device gets what it asked for; quiet hours hold alerts but not the digest", () => {
    const night = new Date(2026, 8, 26, 23, 0);
    const d = dev({ needs: true, done: false, digest: true, quiet: { on: true, from: "22:00", to: "07:00" } });
    expect(wants(d, m("needs"), new Date(2026, 8, 26, 12, 0))).toBe(true);
    expect(wants(d, m("done"), new Date(2026, 8, 26, 12, 0))).toBe(false);
    expect(wants(d, m("needs"), night)).toBe(false);
    expect(wants(d, m("digest"), night)).toBe(true);
    expect(wants(d, m("test"), night)).toBe(false);
    expect(wants(d, m("test"), night, "d")).toBe(true);
  });
  test("endpoints must be https on a public host (local http only in dev)", () => {
    expect(endpointOk("https://web.push.apple.com/abc", false)).toBe(true);
    expect(endpointOk("https://fcm.googleapis.com/fcm/send/x", false)).toBe(true);
    expect(endpointOk("http://127.0.0.1:9/x", false)).toBe(false);
    expect(endpointOk("http://127.0.0.1:9/x", true)).toBe(true);
    expect(endpointOk("https://127.0.0.1/x", true)).toBe(false);
    expect(endpointOk("https://192.168.1.2/x", false)).toBe(false);
    expect(endpointOk("file:///etc/passwd", true)).toBe(false);
  });
  test("store: re-subscribing replaces the device's old endpoint; 410 drops it; file is mode 600", async () => {
    const dir = mkdtempSync(`${tmpdir()}/subs-`);
    let status = 201;
    const calls: string[] = [];
    const s = await new PushStore(dir, "mailto:a@b.c", async (sub) => { calls.push(sub.endpoint); return { status, ok: status < 300, gone: status === 410 }; }).init();
    s.upsert({ id: "phone", endpoint: "https://web.push.apple.com/1", keys: { p256dh: "k", auth: "a" }, label: "iPhone" });
    s.upsert({ id: "phone", endpoint: "https://web.push.apple.com/2", keys: { p256dh: "k", auth: "a" } });
    s.upsert({ id: "mac", endpoint: "https://fcm.googleapis.com/3", keys: { p256dh: "k", auth: "a" }, label: "Mac", prefs: { done: false } });
    expect(s.devices.map((d) => [d.id, d.endpoint, d.label])).toEqual([["phone", "https://web.push.apple.com/2", "iPhone"], ["mac", "https://fcm.googleapis.com/3", "Mac"]]);
    expect(statSync(`${dir}/push-subs.json`).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(s.list())).not.toContain("p256dh");
    const r1 = await s.deliver({ kind: "done", title: "t", body: "b" }, { now: new Date(2026, 8, 26, 12) });
    expect(r1).toMatchObject({ sent: 1, targets: 1 });
    expect(calls).toEqual(["https://web.push.apple.com/2"]);
    status = 410;
    s.youngMs = 0; // both devices count as settled: a 410 is believed at once
    const r2 = await s.deliver({ kind: "needs", title: "t", body: "b" }, { now: new Date(2026, 8, 26, 12) });
    expect(r2).toMatchObject({ sent: 0, targets: 2, dropped: 2 });
    expect(s.devices).toEqual([]);
    expect(JSON.parse(readFileSync(`${dir}/push-subs.json`, "utf8"))).toEqual([]);
  });
});

test("a subscription only seconds old that answers 410 is retried, not dropped at once", async () => {
  const dir = mkdtempSync(`${tmpdir()}/subs-`);
  const answers = [410, 410, 201];
  const s = await new PushStore(dir, "mailto:a@b.c", async () => { const st = answers.shift() ?? 201; return { status: st, ok: st < 300, gone: st === 410 }; }).init();
  s.retryMs = 5;
  s.upsert({ id: "new", endpoint: "https://fcm.googleapis.com/n", keys: { p256dh: "k", auth: "a" } });
  const r = await s.deliver({ kind: "test", title: "t", body: "b" }, { only: "new" });
  expect(r).toMatchObject({ sent: 1, dropped: 0 });
  expect(s.devices.length).toBe(1);
});

describe("the rules engine", () => {
  const NOON = T0 + 3.5 * H; // away from the digest window
  function engine(rows: Row[], now: { t: number }, extra: Partial<AutoDeps> = {}) {
    const dir = mkdtempSync(`${tmpdir()}/auto-`);
    const sent: Message[] = [];
    const deps: AutoDeps = {
      file: `${dir}/automations.json`, rows: () => rows, now: () => now.t, changed: () => {}, viewing: () => false, canSend: () => true,
      ctx: () => ({ machineLabel: (x) => String(x), multi: false }),
      deliver: async (m) => { sent.push(m); return { sent: 1, targets: 1, dropped: 0 }; },
      ...extra,
    };
    return { a: new Automations(deps), sent, dir };
  }
  test("a session that needs you gets one push, recorded as the rule's last result", async () => {
    const now = { t: NOON };
    const r = row({ status: "working", title: "Build it" });
    const rows = [r];
    const { a, sent } = engine(rows, now);
    a.observe();
    rows[0] = { ...r, status: "blocked" };
    a.observe();
    now.t += 6000;
    await a.tick();
    await a.tick();
    expect(sent.map((m) => m.title)).toEqual(["Needs you: Build it"]);
    expect(a.publicState().status.alerts?.lastResult).toContain("1 delivered");
  });
  test("three at once become one burst push", async () => {
    const now = { t: NOON };
    const rows = [row({ status: "working" }), row({ status: "working" }), row({ status: "working" })];
    const { a, sent } = engine(rows, now);
    a.observe();
    for (let i = 0; i < 3; i++) rows[i] = { ...rows[i], status: "blocked" };
    a.observe();
    now.t += 6000;
    await a.tick();
    expect(sent.map((m) => m.kind)).toEqual(["burst"]);
  });
  test("stale worktrees: once a week in the scheduled digest, always when you ask for it", async () => {
    const now = { t: new Date(2026, 8, 28, 8, 31).getTime() };
    const stale = [{ path: "/r/.claude/worktrees/x", repo: "r", branch: "stas/x", base: "main", why: "merged" as const, days: 3, dirty: 0 }];
    let asked = 0;
    const { a, sent } = engine([], now, { worktrees: async () => { asked++; return { stale, line: "1 worktree looks finished: r ⎇ stas/x (merged into main)" }; } });
    await a.runDigest(true, true);
    expect(a.publicState().digest?.stale).toEqual(stale);
    expect(sent[0].body).toContain("1 worktree looks finished");
    now.t += 24 * H;
    await a.runDigest(true, true);
    expect(a.publicState().digest?.stale).toBeUndefined();
    expect(asked).toBe(1);
    await a.runDigest(false);
    expect(a.publicState().digest?.stale).toEqual(stale);
    now.t += 6 * 24 * H;
    await a.runDigest(true, true);
    expect(asked).toBe(3);
  });
  test("the scheduled digest runs once at its time, pushes, and shows until dismissed", async () => {
    const now = { t: new Date(2026, 8, 26, 8, 0).getTime() };
    const { a, sent } = engine([row({ status: "blocked" })], now);
    await a.tick();
    expect(sent).toEqual([]);
    now.t = new Date(2026, 8, 26, 8, 31).getTime();
    await a.tick();
    await a.tick();
    expect(sent.map((m) => m.kind)).toEqual(["digest"]);
    expect(a.publicState().digest?.counts.waiting).toBe(1);
    expect(a.publicState().status.digest?.lastResult).toContain("pushed to 1 of 1 device");
    a.dismissDigest();
    expect(a.publicState().digest).toBeNull();
    now.t += 24 * H;
    await a.tick();
    expect(sent.length).toBe(2);
  });
  test("turning alerts off stops pushes; empty sessions over the limit are listed", async () => {
    const now = { t: NOON };
    const shell = row({ empty: true, status: "empty", agent: "shell", startedAt: NOON - 2 * H });
    const r = row({ status: "working" });
    const rows = [r, shell];
    const { a, sent } = engine(rows, now);
    a.setRules({ alerts: { on: false } });
    a.observe();
    rows[0] = { ...r, status: "blocked" };
    now.t += 6000;
    await a.tick();
    expect(sent).toEqual([]);
    expect(a.publicState().empty.keys).toEqual([shell.key]);
    a.setRules({ empty: { minutes: 180 } });
    await a.tick();
    expect(a.publicState().empty.keys).toEqual([]);
    expect(a.rules.alerts).toEqual({ on: false, needs: true, done: true });
  });
});
