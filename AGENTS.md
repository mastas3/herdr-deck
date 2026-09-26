# Working on herdr deck

Instructions for coding agents (and people) changing this repository. To **install** the deck for someone,
follow [AGENT_SETUP.md](AGENT_SETUP.md) instead.

## Shape

- One Bun process, **no dependencies, no build step**. Keep it that way: no `npm install`, no bundler, no framework.
- `src/server.ts` starts everything in order and wires the parts in `src/http/`: `routes.ts` (each request, in order:
  Host check, page and static files, SSE, uploads, the feature modules' routes, forwarding to another machine) and
  `api-hub.ts` / `api-connections.ts` / `api-sessions.ts` (the deck's own `/api/*`); `config.ts`, `machines.ts` (this
  deck and its remotes, hub or node), `sessions.ts`, `new-session.ts`, `chat.ts`, `files.ts`, `queue.ts`, `live.ts`
  (history, usage, sharing, proof of done), `decisions.ts`, `run-tools.ts`, `forward.ts`, `mcp-ctx.ts`, `auth.ts`,
  `page.ts`, `sse.ts`. The `create*` factories only build functions; anything that touches the disk or starts a timer
  is called from `server.ts` at its place in startup. `src/deck.ts` builds the session rows from herdr's socket
  (`src/herdr.ts`). Transcripts come from `src/agents.ts` / `src/transcript.ts` (Claude Code JSONL, Codex rollouts,
  OpenCode SQLite). `src/federation.ts` is the hub-to-node tunnel. `src/mcp.ts` is the MCP endpoint.
- `src/plugin-format.ts` (manifest validator), `src/plugin-trust.ts` (trust screen, update diff) and `src/plugins.ts`
  (staging, install, catalog) are plugins: data-only packages, never code. Built-in ones live in `plugins-catalog/`.
  The design is `docs/superpowers/specs/2026-09-26-plugins-design.md`.
- `public/` is the page: `index.html` (markup only), a service worker and a manifest. The code is `public/js/*.js`
  and the styles `public/css/*.css`, all listed in `public/assets.json` and loaded in that order: scripts as classic
  scripts sharing one global scope (`core.js` first: state, helpers, `api`; `boot.js` last of the deck's own, then
  Gallery, Library and Plugins), styles in cascade order. Code that runs at load may only use what earlier files
  define (calls inside functions are fine); a later file can take over a function by reassigning it. Put new code in
  the file for its area, or a new one in the right place in the manifest. `src/assets.ts` serves each under a content
  hash with immutable caching and the service worker keeps them the same way. Keep each file under 400 lines;
  `test/assets.test.ts` checks that, and that no two scripts declare the same top-level name.
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
