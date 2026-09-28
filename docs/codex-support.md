# Codex support

The deck supports both herdr's Codex CLI sessions and local Codex desktop threads. CLI sessions use the normal
herdr message, steering, queue and terminal controls. Desktop threads have the same transcript and project
inspection features, plus native controls while the desktop owns the task.

## Native controls

- Replies and image uploads reach the original desktop task. The owner inherits its model, reasoning,
  permissions, workspace, plugins and app tools. Files and long pastes retain the deck's existing upload flow.
- While working, Queue holds a message in the deck; Steer sends it into the active turn. The queue is owned by
  the deck, so queued drafts are not mirrored into the desktop's separate follow-up queue.
- Stop includes the observed turn id and uses the desktop's user-stop behavior (including its goal handling).
- Command/file approvals, permission requests, structured questions and MCP elicitation responses use actual
  request ids. Async assistant questions are displayed too; answers become native follow-up messages.
  Unsupported interactive request types link to the desktop. Permission grants are limited to the requested
  permissions for the current turn. No approval is answered automatically.
- Prompt tools, quick replies and native compaction work on connected tasks. The terminal is hidden because
  desktop tasks have no herdr pane.
- New → Codex offers a native desktop task or a CLI session. Native creation accepts an optional first message;
  its normal desktop turn keeps app tools and is protected against duplicate creation/delivery retries.
- More actions offers rename, fork, archive and an archived-task list with restore. Restored old tasks remain
  visible even outside the normal recent-task window. Archive respects Codex's writer ownership: if the desktop
  still has a task loaded, use Archive in Codex itself. The deck does not bypass that lock.
- Task settings offers models and reasoning efforts from the local Codex catalog. Read-only/workspace permission
  changes apply to the next turn and preserve the reviewer. Managed/custom profiles remain in Codex.
- Edit last message replaces the latest user turn and reruns it after an explicit confirmation. Earlier turns
  cannot be edited through the follower protocol. Stale turn ids and repeated receipts cannot run another edit.
- The desktop's queued messages are visible alongside the deck queue. Native queue writes remain in Codex:
  its current follower API replaces the whole array without a conflict precondition, so concurrent edits could
  overwrite a draft. The deck never writes its private queue file.
- Active tasks are followed in the background for status and questions. Opening a task follows its live state;
  unused subscriptions expire. The existing incremental transcript reader still supplies chat history/output.

`src/codex-ipc.ts` connects to the same user's `CODEX_HOME/ipc/ipc.sock`; it neither starts another Codex
backend nor edits Codex's database. `src/codex-control.ts` discovers the current owner and subscribes to its
versioned snapshots/patches. Only allowlisted actions are exposed through authenticated deck routes. A missing
owner, disconnect, unknown stream version or missed patch disables controls until a fresh snapshot arrives.
Use Open & reconnect to open an unloaded task and wait for its owner on macOS. Background reconnects never
raise the app. Other hosts offer normal reconnect and an instruction to open the task on its own machine.

Lifecycle metadata uses a short-lived bundled `codex app-server --stdio` process initialized as `herdr-deck`.
Its allowlist excludes turn execution and it refuses all incoming tool/approval requests. New tasks get a
neutral canonical initialization item so their rollout exists before desktop hydration; all real user messages
and model execution still go through the desktop owner. The adapter never writes Codex's database directly.
The archived list reads the index because this desktop version's `thread/list` omits some paginated tasks.
`DECK_CODEX_APP_BINARY` can select an installed host binary explicitly; a bare CLI install is not advertised as
a native desktop integration.

Message receipts in `~/.config/herdr-deck/codex-delivery.json` record a hash and delivery result, not prompt
text. They are saved before sending; uncertain delivery cannot be automatically retried after a restart.
Queued sends pause on errors instead of silently dropping the message or retrying a potentially accepted turn.
Check the conversation before deliberately editing/replacing an uncertain message.

## Local data

- `src/codex-store.ts` reads the newest `state_<version>.sqlite` under `CODEX_HOME` (default `~/.codex`). It uses
  `threads.rollout_path`, archive state, names, model metadata and `thread_spawn_edges`. Connections are read-only,
  queried data is cached, missing schemas degrade to the older readers, and missing files are checked again.
- `src/codexapp.ts` combines the desktop's local catalog with the state index. Recent file activity keeps an
  active thread visible even when the catalog is stale. Archived and deck-hidden threads are excluded.
- `src/codex-turn.ts` reads complete JSONL events, handles partial appends and file replacement, and matches
  completion ids to the current turn. An interrupted turn does not appear as successfully completed.
- `src/codex-subagents.ts` resolves children through recorded parent/child relationships. A subagent transcript
  or image is served only when the requested child belongs to the selected parent.
- The transcript reader shows the nested command and file-change items emitted by code mode, without repeating
  an existing direct tool call. It keeps model output text and strips known injected setup from user messages.

## Compatibility and remaining gaps

On 2026-09-28, read-only inspection of the installed desktop bundle showed a private, versioned local IPC
interface for owner discovery and follower start, steer, interrupt and compact operations. Initializing the
same-user socket succeeded, but owner discovery returned `no-client-found` for the active deck task and three
other recent local threads. A stream subscription also produced no snapshot. No prompts or interrupts were
sent during those initial probes. Subsequent discovery succeeded for both the active task and a dedicated
integration task. Native start, steer, user-stop, streamed state and async question answers were then verified
against the desktop owner. A native reply successfully called the desktop's `list_artifacts` tool, confirming
that app tools were retained. The cause of the earlier discovery failures was not established.

The bridge is a compatibility adapter for the installed private desktop IPC, not a stable public OpenAI API.
Its frame/stream versions and method versions are checked and tested. App updates may require an adapter
update. It currently controls locally owned desktop tasks; remote desktop hosts need a deck on their host.
Remaining limitations are archiving a desktop-loaded task, editing earlier user turns, writing Codex's native
queue atomically, and changing managed/custom permission profiles. The public app-server API does not attach
a second execution server to a desktop-owned task; its metadata operations obey writer locks. The gated
shared-daemon path in the installed app is not enabled or required by this change.

Resuming into a separate CLI remains an explicit user action; the deck refuses it while the app row is working
or blocked. No changes to desktop startup, sandbox policy or tailnet configuration are needed.

## Checks

`bun test test/codex-control.test.ts test/codex-parity.test.ts test/v8.test.ts` covers lifecycle, partial writes, old and current indexes,
archive filtering, child membership, injected setup, nested tools and the busy-resume guard. The normal full
suite remains `bun test`. Native tests also cover fragmented socket frames, disconnects, owner replacement,
revision gaps, stale stop/approval ids, permission scope, async questions, and receipt recovery after restart.
`bin/ui-snapshot.mjs --views codex-session,codex-approval,codex-question,codex-disconnected,codex-menu` exercises
desktop/phone views with synthetic data; it sends no messages to real agents.

The 2026-09-28 validation passed all 898 repository tests. Four existing desktop/phone snapshots matched the
baseline; fourteen snapshots covering existing and native Codex views had no page errors. A dedicated desktop
integration task verified replies, retained app tools, steering, interruption, async question answers, image
input and queued delivery. Repeating a message receipt through the running deck returned the original result
without a second message. Command/file/permission approvals and MCP forms are covered by protocol fixtures;
they were not exercised against a real privileged action.

The follow-up passed 936 tests. Live checks verified native creation with exactly one visible user prompt,
retained app tools, rename readback in Codex, forked history, inactive-task archive/list/restore, model/effort
and task permission changes with restoration, and a latest-message edit with no duplicate on receipt retry.
Creation replay tests also cover a task started manually in the desktop before the first-send retry. UI fixtures
cover management, settings, editing, both queues, reconnect and uncertain-delivery cases on desktop/phone;
four existing home/session snapshots match the prior commit.

The final running-deck HTTP smoke also checked blank creation without a model turn, open/reconnect after
restore, loaded-task archive refusal, model-effort save/restore, and repeated create/edit/fork receipts.
All disposable verification tasks were archived afterward.
