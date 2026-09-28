import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { CodexControlError } from "./codex-ipc";
import type { CodexControlState } from "./codex-control-state";

export type CodexModelChoice = { id: string; label: string; efforts: string[]; defaultEffort: string };
export type CodexNativeAccess = {
  current(id: string): Promise<CodexControlState>;
  raw(id: string): any;
  action(id: string, method: string, params: any, version: number): Promise<any>;
};
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export function codexModelChoices(value: any): CodexModelChoice[] {
  const rows = Array.isArray(value) ? value : value?.models;
  if (!Array.isArray(rows)) return [];
  const result = new Map<string, CodexModelChoice>();
  for (const m of rows) {
    const id = m?.slug ?? m?.id;
    if (typeof id !== "string" || !/^[\w./:-]{1,120}$/.test(id) || (m.visibility && m.visibility !== "list")) continue;
    const supported = [...new Set<string>((m.supported_reasoning_levels ?? []).map((e: any) => e?.effort ?? e).filter((e: any) => efforts.has(e)))];
    result.set(id, { id, label: typeof m.display_name === "string" ? m.display_name : id, efforts: supported,
      defaultEffort: supported.includes(m.default_reasoning_level) ? m.default_reasoning_level : supported[0] ?? "" });
  }
  return [...result.values()];
}

function permissionState(raw: any) {
  const settings = raw?.latestThreadSettings ?? {}, current = raw?.currentPermissions ?? {};
  const sandbox = settings.sandboxPolicy ?? current.sandboxPolicy;
  const profile = settings.activePermissionProfile === undefined ? current.activePermissionProfile : settings.activePermissionProfile;
  const managed = profile?.id && ![":read-only", ":workspace", ":workspace-write", ":danger-full-access"].includes(profile.id);
  // Named built-ins take effect on the next turn; the last effective sandbox can lag that selection.
  const mode = managed ? "managed" : profile?.id === ":read-only" ? "read-only" : [":workspace", ":workspace-write"].includes(profile?.id) ? "workspace-write"
    : profile?.id === ":danger-full-access" ? "custom" : sandbox?.type === "readOnly" ? "read-only" : sandbox?.type === "workspaceWrite" ? "workspace-write" : "custom";
  return { sandbox, profile, mode, managed, approvalPolicy: settings.approvalPolicy ?? current.approvalPolicy,
    approvalsReviewer: settings.approvalsReviewer ?? current.approvalsReviewer };
}
function settingsVersion(raw: any) {
  return createHash("sha256").update(JSON.stringify({ model: raw?.latestModel, effort: raw?.latestReasoningEffort ?? raw?.latestThreadSettings?.effort,
    permissions: permissionState(raw), cwd: raw?.cwd })).digest("hex").slice(0, 24);
}

export function createCodexSettings(access: CodexNativeAccess, options: { modelsFile?: string; readModels?: () => Promise<any> } = {}) {
  const file = options.modelsFile ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json");
  async function view(id: string) {
    const state = await access.current(id), raw = access.raw(id), p = permissionState(raw);
    let models: CodexModelChoice[] = [];
    try { models = codexModelChoices(options.readModels ? await options.readModels() : JSON.parse(await readFile(file, "utf8"))); } catch {}
    const permissionModes = p.managed || !["readOnly", "workspaceWrite", "dangerFullAccess"].includes(p.sandbox?.type) ? [] : [
      { id: "read-only", label: "Read only", description: "Read files; network access is off. Ask before running outside the sandbox." },
      { id: "workspace-write", label: "Workspace write", description: "Write in this task's workspace; network access is off. Ask before running outside the sandbox." },
    ];
    return { model: state.model ?? "", effort: state.effort ?? "", models, version: settingsVersion(raw), permissionMode: p.mode, permissionModes,
      permissionsNote: permissionModes.length ? "Changes apply to the next turn of this task." : "This task uses a managed or custom permission profile. Change it in Codex.",
      status: state.status };
  }
  return {
    read: view,
    async update(id: string, patch: { expectedVersion: string; model?: string; effort?: string; permissionMode?: string }) {
      const v = await view(id), raw = access.raw(id), p = permissionState(raw);
      if (!patch.expectedVersion || patch.expectedVersion !== v.version) throw new CodexControlError("Task settings changed. Reopen settings before saving.", "CODEX_STALE");
      const threadSettings: any = {};
      if (patch.model !== undefined || patch.effort !== undefined) {
        const model = v.models.find((m) => m.id === (patch.model ?? v.model));
        if (!model) throw new CodexControlError("Choose a model available in this Codex installation.", "CODEX_INVALID");
        const effort = patch.effort ?? (model.efforts.includes(v.effort) ? v.effort : model.defaultEffort);
        if (effort && !model.efforts.includes(effort)) throw new CodexControlError("This model does not support that reasoning effort.", "CODEX_INVALID");
        threadSettings.model = model.id;
        if (effort) threadSettings.effort = effort;
      }
      if (patch.permissionMode !== undefined && patch.permissionMode !== v.permissionMode) {
        if (!v.permissionModes.some((m) => m.id === patch.permissionMode)) throw new CodexControlError("Change this permission profile in Codex.", "CODEX_INVALID");
        if (v.status !== "idle") throw new CodexControlError("Wait for this task to finish before changing permissions.", "CODEX_STALE");
        const cwd = raw?.cwd;
        if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new CodexControlError("The task workspace is unavailable.", "CODEX_INVALID");
        threadSettings.approvalPolicy = "on-request";
        threadSettings.permissions = null;
        threadSettings.sandboxPolicy = patch.permissionMode === "read-only" ? { type: "readOnly", networkAccess: false } : {
          type: "workspaceWrite", writableRoots: p.sandbox?.type === "workspaceWrite" ? p.sandbox.writableRoots : [cwd],
          networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
        };
      }
      if (!Object.keys(threadSettings).length) return { ok: true, applied: false };
      // The owner serializes updates. Its condition prevents an older model/effort form overwriting a newer choice.
      const result = await access.action(id, "thread-follower-update-thread-settings", { threadSettings,
        condition: { ifModelEquals: raw.latestModel, ifEffortEquals: raw.latestReasoningEffort } }, 2);
      if (result?.applied !== true) throw new CodexControlError("Task settings changed before the update was applied.", "CODEX_STALE");
      return { ok: true, applied: true };
    },
  };
}
