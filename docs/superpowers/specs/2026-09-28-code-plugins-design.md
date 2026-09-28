# Code plugins: a small core, and every extra as a real plugin

Date: 2026-09-28 · Status: approved by the user in chat (2026-09-28) · Extends `2026-09-26-plugins-design.md`

## Why

The deck drifted: the extras (Discover, gallery, Studio, Leads, Opportunities, Research, Founder Library, covers,
Quests, project pages, the connections store) are ~16k of 25k server lines and ~4.9k of 9.2k page lines, all wired
into `src/server.ts` and `public/assets.json`. The user wants the core kept small and improved, and every extra to be
a plugin that can be switched off, with plugins able to run real code.

## Decisions (user, 2026-09-28)

| Question | Decision |
|---|---|
| Can plugins run code? | **Yes.** Two kinds: **data plugins** (the existing format; safe; strangers OK) and **code plugins**. |
| Who can install code plugins | The extras ship **built in** as code plugins (trusted). Any other code plugin installs only from a **local folder or a git repo pinned to a commit**, behind a red trust screen: "runs code on this machine with your full permissions". Never from a stranger by default. |
| Uncommitted Discover work from another session | Committed as-is (`38152df`) and moves into the plugins with the rest. |

## What stays core

Sessions list, session view (chat, composer, terminal, slash menu, uploads, answer cards, code-block actions),
Inbox/decisions (+ Jev suggestions, proof-of-done), machines (hub/node, Codex app), History + deep search, push +
automations engine, MCP server, new/rename/close, themes, ⌘K palette, settings, the plugin host + Plugins view.
Core must never import plugin code (a test enforces this).

## Built-in code plugins

| id | Owns (today's files) | Needs | Offers |
|---|---|---|---|
| `covers` | covers.ts, cover-art.ts, js/covers.js | — | `covers` service (`respond`) |
| `library` | library*.ts, bin/library-bridge.*, js/library.js, css/library.css | — | `library` service (evidence, comparables), MCP tool, Discover tab |
| `connections` | connections.ts, store.ts, catalog.ts, accounts.ts, logins.ts, projconn.ts, recipes.ts, js/conn-store.js, js/connections.js | — | `connections` service (`inventory`), Tools entry, MCP tool, CONNECTIONS.md |
| `discover` | discover*.ts, gallery-server.ts, ideagen/*, feed.ts, mix.ts, studio*.ts, idea-archive.ts, js/discover.js, mix, feed, studio*, gallery-* | optional: library, covers, connections | `discover` service; **extension point `discover.tabs`** |
| `leads` | leads.ts, js/leads*.js | discover | `leads` service; Discover tab |
| `opportunities` | opportunit*.ts, js/opportunities.js | discover, leads | Discover tab / view |
| `research` | autoresearch*.ts, js/research.js | discover | Discover tab |
| `projects` | journey*.ts, js/journey*.js | — | `journeys` service; `/p/*` pages |
| `quests` | game*.ts, revenue.ts, economics.ts, js/quests*.js | projects; optional discover, connections | digest lines, `game` summary, `startRun` |

(Exact file lists are the migrating agent's call; the table is the intent.)

## The contract

A code plugin is a folder with `plugin.json` (`"deck": 1, "kind": "code"`, id, name, version, `requires`, `uses`
(optional deps), `server` entry, `client` scripts, `styles`, `settings`) and code beside it. Built-ins live in
`plugins-builtin/<id>/` in the repo; installed ones in `~/.config/herdr-deck/plugins/<id>/`.

Server entry exports `activate(host): Promise<Deactivate | void>`. The host gives a plugin exactly what the
composition root lends extras today, nothing wider by accident:

- `host.routes(prefix, handler)` — `/api/<prefix>/*` (and page routes like `/p/*` when declared); errors become a 500 for that plugin only.
- `host.every(ms, fn)`, `host.after(ms, fn)`, `host.onStop(fn)` — all timers/workers stop on deactivate.
- `host.provide(name, api)` / `host.use(name)` — services; `use` of a disabled optional dependency returns `undefined`.
- `host.extend(point, contribution)` / `host.contributions(point)` — e.g. `discover.tabs`, `digest.lines`, `mcp.tools`, `palette.entries`, `fullState` slices, `tools.entries`.
- Core capabilities, typed: rows, sessions (start/send/close), push, automations, decisions, broadcast/notice, machines, `isNode`, dataDir (the plugin's data keeps living where it lives today — **no data migration**), env.
- Client: plugin scripts load after core scripts, only for enabled plugins, and register with `deckPlugins.register(id, { views, tabs, palette, keys, settings })`; core views/tabs/palette/keys read the registry instead of hard-coded extras.

Lifecycle: load order = dependency order; a missing hard dependency or a thrown `activate` marks the plugin
**failed** (shown in the Plugins view with the error) and the rest keep running. Disabled plugins are never
imported. Enable/disable from the Plugins view: server activates/deactivates live; the page reloads to swap assets.
Nodes (Linux) run only plugins marked `"machine": "any"`; hub-only plugins stay off there.

Trust: built-ins are trusted by path. Installed code plugins store the approved hash of every file; a changed file
disables the plugin until re-approved. Data plugins keep their existing trust flow unchanged.

## Phases

1. **Host + proof** (one agent): plugin host (server + client registry), trust screen for code plugins, Plugins
   view toggles, a committed reusable UI snapshot harness (`bin/ui-snapshot.*`, scratch HOME, synthetic sessions,
   frozen clock, blocked mutating APIs), and `covers` migrated as the proof.
2. **Migrate in parallel** (worktrees): `library` + `connections`; `discover`; `projects` + `quests`.
3. **Then** `leads` + `opportunities` + `research` (they plug into `discover.tabs`).
4. **Independent verification**: all on / all off / each off; core-import test; before/after snapshots identical with
   everything on; nothing loaded, requested or scheduled for a disabled plugin; data dirs unchanged; startup time and
   page weight before/after; Linux node.

## Non-goals

No behaviour changes to the extras, no data migration, no sandboxing of code plugins (they run in-process with full
permissions, which the trust screen says plainly), no public plugin marketplace for code.
