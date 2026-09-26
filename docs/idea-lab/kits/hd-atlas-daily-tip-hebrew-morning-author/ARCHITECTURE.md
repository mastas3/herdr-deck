# Architecture: HD Atlas Daily Tip — Hebrew Morning Authority

A Netlify site collects birth data via a form, computes the chart with bodygraph-3d's engine, stores it in Supabase, and a scheduled Netlify Function runs daily to pull today's transit, generate a Hebrew message via Claude grounded in hd-atlas text, and send it over Twilio WhatsApp.

## Components

| component | does | uses |
|---|---|---|
| hd-atlas | Supplies Hebrew canon text for each type's Strategy and each Authority's decision-making description, used as grounding context for Claude | local repo, packages/atlas cards read at build or function runtime via a small export script |
| bodygraph-3d | Computes the user's exact chart (type, Authority) from birth data and computes today's planetary transit line for the daily tip | astronomy-engine, exposed as a small server function called from the intake and daily-send flow |
| Netlify | Hosts landing page, intake form, and two functions: intake-submit and daily-send (triggered by Netlify scheduled functions) | Netlify Functions, Netlify Blobs for lightweight caching of today's transit |
| Supabase | Stores subscribers table (birth data, chart result, phone number, subscription status) since Netlify Functions are stateless | Postgres |
| Twilio | Sends the daily WhatsApp message to each subscriber's number | WhatsApp Business API via Twilio |
| Claude | Writes the final Hebrew daily message from a template: Strategy line + Authority tip + decision prompt, given hd-atlas text and today's transit as context | Anthropic API called from daily-send function |
| Gumroad | Takes payment and captures buyer email; builder manually cross-checks paid emails against Supabase subscribers | Gumroad product page, manual reconciliation for v1 |

## Data model

- **subscriber**: id, phone_e164, email, birth_date, birth_time, birth_place, hd_type, hd_authority, status(trial/active/cancelled), created_at
- **daily_message_log**: id, subscriber_id, date, transit_summary, message_text, sent_at, twilio_sid

## Flows

### Onboarding

1. User clicks WhatsApp link from landing page sample
2. User sends birth date, time, place as free text to the bot number
3. intake-submit function parses the message, calls bodygraph-3d chart function to get type + Authority
4. Result saved to Supabase subscribers table
5. Bot replies in Hebrew confirming type and Authority, links to Gumroad for payment

### Daily send

1. Netlify scheduled function daily-send fires at 7am Israel time
2. For each active subscriber, function reads hd_type and hd_authority
3. bodygraph-3d computes today's transit summary
4. Claude generates the Hebrew message using hd-atlas Strategy/Authority text + transit + a decision-prompt instruction
5. Message sent via Twilio WhatsApp API
6. Row written to daily_message_log

### Payment reconciliation

1. Gumroad sends payment notification email to rpsm90@gmail.com
2. Builder manually matches Gumroad buyer email to a pending subscriber phone number in Supabase
3. Builder updates subscriber.status to active in Supabase table editor
