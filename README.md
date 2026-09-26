# herdr deck

A live web dashboard for everything running in [herdr](https://herdr.dev): every pane in every
herdr session, as one searchable, filterable list you can act on.

```bash
bin/install.sh          # run at login on http://127.0.0.1:4747 (launchd, auto-restart)
bin/uninstall.sh        # stop and remove the login service
bun run dev             # or run it in the foreground (DECK_PORT=4748 to use another port)
bun test
```

## Machines

Every machine with herdr can run its own deck (a node), and one deck (the hub) shows them all as tabs.

```bash
bin/deploy-node.sh my-linux-box      # copies the deck over SSH, runs it as a systemd --user (or launchd) service
```

Then list the machine in the hub's `~/.config/herdr-deck/hosts.json`:

```json
{ "self": { "id": "mac", "label": "MacBook" },
  "remotes": [{ "id": "linux", "label": "Linux · work", "ssh": "my-linux-box" }] }
```

The hub opens an SSH tunnel to each node's loopback port. It authenticates with the node's
`~/.config/herdr-deck/api.token` (file mode 600, read once over SSH), mirrors the node's event stream, and forwards actions.
Tunnels pick a free port and close when the hub exits. Remote sessions get briefs from the hub's own local model.

## Layout

```
┌ sessions ───────────┬ details ───────────────────────────────┐
│ search, filters,    │ project · title · status · dates        │
│ sort, group         │ In short (local-model brief)            │
│ rows (project-      │ How it started · latest recap           │
│ coloured)           │ images · history of asks and replies    │
├─────────────────────┴─────────────────────────────────────────┤
│ terminal: live view of the pane; click it to type into it     │
└───────────────────────────────────────────────────────────────┘
```

The list collapses (`[`) to a column of coloured squares and resizes by dragging its edge; the terminal
collapses (`]`) and resizes by dragging the bar above it. Sizes are remembered.

## Daily use

- **Inbox:** sessions sort themselves into Needs you (waiting for input or finished), Running, Quiet, Stale and Empty.
  Stale and Empty start collapsed. Empty has a "Close all" link.
- **⌘K** searches sessions on every machine, recipes, projects and commands in one place.
- **Reply** (`r`): a message box under the terminal. Enter sends it to the agent.
- **Recipes** (`.`): saved prompts. The defaults are status, run tests, review diff, commit, handoff note,
  wrap up, step back, continue and /compact, and all of them are editable. They go to the current session or to every
  selected session (⌘-click or `s`). **Standup** asks every idle agent for a one-line status.
- **Briefs** write themselves when you stay on a session for a moment (local Ollama, cached).

## The list

- A colored band shows status: working (amber), needs input (red), finished and unseen (blue), idle (green), empty (dashed grey).
- Each project gets its own color, shown in the list, in group headers and across the top of the details panel.
- Each row shows the title, project, agent, branch with changed-file count, last activity and the last output line.
- Flags: `empty`, `dup` (two panes on one conversation), `stale` (no activity for 2+ days) and `heavy` (over 1.5 GB).
- Search takes `-word`, `is:stale`, `is:dup`, `is:empty` and `agent:codex`.
- Filter by status, agent or project. Sort by what needs you, last active, newest, project, memory or context size.
  Group by project, status, agent or workspace.

## Details

- **In short**: three lines covering what the session is for, how it started and where it stands.
  A local Ollama model (`gemma4:e4b` by default; set `DECK_BRIEF_MODEL` to change it) writes them on request,
  so conversation text never leaves the Mac. Briefs are cached in `~/.config/herdr-deck/briefs/`.
- **How it started**: your first message, quoted in full.
- **Recap**: Claude's own recap (`away_summary`) when there is one, otherwise the agent's latest reply.
- **Images**: screenshots you pasted and images the agent looked at, with a full-size viewer.
- **History**: every request with the reply it got, oldest or newest first.
  It also shows compactions, total agent work time, context size, memory, spend and the resume command.

Sources: Claude `~/.claude/projects/*.jsonl`, Codex `~/.codex/sessions`, OpenCode `opencode.db`.
Transcripts are read incrementally: after the first read, only newly appended bytes are parsed.

## Terminal

The bottom panel mirrors the selected pane live, in color, fitted to the pane's width. Click it (or press `t`)
and your keystrokes go to the pane: letters, Enter, Esc, arrows, Tab, Ctrl/Alt combinations and pasted text.
Click outside or press `Ctrl+]` to stop. Buttons send common answers (esc, enter, 1/2/3, y/n) in one click.

## Starting and closing sessions

- **New** (`n`): choose Claude Code, Codex, OpenCode or a plain shell, a folder (recent folders and
  `~/Documents/Projects/*` are suggested), optional flags and an optional first message. It opens a herdr tab,
  waits for the shell prompt, starts the agent through herdr's API and sends the message. Progress appears
  as notifications, and the new session is selected as soon as its tab exists.
- **Close** works on one session or a selection. A confirmation lists what will stop, warns about anything
  still working, and shows the memory it frees.
- **Closed** keeps closed agent sessions with a **Reopen** button, which resumes them in a new tab.
- **Close candidates** selects empty sessions, the older copy of each duplicate, and anything untouched for a week.
- **Jump to pane** (`f`) switches herdr to the pane and brings WezTerm forward (set `DECK_TERMINAL` to change the app).
- **Alerts** sends a desktop notification when an agent finishes or needs input.

## How it stays fast

- One Bun process, no dependencies, no build step. It talks to herdr's Unix socket directly (≈1 ms per call).
- It subscribes to herdr's event stream and re-snapshots on change (coalesced), with a 2 s safety poll.
- The browser gets the full state inlined in the first HTML response, then row-level patches over SSE:
  only rows that changed are sent, and only those DOM nodes are touched.
- Row data comes from the head and tail of session files and is cached by size and mtime. The detail view parses
  transcripts incrementally, so an active 35 MB file costs about 1 ms after the first read (about 150 ms). OpenCode data is
  cached by `time_updated`. Fonts are bundled locally.

## On your phone (PWA over Tailscale)

`bin/install.sh` also runs `tailscale serve --bg --https=8448 http://127.0.0.1:4747`, which serves the deck on
`https://<this-mac>.<tailnet>.ts.net:8448`. That address is reachable only from your tailnet (not Funnel) and has a real certificate.
Open it on the phone, then use Add to Home Screen (iOS Safari) or Install app (Android Chrome).

- On a phone the deck has two screens. The sessions list has search and status chips across the top, with more under Filters.
  Tapping a session opens it with Story and Terminal tabs, and the system back gesture returns to the list.
- The terminal wraps lines to the screen and has a row of keys (esc, enter, ctrl+c, arrows, 1/2/3, y/n)
  and a message box that sends to the agent.
- New session opens as a full-screen sheet.
- A service worker keeps icons and fonts instant and shows a clear "your Mac isn't reachable" page when you're offline.
  Live data is never cached.
- Alerts work while the app is open. Push alerts while it's closed would need a push service.

## Safety

Binds to 127.0.0.1 only. Local requests must use a localhost `Host` header, which blocks DNS rebinding.
Requests through `tailscale serve` are accepted only when Tailscale stamps them with the machine owner's login
(`Tailscale-User-Login`; override with `DECK_TS_USERS`). Every action also needs a per-process token that only the page itself receives. The Closed list lives in
`~/.config/herdr-deck/graveyard.json`.
