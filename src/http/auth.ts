// Who may talk to the deck: this machine (the Host header), the machine owner over Tailscale, and a hub holding
// the node token. The action token (x-deck-token) is checked per route in src/http/routes.ts.
import { existsSync } from "node:fs";

/** Looks up the machine owner's Tailscale login once, so call it where startup wants that to happen. */
export function createAuth(o: { port: number; host: string; apiToken: string; hubSeen: () => void }) {
  const { port: PORT, host: HOST, apiToken: API_TOKEN } = o;
  // Remote access goes through `tailscale serve`, which proxies tailnet HTTPS to this loopback port and
  // stamps each request with the caller's Tailscale login. Only the machine owner's login (or DECK_TS_USERS) is let in.
  const tsUsers = new Set((process.env.DECK_TS_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  if (!tsUsers.size) {
    try {
      const bin = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => existsSync(p));
      if (bin) {
        const st = JSON.parse(Bun.spawnSync([bin, "status", "--json"], { stderr: "ignore" }).stdout.toString());
        const login = st.User?.[String(st.Self?.UserID)]?.LoginName;
        if (login) tsUsers.add(login);
      }
    } catch {}
  }

  const hasApiToken = (req: Request) => req.headers.get("authorization") === `Bearer ${API_TOKEN}`;

  function allowedHost(req: Request) {
    if (hasApiToken(req)) { o.hubSeen(); return true; }
    const host = req.headers.get("host") ?? "";
    if (host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`) return true;
    // A cross-site page can't add this header without a CORS preflight, which is never answered.
    const tsLogin = req.headers.get("tailscale-user-login");
    if (tsLogin && tsUsers.has(tsLogin)) return true;
    return HOST !== "127.0.0.1" && !!process.env.DECK_ALLOW_ANY_HOST;
  }
  return { hasApiToken, allowedHost };
}
