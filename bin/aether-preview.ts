#!/usr/bin/env bun
// An optional, temporary, loopback-only preview. It never starts a deck, creates credentials or forwards writes.
import { readFileSync } from "node:fs";
import { createAssets } from "../src/assets";
import { activate } from "../plugins-builtin/aether/server";

const publicDir = new URL("../public", import.meta.url).pathname;
const pluginDir = new URL("../plugins-builtin/aether", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${pluginDir}/plugin.json`, "utf8"));
const sameTarget = (r: any, t: any) => !!r && !!t && ["key", "sessionId", "machine", "agent", "cwd", "project"].every((k) => r[k] === t[k]);
const identity = (r: any) => Object.fromEntries(["key", "sessionId", "machine", "agent", "cwd", "project"].map((k) => [k, r[k]]));
const json = (body: any, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
export const fixtureRow = { key: "fixture:companion", sessionId: "fixture-aether-session", machine: "preview", agent: "claude", title: "Bring the garden to life", project: "herdr-deck", cwd: "/tmp/aether-fixture", status: "working", lastActiveAt: Date.now(), tail: [], seen: true };
export const fixtureChat = { gen: 1, total: 3, messages: [
  { i: 0, role: "user", text: "Build one island that follows a real agent session.", at: Date.now() - 90_000 },
  { i: 1, role: "assistant", text: "The island is connected. I’m checking the reply path and the way the garden changes when work finishes.", at: Date.now() - 60_000 },
  { i: 2, role: "assistant", text: "The first companion has a home. Your session stays clearly identified, and its conversation is a single tap away.", at: Date.now() - 20_000 },
] };

export function createAetherPreview({ port = 4768, sessionKey, upstream = fetch, fixture = false }: { port?: number; sessionKey?: string; upstream?: typeof fetch; fixture?: boolean }) {
  const origin = "http://127.0.0.1:4747";
  const assets = createAssets(publicDir, { dev: true, plugins: () => [{ id: "aether", dir: pluginDir, scripts: manifest.client, styles: manifest.styles }] });
  let target: any = null, token = "", art: any;
  activate({ dir: pluginDir, routes: (_: string, fn: any) => { art = fn; } } as any);
  async function state() {
    const response = fixture ? null : await upstream(`${origin}/api/state`, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (response && !response.ok) throw new Error("The running deck is unavailable.");
    const data = fixture ? { token: "fixture-only", self: "preview", rows: [fixtureRow], summary: { machines: [{ id: "preview", label: "Fixture only", online: true, local: true }] } } : await response!.json();
    const row = data.rows.find((r: any) => r.key === (fixture ? fixtureRow.key : sessionKey));
    if (!target && row?.sessionId) target = identity(row);
    const rows = sameTarget(row, target) ? [row] : [];
    token = data.token;
    return { token, self: data.self, rows, summary: { herdr: [], machines: (data.summary?.machines ?? []).filter((m: any) => m.id === target?.machine) },
      graveyard: [], tools: [], queue: {}, toolGroups: {}, usage: {}, history: {}, decisions: [], radar: [], jev: {}, canShare: false, publicUrl: "", plugins: { active: ["aether"] },
      aetherPreview: { origin, target, fixture } };
  }
  return async (req: Request) => {
    const host = req.headers.get("host") ?? new URL(req.url).host;
    if (!["127.0.0.1:" + port, "localhost:" + port].includes(host)) return json({ error: "forbidden host" }, 403);
    const u = new URL(req.url);
    if (req.headers.get("origin") && !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(req.headers.get("origin")!)) return json({ error: "forbidden origin" }, 403);
    try {
      if (req.method === "GET") {
        if (u.pathname === "/health") return json({ ok: true, mode: fixture ? "aether-fixture-preview" : "aether-read-only-preview" });
        if (u.pathname === "/" || u.pathname === "/api/state") {
          const data = await state();
          if (u.pathname === "/api/state") return json(data);
          let html = readFileSync(`${publicDir}/index.html`, "utf8").replace("/*__BOOT__*/", `window.__BOOT__=${JSON.stringify(data).replace(/</g, "\\u003c")};`);
          html = assets.inject(html).replace("<title>herdr deck</title>", "<title>Aether · local preview</title>");
          return new Response(html, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
        }
        if (u.pathname === "/events") {
          let timer: ReturnType<typeof setTimeout>, stopped = false;
          const encoder = new TextEncoder();
          const stream = new ReadableStream({ start(controller) {
            const tick = async () => {
              try { const data = await state(); if (!stopped) controller.enqueue(encoder.encode(`event: full\ndata: ${JSON.stringify(data)}\n\n`)); }
              catch { if (!stopped) { stopped = true; controller.error(new Error("Deck disconnected")); } }
              if (!stopped) timer = setTimeout(tick, 5000);
            };
            void tick();
          }, cancel() { stopped = true; clearTimeout(timer); } });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
        }
        if (u.pathname.startsWith("/aether-art/")) return await art({ url: u });
        const asset = assets.serve(req, u); if (asset) return asset;
        if (/^\/fonts\/[\w-]+\.woff2$/.test(u.pathname) || /^\/icon[\w-]*\.(png|svg)$/.test(u.pathname) || u.pathname === "/manifest.webmanifest") return new Response(Bun.file(publicDir + u.pathname));
        return new Response("Not found", { status: 404 });
      }
      // No live mutation endpoint can pass this allowlist, even with the existing action token.
      if (req.method !== "POST" || u.pathname !== "/api/chat") return json({ error: "Read-only preview. Open the named session in the live deck to reply." }, 403);
      if (!token || req.headers.get("x-deck-token") !== token) return json({ error: "forbidden" }, 403);
      if (Number(req.headers.get("content-length") || 0) > 2048) return json({ error: "Request too large" }, 413);
      const raw = await req.text(); if (raw.length > 2048) return json({ error: "Request too large" }, 413);
      const body = JSON.parse(raw);
      const current = await state();
      if (!current.rows.length || body.key !== target?.key || body.sub) return json({ error: "The selected session is unavailable or changed." }, 409);
      if (fixture) return json(fixtureChat);
      const reply = await upstream(`${origin}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-deck-token": token }, body: JSON.stringify({ key: target.key, limit: 40 }), signal: AbortSignal.timeout(8000), redirect: "error" });
      return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch { return json({ error: "Could not reach the running deck. Reconnect and retry." }, 503); }
  };
}

if (import.meta.main) {
  const sessionKey = process.argv.find((a) => a.startsWith("--session="))?.slice(10);
  const fixture = process.argv.includes("--fixture"), port = Number(process.env.DECK_PREVIEW_PORT || 4768);
  if (!fixture && !sessionKey) throw new Error("Pass --session=<exact live row key> or --fixture. A session is never chosen automatically.");
  Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: createAetherPreview({ port, sessionKey, fixture }) });
  console.log(`Aether ${fixture ? "fixture" : "read-only live"} preview: http://127.0.0.1:${port}/?view=aether`);
}
