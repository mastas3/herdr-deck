// Your projects as connections: the ones that expose something agents can use — an MCP server registered in an
// agent app, a CLI (package.json "bin", pyproject scripts, bin/*.sh), an HTTP server or dashboard port, a
// launchd/systemd service, or a skill that drives it. One card per project, with what it does (the wiki's TLDR),
// how agents use it (MCP tool names, CLI names, URL, skill), and whether it's running now.
// MCP config paths and URLs are used only to match a server to its project; they're never stored (args can
// hold tokens). "Running" comes from the list of listening ports (lsof/ss); nothing here connects to a port.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Item } from "./connections";

export type McpRef = { name: string; where: string; hints: string[] };
export type ServiceRef = { label: string; kind: "launchd" | "systemd"; running?: boolean; loaded?: boolean; text: string };
export type SkillRef = { name: string; text: string };
/** `listening`: port → the working directory of the process listening on it (undefined when unknown). */
export type ProjInput = { home: string; roots: string[]; mcps: McpRef[]; services: ServiceRef[]; skills: SkillRef[]; listening?: Map<number, string | undefined>; wikiDir?: string };
export type ProjMcp = { name: string; where: string[]; tools: string[] };
export type ProjConn = {
  root: string; name: string; wiki?: string; tldr?: string;
  mcp: ProjMcp[]; cli: string[]; ports: number[]; services: ServiceRef[]; skills: string[];
  running?: boolean; // undefined when there's nothing to run or the port list is unknown
};

const SKIP_DIR = /^(\.|node_modules$|venv$|\.venv$|__pycache__$|dist$|build$|target$|coverage$|logs?$|output$|data$|tmp$)/;
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const text = (p: string, max = 256 * 1024) => { try { const s = statSync(p); if (!s.isFile() || s.size > max) return ""; return readFileSync(p, "utf8"); } catch { return ""; } };
const json = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const norm = (p: string) => p.replace(/\/+$/, "");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Ports that belong to other tools a project talks to (Ollama, Postgres, Redis, MySQL, MongoDB, LM Studio), not to the project. */
const OTHERS = new Set([11434, 5432, 5433, 6379, 3306, 27017, 1234]);
/** Ports a text says a server listens on: "port 8088", "localhost:3777", "on :4747", PORT=…, --port … */
export function portsIn(t: string): number[] {
  const out = new Set<number>();
  const re = /\bport\s+(\d{4,5})\b|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})\b|\bon :(\d{4,5})\b|\bPORT\s*=\s*["']?(\d{4,5})\b|--port[= ](\d{4,5})\b|<key>[A-Z_]*PORT<\/key>\s*<string>(\d{4,5})<\/string>/gi;
  for (const m of t.matchAll(re)) { const n = Number(m.slice(1).find(Boolean)); if (n > 1024 && n < 49152 && !OTHERS.has(n)) out.add(n); }
  return [...out];
}
/** MCP tool names declared in a server's source: FastMCP decorators, server.tool("x"), registerTool, or { name: "x", description …}. */
export function toolsIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/@\w+\.tool\([^)]*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g)) out.add(m[1]);
  for (const m of src.matchAll(/\.(?:tool|registerTool)\(\s*["'`]([\w.-]+)["'`]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bname\s*[:=]\s*["']([a-z][\w-]{2,40})["']\s*,\s*\n?\s*(?:title\s*[:=][^,\n]*,\s*\n?\s*)?description\s*[:=]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bname\s*:\s*["']([a-z][\w-]*\.[\w.-]{2,40})["']\s*,\s*\n?\s*description\s*:/g)) out.add(m[1]); // dotted names: hd.search
  for (const m of src.matchAll(/Tool\(\s*name\s*=\s*["']([\w-]+)["']/g)) out.add(m[1]);
  return [...out].slice(0, 16);
}
/** Source files that likely define an MCP server: under the path itself, or files/folders named *mcp* in the project. */
function mcpSources(root: string, paths: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number, onlyMcp: boolean) => {
    for (const n of ls(dir)) {
      if (files.length >= 25 || SKIP_DIR.test(n)) continue;
      const p = `${dir}/${n}`;
      if (isDir(p)) { if (depth > 0) walk(p, depth - 1, onlyMcp && !/mcp/i.test(n)); }
      else if (/\.(py|ts|js|mjs)$/.test(n) && (!onlyMcp || /mcp/i.test(n) || /mcp/i.test(dir.slice(root.length)))) files.push(p);
    }
  };
  for (const p of paths) { if (isDir(p)) walk(p, 2, false); else if (/\.(py|ts|js|mjs)$/.test(p) && existsSync(p)) files.push(p); }
  if (!files.length) walk(root, 3, true);
  return files;
}

/** The wiki's project pages: slug → the paths they name (`**Path:** \`~/…\``), the TLDR and the page text. */
export function wikiProjects(wikiDir: string, home: string): Map<string, { paths: string[]; tldr: string; text: string }> {
  const out = new Map<string, { paths: string[]; tldr: string; text: string }>();
  for (const f of ls(`${wikiDir}/projects`)) {
    if (!f.endsWith(".md") || f === "CLAUDE.md") continue;
    const t = text(`${wikiDir}/projects/${f}`, 512 * 1024);
    if (!t) continue;
    const body = t.replace(/^---[\s\S]*?\n---\s*\n/, "");
    const first = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("-") && !l.startsWith(">")) ?? "";
    const tldr = first.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\*\*|`|__/g, "").replace(/\s+/g, " ").trim();
    const paths = [...t.matchAll(/\*\*(?:Local )?Path:?\*\*:?\s*`([^`]+)`/gi)].map((m) => norm(m[1].trim().replace(/^~(?=\/)/, home)));
    out.set(f.replace(/\.md$/, ""), { paths, tldr, text: t });
  }
  return out;
}

/** Every project that exposes something agents can use, with its evidence. Pure over the file system and the inputs. */
export function detectProjects(inp: ProjInput): ProjConn[] {
  const { home } = inp;
  const tilde = (p: string) => (p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p);
  const wiki = inp.wikiDir ? wikiProjects(inp.wikiDir, home) : new Map();
  const bySlugPath = new Map<string, string>(); // root → wiki slug
  for (const [slug, w] of wiki) for (const p of w.paths) if (!bySlugPath.has(p)) bySlugPath.set(p, slug);
  // Candidate roots: every folder in the project roots, plus wiki project paths that live elsewhere.
  const roots = new Set<string>();
  for (const r of inp.roots) for (const d of ls(r)) if (!d.startsWith(".") && !SKIP_DIR.test(d) && isDir(`${r}/${d}`)) roots.add(`${r}/${d}`);
  for (const p of bySlugPath.keys()) if (isDir(p)) roots.add(p);
  const rootOf = (p: string) => { let best = ""; for (const r of roots) if ((p === r || p.startsWith(r + "/")) && r.length > best.length) best = r; return best || undefined; };
  // MCP servers → their project, by the paths in their command, args and cwd. Local URLs match by port later.
  const mcpBy = new Map<string, { m: McpRef; paths: string[] }[]>();
  const byPort: { m: McpRef; port: number }[] = [];
  const inRoot = (p: string | undefined, r: string) => !!p && (p === r || p.startsWith(`${r}/`));
  /** Whose process listens on a port: a project root, "" when it's someone else's, undefined when unknown. */
  const owner = (port: number) => { if (!inp.listening?.has(port)) return undefined; const cwd = inp.listening.get(port); return cwd === undefined ? undefined : rootOf(cwd) ?? ""; };
  for (const m of inp.mcps) {
    const paths = m.hints.map((h) => h.replace(/^~(?=\/)/, home)).filter((h) => h.startsWith("/"));
    const r = paths.map(rootOf).find(Boolean);
    if (r) { mcpBy.set(r, [...(mcpBy.get(r) ?? []), { m, paths: paths.filter((p) => p.startsWith(r)) }]); continue; }
    for (const h of m.hints) { const port = Number(h.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})(?:\/|$)/)?.[1]); if (port) byPort.push({ m, port }); }
  }
  const out: ProjConn[] = [];
  for (const root of roots) {
    const dir = root.split("/").pop()!;
    const slug = bySlugPath.get(root) ?? (wiki.has(dir) ? dir : undefined);
    const w = slug ? wiki.get(slug) : undefined;
    const pkg = json(`${root}/package.json`);
    const py = text(`${root}/pyproject.toml`, 128 * 1024);
    const cli = new Set<string>();
    if (typeof pkg?.bin === "string" && pkg.name) cli.add(String(pkg.name).split("/").pop()!);
    else if (pkg?.bin && typeof pkg.bin === "object") for (const k of Object.keys(pkg.bin)) cli.add(k);
    for (const sec of py.matchAll(/^\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) for (const m of sec[1].matchAll(/^\s*["']?([\w.-]+)["']?\s*=/gm)) cli.add(m[1]);
    for (const f of ls(`${root}/bin`)) if (/\.(sh|bash)$/.test(f) && !f.startsWith("_") && cli.size < 12) cli.add(`bin/${f}`);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const said = new RegExp(`(?:${esc(root)}|${esc(tilde(root))})(?![\\w-]|\\.\\w)`); // not a longer name (yt-transcriber-v2, x.bak); a full stop is fine
    const mentions = (t: string) => said.test(t);
    const services = inp.services.filter((s) => mentions(s.text));
    const skills = inp.skills.filter((s) => mentions(s.text)).map((s) => s.name);
    // Ports: what the wiki, its service and its skill say, plus package.json script ports once it has any of those,
    // plus whatever a process started from this folder is listening on right now.
    const declared = new Set<number>([...portsIn(w?.text ?? ""), ...services.flatMap((s) => portsIn(s.text)), ...inp.skills.filter((s) => skills.includes(s.name)).flatMap((s) => portsIn(s.text))]);
    if (declared.size) for (const p of portsIn(Object.values<string>(pkg?.scripts ?? {}).join("\n"))) declared.add(p);
    const live = [...(inp.listening ?? new Map()).entries()].filter(([port, cwd]) => port < 49152 && inRoot(cwd, root)).map(([port]) => port).sort((a, b) => a - b);
    // Declared ports first (the ones people know it by), then what's live; running ones before idle ones.
    const ports = [...new Set([...declared].sort((a, b) => Number(live.includes(b)) - Number(live.includes(a))).concat(live))].slice(0, 3);
    const mcps: ProjMcp[] = [];
    for (const { m, paths } of mcpBy.get(root) ?? []) {
      const prev = mcps.find((x) => x.name === m.name);
      if (prev) { if (!prev.where.includes(m.where)) prev.where.push(m.where); continue; }
      const tools = new Set<string>();
      for (const f of mcpSources(root, paths.filter((x) => norm(x) !== root))) for (const t of toolsIn(text(f))) tools.add(t);
      mcps.push({ name: m.name, where: [m.where], tools: [...tools].slice(0, 16) });
    }
    // A local MCP URL belongs to the project whose process listens on that port (or, if that's unknown, the one project that declares it).
    for (const { m, port } of byPort) {
      const o = owner(port);
      const mine = o !== undefined ? o === root : ports.includes(port) && out.every((x) => !x.ports.includes(port));
      if (mine && !mcps.some((x) => x.name === m.name)) mcps.push({ name: m.name, where: [m.where], tools: [...new Set(mcpSources(root, []).flatMap((f) => toolsIn(text(f))))].slice(0, 16) });
    }
    if (mcps.length >= 3) continue; // a folder of other people's MCP servers, not a project: leave their cards alone
    const listen = live.length > 0 || ports.some((p) => owner(p) === undefined && inp.listening?.has(p));
    const hasServer = ports.length > 0 || services.length > 0;
    if (!mcps.length && !cli.size && !services.length && !skills.length && !(w && ports.length) && !listen) continue;
    const running = services.some((s) => s.running) || listen ? true : hasServer && inp.listening ? false : undefined;
    out.push({ root, name: slug ?? dir, wiki: slug, tldr: w?.tldr || pkg?.description || py.match(/^description\s*=\s*"([^"]+)"/m)?.[1] || undefined, mcp: mcps, cli: [...cli], ports, services, skills, running });
  }
  // Two folders, one name (a clone and the wiki's path): keep the one with more to offer.
  const worth = (p: ProjConn) => p.mcp.length * 4 + p.skills.length * 2 + (p.running ? 3 : 0) + p.cli.length + p.services.length;
  const best = new Map<string, ProjConn>();
  for (const p of out) { const k = slug(p.name); const prev = best.get(k); if (!prev || worth(p) > worth(prev)) best.set(k, p); }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Cards for the store and CONNECTIONS.md. `aliases` are the MCP (and service) card ids this card replaces. */
export function projectItems(list: ProjConn[], home: string): Item[] {
  const tilde = (p: string) => (p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p);
  return list.map((p) => {
    const via: string[] = [];
    for (const m of p.mcp) via.push(`MCP ${m.name} (${m.where.join(", ")})`);
    for (const c of p.cli.slice(0, 6)) via.push(c.startsWith("bin/") ? c : `CLI ${c}`);
    for (const port of p.ports) via.push(`:${port}`);
    for (const s of p.services) via.push(`${s.kind} ${s.label}${s.running ? " (running)" : s.loaded ? " (loaded)" : ""}`);
    for (const s of p.skills) via.push(`skill ${s}`);
    const how: string[] = [];
    for (const m of p.mcp) how.push(`MCP server "${m.name}" (${m.where.join(", ")})${m.tools.length ? `, tools: ${m.tools.join(", ")}` : ""}: use its tools.`);
    if (p.skills.length) how.push(`Load the ${p.skills.join(" / ")} skill${p.skills.length > 1 ? " (whichever fits)" : ""} first; it knows how to drive this project.`);
    const clis = p.cli.filter((c) => !c.startsWith("bin/"));
    if (clis.length) how.push(`CLI: ${clis.map((c) => `\`${c}\``).join(", ")} (run from the project, e.g. \`uv run\`/\`npx\` if it isn't on PATH).`);
    const scripts = p.cli.filter((c) => c.startsWith("bin/"));
    if (scripts.length) how.push(`Scripts: ${scripts.join(", ")} (read before running).`);
    if (p.ports.length) how.push(`${p.running ? "Running" : "Serves"} on ${p.ports.map((x) => `http://localhost:${x}`).join(", ")}${p.running === false ? " (not running now; ask before starting it)" : ""}.`);
    how.push(`Project folder: ${tilde(p.root)}${p.wiki ? `; read ~/wiki/projects/${p.wiki}.md first` : ""}.`);
    const bits = [p.mcp.length ? "MCP" : "", clis.length ? "CLI" : scripts.length ? "scripts" : "", p.skills.length ? "skill" : "", p.running ? `running${p.ports.length ? ` on :${p.ports[0]}` : ""}` : p.running === false ? `not running${p.ports.length ? ` (:${p.ports[0]})` : ""}` : ""].filter(Boolean);
    const usable = p.mcp.length || p.cli.length || p.skills.length || p.running;
    return {
      id: `proj:${slug(p.name)}`, name: p.name, kind: "project", cat: "projects", group: "projects",
      state: usable ? "ready" : "installed", status: usable ? "ready" : "partial",
      detail: p.tldr ? p.tldr.slice(0, 220) : `Your project at ${tilde(p.root)}`,
      note: bits.join(" · "), via, use: how.join(" "), path: tilde(p.root),
      aliases: p.mcp.map((m) => `mcp:${slug(m.name)}`), tools: p.mcp.flatMap((m) => m.tools).slice(0, 16),
    } as Item;
  });
}
