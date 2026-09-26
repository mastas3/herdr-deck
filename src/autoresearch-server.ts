// Autoresearch, wired to the deck: the server lends the loop its new-session machinery, closing, headless Claude,
// Jev and push. DECK_RESEARCH_DIR moves its state; DECK_RESEARCH_FAKE=1 simulates sessions (no agent time).
import { homedir } from "node:os";
import { createAutoresearch } from "./autoresearch";
import type { Automations } from "./automations";
import type { Deck, Row } from "./deck";
import { call } from "./herdr";
import { jevAskOnce, jevAvailable, jevUsage } from "./jev";
import { runClaude } from "./mix";
import type { PushStore } from "./push";
import { comparablesFor } from "./library-strategy";

type Handles = {
  self: string; dataDir: string; deck: Deck; rows: () => Row[];
  startSession: (body: any) => Promise<{ key: string }>; closeLocal: (keys: string[], wholeTab: boolean) => Promise<any[]>; sendText: (key: string, text: string) => Promise<void>;
  screen: (row: Row) => Promise<string[] | undefined>; push: PushStore; auto: () => Automations | undefined; isNode: () => boolean;
  discover: { profile: () => Promise<{ projects: { name: string; tldr: string; status: string; weight: number }[]; interests: { label: string }[] }>; paths: { ideas: string } };
  machines: () => { id: string; label: string; online: boolean; local: boolean; kind?: string }[];
};

export function researchForServer(h: Handles) {
  const env = process.env;
  const projectsDir = env.DECK_PROJECTS_DIR || `${homedir()}/Documents/Projects`;
  const ar = createAutoresearch(
    {
      dir: env.DECK_RESEARCH_DIR || `${h.dataDir}/research`, workRoot: env.DECK_RESEARCH_WORK || `${projectsDir}/_research`, self: h.self, home: homedir(),
      fake: env.DECK_RESEARCH_FAKE ? { ms: Number(env.DECK_RESEARCH_FAKE_MS) || 4000, fail: String(env.DECK_RESEARCH_FAKE_FAIL ?? "").split(",").map(Number).filter(Boolean) } : undefined,
      planner: env.DECK_RESEARCH_PLANNER === "template" ? "template" : "claude", timeoutMs: Number(env.DECK_RESEARCH_TIMEOUT_MS) || undefined,
    },
    {
      rows: () => h.rows().map((r) => ({ key: r.key, tab: r.tab, title: r.title, status: r.status, cwd: r.cwd, firstPrompt: r.firstPrompt, machine: r.machine })),
      // Unattended: permissions by Claude's auto mode, and no questions (the last30days skill would otherwise ask some).
      start: (o) => h.startSession({ kind: o.kind, cwd: o.cwd, prompt: o.prompt, label: o.label, model: o.model, mode: "auto", args: ["--disallowedTools", "AskUserQuestion"], focus: false }),
      close: async (key) => (await h.closeLocal([key], false))[0],
      send: (key, text) => h.sendText(key, text),
      keys: async (key, keys) => { const f = h.deck.find(key); if (f) await call(f.sess.socket, "pane.send_keys", { pane_id: f.row.paneId, keys }); },
      screen: async (key) => { const row = h.rows().find((r) => r.key === key); return row ? ((await h.screen(row)) ?? []).join("\n") : ""; },
      plan: async (system, user, timeoutMs) => (await runClaude({ system, user, timeoutMs, signal: AbortSignal.timeout(timeoutMs), onText: () => {}, model: "haiku" })).text,
      jev: (state, questions, label) => jevAskOnce(state, questions as any, "research", { label }),
      jevReady: () => jevAvailable() && jevUsage().calls < jevUsage().cap,
      // Pushes follow the Automations switches and each device's own choices (quiet hours included).
      notify: (m) => {
        const rules = h.auto()?.publicState().rules;
        if (h.isNode() || !rules?.alerts.on || !rules.alerts.done) return;
        return h.push.deliver({ ...m, kind: "done" }, { urgency: "normal", ttl: 6 * 3600, topic: m.tag.replace(/[^\w-]/g, "").slice(0, 32) });
      },
      assets: async () => (await h.discover.profile()).projects.filter((x) => x.weight > 0 && !["dead", "archived"].includes(x.status)).slice(0, 16).map((x) => `${x.name}${x.tldr ? `: ${x.tldr.slice(0, 80)}` : ""}`),
      interests: async () => (await h.discover.profile()).interests.map((i) => i.label),
      machines: () => h.machines().filter((m) => m.kind !== "app").map(({ id, label, online, local }) => ({ id, label, online, local })),
      comparables: (t) => comparablesFor(t),
    },
  );
  return { ...ar, handle: (path: string, body: any) => ar.handle(path, body, { ideasDir: h.discover.paths.ideas, projectsDir }) };
}
