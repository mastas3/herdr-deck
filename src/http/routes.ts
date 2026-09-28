// Every request, in order: the Host check, GETs a running plugin serves (e.g. /covers/*), the page and static files,
// the SSE stream, images and raw files, then /mcp, then POSTs carrying the action token: uploads (files, plugins),
// running plugins' /api/* routes, the feature modules' own /api/* routes, a session on another machine, and last the
// deck's API (api-hub.ts, api-connections.ts, api-sessions.ts).
import { splitKey } from "../federation";
import { choiceFromInput, recordOutcome } from "../decisions";
import { handleMcp } from "../mcp";
import { MAX_UPLOAD } from "../plugins";
import { gzipJson, json, send, staticFile } from "./page";
import { resolveSafe, saveUpload } from "./files";
import { hubApi } from "./api-hub";
import { connectionsApi } from "./api-connections";
import { sessionsApi } from "./api-sessions";
import type { Hub } from "./hub";

export function createRoutes(hub: Hub) {
  const { TOKEN, deck, hosts, push, sse, auth, mcp, decisions, opportunities, discover, gallery, library, leads, research, journeys, game, plugins, pluginHost, codePlugins } = hub;
  const { page, assets, fullState, forwardToMachine } = hub;
  const { imageFor } = hub.chat;
  const { remotes, localRow, isNode, machines } = hosts;
  const { hasApiToken, allowedHost } = auth;

  /** Discover's replies get painted covers from the covers plugin when it's on (a shim until Discover is a plugin
   *  that uses the service itself); with covers off the page draws each card's placeholder. */
  const withCovers = (d: unknown) => pluginHost.service<{ respond(d: unknown): Response }>("covers")?.respond(d) ?? json(d);

  async function handle(req: Request): Promise<Response> {
    // Host check blocks DNS-rebinding; the token blocks cross-site POSTs.
    if (!allowedHost(req)) return new Response("forbidden host", { status: 403 });
    const url = new URL(req.url);

    if (req.method === "GET") {
      { const r = await pluginHost.get(req, url); if (r) return r; }
      // "/" and every session link (/s/<machine>/<agent>/<session id>) serve the same page; the page resolves the link.
      // So do a running plugin's page links. /p (project pages) is core until the projects plugin declares it.
      if (url.pathname === "/" || url.pathname.startsWith("/s/") || url.pathname === "/p" || url.pathname.startsWith("/p/") || pluginHost.isPage(url.pathname)) return send(req, page(), "text/html; charset=utf-8");
      { const a = assets.serve(req, url); if (a) return a; }
      if (url.pathname === "/events") return sse.stream(fullState);
      { const f = await staticFile(url); if (f) return f; }
      if (url.pathname === "/api/image") {
        // <img> can't send headers, so the token rides in the query string.
        if (url.searchParams.get("t") !== TOKEN && !hasApiToken(req)) return new Response("forbidden", { status: 403 });
        const route = splitKey(url.searchParams.get("key") ?? "", remotes);
        if (route.remote) {
          const q = new URLSearchParams({ key: route.key, id: url.searchParams.get("id") ?? "", sub: url.searchParams.get("sub") ?? "" });
          const res = await route.remote.get(`/api/image?${q}`).catch(() => null);
          if (!res?.ok) return new Response("image not found", { status: 404 });
          return new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "image/png", "cache-control": "private, max-age=86400" } });
        }
        const lr = localRow(route.key);
        const img = lr && (await imageFor(lr, url.searchParams.get("id") ?? "", url.searchParams.get("sub") || undefined).catch(() => undefined));
        if (!img) return new Response("image not found", { status: 404 });
        return new Response(img.data, { headers: { "content-type": img.type, "cache-control": "private, max-age=86400" } });
      }
      if (url.pathname === "/api/file-raw") {
        if (url.searchParams.get("t") !== TOKEN && !hasApiToken(req)) return new Response("forbidden", { status: 403 });
        const route = splitKey(url.searchParams.get("key") ?? "", remotes);
        if (route.remote) {
          const res = await route.remote.get(`/api/file-raw?${new URLSearchParams({ key: route.key, path: url.searchParams.get("path") ?? "" })}`).catch(() => null);
          return res?.ok ? new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream", "cache-control": "private, max-age=300" } }) : new Response("not found", { status: 404 });
        }
        const p = resolveSafe(localRow(route.key)?.cwd, url.searchParams.get("path") ?? "");
        const f = p && Bun.file(p);
        if (!f || !(await f.exists())) return new Response("not found", { status: 404 });
        return new Response(f, { headers: { "cache-control": "private, max-age=300" } });
      }
      if (url.pathname === "/api/push/key") return json({ key: push.vapid.publicKey, node: isNode() });
      if (url.pathname === "/health") return json({ ok: true, clients: sse.clients.size, ...deck.health(), machines: machines().map(({ herdr, ...m }) => m) });
      return new Response("not found", { status: 404 });
    }

    if (url.pathname === "/mcp") {
      if (req.headers.get("authorization") !== `Bearer ${mcp.token}`) return new Response("unauthorized", { status: 401 });
      if (req.method === "GET") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const msg: any = await req.json().catch(() => null);
      if (!msg) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
      if (Array.isArray(msg)) { const out = (await Promise.all(msg.map((m) => handleMcp(m, mcp.ctx)))).filter(Boolean); return out.length ? json(out) : new Response(null, { status: 202 }); }
      const out = await handleMcp(msg, mcp.ctx);
      return out ? json(out) : new Response(null, { status: 202 });
    }
    if (req.method !== "POST" || (req.headers.get("x-deck-token") !== TOKEN && !hasApiToken(req))) return new Response("forbidden", { status: 403 });
    if (url.pathname === "/api/upload") {
      // Raw body; the file lands on the machine where the session runs, and the agent gets its path.
      const key = url.searchParams.get("key") ?? "";
      const name = url.searchParams.get("name") ?? "file";
      try {
        const route = splitKey(key, remotes);
        if (route.remote) {
          const r = await route.remote.raw(`/api/upload?${new URLSearchParams({ key: route.key, name })}`, new Uint8Array(await req.arrayBuffer()));
          return json(r.data, r.status);
        }
        return json(await saveUpload(req, name));
      } catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); }
    }
    if (url.pathname === "/api/plugins/upload") {
      // Raw body, like /api/upload: a plugin.json or a .zip, staged for the trust screen. Nothing is installed yet.
      if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD) return json({ error: "That file is over 5 MB." }, 413);
      try { return json(await plugins.stageUpload(url.searchParams.get("name") ?? "plugin.json", new Uint8Array(await req.arrayBuffer()))); }
      catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); }
    }
    const body: any = await req.json().catch(() => ({}));
    try {
      // An answer typed in the reply box or pressed in the terminal answers the decision on screen too:
      // record it for Jev before the input goes anywhere (the inbox's own /api/decide then finds it done).
      if ((url.pathname === "/api/send" || url.pathname === "/api/keys") && body.key) {
        const d = decisions.get(String(body.key));
        const choice = d && choiceFromInput(d, { text: body.text, keys: body.keys });
        if (d && choice) recordOutcome(d.key, choice === "other" ? "reply" : "answer", choice, d);
      }
      { const r = await pluginHost.api(req, url, body); if (r) return r; }
      if (url.pathname.startsWith("/api/opportunities")) { const d = await opportunities.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/discover")) { const d = await discover.handle(url.pathname, body); if (d !== undefined) return withCovers(d); }
      if (url.pathname.startsWith("/api/ideas")) { const d = await gallery.handle(url.pathname, body); if (d !== undefined) return withCovers(d); }
      if (url.pathname.startsWith("/api/library/")) { const d = await library.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/leads")) { const d = await leads.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/research")) { const d = await research.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/journey")) { const d = await journeys.handle(url.pathname, body); if (d !== undefined) return json(d); }
      { const g = await game.route(url.pathname, body); if (g) return json(g.data, g.status); }
      if (url.pathname.startsWith("/api/plugins/code")) { const d = await codePlugins.handle(url.pathname, body); if (d !== undefined) return json(d); }
      if (url.pathname.startsWith("/api/plugins")) { const d = await plugins.handle(url.pathname, body); if (d !== undefined) return json(d); }
      const forwarded = await forwardToMachine(url.pathname, body);
      if (forwarded) return forwarded;
      const res = (await hubApi(hub, url.pathname, body)) ?? (await connectionsApi(hub, url.pathname, body)) ?? (await sessionsApi(hub, url.pathname, body));
      if (res) return res;
    } catch (e: any) {
      return json({ error: e?.message ?? String(e), code: e?.code }, 500);
    }
    return new Response("not found", { status: 404 });
  }

  return {
    async fetch(req: Request) {
      return gzipJson(req, await handle(req));
    },
  };
}
