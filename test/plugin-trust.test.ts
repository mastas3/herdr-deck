import { describe, expect, test } from "bun:test";
import { parseBundle, parseEvery, type Bundle } from "../src/plugin-format";
import { describeEvery, diffBundles, grantSentence, serviceName, trustSummary } from "../src/plugin-trust";

const bundle = (raw: any, extra: Record<string, string> = {}): Bundle => {
  const r = parseBundle({ "plugin.json": JSON.stringify(raw), ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.bundle;
};
const base = () => ({
  deck: 1, id: "demo-pack", name: "Demo pack", version: "1.0.0", kind: "business", description: "Trust me, it only reads.",
  grants: {
    "mail.read": { tools: ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread"] },
    "mail.send": { tools: ["mcp__claude_ai_Gmail__reply"], writes: true },
  },
  sources: [{ id: "inbox", prompt: "List mail", grants: ["mail.read"], schema: { type: "array", items: { type: "object", properties: { id: { type: "string" }, subject: { type: "string" } } } } }],
  views: [{ id: "inbox", title: "Mail", template: "inbox", source: "inbox", item: { id: "$.id", title: "$.subject" } }],
  projects: [{ id: "studio", name: "Studio", folder: "demo-studio", repo: { url: "https://github.com/acme/studio", ref: "a".repeat(40) } }],
  roles: [{ id: "writer", project: "studio", title: "Writer", agent: "claude", model: "sonnet", prompt: "prompts/writer.md" }],
  schedules: [{ id: "daily", every: "weekday 09:00", role: "writer", prompt: "Plan the day" }],
});

describe("wording", () => {
  test("describeEvery", () => {
    expect(describeEvery(parseEvery("day 09:00")!)).toBe("every day at 09:00");
    expect(describeEvery(parseEvery("weekday 18:30")!)).toBe("on weekdays at 18:30");
    expect(describeEvery(parseEvery("mon,thu,sat 07:05")!)).toBe("on Mon, Thu and Sat at 07:05");
    expect(describeEvery(parseEvery("1h")!)).toBe("every hour");
    expect(describeEvery(parseEvery("6h")!)).toBe("every 6 hours");
  });
  test("serviceName", () => {
    expect(serviceName("claude_ai_Gmail")).toBe("Gmail");
    expect(serviceName("claude_ai_Google_Calendar")).toBe("Google Calendar");
    expect(serviceName("plugin_context7_context7")).toBe("context7");
  });
  test("grantSentence groups by service and says reading vs changing", () => {
    expect(grantSentence({ tools: ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread"] })).toBe("Read Gmail (search threads, get thread)");
    expect(grantSentence({ tools: ["mcp__claude_ai_Gmail__reply"] })).toBe("Change things in Gmail (reply)");
    expect(grantSentence({ tools: ["Bash(gh search prs:*)"] })).toBe("Run commands on this machine (gh search prs)");
    expect(grantSentence({ tools: ["WebFetch", "Read"] })).toBe("Fetch web pages; Read files on this machine");
  });
});

describe("trustSummary", () => {
  test("is built from grants, repos, roles and schedules", () => {
    const t = trustSummary(bundle(base(), { "prompts/writer.md": "You write." }));
    expect(t.headline).toBe("Adds a Mail view; Starts 1 agent when you press Start; Writer gets a prompt on weekdays at 09:00.");
    expect(t.grants.map((g) => [g.id, g.writes])).toEqual([["mail.read", false], ["mail.send", true]]);
    expect(t.needsTick).toBe(false);
    expect(t.repos).toEqual([{ project: "Studio", url: "https://github.com/acme/studio", ref: "a".repeat(40) }]);
    expect(t.roles[0]).toEqual({ id: "writer", title: "Writer", agent: "claude", model: "sonnet", project: "Studio", machine: "hub" });
    expect(t.schedules).toEqual([{ id: "daily", role: "Writer", when: "on weekdays at 09:00" }]);
    expect(t.prompts.find((p) => p.where === `Role "Writer"`)?.text).toBe("You write."); // file prompts are resolved
    expect(t.description).toBe("Trust me, it only reads."); // shown, but it never feeds the facts above
  });
  test("any Bash tool needs the extra tick", () => {
    const raw: any = base();
    raw.grants["gh.read"] = { tools: ["Bash(gh search prs:*)"] };
    expect(trustSummary(bundle(raw, { "prompts/writer.md": "x" })).needsTick).toBe(true);
  });
});

describe("diffBundles", () => {
  const files = { "prompts/writer.md": "You write." };
  test("source prompt changes are listed but don't need approval", () => {
    const b: any = base(); b.version = "1.0.1"; b.sources[0].prompt = "List mail, newest first";
    const d = diffBundles(bundle(base(), files), bundle(b, files));
    expect(d).toMatchObject({ from: "1.0.0", to: "1.0.1", needsApproval: false });
    expect(d.changes).toEqual([{ text: `Source "inbox": prompt changed`, approve: false }]);
  });
  test("a new grant needs approval", () => {
    const b: any = base(); b.grants["mail.label"] = { tools: ["mcp__claude_ai_Gmail__label_thread"] };
    const d = diffBundles(bundle(base(), files), bundle(b, files));
    expect(d.needsApproval).toBe(true);
    expect(d.changes[0]).toEqual({ text: `New permission: Change things in Gmail (label thread)`, approve: true });
  });
  test("a role prompt file change needs approval: it reaches a full session", () => {
    const d = diffBundles(bundle(base(), files), bundle(base(), { "prompts/writer.md": "You write, and also push to main." }));
    expect(d.changes).toEqual([{ text: `Role "Writer" changes: prompt`, approve: true }]);
  });
  test("schedule time, repo ref, and removals", () => {
    const b: any = base();
    b.schedules[0].every = "day 06:00";
    b.projects[0].repo.ref = "b".repeat(40);
    delete b.grants["mail.send"];
    const d = diffBundles(bundle(base(), files), bundle(b, files));
    expect(d.changes).toContainEqual({ text: `No longer asks to: Change things in Gmail (reply)`, approve: false });
    expect(d.changes).toContainEqual({ text: `Schedule "daily" changes: when (every day at 06:00)`, approve: true });
    expect(d.changes).toContainEqual({ text: `Project Studio now clones https://github.com/acme/studio at bbbbbbbbbbbb`, approve: true });
    expect(d.needsApproval).toBe(true);
  });
});
