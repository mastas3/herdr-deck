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

## The contract (as built in phase 1)

### Folder layout

```
plugins-builtin/<id>/            built in, trusted by path (repo)
  plugin.json                    the manifest below
  server.ts                      exports activate(host)
  *.ts                           its own server modules (import the core freely, never another plugin's files)
  *.js, *.css                    page files named in plugin.json
  test/*.test.ts                 its tests; plain `bun test` runs them
<data>/plugins/<id>/             installed (<data> = DECK_PLUGINS_DIR or ~/.config/herdr-deck), same shape
<data>/code-plugins.json         { enabled: {id: bool}, installed: [{id, name, version, from, files: {path: sha256}, hash, approvedAt}], settings: {id: {key: value}} }
```

### plugin.json (`src/plugin-code-format.ts`)

| field | meaning |
|---|---|
| `deck: 1`, `kind: "code"`, `id`, `name`, `version`, `description?` | `id` = folder name (`[a-z0-9-]`, 2–40) |
| `requires: string[]` | plugin ids it can't run without: started first; if one is off/failed/missing this one is **failed** ("Needs …") |
| `uses: string[]` | optional plugin ids: started first when on; `host.use()` of theirs returns `undefined` when off |
| `server?` | entry file (.ts/.js) exporting `activate(host)` |
| `client: string[]`, `styles: string[]` | page files, appended after the core's (in plugin load order) at `/plugins/<id>/<file>?v=<hash>` |
| `machine: "hub" \| "any"` | default `"hub"`: never started on a node (status `hub-only`) |
| `routes: string[]` | `"covers"` → POST `/api/covers` and `/api/covers/*`; `"/covers/"` → GETs under that path (no token). Core API names and paths are refused |
| `pages: string[]` | paths that serve the deck page (client-side links such as `/p`) |
| `provides: string[]` | service names it may `provide` |
| `extends: string[]` | extension points it may `extend` |
| `settings: {key: {label, type: boolean\|number\|string, default, hint?}}` | shown and edited in the Plugins view; read with `host.setting(key)` |

The host refuses any route, service or point the manifest doesn't list, so the trust screen (built from the manifest
before any code runs) shows the whole surface.

### Server: `activate(host: Host): Promise<Deactivate | void>` (`src/plugin-api.ts`)

- `host.id`, `host.dir`, `host.dataDir` (the deck's data folder: data stays where it lives today, **no migration**),
  `host.env(name)`, `host.log(msg)`.
- `host.routes(prefix, handler)`; `handler({ method, path, url, body, req })` returns a `Response` (sent as is),
  `undefined` (not mine) or anything else (sent as JSON). A throw becomes `500 {error, plugin}` for that plugin only.
- `host.every(ms, fn)`, `host.after(ms, fn)` (each returns a cancel function), `host.onStop(fn)`: all stop on deactivate.
  Errors in timers are logged, never thrown into the deck.
- `host.provide(name, api)` / `host.use(name)`: `use` throws when the provider isn't in `requires`/`uses`, and returns
  `undefined` while it is off. Call it when needed; don't keep the result.
- `host.extend(point, c)` / `host.contributions(point)` (running plugins, in load order). Core points (`CorePoints`):
  `fullState` `{key, get}` (core keys refused), `digest.lines` `{title, lines(), pref?}` (replaces automations'
  `questLines`), `mcp.tools` `{name, description, inputSchema, call(args)}` (can't shadow a deck tool),
  `tools.entries` (a `Tool`, runnable like the built-ins). Any other name is a plugin's own point, e.g. `discover.tabs`.
- `host.setting(key)`.
- Core, typed: `host.rows()`, `host.sessions.start/send/close`, `host.push`, `host.automations()`, `host.decisions()`,
  `host.broadcast(event, data)` (core event names refused), `host.notice({ok, message})`, `host.machines()`, `host.isNode()`,
  `host.history(o)` (past sessions on every machine, the History search) and `host.checks()` (proof-of-done results).
- The core reaches a plugin only through `pluginHost.service(name)` (no import; a test enforces that nothing under
  `src/` imports `plugins-builtin/`).
- While a part is still core, the core can offer it to plugins under the service name its plugin will use:
  `pluginHost.provideCore(name, api)` (idempotent; a plugin that provides the name wins). `use()` finds it like any other.
- Device push preferences a plugin adds (e.g. quests' `questDigest`, `quests`) are kept by name in each device's prefs; a
  `digest.lines` section's `pref` skips devices that set it false, a push with `pref` goes only where it is true.

### Client (`public/js/registry.js`, loaded right after core.js)

`deckPlugins.register(id, spec)` returns `{ extend(point, c) }`. `spec`:

| key | shape | read by |
|---|---|---|
| `views` | `{ [mode]: { render(), load?(), leave?(), path?() } }` | `setMode`/`renderMode`; `path()` is the view's URL (`syncUrl`) |
| `tabs` | `[{ view, label, icon (string or fn), key?, count?, order }]` | the view tab bar (core: Inbox 10, History 20, Plugins 90) |
| `palette` | `(q, cur) => [{ t, run, k?, echo?, slot: "views"\|"more", order? } \| { section, html, run }]` | ⌘K |
| `keys` | `{ [key]: (e) => void }` (core keys refused) | the keyboard handler |
| `settings` | `[{ html, run }]` | the Settings menu |
| `events` | `{ [sseEvent]: (data) => void }` | the SSE connection |
| `state` | `(fullState) => void` | every full state |
| `links` | `(url: URL) => boolean` | deep links on load, `?…` params and push taps |

Plus `deckPlugins.contributions(point)`, `deckPlugins.each(point, ...args)`, `deckPlugins.view(mode)`,
`deckPlugins.has(id)` (its scripts are in the page) and `deckPlugins.on(id)` (running on the deck, from
`fullState.plugins.active`). A "plugins" SSE event (something switched) reloads the page. The page's first state, the
SSE connection and its own link wait until every script (running plugins' included) has loaded, so late-loaded state
hooks, events and links are registered in time. Two points the core reads: `project.link` `{ icon, open(name) }` (where
a project's name leads: the list's project headers and the session header; nothing is a link while none is on) and
`notify.prefs` `{ title, prefs: [{ key, label, hint, default }] }` (a section of the Notifications dialog).

### Lifecycle

`start()`/`reconcile()` scans, orders by dependencies (built-ins before installed, then by id; a cycle → failed),
stops (dependents first) whatever may no longer run, then starts what should, in order. Status per plugin: `on`,
`off`, `failed` (+error), `hub-only`, `changed` (installed files differ from the approved hashes), `invalid` (bad
manifest). Built-ins default on. Enable/disable is live: `/api/plugins/code/enable` → reconcile → broadcast.

### Trust

Built-ins are trusted by path. Code installs come only from a local folder or a git repo pinned to a 40-char commit:
`/api/plugins/code/inspect` stages a copy (git: clone, check out, verify HEAD, drop `.git`; symlinks refused), the
red trust screen lists every file and the manifest's surface and needs a tick, and `/api/plugins/code/install` moves
exactly the staged bytes (checked by hash) into place and records each file's sha256. Any added, removed or edited
file → `changed`, off until reviewed again. Data plugins keep their own flow; a name one uses can't be taken.

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
