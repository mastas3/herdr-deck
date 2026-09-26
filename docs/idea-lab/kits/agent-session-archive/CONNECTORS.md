# Connectors: Agent Session Archive

## Repos

- ✓ [PostHog/posthog-js](https://github.com/PostHog/posthog-js) — Send usage data from your web app or site to PostHog, with autocapture. (613★)
- ✓ [remotion-dev/remotion](https://github.com/remotion-dev/remotion) — 🎥      Make videos programmatically with React (60533★)
- ✓ [puppeteer/puppeteer](https://github.com/puppeteer/puppeteer) — JavaScript API for Chrome and Firefox (95623★)

## Services

- have: SQLite — Accounts & database
- have: Firebase — Accounts & database
- have: Auth0 — Accounts & database
- have: Vercel — Host a web app
- have: Netlify — Host a web app
- have: Cloudflare — Host a web app
- sign up: PostHog (https://posthog.com) — Product analytics, funnels, session replay, feature flags · Free tier
- sign up: Plausible (https://plausible.io) — Privacy-friendly web analytics · No free tier (30-day trial; free if self-hosted)
- have: Resend — Send email
- have: Gmail — Send email
- have: Mail — Send email
- have: Claude Docs — LLM calls
- have: Ollama — LLM calls
- have: OpenRouter — LLM calls
- have: Telegram — Telegram bot
- have: Adobe — PDF / document reports
- have: Pandoc — PDF / document reports
- have: Gumroad — Take payments
- have: Shopify — Take payments
- have: TON — Take payments
- have: Wix — Landing page / site

## Keys (names only)

- SUPABASE_URL: missing
- NETLIFY_AUTH_TOKEN: have (set in ~/.stasclaw/.env)
- RESEND_API_KEY: have (in 1 project: xxx-quiz)
- ANTHROPIC_API_KEY: have (in 2 projects: omni-claude, stasclaw)
- TELEGRAM_BOT_TOKEN: have (set in ~/.zshrc)
- GUMROAD_ACCESS_TOKEN: missing

## MCP servers & skills

- gumroad (MCP): create the product and read sales
- vercel (MCP): deploy previews and read logs
- supabase (MCP): migrations and typed queries
- codex-image (skill): logo, OG image and app icon
- hyperframes (skill): promo and product videos
- playwright (MCP): check the landing page and checkout end to end
- context7 (MCP): current SDK docs while coding

## Still missing

- **Analytics & funnels**
  - service: PostHog (https://posthog.com) — Sign up at https://posthog.com; put its key in .env (name only in .env.example)
  - service: Plausible (https://plausible.io) — Sign up at https://plausible.io; put its key in .env (name only in .env.example)
  - repo: PostHog/posthog-js (https://github.com/PostHog/posthog-js) — git clone https://github.com/PostHog/posthog-js.git and wire its smallest example into the MVP
