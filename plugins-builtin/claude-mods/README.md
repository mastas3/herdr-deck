# Claude Mods in the deck

Open **Plugins → Claude Mods** for each machine's configured plugins, or a live Claude session's **Mods** inspector for commands and native UI controls. New session offers a **Claude profile** choice.

Mods execute in Claude Code, so their guards and hooks work in herdr without a second implementation. The deck reads plugin manifests and `hooks.json` modules; it never imports mod code. It shows marketplace installations and `CLAUDE_CODE_PLUGIN_DIRS` entries, including ordinary plugins. A configured plugin is not proof that an existing session loaded it: use `/plugin` to check and manage plugins, then `/reload-plugins` to apply changes.

- **status-now**: `/progress` opens its text output in the screen.
- **context-keeper**: live `ctx`, `cache`, `stall` metadata follows the pane into list/board badges and the Mods inspector. `/handoff-compact` runs in that same session.
- **next-steps**: `/next` requests suggestions. Press **Focus mod buttons**, then the letter shown beside the suggestion. This sends Claude's Ctrl+X, Tab focus sequence and its native hotkeys.
- **fable-guard** and **fast-jev-compaction**: keep executing in Claude. Inventory reports their configuration; the deck does not bypass their rules.
- **tailnet-link**: `/links` is available when the mod is configured for the session's profile. Installation, operator permissions and port sharing remain with the existing mod.
- **Other mods**: literal command registrations in their hooks module are offered automatically. Dynamic commands, plugin settings, dialogs, and additional keyboard controls are available in the full terminal. Graphics and mouse-only widgets need the native terminal; there is no universal conversion from Claude's mod UI to chat cards.

Commands wait for an idle session. Mod controls can answer the current UI during a turn; requests carry the conversation ID so a replaced pane occupant cannot receive an old click. Merely viewing the panel sends no command. The screen polls only while the inspector is open. Disable this deck plugin in **Plugins → Built in** to remove its UI, routes and polling; Claude's installed mods continue running.

## Profiles

The core reads `~/.claude`, `CLAUDE_CONFIG_DIR`, and `.claude-*` folders containing a projects store or installed-plugin registry. Backups and lookalike tool folders are excluded. `DECK_CLAUDE_CONFIG_DIRS` accepts additional colon-separated directories. Symlinked stores are deduplicated. No credential files are read.

Launching passes only the chosen `CLAUDE_CONFIG_DIR` through herdr's `tab.create.env`, supported by the verified Linux herdr 0.7.5 schema. Transcript lookup, history indexing, context-window caches and resume commands retain the profile. Each machine discovers its own paths; the hub forwards actions to that machine. Older/offline nodes show an actionable error instead of executing locally.

## Validation

`bun test test/claude-profiles.test.ts plugins-builtin/claude-mods` exercises profile lookup, privacy, command discovery, remote routing and stale-session protection. `bin/ui-snapshot.mjs --views claude-mods,claude-mods-session,claude-mods-controls,claude-mods-new` checks desktop and phone UI against synthetic state. The `claude-mods-off` view is for a run with `--plugins-off claude-mods`.
