// Put a session's dev server on your tailnet (`tailscale serve`, never Funnel: only your devices can open it).
import { existsSync } from "node:fs";

const BIN = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => existsSync(p));
export const canShare = () => !!BIN;

async function ts(args: string[], timeout = 8000) {
  if (!BIN) throw new Error("Tailscale isn’t installed on this machine");
  const p = Bun.spawn([BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(9), timeout);
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
  const target = addr.includes("::1") || addr === "[::1]" ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
  let st: any = {};
  try { st = JSON.parse((await ts(["serve", "status", "--json"])) || "{}"); } catch {}
  const taken = new Set(Object.keys(st.TCP ?? {}).map(Number));
  let https = port;
  while (taken.has(https) || https === 443) https = https + 10000 > 65000 ? 8500 + Math.floor(Math.random() * 400) : https + 10000;
  await ts(["serve", "--bg", `--https=${https}`, target], 15_000);
  return `https://${await dnsName()}:${https}`;
}

export async function unshare(port: number) {
  const served = await servedPorts();
  const url = served.get(port);
  if (!url) return;
  const https = Number(url.match(/:(\d+)$/)?.[1] ?? 443);
  await ts(["serve", `--https=${https}`, "off"]);
}
