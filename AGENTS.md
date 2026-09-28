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
  (staging, install, catalog) are **data plugins**: data-only packages, never code. Built-in ones live in
  `plugins-catalog/`. The design is `docs/superpowers/specs/2026-09-26-plugins-design.md`.
- **Code plugins** are the deck's extras: `plugins-builtin/<id>/` (see "Code plugins" below). The host is
  `src/plugin-host.ts` (+ `plugin-api.ts` the contract, `plugin-code-format.ts` the manifest, `plugin-code-store.ts`
  hashes and state, `plugin-code-api.ts` the Plugins view's API); the page side is `public/js/registry.js`. Core
  never imports plugin code. The design is `docs/superpowers/specs/2026-09-28-code-plugins-design.md`.
- `public/` is the page: `index.html` (markup only), a service worker and a manifest. The code is `public/js/*.js`
  and the styles `public/css/*.css`, all listed in `public/assets.json` and loaded in that order: scripts as classic
  scripts sharing one global scope (`core.js` first: state, helpers, `api`; `registry.js` next; `boot.js` last of the
  deck's own, then Library and Plugins; then running code plugins' files; startup itself waits for all of them, on
  DOMContentLoaded), styles in cascade order. Code that runs at load may only use what earlier files
  define (calls inside functions are fine); a later file can take over a function by reassigning it. Put new code in
  the file for its area, or a new one in the right place in the manifest. `src/assets.ts` serves each under a content
  hash with immutable caching and the service worker keeps them the same way. Keep each file under 400 lines;
  `test/assets.test.ts` checks that, and that no two scripts (the deck's and every plugin's) declare the same
  top-level name.
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

## Code plugins

Every extra (Covers, then Discover, Library, Connections, Leads, Opportunities, Research, project pages, Quests) is a
code plugin that can be switched off in Plugins → Built in. The contract is in the design doc; `src/plugin-api.ts` is
the typed `Host`. Worked example: `plugins-builtin/covers/`.

- **Folder**: `plugins-builtin/<id>/plugin.json`, `server.ts` (`export function activate(host)`), the modules it owns,
  its page files, and `test/*.test.ts` (plain `bun test` runs them).
- **plugin.json** lists everything it touches: `routes` (`"covers"` = POST `/api/covers*`, `"/covers/"` = GET files),
  `pages`, `provides`, `extends`, `requires`/`uses`, `client`/`styles`, `machine` (`"hub"` default, or `"any"`).
  Anything not listed is refused at runtime, so the manifest is the whole surface.
- **Server**: build your module inside `activate` from `host` only. Covers:
  `createCovers({ dir, confFile, dataDir, enabled: () => !host.isNode() })`, then `host.provide("covers", {...})`,
  `host.routes("/covers/", …)`, `host.routes("covers", …)`, `host.after(90_000, tick)`, `host.every(60_000, tick)`,
  `host.onStop(covers.stop)`. No `setInterval` of your own: host timers are what stop when it's switched off.
  Keep data where it lives today (`host.dataDir`, `host.env("DECK_…_DIR")`), no migrations.
- **Talking to other plugins**: `host.use("covers")` (declare the provider in `requires`/`uses`; it's `undefined`
  while off), or an extension point (`host.extend("discover.tabs", …)` / `host.contributions(…)`). Never import
  another plugin's files. The core reaches you only through `pluginHost.service(name)` or a core point
  (`fullState`, `digest.lines`, `mcp.tools`, `tools.entries`).
- **Page**: move the files from `public/js`/`public/css` and `public/assets.json` into the folder and `client`/`styles`
  (they load after the core's, so code that runs at load may only use core globals and plugins you `require`).
  Register with `deckPlugins.register(id, { views, tabs, palette, keys, settings, events, state, links })` instead of
  editing `views.js`, `palette.js`, `input.js`, `menus.js` or `boot.js`; look at the registrations at the end of
  `discover.js`, `quests.js`, `journey.js`, `connections.js` and `opportunities.js`, which move with those plugins.
- **Migrating**: `git mv` the files, fix imports, remove the wiring from `src/server.ts`, `src/http/routes.ts`,
  `src/http/hub.ts` and the page, and check `test/plugin-guards.test.ts`. Behaviour must not change: prove it with
  the snapshot harness (below) with everything on, then with your plugin off (no requests, timers or errors).

## UI snapshots (before/after)

`bin/ui-snapshot.mjs` starts a throwaway deck from a source folder on its own port with a scratch HOME (no real
sessions, data or herdr socket; no model or Codex calls), adds synthetic sessions, freezes the page's clock,
`Math.random` and SSE, blocks every mutating API, and writes `<view>-<desktop|phone>.png/.json` (DOM text, page
errors, requests) for each view. `bin/ui-compare.mjs` diffs two runs (pixels with a tolerance, text, request sets,
errors) and exits 1 on a difference. It uses node with the global Playwright (`PLAYWRIGHT_PATH` overrides), never the
shared Playwright MCP. Use the same `--port` for both runs (the scratch HOME's path is printed on some pages).

```sh
git archive main | tar -x -C /tmp/deck-base                              # the "before" source
node bin/ui-snapshot.mjs --repo /tmp/deck-base --out /tmp/snap-before --port 4772 --views all-but-new
node bin/ui-snapshot.mjs --out /tmp/snap-after --port 4772               # this checkout, every plugin on
node bin/ui-snapshot.mjs --out /tmp/snap-off --port 4772 --plugins-off covers
node bin/ui-compare.mjs /tmp/snap-before /tmp/snap-after --ignore-requests '^GET /(js|plugins)/'
```

`--views a,b` picks views (see `--help`), `--seed <dir>` copies fixture data into the scratch HOME, `--env K=V`
passes settings to the deck, `--keep` keeps the scratch HOME. Add a view to `VIEWS` in the script when your plugin
has a screen the list misses.
