# Folder explorer

The default navigator is now a directory tree: machine → folders → sessions. Several branches can stay open at the same time, beside the existing chat. Priority and project grouping remain in the view switcher; `g` cycles through all three.

- A machine is its home folder. Sessions outside that home appear under Filesystem.
- A folder click opens or closes it. Explicitly opening a folder reads its immediate subdirectories; the initial view uses inlined session state and makes no directory requests.
- Folder names use full path + physical machine identity. Same-name projects never merge; local Codex app sessions sit under the local computer.
- A terminal button and the folder menu open a standalone shell at that exact path. New session uses the selected folder too. Terminal controls require the Terminals plugin.
- Go to folder accepts `~/…` or an absolute path and a machine. Empty directories work without any sessions.
- Right-click or the visible `•••` button exposes folder actions. Arrow keys traverse the tree; Left/Right close/open a branch; Enter opens a session.
- Live updates preserve the actual folder controls, keyboard focus and typed folder paths. Session order freezes under the pointer, like the existing list.
- Search finds loaded empty folders as well as sessions. Its expansion state is temporary, so clearing the search restores the previous branches.
- Open terminal in the command palette uses the selected directory while in the explorer; a machine filter still takes precedence over an out-of-scope selection.
- Open branches persist on this browser. Selecting through the palette reveals its ancestors without closing other branches.
- Warm SVG folders open with their contents. Neighboring rows move using measured transforms, outgoing contents fade, and the terminal panel slides in. Both OS and deck reduced-motion settings disable motion.

## Implementation

`public/js/explorer-model.js` builds the pure hierarchy, `explorer.js` renders it, `explorer-dom.js` reconciles keyed DOM elements, and `explorer-events.js` handles folder interactions. `public/css/explorer.css` uses existing theme tokens and bundled fonts.

The authenticated `/api/browse-folders` endpoint returns directory names only, asynchronously, at most 500 per listing. It accepts configured machine routing and refuses credential directories, including symlink targets. It does not change file-viewer policy. Older remote nodes need the updated endpoint to browse previously unknown folders; their inlined sessions remain navigable.

Terminals exposes `folder.terminal` through the client registry. The core imports no plugin code. The plugin sends a validated `cwd` with tmux `new-session -c`, escaping tmux format syntax in literal paths. The target machine checks the directory before creating a shell, because tmux otherwise silently falls back to HOME for missing directories. The existing tmux capture/polling terminal remains; this change does not replace it with a full terminal emulator.

## Validation

- `bun test`: full repository suite.
- `bun test test/explorer.test.ts plugins-builtin/terminals/test/terminals.test.ts`: directory identity, nesting, home metadata, symlinks, private folders, remote routing, real shell working-directory checks, and terminal lifecycle.
- `node bin/ui-explorer-journey.mjs /tmp/deck-explorer-ui`: isolated HOME, synthetic sessions, real directory reads and tmux shells, desktop/phone dark/light screenshots, branch persistence, keyboard navigation, search, empty folders, remote routing fixture, and reduced motion.
- `node bin/ui-explorer-journey.mjs /tmp/deck-explorer-preview --preview --keep`: leaves an isolated interactive demo on loopback port 4776 (`--port` overrides it). No real agent sessions or personal data are loaded.

The isolated journey uses a fixture for remote routing. Live Mac/Linux browsing and shell checks were also completed during the production rollout below. The preview never changes the production deck or its tailnet route.

## Validation in this checkout, 2026-10-09

The existing prototype was integrated into this checkout with its unrelated changes preserved. Refinements add keyed DOM updates, roving keyboard focus, empty-folder search, temporary search expansion, pointer order freezing, explicit reduced-motion handling and missing-directory terminal rejection. Go to folder preserves drafts across updates and ignores results after cancellation.

- Full suite: 1,403 passing tests, zero failures.
- Explorer browser journey: desktop and phone checks, zero page errors and no agent mutations. Real local folder/PTY tests cover exact working directory, and remote routing uses a fixture.
- Existing terminal journey: 30 desktop and 29 phone checks passed.
- Terminal plugin disabled: desktop and phone explorer snapshots have zero page errors and no terminal buttons.
- Reviewed screenshots: `/tmp/deck-explorer-validated/`; test logs: `/tmp/deck-explorer-all-final.log` and `/tmp/deck-explorer-browser-final.log`.

The sample-data preview on port 4776 used a separate scratch HOME with one configured machine. It was stopped after production verification; the earlier preview on port 4774 was left alone.

## Production rollout, 2026-10-09

Explorer commit `28e5f4b` was merged into `main` and pushed. Existing local changes, including the concurrent visual identity work, were preserved. The isolated committed release passed 1,367 tests; the integrated production checkout passed 1,406 tests with zero failures. The combined desktop/phone explorer journey also passed.

The Linux node received the six backend files required for directory browsing, with source-hash checks and a rollback copy. The existing Mac launchd and Linux systemd services were restarted. The production tailnet route and configuration were unchanged.

Live verification at https://stas-2s-macbook-pro.tail2a005b.ts.net:8448/ confirmed both MacBook and Linux · work, nested directory browsing, and real terminal working directories on both machines. Only the temporary verification shells were closed. Tokenless directory requests returned 403. Desktop and phone viewport checks showed both computers, remote browsing, no horizontal overflow, and zero page errors. These are browser viewport checks; physical-device testing was not performed.

Evidence: `/tmp/deck-explorer-integrated-tests.log`, `/tmp/deck-explorer-integrated-ui/`, `/tmp/deck-explorer-live-browser.log`, and `/tmp/deck-explorer-live-smoke.log`.
