# Build plan: HD Atlas Daily Tip — Hebrew Morning Authority

## [ ] T1 Landing page with sample 3-day Hebrew message (S)

Agent prompt:

```
In ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author create a single static landing page (index.html, style.css) in Hebrew, RTL, with: headline, subhead, 3 benefits, a sample of 3 consecutive days of the daily WhatsApp message (write realistic Hebrew text for a Generator with Sacral Authority: Strategy line + today's Authority tip + one decision prompt, for 3 different days), and a CTA button linking to a WhatsApp click-to-chat link https://wa.me/972500000000?text=%D7%A8%D7%95%D7%A6%D7%94%20%D7%9C%D7%94%D7%AA%D7%97%D7%99%D7%9C (placeholder number to be replaced once Twilio WhatsApp number is provisioned). Deploy with: cd ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author && npx netlify-cli deploy --prod. Print the resulting URL.
```

Done when:

- netlify deploy --prod succeeds and prints a live https URL
- Page renders RTL Hebrew text correctly with no broken layout on mobile width 375px
- Sample messages read naturally in Hebrew and mention Strategy, Authority, and a concrete decision

## [ ] T2 Export hd-atlas Strategy/Authority text for the 5 types and 7 authorities (S)

Agent prompt:

```
In ~/Documents/Projects/hd-atlas, inspect the existing atlas card structure first: run ls packages/atlas and cat one sample card file to see its fields. Then write a script scripts/export-strategy-authority.ts that reads all cards tagged type or authority and writes a single JSON file to ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author/data/strategy-authority-he.json with shape {type: string, strategy_text_he: string}[] and {authority: string, tip_text_he: string}[]. Run it with: npx tsx scripts/export-strategy-authority.ts and confirm the output file has entries for all 5 types (Generator, Manifesting Generator, Projector, Manifestor, Reflector) and at least 6 authorities.
```

Done when:

- data/strategy-authority-he.json exists and is valid JSON
- Contains exactly 5 type entries and at least 6 authority entries, all with non-empty Hebrew text
- Running the script twice produces the same output (idempotent)

## [ ] T3 Supabase subscribers table and Netlify env wiring (S)

Agent prompt:

```
Create a Supabase project (or use an existing one) and run this SQL in the SQL editor: create table subscribers (id uuid primary key default gen_random_uuid(), phone_e164 text unique not null, email text, birth_date date, birth_time time, birth_place text, hd_type text, hd_authority text, status text default 'trial', created_at timestamptz default now()); create table daily_message_log (id uuid primary key default gen_random_uuid(), subscriber_id uuid references subscribers(id), date date, transit_summary text, message_text text, sent_at timestamptz, twilio_sid text). In ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author add netlify/functions/lib/supabase.ts exporting a configured Supabase client reading SUPABASE_URL and SUPABASE_SERVICE_KEY from process.env. Set these with: npx netlify-cli env:set SUPABASE_URL <value> and npx netlify-cli env:set SUPABASE_SERVICE_KEY <value>.
```

Done when:

- Both tables exist in Supabase, confirmed by running select * from subscribers limit 1 in SQL editor with no error
- netlify env:list shows SUPABASE_URL and SUPABASE_SERVICE_KEY set
- A local test insert via the supabase.ts client succeeds and shows up in the table

## [ ] T4 Chart calculation function using bodygraph-3d engine (M)

Agent prompt:

```
Inspect ~/Documents/Projects/bodygraph-3d/src to find the exported function that computes type and authority from birth date/time/place (look in src for a file exporting something like calculateBodygraph or deriveChart; run grep -r 'export function' src | grep -i chart to find it). Copy or import the minimal calculation logic into ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author/netlify/functions/lib/chart.ts as a function computeChart(birthDate, birthTime, birthPlace): {type: string, authority: string}. Write a small test in netlify/functions/lib/chart.test.ts using a known birth date/time and assert it returns a plausible type and authority (not 'undefined').
```

Done when:

- grep command output is inspected and referenced function is correctly identified before copying
- chart.test.ts passes with npx vitest run netlify/functions/lib/chart.test.ts
- computeChart returns one of the 5 valid types and one of the 7 valid authorities for a test date

## [ ] T5 Intake function: WhatsApp message parses birth data and saves subscriber (M) — after T3, T4

Agent prompt:

```
In ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author create netlify/functions/intake-submit.ts as a Twilio WhatsApp webhook handler. First inspect a real Twilio incoming WhatsApp webhook payload by checking Twilio docs sample or the Twilio console log format (print the raw request body to console.log on first real test message before writing the parser). Parse free-text Hebrew birth data (expect a loose format like '15/03/1990 14:30 תל אביב'), call computeChart from lib/chart.ts, upsert into Supabase subscribers by phone_e164, and reply with a Hebrew TwiML message confirming the detected type and Authority. Deploy with npx netlify-cli deploy --prod and set the function URL as the Twilio WhatsApp webhook.
```

Done when:

- Sending a test WhatsApp message with sample birth text triggers a Supabase row with correct hd_type and hd_authority
- Function replies in Hebrew with the detected type and Authority within the Twilio 15-second timeout
- Malformed input (missing time) returns a Hebrew error message asking to resend, not a crash

## [ ] T6 Daily-send scheduled function generating Claude-written Hebrew messages (M) — after T2, T3, T4

Agent prompt:

```
In ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author create netlify/functions/daily-send.ts as a Netlify scheduled function (cron '0 4 * * *' for 7am Israel time UTC+3). It should: load all subscribers with status='active' from Supabase, load data/strategy-authority-he.json, call computeChart's transit helper (or a simple daily transit lookup from bodygraph-3d) to get today's transit_summary, call the Anthropic API with a Hebrew prompt template combining strategy_text_he, tip_text_he, and transit_summary asking for a short daily message with one decision prompt, send the result via Twilio WhatsApp API using TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_NUMBER env vars, and log to daily_message_log. Set env vars with npx netlify-cli env:set for each. Test locally with npx netlify-cli functions:invoke daily-send.
```

Done when:

- functions:invoke daily-send runs without error against at least one test subscriber in Supabase
- A real WhatsApp message arrives in Hebrew with Strategy, Authority tip, and a distinct decision prompt
- daily_message_log gets a new row with sent_at populated and matching twilio_sid

## [ ] T7 Gumroad product and manual reconciliation checklist (S) — after T1

Agent prompt:

```
Create a Gumroad product 'HD Atlas יומי בעברית' with two prices: ₪19/month subscription and ₪180/year subscription. In ~/Documents/Projects/hd-atlas-daily-tip-hebrew-morning-author add a file docs/reconciliation.md describing the manual steps: when a Gumroad sale notification arrives at rpsm90@gmail.com, find the matching phone number in the Supabase subscribers table by email or by asking the buyer via WhatsApp, then run an UPDATE subscribers SET status='active' WHERE phone_e164 = '...' in the Supabase SQL editor. Link the Gumroad product URL in landing page CTA from T1.
```

Done when:

- Gumroad product page is live with both ₪19/month and ₪180/year options visible
- docs/reconciliation.md exists with the exact SQL update command written out
- Landing page CTA links to the live Gumroad product URL
