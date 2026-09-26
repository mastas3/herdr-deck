# Setting up herdr deck: a guide for AI agents

You are a coding agent (Claude Code, Codex, OpenCode, or similar) and a person asked you to set up
**herdr deck** on their computer. This file tells you exactly how. Follow it in order.

The person may be completely non-technical. That changes how you work:

- **Talk plainly.** Before each step, say in one short sentence what you're about to do and why
  ("Now I'll install Bun, the small program that runs the deck."). No jargon without a few-word explanation.
- **Do the work yourself.** Run the commands; don't hand them a list to type. Ask them to act only when
  you truly can't: typing their password, clicking something in an app, or picking up their phone.
- **Ask before anything optional** (steps 7 to 10), and before anything that needs `sudo` or their password.
  Say what it's for and that it's fine to skip.
- **Never** use `tailscale funnel`, open ports to the internet, bind the deck to `0.0.0.0`, or turn off
  its access checks. The deck can control their agents, so it must stay private to them.
- **Don't guess when something fails.** Read the error, check the Troubleshooting table at the end, and
  explain what went wrong in plain words.
- **Finish** with a short summary: what's installed, the address to open, and anything you skipped.

## What it is (to tell the person, in your own words)

herdr deck is a web page that shows every AI coding agent they're running (Claude Code, Codex,
OpenCode) in one list: which are working, which need an answer, which are done. They can read each
conversation, reply, and answer the agents' questions from the page, and optionally from their phone.
The agents themselves run inside **herdr**, a terminal app made for running many agents at once. The deck
runs quietly in the background on their computer and is private to them.

## Step 1: Check the computer

Run these and note the results:

```bash
uname -s                        # Darwin = macOS, Linux = Linux. Anything else: stop, it isn't supported.
uname -m                        # arm64 / x86_64 (for your own information)
command -v git curl unzip
command -v bun herdr claude codex opencode tailscale ollama
test -S ~/.config/herdr/herdr.sock && echo "herdr server running" || echo "herdr server not running"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4747/health   # 200 means a deck is already running
```

- **Windows** (including when you're not sure): stop and tell the person herdr deck needs macOS or Linux.
  On Windows, WSL2 (Ubuntu) can work, and then you follow the Linux steps inside it.
- **A deck already answers on 4747:** it's already installed. Skip to step 6 to check it, or run the step 4
  command again to update it.

## Step 2: Make sure the basics are there

- **macOS without git:** run `xcode-select --install`. A system window appears. Ask the person to click
  **Install** and wait until it finishes (a few minutes), then carry on.
- **Linux without git, curl or unzip:** install them with the system package manager, which needs their
  password. For example: Debian/Ubuntu `sudo apt-get update && sudo apt-get install -y git curl unzip`,
  Fedora `sudo dnf install -y git curl unzip`, Arch `sudo pacman -S --needed git curl unzip`.

## Step 3: Install herdr (the terminal the agents run in)

Skip this step if `command -v herdr` found it.

- **macOS:** if Homebrew is installed (`command -v brew`), run `brew install herdr`. If there's no Homebrew,
  follow herdr's own setup guide.
- **Linux**, or anything unclear: read **https://herdr.dev/agent-guide.md** and follow its install steps.

Check it with `herdr --version`.

herdr is an interactive terminal app, so you can't start it for the person from here. Tell them:
"Open your terminal app and type `herdr`, then press Enter. That's where you'll run your AI agents from now on.
You can leave it open."

Then, so the deck can tell when agents are working or waiting, install herdr's hooks for the agents they
have (only the ones step 1 found):

```bash
herdr integration install claude     # if Claude Code is installed
herdr integration install codex      # if Codex is installed
herdr integration install opencode   # if OpenCode is installed
herdr integration status
```

If they have none of these agents yet, say so. The deck is only useful with at least one. Claude Code is at
https://claude.com/claude-code and Codex at https://developers.openai.com/codex. Offer to help install one,
but don't sign them up for anything.

## Step 4: Install the deck

Run this single command. It installs Bun if needed, downloads the deck to `~/.local/share/herdr-deck`, and
starts it as a background service that comes back after a restart:

```bash
curl -fsSL https://raw.githubusercontent.com/mastas3/herdr-deck/main/bin/bootstrap.sh | bash
```

It ends with `herdr-deck running on http://127.0.0.1:4747`. If Tailscale is set up, it also prints an
`on your tailnet: https://…` address. Keep that for step 7.

If you're working inside a clone of this repository instead, run `bin/install.sh` from its root. It does the
same thing from that folder.

## Step 5: Linux only, keep it running after logout

```bash
loginctl show-user "$USER" -p Linger
```

If that doesn't say `Linger=yes`, the deck stops whenever the person logs out. Ask: "Should the deck keep
running when you're logged out? It needs your password once." If they agree, run
`sudo loginctl enable-linger "$USER"`.

## Step 6: Check it works

```bash
curl -s http://127.0.0.1:4747/health
```

You want `{"ok":true,…}`. `"herdr":[]` in that output means the herdr server isn't running yet. That's fine
if they haven't opened herdr (step 3).

Open it for them: `open http://127.0.0.1:4747` on macOS, `xdg-open http://127.0.0.1:4747` on Linux. Tell
them to bookmark it. If herdr is running with an agent inside, it appears in the list within a second or two.
If the page says herdr isn't running, remind them to type `herdr` in a terminal.

Give them a 30-second tour in words: the list on the left (a red band means an agent is waiting for them), click
a session to read its conversation and reply at the bottom, press **n** for a new session, and **⌘K** (Ctrl+K on
Linux) searches everything.

## Optional extras

Ask about each one, briefly, and do only what they want.

### Step 7: The deck on their phone (Tailscale)

"Would you like the deck on your phone? It uses Tailscale, a free app that connects your own devices privately.
Nobody else can reach it."

1. Install Tailscale on the computer if `command -v tailscale` found nothing: macOS `brew install --cask tailscale`
   (or the Mac App Store), Linux `curl -fsSL https://tailscale.com/install.sh | sh` (needs their password).
2. Sign in: they open the Tailscale app, or you run `sudo tailscale up` on Linux, which prints a login link for
   them to open. `tailscale status` should then list this computer.
3. Linux only: `sudo tailscale set --operator="$USER"` so the deck is allowed to use `tailscale serve`.
4. Run the step 4 command again (or `~/.local/share/herdr-deck/bin/install.sh`). It now prints
   `on your tailnet: https://<computer>.<tailnet>.ts.net:8448`.
5. They install Tailscale on the phone (App Store or Google Play) and sign in with **the same account**. The
   deck only lets in the account that owns the computer.
6. They open that `https://…ts.net:8448` address on the phone. iPhone: Share → **Add to Home Screen**.
   Android Chrome: menu → **Install app**.

### Step 8: Short AI summaries of each session (Ollama, runs locally)

"The deck can write a three-line summary of each session using a small AI model that runs on your own computer,
so nothing is sent anywhere. It downloads a few GB. Want it?"

1. Install Ollama if it's missing: macOS `brew install ollama` (or the app from https://ollama.com), Linux
   `curl -fsSL https://ollama.com/install.sh | sh`.
2. Make sure it's running (`ollama list` works). On macOS with Homebrew, `brew services start ollama`.
3. `ollama pull gemma4:e4b`. To use a different model, add `DECK_BRIEF_MODEL=<model>` to
   `~/.config/herdr-deck/env` and run the install command again to restart.

### Step 9: More computers

Only if they run agents on more than one machine. Each other machine needs herdr and Bun, and this computer must
be able to `ssh <host>` into it **without a password prompt** (an SSH key). Check that with
`ssh -o BatchMode=yes <host> true`. Then:

```bash
~/.local/share/herdr-deck/bin/deploy-node.sh <host>
```

Then, in the deck, **Settings → Machines… → Add** with the same host. That connects it without a restart. Or
add it to `~/.config/herdr-deck/hosts.json` by hand (the README shows the format) and restart. Setting up SSH
keys from scratch is its own task. Explain it and do it only if they want.

### Step 10: Let their agents use the deck (MCP)

The deck is also an MCP server, so their agents can list sessions, search history and message each other. If
they use Claude Code and want this:

```bash
claude mcp add --scope user --transport http herdr-deck http://127.0.0.1:4747/mcp \
  --header "Authorization: Bearer $(cat ~/.config/herdr-deck/mcp.token)"
```

For other agents, the deck's Connections view (⌘K → Connections) shows the address and token. The token is a
secret. Don't paste it anywhere but the agent's own config.

## Settings

Settings go in `~/.config/herdr-deck/env`, one `NAME=value` per line. Run the install command again after
editing to restart. The README lists them all. The one people most often want on macOS is
`DECK_TERMINAL=<app>` (for example `Ghostty`, `iTerm`, `Terminal`), the app that **Jump to pane** brings
forward. The default is WezTerm.

## Updating and removing

- **Update:** run the step 4 command again.
- **Remove:** `~/.local/share/herdr-deck/bin/uninstall.sh` stops it and removes the service and the tailnet
  address. Their data stays in `~/.config/herdr-deck/`. Delete that folder and `~/.local/share/herdr-deck`
  to remove everything.

## Troubleshooting

| What you see | What to do |
|---|---|
| `bun: command not found` after installing | Bun lives in `~/.bun/bin`. Run `export PATH="$HOME/.bun/bin:$PATH"` or open a new terminal |
| The installer says `service installed but not answering yet` | Read the log. macOS: `tail -50 ~/Library/Logs/herdr-deck.log`. Linux: `journalctl --user -u herdr-deck -n 50`. Another program may use port 4747 (`lsof -i :4747`). Then install on another port: `DECK_PORT=4800 ~/.local/share/herdr-deck/bin/install.sh` |
| Linux: `Failed to connect to bus` from systemctl | No user session bus, common over plain SSH or in containers. Log in on the machine directly, or run `sudo loginctl enable-linger $USER` and reconnect. As a last resort run it in the foreground: `bun ~/.local/share/herdr-deck/src/server.ts` |
| The page loads but the list is empty | herdr isn't running (`herdr status`), or no agent has been started inside herdr yet |
| Every session says idle, even busy ones | Step 3's `herdr integration install …`, then restart those agents |
| The phone shows "forbidden host" or won't load | The phone must be on Tailscale with the same account as the computer. Check `tailscale serve status` shows port 8448 |
| `couldn't run 'tailscale serve'` on Linux | `sudo tailscale set --operator=$USER`, then run the installer again |
| `… already exists and isn't a git checkout` | Something else is in `~/.local/share/herdr-deck`. Look at it with the person before moving it, or install elsewhere with `DECK_DIR=~/herdr-deck` |
| `has local changes` when updating | Someone edited the installed copy. Show the person `git -C ~/.local/share/herdr-deck status` and ask before discarding anything |
