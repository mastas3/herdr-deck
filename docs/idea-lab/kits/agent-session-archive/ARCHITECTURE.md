# Architecture: Agent Session Archive

stasclaw (already running as a macOS daemon) gets a new watcher module that tails Claude Code's log directory and Codex's session output files, normalizes each event into a SQLite row, and exposes them over a local HTTP API. A Next.js dashboard deployed on Netlify reads from that API (or a synced read-only SQLite copy) for search and replay. Resend sends a weekly digest built from a SQL query over the same database.

## Components

| component | does | uses |
|---|---|---|
| stasclaw watcher | Tails ~/.claude/logs (Claude Code) and Codex CLI session JSONL output, parses each line into an Event, writes to SQLite | stasclaw (owned), SQLite |
| archive.db | Single SQLite file storing sessions, events, and decisions with FTS5 virtual table for full-text search | SQLite |
| local API server | Small Express/Fastify server inside stasclaw exposing /sessions, /sessions/:id/replay, /search?q= | stasclaw (owned) |
| web dashboard | Search UI, session replay timeline, diff viewer, export-to-JSON/Markdown button | Vercel is not used; deployed to Netlify instead, calls local API via a tunnel or reads a nightly-exported static JSON… |
| digest job | Cron inside stasclaw runs weekly, queries top decisions by session count and diff size, sends email | Resend |

## Data model

- **Session**: id, tool (claude_code|codex|cursor), project_tag, started_at, ended_at, machine_id
- **Event**: id, session_id, type (tool_call|decision|diff|error), timestamp, raw_text, summary
- **Decision**: id, event_id, title, rationale_text, alternatives_considered
- **Diff**: id, event_id, file_path, before_snippet, after_snippet

## Flows

### Ingest a Claude Code session

1. stasclaw watcher detects new file in ~/.claude/logs
2. Parser splits JSONL into Event rows tagged by session_id
3. Decision-type events get rationale_text extracted via regex on 'because'/'decided to' markers
4. Rows inserted into archive.db, FTS index updated

### Search and replay

1. User types query in dashboard search box
2. API runs SQLite FTS5 MATCH query, returns ranked events
3. User clicks a session, dashboard fetches all events for session_id ordered by timestamp
4. Timeline renders tool calls, decisions, and diffs in sequence

### Weekly digest

1. Cron fires every Monday 8am
2. Query top 5 decisions and total sessions per project from last 7 days
3. Render Markdown summary
4. Send via Resend to rpsm90@gmail.com
