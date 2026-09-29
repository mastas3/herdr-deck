// What the New session dialog offers: folders you work in, each agent's providers, models, efforts and modes, and the
// flags you tend to start each agent with.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { Deck } from "../deck";
import type { Graves } from "./config";
import { claudeProvider, codexProvider, flatModels, opencodeCatalog, type OpencodeCatalog } from "../model-catalog";

type Opt = { v: string; l?: string; efforts?: string[] };

function codexChoices() {
  let models: Opt[] = [], defModel = "", defEffort = "";
  try {
    const d = JSON.parse(readFileSync(`${homedir()}/.codex/models_cache.json`, "utf8"));
    const arr = Array.isArray(d) ? d : d.models ?? [];
    models = arr.map((m: any) => ({ v: m.slug ?? m.id, l: m.display_name ?? undefined, efforts: (m.supported_reasoning_levels ?? []).map((x: any) => x.effort ?? x).filter(Boolean) })).filter((m: Opt) => m.v);
  } catch {}
  try {
    const cfg = readFileSync(`${homedir()}/.codex/config.toml`, "utf8");
    defModel = cfg.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    defEffort = cfg.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  } catch {}
  return { models, defModel, defEffort };
}

/** `oc` is injectable so a test needn't run OpenCode. `models` stays the flat list (with "Default" first); `providers`
 *  is the same models grouped for the page's picker. */
export async function agentChoices(oc: { get(): Promise<OpencodeCatalog> } = opencodeCatalog) {
  const cx = codexChoices();
  const ocat = await oc.get();
  const claude = [claudeProvider()], codex = [codexProvider(cx.models)];
  return {
    claude: {
      models: [{ v: "", l: "Default" }, ...flatModels(claude)],
      providers: claude,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      modes: [{ v: "", l: "Ask first" }, { v: "acceptEdits", l: "Accept edits" }, { v: "auto", l: "Auto" }, { v: "plan", l: "Plan only" }, { v: "bypassPermissions", l: "Skip all checks" }],
    },
    codex: {
      models: [{ v: "", l: `Default${cx.defModel ? ` (${cx.defModel})` : ""}` }, ...cx.models],
      providers: codex,
      efforts: [...new Set(cx.models.flatMap((m) => m.efforts ?? []))],
      defaultEffort: cx.defEffort,
      modes: [{ v: "", l: "Default" }, { v: "read-only", l: "Read only" }, { v: "workspace-write", l: "Workspace write" }, { v: "yolo", l: "No sandbox, no approvals" }],
    },
    opencode: {
      models: [{ v: "", l: "Default" }, ...flatModels(ocat.providers)],
      providers: ocat.providers,
      ...(ocat.error ? { error: ocat.error } : {}),
      efforts: [],
      modes: [{ v: "", l: "Build (default)" }, { v: "plan", l: "Plan" }],
    },
  };
}

export const AGENT_KINDS = new Set(["claude", "codex", "opencode", "gemini", "cursor", "copilot", "amp", "grok", "hermes", "qwen", "kimi", "droid", "pi"]);

/** Folder suggestions and the flags the user tends to start each agent with. */
export async function newSessionOptions(deck: Deck, graves: Graves) {
  const recent = new Map<string, number>();
  for (const r of deck.rows.values()) recent.set(r.cwd, Math.max(recent.get(r.cwd) ?? 0, r.lastActiveAt ?? r.startedAt ?? 0));
  for (const g of graves.list) recent.set(g.cwd, Math.max(recent.get(g.cwd) ?? 0, g.closedAt));
  // Common homes for code; DECK_PROJECT_DIRS (colon-separated) overrides.
  const roots = (process.env.DECK_PROJECT_DIRS ?? ["Documents/Projects", "Projects", "projects", "code", "src", "dev", "repos", "work"].map((d) => `${homedir()}/${d}`).join(":")).split(":");
  let projects: { path: string; mtime: number }[] = [];
  for (const root of roots) {
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        projects.push({ path: `${root}/${d.name}`, mtime: statSync(`${root}/${d.name}`).mtimeMs });
      }
    } catch {}
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  const argHints: Record<string, Record<string, number>> = {};
  for (const r of deck.rows.values()) {
    if (!AGENT_KINDS.has(r.agent) || !r.command) continue;
    // "node /…/bin/codex --yolo" or "claude --resume <id>": keep the flags, drop paths and resume ids.
    const words = r.command.split(/\s+/);
    const i = words.findIndex((w) => w === r.agent || w.endsWith(`/${r.agent}`));
    const flags = words.slice(i + 1).filter((w, j, a) => w.startsWith("-") && !/^--?(resume|r|session|s)$/.test(w) && !/^--?(resume|session)$/.test(a[j - 1] ?? ""));
    const k = flags.join(" ");
    (argHints[r.agent] ??= {})[k] = (argHints[r.agent][k] ?? 0) + 1;
  }
  const workspaces = [...deck.sessions.values()].filter((s) => s.online).flatMap((s) =>
    (s.snap?.workspaces ?? []).map((w: any) => ({ herdr: s.name, id: w.workspace_id, label: w.label, focused: s.snap.focused_workspace_id === w.workspace_id })),
  );
  return {
    recent: [...recent.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 30),
    projects: projects.map((p) => p.path).slice(0, 80),
    choices: await agentChoices(),
    argHints: Object.fromEntries(Object.entries(argHints).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1]).map(([a]) => a).filter(Boolean).slice(0, 3)])),
    workspaces,
  };
}
