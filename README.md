# herdr deck

A live web dashboard for everything running in [herdr](https://herdr.dev): every pane in every
herdr session, as one searchable, filterable list you can act on.

```bash
bin/install.sh          # run at login on http://127.0.0.1:4747 (launchd, auto-restart)
bin/uninstall.sh        # stop and remove the login service
bun run dev             # or run it in the foreground (DECK_PORT=4748 to use another port)
bun test
```

## What each row shows

- **Status band**: working (amber), needs input (red), finished and unseen (blue), idle (green), empty (dashed grey).
- **Title**: the agent's own session title (terminal title, OpenCode session title, or the first request).
- **Project, git branch, uncommitted file count, model, herdr tab**.
- **Dates**: last activity and conversation start, read from the agent's own session store
  (Claude `~/.claude/projects/*.jsonl`, Codex `~/.codex/sessions`, OpenCode `opencode.db`);
  process start time from `ps`. Hover for exact timestamps.
- **Memory** for the pane's whole process tree (agents drag in MCP servers and dev servers), and **context size**.
- **Last output**: the pane's recent terminal lines with agent chrome stripped.
- Flags: `empty` (bare shell, or an agent with no conversation), `duplicate` (two panes on the same conversation),
  `stale` (no activity for 2+ days), `heavy` (over 1.5 GB).

## Doing things

- Click a row for the detail panel: live terminal output (ANSI colour), every date, first request and last reply,
  resume command, key buttons (Esc, Enter, Ctrl+C, 1/2/3, y/n) for answering prompts, and a box to message the agent.
- **Close** any pane or a whole selection. A confirmation lists what will stop, flags anything still working,
  and shows the memory it frees. If the pane is the only one in its tab, the tab closes.
- **Closed** keeps every closed agent session with a **Reopen** button: it opens a new herdr tab in the same folder,
  waits for the shell prompt, then runs `claude --resume …` / `codex resume …` / `opencode -s …`.
- **Select close candidates** picks empty panes, the older copy of duplicates, and anything untouched for a week.
- **Jump to pane** focuses it in herdr and brings WezTerm forward (`DECK_TERMINAL` to change the app).
- **Alerts** sends a desktop notification when an agent finishes or needs input; the tab title shows the count.
- Keyboard: `/` search, `j`/`k` move, `Enter` detail, `f` jump, `x` close, `s` select, `a` select all shown,
  `p` message, `1`–`4` status filters, `c` closed list, `Esc` clear. Search takes `-word`, `is:stale`,
  `is:dup`, `is:empty`, `agent:codex`.

## How it stays fast

- One Bun process, no dependencies, no build step. It talks to herdr's Unix socket directly (≈1 ms per call).
- It subscribes to herdr's event stream and re-snapshots on change (coalesced), with a 2 s safety poll.
- The browser gets the full state inlined in the first HTML response, then row-level patches over SSE:
  only rows that changed are sent, and only those DOM nodes are touched.
- Session files are parsed from their head and tail only, and cached by size and mtime; OpenCode rows are
  cached by `time_updated`. Fonts are bundled locally.

## Safety

Binds to 127.0.0.1 only. Requests with any other `Host` header are refused (DNS rebinding), and every action
needs a per-process token that only the page itself receives. The Closed list lives in
`~/.config/herdr-deck/graveyard.json`.
