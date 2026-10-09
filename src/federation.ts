// Other machines: each runs its own herdr-deck (a "node"); this deck (the hub) reaches each one over an
// SSH tunnel, authenticates with the node's API token, mirrors its rows from the node's event stream,
// and forwards actions. Remote keys are "<machine>|<node key>" so one list can hold every machine.
import type { Subprocess } from "bun";
import type { Row } from "./deck";
import type { MachineUsage } from "./usage-accounts";
import { nodeUsage } from "./usage-merge";
import { RowFeed, type Usage } from "./row-feed";
import { seqStep } from "./http/sse";

export type RemoteConf = { id: string; label: string; ssh: string; remotePort?: number; localPort?: number };
export type Machine = { id: string; label: string; local: boolean; online: boolean; error?: string; herdr?: any[]; kind?: "app"; home?: string };

type Listener = {
  /** Rows that changed or went (both empty: only this machine's summary or online state changed). */
  patch: (upsert: Row[], remove: string[]) => void;
  procs: (u: Record<string, Usage>) => void;
  graveyard: () => void;
  notice: (n: any) => void;
  usage: () => void;
};
/** The node's stream skipped an event: reconnect from the last one applied (it replays the rest). */
class Gap extends Error {}

export class RemoteHost {
  rows = new Map<string, Row>();
  graveyard: any[] = [];
  summary: any = { herdr: [] };
  /** The node's own AI accounts and limits; kept while it's offline (the page shows how old it is). */
  usage?: MachineUsage;
  online = false;
  error?: string = "connecting";
  private token?: string;
  private tunnel?: Subprocess;
  private stopped = false;
  private tunnelUp?: Promise<void>;
  /** The node's last event applied here ("<boot>.<n>"): a reconnect asks only for what came after. */
  private seq?: string;
  /** Passes on only what the hub's pages show: an older node still sends rows whose start time jitters. */
  private feed = new RowFeed();
  base = "";

  constructor(readonly conf: RemoteConf, private on: Listener) {}

  machine(): Machine {
    const home = this.summary?.machines?.find((m: any) => m.local && m.kind !== "app")?.home;
    return { ...(typeof home === "string" ? { home } : {}), id: this.conf.id, label: this.conf.label, local: false, online: this.online, error: this.error, herdr: this.summary?.herdr };
  }

  start() {
    this.openTunnel();
    this.streamLoop();
  }

  stop() {
    this.stopped = true;
    this.tunnel?.kill();
  }

  // ── transport ──────────────────────────────────────────────────────────────

  /** A fresh free loopback port per tunnel, so a stale tunnel can never shadow this one. */
  private freePort(): number {
    const srv = Bun.listen({ hostname: "127.0.0.1", port: this.conf.localPort ?? 0, socket: { data() {} } });
    const port = srv.port;
    srv.stop(true);
    return port;
  }

  private openTunnel() {
    if (this.stopped) return;
    const { ssh, remotePort = 4747 } = this.conf;
    const port = this.freePort();
    this.base = `http://127.0.0.1:${port}`;
    // The remote side just reads stdin: when this process dies the pipe closes and the tunnel exits with it.
    this.tunnel = Bun.spawn(
      ["ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
        "-o", "ConnectTimeout=8", "-L", `127.0.0.1:${port}:127.0.0.1:${remotePort}`, ssh, "cat >/dev/null"],
      { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
    const t = this.tunnel;
    this.tunnelUp = this.waitForPort(port);
    t.exited.then(async () => {
      const err = (await new Response(t.stderr as ReadableStream).text().catch(() => "")).trim().split("\n").pop();
      if (this.stopped) return;
      this.error = err ? `SSH: ${err}` : "SSH tunnel closed";
      setTimeout(() => this.openTunnel(), 4000);
    });
  }

  private async waitForPort(port: number) {
    for (let i = 0; i < 60; i++) {
      try { const c = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }); c.end(); return; } catch {}
      await Bun.sleep(200);
    }
  }

  private async fetchToken(): Promise<string> {
    const p = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", this.conf.ssh, "cat ~/.config/herdr-deck/api.token"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    if (p.exitCode !== 0 || !/^[a-f0-9]{32,}$/.test(out)) throw new Error("herdr-deck isn't installed on this machine yet (no API token)");
    return out;
  }

  private headers() {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  private setOffline(error: string) {
    const changed = this.online || this.error !== error;
    this.online = false;
    this.error = error;
    if (changed) this.on.patch([], []);
  }

  /** Mirrors the node's SSE stream; reconnects with backoff forever. */
  private async streamLoop() {
    let delay = 1500;
    while (!this.stopped) {
      try {
        this.token ??= await this.fetchToken();
        await this.tunnelUp;
        const res = await fetch(`${this.base}/events${this.seq ? `?since=${encodeURIComponent(this.seq)}` : ""}`, { headers: this.headers() });
        if (res.status === 401 || res.status === 403) {
          this.token = undefined;
          throw new Error("the node rejected our token");
        }
        if (!res.ok || !res.body) throw new Error(`node answered ${res.status}`);
        delay = 1500;
        await this.consume(res.body);
        throw new Error("stream ended");
      } catch (e: any) {
        if (e instanceof Gap) { await Bun.sleep(200); continue; }
        const msg = e?.code === "ConnectionRefused" || /ECONNREFUSED|Unable to connect/i.test(String(e?.message)) ? "can't reach the node (is herdr-deck running there?)" : String(e?.message ?? e);
        this.setOffline(msg);
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 15000);
      }
    }
  }

  private async consume(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    try {
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = "message", data = "", id = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
            else if (line.startsWith("id: ")) id = line.slice(4);
          }
          if (data) await this.receive(event, JSON.parse(data), id);
        }
      }
    } finally {
      // Leaving early (a gap, a bad event) must close the connection too, not leave it open under a new one.
      reader.cancel().catch(() => {});
    }
  }

  /** A node's row under the hub's keys: its own, and its dispatcher's (a worker's parent is on the same machine). */
  private tag = (r: Row): Row => ({ ...r, key: `${this.conf.id}|${r.key}`, machine: this.conf.id, ...(r.parent?.key ? { parent: { ...r.parent, key: `${this.conf.id}|${r.parent.key}` } } : {}) });
  private tagGrave = (g: any) => ({ ...g, id: `${this.conf.id}|${g.id}`, machine: this.conf.id });

  /** One event from the node's stream, in order: numbered ones must follow on from the last applied. */
  private async receive(event: string, data: any, id: string) {
    if (event === "full") { this.applyState(data, id || data.seq); return; }
    if (event === "stale") {
      // The node no longer has what we missed (it restarted, or we were away long): take its whole state, gzipped.
      const res = await this.get("/api/state");
      if (!res.ok) throw new Error(`node answered ${res.status}`);
      const st = await res.json();
      this.applyState(st, st.seq);
      return;
    }
    if (event === "ready") { this.goOnline(); return; }
    if (id) {
      const step = seqStep(this.seq, id);
      if (step === "skip") return;
      if (step === "resync") throw new Gap(`missed events before ${id}`);
      this.seq = id;
    }
    this.handle(event, data);
  }

  private goOnline() {
    if (this.online && !this.error) return;
    this.online = true;
    this.error = undefined;
    this.on.patch([], []);
  }

  /** The node's whole state (on connect, or after `stale`): passed on as the rows that differ from what we had. */
  private applyState(data: any, seq?: string) {
    this.seq = seq || undefined;
    this.online = true;
    this.error = undefined;
    this.rows = new Map(data.rows.map((r: Row) => { const t = this.tag(r); return [t.key, t]; }));
    this.summary = data.summary;
    this.graveyard = (data.graveyard ?? []).map(this.tagGrave);
    this.usage = nodeUsage(data.usage) ?? this.usage;
    const { upsert, remove } = this.feed.diff(this.rows.values());
    this.on.patch(upsert, remove);
    const u = this.feed.flushUsage(this.rows.values());
    if (u) this.on.procs(u);
    this.on.graveyard();
    this.on.usage();
  }

  private handle(event: string, data: any) {
    if (event === "patch") {
      const upsert = data.upsert.map(this.tag);
      for (const r of upsert) this.rows.set(r.key, r);
      const remove = data.remove.map((k: string) => `${this.conf.id}|${k}`);
      for (const k of remove) { this.rows.delete(k); this.feed.forget(k); }
      const summaryChanged = JSON.stringify(data.summary?.herdr) !== JSON.stringify(this.summary?.herdr);
      this.summary = data.summary;
      const changed = this.feed.diff(upsert, false).upsert;
      if (changed.length || remove.length || summaryChanged) this.on.patch(changed, remove);
      const u = this.feed.takeUsage(this.rows.values());
      if (u) this.on.procs(u);
    } else if (event === "procs") {
      const u: Record<string, Usage> = {};
      for (const [k, v] of Object.entries<Usage>(data)) {
        const key = `${this.conf.id}|${k}`, r = this.rows.get(key);
        if (!r) continue;
        [r.rssKB, r.cpu, r.procs] = v;
        this.feed.noteUsage(key, v);
        u[key] = v;
      }
      if (Object.keys(u).length) this.on.procs(u);
    } else if (event === "graveyard") {
      this.graveyard = data.map(this.tagGrave);
      this.on.graveyard();
    } else if (event === "usage") {
      this.usage = nodeUsage(data) ?? this.usage;
      this.on.usage();
    } else if (event === "notice") {
      this.on.notice({ ...data, key: data.key ? `${this.conf.id}|${data.key}` : undefined, message: `${this.conf.label}: ${data.message}` });
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async post(path: string, body: unknown): Promise<{ status: number; data: any }> {
    if (!this.online) throw new Error(`${this.conf.label} is offline: ${this.error ?? "not connected"}`);
    const res = await fetch(`${this.base}${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  /** Raw bytes (uploads). */
  async raw(pathAndQuery: string, bytes: Uint8Array): Promise<{ status: number; data: any }> {
    if (!this.online) throw new Error(`${this.conf.label} is offline: ${this.error ?? "not connected"}`);
    const res = await fetch(`${this.base}${pathAndQuery}`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" }, body: bytes, signal: AbortSignal.timeout(120_000) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  async get(pathAndQuery: string): Promise<Response> {
    return fetch(`${this.base}${pathAndQuery}`, { headers: { authorization: `Bearer ${this.token}` } });
  }
}

/** Splits "<machine>|<node key>"; keys without a known machine prefix are local. */
export function splitKey(key: string | undefined, remotes: Map<string, RemoteHost>): { remote?: RemoteHost; key: string } {
  const k = String(key ?? "");
  const i = k.indexOf("|");
  if (i > 0) {
    const remote = remotes.get(k.slice(0, i));
    if (remote) return { remote, key: k.slice(i + 1) };
  }
  return { key: k };
}
