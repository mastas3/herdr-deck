// The trust screen's facts: built only from what a plugin's manifest makes possible (never from its own
// description), plus what an update changes. The page renders all of it as escaped text.
import { grantClass, parseEvery, promptText, toolClass, type Bundle, type Every, type GrantDef } from "./plugin-format";

export type TrustGrant = { id: string; sentence: string; tools: string[]; writes: boolean; web: boolean; machine: boolean; bash: boolean };
export type Trust = {
  id: string; name: string; version: string; kind: string; author: string; description: string; homepage: string;
  icon: { glyph: string; color: string } | null;
  headline: string;
  grants: TrustGrant[]; needsTick: boolean;
  repos: { project: string; url: string; ref: string }[];
  roles: { id: string; title: string; agent: string; model: string; project: string; machine: string }[];
  schedules: { id: string; role: string; when: string }[];
  requires: { plugins: string[]; connections: string[] };
  adds: { sources: string[]; views: string[]; actions: string[]; recipes: string[]; projects: string[] };
  prompts: { where: string; text: string }[];
};
export type Change = { text: string; approve: boolean };
export type Diff = { from: string; to: string; changes: Change[]; needsApproval: boolean };

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const and = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function describeEvery(e: Every): string {
  if (e.kind === "hours") return e.n === 1 ? "every hour" : `every ${e.n} hours`;
  const t = `${pad(e.h)}:${pad(e.m)}`;
  if (e.days.length === 7) return `every day at ${t}`;
  if (e.days.join() === "1,2,3,4,5") return `on weekdays at ${t}`;
  return `on ${and(e.days.map((d) => DAY[d]))} at ${t}`;
}
/** "claude_ai_Google_Calendar" → "Google Calendar". */
export const serviceName = (server: string) => server.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "").replace(/[_-]+/g, " ").trim();

/** One grant in plain English, e.g. "Read Gmail (search threads, get thread)". */
export function grantSentence(g: GrantDef): string {
  const parts = new Map<string, string[]>();
  const add = (head: string, what?: string) => { const l = parts.get(head) ?? []; if (what && !l.includes(what)) l.push(what); parts.set(head, l); };
  const all = g.writes === true || g.tools.some((t) => toolClass(t).writes);
  for (const t of g.tools) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
    const scoped = /^Bash\((.+):\*\)$/.exec(t);
    if (mcp) add(`${all || toolClass(t).writes ? "Change things in" : "Read"} ${serviceName(mcp[1])}`, mcp[2].replace(/[_-]+/g, " "));
    else if (scoped) add("Run commands on this machine", scoped[1].trim());
    else if (t === "Bash") add("Run any command on this machine");
    else if (t === "Write" || t === "Edit") add("Change files on this machine");
    else if (t === "Read" || t === "Glob" || t === "Grep") add("Read files on this machine");
    else if (t === "WebFetch") add("Fetch web pages");
    else if (t === "WebSearch") add("Search the web");
  }
  return [...parts].map(([head, what]) => (what.length ? `${head} (${what.join(", ")})` : head)).join("; ");
}

export function trustSummary(b: Bundle): Trust {
  const m = b.manifest;
  const text = (s: string) => promptText(b.files, s);
  const grants = Object.entries(m.grants ?? {}).map(([id, g]) => ({ id, sentence: grantSentence(g), tools: g.tools, ...grantClass(g) }));
  const roleTitle = new Map((m.roles ?? []).map((r) => [r.id, r.title]));
  const projectName = new Map((m.projects ?? []).map((p) => [p.id, p.name]));
  const roles = (m.roles ?? []).map((r) => ({ id: r.id, title: r.title, agent: r.agent, model: r.model ?? "", project: projectName.get(r.project) ?? r.project, machine: r.machine ?? "hub" }));
  const schedules = (m.schedules ?? []).map((s) => ({ id: s.id, role: roleTitle.get(s.role) ?? s.role, when: describeEvery(parseEvery(s.every)!) }));
  const views = (m.views ?? []).map((v) => v.title);
  const head: string[] = [];
  if (views.length) head.push(`Adds ${and(views.map((v) => `a ${v} view`))}`);
  if (roles.length) head.push(`Starts ${plural(roles.length, "agent")} when you press Start`);
  if (schedules.length) head.push(`${schedules[0].role} gets a prompt ${schedules[0].when}${schedules.length > 1 ? ` (and ${plural(schedules.length - 1, "more schedule")})` : ""}`);
  if (m.recipes?.length) head.push(`Adds ${plural(m.recipes.length, "recipe")}`);
  return {
    id: m.id, name: m.name, version: m.version, kind: m.kind, author: m.author ?? "", description: m.description ?? "", homepage: m.homepage ?? "",
    icon: m.icon ?? null,
    headline: head.length ? `${head.join("; ")}.` : "Adds nothing you'll see yet.",
    grants, needsTick: grants.some((g) => g.bash),
    repos: (m.projects ?? []).flatMap((p) => (p.repo ? [{ project: p.name, url: p.repo.url, ref: p.repo.ref }] : [])),
    roles, schedules,
    requires: { plugins: m.requires?.plugins ?? [], connections: (m.requires?.connections ?? []).map((n) => n.label) },
    adds: { sources: (m.sources ?? []).map((s) => s.id), views, actions: (m.actions ?? []).map((a) => a.label), recipes: (m.recipes ?? []).map((r) => r.title), projects: (m.projects ?? []).map((p) => p.name) },
    prompts: [
      ...(m.sources ?? []).map((s) => ({ where: `Source "${s.id}"`, text: text(s.prompt) })),
      ...(m.actions ?? []).map((a) => ({ where: `Action "${a.label}"`, text: text(a.prompt) })),
      ...(m.roles ?? []).map((r) => ({ where: `Role "${r.title}"`, text: text(r.prompt) })),
      ...(m.schedules ?? []).map((s) => ({ where: `Schedule "${s.id}"`, text: text(s.prompt) })),
      ...(m.recipes ?? []).map((r) => ({ where: `Recipe "${r.title}"`, text: text(r.prompt) })),
      ...(m.projects ?? []).flatMap((p) => (p.playbook ? [{ where: `Playbook for ${p.name}`, text: text(p.playbook) }] : [])),
    ],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What an update changes. Grants, repos, roles and schedules need approval again: grants box in every agent run,
 *  and role and schedule prompts reach full sessions. So do recipes and session actions: they open a prefilled
 *  session with your own permissions. Source and draft prompts don't: their grants box them in. */
export function diffBundles(old: Bundle, next: Bundle): Diff {
  const a = old.manifest, b = next.manifest, out: Change[] = [];
  const push = (text: string, approve: boolean) => out.push({ text, approve });
  const pa = (s: string) => promptText(old.files, s), pb = (s: string) => promptText(next.files, s);

  const ga = a.grants ?? {}, gb = b.grants ?? {};
  for (const id of new Set([...Object.keys(ga), ...Object.keys(gb)])) {
    if (!Object.hasOwn(ga, id)) push(`New permission: ${grantSentence(gb[id])}`, true);
    else if (!Object.hasOwn(gb, id)) push(`No longer asks to: ${grantSentence(ga[id])}`, false);
    else if (!same(ga[id], gb[id])) push(`Permission "${id}" changes to: ${grantSentence(gb[id])}`, true);
  }
  function walk<T extends { id: string }>(xs: T[] | undefined, ys: T[] | undefined, name: (x: T) => string, added: (y: T) => boolean, changed: (x: T, y: T) => Change | null) {
    const A = new Map((xs ?? []).map((x) => [x.id, x])), B = new Map((ys ?? []).map((y) => [y.id, y]));
    for (const [id, y] of B) { const x = A.get(id); if (!x) push(`New ${name(y)}`, added(y)); else { const ch = changed(x, y); if (ch) out.push(ch); } }
    for (const [id, x] of A) if (!B.has(id)) push(`Removes ${name(x)}`, false);
  }
  const fields = (pairs: [string, unknown, unknown][]) => pairs.filter(([, x, y]) => !same(x, y)).map(([k]) => k);

  walk(a.projects, b.projects, (p) => `project ${p.name}`, () => true, (x, y) =>
    !same(x.repo, y.repo) ? { text: y.repo ? `Project ${y.name} now clones ${y.repo.url} at ${y.repo.ref.slice(0, 12)}` : `Project ${y.name} no longer clones a repo`, approve: true }
    : x.folder !== y.folder ? { text: `Project ${y.name} moves to the folder ${y.folder}`, approve: true } : null);
  walk(a.roles, b.roles, (r) => `agent role ${r.title}`, () => true, (x, y) => {
    const f = fields([["agent", x.agent, y.agent], ["model", x.model, y.model], ["project", x.project, y.project], ["machine", x.machine, y.machine], ["prompt", pa(x.prompt), pb(y.prompt)]]);
    return f.length ? { text: `Role "${y.title}" changes: ${f.join(", ")}`, approve: true } : null;
  });
  walk(a.schedules, b.schedules, (s) => `schedule "${s.id}" (${describeEvery(parseEvery(s.every)!)})`, () => true, (x, y) => {
    const f = fields([["when", x.every, y.every], ["role", x.role, y.role], ["prompt", pa(x.prompt), pb(y.prompt)]]);
    return f.length ? { text: `Schedule "${y.id}" changes: ${f.map((k) => (k === "when" ? `when (${describeEvery(parseEvery(y.every)!)})` : k)).join(", ")}`, approve: true } : null;
  });
  walk(a.sources, b.sources, (s) => `source "${s.id}"`, () => false, (x, y) => {
    if (!same(x.grants, y.grants) || !same(x.machine, y.machine)) return { text: `Source "${y.id}" now uses ${and(y.grants)}${y.machine === "other" ? " on your other machine" : ""}`, approve: true };
    return pa(x.prompt) !== pb(y.prompt) ? { text: `Source "${y.id}": prompt changed`, approve: false } : null;
  });
  walk(a.actions, b.actions, (x) => `action "${x.label}"`, () => true, (x, y) => {
    if (x.mode !== y.mode || !same(x.grants, y.grants)) return { text: `Action "${y.label}" now ${y.mode === "draft" ? `sends with ${and(y.grants ?? [])}` : "opens a session"}`, approve: true };
    return pa(x.prompt) !== pb(y.prompt) ? { text: `Action "${y.label}": prompt changed`, approve: y.mode === "session" } : null;
  });
  walk(a.views, b.views, (v) => `view ${v.title}`, () => false, () => null);
  walk(a.recipes, b.recipes, (r) => `recipe ${r.title}`, () => true, (x, y) => (pa(x.prompt) !== pb(y.prompt) ? { text: `Recipe ${y.title}: prompt changed`, approve: true } : null));
  if (!same(a.requires, b.requires)) push("Needs different plugins or connections", false);
  return { from: a.version, to: b.version, changes: out, needsApproval: out.some((c) => c.approve) };
}
