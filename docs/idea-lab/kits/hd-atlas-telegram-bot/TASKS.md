# Build plan: HD Atlas Telegram Bot

## [ ] T1 Set up bot project skeleton and inspect hd-atlas corpus format (S)

Agent prompt:

```
In ~/Documents/Projects/hd-atlas-telegram-bot, run `ls ~/Documents/Projects/hd-atlas` and then `cat` one sample card JSON file from hd-atlas (find it with `find ~/Documents/Projects/hd-atlas -name '*.json' | head -5`) to inspect the real field names. Then create package.json with dependencies node-telegram-bot-api and dotenv, and a src/loadCards.js module that reads all card JSON files from ~/Documents/Projects/hd-atlas and normalizes them into the Card shape {id, number, hebrew_name, keywords, description_he, type}. Write a small test script scripts/test-load.js that loads and prints the count of cards and one sample.
```

Done when:

- `node scripts/test-load.js` prints exactly 42 cards loaded
- Sample printed card has non-empty hebrew_name and description_he fields

## [ ] T2 Build core Telegram bot with card search (S) — after T1

Agent prompt:

```
In ~/Documents/Projects/hd-atlas-telegram-bot, create src/bot.js using node-telegram-bot-api with polling mode. Load BOT_TOKEN from .env. Implement /start (Hebrew welcome message), /help, and a message handler that takes free text, searches cards loaded via src/loadCards.js by number or fuzzy keyword match (simple includes() on hebrew_name and keywords), and replies with description_he. If no match, reply in Hebrew asking user to try a card number or name.
```

Done when:

- Sending a card number like '34' to the bot in a test chat returns the correct Hebrew description
- Sending a random Hebrew word with no match returns the fallback message, not a crash

## [ ] T3 Add free-tier limit and subscriber check (S) — after T2

Agent prompt:

```
In ~/Documents/Projects/hd-atlas-telegram-bot, create src/subscribers.js backed by a local subscribers.json file with shape {telegram_user_id, gumroad_email, subscription_status, plan, started_at}. In src/bot.js, track per-user query count in memory (reset never, just count total). Allow 5 free lookups per telegram_user_id; after that, check subscribers.json for an active subscription; if none, reply with Hebrew message and the Gumroad checkout link https://gumroad.com/l/hd-atlas-bot (check it's the real product URL after creating it).
```

Done when:

- User under 5 queries gets normal card replies
- User over 5 queries without subscription gets the Gumroad link message in Hebrew

## [ ] T4 Create Netlify Function to receive Gumroad webhook (S) — after T3

Agent prompt:

```
First run `curl -s https://gumroad.com/api/v2/sales -H 'Authorization: Bearer TEST'` to inspect the real shape of a Gumroad sale payload (or check Gumroad docs page source with curl if API key not yet set up). In ~/Documents/Projects/hd-atlas-telegram-bot, create netlify/functions/gumroad-webhook.js that accepts POST, reads the sale payload's email and a custom field 'telegram_user_id', and appends/updates a record in subscribers.json (or Netlify Blob if file writes aren't persistent) with subscription_status 'active'. Add netlify.toml pointing functions to netlify/functions.
```

Done when:

- `npx netlify dev` runs the function locally and a test curl POST with sample payload updates subscribers.json
- Function returns 200 status on valid payload

## [ ] T5 Build and deploy landing page to Netlify (S) — after T4

Agent prompt:

```
In ~/Documents/Projects/hd-atlas-telegram-bot, create index.html (plain HTML/CSS, no framework) with the Hebrew headline, subhead, 3 benefits, and CTA button linking to the Telegram bot (https://t.me/hd_atlas_bot — check it's the real bot username after creating it in BotFather) and a secondary link to the Gumroad page. Style with a simple centered layout, RTL direction. Deploy with `npx netlify-cli deploy --prod`.
```

Done when:

- `npx netlify-cli deploy --prod` completes and returns a live URL
- Opening the URL shows RTL Hebrew text rendering correctly and both links are clickable

## [ ] T6 Post in HumandesignIsrael Facebook group and log first conversations (S) — after T5

Agent prompt:

```
No code needed for this task. In ~/Documents/Projects/hd-atlas-telegram-bot, create a file OUTREACH_LOG.md and manually log each of the first 10 direct conversations you have in the HumandesignIsrael Facebook group or linked WhatsApp group after posting the bot link, including date, person's first name, and whether they tried the bot.
```

Done when:

- OUTREACH_LOG.md contains at least 10 dated entries
- At least 1 entry marks a person as having sent a message to the bot
