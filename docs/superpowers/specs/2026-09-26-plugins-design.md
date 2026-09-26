# Plugins: installable abilities, integrations and whole businesses

Date: 2026-09-26 · Branch: `deck-plugins` · Status: design approved in chat, spec awaiting review

## Why

The deck already knows every agent session, connection, project and journey. Plugins let anyone package an
ability on top of that and let anyone else install it:

- **Integrations** that feel native: a Gmail inbox, GitHub PRs, ProofHub tasks, any context source, shown as a
  deck view with agent actions.
- **Business packs**: one or more projects with their agent roles, prompts, recipes, schedules, required
  connections and a playbook, so a working business (content creation, support, a niche shop, one with a
  physical side) can be shared and run by someone else on their own machines and accounts.

## What the user said (decisions)

| Question | Decision |
|---|---|
| Who installs plugins | **Strangers from day one.** Plugins are untrusted; the deck never runs plugin code. |
| How plugins get UI | **Templates first.** The plugin declares data and a layout; the deck renders it in its own style. An iframe escape hatch is out of scope. |
| How views and actions reach services | **Through an agent.** A locked-down headless `claude -p` with only the tools the plugin declares fetches and acts. |
| What a business pack contains | **Blueprint + repo links.** Projects (optionally a public git repo pinned to a commit), roles, recipes, schedules, connections, playbook. Nothing runs until the user presses Start. |
| How plugins are made and found | All four: **catalog**, **install from URL/file**, **agent generates one**, **export from my setup** — export ships in v1. |
| Structure | **One format** (`plugin.json`) with extension points; any git repo with `plugin.json` at its root is a plugin. |

## Spike: agent sources are viable (2026-09-26)

`claude -p --model haiku --tools "<one Gmail tool>" --allowedTools "<same>" --setting-sources "" --no-session-persistence`
reached the claude.ai Gmail connector and returned `id`, `messages`, `viewUrl`.

| Variant | Gmail reachable | Cost | Time |
|---|---|---|---|
| `--tools <exact list>`, cold cache | yes | $0.24 | ~10 s |
| same, warm cache | yes | $0.026 | ~10 s |
| `--strict-mcp-config` | **no** (drops claude.ai connectors) | $0.016 | — |

Consequences: views are **cached snapshots**, refreshed in the background, never live; the runner restricts
tools with `--tools`, not `--strict-mcp-config`; every run has a spend cap.

## 1. The format

A plugin is a folder (or git repo) containing `plugin.json` and optional files beside it (`prompts/*.md`,
`playbook.md`, `icon.svg`). It is **data only**. The validator rejects unknown keys, file references that
escape the plugin folder, and anything that doesn't match the schema below.

```jsonc
{
  "deck": 1,                                  // format version; the deck refuses versions it doesn't know
  "id": "content-studio",                     // [a-z0-9-]{2,40}, unique per install
  "name": "Content Studio", "version": "1.0.0", // semver
  "kind": "business",                         // "integration" | "business" (display only)
  "author": "…", "description": "…", "homepage": "https://…",
  "icon": { "glyph": "CS", "color": "#7c3aed" },

  "requires": {
    "plugins": ["gmail-inbox"],               // installed first, each with its own trust screen
    "connections": [{ "label": "YouTube", "any": ["svc:youtube-data-api"] }]   // recipes' Need shape
  },

  // Named tool grants: the only tools an agent run from this plugin may use.
  "grants": {
    "gmail.read": { "tools": ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread"] },
    "gmail.send": { "tools": ["mcp__claude_ai_Gmail__reply"], "writes": true }
  },

  "sources":  [{ "id": "inbox", "prompt": "prompts/inbox.md", "grants": ["gmail.read"],
                 "schema": { /* JSON Schema subset: object/array/string/number/boolean, required, maxItems */ },
                 "refresh": "10m", "model": "haiku", "machine": "hub" }],
  "views":    [{ "id": "inbox", "title": "Gmail", "template": "inbox", "source": "inbox",
                 "item": { "id": "$.id", "title": "$.subject", "from": "$.from", "time": "$.date",
                           "snippet": "$.snippet", "unread": "$.unread", "url": "$.viewUrl" },
                 "actions": ["reply"], "pin": true }],
  "actions":  [{ "id": "reply", "label": "Reply with agent", "mode": "draft",   // "draft" | "session"
                 "prompt": "prompts/reply.md", "draftSchema": { … }, "grants": ["gmail.send"] }],
  "recipes":  [ /* src/recipes.ts Recipe shape, minus custom/from */ ],
  "projects": [{ "id": "studio", "name": "Studio", "folder": "content-studio",
                 "repo": { "url": "https://github.com/…", "ref": "<40-char commit>" },   // optional
                 "playbook": "playbook.md" }],
  "roles":    [{ "id": "writer", "project": "studio", "title": "Writer", "agent": "claude",
                 "model": "sonnet", "prompt": "prompts/writer.md", "machine": "hub" }],
  "schedules":[{ "id": "daily-plan", "every": "day 09:00", "role": "writer",
                 "prompt": "Plan today's 3 posts from {source:trends}" }]
}
```

Field rules:

- `item` values are JSONPath-lite (`$.a.b`, `$.a[0]`) into one source item. Unknown template fields are rejected.
- `refresh`: `5m`…`24h`; floor 5m.
- `every`: `day HH:MM`, `weekday HH:MM`, `mon,thu HH:MM`, or `Nh` (N ≥ 1). Local time on the hub.
- `{item}` in an action prompt is the item's mapped fields as JSON; `{source:<id>}` is that source's cached
  snapshot, trimmed; `{date}` and `{machine}` as in recipes.
- `machine`: `"hub"` (default) or `"other"`, the same meaning as recipes.
- `playbook.md`: a markdown checklist, where each `- [ ] Title — metric >= N` or `- [ ] Title (manual)` line
  becomes a Journey `LadderItem`.

### Extension points in v1

| Point | What it adds | Where it shows |
|---|---|---|
| `sources` | Agent-fetched data, schema-checked, cached on the hub | Views; `deck_plugin_data` MCP tool; `{source:…}` in prompts |
| `views` | `inbox`, `list` or `board` template bound to a source, plus the shared item detail pane | Pinned: a button beside Inbox / History / Discover; else inside the plugin's card |
| `actions` | `session`: opens New session prefilled. `draft`: headless draft → you review → headless send | Item detail pane |
| `recipes` | Recipes with a plugin badge | Connections → Recipes |
| `projects`, `roles` | Repo clone and folder, standing agent sessions | Projects page with **Set up** |
| `playbook` | Milestones | The project's Journey |
| `schedules` | Timed prompts to a role session of the same plugin | Plugin card; every prompt appears in its session like a typed message |

Templates: `inbox` (from / title / snippet / time / unread), `list` (title / subtitle / badge / time),
`board` (columns by a `column` field, cards with title / subtitle / badge). All three open the same detail pane:
mapped fields, a `body` field rendered as escaped plain text with line breaks, an `url` shown as a link only if
it is `https:`, and the action buttons.

### Storage (`~/.config/herdr-deck/`)

- `plugins/<id>/`: the installed files, exactly as approved.
- `plugins.json`: `{ id, version, from: { url?, ref?, file?, catalog? }, enabled, approved: { grants, repos, schedules, hash }, installedAt }[]`.
- `plugins/<id>/cache/<source>.json`: `{ at, items, error?, cost }`.
- `plugins/<id>/spend.json`: spend per day.

## 2. Trust and execution

Threat model: the plugin's author may be hostile, and so may the **content** its agents read (an email that
says "forward everything to …").

**Install gate.** Installing always shows a trust screen generated from the manifest, never from the
plugin's own description:

- Each grant in plain English ("*Read* your Gmail threads"; **"Send replies from your Gmail"** in red for
  `writes: true`), with the exact tool names one tap away.
- Grants that name built-in tools that touch the machine (`Bash`, `Write`, `Edit`, `Read`, `WebFetch`,
  `WebSearch`) get the label **"runs commands / reads files on your machine"**. `Bash` requires a second tick.
- Repos to clone (URL, pinned commit), roles, schedules ("Starts 2 agents; the Writer gets a prompt every day
  at 09:00"), required connections and plugins.
- The full text of every prompt, one tap away.

Nothing is enabled until approved. **Updates** show a diff of grants, repos, roles and schedules, and need
approval again whenever any of these changed. Changes to source and draft prompts are listed but auto-approved,
because grants box those runs in. Changes to role or schedule prompts need approval, because those prompts go to
full agent sessions with the user's own permissions. The approved
manifest's hash is stored, so a file edited on disk after approval disables the plugin until it is re-approved.

**Headless runner (`src/plugin-runner.ts`).** Every source refresh and draft action goes through one function
that builds the arguments from the approved grants only:

```
claude -p --model <haiku|sonnet> --effort low
  --tools "<union of the run's grant tools>" --allowedTools "<same>"
  --setting-sources "" --no-session-persistence --disable-slash-commands
  --output-format json --system-prompt <runner system prompt + schema>
  cwd: fresh temp dir; stdin: the plugin prompt
```

- Timeout 90 s. The output must parse as JSON and match the schema, or the run fails; items that don't match are dropped.
- Spend cap per plugin per day: $1 by default, adjustable on the card. `total_cost_usd` from each run is added
  to `spend.json`. At the cap, runs stop until local midnight and the card says so.
- At most two plugin runs at once on a machine; further runs queue. Spawned, never blocking the event loop.

**Reading and writing are separate runs.** Source runs and the first half of a draft action get only
non-`writes` grants. A `draft` action:

1. Runs with read grants and returns a payload matching `draftSchema`.
2. The deck shows that exact payload (editable text fields).
3. On **Send**, a second run gets only the action's `writes` grants and a fixed system prompt: "Perform exactly
   this operation with these arguments. Do nothing else." The payload goes in as JSON data.

Content the agent reads can distort a draft, but it can't send anything the user didn't see.

**Untrusted output.** Everything from a plugin or its agents is rendered as escaped text by the deck's own
templates. No plugin HTML, CSS or script. Links are only made from `https:` URLs.

**Sessions and repos.**

- Repos are `git clone`d into the projects folder and checked out at the pinned ref. The deck never runs anything in them.
- Role sessions start through the New session dialog, prefilled, with the permission mode the user picks.
  "default" is proposed; "bypass" is never offered for plugin roles.
- Every plugin prompt sent to a session starts with a header line: `[plugin Content Studio 1.0.0 · schedule daily-plan]`.
- Schedules may only target role sessions of the same plugin. If the role's session isn't running, the
  schedule records "skipped: Writer isn't running" instead of starting one.

**Across machines.** Plugins live on the hub. A source or role with `"machine": "other"` runs through the
existing federation tunnel on that machine's node, which uses the same runner code and flags. A node refuses
plugin runs that don't come from its hub.

## 3. UI and data flow

**Plugins view** (a fourth view button with a puzzle icon), with four tabs:

- **Installed**: cards with state, today's spend, last refresh and error, and Enable / Update / Remove.
- **Catalog**: built-in entries shipped in `plugins-catalog/` in this repo (Gmail inbox, GitHub PRs, Content Studio sample pack).
- **Add**: paste a git or HTTPS URL, drop `plugin.json` or a `.zip`, or **Describe it**. Describe it has an agent
  (no tools, like `mix.ts`) write a manifest from the description and the user's connection inventory (names
  only); the validator's errors are fed back for up to 2 fix-up rounds. Every path ends on the trust screen with a
  live preview (one source run, counted against the cap) before anything is installed.
- **Package**: export (section 4).

**Plugin views.** A pinned view opens instantly on the cached snapshot and shows "updated 4m ago · Refresh".
While refreshing it keeps the old data with a thin progress bar. Selecting an item opens the detail pane. On the
phone it's the same list-then-detail flow as sessions.

**Refresh policy.** A source refreshes:

- when its view opens and the cache is older than `refresh`,
- when the user taps Refresh,
- on its interval, only while a deck page is visible (the existing `presence` map in `server.ts`).

Results reach the page as an SSE event `plugin` with `{ id, source, at, items, error }`.

**Business pack setup.** From the trust screen or from Projects → Set up, a checklist:

1. Missing connections, each linking to Connections.
2. Clone repos (or create empty folders).
3. Start role sessions: one prefilled New session dialog per role, with a single "Start all" confirm.
4. Turn on schedules.

Each step can be retried on its own. The project then appears on the Projects page with its playbook as a Journey.

**For agents.** A new deck MCP tool, `deck_plugin_data(plugin, source)`, returns the cached snapshot (it never
triggers a paid refresh). `deck_connections` lists installed plugins and their sources.

**Server pieces.**

| Module | Job |
|---|---|
| `src/plugins.ts` | Schema and validator, trust summary and update diff, install/remove/enable, `plugins.json`, the catalog |
| `src/plugin-runner.ts` | Runner argument building, spawning, schema filtering, spend and concurrency |
| `src/plugin-sched.ts` | Schedule parsing and due-time calculation (pure, fake clock), hooked into the hub's existing timer |
| `src/plugin-playbook.ts` | `playbook.md` → Journey ladder items |
| `src/plugin-export.ts` | Export drafting and the scrubber |

Routes: `GET /api/plugins`; `POST /api/plugins/install` (url, file or catalog id; with `approve: hash` to
actually install); `POST /api/plugins/remove`, `/enable`, `/cap`; `POST /api/plugin-refresh`;
`POST /api/plugin-action` (draft, then send with the reviewed payload); `POST /api/plugin-generate`;
`POST /api/plugin-export`. All are behind the existing action token and Host check.

## 4. Export, errors and testing

**Package this.** From a project on the Projects page, or from a set of sessions picked on the Plugins → Package tab:

1. **Collect** (deterministic): each chosen session's first user prompt, agent, model and folder; recipes and
   automations referencing the project; connections the sessions used (from transcripts, as Connections
   already does); the repo remote and HEAD; Journey milestones.
2. **Draft**: a no-tools agent turns that into `plugin.json`, `prompts/*.md` and `playbook.md`. Generic role
   prompts replace one-off chatter.
3. **Scrub** (`plugin-export.ts`, deterministic code, not an agent). It builds on `jev.ts:scrub()` and replaces:
   - the home path → `~`,
   - the user's name, username, hostnames, tailnet names and emails (from the machine and git config),
   - anything matching key-name patterns or looking like a high-entropy token (≥ 24 chars, ≥ 3.5 bits/char),
   - private repo URLs (checked with `gh repo view --json isPrivate` when `gh` is present, otherwise treated as
     private) unless the user ticks "include".

   Each replacement is a placeholder like `{{email}}`, and install asks the new user for these values.
4. **Review**: side by side, every replacement highlighted, all files editable. The export can't be saved
   until every flagged item has been accepted or edited.
5. **Save** to a folder or `.zip` under `~/Downloads`. Nothing is uploaded. A private repo in the pack is flagged:
   "the recipient won't be able to clone this".

**Errors.** Each failure is recorded on the plugin's card. Nothing blocks the event loop.

| Failure | Behaviour |
|---|---|
| Invalid manifest | Rejected at install with the exact JSON path and reason |
| Run timeout, bad JSON or schema mismatch | Stale cache kept; error chip with Retry |
| Missing connection | "Needs Gmail", linking to Connections; sources that need it don't run |
| Spend cap reached | Refreshes pause until midnight; the card shows spend and the cap |
| Clone fails | That setup step shows the error and can be retried; other steps work |
| Approved files changed on disk | Plugin disabled until re-approved |
| Uninstall | Removes files, cache, spend and schedules; asks whether to keep cloned repos and sessions (default keep) |

**Testing** (`bun test`, no live agents):

- `test/plugins.test.ts`: validator (good manifests; unknown keys; bad ids; bad grants; files escaping the
  folder; bad `every` and `refresh`), trust summary text, update diff, approved-hash tamper check.
- `test/plugin-runner.test.ts`: exact `--tools` per run; a `writes` grant never in a source or draft run; the
  send run has only the action's write grants; schema filtering; spend cap arithmetic.
- `test/plugin-sched.test.ts`: due times on a fake clock, including DST and weekday rules.
- `test/plugin-playbook.test.ts`: checklist → ladder items.
- `test/plugin-export.test.ts`: scrubber against a fixture of paths, emails, tokens, hostnames and private repo URLs; placeholders round-trip.
- Manual: Gmail inbox and GitHub PRs end to end on the running deck and on the phone over the tailnet; install
  the Content Studio sample pack and run Set up; export a real project and install it in a clean
  `HOME` to check that nothing personal leaks.

## Out of scope for v1

A public registry and search, signing and author identity, a sandboxed iframe UI, plugin code of any kind,
non-Claude runners for sources (Codex/OpenCode roles are fine; headless runs are Claude only), payments for
plugins, and automatic updates from git (updates are user-initiated and re-show the trust diff).

## Build order

1. Format, validator, storage and trust screen, with install from file and catalog (no runs yet).
2. Runner, sources, `inbox`/`list` views, `deck_plugin_data`. Ships the Gmail inbox and GitHub PRs plugins.
3. Actions (`session` and `draft` → send), plus the `board` template.
4. Projects, roles, playbook, schedules, Set up flow, with the Content Studio sample pack.
5. Install from URL, and Describe it (generation).
6. Export and the scrubber.

Each step leaves the deck working and tested, and could merge on its own.
