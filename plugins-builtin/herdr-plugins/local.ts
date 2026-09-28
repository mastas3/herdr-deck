// This machine's herdr workflow plugins: what's installed (`herdr plugin list --json`), on/off, uninstall with a way
// back, config folder, command logs, running an action for a session's pane, and installs as jobs the page polls.
// herdr does the work; the deck only calls its CLI (and its socket for an action with a pane as context).
import { randomUUID } from "node:crypto";
import type { Row } from "../../src/deck";
import { discoverSessions } from "../../src/herdr";
import { platformName, type Cli } from "./cli";

type Cmd = { command: string[]; platforms?: string[] };
export type HAction = { id: string; title: string; contexts?: string[]; platforms?: string[]; command: string[]; description?: string };
export type HPlugin = {
  id: string; name: string; version: string; description?: string; enabled: boolean; minHerdrVersion?: string; platforms?: string[];
  source: { kind: string; owner?: string; repo?: string; subdir?: string; ref?: string; commit?: string; installedAt?: number };
  root?: string; actions: HAction[]; events: { on: string; command: string[] }[]; panes: { id: string; title: string; placement?: string; command: string[] }[];
  build: Cmd[]; startup: Cmd[]; linkHandlers: { id: string; title: string; pattern: string; action: string }[]; warnings: string[];
};
export type Status = { version?: string; platform: string; plugins: HPlugin[]; error?: string };
export type Undo = { kind: "install"; spec: string; ref: string; enabled: boolean } | { kind: "link"; path: string; enabled: boolean };
export type Job = { id: string; spec: string; ref: string; state: "running" | "done" | "failed"; lines: string[]; startedAt: number; plugin?: { id: string; name: string; commit?: string }; error?: string };

const SPEC = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_LINES = 400;

/** One plugin from herdr's list, in the deck's words (herdr's field names change between versions less than ours do). */
export function normalize(p: any): HPlugin {
  const s = p.source ?? {};
  return {
    id: p.plugin_id, name: p.name ?? p.plugin_id, version: p.version ?? "", description: p.description ?? undefined, enabled: !!p.enabled,
    minHerdrVersion: p.min_herdr_version, platforms: p.platforms ?? undefined,
    source: { kind: s.kind ?? "local", owner: s.owner ?? undefined, repo: s.repo ?? undefined, subdir: s.subdir ?? undefined, ref: s.requested_ref ?? undefined, commit: s.resolved_commit ?? undefined, installedAt: s.installed_unix_ms ?? undefined },
    root: p.plugin_root ?? undefined,
    actions: (p.actions ?? []).map((a: any) => ({ id: a.id ?? a.action_id, title: a.title ?? a.id, contexts: a.contexts ?? undefined, platforms: a.platforms ?? undefined, command: a.command ?? [], description: a.description ?? undefined })),
    events: (p.events ?? []).map((e: any) => ({ on: e.on, command: e.command ?? [] })),
    panes: (p.panes ?? []).map((x: any) => ({ id: x.id, title: x.title ?? x.id, placement: x.placement, command: x.command ?? [] })),
    build: p.build ?? [], startup: p.startup ?? [], linkHandlers: p.link_handlers ?? [], warnings: p.warnings ?? [],
  };
}
/** "owner/repo[/subdir]" for a GitHub-installed plugin: what `herdr plugin install` and `uninstall` take. */
export const specOf = (p: HPlugin) => (p.source.owner && p.source.repo ? [p.source.owner, p.source.repo, p.source.subdir].filter(Boolean).join("/") : undefined);

export function createLocal(cli: Cli, rows: () => Row[]) {
  const jobs = new Map<string, Job>();
  let chain: Promise<unknown> = Promise.resolve();
  const aborts = new Set<AbortController>();
  const check = (id: string) => { if (!ID.test(String(id ?? ""))) throw new Error("That isn't a plugin id"); return id; };

  async function status(): Promise<Status> {
    const platform = platformName();
    const version = await cli.version();
    if (!version) return { platform, plugins: [], error: cli.bin() ? "herdr didn't answer" : "herdr isn't installed on this machine" };
    try {
      const r = await cli.json<{ plugins: any[] }>(["plugin", "list", "--json"]);
      return { version, platform, plugins: (r.plugins ?? []).map(normalize).sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e: any) { return { version, platform, plugins: [], error: e.message }; }
  }
  const find = async (id: string) => (await status()).plugins.find((p) => p.id === id);

  async function setEnabled(id: string, on: boolean) { await cli.json(["plugin", on ? "enable" : "disable", check(id)]); }

  /** Uninstalls (GitHub) or unlinks (local) and says how to put it back: the same commit, or the same folder. */
  async function remove(id: string): Promise<Undo | undefined> {
    const p = await find(check(id));
    if (!p) throw new Error("It isn't installed");
    const spec = specOf(p);
    const undo: Undo | undefined = p.source.kind === "github" && spec && p.source.commit ? { kind: "install", spec, ref: p.source.commit, enabled: p.enabled }
      : p.source.kind === "local" && p.root ? { kind: "link", path: p.root, enabled: p.enabled } : undefined;
    const r = await cli.run(["plugin", p.source.kind === "local" ? "unlink" : "uninstall", id], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(lastLine(r.err || r.out) || `herdr exited with ${r.code}`);
    return undo;
  }
  /** Undo of a remove. A reinstall runs the plugin's build commands again, as the first install did. */
  async function restore(u: Undo) {
    if (u.kind === "link") {
      const r = await cli.run(["plugin", "link", u.path, u.enabled ? "--enabled" : "--disabled"], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(lastLine(r.err || r.out) || "Couldn't link it again");
      return;
    }
    const job = install(u.spec, u.ref);
    const done = await waitJob(job.id);
    if (done.state !== "done") throw new Error(done.error ?? "Couldn't install it again");
    if (!u.enabled && done.plugin) await setEnabled(done.plugin.id, false);
  }

  async function configDir(id: string) {
    const r = await cli.run(["plugin", "config-dir", check(id)]);
    if (r.code !== 0) throw new Error(lastLine(r.err || r.out) || "herdr said no");
    return r.out.trim();
  }
  async function logs(id?: string, limit = 20) {
    const r = await cli.json<{ logs: any[] }>(["plugin", "log", "list", ...(id ? ["--plugin", check(id)] : []), "--limit", String(Math.min(100, Math.max(1, limit)))]);
    return (r.logs ?? []).slice(-limit).reverse();
  }

  /** Runs an action. With a session, herdr gets that pane (and its tab and workspace) as the context instead of
   *  whatever is focused in the terminal; the command runs in the plugin's folder either way. */
  async function invoke(pluginId: string, actionId: string, key?: string) {
    const row = key ? rows().find((r) => r.key === key) : undefined;
    if (key && !row) throw new Error("That session is gone");
    const context: Record<string, string> = { invocation_source: "herdr-deck" };
    if (row) Object.assign(context, { focused_pane_id: row.paneId, tab_id: row.tabId, workspace_id: row.workspaceId, focused_pane_cwd: row.cwd, focused_pane_agent: row.agent, tab_label: row.tab, workspace_label: row.workspace });
    const sock = row ? discoverSessions().find((s) => s.name === row.herdr)?.socket : undefined;
    const r = await cli.api("plugin.action.invoke", { action_id: String(actionId), plugin_id: check(pluginId), context }, sock);
    return { log: r?.log, title: r?.action?.title };
  }

  /** `herdr plugin install <spec> --ref <commit> --yes`, pinned to the commit the trust screen showed. */
  function install(spec: string, ref: string): Job {
    if (!SPEC.test(spec) || spec.split("/").some((x) => x === "." || x === "..")) throw new Error("That isn't owner/repo[/folder]");
    if (!SHA.test(ref)) throw new Error("Pin a 40-character commit");
    for (const [id, j] of jobs) if (j.state !== "running" && Date.now() - j.startedAt > 3_600_000) jobs.delete(id);
    const job: Job = { id: randomUUID(), spec, ref, state: "running", lines: [`$ herdr plugin install ${spec} --ref ${ref} --yes`], startedAt: Date.now() };
    jobs.set(job.id, job);
    const push = (l: string) => { if (job.lines.length < MAX_LINES) job.lines.push(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")); };
    const ac = new AbortController();
    aborts.add(ac);
    // One install at a time: herdr keeps one registry file.
    chain = chain.then(async () => {
      try {
        const r = await cli.run(["plugin", "install", spec, "--ref", ref, "--yes"], { timeoutMs: 15 * 60_000, onLine: (l) => push(l), signal: ac.signal });
        if (r.code !== 0) throw new Error(lastLine(r.err || r.out) || `herdr exited with ${r.code}`);
        const [owner, repo, ...sub] = spec.split("/");
        const p = (await status()).plugins.find((x) => x.source.owner === owner && x.source.repo === repo && (x.source.subdir ?? "") === sub.join("/"));
        job.plugin = p && { id: p.id, name: p.name, commit: p.source.commit };
        job.state = "done";
      } catch (e: any) { job.state = "failed"; job.error = ac.signal.aborted ? "Stopped" : e.message; push(`! ${job.error}`); }
      finally { aborts.delete(ac); }
    });
    return job;
  }
  async function waitJob(id: string) {
    for (;;) { const j = jobs.get(id); if (!j || j.state !== "running") return j ?? ({ state: "failed", error: "gone" } as Job); await Bun.sleep(300); }
  }

  return {
    status, setEnabled, remove, restore, configDir, logs, invoke, install,
    job: (id: string) => jobs.get(String(id)),
    stop: () => { for (const a of aborts) a.abort(); },
  };
}
export type Local = ReturnType<typeof createLocal>;

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop()?.replace(/^Error:\s*/, "");
