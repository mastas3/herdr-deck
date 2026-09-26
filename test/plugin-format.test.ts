import { describe, expect, test } from "bun:test";
import { grantClass, isFileRef, parseEvery, parseRefresh, toolClass } from "../src/plugin-format";

describe("toolClass", () => {
  test("MCP tools: reading vs changing is judged from the tool's own name", () => {
    expect(toolClass("mcp__claude_ai_Gmail__search_threads")).toEqual({ ok: true, writes: false, web: false, machine: false, bash: false });
    expect(toolClass("mcp__claude_ai_Gmail__get_thread").writes).toBe(false);
    expect(toolClass("mcp__claude_ai_Gmail__reply").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Gmail__label_thread").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Gmail__send_message").writes).toBe(true);
    expect(toolClass("mcp__plugin_context7_context7__query-docs").writes).toBe(false);
  });
  test("built-in tools", () => {
    expect(toolClass("Read")).toEqual({ ok: true, writes: false, web: false, machine: true, bash: false });
    expect(toolClass("Write").writes).toBe(true);
    expect(toolClass("WebFetch")).toEqual({ ok: true, writes: false, web: true, machine: false, bash: false });
    expect(toolClass("Bash")).toEqual({ ok: true, writes: true, web: true, machine: true, bash: true });
  });
  test("scoped Bash: a read-only two-word command reads; anything open-ended counts as writing", () => {
    expect(toolClass("Bash(gh search prs:*)")).toEqual({ ok: true, writes: false, web: true, machine: true, bash: true });
    expect(toolClass("Bash(gh pr merge:*)").writes).toBe(true);
    expect(toolClass("Bash(gh:*)").writes).toBe(true); // one program with any subcommand is no scope
    expect(toolClass("Bash(curl:*)")).toMatchObject({ writes: true, web: true });
    expect(toolClass("Bash(python3 x.py:*)").writes).toBe(true);
  });
  test("scoped Bash: always reaches the web, and only gh, git or ls with a read subcommand reads", () => {
    // A wrapper runs whatever follows it, and many CLIs take a host in their arguments.
    for (const t of ["Bash(time curl list:*)", "Bash(timeout 5 curl get:*)", "Bash(nice curl get:*)", "Bash(xcrun curl get:*)", "Bash(npm view:*)", "Bash(kubectl get:*)", "Bash(git pull:*)"])
      expect(toolClass(t), t).toMatchObject({ ok: true, writes: true, web: true });
    for (const t of ["Bash(git log:*)", "Bash(gh pr list:*)"]) expect(toolClass(t), t).toEqual({ ok: true, writes: false, web: true, machine: true, bash: true });
  });
  test("anything else is refused", () => {
    for (const t of ["mcp__x__*", "Bash(rm -rf /; echo:*)", "Bash(a|b:*)", "Task", "NotebookEdit", "mcp__x", "", "bash"]) expect(toolClass(t).ok).toBe(false);
    expect(toolClass(42 as any).ok).toBe(false);
  });
  test("a grant writes if its author says so or any tool does", () => {
    expect(grantClass({ tools: ["mcp__claude_ai_Gmail__search_threads"] }).writes).toBe(false);
    expect(grantClass({ tools: ["mcp__claude_ai_Gmail__search_threads"], writes: true }).writes).toBe(true);
    expect(grantClass({ tools: ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__reply"] }).writes).toBe(true);
    expect(grantClass({ tools: ["Bash(gh search prs:*)"] })).toEqual({ writes: false, web: true, machine: true, bash: true });
  });
  test("unknown or oddly named tools count as changing things (default-deny)", () => {
    // MCP tools without clear read verbs default to writes: true
    expect(toolClass("mcp__claude_ai_Google_Drive__copy_file").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Gmail__untrash_message").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Gmail__untrash_thread").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Gmail__unmark_message_spam").writes).toBe(true);
    expect(toolClass("mcp__claude_ai_Claude_Docs__batch").writes).toBe(true);
    expect(toolClass("mcp__x__do_thing").writes).toBe(true);
    // Browser/web tools are always dangerous
    expect(toolClass("mcp__plugin_playwright_playwright__browser_snapshot")).toEqual({
      ok: true, writes: true, web: true, machine: false, bash: false,
    });
    expect(toolClass("mcp__plugin_playwright_playwright__browser_click")).toEqual({
      ok: true, writes: true, web: true, machine: false, bash: false,
    });
    for (const t of ["browser_type", "browser_navigate", "browser_evaluate", "browser_run_code_unsafe"])
      expect(toolClass(`mcp__plugin_playwright_playwright__${t}`), t).toMatchObject({ ok: true, writes: true, web: true });
    expect(toolClass("mcp__fetch__fetch")).toEqual({ ok: true, writes: true, web: true, machine: false, bash: false });
    // Safe read-only operations
    expect(toolClass("mcp__claude_ai_Google_Drive__search_files").writes).toBe(false);
    expect(toolClass("mcp__claude_ai_Google_Drive__read_file_content").writes).toBe(false);
    expect(toolClass("mcp__x__searchThreads").writes).toBe(false);
    // Scoped Bash with write operations
    expect(toolClass("Bash(git clone:*)").writes).toBe(true);
    expect(toolClass("Bash(npm install:*)").writes).toBe(true);
    expect(toolClass("Bash(docker run:*)").writes).toBe(true);
    expect(toolClass("Bash(aws s3 rm:*)").writes).toBe(true);
    expect(toolClass("Bash(find . -delete:*)").writes).toBe(true);
    expect(toolClass("Bash(gh api:*)").writes).toBe(true);
    // Scoped Bash with read-only operations
    expect(toolClass("Bash(aws s3 ls:*)").writes).toBe(true); // only gh, git and ls may read; aws can reach any endpoint
    expect(toolClass("Bash(git log:*)").writes).toBe(false);
    expect(toolClass("Bash(gh pr list:*)").writes).toBe(false);
    // A program that runs other programs
    expect(toolClass("Bash(npx foo:*)")).toMatchObject({ writes: true, web: true });
  });
});

describe("parsers", () => {
  test("parseEvery", () => {
    expect(parseEvery("day 09:00")).toEqual({ kind: "days", days: [0, 1, 2, 3, 4, 5, 6], h: 9, m: 0 });
    expect(parseEvery("weekday 18:30")).toEqual({ kind: "days", days: [1, 2, 3, 4, 5], h: 18, m: 30 });
    expect(parseEvery("thu,mon 07:05")).toEqual({ kind: "days", days: [1, 4], h: 7, m: 5 });
    expect(parseEvery("6h")).toEqual({ kind: "hours", n: 6 });
    for (const bad of ["day 24:00", "day 9:00", "mon,mon 09:00", "funday 09:00", "0h", "25h", "every day", ""]) expect(parseEvery(bad)).toBeNull();
  });
  test("parseRefresh: 5m to 24h", () => {
    expect(parseRefresh("10m")).toBe(10);
    expect(parseRefresh("2h")).toBe(120);
    expect(parseRefresh("24h")).toBe(1440);
    for (const bad of ["4m", "25h", "10", "1d", "m"]) expect(parseRefresh(bad)).toBeNull();
  });
  test("isFileRef: plain relative paths inside the plugin only", () => {
    for (const ok of ["prompts/inbox.md", "playbook.md", "a/b/c/d.txt", "_x.md"]) expect(isFileRef(ok)).toBe(true);
    for (const bad of ["../x.md", "/etc/x.md", "prompts/../x.md", "./x.md", "a/b/c/d/e.md", "x.js", "a b.md", "v1.2.md", 5]) expect(isFileRef(bad)).toBe(false);
  });
});

import { parseBundle, promptText, referencedFiles, validate, type Problem } from "../src/plugin-format";

const mail = () => {
  const raw: any = {
    deck: 1, id: "demo-mail", name: "Demo mail", version: "1.0.0", kind: "integration",
    requires: { connections: [{ label: "Gmail", any: ["svc:gmail"] }] },
    grants: {
      "mail.read": { tools: ["mcp__claude_ai_Gmail__search_threads"] },
      "mail.send": { tools: ["mcp__claude_ai_Gmail__reply"], writes: true },
    },
    sources: [{ id: "inbox", prompt: "prompts/inbox.md", grants: ["mail.read"], refresh: "10m", model: "haiku",
      schema: { type: "array", maxItems: 30, items: { type: "object", properties: { id: { type: "string" }, subject: { type: "string" } }, required: ["id"] } } }],
    views: [{ id: "inbox", title: "Mail", template: "inbox", source: "inbox", item: { id: "$.id", title: "$.subject" }, actions: ["reply"], pin: true }],
    actions: [{ id: "reply", label: "Reply", mode: "draft", prompt: "Draft a reply to {item}", draftSchema: { type: "object", properties: { body: { type: "string" } } }, grants: ["mail.send"] }],
  };
  return { raw, files: { "plugin.json": JSON.stringify(raw), "prompts/inbox.md": "List my inbox." } as Record<string, string> };
};
const pack = () => {
  const raw: any = {
    deck: 1, id: "demo-pack", name: "Demo pack", version: "0.2.0", kind: "business",
    sources: [{ id: "trends", prompt: "Top 5 trends today", grants: [], schema: { type: "array", items: { type: "object", properties: { title: { type: "string" } } } } }],
    projects: [{ id: "studio", name: "Studio", folder: "demo-studio", repo: { url: "https://github.com/acme/studio", ref: "a".repeat(40) }, playbook: "playbook.md" }],
    roles: [{ id: "writer", project: "studio", title: "Writer", agent: "claude", model: "sonnet", prompt: "prompts/writer.md" }],
    schedules: [{ id: "daily", every: "day 09:00", role: "writer", prompt: "Plan today from {source:trends}" }],
    recipes: [{ id: "post", title: "Write a post", pitch: "One post", cat: "content", needs: [], steps: ["Write it"], prompt: "Write a post", folder: "~/Documents" }],
    actions: [{ id: "discuss", label: "Discuss", mode: "session", prompt: "Let's talk about {item}" }],
  };
  return { raw, files: { "plugin.json": JSON.stringify(raw), "prompts/writer.md": "You write posts.", "playbook.md": "- [ ] First post (manual)" } as Record<string, string> };
};
const has = (ps: Problem[], path: string, fragment: string) =>
  expect(ps.some((p) => p.path === path && p.message.includes(fragment)), `${path} ~ ${fragment}\n${JSON.stringify(ps, null, 1)}`).toBe(true);

describe("validate", () => {
  test("good manifests pass", () => {
    expect(validate(mail().raw, mail().files)).toEqual([]);
    expect(validate(pack().raw, pack().files)).toEqual([]);
  });
  test("unknown fields are rejected, top-level and nested", () => {
    const { raw, files } = mail();
    raw.run = "rm -rf ~"; raw.sources[0].exec = "x";
    const ps = validate(raw, files);
    has(ps, "run", "isn't a field");
    has(ps, "sources[0].exec", "isn't a field");
  });
  test("identity fields", () => {
    const { raw, files } = mail();
    Object.assign(raw, { deck: 2, id: "Bad_ID", version: "v1", kind: "app" });
    const ps = validate(raw, files);
    has(ps, "deck", "must be 1");
    has(ps, "id", "lowercase");
    has(ps, "version", "1.0.0");
    has(ps, "kind", '"integration" or "business"');
    expect(validate("nope", {})).toEqual([{ path: "", message: "must be an object" }]);
  });
  test("grants: unknown tools and empty lists", () => {
    const { raw, files } = mail();
    raw.grants["mail.read"].tools = ["mcp__x__*"];
    raw.grants.empty = { tools: [] };
    const ps = validate(raw, files);
    has(ps, "grants.mail.read.tools[0]", "isn't a tool");
    has(ps, "grants.empty.tools", "at least one");
  });
  test("a source can't use a grant that changes things, even a disguised one", () => {
    const { raw, files } = mail();
    raw.grants.sneaky = { tools: ["mcp__claude_ai_Gmail__reply"] }; // no writes: true, but the tool replies
    raw.sources[0].grants = ["mail.read", "sneaky"];
    has(validate(raw, files), "sources[0].grants[1]", "sources may only read");
  });
  test("a source can't both read your accounts and reach the web", () => {
    const { raw, files } = mail();
    raw.grants.web = { tools: ["WebFetch"] };
    raw.sources[0].grants = ["mail.read", "web"];
    has(validate(raw, files), "sources[0].grants", "could leak them");
    raw.sources[0].grants = ["web"]; // web alone is fine
    expect(validate(raw, files)).toEqual([]);
  });
  test("sources: schema shape, refresh, missing grant", () => {
    const { raw, files } = mail();
    raw.sources[0].schema = { type: "object" };
    raw.sources[0].refresh = "1m";
    raw.sources[0].grants = ["nope"];
    const ps = validate(raw, files);
    has(ps, "sources[0].schema", "list of objects");
    has(ps, "sources[0].refresh", "5m and 24h");
    has(ps, "sources[0].grants[0]", "no grant named nope");
  });
  test("views: template fields, paths and schema properties", () => {
    const { raw, files } = mail();
    raw.views[0].item = { id: "$.id", title: "$.subjct", colour: "$.x", from: "subject" };
    raw.views[0].source = "nope";
    raw.views[0].actions = ["gone"];
    const ps = validate(raw, files);
    has(ps, "views[0].source", "no source named nope");
    has(ps, "views[0].item.colour", "isn't a field of the inbox template");
    has(ps, "views[0].item.from", "like $.subject");
    has(ps, "views[0].actions[0]", "no action named gone");
    const again = mail(); again.raw.views[0].item.title = "$.subjct";
    has(validate(again.raw, again.files), "views[0].item.title", "doesn't have");
  });
  test("draft actions need write grants and an object schema; session actions take none", () => {
    const { raw, files } = mail();
    raw.actions[0].grants = ["mail.read"];
    raw.actions[0].draftSchema = { type: "string" };
    raw.actions.push({ id: "chat", label: "Chat", mode: "session", prompt: "Hi", grants: ["mail.send"] });
    const ps = validate(raw, files);
    has(ps, "actions[0].grants[0]", "only reads");
    has(ps, "actions[0].draftSchema", "type object");
    has(ps, "actions[1]", "takes no grants");
  });
  test("prompt files must be inside the plugin and present", () => {
    const { raw, files } = mail();
    raw.sources[0].prompt = "../secrets.md";
    has(validate(raw, files), "sources[0].prompt", "plain relative paths");
    raw.sources[0].prompt = "prompts/missing.md";
    has(validate(raw, files), "sources[0].prompt", "isn't in the plugin");
    raw.sources[0].prompt = "x".repeat(8001);
    has(validate(raw, files), "sources[0].prompt", "longer than 8000");
  });
  test("business pack references and formats", () => {
    const { raw, files } = pack();
    raw.roles[0].project = "nope";
    raw.schedules[0].every = "sometimes";
    raw.schedules[0].role = "ghost";
    raw.schedules[0].prompt = "Use {source:nope}";
    raw.projects[0].repo = { url: "https://user:pw@github.com/a/b", ref: "main" };
    raw.projects[0].folder = "../escape";
    raw.recipes[0].folder = "~/../etc";
    const ps = validate(raw, files);
    has(ps, "roles[0].project", "no project named nope");
    has(ps, "schedules[0].every", "day 09:00");
    has(ps, "schedules[0].role", "no role named ghost");
    has(ps, "schedules[0].prompt", "{source:nope}");
    has(ps, "projects[0].repo.url", "https://");
    has(ps, "projects[0].repo.ref", "40-character");
    has(ps, "projects[0].folder", "one folder name");
    has(ps, "recipes[0].folder", "under ~");
  });
  test("repeated ids", () => {
    const { raw, files } = pack();
    raw.roles.push({ ...raw.roles[0] });
    has(validate(raw, files), "roles[1].id", "used twice");
  });
});

describe("bundles", () => {
  test("parseBundle reports bad JSON and returns the bundle when valid", () => {
    expect(parseBundle({ "plugin.json": "{nope" })).toMatchObject({ ok: false, problems: [{ path: "plugin.json" }] });
    const { files } = mail();
    const r = parseBundle(files);
    expect(r.ok && r.bundle.manifest.id).toBe("demo-mail");
  });
  test("referencedFiles tolerates junk and lists only safe refs", () => {
    expect(referencedFiles(null)).toEqual([]);
    expect(referencedFiles({ sources: [{ prompt: "prompts/a.md" }, { prompt: "../b.md" }, 5], projects: [{ playbook: "playbook.md" }], roles: "x" }).sort()).toEqual(["playbook.md", "prompts/a.md"]);
  });
  test("promptText resolves file refs and passes inline text through", () => {
    expect(promptText({ "p.md": "from file" }, "p.md")).toBe("from file");
    expect(promptText({}, "inline text")).toBe("inline text");
  });
  test("hostile keys never crash the validator and are reported", () => {
    // __proto__ as grant name: JSON.parse makes it an own key, not prototype
    const raw1 = JSON.parse('{"deck":1,"id":"test","name":"Test","version":"1.0.0","kind":"integration","grants":{"__proto__":{"tools":["mcp__x__y"],"writes":true}},"sources":[{"id":"s1","prompt":"x","grants":["tools"],"schema":{"type":"array","items":{"type":"object"}}}]}');
    expect(() => validate(raw1, {})).not.toThrow();
    const ps1 = validate(raw1, {});
    has(ps1, "grants.__proto__", "grant names are");
    has(ps1, "sources[0].grants[0]", "no grant named tools");

    // grant "constructor" is reserved
    const { raw, files } = mail();
    raw.grants.constructor = { tools: ["mcp__claude_ai_Gmail__search_threads"] };
    const ps2 = validate(raw, files);
    has(ps2, "grants.constructor", "reserved");

    // source referencing undefined grant "constructor"
    raw.grants.constructor = undefined;
    raw.sources[0].grants = ["constructor"];
    const ps3 = validate(raw, files);
    has(ps3, "sources[0].grants[0]", "no grant named constructor");

    // view with template "__proto__"
    const { raw: raw4, files: files4 } = mail();
    raw4.views[0].template = "__proto__" as any;
    const ps4 = validate(raw4, files4);
    has(ps4, "views[0].template", "must be");

    // view item path $.constructor against schema lacking it
    const { raw: raw5, files: files5 } = mail();
    raw5.views[0].item.title = "$.constructor";
    const ps5 = validate(raw5, files5);
    has(ps5, "views[0].item.title", "doesn't have");

    // schema with required: ["constructor"] and properties lacking it
    const { raw: raw6, files: files6 } = mail();
    raw6.sources[0].schema = { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["constructor"] } };
    const ps6 = validate(raw6, files6);
    has(ps6, "sources[0].schema.items.required", "must list names");
  });
});
