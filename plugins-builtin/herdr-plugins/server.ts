// herdr plugins: manage herdr's own workflow plugins (herdr.dev/docs/plugins) from the deck. Each deck manages its own
// machine's herdr through the CLI (local.ts); the hub asks every machine's deck and shows them side by side, so it runs
// on every machine. Browsing reads the public marketplace index (market.ts) only when you open Browse: no timers.
// herdr doesn't review or sandbox plugins, so an install only happens after the red trust screen in the page, pinned
// to the exact commit it showed.
import type { Host } from "../../src/plugin-api";
import type { RemoteHost } from "../../src/federation";
import { createCli } from "./cli";
import { createLocal, type Undo } from "./local";
import { createMarket } from "./market";
import { compatFor, type MachineInfo } from "./compat";

type Remotes = { get(id: string): RemoteHost | undefined; all(): RemoteHost[] };
const LOCAL_OPS = new Set(["status", "enable", "remove", "restore", "config-dir", "logs", "invoke", "install", "job"]);

export function activate(host: Host) {
  const cli = createCli((n) => host.env(n));
  const local = createLocal(cli, () => host.rows());
  const market = createMarket();
  host.onStop(local.stop);
  const self = () => host.machines().find((m) => m.local && m.kind !== "app");
  const remotes = () => host.use<Remotes>("remotes");

  /** Another machine's deck answers for its own herdr. A 404 means this part is off over there. */
  async function remote(id: string, body: any) {
    const r = remotes()?.get(id);
    if (!r) throw new Error("Unknown machine");
    const res = await r.post("/api/herdr-plugins", body);
    if (res.status === 404) throw new Error(`Turn on “herdr plugins” in Plugins → Built in on ${r.conf.label}’s deck to manage it from here.`);
    if (res.status >= 400) throw new Error(res.data?.error ?? `${r.conf.label} said ${res.status}`);
    return res.data;
  }

  async function localOp(b: any) {
    switch (b.op) {
      case "status": return local.status();
      case "enable": await local.setEnabled(b.id, !!b.on); return { ok: true };
      case "remove": return { undo: await local.remove(b.id) };
      case "restore": await local.restore(b.undo as Undo); return { ok: true };
      case "config-dir": return { path: await local.configDir(b.id) };
      case "logs": return { logs: await local.logs(b.id, Number(b.limit) || 20) };
      case "invoke": return local.invoke(b.pluginId, b.actionId, b.key || undefined);
      case "install": return local.install(String(b.spec ?? ""), String(b.ref ?? ""));
      case "job": return local.job(b.id) ?? Response.json({ error: "No such install" }, { status: 404 });
    }
  }

  /** Every machine's herdr and its plugins: this one, then each remote deck (offline or off ones say why). */
  async function machines() {
    const me = self();
    const mine = { id: me?.id ?? "local", label: me?.label ?? "This machine", local: true, ...(await local.status()) };
    const others = await Promise.all((remotes()?.all() ?? []).map(async (r) => {
      const base = { id: r.conf.id, label: r.conf.label, local: false, platform: undefined, plugins: [] };
      try { return { ...base, ...(await remote(r.conf.id, { op: "status" })) }; } catch (e: any) { return { ...base, error: e.message }; }
    }));
    return { self: mine.id, machines: [mine, ...others] };
  }

  host.routes("herdr-plugins", async ({ body }) => {
    const b = body ?? {};
    if (LOCAL_OPS.has(b.op)) {
      const me = self()?.id;
      if (b.machine && b.machine !== me) {
        // A session key from the hub is "<machine>|<key on that machine>".
        const key = typeof b.key === "string" && b.key.startsWith(`${b.machine}|`) ? b.key.slice(b.machine.length + 1) : b.key;
        return remote(b.machine, { ...b, machine: undefined, key });
      }
      return localOp(b);
    }
    // Whether each plugin fits each machine the page knows (its herdr version and OS), said once, here.
    const ms: MachineInfo[] = Array.isArray(b.machines) ? b.machines.filter((m: any) => typeof m?.id === "string") : [];
    const withFit = <R extends { manifests: any[] }>(r: R) => ({ ...r, manifests: r.manifests.map((m) => ({ ...m, fit: Object.fromEntries(ms.map((x) => [x.id, compatFor(m, x)])) })) });
    switch (b.op) {
      case "machines": return machines();
      case "browse": { const r = await market.search(b.q, b.sort, Number(b.limit) || 40); return { ...r, repos: r.repos.map(withFit) }; }
      case "recommended": return { repos: (await market.recommended(Array.isArray(b.skip) ? b.skip.map(String) : [])).map(withFit) };
      case "review": {
        // What the trust screen shows: the manifest at the commit an install will pin, and that commit.
        const sha = /^[0-9a-f]{40}$/.test(b.commit ?? "") ? b.commit : undefined;
        if (!sha) return Response.json({ error: "The marketplace has no commit for it yet; try again in a few minutes." }, { status: 400 });
        const [detail, commit] = await Promise.all([market.manifest(b.fullName, b.path, sha), market.commit(b.fullName, sha)]);
        return { detail, commit };
      }
    }
    return Response.json({ error: "Unknown op" }, { status: 400 });
  });
}
