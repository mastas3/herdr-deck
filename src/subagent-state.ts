// When a Claude subagent counts as running (the inspector's Subagents tab, the list's subagent count).
// A foreground subagent is done when the parent's Agent call returns. A background one returns to its parent at once
// ("Async agent launched"), so only its own transcript tells: done once it writes its final answer. In between, a
// transcript that goes quiet for 45 s means it stopped, unless its last tool call is still open (a five-minute test
// run writes nothing until it ends): then it may wait up to 30 minutes.
export const SUB_QUIET_MS = 45_000;
export const SUB_WAIT_MS = 30 * 60_000;

export type SubState = {
  ended: boolean; // its last assistant message is end_turn text
  pending: boolean; // a tool call it made has no result yet
  background: boolean; // meta.json requestShape "background"
  callDone: boolean; // the parent's Agent call has returned
  quietMs: number; // since its transcript was last written
};
export function subRunning(s: SubState): boolean {
  if (s.ended) return false;
  if (s.callDone && !s.background) return false;
  return s.quietMs < (s.pending ? SUB_WAIT_MS : SUB_QUIET_MS);
}
