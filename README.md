# herdr deck

**One live screen for every AI coding agent you're running.** Claude Code, Codex and OpenCode sessions
in [herdr](https://herdr.dev), on this computer and your others, as one list you can triage, answer and
steer, from your desk or your phone.

- See at a glance which agents are working, which are waiting on you, and which finished.
- Open any session as a chat: read the whole conversation, answer permission prompts with one tap, send
  messages, attach files, or type straight into its terminal.
- Start, rename, close and resume sessions. Search every past conversation.
- Install it on your phone as an app (over [Tailscale](https://tailscale.com), private to you).
- Watch several machines from one deck.

It's a single [Bun](https://bun.sh) process with no dependencies and no build step. It reads only local
files and herdr's socket, and it listens only on `127.0.0.1`.

## Install

You need **macOS or Linux** and **[herdr](https://herdr.dev)** (`brew install herdr`), where your agents run.
Then paste this into a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/mastas3/herdr-deck/main/bin/bootstrap.sh | bash
```

That installs Bun if you don't have it, puts the deck in `~/.local/share/herdr-deck`, and starts it as a
login service (launchd on macOS, `systemd --user` on Linux) so it's always there. Open
**http://127.0.0.1:4747**. Run the same line again to update.

### Or let your AI agent set it up

New to all this? Paste this to Claude Code, Codex, or any coding agent that can run commands on your computer:

```text
Set up herdr deck on this computer for me. Follow the guide at
https://raw.githubusercontent.com/mastas3/herdr-deck/main/AGENT_SETUP.md step by step.
I'm not technical, so explain what you're doing in plain words and ask me before anything optional.
```

The guide ([AGENT_SETUP.md](AGENT_SETUP.md)) walks the agent through checking your computer, installing
what's missing, starting the deck, and the optional extras: the phone app, more machines, local AI summaries.

### From a clone

```bash
git clone https://github.com/mastas3/herdr-deck.git && cd herdr-deck
bin/install.sh          # run it as a login service on http://127.0.0.1:4747 (restarts it if it's running)
bin/uninstall.sh        # stop it and remove the service (your data in ~/.config/herdr-deck stays)
bun run dev             # or run it in the foreground with reload (DECK_PORT=4748 to use another port)
bun test
```

## What you need

| | Needed? | What for |
|---|---|---|
| macOS or Linux | yes | Windows isn't supported (herdr doesn't run there either) |
| [herdr](https://herdr.dev) | yes | The terminal your agents run in. The deck reads its socket at `~/.config/herdr/herdr.sock`. For accurate working/waiting status, run `herdr integration install claude` (and `codex`, `opencode`) |
| [Bun](https://bun.sh) 1.2+ | yes | Runs the deck. The installer gets it for you |
| Claude Code, Codex or OpenCode | at least one | The agents the deck shows. Their transcripts are read from `~/.claude`, `~/.codex` and OpenCode's database. Codex desktop app threads show up too |
| [Tailscale](https://tailscale.com) | optional | The phone app and reaching the deck from your other devices, privately |
| [Ollama](https://ollama.com) | optional | Three-line session summaries written by a local model (`ollama pull gemma4:e4b`) |
| SSH access to other machines | optional | Watching more than one machine from one deck |

## On your phone (PWA over Tailscale)

When Tailscale is running, the installer also runs `tailscale serve --bg --https=8448 http://127.0.0.1:4747`,
which serves the deck on `https://<this-computer>.<tailnet>.ts.net:8448`. That address is reachable only from
your own tailnet (never Funnel, never the public internet) and has a real certificate. Open it on the phone,
then use **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

On Linux, `tailscale serve` needs permission once: `sudo tailscale set --operator=$USER`, then run
`bin/install.sh` again.

- On a phone the deck has two screens. The sessions list has search and status chips across the top, with more under Filters.
  Tapping a session opens it with Story and Terminal tabs, and the system back gesture returns to the list.
- The terminal wraps lines to the screen and has a row of keys (esc, enter, ctrl+c, arrows, 1/2/3, y/n)
  and a message box that sends to the agent.
- A service worker keeps icons and fonts instant and shows a clear "your computer isn't reachable" page when
  you're offline. Live data is never cached.
- Alerts work while the app is open. Push alerts while it's closed would need a push service.

## More machines

Every machine with herdr can run its own deck (a node), and one deck (the hub) shows them all as tabs.

```bash
bin/deploy-node.sh my-linux-box      # copies the deck over SSH, runs it as a systemd --user (or launchd) service
```

The other machine needs Bun installed, and `my-linux-box` must be a host you can `ssh` into without a
password prompt (a key in `~/.ssh/config`). Or do it from the deck: **Settings → Machines…** lists every
machine, adds one by SSH host (it runs the same install and connects without a restart), renames or removes
one (removing only stops watching it). By hand, list the machine in the hub's `~/.config/herdr-deck/hosts.json`:

```json
{ "self": { "id": "laptop", "label": "My laptop" },
  "remotes": [{ "id": "linux", "label": "Linux box", "ssh": "my-linux-box" }] }
```

The hub opens an SSH tunnel to each node's loopback port. It authenticates with the node's
`~/.config/herdr-deck/api.token` (file mode 600, read once over SSH), mirrors the node's event stream, and forwards actions.
Tunnels pick a free port and close when the hub exits. Remote sessions get briefs from the hub's own local model.

## Settings

Put settings in `~/.config/herdr-deck/env`, one `NAME=value` per line, then restart the deck
(`bin/install.sh` again). All of them are optional.

| Setting | Default | What it does |
|---|---|---|
| `DECK_BRIEF_MODEL` | `gemma4:e4b` | Ollama model that writes the session summaries |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where Ollama runs |
| `DECK_PROJECT_DIRS` | `~/Documents/Projects:~/Projects:~/code:…` | Folders (colon-separated) that hold your projects; used for project names and the New session folder list |
| `DECK_TERMINAL` | `WezTerm` | macOS app that **Jump to pane** brings forward (for example `Ghostty`, `iTerm`, `Terminal`) |
| `DECK_HUB_DIR` | `~/wiki` if it exists, else `~` | Folder for deck-started planning sessions |
| `DECK_WIKI_DIR` | `~/wiki` | Where `[[page]]` links in agent replies point, if you keep a Markdown wiki |
| `DECK_TS_USERS` | this machine's Tailscale owner | Comma-separated Tailscale logins allowed in through the tailnet |
| `DECK_CODEX_APP_DAYS` | `3` | How many days of Codex desktop app threads to show |
| `DECK_NO_HISTORY` | | Set to `1` to turn off the History index |
| `DECK_CHECK_TIMEOUT_MS` | `600000` | Time limit for "proof of done" checks |

These are set when you install instead, as `DECK_PORT=4800 bin/install.sh`:

| Setting | Default | What it does |
|---|---|---|
| `DECK_PORT` | `4747` | Loopback port |
| `DECK_TS_PORT` | `8448` | Tailnet HTTPS port |
| `DECK_PUBLIC_URL` | the tailnet address | Base address for shareable session links |
| `DECK_NO_TAILSCALE` | | Set to `1` to leave Tailscale alone |

Everything the deck keeps (closed sessions, held messages, briefs, tools, the History index, tokens) lives in
`~/.config/herdr-deck/`.

## Troubleshooting

- **The page is empty and says herdr isn't running.** Open a terminal and run `herdr`, then start your agents
  inside it. `herdr status` should say `server: running`.
- **Sessions show but the status is always idle.** Install herdr's agent hooks: `herdr integration install claude`
  (and `codex` / `opencode`), then restart those agents.
- **http://127.0.0.1:4747 doesn't open.** Check `curl http://127.0.0.1:4747/health`. Logs: macOS
  `~/Library/Logs/herdr-deck.log`, Linux `journalctl --user -u herdr-deck -n 50`. Run `bin/install.sh` again
  to restart it.
- **Linux: the deck stops when I log out.** Run `sudo loginctl enable-linger $USER` once.
- **The phone link says "forbidden host".** The deck only lets in the Tailscale account that owns the computer.
  Sign the phone into the same account, or add the phone's login to `DECK_TS_USERS`.
- **Summaries never appear.** They need Ollama running with the model pulled: `ollama pull gemma4:e4b`.

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
  - **Jev** (optional and hidden unless a `jev` CLI with a TypeSafe API key is installed) suggests which option you'd pick, whether a
    decision is low-stakes, and how likely a "done" really is. It never answers for you. What you actually did
    is recorded with `jev outcome`. TypeSafe has no daily limit (1,200 requests/min); the deck caps its own calls at `DECK_JEV_DAILY` a day (default 1000, about $0.08).
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
  so conversation text never leaves your computer. Briefs are cached in `~/.config/herdr-deck/briefs/`.
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
  your project folders are suggested; see `DECK_PROJECT_DIRS`), optional flags and an optional first message. It opens a herdr tab,
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

## Security

Binds to 127.0.0.1 only. Local requests must use a localhost `Host` header, which blocks DNS rebinding.
Requests through `tailscale serve` are accepted only when Tailscale stamps them with the machine owner's login
(`Tailscale-User-Login`; override with `DECK_TS_USERS`). Every action also needs a per-process token that only the page itself receives. The Closed list lives in
`~/.config/herdr-deck/graveyard.json`.
The MCP token only works on `/mcp`, which can't close anything. Jev gets trimmed recent output with home paths,
emails and anything key-like scrubbed (and the `jev` CLI redacts again).

Found a security problem? Please report it privately; see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. The code is plain TypeScript run by Bun with no dependencies and no
build step: `src/` is the server, `public/` is the page. `bun run dev` runs it with reload and `bun test` runs
the tests. [AGENTS.md](AGENTS.md) has the conventions (it's also what coding agents read).

## License

[MIT](LICENSE)
