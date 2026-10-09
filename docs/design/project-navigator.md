# Project navigator

Projects is the default explorer view. It shows each physical machine, the projects with open sessions on it, and those sessions. All folders switches to the original filesystem tree with lazy directory browsing and directory terminals. Each view remembers its own open branches. Projects never scans directories just because a project or computer is expanded.

Project identity is the physical machine plus its full project path. Linked worktrees join their repository's project, and local Codex app tasks join the local computer. Empty shells and empty directories do not create projects. Quiet sessions stay available so work can be resumed after days away; attention and working projects appear first. Existing priority and project-list layouts remain available.

## Sessions and agents

A session shows its task title, a short purpose excerpt, live state, model, effort, context percentage where known, and conversation age. Details expands in place without changing the open chat: opening request, latest request/update, model/effort, context tokens, transcript bytes, process RAM, process uptime and account limits. Account limits are explicitly shared; old readings and unknown values are labeled. Conversation age is not presented as continuous runtime, and transcript size is not process memory.

Purpose and latest-request/outcome excerpts come from the existing incremental transcript parser. An already-loaded local brief can supply the purpose. This view does not launch model calls, generate speculative summaries, or copy conversations to another service. OpenCode's shared database does not provide a per-session transcript-file size; that field remains unreported rather than showing the database's size.

Native Claude, Codex and OpenCode subagents use the deck's existing transcript/index readers. Fleet workers, including Conductor dispatches, use the existing dispatch ledger and parent links. Workers nest once under their dispatcher; same-ID native/fleet entries are not counted twice. Worker-only search brings the parent along as context. Missing or ambiguous dispatchers stay explicit, and cycles cannot create recursive rendering. Running native agents appear first; older inactive ones are behind Show earlier agents. Selecting a native agent opens its conversation; selecting a fleet worker opens that session.

## Interaction and motion

Project/folder selection, directory terminals, contextual new sessions and Go to folder share the existing navigator. Go to an arbitrary directory switches to All folders. Keyboard arrows traverse project and agent branches. Keyed updates preserve controls and focus; live ordering freezes under the pointer. Project expansion, agent disclosure and view changes use short opacity/transform transitions with bounded staggering and measured row movement. Both OS and deck reduced-motion settings are respected.

## Validation

- `bun test`: project identity, worktrees, physical-machine grouping, worker parent context, orphan/cycle handling, native/fleet deduplication, overview provenance, metadata and existing regressions.
- `node bin/ui-explorer-journey.mjs /tmp/rook-projects-ui`: project checks in `bin/ui-projects-checks.mjs`, followed by the complete existing folder/terminal journey. Uses a disposable HOME, fake sessions and local test PTYs; no real agent messages.
- Browser checks cover desktop/phone layouts, in-place details, account limits, nested native/fleet agents, historical-agent disclosure, keyboard navigation, live-update focus, independent persisted view expansion, search context, reduced motion and overflow.
