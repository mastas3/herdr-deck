# Aether: first project island

Aether is a built-in, switchable view of one existing agent session. Open the **Aether** tab, choose a companion, and bring it to the island. A session's menu also offers **Visit this session’s Aether island**.

The island follows that session's working, blocked, done, idle or disconnected state. It shows the latest written agent update and six recent user/agent messages. **Reply in this session** opens that exact session in the deck's existing chat. Sending, queueing, reconnecting and approving requests remain the existing deck interactions. Opening Aether or tapping Reply never sends a message itself.

The selected identity includes the session id, pane key, machine, agent, folder and project. A reused pane or moved session becomes unavailable until the user selects it again. There is no fallback to a different session. Only the identity is stored in browser storage; chat content remains in memory. Reads are bounded to 40 recent messages, coalesced, and made only while the view is visible.

## Local previews

Run from this checkout:

```sh
# Synthetic data only; useful for UI verification.
bun bin/aether-preview.ts --fixture
# http://127.0.0.1:4768/?view=aether

# One exact session from the running deck; substitute its observed key.
DECK_PREVIEW_PORT=4769 bun bin/aether-preview.ts --session='<exact-row-key>'
# http://127.0.0.1:4769/?view=aether
```

The live preview reads the existing deck at `127.0.0.1:4747`. It pins the first observed full identity for the supplied key, filters state down to that session, and forwards only its `/api/chat` reads. All live mutation routes are refused. It reuses the running deck's action token in memory, creates no credentials, binds only to loopback, checks Host and Origin, and makes no network configuration changes. Reply navigates to that exact session on the running deck.

Stop either foreground preview with Ctrl+C. No launch agent or persistent service is installed. The preview is not exposed over Tailscale.

## Approved artwork

The coordinator supplied Library item `libfile_3874152db580819187127f9a2ca95862`, **Aether-world-reference.zip**, version 0. After the supported transfer failed, the user downloaded it to Downloads and authorized extraction into Projects. The archive was CRC checked and every member checked for traversal, absolute paths, duplicate paths and symlinks before exclusive extraction into `/Users/stas-2/Documents/Projects/aether-world-reference`.

`plugins-builtin/aether/art/world.webp` and `art/aether.webp` are unchanged copies of the inspected approved images. The garden is 1536×1024. The 1536×2288 atlas has eight columns and eleven rows, with 192×208 cells displayed at half size. Working uses row 7, blocked uses row 6, completed uses the row 3 wave, and resting uses row 0. Reduced motion and disconnected states stop animation. The original rune puzzle and hosted-game code were not copied.

Archive SHA-256: `b439f9aa17136a014feb6c56118ffddb0b73fcd8b98289baf00a458460894f6a`.

## Verification

```sh
bun test
node bin/aether-ui-check.mjs /tmp/aether-ui
node bin/ui-snapshot.mjs --out /tmp/aether-native --port 4772 --views aether,codex-approval,codex-connect-send,codex-connect-failed
node bin/ui-snapshot.mjs --out /tmp/aether-off --port 4773 --views home --plugins-off aether
```

The UI check requires the fixture preview on 4768 and the repo's existing global Playwright, or `PLAYWRIGHT_PATH`. It intercepts browser writes and verifies target selection, Escape/Cancel, history retention, coalesced reads, reused-target protection, offline/read-error recovery, repeated Reply clicks, the native composer handoff and Android back/close behavior. No real session receives test input.

The repository does not configure a separate TypeScript typecheck. Bun tests and JavaScript syntax checks are used here, following its existing dependency-free workflow.

## Activation

The user authorized applying the completed changes and briefly restarting the existing `dev.herdr-deck` launchd service after checks pass. Recheck the running checkout for concurrent changes, apply only this branch's changes, and restart the existing service directly. Do not rerun the installer: it can rewrite settings and the Tailscale route. No dependencies, build, migration, credentials, or network changes are required. Once activated, the existing phone URL can use `/?view=aether` with the same authentication. Choose one companion on each browser; that explicit choice is stored locally.
