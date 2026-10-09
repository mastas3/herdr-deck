# Validation — 2026-10-08

- `bun test`: **1,380 passed**, zero failures, 146 files (55.52 seconds).
- `bun test plugins-builtin/terminals test/assets.test.ts test/plugin-guards.test.ts`: **27 passed**.
- `node bin/ui-terminals-journey.mjs`: **18 desktop + 17 phone checks passed**, plus the disabled-plugin check.
  Real scratch shells; direct typing (desktop), Unicode, Ctrl+C before Send, draft preservation, keep/detach,
  browser reload, deck restart, simulated read failures/reconnection, explicit end, temporary close,
  navigation and delayed-open cleanup, no agent-session actions, no page overflow/errors.
- `node bin/ui-snapshot.mjs --out /tmp/deck-terminals-snapshot --views terminals --port 4772`:
  desktop and phone both had zero page errors and zero blocked mutations.
- Isolated Linux SSH/tmux check: real PTY, retained environment after detach/reconnect, complete cleanup.
  One sampled remote read took 313 ms; this is not a latency guarantee.
- Live authenticated API checks passed on **MacBook** and **Linux · work**: open, input, keep, release,
  reconnect with retained shell environment, close. Only new verification shells were used and all were removed.
- Live tokenless POST returned **403**. The existing tailnet `/terminals` page returned **200**.
- Plugin enabled in the existing launchd deck; no Tailscale route changes or node deployments.

Browser screenshots and machine-readable journey evidence are produced in `/tmp/deck-terminal-ui` by the harness.
Physical phones/PWAs were not tested. Kept terminals do not survive a machine reboot or tmux-server termination.

## Cmd+K correction — 2026-10-08

- Open terminal is an everyday command in Cmd+K. It follows the machine filter: All machines asks, a specific
  computer opens directly, and Codex app uses its local host. The selected agent row never overrides the filter.
- The command opens a bottom terminal panel over the current view. Navigation keeps it open; close disposes
  temporary shells, and Keep/Detach preserves them. The management page is secondary, under Saved terminals.
- Full repository suite: **1,383 passed**, zero failures, 147 files. Scope-selection tests cover All machines,
  a different selected agent, local/remote/offline hosts, the app filter and a removed host.
- The browser harness now covers Cmd+K itself, machine search/selection, cancel, direct scoped launch, retained
  view/filter, navigation with the drawer open, Keep/Detach, and cancelling a slow panel launch. Its virtual
  second-machine fixture records the requested target before forwarding to an isolated local PTY.
- Final browser run: **30 desktop + 29 phone checks passed**, plus plugin-off verification. Repeated immediate
  close/open is covered; the picker is removed as soon as a choice is made.
- After deployment, the actual Cmd+K flow passed against the live MacBook and Linux connections. All machines
  displayed the picker, specific scopes launched directly, and the current view stayed intact. All verification
  terminals were closed; no agent messages were sent.
