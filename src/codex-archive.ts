import { CodexControlError } from "./codex-ipc";

export class CodexArchiveDesktopRequired extends CodexControlError {
  readonly action = { kind: "open-codex", label: "Open in Codex" } as const;
  constructor(archived: boolean) {
    super(`Codex still has this task loaded. ${archived ? "Archive" : "Restore"} it in the Codex app.`, "CODEX_DESKTOP_REQUIRED");
  }
}

export function codexArchiveFailure(error: unknown, archived: boolean) {
  // Only a definite writer refusal permits a handoff; a lost acknowledgement remains uncertain.
  if (error instanceof CodexControlError && error.code === "CODEX_INVALID" && /already has an active writer/i.test(error.message))
    return new CodexArchiveDesktopRequired(archived);
  return error;
}
