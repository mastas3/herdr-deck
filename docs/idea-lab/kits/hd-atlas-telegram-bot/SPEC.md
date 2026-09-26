# Spec: HD Atlas Telegram Bot

## Problem

Users of the official Human Design app paid for subscriptions and got 'failure to connect to server' with no support response — as one user put it, 'It's Apps like this that pull stunts like this that make people reluctant to invest into any app.' They want a dependable, offline way to look up their gates, channels, and centers without depending on a fragile server.

## Buyer

Hebrew-speaking Human Design fans in Israel active in Telegram/WhatsApp groups like HumandesignIsrael, many of whom already paid once for an app that broke.

## Jobs

- Look up a gate/channel/center by name or number and get an instant Hebrew explanation
- Trust that the tool won't suddenly stop working after payment
- Share quick answers inside WhatsApp/Telegram group chats without opening a broken app

## In scope (v1)

- Telegram bot answering card lookups by number or Hebrew name from the 42-card hd-atlas corpus
- Free-text search fallback (fuzzy match on keywords)
- Gumroad-based subscription check gating full corpus access after a free-tier limit
- Basic /start, /help, /search commands

## Out of scope

- Full bodygraph calculation (that's bodygraph-3d's job, not this bot's)
- Payment inside Telegram itself (Gumroad checkout link only)
- iOS/Android app
- Multi-language support beyond Hebrew

## Success metrics

| metric | target | milestone |
|---|---|---|
| Landing page live with bot link | 1 page on Netlify | landing live |
| Direct conversations with prospects in the FB/WhatsApp group | 10 conversations | 10 conversations |
| Paying subscriber via Gumroad | 1 paying customer | first paying customer |
