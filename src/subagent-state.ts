// When a Claude subagent counts as running (the inspector's Subagents tab, the list's subagent count).
// It is done once it writes its final answer (end_turn text), or when the parent's Agent call closes: a foreground
// agent's call returns with its answer; a background one's is closed by its notice (transcript.ts, taskDone), except
// that a parent read without that notice may show its launch ("Async agent launched") as a closed call, so for a
// background agent only a failed or killed call counts. In between, a transcript quiet for 45 s means it stopped,
// unless a call is still open: its own last tool call (a five-minute test run writes nothing until it ends) or the
// parent's call to it. Then it may wait up to 30 minutes (a session killed mid-call stops showing).
export const SUB_QUIET_MS = 45_000;
export const SUB_WAIT_MS = 30 * 60_000;

export type SubState = {
  ended: boolean; // its last assistant message is end_turn text
  pending: boolean; // a tool call it made has no result yet
  background: boolean; // meta.json requestShape "background"
  call?: "running" | "done" | "error"; // the parent's Agent call to it, when the parent was read
  quietMs: number; // since its transcript was last written
};
export function subRunning(s: SubState): boolean {
  if (s.ended || s.call === "error") return false;
  if (s.call === "done" && !s.background) return false;
  return s.quietMs < (s.pending || s.call === "running" ? SUB_WAIT_MS : SUB_QUIET_MS);
}
