// A fake herdr server for tests: the socket API the deck uses (newline-delimited JSON over a Unix socket), backed by
// an in-memory snapshot, logging every call. Nothing real is touched. Use it in-process (startFakeHerdr) or as a
// process for end-to-end runs: `bun test/fake-herdr.ts <socket> [state.json]`, driven with the fake.* methods:
//   fake.state {state}           replace the snapshot            fake.calls {}          every call so far
//   fake.crash {}                herdr "restarts": one fresh workspace with one empty shell, subscribers dropped
//   fake.fail {cwd: [substr]}    tab.create fails for folders containing any of these
//   fake.delay {ms}              how long a new pane's shell takes to draw its prompt (pane.read is empty until then)
import { existsSync, readFileSync, rmSync } from "node:fs";

export type FakePane = { pane_id: string; workspace_id: string; tab_id: string; cwd: string; command?: string; agent?: string; agent_status?: string; agent_session?: { value: string }; focused?: boolean; label?: string; terminal_title_stripped?: string };
export type FakeState = {
  version: string; protocol: number; focused_workspace_id?: string; focused_pane_id?: string;
  workspaces: { workspace_id: string; label: string; number: number }[];
  tabs: { tab_id: string; workspace_id: string; label: string; number: number; pane_count: number }[];
  panes: FakePane[]; layouts: unknown[]; agents: unknown[];
};
export type FakeCall = { at: number; method: string; params: any };

const RESUME = /^(claude) --resume (\S+)|^(codex) resume (?:\S+ )*?([0-9a-f-]{8,})|^(opencode) -s (\S+)/;

export function emptyState(): FakeState {
  return { version: "fake", protocol: 1, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
}

/** A herdr that just started: one workspace, one tab, one empty shell. */
export function freshState(cwd = "/tmp"): FakeState {
  return { ...emptyState(), focused_workspace_id: "w1", workspaces: [{ workspace_id: "w1", label: "1", number: 1 }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "", number: 1, pane_count: 1 }], panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd }] };
}

export function startFakeHerdr(socket: string, init: FakeState = freshState()) {
  let state: FakeState = structuredClone(init);
  const calls: FakeCall[] = [];
  const born = new Map<string, number>();
  const subs = new Set<any>();
  let fail: string[] = [], delay = 0, seq = 1000;
  const id = (p: string) => `${p}${++seq}`;
  const emit = (type: string) => { for (const s of subs) try { send(s, { event: { type } }); } catch {} };
  const newTab = (wsId: string, cwd: string, label: string) => {
    const tab = { tab_id: id("t"), workspace_id: wsId, label, number: state.tabs.filter((t) => t.workspace_id === wsId).length + 1, pane_count: 1 };
    const pane: FakePane = { pane_id: id("p"), workspace_id: wsId, tab_id: tab.tab_id, cwd };
    state.tabs.push(tab); state.panes.push(pane); born.set(pane.pane_id, Date.now());
    return { tab, pane };
  };
  const err = (code: string, message: string) => ({ error: { code, message } });

  function handle(method: string, p: any, conn: any): any {
    switch (method) {
      case "session.snapshot": return { type: "session_snapshot", snapshot: state };
      case "events.subscribe": subs.add(conn); return { type: "subscribed" };
      case "pane.process_info": {
        // The fake's own pid stands in for the shell; an agent pane runs its command (with its flags) in front.
        const pane = state.panes.find((x) => x.pane_id === p.pane_id);
        if (!pane) return err("not_found", "no such pane");
        const fg = pane.agent ? [{ pid: process.pid, name: pane.agent, argv0: pane.agent, cmdline: pane.command ?? pane.agent }] : [];
        return { type: "process_info", process_info: { shell_pid: process.pid, foreground_processes: fg } };
      }
      case "pane.read": {
        const b = born.get(p.pane_id);
        return { type: "pane_read", read: { text: b && Date.now() - b < delay ? "" : `${state.panes.find((x) => x.pane_id === p.pane_id)?.cwd ?? ""} $ ` } };
      }
      case "workspace.create": {
        const ws = { workspace_id: id("w"), label: p.label ?? String(state.workspaces.length + 1), number: state.workspaces.length + 1 };
        state.workspaces.push(ws);
        const { tab, pane } = newTab(ws.workspace_id, p.cwd ?? "/tmp", "");
        emit("workspace.created");
        return { type: "workspace_created", workspace: ws, tab, root_pane: pane };
      }
      case "tab.create": {
        if (fail.some((f) => String(p.cwd ?? "").includes(f))) return err("spawn_failed", `could not start a shell in ${p.cwd}`);
        const wsId = p.workspace_id ?? state.focused_workspace_id ?? state.workspaces[0]?.workspace_id;
        if (!state.workspaces.some((w) => w.workspace_id === wsId)) return err("not_found", `no workspace ${wsId}`);
        const { tab, pane } = newTab(wsId, p.cwd ?? "/tmp", p.label ?? "");
        emit("tab.created");
        return { type: "tab_created", tab, root_pane: pane };
      }
      case "tab.rename": { const t = state.tabs.find((x) => x.tab_id === p.tab_id); if (!t) return err("not_found", "no such tab"); t.label = p.label; emit("tab.renamed"); return { type: "ok" }; }
      case "pane.send_input": {
        const pane = state.panes.find((x) => x.pane_id === p.pane_id);
        if (!pane) return err("not_found", "no such pane");
        // Typing a resume command brings that agent back in the pane, as the real one would.
        const m = String(p.text ?? "").match(RESUME);
        if (m) { pane.agent = m[1] ?? m[3] ?? m[5]; pane.agent_session = { value: m[2] ?? m[4] ?? m[6] }; pane.agent_status = "idle"; emit("pane.agent_detected"); }
        return { type: "ok" };
      }
      case "tab.close": state.panes = state.panes.filter((x) => x.tab_id !== p.tab_id); state.tabs = state.tabs.filter((x) => x.tab_id !== p.tab_id); emit("tab.closed"); return { type: "ok" };
      case "pane.close": state.panes = state.panes.filter((x) => x.pane_id !== p.pane_id); emit("pane.closed"); return { type: "ok" };
      case "agent.start": {
        const pane = state.panes.find((x) => x.pane_id === p.pane_id);
        if (!pane) return err("not_found", "no such pane");
        pane.agent = p.kind; pane.agent_status = "idle"; emit("pane.agent_detected");
        return { type: "ok" };
      }
      case "pane.focus": case "pane.send_keys": case "agent.prompt": return { type: "ok" };
      // ── test controls ──
      case "fake.state": state = structuredClone(p.state); emit("workspace.updated"); return { type: "ok" };
      // The deck polls (snapshots, screen reads) all the time: `skip` leaves those out.
      case "fake.calls": return { type: "calls", calls: calls.filter((c) => !c.method.startsWith("fake.") && !(p.skip ?? []).includes(c.method)) };
      case "fake.crash": crash(); return { type: "ok" };
      case "fake.fail": fail = [...(p.cwd ?? [])]; return { type: "ok" };
      case "fake.delay": delay = Number(p.ms) || 0; return { type: "ok" };
    }
    return err("unknown_method", `the fake has no ${method}`);
  }

  function crash() {
    state = freshState();
    for (const s of subs) try { s.end(); } catch {}
    subs.clear();
  }

  if (existsSync(socket)) rmSync(socket);
  // Big replies (fake.calls) take several writes: keep what didn't fit and send it when the socket drains.
  const flush = (s: any) => {
    while (s.data.out.length) {
      const n = s.write(s.data.out);
      if (n <= 0) return;
      s.data.out = s.data.out.subarray(n);
    }
  };
  const send = (s: any, obj: unknown) => { s.data.out = Buffer.concat([s.data.out, Buffer.from(JSON.stringify(obj) + "\n")]); flush(s); };
  const server = Bun.listen<{ buf: string; out: Buffer }>({
    unix: socket,
    socket: {
      open(s) { s.data = { buf: "", out: Buffer.alloc(0) }; },
      drain(s) { flush(s); },
      data(s, d) {
        s.data.buf += d.toString();
        let nl;
        while ((nl = s.data.buf.indexOf("\n")) >= 0) {
          const line = s.data.buf.slice(0, nl);
          s.data.buf = s.data.buf.slice(nl + 1);
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          calls.push({ at: Date.now(), method: msg.method, params: msg.params ?? {} });
          const out = handle(msg.method, msg.params ?? {}, s);
          send(s, out?.error ? { id: msg.id, error: out.error } : { id: msg.id, result: out });
        }
      },
      close(s) { subs.delete(s); },
    },
  });
  return {
    get state() { return state; },
    set state(v: FakeState) { state = structuredClone(v); emit("workspace.updated"); },
    calls, crash,
    fail: (cwd: string[]) => { fail = cwd; },
    delay: (ms: number) => { delay = ms; },
    stop: () => { server.stop(true); try { rmSync(socket); } catch {} },
  };
}

if (import.meta.main) {
  const [socket, file] = process.argv.slice(2);
  if (!socket) { console.error("usage: bun test/fake-herdr.ts <socket> [state.json]"); process.exit(2); }
  startFakeHerdr(socket, file ? JSON.parse(readFileSync(file, "utf8")) : freshState());
  console.log(`fake herdr on ${socket}`);
}
