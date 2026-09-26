# Working on herdr deck

Instructions for coding agents (and people) changing this repository. To **install** the deck for someone,
follow [AGENT_SETUP.md](AGENT_SETUP.md) instead.

## Shape

- One Bun process, **no dependencies, no build step**. Keep it that way: no `npm install`, no bundler, no framework.
- `src/server.ts` is the HTTP server, SSE and API routes. `src/deck.ts` builds the session rows from herdr's socket
  (`src/herdr.ts`). Transcripts come from `src/agents.ts` / `src/transcript.ts` (Claude Code JSONL, Codex rollouts,
  OpenCode SQLite). `src/federation.ts` is the hub-to-node tunnel. `src/mcp.ts` is the MCP endpoint.
- `src/plugin-format.ts` (manifest validator), `src/plugin-trust.ts` (trust screen, update diff) and `src/plugins.ts`
  (staging, install, catalog) are plugins: data-only packages, never code. Built-in ones live in `plugins-catalog/`.
  The design is `docs/superpowers/specs/2026-09-26-plugins-design.md`.
- `public/` is the page: vanilla JS (`app.js`) and CSS in `index.html`, a service worker and a manifest.
- `bin/` holds the install scripts: `bootstrap.sh` (one-line install), `install.sh` (the launchd or systemd
  service), `deploy-node.sh` (another machine over SSH) and `uninstall.sh`.
- Data lives in `~/.config/herdr-deck/`. Never write elsewhere in the user's home without a clear reason.

## Rules

- Run `bun test` before you commit. Add a test in `test/` for logic you change (parsers, row building, ordering).
- The server caches the HTML at startup. After UI edits, restart the running deck (`bin/install.sh`) or use
  `bun run dev`.
- Keep it fast: the first page load has all state inlined, transcripts are parsed incrementally, and nothing blocks
  the event loop (cache SQLite reads, spawn slow work).
- Keep it private: bind to `127.0.0.1` only, keep the Host check, the per-process action token, and the Tailscale
  login check. Never add `tailscale funnel`. Anything sent off the machine must be opt-in and scrubbed.
- Match the surrounding code: short, direct comments that explain *why*, and plain-English UI text.
- Must work on macOS and Linux. Guard platform-specific calls (`open`, `launchctl`, app paths).
