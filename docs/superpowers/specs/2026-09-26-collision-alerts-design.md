# Collision alerts and worktrees

Status: draft for review · 2026-09-26 · Spec 1 of 3 (build order: collisions → autopilot → goals)

## Why

With many agents running, two of them regularly end up working in the same git checkout. That goes wrong in
two ways:

1. **Same file.** Both edit `src/server.ts`, and one overwrites or reverts the other's work.
2. **Same checkout.** They edit different files, but one runs `git stash`, `git checkout .`, `git reset` or
   `git commit -a` and takes the other's uncommitted work with it.

Today the deck can't see either. It should say so when it happens, help calm the moment down, and above all
stop it happening by starting new sessions in a git worktree. The worktree plumbing built here is reused by
Goals (spec 3).

## Success

- Within a minute of two live sessions editing the same file in the same checkout, both rows show a warning
  and (if enabled) the phone gets one push.
- The New session dialog offers "start in a worktree" when the folder's checkout already has a live editor.
- A session in a worktree shows under its real project ("herdr-deck ⎇ fix-sse"), not as a separate project.
- No false alarms from reads, from sessions that finished long ago, or from different worktrees of one repo.

## Non-goals (v1)

- Edits made through shell commands (`sed -i`, formatters, code generators) aren't tracked. Only edit tools
  are (Edit, Write, MultiEdit, NotebookEdit, apply_patch). The "same checkout" level partly covers this.
- No collisions across machines: different machines have different disks.
- No automatic separating of mixed changes in a shared file. That can't be done safely, so the deck asks.

## Design

### 1. Per-file edit tracking (`src/transcript.ts`)

`Detail.touch` is folder-level and weighted, with no times, which is the wrong shape for this. Add a second map
next to it:

```ts
edits: Map<string, number>; // absolute file path → last time an edit tool wrote it (ms)
```

- `workFromInput(d, name, input, at)` gains the message time. When `EDIT_TOOLS` matches and there's a
  `file_path`/`filePath`/`notebook_path`/`path`, it sets `edits[abs] = at`.
- Codex `apply_patch` input: parse the `*** Update File: `, `*** Add File: ` and `*** Delete File: ` lines.
  Relative paths resolve against the turn's `cwd`/`workdir`.
- OpenCode: its edit/write tool parts carry `filePath`, so they go through the same function.
- Bounded: keep only the newest 500 paths per session, and drop anything under `IGNORE`.
- Incremental parsing already handles appended bytes, so this costs nothing extra per tick.

`Insight` exposes `edits` (a recent slice: the last 60 minutes) to `deck.ts`. It doesn't go over the wire.

### 2. Checkout roots and worktrees (`src/worktree.ts`, new)

A small module with no deck state, so it's easy to test:

- `checkoutOf(path)`: walks up to the nearest `.git` (a folder or a file) and returns that checkout's root.
  Cached per folder. A worktree is its own checkout, which is right: two worktrees never collide.
- `mainRepoOf(checkoutRoot)`: when `.git` is a file (`gitdir: <repo>/.git/worktrees/<name>`), returns
  `<repo>`, otherwise the root itself. Used for display and for per-project settings (proof-of-done approvals,
  autopilot rules), so a worktree inherits its repo's settings.
- `createWorktree(repoRoot, slug, base = "HEAD")`: runs
  `git -C <repo> worktree add -b wt/<slug> <parent>/<repo>.worktrees/<slug> <base>` and returns the path.
  If the branch or folder exists, it adds `-2`, `-3` to the slug. Errors come back as plain text.
- `removeWorktree(path)`: only when `git status --porcelain` is empty. Otherwise it refuses and says why.

`projects.ts` uses `mainRepoOf` so a worktree session's `project` is the repo's name, with a new
`Row.worktree?: string` (the slug) for the "⎇ slug" label.

### 3. Detecting collisions (`src/deck.ts`)

A new pass in `rebuildNow()`, `attachCollisions(rows)`, next to `attachPorts`. It runs on each node over
that node's own rows.

- A session is a **live editor of checkout C** when its pane is open and it edited a file under C in the last
  30 minutes.
- **files**: two live editors of C both edited the same file in the last 30 minutes, and at least one of them
  is `working` now.
- **checkout**: two live editors of C, different files, at least one `working`.

```ts
collision?: { level: "files" | "checkout"; root: string; with: { key: string; title: string }[]; files?: string[] /* relative, ≤5 */ };
```

It's a plain `Row` field, so it goes through `emit()`'s diff and the hub's federation mirror without changes.

### 4. UI (`public/js/collisions.js`)

New client code goes in `public/js/collisions.js` (listed in `public/assets.json`, under 400 lines). `app.js`
only gets the hooks for the row chip and the New session checkbox.

- **Row:** `files` shows an amber "same files" chip naming the other session. `checkout` shows only a small
  "shares checkout" dot (hover or long-press to explain it), because it's common and usually fine.
- **Session header:** one line: "Also editing here: *<other session>* · `src/server.ts`, `public/app.js`",
  with actions:
  - **Tell both** (both levels): sends each session a short note: "Another agent (*<title>*) is editing
    *<files>* in this checkout right now. Don't revert, stash, reset or checkout their changes. Commit only
    your own files, by path. If you need one of those files, stop and tell me." Uses the normal send path.
  - **Pause this one** (files level): sends Esc, then holds a message ("Paused: another agent is editing the
    same files. Wait until I say go.") using the existing held-message queue.
  - **Move to a worktree** (checkout level only, where the files don't overlap): a new built-in prompt tool,
    `move-to-worktree`. It asks the agent to create a worktree with the deck's naming, carry over only its own
    changed files (`git diff -- <its files>` applied there, then restored here), and continue there. Not
    offered at the files level, because a shared file's changes can't be split safely.
- **New session dialog:** when the chosen folder's checkout has a live editor, show "Another agent is
  editing here. Start in a new worktree" (checked by default) plus a slug field (from the first message).
  `startSession` gains an optional `worktree: { slug }`: create it first, then start in that path.
- **Close dialog:** for a session in a deck-made worktree with a clean tree, offer "Also remove its worktree".

### 5. Push (`src/automations.ts`)

A new `CollisionTracker` shaped like `AlertTracker`. It queues when a pair reaches `files`, with a 60 s grace
period (it must still hold) and a 30 min cooldown per pair. A new rule, `collisions: { on: true }`, has a toggle
in Settings → Automations. The checkout level never pushes.

## Errors and edge cases

- A deleted file is still an edit, so deleting while the other agent edits counts as a collision.
- Paths outside `$HOME` are ignored, the same as `touch`.
- Reopening a session re-reads its transcript, so its edits come back with their original times: no fresh
  alarm for old work.
- Worktree creation fails (dirty index, locked ref): the dialog shows git's message and nothing starts.

## Testing

- `test/transcript.test.ts`: Claude Edit/Write, Codex `apply_patch` (relative and absolute), OpenCode edit →
  `edits` with the right times, and reads never counted.
- `test/worktree.test.ts`: a temporary repo, `createWorktree` naming and collisions, `checkoutOf`/`mainRepoOf`
  for the main checkout and a worktree, `removeWorktree` refusing when dirty.
- `test/collisions.test.ts`: `attachCollisions` over synthetic rows and edit maps: files vs checkout, the
  30-minute window, the "one must be working" rule, different worktrees not colliding.
- `test/automations.test.ts`: `CollisionTracker` grace and cooldown.
