# Agent Session Archive

I run Claude Code, Codex, and Gemini simultaneously on different features and the context-switching is overwhelming me. Git worktrees are super frustrating to manage across multiple agent sessions, and two weeks later I can't find that decision the agent made or replay why it chose that architecture. Logs get lost across machines and terminals.

## How to work here

- Read SPEC.md, ARCHITECTURE.md and TASKS.md first; do the tasks in order and tick them off in TASKS.md.
- Base: copy the patterns (not the code wholesale) from ~/Documents/Projects/stasclaw. Deploy: Netlify (npx netlify-cli deploy; the CLI is signed in).
- Secrets: names are in .env.example; values live in .env (never commit it, never print values).
- Never post, send messages or charge anyone on the user's behalf; draft and ask.

## Tools you have

- gumroad (MCP): create the product and read sales
- vercel (MCP): deploy previews and read logs
- supabase (MCP): migrations and typed queries
- codex-image (skill): logo, OG image and app icon
- hyperframes (skill): promo and product videos
- playwright (MCP): check the landing page and checkout end to end
- context7 (MCP): current SDK docs while coding
