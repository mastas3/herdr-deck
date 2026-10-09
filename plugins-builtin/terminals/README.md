# Terminals

Press **Cmd+K → Open terminal**. In **All machines**, a searchable quick picker asks which machine; in a specific
machine view, the shell opens there immediately. The current machine filter, rather than the selected agent row,
determines the target. The Codex app filter uses its local computer. The terminal opens in a bottom panel without
changing your current view. **Cmd+K → Terminals: saved terminals** (or Settings → Saved terminals) opens the
management page for reconnecting to kept shells.

This does not create an agent session or a herdr pane. The desktop output accepts typing/paste; the command box
and key row also work on a phone. Ctrl+C interrupts a command, Tab and arrows work at the shell prompt.

- **Temporary** is the default. Close terminal, switching terminals or closing the page ends it. A terminal in
  the bottom panel stays open as you navigate the deck; an inline terminal on the management page closes when
  you leave that page.
- A lost connection leaves a **five-minute reconnect window**, followed by cleanup (checked every 30 seconds).
  The watchdog runs with tmux, so cleanup still works if the deck crashes. Backgrounding a mobile browser can
  eventually expire a temporary shell; keep a terminal before leaving long-running work unattended.
- **Keep terminal** preserves the shell, working directory, environment and scrollback. Rename it if useful.
  **Detach** leaves it running; choose its name in Terminals to reconnect, including from another device.
- **End** explicitly stops a kept terminal after confirmation. Kept terminals survive browser/deck restarts,
  but not machine reboots, shell exit, or terminating their tmux server. Switching off the plugin preserves them;
  switch it on again to reconnect. Temporary terminals are cleaned up when the plugin stops.

## Implementation

Switchable hub code plugin; no package dependencies or build step. Requires the existing `tmux` executable on each
target machine. Supported platforms: macOS/Linux. Missing tmux produces an actionable message and installs nothing.
The machine list comes from the deck's configured computers; the Codex app pseudo-machine is excluded. Remote
shells use each configured SSH destination, with batch authentication and bounded connect/command timeouts. No
remote deck update is required. No new network listener, tunnel, cloud service or agent call is introduced.

Each hub's data-directory hash names a dedicated tmux server (`deck-term-<hash>`), started with `/dev/null` config.
It does not attach to existing tmux servers. IDs are validated UUIDs. Kept/title/lease metadata lives in session
options; the shell's own tmux state supplies history. The browser reads the last 500 lines once a second when
visible; hidden pages do not renew the temporary lease. This is a text terminal with ANSI colors, matching the
deck's existing terminal; mouse-driven terminal apps are not supported.

All operations use POST `/api/terminals` behind the normal Host, Tailscale-owner and action-token checks. Remote
commands use shell-quoted fixed argv, and input uses hex bytes so text cannot become a tmux command separator.
Input is validated before sending, serialized, bounded, and never automatically retried. There are at most 12
terminals per machine. Opening is idempotent for the browser-generated ID. No output is written to deck logs or
agent transcripts; the interactive shell may still use its normal history file.

## Validation

```sh
bun test
node bin/ui-terminals-journey.mjs /tmp/deck-terminal-ui
node bin/ui-snapshot.mjs --out /tmp/deck-terminals-snapshot --views terminals
```

The browser journey starts a scratch deck/HOME and isolated tmux server, exercises real shells on desktop/phone
viewports, and checks authentication, command/Unicode input, Ctrl+C, drafts, keep/detach, reload, deck restart,
lost connections, explicit end, temporary cleanup, navigation races, no new agent sessions, overflow and errors.
It also checks that switching the plugin off removes its view and makes no terminal requests. Real PTY unit tests
skip when tmux is absent; other tests still run. Physical mobile keyboard/PWA behavior needs device verification.

Transport behavior follows the [tmux manual](https://man.openbsd.org/tmux).
