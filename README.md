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

Or do it from the deck: **Settings → Machines…** lists every machine, adds one by SSH host (it runs the same
install and connects without a restart), renames or removes one (removing only stops watching it).
By hand, list the machine in the hub's `~/.config/herdr-deck/hosts.json`:

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
- **⌘K** searches sessions on every machine, tools, views, projects and commands in one place.
- **Reply** (`r`): the message box under the chat. Enter sends it to the agent. Attach files with the paperclip,
  by dropping them on the chat, or by pasting; they're saved on the session's machine and the agent gets the paths.
- **Send** always delivers right away, even while the agent works (Claude Code takes it at its next step,
  Codex steers with it). To hold a message until the turn is over instead, press ⌥Enter: the hub keeps it
  (shown above the box, where you can edit, send now or drop it) and sends it when the agent finishes.
  Held messages live in `~/.config/herdr-deck/queue.json`.
- **Long pastes** (over 4,000 characters or 40 lines) become a chip instead of a wall of text. On send each
  one is saved as a file next to the session and the agent gets the path; preview it, put it back inline, or
  remove it first. Anything over 12,000 characters travels the same way.
- **`/` commands:** type `/` for the session's own commands: Claude Code's built-ins (read from the installed
  binary, so they match your version), your commands, project commands, plugin commands and skills; Codex and
  OpenCode built-ins and custom prompts. Arrows to move, Tab to insert, Enter to run. Deck tools are listed too.
- **Answer in the list:** when an agent is waiting on you (a permission prompt, Claude's "trust this folder?",
  or a question with options), a card under its row shows the question and one-tap answers, like Claude on
  the web and phone. Prompts are read from the pane's live screen.
- **Right-click** a session (or hold it on a phone): open, rename, message, jump, new session in its project, copy link, select, close.
- **Rename** (`e`, or ⋯ → Rename): renames the herdr pane (and the tab when the pane has it to itself), the
  herdr agent name, and runs `/rename` in Claude Code or Codex so their own history shows it (queued if busy).
- **Status line** above the message box: project, context used, and the plan limits for that agent
  (Claude 5-hour and weekly from `~/.claude/rate-cache.json`, written by the Claude status line script;
  Codex limits from its session files).
- **Tools** (`.`, or the ⚡ Tools button next to the message box): one click that makes the agent, or the deck, do something:
  check my email for context, related past work (from History), attach files, handoff → compact (writes a
  handoff note to `~/.config/herdr-deck/handoffs/`, waits, then compacts around it), status line, step back,
  update the wiki, write a handoff note, verify it's done, run the tests, review your diff, Tailscale link,
  show me what you built. Add your own in the Tools view. **Standup** asks every idle agent for a status line.
- **Briefs** write themselves when you stay on a session for a moment (local Ollama, cached).

## Views (top of the list)

- **Inbox** (`i`): every session waiting on you, reduced to the decision. Permission prompts (numbered or
  cursor menus) answer with one tap; a question with options shows the options; "done" gets **Looks good**,
  **Send back**, **Verify now**. Filters: quick ones, permissions, questions, done.
  - **Jev** (TypeSafe, via your `jev` CLI and its receipts) suggests which option you'd pick, whether a
    decision is low-stakes, and how likely a "done" really is. It never answers for you. What you actually did
    is recorded with `jev outcome`, however you answered (inbox, keys, the list and board cards, or a reply
    typed in the session). Each request is asked once: the answer is cached by a fingerprint of what's sent
    (`~/.config/herdr-deck/jev-cache.json`), so redraws, rebuilds and restarts don't ask again. The **Jev**
    button in the Inbox header opens a panel read from `~/.jev/receipts.jsonl`: calls, tokens and cost
    (today, 7 days, all time; $0.042 per million input tokens), how often Jev's pick matched what you did by
    kind, calibration, the last ten decisions, and the daily cap. TypeSafe has no daily limit (1,200
    requests/min); the deck caps its own calls (default 1000 a day, about $0.05; set it in the panel, saved to
    `~/.config/herdr-deck/jev-settings.json`, or `DECK_JEV_DAILY` before you do).
  - **Proof of done:** when an agent says it's done, the deck re-runs the project's own checks (detected from
    package.json, Cargo, go.mod, pytest, Makefile). You approve the command once per project, or turn it off.
    Results show on the row and in the Inbox. Stored in `~/.config/herdr-deck/checks.json`.
- **History** (`h`): every past Claude Code and Codex conversation on every machine, full-text searchable.
  Open one to read the whole chat, jump to the match, and **Resume** it in a new herdr tab. Each machine
  indexes its own transcripts into `~/.config/herdr-deck/history.db` (SQLite FTS5), in a short-lived child
  process that re-scans every minute.
- Every view has a ✕ (and Esc) to get back to the session.
- **Tools** (Tools menu → Manage tools): what every tool does and exactly what it sends; add, edit and delete your own.
- **Connections** (Tools menu → Connections, or ⌘K): what each machine can reach, as cards: services
  (GitHub, Vercel, Netlify, Cloudflare, Supabase… however they're reached: a CLI, `npx`, an app, an MCP
  server or an API key name), AI agents and plans, MCP servers from every agent app, SSH hosts, API key names
  (never values), dev tools, browsers, skills, and your own additions. Each card says what it's for and how
  agents should use it (editable). Pick some and **Add to** the session: the agent gets them as context.
  Each machine writes the full list to `~/.config/herdr-deck/CONNECTIONS.md`. Hide what you don't need;
  your notes and additions live in `~/.config/herdr-deck/connections.json`.
- **Discover** (`d`, or ⌘K): repos worth forking and ideas worth building.
  - **For you:** your interests, read from the wiki (project tags, status and recency, concepts, the last month
    of `log.md`), your local repos (languages, keywords, dependencies) and your connections, as chips you can
    add to or remove. For each one the deck searches GitHub with `gh` for hidden gems: 30–5,000 stars, pushed in
    the last six months, licensed, not archived or a fork, not yours or already cloned. They're ranked by fit ×
    momentum (stars a month), and each card says which interest and projects it fits. **Fork & explore** opens the
    New session dialog with a prompt to clone it and judge how to build on it; Save and Dismiss are remembered.
    A **Trending in your areas** row shows new repos climbing fast. Results are cached for hours
    (`~/.config/herdr-deck/discover-cache.json`), refreshed in the background, and marked when stale.
  - **Idea lab:** describe any idea. Enter searches GitHub for its building blocks (grouped by the role each
    could play) and topics, and shows which of your projects and connections fit. **Research & plan it** opens a
    new Claude Code session, prefilled, that researches what exists and writes a plan (architecture, the exact
    repos and services, build order, costs and risks, first three tasks) to `~/.config/herdr-deck/ideas/<slug>.md`.
    **Sparks** are "what if" ideas combined from your interests, projects, connections and gems.
  - **Ideas:** the plans, rendered, with the session that wrote them and **Start building**.
  - Only interest keywords and the words of your idea go to GitHub. Nothing starts until you confirm the
    dialog. Your chips, saves and dismissals live in `~/.config/herdr-deck/discover.json`.
- **Simple mode** (Settings, or ⌘K): big type, only the essentials (no terminal, tool calls, meters or
  tabs), friendly status words, and cheerful colors tuned for every theme.
- **Themes:** System, Harbor, Light, Midnight, Nord, Solarized, Paper, High contrast, Dracula, Catppuccin
  Mocha and Latte, Tokyo Night, Gruvbox, Rosé Pine, Everforest, One Dark, GitHub Light, Monokai.

## MCP server

Agents can use the deck: `POST http://127.0.0.1:4747/mcp` (streamable HTTP), with a bearer token from
`~/.config/herdr-deck/mcp.token`. Tools: `deck_sessions`, `deck_session`, `deck_search`, `deck_history`,
`deck_decisions`, `deck_connections`, `deck_send`, `deck_start`. Closing is not offered; `deck_start` can't ask
for skip-permission modes; every send and start is logged to `~/.config/herdr-deck/mcp-audit.jsonl` and shown
in the deck. The Connections view has the `claude mcp add` command.

## Dev servers and tailnet links

The deck sees which ports each session's processes listen on (and servers started from its project folder),
and shows them in the session header. **Share** puts one on your tailnet with `tailscale serve` (never Funnel)
and opens the link.

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
The MCP token only works on `/mcp`, which can't close anything. Jev gets trimmed recent output with home paths,
emails and anything key-like scrubbed (and the `jev` CLI redacts again).
