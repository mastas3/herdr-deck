import type { CodexControl } from "./codex-control";
import { CodexControlError } from "./codex-ipc";

// Opening is an explicit user action; background polling must never steal desktop focus.
export function createCodexRecovery(options: {
  control: Pick<CodexControl, "watch">;
  platform?: string;
  open?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<unknown>;
  attempts?: number;
}) {
  const platform = options.platform ?? process.platform;
  const opening = new Map<string, Promise<unknown>>();
  const open = options.open ?? (async (url: string) => {
    const proc = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    const timeout = setTimeout(() => proc.kill(), 5000);
    try { if (await proc.exited !== 0) throw new CodexControlError("Could not open the Codex app on this Mac."); }
    finally { clearTimeout(timeout); }
  });
  return {
    canOpen: platform === "darwin",
    async connect(id: string) {
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new CodexControlError("Invalid Codex task", "CODEX_INVALID");
      if (opening.has(id)) return opening.get(id);
      const run = (async () => {
        const current = await options.control.watch(id, true);
        if (current.ready) return current;
        if (platform !== "darwin") throw new CodexControlError("Open this task in Codex on its host machine, then reconnect.");
        await open(`codex://threads/${id}`);
        let state = current;
        for (let i = 0; i < (options.attempts ?? 4); i++) {
          await (options.sleep ?? Bun.sleep)(600);
          state = await options.control.watch(id, true);
          if (state.ready) return state;
        }
        return state;
      })().finally(() => opening.delete(id));
      opening.set(id, run);
      return run;
    },
  };
}
