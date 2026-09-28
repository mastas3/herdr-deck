// plugin.json for a code plugin ("kind": "code"): what it is, what it needs, and everything it may touch in the deck.
// The host refuses a route, service or extension point the manifest doesn't list, so the trust screen (built from this
// file, before any of its code runs) shows the whole surface. Data plugins keep their own format (src/plugin-format.ts).
import { PLUGIN_ID, type Problem } from "./plugin-format";

export type SettingDef = { label: string; type: "boolean" | "number" | "string"; default: boolean | number | string; hint?: string };
export type CodeManifest = {
  deck: 1; kind: "code"; id: string; name: string; version: string; description?: string;
  /** Plugins it can't run without (started first; turning one off turns this off). */
  requires: string[];
  /** Plugins it works with when they're on (started first when they are; `host.use` returns undefined when not). */
  uses: string[];
  /** Server entry (.ts or .js) exporting `activate(host)`. */
  server?: string;
  /** Page scripts and styles, loaded after the deck's own, only while the plugin is on. */
  client: string[]; styles: string[];
  /** "hub" (default): never starts on a node. "any": runs on every machine. */
  machine: "hub" | "any";
  /** API prefixes ("covers" → /api/covers*) and GET path prefixes ("/covers/") it serves. */
  routes: string[];
  /** Paths that open the deck's page (links the page itself handles, like /p/<project>). */
  pages: string[];
  provides: string[];
  extends: string[];
  settings: Record<string, SettingDef>;
};

const FILE = /^[A-Za-z0-9_][\w.-]*(\/[A-Za-z0-9_][\w.-]*){0,3}$/;
const API = /^[a-z][a-z0-9-]{1,39}$/;
const GET = /^\/[a-z][a-z0-9-]{1,39}\/$/;
const PAGE = /^\/[a-z][a-z0-9-]{0,39}$/;
const NAME = /^[a-z][\w.-]{1,59}$/;
/** First path segments the core serves: a plugin can't take them. */
const RESERVED = new Set(["api", "s", "js", "css", "fonts", "events", "mcp", "health", "plugins", "sw.js", "manifest.webmanifest", "offline.html", "icon"]);
/** API prefixes the core owns (the deck's own /api/* routes and the plugin system). */
export const CORE_API = new Set([
  "plugins", "automations", "brief", "chat", "close", "codex-hide", "codex-open", "codex-resume", "decide", "detail", "dev", "file", "file-open",
  "file-raw", "focus", "forget", "history", "history-rescan", "history-resume", "history-row", "image", "jev", "keys", "machines", "mcp-info", "new",
  "new-options", "push", "queue", "read", "recipe", "rename", "reopen", "search", "seen", "send", "share", "slash", "state", "tool", "tools", "type", "upload", "verify",
]);

export function parseCodeManifest(raw: unknown): { ok: true; manifest: CodeManifest } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const bad = (path: string, message: string) => problems.push({ path, message });
  const m = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : undefined;
  if (!m) return { ok: false, problems: [{ path: "", message: "plugin.json must be an object" }] };
  if (m.deck !== 1) bad("deck", 'must be 1');
  if (m.kind !== "code") bad("kind", 'must be "code"');
  if (typeof m.id !== "string" || !PLUGIN_ID.test(m.id)) bad("id", "lowercase letters, digits and dashes, 2–40 characters");
  for (const k of ["name", "version"]) if (typeof m[k] !== "string" || !m[k].trim() || m[k].length > 80) bad(k, "a short text");
  if (m.description !== undefined && (typeof m.description !== "string" || m.description.length > 500)) bad("description", "a text up to 500 characters");
  const list = (k: string, re: RegExp, why: string): string[] => {
    const v = m[k] ?? [];
    if (!Array.isArray(v)) { bad(k, "must be a list"); return []; }
    v.forEach((x, i) => { if (typeof x !== "string" || !re.test(x)) bad(`${k}[${i}]`, why); });
    if (new Set(v).size !== v.length) bad(k, "has duplicates");
    return v.filter((x) => typeof x === "string");
  };
  const requires = list("requires", PLUGIN_ID, "a plugin id");
  const uses = list("uses", PLUGIN_ID, "a plugin id");
  for (const id of requires) if (uses.includes(id)) bad("uses", `${id} is already in requires`);
  if ([...requires, ...uses].includes(m.id)) bad("requires", "a plugin can't need itself");
  if (m.server !== undefined && (typeof m.server !== "string" || !FILE.test(m.server) || !/\.(ts|js|mjs)$/.test(m.server))) bad("server", "a .ts or .js file in the plugin's folder");
  const client = list("client", /^[A-Za-z0-9_][\w.-]*(\/[A-Za-z0-9_][\w.-]*){0,3}\.js$/, "a .js file in the plugin's folder");
  const styles = list("styles", /^[A-Za-z0-9_][\w.-]*(\/[A-Za-z0-9_][\w.-]*){0,3}\.css$/, "a .css file in the plugin's folder");
  if (m.machine !== undefined && m.machine !== "hub" && m.machine !== "any") bad("machine", 'must be "hub" or "any"');
  const routes = list("routes", /^(\/?)[a-z]/, "an API name (covers) or a path prefix (/covers/)");
  routes.forEach((r, i) => {
    if (r.startsWith("/")) { if (!GET.test(r) || RESERVED.has(r.slice(1, -1))) bad(`routes[${i}]`, "a path prefix like /covers/ that the deck doesn't use"); }
    else if (!API.test(r) || CORE_API.has(r)) bad(`routes[${i}]`, "an API name the deck doesn't use");
  });
  const pages = list("pages", PAGE, "a path like /p");
  pages.forEach((p, i) => { if (RESERVED.has(p.slice(1)) || p === "/") bad(`pages[${i}]`, "a path the deck doesn't use"); });
  const provides = list("provides", NAME, "a service name");
  const ext = list("extends", NAME, "an extension point name");
  const settings: Record<string, SettingDef> = {};
  if (m.settings !== undefined) {
    if (!m.settings || typeof m.settings !== "object" || Array.isArray(m.settings)) bad("settings", "must be an object");
    else for (const [k, s] of Object.entries<any>(m.settings)) {
      const types = ["boolean", "number", "string"];
      if (!/^[a-zA-Z][\w-]{0,39}$/.test(k) || !s || typeof s.label !== "string" || !types.includes(s.type) || typeof s.default !== s.type) bad(`settings.${k}`, "needs a label, a type (boolean, number, string) and a default of that type");
      else settings[k] = { label: s.label, type: s.type, default: s.default, hint: typeof s.hint === "string" ? s.hint : undefined };
    }
  }
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    manifest: {
      deck: 1, kind: "code", id: m.id, name: m.name.trim(), version: m.version.trim(), description: m.description,
      requires, uses, server: m.server, client, styles, machine: m.machine ?? "hub", routes, pages, provides, extends: ext, settings,
    },
  };
}

/** Every file a manifest names, for the asset server and the trust check. */
export const manifestFiles = (m: CodeManifest) => [...(m.server ? [m.server] : []), ...m.client, ...m.styles];
