# Session startup and first-message recovery

New herdr sessions save their launch options and first message in `~/.config/herdr-deck/session-starts.json` before creating a worktree or pane. The file is private to the user's account (0600) and replaced atomically. The browser also keeps an unacknowledged submission locally, including its request ID, so a dropped response or double click can be retried without creating another pane.

**New session → Saved starts** shows unfinished starts on the selected machine. A failed live session stays visible in the attention list with its original title and a persistent explanation. Copy saved message recovers the exact draft; Review & start again opens the creation dialog for review and does not submit it. Dismiss hides the record with Undo, retaining its saved message.

Claude accepts its initial prompt as a positional CLI argument. The deck passes it as one argument after `--`, then checks Claude's transcript for that exact user message after the launch time. This avoids a separate `agent.prompt` handoff, which Linux herdr 0.7.5 can refuse even after Claude starts. A startup error can be treated as successful only if the transcript confirms receipt. Unknown delivery is never automatically resent. Other agent types keep their existing prompt path with the same durable launch records.

A deck restart during creation or delivery marks the record as uncertain and preserves it for review. This prevents a blind replay into a replacement pane or a shell. Receipts do not make creation and the external herdr process one transaction: a lost socket response or crash may leave an unrecorded pane; the saved intent and uncertain status explain that boundary. Successful receipts are retained for the most recent 200 starts; unresolved and dismissed drafts are retained.

## Linux incident inspected on 2026-10-04

Two Conductor attempts to start a native mobile-app project created Claude transcripts but contained no user messages. The first pane (`w3:pBW`, conversation `07839576-cdc6-46f4-b473-3af84f509e39`) was in the deck's Closed list. The second (`w3:pBX`, conversation `f0b9aa08-fbca-463c-993a-eb54a851da8a`) was still open at an empty Claude prompt in its own worktree. Logs reported `agent target ... not found` and `not an active named agent` before first-message delivery. This preceded the earlier deck restart.

Read-only inspection showed the surviving native Claude process in front, `agent.get` resolving it by pane, and lookup by its advertised name failing. The previous deck kept the initial prompt only in an asynchronous function and emitted only a transient error notice. Its empty-row handling then folded the session away, using an unrelated MCP helper process as the title.

The owner's supplied message was recovered into two local startup records. No new task was dispatched and neither existing worktree was removed. The deck's persisted records describe the failed attempts without inventing messages in Claude's transcripts.

Validation covers persistence before side effects, request coalescing, changed-request rejection, restart uncertainty, occupant changes, remote routing, corrupt stores, a false named-agent failure with transcript acknowledgment, and desktop/phone review and double-submit controls. The recovery behavior is tested against fake herdr sockets; no live model is prompted by the tests.
