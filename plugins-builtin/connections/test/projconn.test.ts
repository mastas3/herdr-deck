import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Inventory, Item } from "../connections";
import { detectProjects, portsIn, projectItems, toolsIn, type McpRef } from "../projconn";
import { RECIPES, readiness } from "../recipes";

const ARG_SECRET = "FAKEMCPARGSECRET_42", URL_SECRET = "FAKEURLTOKEN_77";
let home = "";
const P = () => `${home}/Documents/Projects`;
const w = (rel: string, s: string) => { const p = `${home}/${rel}`; mkdirSync(p.split("/").slice(0, -1).join("/"), { recursive: true }); writeFileSync(p, s); };
beforeAll(() => {
  home = mkdtempSync(`${tmpdir()}/deck-projconn-`);
  // An MCP server + CLI (Python, FastMCP), registered in Claude Code with a secret in its args.
  w("Documents/Projects/fb-group-scraper/pyproject.toml", `[project]\nname = "fb-scraper"\ndescription = "Facebook group archiver"\n\n[project.scripts]\nfb-scraper = "fb_scraper.cli:main"\n\n[tool.x]\n`);
  w("Documents/Projects/fb-group-scraper/fb_scraper/mcp_server.py", `from mcp.server.fastmcp import FastMCP\nmcp = FastMCP("fb")\n\n@mcp.tool()\ndef search_posts(q: str): ...\n\n@mcp.tool()\nasync def top_authors(): ...\n`);
  w("wiki/projects/fb-group-scraper.md", "---\ntype: project\n---\n\nJob-based archiver for [[facebook]] groups with a **local** semantic index.\n\n- **Path:** `~/Documents/Projects/fb-group-scraper`\n");
  // A dashboard on a port the wiki names, a skill that drives it, and a CLI.
  w("Documents/Projects/yt-transcriber/pyproject.toml", `[project.scripts]\nyt-cli = "yt.cli:main"\n`);
  w("wiki/projects/yt-transcriber.md", "---\ntype: project\n---\n\nYouTube URL to clips, SRTs and knowledge; channels into a RAG.\n\n- **Path:** `~/Documents/Projects/yt-transcriber/`\n- Dashboard on port 8088; talks to Ollama at localhost:11434.\n");
  w(".claude/skills/yt-transcriber/SKILL.md", "---\nname: yt-transcriber\n---\nDrive the project at ~/Documents/Projects/yt-transcriber.\n");
  // A node MCP server that lives outside the projects folder, found through the wiki's Path line.
  w("Downloads/lib/esoteric-rag/mcp-server/index.js", `server.tool("esoteric_search", {}, async () => {});\nserver.registerTool('esoteric_sources', {});\n`);
  w("wiki/projects/esoteric-rag.md", "---\ntype: project\n---\n\nLocal RAG over an occult library, FastAPI on port 8666.\n\n- **Path:** `~/Downloads/lib/esoteric-rag/`\n");
  // A server run by launchd, reached by an HTTP MCP URL on its port; tools declared as { name, description } objects.
  w("Documents/Projects/deck/src/mcp.ts", `const TOOLS = [\n  { name: "deck_sessions", description: "…" },\n  { name: "deck.search",\n    description: "…" },\n];\n`);
  w("Documents/Projects/deck/package.json", JSON.stringify({ name: "deck", scripts: { start: "bun src/server.ts" } }));
  // Plain web apps: one running now (a process listens from its folder), one never running with a dev port only.
  w("Documents/Projects/webapp/package.json", JSON.stringify({ name: "webapp", scripts: { dev: "vite --port 5173" } }));
  w("Documents/Projects/idle-app/package.json", JSON.stringify({ name: "idle", scripts: { dev: "vite --port 5174" } }));
  w("Documents/Projects/tool/package.json", JSON.stringify({ name: "@me/tool", bin: { tooly: "./cli.js" }, description: "A CLI" }));
  w("Documents/Projects/helper/bin/_common.sh", "#!/bin/sh\n");
  // A folder of other people's MCP servers: not a project card.
  for (const n of ["a", "b", "c"]) w(`Documents/Projects/mcp-collection/${n}/index.js`, "");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const mcps = (): McpRef[] => [
  { name: "fb-group", where: "Claude Code", hints: ["uv", "--directory", `${P()}/fb-group-scraper`, "run", "fb-scraper", "mcp", "--token", ARG_SECRET] },
  { name: "esoteric-rag", where: "OpenCode", hints: ["node", `${home}/Downloads/lib/esoteric-rag/mcp-server/index.js`] },
  { name: "herdr-deck", where: "Claude Code", hints: [`http://127.0.0.1:4747/mcp?key=${URL_SECRET}`] },
  { name: "cloud-thing", where: "Claude Code", hints: ["npx", "-y", "@vendor/mcp"] },
  ...["a", "b", "c"].map((n) => ({ name: `coll-${n}`, where: "Cline", hints: ["node", `${P()}/mcp-collection/${n}/index.js`] })),
];
const run = (listening?: Map<number, string | undefined>) => detectProjects({
  home, roots: [P()], mcps: mcps(), wikiDir: `${home}/wiki`, listening,
  services: [{ label: "dev.deck", kind: "launchd", running: true, loaded: true, text: `<key>WorkingDirectory</key><string>${P()}/deck</string><key>DECK_PORT</key><string>4747</string>` }],
  skills: [{ name: "yt-transcriber", text: readFileSync(`${home}/.claude/skills/yt-transcriber/SKILL.md`, "utf8") }],
});

describe("your projects as connections", () => {
  test("ports and tool names are read from text", () => {
    expect(portsIn("dashboard on port 8088, api at localhost:3777, PORT=4100, --port 5599, ollama localhost:11434, junk :80")).toEqual([8088, 3777, 4100, 5599]);
    expect(toolsIn(`@mcp.tool()\ndef a(): ...\nserver.tool("b", {})\n{ name: "c_d", description: "x" }\nTool(name="e")`)).toEqual(["a", "b", "c_d", "e"]);
  });
  test("finds each kind of interface and leaves plain folders out", () => {
    const list = run(new Map([[4747, `${P()}/deck`], [5173, `${P()}/webapp`], [5432, undefined]]));
    const by = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(Object.keys(by).sort()).toEqual(["deck", "esoteric-rag", "fb-group-scraper", "tool", "webapp", "yt-transcriber"]);
    expect(by["fb-group-scraper"]).toMatchObject({ cli: ["fb-scraper"], tldr: "Job-based archiver for facebook groups with a local semantic index." });
    expect(by["fb-group-scraper"].mcp).toEqual([{ name: "fb-group", where: ["Claude Code"], tools: ["search_posts", "top_authors"] }]);
    expect(by["esoteric-rag"].mcp[0]).toMatchObject({ name: "esoteric-rag", tools: ["esoteric_search", "esoteric_sources"] });
    expect(by["esoteric-rag"]).toMatchObject({ ports: [8666], running: false });
    expect(by["yt-transcriber"]).toMatchObject({ skills: ["yt-transcriber"], cli: ["yt-cli"], ports: [8088], running: false }); // Ollama's 11434 isn't its port
    expect(by.deck.mcp).toEqual([{ name: "herdr-deck", where: ["Claude Code"], tools: ["deck_sessions", "deck.search"] }]);
    expect(by.deck).toMatchObject({ running: true, ports: [4747] });
    expect(by.webapp).toMatchObject({ running: true, ports: [5173] }); // a process listens from its folder
    expect(by.tool.cli).toEqual(["tooly"]);
  });
  test("with no listening info, nothing claims to be running or stopped", () => {
    const by = Object.fromEntries(run(undefined).map((p) => [p.name, p]));
    expect(by.webapp).toBeUndefined();
    expect(by["esoteric-rag"].running).toBeUndefined();
    expect(by.deck.running).toBe(true); // its launchd service says so
  });
  test("a port someone else listens on doesn't make a project look running", () => {
    const by = Object.fromEntries(run(new Map([[8088, `${home}/elsewhere`]])).map((p) => [p.name, p]));
    expect(by["yt-transcriber"].running).toBe(false);
  });
  test("cards: what it does, how agents use it, aliases for the MCP card it replaces; no config secrets", () => {
    const items = projectItems(run(new Map([[4747, `${P()}/deck`]])), home);
    const fb = items.find((i) => i.id === "proj:fb-group-scraper")!;
    expect(fb).toMatchObject({ kind: "project", cat: "projects", state: "ready", path: "~/Documents/Projects/fb-group-scraper", aliases: ["mcp:fb-group"], tools: ["search_posts", "top_authors"] });
    expect(fb.use).toContain('MCP server "fb-group" (Claude Code), tools: search_posts, top_authors');
    expect(fb.use).toContain("read ~/wiki/projects/fb-group-scraper.md first");
    const yt = items.find((i) => i.id === "proj:yt-transcriber")!;
    expect(yt.use).toContain("Load the yt-transcriber skill first");
    expect(yt.note).toBe("CLI · skill · not running (:8088)");
    const out = JSON.stringify(items);
    expect(out).not.toContain(ARG_SECRET);
    expect(out).not.toContain(URL_SECRET);
    expect(out).not.toContain("coll-a");
  });
  test("recipes accept a project card for the MCP or service it replaced", () => {
    const inv: Inventory = { machine: "t", at: 0, ms: 0, sections: [{ id: "projects", title: "", hint: "", items: [
      { id: "proj:fb-group-scraper", name: "fb-group-scraper", kind: "project", state: "ready", status: "ready", aliases: ["mcp:fb-group", "svc:facebook-group-archive"] } as Item,
      { id: "skill:last30days", name: "last30days", kind: "skill", status: "ready" } as Item,
    ] }] };
    const rd = readiness(RECIPES.find((r) => r.id === "community-pulse")!, inv);
    expect(rd.state).toBe("ready");
    expect(rd.needs[0].id).toBe("proj:fb-group-scraper");
  });
});

describe("the whole scan: project cards replace their MCP cards; args never leak", () => {
  test("fake HOME", async () => {
    w(".claude.json", JSON.stringify({ mcpServers: { "fb-group": { command: "uv", args: ["--directory", `${P()}/fb-group-scraper`, "run", "fb-scraper", "mcp", "--token", ARG_SECRET] } } }));
    w("Documents/Projects/astra/.mcp.json", JSON.stringify({ mcpServers: { "esoteric-rag": { command: "node", args: [`${home}/Downloads/lib/esoteric-rag/mcp-server/index.js`, `--key=${ARG_SECRET}`] }, remote: { url: `https://mcp.example.com/x/${URL_SECRET}` } } }));
    const p = Bun.spawn([process.execPath, new URL("../connections.ts", import.meta.url).pathname, "--scan"], { env: { ...process.env, HOME: home, DECK_NO_LOGINS: "1" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const inv = JSON.parse(out) as Inventory;
    const md = readFileSync(`${home}/.config/herdr-deck/CONNECTIONS.md`, "utf8");
    for (const s of [ARG_SECRET, URL_SECRET]) { expect(out).not.toContain(s); expect(md).not.toContain(s); }
    const projects = inv.sections.find((s) => s.id === "projects")!.items;
    expect(projects.map((i) => i.id)).toEqual(expect.arrayContaining(["proj:fb-group-scraper", "proj:esoteric-rag", "proj:yt-transcriber", "proj:tool"]));
    const mcpIds = inv.sections.find((s) => s.id === "mcp")!.items.map((i) => i.id);
    expect(mcpIds).not.toContain("mcp:fb-group"); // folded into the project card
    expect(mcpIds).not.toContain("mcp:esoteric-rag");
    expect(mcpIds).toContain("mcp:remote"); // a project-scoped .mcp.json server that isn't a project of yours
    const services = inv.sections.find((s) => s.id === "services")!.items.map((i) => i.id);
    expect(services).not.toContain("svc:facebook-group-archive");
    expect(services).not.toContain("svc:youtube-rag-yt-transcriber");
    expect(projects.find((i) => i.id === "proj:fb-group-scraper")!.aliases).toEqual(expect.arrayContaining(["mcp:fb-group", "svc:facebook-group-archive"]));
    expect(md).toContain("## Your projects");
    expect(md).toContain("**fb-group-scraper**");
    expect(md).toContain("tools: search_posts, top_authors");
  }, 60_000);
});
