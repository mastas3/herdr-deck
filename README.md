# herdr deck

**One live screen for every AI coding agent you're running.** Claude Code, Codex and OpenCode sessions
in [herdr](https://herdr.dev), on this computer and your others, as one list you can triage, answer and
steer, from your desk or your phone.

- See at a glance which agents are working, which are waiting on you, and which finished.
- Open any session as a chat: read the whole conversation, answer permission prompts with one tap, send
  messages, attach files, or type straight into its terminal.
- Start, rename, close and resume sessions. Search every past conversation.
- Install it on your phone as an app (over [Tailscale](https://tailscale.com), private to you).
- Watch several machines from one deck.

It's a single [Bun](https://bun.sh) process with no dependencies and no build step. It reads only local
files and herdr's socket, and it listens only on `127.0.0.1`.

## Install

You need **macOS or Linux** and **[herdr](https://herdr.dev)** (`brew install herdr`), where your agents run.
Then paste this into a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/mastas3/herdr-deck/main/bin/bootstrap.sh | bash
```

That installs Bun if you don't have it, puts the deck in `~/.local/share/herdr-deck`, and starts it as a
login service (launchd on macOS, `systemd --user` on Linux) so it's always there. Open
**http://127.0.0.1:4747**. Run the same line again to update.

### Or let your AI agent set it up

New to all this? Paste this to Claude Code, Codex, or any coding agent that can run commands on your computer:

```text
Set up herdr deck on this computer for me. Follow the guide at
https://raw.githubusercontent.com/mastas3/herdr-deck/main/AGENT_SETUP.md step by step.
I'm not technical, so explain what you're doing in plain words and ask me before anything optional.
```

The guide ([AGENT_SETUP.md](AGENT_SETUP.md)) walks the agent through checking your computer, installing
what's missing, starting the deck, and the optional extras: the phone app, more machines, local AI summaries.

### From a clone

```bash
git clone https://github.com/mastas3/herdr-deck.git && cd herdr-deck
bin/install.sh          # run it as a login service on http://127.0.0.1:4747 (restarts it if it's running)
bin/uninstall.sh        # stop it and remove the service (your data in ~/.config/herdr-deck stays)
bun run dev             # or run it in the foreground with reload (DECK_PORT=4748 to use another port)
bun test
```

## Opportunities

**Opportunities** is a workspace alongside Discover. Discover’s **Evidence & tests** tab opens the same
notebook. Opening evidence for an idea links it once; later opens preserve your edits, reviews and tests.
Earlier ideas, saved cards and build tools remain available.

- Explore your existing advantages, unrelated markets, or novel product mechanisms across 13 industries.
- Keep a dossier with buyer/problem hypotheses, sources, counterevidence, alternatives, unknowns, and
  human review of buyer, problem, alternatives, distribution, feasibility and economics.
- Calculate contribution, acquisition payback, founder capacity, break-even, a 12-month cash projection,
  and sensitivity from explicit inputs. Missing inputs remain unknown; assumptions and measurements
  retain their notes and source references. Annual billing separates receipts from recognized revenue.
- Get a revenue model to test, its prerequisites, complementary streams and a concrete paid experiment.
- Plan experiments before recording results. Payment and repeat-customer stages require owner-attested
  outcomes with denominators and evidence references. They are not payment-provider verification.

Opening this workspace runs no external research. **Explore with an agent** explicitly sends a scrubbed
brief to the configured Claude model. Market and novel modes do not include the project inventory.
**Research** offers public signal collectors or a bounded Claude WebSearch/WebFetch run for alternatives,
prices, distribution, feasibility and counterevidence. Deep research requires an installed, signed-in
Claude Code supporting the safety flags. Each run has a time/output limit, cancellation and explicit
retry after interruption. A retrieved page is evidence of source access; generated interpretations
remain provisional. Tool-returned text can be a summary and must be checked against the original page
before quoting. Search coverage cannot establish global nonexistence or proven demand.

Research-ready is a screening policy: two independent current customer evidence groups, current human
review across six dimensions, and complete conditional economics. Publisher and copied-text grouping
is conservative. Source changes, failed refreshes and concept changes invalidate relevant reviews.
Historical payment evidence cannot transfer to a different buyer/problem/mechanism.

Data stays in separate `opportunities.db` and `opportunity-jobs.json` files under the deck data directory
(or `DECK_DISCOVER_DIR`). The implementation remains dependency-free. The longer design rationale is
in [the opportunity engine proposal](docs/discover-opportunity-engine.md).

For an isolated UI preview with separate temporary data and no live session controls:

```bash
bun bin/opportunities-preview.ts   # http://127.0.0.1:4759/?view=opportunities
```

Use `DECK_PREVIEW_PORT` and `DECK_PREVIEW_DIR` to override its port and data directory. Tailnet access
also requires `DECK_PREVIEW_TS_USER` to match the owner's Tailscale login. This preview does not import
production ideas or restart the installed deck.

## What you need

| | Needed? | What for |
|---|---|---|
| macOS or Linux | yes | Windows isn't supported (herdr doesn't run there either) |
| [herdr](https://herdr.dev) | yes | The terminal your agents run in. The deck reads its socket at `~/.config/herdr/herdr.sock`. For accurate working/waiting status, run `herdr integration install claude` (and `codex`, `opencode`) |
| [Bun](https://bun.sh) 1.2+ | yes | Runs the deck. The installer gets it for you |
| Claude Code, Codex or OpenCode | at least one | The agents the deck shows. Their transcripts are read from `~/.claude`, `~/.codex` and OpenCode's database. Codex desktop app threads show up too |
| [Tailscale](https://tailscale.com) | optional | The phone app and reaching the deck from your other devices, privately |
| [Ollama](https://ollama.com) | optional | Three-line session summaries written by a local model (`ollama pull gemma4:e4b`) |
| SSH access to other machines | optional | Watching more than one machine from one deck |

## On your phone (PWA over Tailscale)

When Tailscale is running, the installer also runs `tailscale serve --bg --https=8448 http://127.0.0.1:4747`,
which serves the deck on `https://<this-computer>.<tailnet>.ts.net:8448`. That address is reachable only from
your own tailnet (never Funnel, never the public internet) and has a real certificate. Open it on the phone,
then use **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

On Linux, `tailscale serve` needs permission once: `sudo tailscale set --operator=$USER`, then run
`bin/install.sh` again.

- On a phone the deck has two screens. The sessions list has search and status chips across the top, with more under Filters.
  Tapping a session opens its chat; the top bar's second tab is the inspector (terminal, subagents, servers), and the
  system back gesture returns to the list.
- The terminal wraps lines to the screen and has a row of keys (esc, enter, ctrl+c, arrows, 1/2/3, y/n)
  and a message box that sends to the agent.
- A service worker keeps icons and fonts instant and shows a clear "your computer isn't reachable" page when
  you're offline. Live data is never cached.
- Push notifications work with the app closed (see Notifications below). On iPhone they need the installed app (iOS 16.4+).

## More machines

Every machine with herdr can run its own deck (a node), and one deck (the hub) shows them all as tabs.

```bash
bin/deploy-node.sh my-linux-box      # copies the deck over SSH, runs it as a systemd --user (or launchd) service
```

The other machine needs Bun installed, and `my-linux-box` must be a host you can `ssh` into without a
password prompt (a key in `~/.ssh/config`). Or do it from the deck: **Settings → Machines…** lists every
machine, adds one by SSH host (it runs the same install and connects without a restart), renames or removes
one (removing only stops watching it). By hand, list the machine in the hub's `~/.config/herdr-deck/hosts.json`:

```json
{ "self": { "id": "laptop", "label": "My laptop" },
  "remotes": [{ "id": "linux", "label": "Linux box", "ssh": "my-linux-box" }] }
```

The hub opens an SSH tunnel to each node's loopback port. It authenticates with the node's
`~/.config/herdr-deck/api.token` (file mode 600, read once over SSH), mirrors the node's event stream, and forwards actions.
Tunnels pick a free port and close when the hub exits. Remote sessions get briefs from the hub's own local model.

## Settings

Put settings in `~/.config/herdr-deck/env`, one `NAME=value` per line, then restart the deck
(`bin/install.sh` again). All of them are optional.

| Setting | Default | What it does |
|---|---|---|
| `DECK_BRIEF_MODEL` | `gemma4:e4b` | Ollama model that writes the session summaries |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where Ollama runs |
| `DECK_PROJECT_DIRS` | `~/Documents/Projects:~/Projects:~/code:…` | Folders (colon-separated) that hold your projects; used for project names and the New session folder list |
| `DECK_TERMINAL` | `WezTerm` | macOS app that **Jump to pane** brings forward (for example `Ghostty`, `iTerm`, `Terminal`) |
| `DECK_HUB_DIR` | `~/wiki` if it exists, else `~` | Folder for deck-started planning sessions |
| `DECK_WIKI_DIR` | `~/wiki` | Where `[[page]]` links in agent replies point, if you keep a Markdown wiki |
| `DECK_TS_USERS` | this machine's Tailscale owner | Comma-separated Tailscale logins allowed in through the tailnet |
| `DECK_CODEX_APP_DAYS` | `3` | How many days of Codex desktop app threads to show |
| `DECK_CODEX_APP_BINARY` | auto-detected desktop bundle | Absolute path to the installed Codex binary for native task metadata operations |
| `DECK_NO_HISTORY` | | Set to `1` to turn off the History index |
| `DECK_CHECK_TIMEOUT_MS` | `600000` | Time limit for "proof of done" checks |

These are set when you install instead, as `DECK_PORT=4800 bin/install.sh`:

| Setting | Default | What it does |
|---|---|---|
| `DECK_PORT` | `4747` | Loopback port |
| `DECK_TS_PORT` | `8448` | Tailnet HTTPS port |
| `DECK_PUBLIC_URL` | the tailnet address | Base address for shareable session links |
| `DECK_NO_TAILSCALE` | | Set to `1` to leave Tailscale alone |

Everything the deck keeps (closed sessions, held messages, briefs, tools, the History index, tokens) lives in
`~/.config/herdr-deck/`.

## Troubleshooting

- **The page is empty and says herdr isn't running.** Open a terminal and run `herdr`, then start your agents
  inside it. `herdr status` should say `server: running`.
- **Sessions show but the status is always idle.** Install herdr's agent hooks: `herdr integration install claude`
  (and `codex` / `opencode`), then restart those agents.
- **http://127.0.0.1:4747 doesn't open.** Check `curl http://127.0.0.1:4747/health`. Logs: macOS
  `~/Library/Logs/herdr-deck.log`, Linux `journalctl --user -u herdr-deck -n 50`. Run `bin/install.sh` again
  to restart it.
- **Linux: the deck stops when I log out.** Run `sudo loginctl enable-linger $USER` once.
- **The phone link says "forbidden host".** The deck only lets in the Tailscale account that owns the computer.
  Sign the phone into the same account, or add the phone's login to `DECK_TS_USERS`.
- **Summaries never appear.** They need Ollama running with the model pulled: `ollama pull gemma4:e4b`.

## Daily use

- **Codex desktop threads** show their chat, nested commands and edits, subagents and their conversations,
  project changes, context usage and completion state. The deck reads Codex's state index (including moved
  transcripts and archive status), respecting `CODEX_HOME`. Connected desktop tasks accept replies, image/file
  attachments, **Steer**, **Stop**, approvals and questions directly in the deck. While working, **Queue** holds
  your message until the turn ends; **Steer** sends it now. The desktop keeps its model, permissions, plugins and
  app tools. **Open & reconnect** recovers an unloaded task on its host Mac. Native tasks can be created,
  renamed, forked and restored; **Fork after this reply** copies history through a completed reply into a new
  task. More actions also offers settings and editing the last message. Archive works when the desktop has
  released the task; loaded tasks offer an explicit handoff to Codex. Settings show the last effective permission
  policy separately from a selected next-turn profile. Model/effort and supported per-task permissions apply
  to the next turn. The desktop's queue is visible separately, with an action to open it in Codex. Native controls use a private,
  versioned interface; unsupported versions stay read-only. See [Codex support](docs/codex-support.md).
- **Inbox:** sessions sort themselves into Needs you (waiting for input or finished), Running, Quiet, Stale and Empty.
  Stale and Empty start collapsed. Empty has a "Close all" link.
- **⌘K** searches sessions on every machine, tools, views, projects and commands in one place. Empty, it shows
  the commands you ran last and what you can do to the selected session; type a project's name to show only it
  or start a new session in it. Each command shows its key.
- **Keyboard:** `?` opens every shortcut, searchable (type a key, or what you want to do). The ones worth
  learning first: `J` jumps to the next session waiting on you, `i` opens Decisions, `r` replies, `x` closes,
  `A` selects every session shown, `Y` copies the resume command, `U` opens Usage.
- **Undo:** closing a session, renaming one or skipping a decision shows a toast with **Undo** (or ⌘Z) for a few
  seconds; a close reopens exactly the panes it closed. Anything that fails says why, with **Retry**.
- **Reply** (`r`): the message box under the chat. Enter sends it to the agent. Attach files with the paperclip,
  by dropping them on the chat, or by pasting; they're saved on the session's machine and the agent gets the paths.
- **Send** always delivers right away, even while the agent works (Claude Code takes it at its next step,
  Codex steers with it). To hold a message until the turn is over instead, press ⌥Enter: the hub keeps it
  (shown above the box, where you can edit, send now or drop it) and sends it when the agent finishes.
  Held messages live in `~/.config/herdr-deck/queue.json`.
- **Long pastes** (over 4,000 characters or 40 lines) become a chip instead of a wall of text. On send each
  one is saved as a file next to the session and the agent gets the path; preview it, put it back inline, or
  remove it first. Anything over 12,000 characters travels the same way.
- **`/` commands:** type `/` for the session's own commands: Claude Code's built-ins (read from the installed
  binary, so they match your version), your commands, project commands, plugin commands and skills; Codex and
  OpenCode built-ins and custom prompts. Arrows to move, Tab to insert, Enter to run. Deck tools are listed too.
- **Answer in the list:** when an agent is waiting on you (a permission prompt, Claude's "trust this folder?",
  or a question with options), a card under its row shows the question and one-tap answers, like Claude on
  the web and phone. Prompts are read from the pane's live screen.
- **Right-click** a session (or hold it on a phone): open, rename, message, jump, new session in its project, copy link, select, close.
- **Rename** (`e`, or ⋯ → Rename): renames the herdr pane (and the tab when the pane has it to itself), the
  herdr agent name, and runs `/rename` in Claude Code or Codex so their own history shows it (queued if busy).
- **Status line** above the message box: project, context used, and the plan limits for that agent
  (Claude 5-hour and weekly from `~/.claude/rate-cache.json`, written by the Claude status line script;
  Codex limits from its session files). Claude's context window (200k or 1M) is only told to the status line,
  so the script also saves it to `~/.claude/context-cache/<session id>.json`; without that the deck guesses 200k.
- **Tools** (`.`, or the ⚡ Tools button next to the message box): one click that makes the agent, or the deck, do something:
  check my email for context, related past work (from History), attach files, handoff → compact (writes a
  handoff note to `~/.config/herdr-deck/handoffs/`, waits, then compacts around it), status line, step back,
  update the wiki, write a handoff note, verify it's done, run the tests, review your diff, Tailscale link,
  show me what you built. Add your own in the Tools view. **Standup** asks every idle agent for a status line.
- **Briefs** write themselves when you stay on a session for a moment (local Ollama, cached).

## Views (top of the list)

- **Inbox** (`i`): every session waiting on you, reduced to the decision. Permission prompts (numbered or
  cursor menus) answer with one tap; a question with options shows the options; "done" gets **Looks good**,
  **Send back**, **Verify now**. Filters: quick ones, permissions, questions, done.
  - **Jev** (optional and hidden unless a `jev` CLI with a TypeSafe API key is installed) suggests which option you'd pick, whether a
    decision is low-stakes, and how likely a "done" really is. It never answers for you. What you actually did
    is recorded with `jev outcome`, however you answered (inbox, keys, the list and board cards, or a reply
    typed in the session). Each request is asked once: the answer is cached by a fingerprint of what's sent
    (`~/.config/herdr-deck/jev-cache.json`), so redraws, rebuilds and restarts don't ask again. The **Jev**
    button in the Inbox header opens a panel read from `~/.jev/receipts.jsonl`: calls, tokens and cost
    (today, 7 days, all time; $0.042 per million input tokens), how often Jev's pick matched what you did by
    kind, calibration, the last ten decisions, and the daily cap. TypeSafe has no daily limit (1,200
    requests/min); the deck caps its own calls (default 1000 a day, about $0.05; set it in the panel, saved to
    `~/.config/herdr-deck/jev-settings.json`, or `DECK_JEV_DAILY` before you do).
  - **Proof of done:** when an agent says it's done, the deck re-runs the project's own checks (detected from
    package.json, Cargo, go.mod, pytest, Makefile). You approve the command once per project, or turn it off.
    Results show on the row and in the Inbox. Stored in `~/.config/herdr-deck/checks.json`.
- **History** (`h`): every past Claude Code and Codex conversation on every machine, full-text searchable.
  Open one to read the whole chat, jump to the match, and **Resume** it in a new herdr tab. Each machine
  indexes its own transcripts into `~/.config/herdr-deck/history.db` (SQLite FTS5), in a short-lived child
  process that re-scans every minute.
- Every view has a ✕ (and Esc) to get back to the session.
- **Tools** (Tools menu → Manage tools): what every tool does and exactly what it sends; add, edit and delete your own.
- **Connections** (Tools menu → Connections, or ⌘K): an app store of what each machine can reach. Categories down the
  side (chips on a phone): AI models & agents, Your projects, Code & Git, Cloud & deploy, Data & databases,
  Communication, Social media, Media & creative, Knowledge & notes, Commerce & payments, Sites & accounts, Automation,
  Search & OSINT, Devices & network, Browsers, MCP servers, Skills, Keys & secrets, Yours, Recommended, and Not set up. Every card has a category, a colored badge, what it's for,
  a state (ready, signed out, installed only, offline) and which machines have it. **Featured** shows what's ready
  and what's new (first seen in the last two weeks); search spans everything. The scan finds CLIs and apps (with
  sign-in checks), npx packages, MCP servers from every agent app (Claude Code and plugins, claude.ai connectors,
  Codex, OpenCode, Gemini, Antigravity, Cursor, Windsurf, Zed, Cline, Hermes, Goose, Claude Desktop, VS Code), API
  key NAMES from shell files, agent env files (`~/.hermes/.env`…), `~/.config/*/.env` and project `.env` files (never
  values), local Postgres databases, Redis, Docker, rclone remotes, Shortcuts, Obsidian vaults, the wiki, tailnet
  devices, SSH hosts, launchd/systemd user services, browser profiles and skills. macOS-only probes are skipped on Linux.
  - **Your projects:** projects under `~/Documents/Projects` (and the other usual project folders, plus wiki pages
    whose `**Path:**` points elsewhere) that agents can use: an MCP server registered in any agent app or a project's
    `.mcp.json` (matched by the paths in its command, args and cwd, or a local URL's port; those are never stored,
    since args can hold tokens), a CLI (package.json `bin`, pyproject scripts, `bin/*.sh`), a port (from the wiki page,
    its launchd/systemd service or skill), or a skill that mentions the project folder. Each card has the wiki's TLDR,
    MCP tool names read from the server's source, and whether it's running now: a listening port whose process was
    started from that folder (from `lsof`/`ss`; nothing connects to any port). A project's MCP card and a service card
    it fully explains (e.g. `fb-group` → fb-group-scraper) fold into it; recipes still match the old ids.
  - **Social media** and **Sites & accounts:** one card per account, merging every sign of it: the site NAMES you have
    saved logins for in Chrome, Brave, Edge, Arc, Vivaldi and Chromium (every profile, macOS and Linux), desktop apps
    (Telegram, WhatsApp, Discord), API key names, MCP servers, CLIs, and accounts you add with **Add account** (your
    public handle or profile link and how agents may use it, saved in `connections.json` and listed in CONNECTIONS.md).
    Each card says what agents can do there and how to connect (official API, CLI, MCP, Claude in Chrome, RSS,
    export). A saved login in Chrome makes a browser-first account ready for Claude in Chrome; a login only in another
    browser, or a service whose CLI/API isn't set up, shows as **Has account**. Logins the catalog doesn't know are
    counted under one collapsed **Other sites** card (hide it if you like); their names never go into CONNECTIONS.md.
    How the login list is read: each profile's `Login Data` file is copied to a private temp folder (the browser
    locks it), only `origin_url` and `signon_realm` are read and reduced to a site name, and the copy is deleted.
    Usernames, passwords and cookies are never read; neither is history, Safari or the Keychain. Banks, payments and
    investing, health, government, dating and adult sites are dropped before anything else sees them. It runs in its
    own process with a 6-second cap (`DECK_LOGINS_MS`); `DECK_NO_LOGINS=1` turns it off. Nothing leaves the machine
    except the usual inventory your hub reads over the tailnet.
  - **Recommended for you:** services worth signing up for (email, analytics, error tracking, newsletters, schedulers,
    scrapers, GPUs, video and music models, game portals…), filtered to what the machine doesn't have yet and ranked
    by fit with your projects and interests from `~/wiki/index.md` and `overview.md`. Each says which project it fits
    and why, whether there's a free tier (well-known facts only; otherwise "check pricing"), the official sign-up link,
    and which recipes it unlocks. The deck never signs up for anything. **Not interested** hides one.
  **Select** cards one by one, or all in the category or search in view, then **Add to** a session (the agent gets
  them as context) or **Use in a recipe**.
- **Recipes** (a tab in Connections): about thirty-five workflows that combine your connections: ship-and-show, YouTube
  channel → RAG → wiki digest, morning revenue brief, nightly repo health, render on the Linux box, cross-post a short
  to YouTube/TikTok/Instagram as drafts, 2027 prophecy mentions on Reddit and HN, a weekly X thread or newsletter
  issue from the wiki, a launch kit, consistent social profiles, and more. Each
  shows which connections it needs and whether this machine has them; ready ones sort first. **Run** opens the New
  session dialog with the prompt, folder and agent filled in (nothing starts until you press Start). **Copy prompt**,
  or **Customize** to save your own copy in the hub's `~/.config/herdr-deck/recipes.json`. Built-ins live in
  `plugins-builtin/connections/recipes.ts`. Each machine writes the full list to `~/.config/herdr-deck/CONNECTIONS.md`;
  your notes, hidden cards and additions live in `~/.config/herdr-deck/connections.json`.
- **Discover** (`d`, or ⌘K): repos worth forking and ideas worth building.
  - **For you** starts with an evidence shortlist, which can be empty. New problem leads come from dated
    public excerpts; AI may suggest an offer but cannot certify demand. Stages come from reviewed sources
    and recorded tests: Untested idea → Problem documented → Buyers interested → Customers paid →
    Customers returned. Paid stages are owner-reported, not independently verified payments.
    There are no AI confidence scores, sales forecasts or “fastest to first dollar” rankings.
    **Find new problem leads** explicitly starts public research and one bounded Claude call for up to six
    suggestions. Opening Discover does not start generation or external refreshes. Missing, old or undated
    source material produces fewer leads or an empty result; source failures remain visible.
    **Review evidence** and **Plan a buyer test** open the shared Opportunities notebook inside Discover.
    Original excerpts, source dates, unresolved questions and failed tests remain visible. Set the offer,
    audience and pass/fail conditions before recording results. Earlier generated ideas remain collapsed
    under **Untested ideas and earlier work**; old scores cannot put them on the shortlist. Saved and
    reviewed card snapshots survive daily replacement. Build tools and existing starter kits remain in
    each idea’s detail panel. Data lives in `~/.config/herdr-deck/gallery/`; the daily Claude call cap still
    applies (`DECK_GALLERY_CLAUDE_MAX`). The old recipe and model-judging settings apply only to the lab.
    See [Discover evidence rules](docs/discover-evidence.md) for the exact stage and shortlist rules.
    Below the gallery: your interests, read from the wiki (project tags, status and recency, concepts, the last month
    of `log.md`), your local repos (languages, keywords, dependencies) and your connections, as chips you can
    add to or remove. For each one the deck searches GitHub with `gh` for hidden gems: 30–5,000 stars, pushed in
    the last six months, licensed, not archived or a fork, not yours or already cloned. They're ranked by fit ×
    momentum (stars a month), and each card says which interest and projects it fits. **Fork & explore** opens the
    New session dialog with a prompt to clone it and judge how to build on it; Save and Dismiss are remembered.
    A **Trending in your areas** row shows new repos climbing fast. Results are cached for hours
    (`~/.config/herdr-deck/discover-cache.json`), refreshed on request, and marked when stale.
    **Ideas** (the legacy tab): an unvalidated feed of businesses, apps and services made from what you
    have, in rows: Make money this month, SaaS for your audience, Automations that sell, Content engines, Built from
    your projects, Remix a gem, Weekend builds, Wild combos. Headless Claude (Haiku) writes it in batches, six calls in
    parallel on the first view of the day, each seeded with different combinations of your things; ideas stream in
    as they complete. Every idea passes a quality gate (a specific customer, a real price, an MVP your real inventory
    can build, a launch plan, a first week of tasks, nothing generic), then a cheap critic pass scores them and drops
    the weak ones; duplicates (same ingredients or nearly the same title) are dropped too. **More like this** asks
    for one row again; **More ideas** (or reaching the end) asks for the next batch. A card shows the name, pitch,
    price, time to first dollar and the stack; **Open plan** shows the whole plan: customer, problem, offer, pricing,
    MVP scope, the stack mapped to your projects and connections, the first 10 customers, the first week, cost to run
    and risks, with **Build it now**, **Research & plan it**, **Find users for it**, **Open in Studio**, Save and Copy.
    Cached for the day in `~/.config/herdr-deck/feed.json`; templates only when no model answers at all. Code:
    `src/feed.ts`.
  - **Studio:** a chat that assembles things out of everything you have. Ask anything ("something for my HD audience
    that makes money on autopilot", "what can I build this weekend?"); it answers in a sentence or two plus
    execution-ready build cards (the same plan as the feed), a clarifying question with tappable answers when your
    ask is ambiguous, and follow-up chips. Inventory names in an answer are chips: tap one to add it to your picks.
    The first screen shows how much you have, **Dice** (a sensible random combo) and **Wildcard** (somewhere
    unexpected), and a deck of starter prompts by intent (Make money, Grow an audience, Automate my life, Weird &
    wonderful, Weekend hack, For my HD community, Ship something today, Remix a gem, Cross-machine power, Local &
    private), filled with your real projects and connections; **Shuffle** deals new ones. **Ingredients** opens a
    searchable picker (a side rail when there's room, a bottom sheet on a phone); what you pick rides along with your
    next message. Every build has **Build it now** (the New session dialog, prefilled with a complete implementation
    brief, in the project's folder or a new `~/Documents/Projects/<slug>`), **Research & plan it**, **Find users**,
    **Riff on this**, Save and Copy. Nothing starts until you confirm the dialog. Conversations are kept in
    `~/.config/herdr-deck/studio/` (the title menu lists, renames and deletes them). Engines: Claude Haiku (fast,
    default), Claude Sonnet (deeper), any local Ollama model (private), or instant templates; answers stream, **Stop**
    keeps what arrived, every run has a time limit and falls back to template combinations. Enter sends, Shift+Enter
    starts a new line. The model sees a compact catalog of your inventory (names and one-liners, secrets redacted),
    the recent turns and your message: no wiki pages, no secrets, no session content. "Mix this" on a gem, "Mix
    these" in Connections and "Open in Studio" land in the Studio's picks. Code: `src/studio.ts`,
    `src/studio-prompts.ts` (the prompts, the starter deck, Dice) and `src/mix.ts` (the engines and the combiner).
  - **Idea lab:** describe any idea. Enter searches GitHub for its building blocks (grouped by the role each
    could play) and topics, and shows which of your projects and connections fit. **Research & plan it** opens a
    new Claude Code session, prefilled, that researches what exists and writes a plan (architecture, the exact
    repos and services, build order, costs and risks, first three tasks) to `~/.config/herdr-deck/ideas/<slug>.md`.
    **Sparks** are "what if" ideas combined from your interests, projects, connections and gems.
  - **Leads:** find the people who need an idea (**Idea → people**), or what an audience needs (**People → ideas**).
    The instant pass searches public posts on Hacker News, Reddit (its keyless search feed, one request a search,
    rate limit respected), GitHub issues (two `gh` searches, sharing Discover's budget), Stack Exchange and App Store
    reviews in parallel, each with a timeout, and streams them in with a status chip per source. Posts are scored for
    pain ("is there an app", "I wish", "would pay"…) × engagement × recency, deduped, and clustered into pain themes,
    each with quotes and links, an app idea, **Plan the app for them**, **Research & plan it**, **Save** and **Copy
    evidence**. Also: where they hang out (subreddits, threads, repos, apps) and who's already building it.
    **Deep dive with last30days** opens a prefilled session that runs the `last30days` skill (Reddit, X, YouTube,
    TikTok, HN, Polymarket, web) and writes a report to `~/.config/herdr-deck/leads/<slug>.md`, listed under Reports.
    Starters from your world, **Shuffle** and **Surprise me** (an audience picked from your interests). Only the query
    words leave the machine; nothing is posted and nobody is contacted; emails and phone numbers are stripped.
    Cached per query in `~/.config/herdr-deck/leads-cache.json`. ⌘K has it too; `leadsFor(text)` opens it from code.
  - **Research:** autoresearch campaigns. Give a goal (presets come from your wiki), optional seeds, a run budget,
    a daily cap and quiet hours; after you confirm a summary, the deck runs research sessions one at a time: headless
    Claude plans each next question from what earlier reports found (a built-in planner fills in), a Claude Code
    session labeled "research: …" runs it with `last30days` and web search and writes a report with scores and a
    JSON block of findings to `~/.config/herdr-deck/research/<campaign>/`, and the deck scores it (a rubric, plus
    Jev's chance of 10 paying customers in 60 days), keeps or discards it, and closes that session. Only niches with a
    named buyer, a linked place they gather, an observed price and linked pains reach the leaderboard; unsourced or
    generic reports are discarded. Pause, Skip, Stop and a kill switch; two failed runs in a row pause it; pushes when
    it finishes or finds a new top niche. It only ever closes its own sessions and survives restarts without starting a
    run twice. `DECK_RESEARCH_FAKE=1` simulates sessions for testing. Code: `src/autoresearch*.ts`.
    Code: `src/leads.ts`.
  - **Ideas:** the plans, rendered, with the session that wrote them and **Start building**.
  - Only interest keywords and the words of your idea go to GitHub. Nothing starts until you confirm the
    dialog. Your chips, saves (repos, mixes and builds, with their plans) and dismissals live in `~/.config/herdr-deck/discover.json`.
- **Projects** (⌘K "Projects" or "Project: <name>", the journey icon on a Projects group header, the project name in a
  session's header, or a link `/p/<project>`): a page for every project. A journey graph runs from the origin (your
  first prompt, the first commit, the wiki's words) through every sitting of commits, session, wiki entry, tag and
  deploy to now and a dashed "heading" into the future; turns where it changed direction bend the line, side quests
  (merged or abandoned branches, worktrees, spin-off projects named after it) fork off as lanes, and milestone flags
  sit where they were unlocked. Drag, ⌘/ctrl-scroll or pinch to zoom; tap any point for what happened and a link to the
  session, commit or wiki page. On a phone it runs top to bottom. Below it: a milestone ladder written for the project
  (users, revenue, releases, stars, views… by kind of project) that unlocks only from evidence (git, deploy config,
  wiki entries that say it shipped, GitHub via `gh`, Gumroad sales for a matching product when your Gumroad MCP server
  has a token, the deck's session history) or from what you log (**Log a metric**, **Mark unlocked…** with a note);
  the original idea, the story so far, where it's heading, side quests, every session and metric sparklines.
  **Start a session here** and **Plan the next milestone** open the New session dialog prefilled. The AI read (turns,
  side-quest names, the ladder, the story) is one headless Claude Code call (Haiku, low effort, no tools) on the first
  open, at most daily after that, or on **Regenerate**; only titles, dates, commit subjects and counts are sent, and
  simple rules fill in without a model. `DECK_JOURNEY_AI=0` turns the model off; `DECK_JOURNEY_ENGINE=ollama` uses a
  local model. Cached in `~/.config/herdr-deck/journeys/` (your entries in `journeys/manual.json`). Code: `src/journey*.ts`.
- **Quests** (`q`, the Quests tab, ⌘K, or the level chip in the list header): a quest board for turning projects into a
  business. Pick one project as the **main quest**: its proofs count double, and switching within a day asks first. XP
  comes only from evidence someone else could check, each ledger line linking it: a release or tag, a wiki entry that
  says something shipped (not a draft, preview or plan), a milestone unlocked by a business number, each Gumroad sale, a
  number you log with a note, a lead you contacted (its link), a conversation you logged (a note), a passing
  proof-of-done check, a merge (checks and merges only a few a day). Never commits, sessions or lines of code; the same
  evidence never pays twice (commits shared by worktrees of one repo pay once). Other projects are side quests, sharing
  a daily allowance of 30% of the main quest's XP (at least 50). **Retire** a dead project for the "killed a zombie
  project" achievement. Each day: three quests for the main quest, written by one headless Claude Code call (Haiku, no
  tools) from its next milestone, its boss, fresh leads (Discover → Leads, only posts you can answer), the live site and
  the product; a quest that names nothing real about the project ("engage with your audience") is thrown away, and
  templates built from the same state fill in, or the board shows fewer. **Start** opens the New session dialog
  prefilled; **Do it yourself** shows the checklist and the leads' links; **Done…** checks one off with a link or a
  note; two **Rerolls** a day swap in spares. **Bosses** are the main quest's money and user milestones, with health
  from the real number (Gumroad sales and 30-day revenue, or what you logged) and every proof that moved it as a hit.
  **Founder levels** (Maker → Shipper → Seller → Founder → Operator) unlock only from business milestones across every
  project; XP fills the bar inside a level. A streak counts days you shipped, sold or talked to users. The **season**:
  a one-sentence goal for the week, a scoreboard, lessons, and Jev's read of whether the evidence meets the goal (you
  can dispute it; that's recorded as a Jev outcome). `startRun(idea)` (for the gallery's Play button) turns an idea into
  a project with a business milestone ladder and opens the New session dialog for its first quest; the folder is made
  only when you confirm. Hub only; state in `~/.config/herdr-deck/game/` (`DECK_GAME_DIR` moves it; the ledger only
  grows). `DECK_GAME_AI=0` writes quests from templates only. Code: `src/game*.ts`.
- **Simple mode** (Settings, or ⌘K): big type, only the essentials (no terminal, tool calls, meters or
  tabs), friendly status words, and cheerful colors tuned for every theme.
- **Themes:** System, Harbor, Light, Midnight, Nord, Solarized, Paper, High contrast, Dracula, Catppuccin
  Mocha and Latte, Tokyo Night, Gruvbox, Rosé Pine, Everforest, One Dark, GitHub Light, Monokai.
- **Plugins**: add integrations and whole working setups to the deck: a Gmail inbox, your GitHub pull requests, or (soon) a
  business pack with its projects, agent roles and schedules. A plugin is data only (a `plugin.json` and some
  prompts), never code. Before anything is installed you get a trust screen built from what the plugin can
  actually do: the exact tools its agents may use, the repos it would clone and the agents it would start.
  Install from the built-in catalog, or drop a `plugin.json` or `.zip` on Plugins → Add.
  The deck's own extras are **code plugins** you can switch off in Plugins → Built in (Covers first; the rest are
  moving over): a part that's off stops running and leaves the page. You can also add a code plugin from a folder or
  a git repo pinned to a commit; its red trust screen says plainly that it runs with your full permissions, and any
  file changed after you approved it turns it off until you review it again.
- **Operator plugins** (built in, off until you switch them on in Plugins → Built in). Anything that starts a
  session, sends a message or deletes a file shows exactly what it will do and waits for your OK.
  - **Dual review** (Review): Claude and Codex review the same diff in two sessions; the Review view lines up
    their findings (both found / only one) and sends the ones you pick back to the session that made the change.
  - **Worker fan-out** (Workers): one brief to several workers, each writing `REPORT.md` and a `DONE` marker; the
    board tracks them and Collect merges the reports into one message.
  - **Limit handoff**: when an account passes 90% of a 5-hour or weekly limit (or an agent prints its limit
    line), offers to continue in Codex or another agent with a handoff note, in a prefilled New session dialog.
  - **Release train** (Releases): QA → staging → production per repo: what each stage is at, what's waiting,
    health; Promote starts an agent session with a deploy brief (the deck never deploys by itself).
  - **Private sessions** (⌘K): a throwaway folder kept out of History and search; when it closes you can delete
    its transcript files, listed one by one first.
  - **Ship tracker** (Shipped): started versus shipped per project from the wiki's project pages, git tags and
    session history, with busy-but-not-shipping projects on top and a line in Monday's digest.

## MCP server

Agents can use the deck: `POST http://127.0.0.1:4747/mcp` (streamable HTTP), with a bearer token from
`~/.config/herdr-deck/mcp.token`. Tools: `deck_sessions`, `deck_session`, `deck_search`, `deck_history`,
`deck_decisions`, `deck_connections`, `deck_send`, `deck_start`. Closing is not offered; `deck_start` can't ask
for skip-permission modes; every send and start is logged to `~/.config/herdr-deck/mcp-audit.jsonl` and shown
in the deck. The Connections view has the `claude mcp add` command.

## Dev servers and tailnet links

The deck sees which ports each session's processes listen on (and servers started from its project folder),
and shows them in the session header. **Share** puts one on your tailnet with `tailscale serve` (never Funnel)
and opens the link.

## The list

- A colored band shows status: working (amber), needs input (red), finished and unseen (blue), idle (green), empty (dashed grey).
- Each project gets its own color, shown in the list, in group headers and across the top of the details panel.
- Each row shows the title, project, agent, branch with changed-file count, last activity and the last output line.
- Flags: `empty`, `dup` (two panes on one conversation), `stale` (no activity for 2+ days) and `heavy` (over 1.5 GB).
- Search takes `-word`, `is:stale`, `is:dup`, `is:empty` and `agent:codex`.
- **Fleet workers** (sessions another session started in a pane of their own, like Conductor's `factoryctl dispatch
  launch`) sit under the session that dispatched them, one level in, with their brief (⚡ #PS1). The dispatcher's row
  says how they're doing ("3 workers · 1 running · 2 done") and folds them away (click the line, or `w`); a worker
  that needs you stays in sight, and lifts its dispatcher up the list. Workers whose dispatcher isn't open sit together
  under a dimmed line naming it. `p` opens a worker's dispatcher; Info lists a dispatcher's workers. The links come
  from the machine's ledger, `~/.config/herdr/dispatch-map.json` (`{ "<worker session id>": { "src": "<dispatcher's
  name>", "brief": "PS1", "src_sid": "<dispatcher session id>" } }`, `src_sid` optional; other tools can write the same
  shape to `~/.config/herdr-deck/dispatch-map.json`), or herdr's `$src` token. Claude's in-process subagents are
  something else: the "N subagents" badge and the inspector's Subagents tab.
- Filter by status, agent or project. Sort by what needs you, last active, newest, project, memory or context size.
  Group by project, status, agent or workspace.

## Details

- **In short**: three lines covering what the session is for, how it started and where it stands.
  A local Ollama model (`gemma4:e4b` by default; set `DECK_BRIEF_MODEL` to change it) writes them on request,
  so conversation text never leaves your computer. Briefs are cached in `~/.config/herdr-deck/briefs/`.
- **How it started**: your first message, quoted in full.
- **Recap**: Claude's own recap (`away_summary`) when there is one, otherwise the agent's latest reply.
- **Images**: screenshots you pasted and images the agent looked at, with a full-size viewer.
- **History**: every request with the reply it got, oldest or newest first.
  It also shows compactions, total agent work time, context size, memory, spend and the resume command.

Sources: Claude `~/.claude/projects/*.jsonl`, Codex `~/.codex/sessions`, OpenCode `opencode.db`.
Transcripts are read incrementally: after the first read, only newly appended bytes are parsed.

## The inspector: terminal, subagents, servers

The open session's extras live in a column on the right, the **inspector**. Show or hide it with `]` (or `\`), the
panel button in the session header, or ⌘K; `` ` `` moves to its next tab. Drag its left edge to resize it; each
device remembers whether it's open, its tab and its width. On the phone it is the screen behind the top bar's second
tab (swipe back as usual). Its tabs:

- **Terminal** mirrors the pane live, in color, fitted to the pane's width. Click it (or press `t`) and your
  keystrokes go to the pane: letters, Enter, Esc, arrows, Tab, Ctrl/Alt combinations and pasted text. Click outside
  or press `Ctrl+]` to stop. **Keys** sends common answers (esc, enter, 1/2/3, y/n) in one click.
- **Subagents**: every subagent of the session, the running ones first. Open one to read its conversation in the chat.
- **Servers**: the dev servers the session runs. **Open** it, **Share** it on your tailnet (for your phone), or
  **Preview** it right in the column. The header's "N servers" chip has the same actions in a menu.

Plugins can add tabs of their own (the `inspector.tabs` point; see `public/js/inspector.js`).

## Starting and closing sessions

- **New** (`n`): choose Claude Code, Codex, OpenCode or a plain shell, a folder (recent folders and
  your project folders are suggested; see `DECK_PROJECT_DIRS`), optional flags and an optional first message.
  Codex offers **Codex app** or **CLI in herdr** when the native integration is installed on that host.
  Native tasks open in Codex; CLI sessions open a herdr tab,
  waits for the shell prompt, starts the agent through herdr's API and sends the message. Progress appears
  as notifications, and the new session is selected as soon as its tab exists.
- **Close** works on one session or a selection. A confirmation lists what will stop, warns about anything
  still working, and shows the memory it frees. Afterwards, **Undo** on the toast (or ⌘Z) reopens them.
- **Closed** keeps closed agent sessions with a **Reopen** button, which resumes them in a new tab.
- **Close candidates** selects empty sessions, the older copy of each duplicate, and anything untouched for a week.
- **Jump to pane** (`f`) switches herdr to the pane and brings WezTerm forward (set `DECK_TERMINAL` to change the app).
- **Notifications** (Settings → Notifications on this device…): push alerts, see below.

## How it stays fast

- One Bun process, no dependencies, no build step. It talks to herdr's Unix socket directly (≈1 ms per call).
- It subscribes to herdr's event stream and re-snapshots on change (coalesced), with a 2 s safety poll.
- The browser gets the full state inlined in the first HTML response, then row-level patches over SSE:
  only rows that changed are sent, and only those DOM nodes are touched.
- Row data comes from the head and tail of session files and is cached by size and mtime. The detail view parses
  transcripts incrementally, so an active 35 MB file costs about 1 ms after the first read (about 150 ms). OpenCode data is
  cached by `time_updated`. Fonts are bundled locally.

## Notifications and automations

The hub sends standard Web Push (VAPID, payloads encrypted for each device per RFC 8291, all with WebCrypto;
no dependencies). The push service (Apple, Google, Mozilla) only relays ciphertext, so the text shows even
when the phone can't reach the Mac; tapping it opens the session (`/s/<machine>/<agent>/<session>`).

- **Settings → Notifications on this device…**: turn on (asks for permission and subscribes), send a test,
  turn off, name the device, and choose what it gets: needs you, finished, the morning digest, quiet hours, today's
  quests in the digest (on by default) and quest pushes (a quest done, a boss hit or defeated, an achievement, the
  Sunday review; off by default).
  Other subscribed devices are listed and can be removed. Where push isn't available the old page-only alerts
  remain (they only work while the deck is open).
- **iPhone:** open the tailnet link in Safari → Share → Add to Home Screen → open herdr deck from the Home
  Screen → Settings → Notifications on this device… → Turn on → Allow → Send a test.
- **Settings → Automations…** (hub rules, for every machine; each shows its last run and result):
  - *Needs you and finished alerts:* one push per session per change, after a 5 s grace period (nothing if it
    moved on or you opened it), no repeat for the same session within 90 s, three or more at once become one
    push, and nothing for a session that is open on a screen.
  - *Morning digest* (default 08:30, up to three hours late if the Mac was asleep): waiting on you, finished
    since yesterday 18:00, still running, idle 3+ days. Pushed, and shown as a card at the top of the Live board
    until dismissed. "Show digest now" and "Push it now" run it on demand.
  - *Empty sessions:* a single card on the Live board when shells or agents have had no conversation for over
    an hour (configurable), with Close all… through the normal confirmation. Nothing closes by itself.
  - *Proof of done:* the auto-verify switch (on by default).
- Files, on the hub: `push.json` (the VAPID key pair, mode 600), `push-subs.json` (devices and their choices,
  mode 600), `automations.json` (rules and last results), all in `~/.config/herdr-deck/` (`DECK_PUSH_DIR`
  moves them). Subscriptions the push service reports gone (404/410) are dropped. Only the hub sends: a deck
  that a hub is talking to (a node) refuses subscriptions (`DECK_ROLE=hub|node` overrides the guess).
  `DECK_PUSH_SUBJECT` sets the VAPID contact (a `mailto:` or `https:` URL).

## Security

Binds to 127.0.0.1 only. Local requests must use a localhost `Host` header, which blocks DNS rebinding.
Requests through `tailscale serve` are accepted only when Tailscale stamps them with the machine owner's login
(`Tailscale-User-Login`; override with `DECK_TS_USERS`). Every action also needs a per-process token that only the page itself receives. The Closed list lives in
`~/.config/herdr-deck/graveyard.json`.
The MCP token only works on `/mcp`, which can't close anything. Jev gets trimmed recent output with home paths,
emails and anything key-like scrubbed (and the `jev` CLI redacts again).

Found a security problem? Please report it privately; see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. The code is plain TypeScript run by Bun with no dependencies and no
build step: `src/` is the server (`src/server.ts` wires the parts in `src/http/`), `public/` is the page (`index.html`
plus the scripts and styles `public/assets.json` lists). `bun run dev` runs it with reload and `bun test` runs
the tests. [AGENTS.md](AGENTS.md) has the conventions (it's also what coding agents read), including
**Write a plugin in 5 minutes**: `bin/new-plugin <id>` scaffolds a working code plugin with a test, and
`bun run dev:plugins` reloads it live as you edit it.

## License

[MIT](LICENSE)
