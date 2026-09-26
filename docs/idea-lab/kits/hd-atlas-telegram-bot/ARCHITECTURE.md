# Architecture: HD Atlas Telegram Bot

A Telegram bot (Node.js, long-polling, no server hosting cost) reads Hebrew card data from the existing hd-atlas JSON corpus, matches user queries to cards, and returns Hebrew explanations. Payment status is checked against a Gumroad license/webhook list stored in a small JSON/SQLite file. Landing page is a static Netlify site linking to the bot and Gumroad checkout.

## Components

| component | does | uses |
|---|---|---|
| hd-atlas | Source of truth: 42 curated Human Design cards with Hebrew descriptions and keywords, stored as JSON files | Read directly by the bot process at query time |
| HD Atlas Telegram Bot (this project) | Node.js bot using node-telegram-bot-api, matches queries to cards, enforces free-tier limit, replies in Hebrew | hd-atlas corpus, Gumroad subscriber list, Telegram Bot API |
| Gumroad | Collects ₪29/month or ₪250/year payments, sends webhook on sale/subscription events | Webhook endpoint hosted as a Netlify Function |
| Netlify | Hosts the static landing page and the Gumroad webhook receiver as a serverless function | Deployed via netlify-cli from ~/Documents/Projects/hd-atlas-telegram-bot |

## Data model

- **Card**: id, number, hebrew_name, keywords[], description_he, type (gate/channel/center)
- **Subscriber**: telegram_user_id, gumroad_email, subscription_status, plan (monthly/yearly), started_at
- **QueryLog**: telegram_user_id, query_text, matched_card_id, timestamp

## Flows

### Card lookup

1. User sends card number or Hebrew keyword to bot
2. Bot searches hd-atlas JSON for exact or fuzzy match
3. If free-tier limit not exceeded or user is subscriber, bot replies with Hebrew description
4. If limit exceeded, bot replies with Gumroad checkout link

### Subscription activation

1. User buys on Gumroad with Telegram user ID as custom field
2. Gumroad webhook fires to Netlify Function
3. Function updates Subscriber record (SQLite file or Netlify Blob)
4. Bot checks Subscriber table on next query
