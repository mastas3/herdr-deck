# Codex support

The deck supports both herdr's Codex CLI sessions and local Codex desktop threads. CLI sessions use the normal
herdr message, steering, queue and terminal controls. Desktop threads have the same transcript and project
inspection features; desktop actions currently consist of opening the thread and hiding it from the deck.

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

## Remaining desktop control gap

On 2026-09-28, read-only inspection of the installed desktop bundle showed a private, versioned local IPC
interface for owner discovery and follower start, steer, interrupt and compact operations. Initializing the
same-user socket succeeded, but owner discovery returned `no-client-found` for the active deck task and three
other recent local threads. A stream subscription also produced no snapshot. No prompts or interrupts were
sent, and no private IPC integration is shipped on the strength of those probes.

Full desktop parity needs a working supported control connection to the existing owner, with tests for owner
loss, ambiguous delivery, permission prompts and app version changes. Resuming into a separate CLI is an explicit
user action; the deck refuses it while the app row is working or blocked. The CLI/app may impose additional
writer ownership restrictions even while a thread is idle.

## Checks

`bun test test/codex-parity.test.ts test/v8.test.ts` covers lifecycle, partial writes, old and current indexes,
archive filtering, child membership, injected setup, nested tools and the busy-resume guard. The normal full
suite remains `bun test`. `bin/ui-snapshot.mjs --views codex-session,codex-menu` exercises the desktop/phone
views with synthetic data; it sends no messages to real agents.
