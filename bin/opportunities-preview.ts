#!/usr/bin/env bun
// Isolated Opportunities preview. It never loads the live deck or controls agent sessions.
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createOpportunityService } from "../src/opportunity-service";
import { runOpportunityWeb } from "../src/opportunity-web";
import { createLeads } from "../src/leads";

const port = Number(process.env.DECK_PREVIEW_PORT || 4759);
const dir = process.env.DECK_PREVIEW_DIR || `/tmp/herdr-opportunities-preview-${process.getuid?.() ?? "user"}`;
const publicDir = new URL("../public/", import.meta.url).pathname;
const token = crypto.randomUUID();
const tsUser = process.env.DECK_PREVIEW_TS_USER || "";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const leads = createLeads(dir);
const opportunities = createOpportunityService({ dir,
  archive: async () => [],
  research: (query, kind, force) => leads.search(query, kind, force),
  researchStatus: (id) => leads.handle("/api/leads/status", { id }),
  deepResearch: runOpportunityWeb,
});
const boot = () => ({ token, self: "preview", rows: [], summary: { herdr: [], machines: [{ id: "preview", label: "Isolated preview", local: true, online: true }] }, graveyard: [], tools: [], queue: {}, toolGroups: {}, usage: {}, history: {}, decisions: [], radar: [], jev: {}, canShare: false, publicUrl: "" });
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, async fetch(req) {
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && !(tsUser && req.headers.get("tailscale-user-login") === tsUser)) return json({ error: "forbidden host" }, 403);
  const url = new URL(req.url);
  if (url.pathname === "/health") return json({ ok: true, mode: "isolated-opportunities-preview" });
  if (url.pathname === "/") {
    const html = readFileSync(`${publicDir}/index.html`, "utf8").replace("/*__BOOT__*/", `window.__BOOT__=${JSON.stringify(boot()).replace(/</g, "\\u003c")};`).replace("<title>", "<title>Isolated preview · ");
    return new Response(html, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
  }
  if (url.pathname === "/events") {
    let timer: ReturnType<typeof setInterval>;
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(enc.encode(`event: full\ndata: ${JSON.stringify(boot())}\n\n`)); timer = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15000); }, cancel() { clearInterval(timer); } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
  if (url.pathname === "/app.js" || /^\/fonts\/[\w-]+\.woff2$/.test(url.pathname) || /^\/icon[^/]*\.(png|svg)$/.test(url.pathname)) {
    const file = Bun.file(resolve(publicDir, `.${url.pathname}`));
    return await file.exists() ? new Response(file, { headers: { "cache-control": "no-store" } }) : new Response("Not found", { status: 404 });
  }
  if (req.method !== "POST" || req.headers.get("x-deck-token") !== token) return json({ error: "forbidden" }, 403);
  try {
    const raw = await req.text(); if (raw.length > 1_000_000) return json({ error: "Request too large" }, 413);
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === "/api/push/presence") return json({ ok: true });
    const result = await opportunities.handle(url.pathname, body);
    return result === undefined ? json({ error: "This isolated preview only serves Opportunities; live deck actions are unavailable." }, 404) : json(result);
  } catch (e: any) { return json({ error: e.message ?? "Request failed" }, 400); }
} });
console.log(`Opportunities preview: http://127.0.0.1:${server.port}/?view=opportunities`);
console.log(`Separate preview data: ${dir}`);
