# Spec: Agent Session Archive

## Problem

I run Claude Code, Codex, and Gemini simultaneously on different features and the context-switching is overwhelming me. Git worktrees are super frustrating to manage across multiple agent sessions, and two weeks later I can't find that decision the agent made or replay why it chose that architecture. Logs get lost across machines and terminals.

## Buyer

Developers running 5+ AI coding agent sessions daily, active in r/ClaudeAI and r/ChatGPTCoding.

## Jobs

- Find a specific decision an agent made days or weeks ago without grepping raw logs
- See a diff and the reasoning behind it in one view
- Compare what Claude Code vs Codex vs Cursor decided on the same task
- Get a weekly digest of what my agents actually did, across all machines

## In scope (v1)

- stasclaw daemon watches Claude Code log files and Codex session output on one machine
- Ingest into SQLite: timestamps, project tag, tool calls, code diffs, LLM decision text
- Web dashboard (Vercel) with full-text search and session replay (chronological step-through)
- Export a session as JSON or Markdown
- Weekly digest email via Resend

## Out of scope

- Cursor log ingestion (different log format, defer to v1.1)
- Multi-machine sync (v1 is single-machine, local-first)
- Team/shared accounts
- Real-time streaming view of an in-progress session

## Success metrics

| metric | target | milestone |
|---|---|---|
| Landing page live on Netlify with working signup form | 1 URL, form submits to Resend/DB | landing live |
| DM + reply conversations with active r/ClaudeAI posters | 10 replies | 10 conversations |
| Paid subscription at $19/month | 1 customer | first paying customer |
