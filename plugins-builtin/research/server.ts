// The research plugin (autoresearch): Discover → Research at /api/research*, campaigns that run deep research sessions
// one after another. The host lends the loop its new-session machinery, closing, a session's screen and keys, and
// push; headless Claude and Jev come from the core's modules. Its state stays where it was: DECK_RESEARCH_DIR or
// <data>/research (campaigns.json and the reports), sessions work in DECK_RESEARCH_WORK or <projects>/_research, and
// DECK_RESEARCH_FAKE=1 simulates sessions (no agent time). The loop ticks on host timers: switched off, it stops where
// it is (campaigns keep their state; nothing is marked paused) and picks up on the next start, as after a restart.
// It reads Discover's profile (projects, interests) while Discover is on, and runs on every machine, as in the core.
import { homedir } from "node:os";
import type { Host } from "../../src/plugin-api";
import { jevAskOnce, jevAvailable, jevUsage } from "../../src/jev";
import { runClaude } from "../../src/model-run";
import { comparablesFor } from "../../src/library-strategy";
import { createAutoresearch } from "./autoresearch";

/** The part of Discover's service Research reads. */
type Profile = { projects: { name: string; tldr: string; status: string; weight: number }[]; interests: { label: string }[] };
type Discover = { profile(): Promise<Profile> };

export function activate(host: Host) {
  const env = (name: string) => host.env(name);
  const projectsDir = env("DECK_PROJECTS_DIR") || `${homedir()}/Documents/Projects`;
  const ideasDir = `${env("DECK_DISCOVER_DIR") || host.dataDir}/ideas`;
  const self = host.machines().find((m) => m.local && m.kind !== "app")?.id ?? "";
  const profile = async (): Promise<Profile> => (await host.use<Discover>("discover")?.profile()) ?? { projects: [], interests: [] };
  const ar = createAutoresearch(
    {
      dir: env("DECK_RESEARCH_DIR") || `${host.dataDir}/research`, workRoot: env("DECK_RESEARCH_WORK") || `${projectsDir}/_research`, self, home: homedir(),
      fake: env("DECK_RESEARCH_FAKE") ? { ms: Number(env("DECK_RESEARCH_FAKE_MS")) || 4000, fail: String(env("DECK_RESEARCH_FAKE_FAIL") ?? "").split(",").map(Number).filter(Boolean) } : undefined,
      planner: env("DECK_RESEARCH_PLANNER") === "template" ? "template" : "claude", timeoutMs: Number(env("DECK_RESEARCH_TIMEOUT_MS")) || undefined,
    },
    {
      rows: () => host.rows().map((r) => ({ key: r.key, tab: r.tab, title: r.title, status: r.status, cwd: r.cwd, firstPrompt: r.firstPrompt, machine: r.machine })),
      // Unattended: permissions by Claude's auto mode, and no questions (the last30days skill would otherwise ask some).
      start: (o) => host.sessions.start({ kind: o.kind, cwd: o.cwd, prompt: o.prompt, label: o.label, model: o.model, mode: "auto", args: ["--disallowedTools", "AskUserQuestion"], focus: false }) as Promise<{ key: string }>,
      close: async (key) => ((await host.sessions.close([key], false)) as { ok: boolean; error?: string }[])[0],
      send: (key, text) => host.sessions.send(key, text),
      keys: (key, keys) => host.sessions.keys(key, keys),
      screen: (key) => host.sessions.screen(key),
      plan: async (system, user, timeoutMs) => (await runClaude({ system, user, timeoutMs, signal: AbortSignal.timeout(timeoutMs), onText: () => {}, model: "haiku" })).text,
      jev: (state, questions, label) => jevAskOnce(state, questions as any, "research", { label }),
      jevReady: () => jevAvailable() && jevUsage().calls < jevUsage().cap,
      // Pushes follow the Automations switches and each device's own choices (quiet hours included).
      notify: (m) => {
        const rules = host.automations()?.publicState().rules;
        if (host.isNode() || !rules?.alerts.on || !rules.alerts.done) return;
        return host.push.deliver({ ...m, kind: "done" }, { urgency: "normal", ttl: 6 * 3600, topic: m.tag.replace(/[^\w-]/g, "").slice(0, 32) });
      },
      assets: async () => (await profile()).projects.filter((x) => x.weight > 0 && !["dead", "archived"].includes(x.status)).slice(0, 16).map((x) => `${x.name}${x.tldr ? `: ${x.tldr.slice(0, 80)}` : ""}`),
      interests: async () => (await profile()).interests.map((i) => i.label),
      machines: () => host.machines().filter((m) => m.kind !== "app").map(({ id, label, online, local }) => ({ id, label, online, local })),
      comparables: (t) => comparablesFor(t),
    },
  );
  const handle = (path: string, body: any) => ar.handle(path, body, { ideasDir, projectsDir });
  host.provide("research", { ...ar, handle });
  host.routes("research", ({ path, body }) => handle(path, body));
  ar.start({ every: host.every, after: host.after });
  host.onStop(() => ar.stop());
}
