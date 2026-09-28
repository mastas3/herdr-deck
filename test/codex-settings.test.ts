import { describe, expect, test } from "bun:test";
import { codexModelChoices, createCodexSettings, type CodexNativeAccess } from "../src/codex-settings";
import { codexControlState } from "../src/codex-control-state";
import { CodexControlError } from "../src/codex-ipc";

const catalog = { models: [
  { slug: "model-a", display_name: "Model A", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
  { slug: "model-b", visibility: "list", default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] },
  { slug: "hidden", visibility: "hide", supported_reasoning_levels: [] },
] };
function fixture() {
  const raw: any = { latestModel: "model-a", latestReasoningEffort: "medium", cwd: "/work/project", threadRuntimeStatus: { type: "idle" },
    latestThreadSettings: { effort: "medium", approvalPolicy: "on-request", approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/work/project"], networkAccess: false }, activePermissionProfile: null } };
  const calls: any[] = [];
  const access: CodexNativeAccess = { current: async () => codexControlState(raw), raw: () => raw,
    action: async (...args) => { calls.push(args); return { applied: true }; } };
  return { raw, calls, access, settings: createCodexSettings(access, { readModels: async () => catalog }) };
}

describe("native Codex per-task settings", () => {
  test("offers only catalog-listed models and supported efforts", () => {
    const choices = codexModelChoices(catalog);
    expect(choices.map((m) => m.id)).toEqual(["model-a", "model-b"]);
    expect(choices[0]).toEqual({ id: "model-a", label: "Model A", efforts: ["low", "medium"], defaultEffort: "medium" });
    expect(codexModelChoices({ models: null })).toEqual([]);
  });
  test("switches model with its supported default and preserves all other settings", async () => {
    const f = fixture(), v = await f.settings.read("task");
    await f.settings.update("task", { expectedVersion: v.version, model: "model-b" });
    expect(f.calls).toEqual([["task", "thread-follower-update-thread-settings", { threadSettings: { model: "model-b", effort: "high" },
      condition: { ifModelEquals: "model-a", ifEffortEquals: "medium" } }, 2]]);
    expect(f.raw.latestThreadSettings.approvalsReviewer).toBe("auto_review");
  });
  test("invalid or unavailable combinations never reach the app", async () => {
    const f = fixture(), v = await f.settings.read("task");
    await expect(f.settings.update("task", { expectedVersion: v.version, model: "invented" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
    await expect(f.settings.update("task", { expectedVersion: v.version, model: "model-b", effort: "low" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
    expect(f.calls).toHaveLength(0);
  });
  test("stale forms and owner-rejected compare-and-set are reported as stale", async () => {
    const f = fixture(), v = await f.settings.read("task");
    f.raw.latestReasoningEffort = "low";
    await expect(f.settings.update("task", { expectedVersion: v.version, effort: "medium" })).rejects.toMatchObject({ code: "CODEX_STALE" });
    f.access.action = async () => ({ applied: false });
    await expect(f.settings.update("task", { expectedVersion: (await f.settings.read("task")).version, effort: "medium" })).rejects.toMatchObject({ code: "CODEX_STALE" });
  });
  test("permission changes are task-only, idle-only and retain the approval reviewer", async () => {
    const f = fixture(), v = await f.settings.read("task");
    f.raw.threadRuntimeStatus.type = "active";
    await expect(f.settings.update("task", { expectedVersion: v.version, permissionMode: "read-only" })).rejects.toMatchObject({ code: "CODEX_STALE" });
    f.raw.threadRuntimeStatus.type = "idle";
    await f.settings.update("task", { expectedVersion: v.version, permissionMode: "read-only" });
    expect(f.calls[0][2]).toMatchObject({ threadSettings: { approvalPolicy: "on-request", permissions: null, sandboxPolicy: { type: "readOnly", networkAccess: false } } });
    expect(f.calls[0][2].threadSettings.approvalsReviewer).toBeUndefined();
    expect(f.calls[0][2].activeTurnId).toBeUndefined();
    await expect(f.settings.update("task", { expectedVersion: v.version, permissionMode: "danger-full-access" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
  });
  test("managed permission profiles cannot be replaced by the deck", async () => {
    const f = fixture(); f.raw.latestThreadSettings.activePermissionProfile = { id: "company-managed" };
    const v = await f.settings.read("task");
    expect(v.permissionModes).toEqual([]);
    await expect(f.settings.update("task", { expectedVersion: v.version, permissionMode: "workspace-write" })).rejects.toMatchObject({ code: "CODEX_INVALID" });
    expect(f.calls).toHaveLength(0);
  });
  test("a next-turn built-in permission selection takes priority over the old effective sandbox", async () => {
    const f = fixture();
    f.raw.latestThreadSettings.activePermissionProfile = { id: ":workspace" };
    f.raw.latestThreadSettings.sandboxPolicy = { type: "readOnly", networkAccess: false };
    expect((await f.settings.read("task")).permissionMode).toBe("workspace-write");
  });
  test("missing catalog fails closed without breaking existing settings display", async () => {
    const f = fixture(), settings = createCodexSettings(f.access, { readModels: async () => { throw new Error("missing"); } });
    const v = await settings.read("task"); expect(v.models).toEqual([]); expect(v.model).toBe("model-a");
    await expect(settings.update("task", { expectedVersion: v.version, model: "model-b" })).rejects.toBeInstanceOf(CodexControlError);
  });
});
