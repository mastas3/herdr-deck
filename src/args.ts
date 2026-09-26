// New-session choices (model, effort, permissions) as each agent CLI spells them.

/** Structured choices become CLI flags; free-form flags from the dialog are appended as typed. */
export function agentArgs(kind: string, o: { model?: string; effort?: string; mode?: string; args?: string | string[] }): string[] {
  const a: string[] = [];
  const model = String(o.model ?? "").trim(), effort = String(o.effort ?? "").trim(), mode = String(o.mode ?? "").trim();
  if (kind === "claude") {
    if (model) a.push("--model", model);
    if (effort) a.push("--effort", effort);
    if (mode === "bypassPermissions") a.push("--dangerously-skip-permissions");
    else if (mode) a.push("--permission-mode", mode);
  } else if (kind === "codex") {
    if (model) a.push("-m", model);
    if (effort) a.push("-c", `model_reasoning_effort="${effort}"`);
    if (mode === "yolo") a.push("--dangerously-bypass-approvals-and-sandbox");
    else if (mode) a.push("-s", mode);
  } else if (kind === "opencode") {
    if (model) a.push("-m", model);
    if (mode) a.push("--agent", mode);
  }
  const extra = Array.isArray(o.args) ? o.args.map(String) : String(o.args ?? "").split(/\s+/).filter(Boolean);
  return [...a, ...extra.filter((x) => !a.includes(x))];
}
