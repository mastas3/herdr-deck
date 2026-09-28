// The hub's half of federation in the API: a request about a session on another machine is proxied to its deck.
import { splitKey, type RemoteHost } from "../federation";
import { cachedBrief, writeBrief } from "../brief";
import type { Row } from "../deck";
import type { Detail } from "../transcript";
import { json } from "./page";

type Deps = {
  remotes: Map<string, RemoteHost>; selfId: string; briefKey: (row: Row) => string;
  closeLocal: (keys: string[], wholeTab: boolean) => Promise<any[]>;
};

export function createForward(deps: Deps) {
  const { remotes, briefKey, closeLocal } = deps;
  /**
   * Actions on another machine's sessions go to that machine's deck. Briefs are the exception:
   * the hub writes them with its own local model from the node's conversation detail.
   */
  return async function forwardToMachine(path: string, body: any): Promise<Response | undefined> {
    if (path.startsWith("/api/push/") || path === "/api/automations" || path.startsWith("/api/dev/")) return;
    if (path === "/api/queue" || path === "/api/machines" || path === "/api/decide" || path === "/api/tool" || path === "/api/history" || path === "/api/connections" || path === "/api/suggest-projects" || path === "/api/mcp-info") return;
    const proxy = async (remote: RemoteHost, payload: unknown) => {
      const r = await remote.post(path, payload);
      return json(r.data, r.status);
    };
    if (path === "/api/close" && Array.isArray(body.keys)) {
      const groups = new Map<RemoteHost | undefined, string[]>();
      for (const k of body.keys) { const r = splitKey(k, remotes); groups.set(r.remote, [...(groups.get(r.remote) ?? []), r.key]); }
      if (![...groups.keys()].some(Boolean)) return;
      const results: any[] = [];
      for (const [remote, keys] of groups) {
        if (!remote) { results.push(...(await closeLocal(keys, !!body.wholeTab))); continue; }
        try {
          const r = await remote.post(path, { ...body, keys });
          results.push(...(r.data.results ?? []).map((x: any) => ({ ...x, key: `${remote.conf.id}|${x.key}`, graves: x.graves?.map((g: string) => `${remote.conf.id}|${g}`) })));
        } catch (e: any) { results.push(...keys.map((k) => ({ key: `${remote.conf.id}|${k}`, ok: false, error: e?.message }))); }
      }
      return json({ results });
    }
    if (path === "/api/new" || path === "/api/new-options") {
      const remote = body.machine && body.machine !== deps.selfId ? remotes.get(body.machine) : undefined;
      if (!remote) return;
      const r = await remote.post(path, { ...body, machine: undefined });
      if (path === "/api/new" && r.data?.key) r.data.key = `${remote.conf.id}|${r.data.key}`;
      return json(r.data, r.status);
    }
    if (path === "/api/reopen" || path === "/api/forget") {
      const r = splitKey(body.id, remotes);
      return r.remote ? proxy(r.remote, { ...body, id: r.key }) : undefined;
    }
    if (!body.key) return;
    const route = splitKey(body.key, remotes);
    if (!route.remote) return;
    if (path === "/api/brief") {
      const row = route.remote.rows.get(body.key);
      const d = (await route.remote.post("/api/detail", { key: route.key })).data;
      if (!row || !d?.turns?.length) return json({ error: "This pane has no conversation to summarise" }, 400);
      const detail: Detail = { gen: 0, messages: [], touch: new Map(), started: d.started, recap: d.recap, turns: d.turns, images: [], compactions: d.compactions ?? 0, asks: d.asks ?? d.turns.length, startedAt: d.startedAt };
      return json({ brief: await writeBrief(briefKey(row), row.title, row.project, detail) });
    }
    if (path === "/api/detail") {
      const row = route.remote.rows.get(body.key);
      const r = await route.remote.post(path, { key: route.key });
      const brief = row?.sessionId ? cachedBrief(briefKey(row)) : undefined;
      return json({ ...r.data, brief, briefStale: !!brief && brief.asks !== r.data?.asks }, r.status);
    }
    return proxy(route.remote, { ...body, key: route.key });
  };
}
