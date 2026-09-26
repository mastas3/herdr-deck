// Plugin manifests. A plugin is data, never code: a plugin.json plus the prompt files it points to. Strangers
// write these, so the validator rejects anything it doesn't know and every problem names its exact JSON path.
import type { Need } from "./recipes";

export type Machine = "hub" | "other";
export type AgentKind = "claude" | "codex" | "opencode";
export type Template = "inbox" | "list" | "board";
export type SchemaDef = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, SchemaDef>; required?: string[]; items?: SchemaDef;
  maxItems?: number; maxLength?: number; enum?: (string | number)[]; description?: string;
};
export type GrantDef = { tools: string[]; writes?: boolean };
export type SourceDef = { id: string; prompt: string; grants: string[]; schema: SchemaDef; refresh?: string; model?: string; machine?: Machine };
export type ViewDef = { id: string; title: string; template: Template; source: string; item: Record<string, string>; actions?: string[]; pin?: boolean };
export type ActionDef = { id: string; label: string; mode: "draft" | "session"; prompt: string; draftSchema?: SchemaDef; grants?: string[] };
export type PluginRecipe = { id: string; title: string; pitch: string; cat: string; needs: Need[]; optional?: Need[]; steps: string[]; prompt: string; folder?: string; agent?: AgentKind; machine?: Machine };
export type ProjectDef = { id: string; name: string; folder: string; repo?: { url: string; ref: string }; playbook?: string };
export type RoleDef = { id: string; project: string; title: string; agent: AgentKind; model?: string; prompt: string; machine?: Machine };
export type ScheduleDef = { id: string; every: string; role: string; prompt: string };
export type Manifest = {
  deck: 1; id: string; name: string; version: string; kind: "integration" | "business";
  author?: string; description?: string; homepage?: string; icon?: { glyph: string; color: string };
  requires?: { plugins?: string[]; connections?: Need[] };
  grants?: Record<string, GrantDef>;
  sources?: SourceDef[]; views?: ViewDef[]; actions?: ActionDef[]; recipes?: PluginRecipe[];
  projects?: ProjectDef[]; roles?: RoleDef[]; schedules?: ScheduleDef[];
};
/** A plugin as the deck holds it: the parsed manifest and its files by relative path ("plugin.json" included). */
export type Bundle = { manifest: Manifest; files: Record<string, string> };
export type Problem = { path: string; message: string };

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const MAX_PROMPT = 8000;
/** A prompt field that names a file beside plugin.json: plain segments only, so it can never climb out of the folder. */
const FILE_REF = /^[A-Za-z0-9_][\w-]*(\/[A-Za-z0-9_][\w-]*){0,3}\.(md|txt)$/;
export const isFileRef = (s: unknown): s is string => typeof s === "string" && FILE_REF.test(s);

// ── tools ─────────────────────────────────────────────────────────────────────
const BUILTIN = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Write", "Edit", "Bash"];
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const SCOPED_BASH = /^Bash\(([A-Za-z0-9_][\w .\/-]{0,60}):\*\)$/;
/** The only programs a scoped Bash grant may use read-only, and then only with a read-only subcommand. Any other
 *  program counts as changing things, wrappers included (time, timeout, sudo...): they run whatever follows them. */
const READ_BINS = new Set(["gh", "git", "ls"]);

const READ_WORDS = new Set([
  "search", "get", "list", "read", "query", "find", "lookup", "view", "show", "describe",
  "count", "stats", "status", "log", "diff", "ls", "cat", "resolve", "inspect", "preview",
  "check", "info", "whoami", "history",
]);

const WRITE_WORDS = new Set([
  // Original WRITE_VERB verbs
  "send", "reply", "forward", "create", "delete", "remove", "trash", "update", "edit", "write",
  "post", "publish", "upload", "share", "move", "archive", "label", "unlabel", "mark", "apply",
  "set", "add", "merge", "close", "reopen", "comment", "push", "commit", "approve", "assign",
  "invite", "pay", "refund", "cancel", "disable", "enable", "rename", "star", "unstar",
  // Extended verbs
  "untrash", "unmark", "copy", "cp", "mv", "rm", "rmdir", "run", "exec", "execute", "eval",
  "evaluate", "install", "uninstall", "click", "type", "fill", "press", "drag", "drop", "hover",
  "navigate", "select", "download", "batch", "clone", "pull", "fetch", "save", "import", "restore",
  "kill", "stop", "start", "restart", "deploy", "build", "init", "submit", "sync", "put", "patch",
  "tag", "fork", "transfer", "charge", "schedule", "book", "order", "buy", "grant", "revoke",
  "block", "unblock", "ban", "mute", "unmute", "follow", "unfollow", "like", "subscribe",
  "unsubscribe", "trigger", "output", "api",
]);
/** Words that chain a second step onto a name ("search_and_destroy"): the read word no longer tells the whole story. */
const JOIN_WORDS = new Set(["and", "or", "then"]);

/** Tokenize a tool name: split camelCase, lowercase, split on non-alphanumeric, drop empties. */
function tokenize(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** A name is read-only when it contains at least one READ_WORD and no WRITE_WORDS. */
function readOnly(tokens: string[]): boolean {
  return tokens.some((t) => READ_WORDS.has(t)) && !tokens.some((t) => WRITE_WORDS.has(t));
}
/** A scoped Bash command's words after the program: a read word, and nothing that changes things or chains. */
function readOnlyRest(tokens: string[]): boolean {
  return tokens.some((t) => READ_WORDS.has(t)) && !tokens.some((t) => WRITE_WORDS.has(t) || JOIN_WORDS.has(t));
}

export type ToolClass = { ok: boolean; writes: boolean; web: boolean; machine: boolean; bash: boolean };
/** What a tool can do, judged by the deck from its name, never from the plugin's own say-so.
 * Default-deny: a tool reads only when its name clearly says so. */
export function toolClass(t: string): ToolClass {
  const no: ToolClass = { ok: false, writes: false, web: false, machine: false, bash: false };
  if (typeof t !== "string") return no;
  if (BUILTIN.includes(t)) {
    if (t === "WebFetch" || t === "WebSearch") return { ok: true, writes: false, web: true, machine: false, bash: false };
    if (t === "Bash") return { ok: true, writes: true, web: true, machine: true, bash: true }; // any command can reach the network
    return { ok: true, writes: t === "Write" || t === "Edit", web: false, machine: true, bash: false };
  }
  const b = SCOPED_BASH.exec(t);
  if (b) {
    const words = b[1].trim().split(/\s+/);
    // A prefix rule can't bound what the arguments do: `git ls-remote <url>`, `npm view --registry <url>` or
    // `time curl ...` all reach any host they're given. So every scoped command counts as reaching the web, and it
    // only reads when it's a known program with a read-only subcommand (one program alone, "gh", can do anything).
    const writes = !(READ_BINS.has(words[0]) && words.length >= 2 && readOnlyRest(tokenize(words.slice(1).join(" "))));
    return { ok: true, writes, web: true, machine: true, bash: true };
  }
  if (MCP_TOOL.test(t)) {
    const server = t.slice("mcp__".length, t.lastIndexOf("__"));
    const tool = t.slice(t.lastIndexOf("__") + 2);
    // Browser/web tools are always considered dangerous.
    if (/browser|playwright|puppeteer|selenium|chrome|fetch|http|scrape|crawl|navigate|url|web/i.test(server + " " + tool)) {
      return { ok: true, writes: true, web: true, machine: false, bash: false };
    }
    // Otherwise default-deny: writes only if tool name clearly says read.
    return { ok: true, writes: !readOnly(tokenize(tool)), web: false, machine: false, bash: false };
  }
  return no;
}
export function grantClass(g: GrantDef) {
  const cs = g.tools.map(toolClass);
  return { writes: g.writes === true || cs.some((c) => c.writes), web: cs.some((c) => c.web), machine: cs.some((c) => c.machine), bash: cs.some((c) => c.bash) };
}

// ── schedules and refresh ─────────────────────────────────────────────────────
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export type Every = { kind: "hours"; n: number } | { kind: "days"; days: number[]; h: number; m: number };
/** "day 09:00", "weekday 09:00", "mon,thu 09:00" or "6h". Local time on the hub. */
export function parseEvery(s: string): Every | null {
  const t = String(s ?? "").trim().toLowerCase();
  const hours = /^(\d{1,2})h$/.exec(t);
  if (hours) { const n = Number(hours[1]); return n >= 1 && n <= 24 ? { kind: "hours", n } : null; }
  const x = /^(day|weekday|[a-z]{3}(?:,[a-z]{3})*) ([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (!x) return null;
  const days = x[1] === "day" ? [0, 1, 2, 3, 4, 5, 6] : x[1] === "weekday" ? [1, 2, 3, 4, 5] : x[1].split(",").map((d) => DAYS.indexOf(d));
  if (days.some((d) => d < 0) || new Set(days).size !== days.length) return null;
  return { kind: "days", days: days.sort((a, b) => a - b), h: Number(x[2]), m: Number(x[3]) };
}
/** "10m" or "2h" in minutes, 5m to 24h; null otherwise. */
export function parseRefresh(s: string): number | null {
  const x = /^(\d{1,4})(m|h)$/.exec(String(s ?? "").trim());
  if (!x) return null;
  const min = Number(x[1]) * (x[2] === "h" ? 60 : 1);
  return min >= 5 && min <= 1440 ? min : null;
}

// ── field rules ───────────────────────────────────────────────────────────────
const LOCAL_ID = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const ID_HINT = "must be lowercase letters, digits, dots, dashes or underscores (up to 40)";
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/[^\s@]*)?$/;
const REPO_URL = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[\w.-]+\/[\w.-]+?(\.git)?$/;
const REF = /^[0-9a-f]{40}$/;
const MODEL = /^[\w.:\[\]-]{1,60}$/;
const FOLDER = /^[A-Za-z0-9][\w.-]{0,60}$/;
const RECIPE_FOLDER = /^~(\/(?!\.{1,2}(\/|$))[\w.-]+){0,6}$/;
const NEED_ID = /^[\w:*.@-]{1,80}$/;
const JSON_PATH = /^\$(\.[A-Za-z_]\w*|\[\d{1,3}\])+$/;
const LOOKS_LIKE_FILE = /^\S+\.(md|txt)$/;
const AGENTS = ["claude", "codex", "opencode"];
const SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean"];
export const TEMPLATES: Record<Template, string[]> = {
  inbox: ["id", "title", "from", "time", "snippet", "unread", "url", "body"],
  list: ["id", "title", "subtitle", "badge", "time", "url", "body"],
  board: ["id", "title", "subtitle", "badge", "column", "url", "body"],
};

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const at = (path: string, k: string | number) => (typeof k === "number" ? `${path}[${k}]` : path ? `${path}.${k}` : k);

/** Collects problems; each helper reports under the exact path it was given. */
class Check {
  p: Problem[] = [];
  bad(path: string, message: string) { if (this.p.length < 60) this.p.push({ path, message }); }
  shape(v: unknown, path: string, req: string[], opt: string[]): v is Record<string, any> {
    if (!isObj(v)) { this.bad(path, "must be an object"); return false; }
    for (const k of req) if (v[k] === undefined) this.bad(at(path, k), "is required");
    for (const k of Object.keys(v)) if (!req.includes(k) && !opt.includes(k)) this.bad(at(path, k), "isn't a field plugins can have");
    return true;
  }
  str(v: unknown, path: string, o: { max?: number; re?: RegExp; hint?: string } = {}): v is string {
    if (typeof v !== "string" || !v.trim()) { this.bad(path, "must be some text"); return false; }
    if (o.max && v.length > o.max) { this.bad(path, `is longer than ${o.max} characters`); return false; }
    if (o.re && !o.re.test(v)) { this.bad(path, o.hint ?? "has the wrong format"); return false; }
    return true;
  }
  optStr(v: unknown, path: string, o: { max?: number; re?: RegExp; hint?: string } = {}) { if (v !== undefined) this.str(v, path, o); }
  oneOf(v: unknown, path: string, options: string[]) { if (!options.includes(v as string)) this.bad(path, `must be ${options.map((o) => `"${o}"`).join(" or ")}`); }
  bool(v: unknown, path: string) { if (v !== undefined && typeof v !== "boolean") this.bad(path, "must be true or false"); }
  list(v: unknown, path: string, max: number, each: (x: any, path: string) => void) {
    if (v === undefined) return;
    if (!Array.isArray(v)) return this.bad(path, "must be a list");
    if (v.length > max) this.bad(path, `has more than ${max} entries`);
    v.slice(0, max).forEach((x, i) => each(x, at(path, i)));
  }
  /** The ids in a list of entries; a repeated id is a problem. */
  ids(v: unknown, path: string): Set<string> {
    const s = new Set<string>();
    if (Array.isArray(v)) v.forEach((x, i) => {
      if (!isObj(x) || typeof x.id !== "string") return;
      if (s.has(x.id)) this.bad(at(at(path, i), "id"), `"${x.id.slice(0, 40)}" is used twice`);
      s.add(x.id);
    });
    return s;
  }
  prompt(v: unknown, path: string, files: Record<string, string>) {
    if (isFileRef(v)) {
      if (files[v] === undefined) this.bad(path, `points at ${v}, which isn't in the plugin`);
      else if (files[v].length > MAX_PROMPT) this.bad(path, `${v} is longer than ${MAX_PROMPT} characters`);
    } else if (typeof v === "string" && LOOKS_LIKE_FILE.test(v)) this.bad(path, "looks like a file, but plugin files must be plain relative paths like prompts/inbox.md");
    else this.str(v, path, { max: MAX_PROMPT });
  }
  need(v: unknown, path: string) {
    if (!this.shape(v, path, ["label", "any"], [])) return;
    this.str(v.label, at(path, "label"), { max: 60 });
    if (Array.isArray(v.any) && !v.any.length) this.bad(at(path, "any"), "must name at least one connection");
    this.list(v.any, at(path, "any"), 10, (x, p) => this.str(x, p, { re: NEED_ID, hint: "must be a connection id like svc:gmail" }));
  }
  /** A JSON Schema subset; true when this schema added no problems. */
  schema(v: unknown, path: string, depth = 0): boolean {
    const before = this.p.length;
    if (depth > 6) { this.bad(path, "is nested too deeply"); return false; }
    if (!this.shape(v, path, ["type"], ["properties", "required", "items", "maxItems", "maxLength", "enum", "description"])) return false;
    if (!SCHEMA_TYPES.includes(v.type)) this.bad(at(path, "type"), `must be one of ${SCHEMA_TYPES.join(", ")}`);
    if (v.properties !== undefined) {
      if (v.type !== "object" || !isObj(v.properties)) this.bad(at(path, "properties"), "only an object schema has properties");
      else for (const [k, s] of Object.entries(v.properties).slice(0, 40)) this.schema(s, `${at(path, "properties")}.${k}`, depth + 1);
    }
    if (v.required !== undefined && (!Array.isArray(v.required) || v.required.some((r: unknown) => typeof r !== "string" || !isObj(v.properties) || !Object.hasOwn(v.properties, r as string))))
      this.bad(at(path, "required"), "must list names from properties");
    if (v.items !== undefined) { if (v.type !== "array") this.bad(at(path, "items"), "only an array schema has items"); else this.schema(v.items, at(path, "items"), depth + 1); }
    if (v.maxItems !== undefined && !(Number.isInteger(v.maxItems) && v.maxItems >= 1 && v.maxItems <= 500)) this.bad(at(path, "maxItems"), "must be a whole number from 1 to 500");
    if (v.maxLength !== undefined && !(Number.isInteger(v.maxLength) && v.maxLength >= 1 && v.maxLength <= 100_000)) this.bad(at(path, "maxLength"), "must be a whole number from 1 to 100000");
    if (v.enum !== undefined && (!Array.isArray(v.enum) || !v.enum.length || v.enum.length > 50 || v.enum.some((e: unknown) => typeof e !== "string" && typeof e !== "number")))
      this.bad(at(path, "enum"), "must be a list of up to 50 strings or numbers");
    this.optStr(v.description, at(path, "description"), { max: 300 });
    return this.p.length === before;
  }
}

/** Every problem with a manifest, each under its exact JSON path. Empty means it can be shown on a trust screen. */
export function validate(raw: unknown, files: Record<string, string>): Problem[] {
  const c = new Check();
  if (!c.shape(raw, "", ["deck", "id", "name", "version", "kind"], ["author", "description", "homepage", "icon", "requires", "grants", "sources", "views", "actions", "recipes", "projects", "roles", "schedules"])) return c.p;
  const m = raw;
  if (m.deck !== 1) c.bad("deck", "must be 1: this deck understands plugin format 1");
  c.str(m.id, "id", { re: PLUGIN_ID, hint: "must be 2-40 lowercase letters, digits or dashes" });
  c.str(m.name, "name", { max: 60 });
  c.str(m.version, "version", { re: SEMVER, hint: "must be a version like 1.0.0" });
  c.oneOf(m.kind, "kind", ["integration", "business"]);
  c.optStr(m.author, "author", { max: 80 });
  c.optStr(m.description, "description", { max: 500 });
  c.optStr(m.homepage, "homepage", { max: 300, re: HTTPS_URL, hint: "must be an https:// link" });
  if (m.icon !== undefined && c.shape(m.icon, "icon", ["glyph", "color"], [])) {
    c.str(m.icon.glyph, "icon.glyph", { max: 3 });
    c.str(m.icon.color, "icon.color", { re: /^#[0-9a-fA-F]{6}$/, hint: "must be a colour like #7c3aed" });
  }
  if (m.requires !== undefined && c.shape(m.requires, "requires", [], ["plugins", "connections"])) {
    c.list(m.requires.plugins, "requires.plugins", 10, (x, p) => { if (c.str(x, p, { re: PLUGIN_ID, hint: "must be a plugin id" }) && x === m.id) c.bad(p, "a plugin can't require itself"); });
    c.list(m.requires.connections, "requires.connections", 20, (x, p) => c.need(x, p));
  }

  // Grants: the only tools any agent run from this plugin may get.
  const grants = new Map<string, GrantDef>();
  if (m.grants !== undefined) {
    if (!isObj(m.grants)) c.bad("grants", "must be an object of named grants");
    else {
      const entries = Object.entries(m.grants);
      if (entries.length > 20) c.bad("grants", "has more than 20 grants");
      for (const [gid, g] of entries.slice(0, 20)) {
        const gp = `grants.${gid}`;
        if (gid === "constructor") { c.bad(gp, "is a reserved name"); continue; }
        if (!LOCAL_ID.test(gid)) { c.bad(gp, `grant names ${ID_HINT.replace("must be ", "are ")}`); continue; }
        if (!c.shape(g, gp, ["tools"], ["writes"])) continue;
        c.bool(g.writes, at(gp, "writes"));
        if (Array.isArray(g.tools) && !g.tools.length) c.bad(at(gp, "tools"), "must name at least one tool");
        c.list(g.tools, at(gp, "tools"), 20, (t, p) => { if (!toolClass(t).ok) c.bad(p, `isn't a tool plugins may use: ${String(t).slice(0, 80)}`); });
        if (Array.isArray(g.tools)) grants.set(gid, { tools: g.tools.filter((t: unknown): t is string => typeof t === "string"), writes: g.writes === true });
      }
    }
  }
  // Every read-only grant goes to one read worker (sources, and the first half of draft actions), used or not.
  // If that worker could read your accounts or files and also reach the web, a prompt injection could leak them.
  const readTools = [...grants.values()].filter((g) => !grantClass(g).writes).flatMap((g) => g.tools);
  const webTools = readTools.filter((t) => toolClass(t).web).length;
  if (webTools && webTools < readTools.length) c.bad("grants", "the plugin's read-only grants can't both read your accounts or files and reach the web: its agent would hold both at once and could leak them");
  const grantRefs = (v: unknown, path: string, want: "read" | "write") => c.list(v, path, 10, (gid, p) => {
    if (typeof gid !== "string" || !grants.has(gid)) return c.bad(p, `there's no grant named ${String(gid).slice(0, 40)}`);
    const w = grantClass(grants.get(gid)!).writes;
    if (want === "read" && w) c.bad(p, `${gid} can change things, and sources may only read`);
    if (want === "write" && !w) c.bad(p, `${gid} only reads; a draft action's grants are what Send uses to change things`);
  });

  const sourceIds = c.ids(m.sources, "sources"), actionIds = c.ids(m.actions, "actions");
  const projectIds = c.ids(m.projects, "projects"), roleIds = c.ids(m.roles, "roles");
  c.ids(m.views, "views"); c.ids(m.recipes, "recipes"); c.ids(m.schedules, "schedules");
  const sourceTokens = (v: unknown, path: string) => {
    const text = typeof v === "string" ? promptText(files, v) : "";
    for (const [, sid] of text.matchAll(/\{source:([^}]*)\}/g)) if (!sourceIds.has(sid)) c.bad(path, `uses {source:${sid.slice(0, 40)}}, but there's no source by that name`);
  };
  const itemProps = new Map<string, Record<string, unknown> | undefined>();

  c.list(m.sources, "sources", 20, (s, sp) => {
    if (!c.shape(s, sp, ["id", "prompt", "grants", "schema"], ["refresh", "model", "machine"])) return;
    c.str(s.id, at(sp, "id"), { re: LOCAL_ID, hint: ID_HINT });
    c.prompt(s.prompt, at(sp, "prompt"), files);
    // Sources refresh on their own, so one feeding another would carry data between them without anyone looking.
    if (typeof s.prompt === "string" && /\{source:[^}]*\}/.test(promptText(files, s.prompt))) c.bad(at(sp, "prompt"), "a source can't use another source's data");
    grantRefs(s.grants, at(sp, "grants"), "read");
    if (c.schema(s.schema, at(sp, "schema"))) {
      if (s.schema.type !== "array" || s.schema.items?.type !== "object") c.bad(at(sp, "schema"), "must be a list of objects (type array, items of type object)");
      else itemProps.set(s.id, s.schema.items.properties);
    }
    if (s.refresh !== undefined && parseRefresh(s.refresh) === null) c.bad(at(sp, "refresh"), "must be between 5m and 24h, like 10m or 2h");
    c.optStr(s.model, at(sp, "model"), { re: MODEL, hint: "must be a model name like haiku" });
    if (s.machine !== undefined) c.oneOf(s.machine, at(sp, "machine"), ["hub", "other"]);
  });

  c.list(m.views, "views", 20, (v, vp) => {
    if (!c.shape(v, vp, ["id", "title", "template", "source", "item"], ["actions", "pin"])) return;
    c.str(v.id, at(vp, "id"), { re: LOCAL_ID, hint: ID_HINT });
    c.str(v.title, at(vp, "title"), { max: 40 });
    c.oneOf(v.template, at(vp, "template"), Object.keys(TEMPLATES));
    if (!sourceIds.has(v.source)) c.bad(at(vp, "source"), `there's no source named ${String(v.source).slice(0, 40)}`);
    const fields = Object.hasOwn(TEMPLATES, v.template) ? TEMPLATES[v.template as Template] : undefined;
    const props = itemProps.get(v.source);
    const ip = at(vp, "item");
    if (!isObj(v.item)) c.bad(ip, 'must map template fields to paths, like { "title": "$.subject" }');
    else {
      for (const k of ["id", "title"]) if (v.item[k] === undefined) c.bad(at(ip, k), "is required");
      for (const [f, path] of Object.entries(v.item).slice(0, 12)) {
        const fp = at(ip, f);
        if (fields && !fields.includes(f)) c.bad(fp, `isn't a field of the ${v.template} template (it has ${fields.join(", ")})`);
        if (typeof path !== "string" || !JSON_PATH.test(path)) { c.bad(fp, "must be a path into the item, like $.subject"); continue; }
        const first = /^\$\.([A-Za-z_]\w*)/.exec(path)?.[1];
        if (first && props && !Object.hasOwn(props, first)) c.bad(fp, `points at ${first}, which the source's schema doesn't have`);
      }
    }
    c.list(v.actions, at(vp, "actions"), 10, (a, p) => { if (!actionIds.has(a)) c.bad(p, `there's no action named ${String(a).slice(0, 40)}`); });
    c.bool(v.pin, at(vp, "pin"));
  });

  c.list(m.actions, "actions", 30, (a, ap) => {
    if (!c.shape(a, ap, ["id", "label", "mode", "prompt"], ["draftSchema", "grants"])) return;
    c.str(a.id, at(ap, "id"), { re: LOCAL_ID, hint: ID_HINT });
    c.str(a.label, at(ap, "label"), { max: 40 });
    c.oneOf(a.mode, at(ap, "mode"), ["draft", "session"]);
    c.prompt(a.prompt, at(ap, "prompt"), files);
    sourceTokens(a.prompt, at(ap, "prompt"));
    if (a.mode === "draft") {
      if (a.draftSchema === undefined) c.bad(at(ap, "draftSchema"), "is required for a draft action");
      else if (c.schema(a.draftSchema, at(ap, "draftSchema")) && a.draftSchema.type !== "object") c.bad(at(ap, "draftSchema"), "must be of type object");
      if (!Array.isArray(a.grants) || !a.grants.length) c.bad(at(ap, "grants"), "a draft action needs the grant Send will use");
      else grantRefs(a.grants, at(ap, "grants"), "write");
    } else if (a.mode === "session" && (a.grants !== undefined || a.draftSchema !== undefined)) {
      c.bad(ap, "a session action runs with your own permissions, so it takes no grants or draftSchema");
    }
  });

  c.list(m.recipes, "recipes", 30, (r, rp) => {
    if (!c.shape(r, rp, ["id", "title", "pitch", "cat", "needs", "steps", "prompt"], ["optional", "folder", "agent", "machine"])) return;
    c.str(r.id, at(rp, "id"), { re: LOCAL_ID, hint: ID_HINT });
    c.str(r.title, at(rp, "title"), { max: 80 });
    c.str(r.pitch, at(rp, "pitch"), { max: 300 });
    c.str(r.cat, at(rp, "cat"), { re: /^[a-z0-9-]{1,30}$/, hint: "must be a category id like email" });
    c.list(r.needs, at(rp, "needs"), 10, (x, p) => c.need(x, p));
    c.list(r.optional, at(rp, "optional"), 10, (x, p) => c.need(x, p));
    c.list(r.steps, at(rp, "steps"), 12, (x, p) => c.str(x, p, { max: 300 }));
    c.prompt(r.prompt, at(rp, "prompt"), files);
    c.optStr(r.folder, at(rp, "folder"), { re: RECIPE_FOLDER, hint: "must be a folder under ~, like ~/wiki" });
    if (r.agent !== undefined) c.oneOf(r.agent, at(rp, "agent"), AGENTS);
    if (r.machine !== undefined) c.oneOf(r.machine, at(rp, "machine"), ["hub", "other"]);
  });

  c.list(m.projects, "projects", 10, (x, pp) => {
    if (!c.shape(x, pp, ["id", "name", "folder"], ["repo", "playbook"])) return;
    c.str(x.id, at(pp, "id"), { re: LOCAL_ID, hint: ID_HINT });
    c.str(x.name, at(pp, "name"), { max: 60 });
    c.str(x.folder, at(pp, "folder"), { re: FOLDER, hint: "must be one folder name, like content-studio" });
    if (x.repo !== undefined && c.shape(x.repo, at(pp, "repo"), ["url", "ref"], [])) {
      const up = at(pp, "repo.url");
      if (c.str(x.repo.url, up, { max: 200, re: REPO_URL, hint: "must be a public https:// git link like https://github.com/owner/name" }) && /\/\.{1,2}(\/|\.git$|$)/.test(x.repo.url)) c.bad(up, "can't contain . or .. segments");
      c.str(x.repo.ref, at(pp, "repo.ref"), { re: REF, hint: "must be a full 40-character commit id, so what you install can't change underneath you" });
    }
    if (x.playbook !== undefined) {
      if (!isFileRef(x.playbook)) c.bad(at(pp, "playbook"), "must be a file in the plugin, like playbook.md");
      else c.prompt(x.playbook, at(pp, "playbook"), files);
    }
  });

  c.list(m.roles, "roles", 20, (x, rp) => {
    if (!c.shape(x, rp, ["id", "project", "title", "agent", "prompt"], ["model", "machine"])) return;
    c.str(x.id, at(rp, "id"), { re: LOCAL_ID, hint: ID_HINT });
    if (!projectIds.has(x.project)) c.bad(at(rp, "project"), `there's no project named ${String(x.project).slice(0, 40)}`);
    c.str(x.title, at(rp, "title"), { max: 40 });
    c.oneOf(x.agent, at(rp, "agent"), AGENTS);
    c.optStr(x.model, at(rp, "model"), { re: MODEL, hint: "must be a model name like sonnet" });
    c.prompt(x.prompt, at(rp, "prompt"), files);
    sourceTokens(x.prompt, at(rp, "prompt"));
    if (x.machine !== undefined) c.oneOf(x.machine, at(rp, "machine"), ["hub", "other"]);
  });

  c.list(m.schedules, "schedules", 20, (x, sp) => {
    if (!c.shape(x, sp, ["id", "every", "role", "prompt"], [])) return;
    c.str(x.id, at(sp, "id"), { re: LOCAL_ID, hint: ID_HINT });
    if (typeof x.every !== "string" || !parseEvery(x.every)) c.bad(at(sp, "every"), 'must be like "day 09:00", "weekday 09:00", "mon,thu 09:00" or "6h"');
    if (!roleIds.has(x.role)) c.bad(at(sp, "role"), `there's no role named ${String(x.role).slice(0, 40)}`);
    c.prompt(x.prompt, at(sp, "prompt"), files);
    sourceTokens(x.prompt, at(sp, "prompt"));
  });
  return c.p;
}

/** plugin.json parsed and validated together with its files. */
export function parseBundle(files: Record<string, string>): { ok: true; bundle: Bundle } | { ok: false; problems: Problem[] } {
  let raw: unknown;
  try { raw = JSON.parse(files["plugin.json"] ?? ""); }
  catch (e: any) { return { ok: false, problems: [{ path: "plugin.json", message: `isn't valid JSON (${String(e?.message ?? e).slice(0, 120)})` }] }; }
  const problems = validate(raw, files);
  return problems.length ? { ok: false, problems } : { ok: true, bundle: { manifest: raw as Manifest, files } };
}

/** The files a manifest points at. It runs before validation, so it's careful about shapes and only returns safe refs. */
export function referencedFiles(raw: unknown): string[] {
  if (!isObj(raw)) return [];
  const out = new Set<string>();
  const take = (v: unknown) => { if (isFileRef(v)) out.add(v); };
  for (const k of ["sources", "actions", "roles", "schedules", "recipes"]) if (Array.isArray(raw[k])) for (const x of raw[k]) if (isObj(x)) take(x.prompt);
  if (Array.isArray(raw.projects)) for (const x of raw.projects) if (isObj(x)) take(x.playbook);
  return [...out].slice(0, 100);
}

/** A prompt field's text: the file it names, or the inline text itself. */
export const promptText = (files: Record<string, string>, s: string) => (isFileRef(s) ? files[s] ?? "" : s);
