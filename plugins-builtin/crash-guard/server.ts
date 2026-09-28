// Crash guard: every few seconds it looks at this machine's herdr panes; when they change (and at least once a minute)
// it saves a snapshot of them. When sessions vanish at once (herdr went away and came back, or most panes are gone),
// it records a crash against the last snapshot from before, and the page offers to restore them. Each machine's deck
// guards its own herdr; the hub also asks the others for theirs and forwards restores to them.
import { readFileSync } from "node:fs";
import type { Host } from "../../src/plugin-api";
import { createStore } from "./store";
import { createRestorer } from "./restore";
import { isPane, looksLikeCrash, restoreCommand, lostPanes, paneOf, sigOf, stillOpen, worthRestoring, type Crash, type Snapshot, type SnapPane } from "./snapshot";

type CoreRemotes = { get(id: string): { post(path: string, body: unknown): Promise<{ status: number; data: any }>; online: boolean; conf: { id: string } } | undefined; all(): { online: boolean; conf: { id: string }; post(path: string, body: unknown): Promise<{ status: number; data: any }> }[] };
const TICK = 5_000, MINUTE = 60_000, COALESCE = 20_000, MAX_AGE = 7 * 86400_000;

export function activate(host: Host) {
  const store = createStore(host.env("DECK_CRASH_GUARD_DIR") || `${host.dataDir}/crash-guard`);
  const selfId = () => host.machines().find((m) => m.local && m.kind !== "app")?.id ?? "local";
  const num = (k: string, d: number) => { const v = Number(host.setting(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  const localPanes = (): SnapPane[] => host.rows().filter((r) => (r.machine ?? selfId()) === selfId() && isPane(r)).map(paneOf);
  const workspaces = () => new Set(localPanes().flatMap((p) => [p.workspaceId, p.workspace]));
  /** Conversations you closed from the deck (the Closed list) since a time: not lost, just closed. */
  function closedSince(at: number) {
    try { return new Set((JSON.parse(readFileSync(`${host.dataDir}/graveyard.json`, "utf8")) as any[]).filter((g) => g.closedAt >= at - TICK && g.sessionId).map((g) => g.sessionId as string)); } catch { return new Set<string>(); }
  }

  let last: Snapshot | undefined = store.latest();
  let pending = 0, sawOffline = false, first = true;
  const remote = new Map<string, any>();
  let remoteJobs = false;

  const status = () => ({
    machine: selfId(), at: Date.now(), atOnce: num("atOnce", 2),
    snapshots: store.list().slice(0, 40),
    crashes: store.crashes().filter((c) => c.lost > 0),
    job: restorer.job(),
  });
  const everything = () => ({ self: selfId(), machines: { [selfId()]: status(), ...Object.fromEntries(remote) } });
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => { if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = undefined; host.broadcast("crash-guard", everything()); }, 150); };
  host.onStop(() => clearTimeout(sendTimer));

  const restorer = createRestorer({ machine: selfId(), reopen: (o) => host.sessions.reopen(o), workspaces, changed: () => changed() });

  function recordCrash(before: Snapshot, lost: SnapPane[], reason: Crash["reason"]) {
    const c: Crash = { id: crypto.randomUUID(), machine: selfId(), at: Date.now(), snapshotId: before.id, snapshotAt: before.seenAt, reason, lost: lost.length, total: before.panes.length };
    store.setCrashes([...store.crashes().filter((x) => x.snapshotId !== before.id), c]);
    host.log(`crash-guard: ${lost.length} sessions vanished (${reason}); snapshot ${before.id} kept for restore`);
    host.notice({ ok: false, message: `herdr ${reason === "restarted" ? "restarted" : "lost sessions"}: ${lost.length} session${lost.length === 1 ? " was" : "s were"} open. Restore them from the banner.` });
  }

  /** Recount each open crash against what's open now; one with nothing left to restore closes itself. */
  function recount(cur: SnapPane[]) {
    let dirty = false;
    const keep: Crash[] = [];
    for (const c of store.crashes()) {
      const snap = store.get(c.snapshotId);
      const lost = snap ? lostPanes(snap.panes, cur, closedSince(snap.at)).length : 0;
      if (lost !== c.lost) { c.lost = lost; dirty = true; }
      if (lost > 0 && Date.now() - c.at < 3 * 86400_000) keep.push(c); else dirty = true;
    }
    if (dirty) { store.setCrashes(keep); changed(); }
  }

  function tick() {
    const now = Date.now();
    const cur = localPanes();
    const herdr = host.machines().find((m) => m.id === selfId())?.herdr ?? [];
    if (herdr.some((h: any) => !h.online)) sawOffline = true;
    const worthBefore = last ? last.panes.filter(worthRestoring).length : 0;
    if (last && now - last.seenAt < MAX_AGE && !store.crashes().some((c) => c.snapshotId === last!.id)) {
      const lost = lostPanes(last.panes, cur, closedSince(last.seenAt));
      const restarted = sawOffline || (cur.length === 0 && herdr.length > 0);
      if (looksLikeCrash({ lost: lost.length, before: worthBefore, restarted, minLost: num("minLost", 3) })) {
        // Once more on the next tick: a herdr that blinks for a second isn't a crash.
        if (++pending < 2) return;
        recordCrash(last, lost, restarted ? "restarted" : first ? "fewer" : "vanished");
        pending = 0;
      } else pending = 0;
    }
    first = false;
    recount(cur);
    if (!cur.length) return; // herdr is away: nothing worth a snapshot
    sawOffline = false;
    const pinned = !!last && store.crashes().some((c) => c.snapshotId === last!.id);
    if (!last || sigOf(last.panes) !== sigOf(cur)) {
      // A burst of changes (opening five tabs) becomes one snapshot, not five.
      const reuse = last && !pinned && now - last.at < COALESCE;
      last = { id: reuse ? last!.id : store.idFor(now), machine: selfId(), at: reuse ? last!.at : now, seenAt: now, panes: cur };
      store.save(last, num("keep", 60));
      changed();
    } else if (now - last.seenAt >= MINUTE) {
      last = { ...last, seenAt: now, panes: cur }; // statuses and titles move; the snapshot keeps the latest
      store.save(last, num("keep", 60));
    }
  }

  // ── the hub: the other machines' decks guard their own herdr; ask them how it looks ──
  async function pollRemotes(onlyJobs = false) {
    if (host.isNode()) return;
    const remotes = host.use<CoreRemotes>("remotes")?.all() ?? [];
    let jobs = false, dirty = false;
    await Promise.all(remotes.map(async (r) => {
      if (!r.online) return;
      const prev = remote.get(r.conf.id);
      if (onlyJobs && !prev?.job?.running) return;
      try {
        const res = await r.post("/api/crash-guard", { op: "status" });
        if (res.status >= 300) { if (prev) { remote.delete(r.conf.id); dirty = true; } return; }
        const sig = (x: any) => JSON.stringify({ ...x, at: 0 });
        if (!prev || sig(prev) !== sig(res.data)) dirty = true;
        remote.set(r.conf.id, res.data);
        if (res.data?.job?.running) jobs = true;
      } catch {}
    }));
    remoteJobs = jobs;
    if (dirty) changed();
  }

  async function local(body: any) {
    switch (body.op) {
      case "status": return status();
      case "snapshot": {
        const s = store.get(String(body.id ?? ""));
        if (!s) return Response.json({ error: "That snapshot is gone" }, { status: 404 });
        const cur = localPanes();
        return { ...s, panes: s.panes.map((p) => ({ ...p, open: stillOpen(p, cur), cmd: restoreCommand(p) })) };
      }
      case "restore": {
        const s = store.get(String(body.id ?? ""));
        if (!s) return Response.json({ error: "That snapshot is gone" }, { status: 404 });
        const want = new Set<string>((body.keys ?? []).map(String));
        const picked = s.panes.filter((p) => want.has(p.key));
        if (!picked.length) return Response.json({ error: "Pick at least one session" }, { status: 400 });
        try { return { job: restorer.start(s.id, picked, num("atOnce", 2)) }; } catch (e: any) { return Response.json({ error: e.message }, { status: 409 }); }
      }
      case "retry": try { return { job: restorer.retry(String(body.job ?? "")) }; } catch (e: any) { return Response.json({ error: e.message }, { status: 409 }); }
      case "clear-job": restorer.clear(); changed(); return { ok: true };
      case "dismiss": {
        const c = store.crashes().find((x) => x.id === body.crash);
        if (c) { c.dismissed = true; store.setCrashes(store.crashes()); changed(); }
        return { ok: true };
      }
      case "save": tick(); return status();
    }
    return Response.json({ error: `unknown op ${body.op}` }, { status: 400 });
  }

  host.routes("crash-guard", async ({ path, body }) => {
    if (path !== "/api/crash-guard") return undefined;
    const m = body.machine;
    if (!m || m === selfId()) return local(body);
    const r = host.use<CoreRemotes>("remotes")?.get(String(m));
    if (!r) return Response.json({ error: `No machine called ${m}` }, { status: 404 });
    const res = await r.post("/api/crash-guard", { ...body, machine: undefined });
    if (["restore", "retry", "dismiss", "clear-job"].includes(body.op)) setTimeout(() => pollRemotes(), 300);
    return Response.json(res.data, { status: res.status });
  });
  host.extend("fullState", { key: "crashGuard", get: everything });
  host.every(TICK, tick);
  host.after(1_000, () => pollRemotes());
  host.every(20_000, () => pollRemotes());
  host.every(2_000, () => (remoteJobs ? pollRemotes(true) : undefined));
}
