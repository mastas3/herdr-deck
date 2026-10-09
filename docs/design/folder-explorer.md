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

Remote routing is checked with a fixture; a real remote-machine shell was not launched for this change. The production deck on port 8448 is not modified by the preview.

## Validation in this checkout, 2026-10-09

The existing prototype was integrated into this checkout with its unrelated changes preserved. Refinements add keyed DOM updates, roving keyboard focus, empty-folder search, temporary search expansion, pointer order freezing, explicit reduced-motion handling and missing-directory terminal rejection. Go to folder preserves drafts across updates and ignores results after cancellation.

- Full suite: 1,403 passing tests, zero failures.
- Explorer browser journey: desktop and phone checks, zero page errors and no agent mutations. Real local folder/PTY tests cover exact working directory, and remote routing uses a fixture.
- Existing terminal journey: 30 desktop and 29 phone checks passed.
- Terminal plugin disabled: desktop and phone explorer snapshots have zero page errors and no terminal buttons.
- Reviewed screenshots: `/tmp/deck-explorer-validated/`; test logs: `/tmp/deck-explorer-all-final.log` and `/tmp/deck-explorer-browser-final.log`.

Private sample-data preview: https://stas-2s-macbook-pro.tail2a005b.ts.net:4776/ (a separate scratch HOME; this is not the production deck). Preview process metadata is under `/tmp/deck-explorer-preview-v2/`. To stop the preview, terminate the process group whose leader is recorded in `process.pid`, then run `tailscale serve --https=4776 off`. Production port 8448 was not changed. The remote node must include the new browsing endpoint to list previously unknown remote folders; live remote browsing was not tested in this task.
