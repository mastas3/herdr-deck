// Put a session's dev server on your tailnet (`tailscale serve`, never Funnel: only your devices can open it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { connect } from "node:net";

const BIN = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => existsSync(p));
export const canShare = () => !!BIN;

async function ts(args: string[], timeout = 8000) {
  if (!BIN) throw new Error("Tailscale isn’t installed on this machine");
  // Own process group: on macOS /usr/local/bin/tailscale is a shell wrapper, and killing only the shell on a timeout
  // would leave a hung CLI running for good.
  const p = Bun.spawn([BIN, ...args], { stdout: "pipe", stderr: "pipe", detached: true } as any);
  const t = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill(9); } }, timeout);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(t);
  if (p.exitCode !== 0) throw new Error((err || out).trim().split("\n").slice(-2).join(" ") || `tailscale ${args[0]} failed`);
  return out;
}

let dns: { at: number; name?: string } = { at: 0 };
async function dnsName() {
  if (Date.now() - dns.at < 10 * 60_000 && dns.name) return dns.name;
  const st = JSON.parse(await ts(["status", "--json"]));
  dns = { at: Date.now(), name: String(st.Self?.DNSName ?? "").replace(/\.$/, "") };
  return dns.name;
}

/** Whether something accepts connections on host:port. */
export function listening(port: number, host = "127.0.0.1", ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

type Owned = { port: number; host: string };
/**
 * The addresses the deck made itself (https port → local port), kept in a file so they outlive a restart. Only these
 * are ever removed without asking: one whose server has been gone for `graceMs` is turned off. Addresses made by hand
 * or by an agent are never touched.
 */
export function createShareOwner(o: { file: string; graceMs?: number; isUp?: (port: number, host: string) => Promise<boolean>; off?: (https: number) => Promise<unknown>; now?: () => number }) {
  const grace = o.graceMs ?? 30 * 60_000, isUp = o.isUp ?? listening, now = o.now ?? Date.now;
  const off = o.off ?? ((https: number) => ts(["serve", `--https=${https}`, "off"]));
  let owned: Record<string, Owned> | undefined;
  const deadSince = new Map<number, number>(); // in memory only: a restart starts the clock again
  const load = () => (owned ??= (() => { try { return JSON.parse(readFileSync(o.file, "utf8")); } catch { return {}; } })());
  const save = () => { try { mkdirSync(dirname(o.file), { recursive: true }); writeFileSync(o.file, JSON.stringify(owned, null, 2)); } catch {} };
  const drop = (https: number) => { if (load()[https]) { delete owned![https]; deadSince.delete(https); save(); } };
  return {
    add(https: number, port: number, host: string) { load()[https] = { port, host }; save(); },
    drop,
    list: () => ({ ...load() }),
    /** Given what's served now (local port → URL), turns off the deck's own addresses whose server is gone. True if it removed one. */
    async prune(served: Map<number, string>) {
      let removed = false;
      for (const [key, e] of Object.entries(load())) {
        const https = Number(key);
        const url = served.get(e.port);
        if (!url || Number(url.match(/:(\d+)$/)?.[1] ?? 443) !== https) { drop(https); continue; } // turned off or changed elsewhere
        if (await isUp(e.port, e.host)) { deadSince.delete(https); continue; }
        const since = deadSince.get(https) ?? now();
        deadSince.set(https, since);
        if (now() - since < grace) continue;
        try { await off(https); drop(https); removed = true; } catch {}
      }
      return removed;
    },
  };
}

const owner = createShareOwner({ file: `${homedir()}/.config/herdr-deck/shares.json` });
export const pruneShares = (served: Map<number, string>) => owner.prune(served);

/** local port → https URL, for everything currently served. */
export async function servedPorts(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!BIN) return out;
  let st: any;
  try { st = JSON.parse((await ts(["serve", "status", "--json"])) || "{}"); } catch { return out; }
  for (const [hostPort, web] of Object.entries<any>(st.Web ?? {})) {
    for (const h of Object.values<any>(web?.Handlers ?? {})) {
      const m = String(h?.Proxy ?? "").match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/);
      if (m) out.set(Number(m[1]), `https://${hostPort.replace(/:443$/, "")}`);
    }
  }
  return out;
}

/** Serves http://<addr>:<port> at https://<machine>.ts.net:<port> (or a free nearby port). */
export async function share(port: number, addr = "127.0.0.1") {
  const served = await servedPorts();
  if (served.has(port)) return served.get(port)!;
  const v6 = addr.includes("::1") || addr === "[::1]";
  const target = v6 ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
  let st: any = {};
  try { st = JSON.parse((await ts(["serve", "status", "--json"])) || "{}"); } catch {}
  const taken = new Set(Object.keys(st.TCP ?? {}).map(Number));
  let https = port;
  while (taken.has(https) || https === 443) https = https + 10000 > 65000 ? 8500 + Math.floor(Math.random() * 400) : https + 10000;
  await ts(["serve", "--bg", `--https=${https}`, target], 15_000);
  owner.add(https, port, v6 ? "::1" : "127.0.0.1");
  return `https://${await dnsName()}:${https}`;
}

export async function unshare(port: number) {
  const served = await servedPorts();
  const url = served.get(port);
  if (!url) return;
  const https = Number(url.match(/:(\d+)$/)?.[1] ?? 443);
  await ts(["serve", `--https=${https}`, "off"]);
  owner.drop(https);
}
