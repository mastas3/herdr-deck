// Recipes: multi-connection workflows the Connections store can launch. Each one names the connections it
// needs (matched against a machine's scan), the steps, and a prompt for the agent. "Run" only prefills the
// New session dialog; nothing starts until the user confirms there. Your own recipes live in
// ~/.config/herdr-deck/recipes.json on the hub.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Inventory, Item } from "./connections";
import { allItems, stateOf } from "./store";

/** Any one of these connections will do. An id ending in "*" matches by prefix (e.g. "ssh:*": any SSH host). */
export type Need = { label: string; any: string[] };
export type Agent = "claude" | "codex" | "opencode";
export type Recipe = {
  id: string; title: string; pitch: string; cat: string;
  needs: Need[]; optional?: Need[];
  steps: string[];
  prompt: string; // {connections} {machine} {date} {selected} are filled in
  folder?: string; // "~/wiki"; empty = wherever the New session dialog would open
  agent?: Agent;
  machine?: "hub" | "other"; // "other": the first machine that isn't the hub (the Linux box)
  custom?: boolean; from?: string;
};

const C = (label: string, ...any: string[]): Need => ({ label, any });
// The connections recipes lean on, by the ids the scanner gives them.
const N = {
  deploy: C("Netlify, Vercel or Cloudflare", "svc:netlify", "svc:vercel", "svc:cloudflare"),
  tailscale: C("Tailscale", "svc:tailscale"),
  email: C("Gmail or Mail", "svc:gmail", "svc:mail", "svc:resend"),
  gmail: C("Gmail", "svc:gmail"),
  calendar: C("Google Calendar or Calendar", "svc:google-calendar", "svc:calendar"),
  github: C("GitHub", "svc:github"),
  git: C("Git", "dev:git"),
  playwright: C("Playwright", "svc:playwright"),
  ytdlp: C("yt-dlp", "svc:yt-dlp"),
  ytrag: C("YouTube RAG (yt-transcriber)", "proj:yt-transcriber", "svc:youtube-rag-yt-transcriber"),
  wiki: C("LLM Wiki or Obsidian", "svc:llm-wiki", "svc:obsidian"),
  ollama: C("Ollama", "svc:ollama", "sub:ollama"),
  gumroad: C("Gumroad", "svc:gumroad", "mcp:gumroad"),
  stripe: C("Stripe", "svc:stripe"),
  telegram: C("Telegram", "svc:telegram"),
  jev: C("Jev", "svc:jev"),
  herdr: C("herdr", "dev:herdr"),
  deckMcp: C("herdr deck MCP", "proj:herdr-deck", "mcp:herdr-deck"),
  adobe: C("Adobe", "svc:adobe", "mcp:adobe-for-creativity"),
  canva: C("Canva", "svc:canva"),
  x: C("X (Twitter)", "svc:x-twitter"),
  ssh: C("An SSH host (the Linux box)", "ssh:*"),
  blender: C("Blender or ffmpeg", "svc:blender", "svc:ffmpeg"),
  ffmpeg: C("ffmpeg", "svc:ffmpeg"),
  hyperframes: C("HyperFrames", "svc:hyperframes"),
  eleven: C("ElevenLabs", "svc:elevenlabs"),
  higgsfield: C("Higgsfield", "svc:higgsfield"),
  postgres: C("Postgres", "svc:postgres"),
  rclone: C("rclone (Dropbox / Drive)", "svc:rclone"),
  last30: C("last30days", "svc:last30days", "skill:last30days"),
  fbgroup: C("Facebook group archive", "proj:fb-group-scraper", "svc:facebook-group-archive", "mcp:fb-group"),
  maigret: C("Maigret", "svc:maigret"),
  holehe: C("Holehe", "svc:holehe"),
  ghunt: C("GHunt", "svc:ghunt"),
  openrouter: C("OpenRouter", "svc:openrouter"),
  claude: C("Claude Code", "agent:claude"),
  codex: C("Codex", "agent:codex"),
  promptfoo: C("promptfoo", "svc:promptfoo"),
  search: C("Brave Search or Serper", "svc:brave-search", "svc:serper", "svc:perplexity", "svc:tavily"),
  docs: C("Claude Docs, Google Drive or Notion", "svc:claude-docs", "svc:google-drive", "svc:notion"),
  shortcuts: C("Shortcuts", "svc:shortcuts"),
  bg: C("Background services", "bg:*"),
  neon: C("Neon or Supabase", "svc:neon", "svc:supabase"),
  pandoc: C("Pandoc or nano-pdf", "svc:pandoc", "svc:nano-pdf"),
  stt: C("Speech-to-text (Deepgram, ElevenLabs, Ollama)", "svc:deepgram", "svc:elevenlabs", "svc:soniox", "svc:ollama"),
  netlify: C("Netlify or Vercel", "svc:netlify", "svc:vercel"),
  godot: C("Godot", "svc:godot"),
  onepass: C("1Password", "svc:1password"),
  reminders: C("Reminders", "svc:reminders"),
  notes: C("Apple Notes", "svc:notes"),
  linear: C("Linear", "svc:linear"),
  // Accounts (src/catalog.ts): a saved login in Chrome makes the browser-first ones ready for Claude in Chrome.
  chrome: C("Chrome (Claude in Chrome)", "svc:chrome"),
  shorts: C("YouTube, TikTok or Instagram", "svc:youtube-data-api", "acct:tiktok", "acct:instagram"),
  xAcct: C("X account", "svc:x-twitter"),
  mentions: C("last30days or a search API", "svc:last30days", "skill:last30days", "svc:brave-search", "svc:serper", "svc:perplexity", "svc:tavily", "acct:exa"),
  forums: C("Reddit or Hacker News account", "acct:reddit", "acct:hacker-news"),
  launch: C("Product Hunt, Hacker News or Reddit", "acct:product-hunt", "acct:hacker-news", "acct:reddit"),
  newsletter: C("Substack, beehiiv, Buttondown or Kit", "acct:substack", "acct:beehiiv", "acct:buttondown", "acct:kit", "acct:mailchimp"),
  scheduler: C("Buffer, Typefully or Hootsuite", "acct:buffer", "acct:typefully", "acct:hootsuite"),
  social: C("Your social accounts", "svc:x-twitter", "acct:instagram", "acct:tiktok", "svc:youtube-data-api", "acct:facebook", "acct:linkedin", "acct:reddit", "acct:threads", "acct:bluesky", "acct:pinterest", "acct:medium", "acct:substack"),
};

const SAFE = "Ask me before anything public, paid, destructive, or that messages another person.";

export const RECIPES: Recipe[] = [
  {
    id: "ship-and-show", cat: "cloud", title: "Ship and show",
    pitch: "Build, put a preview on Netlify or Vercel, share the dev build on your tailnet, and email yourself both links with screenshots.",
    needs: [N.deploy, N.tailscale, N.email], optional: [N.github, N.playwright, C("Sentry or PostHog", "acct:sentry", "acct:posthog")],
    steps: ["Build and run the project's tests", "Deploy a preview (never production)", "Share the dev server on the tailnet with tailscale serve", "Screenshot the preview at 390×844 and 1400×900", "Draft an email to me with both links and the screenshots"],
    prompt: "Ship-and-show this project. 1) Build it and run its tests; stop and tell me if they fail. 2) Deploy a PREVIEW (not production) with whichever deploy target this repo is linked to. 3) Start the dev server if it isn't running and share it on the tailnet with `tailscale serve --bg --https=<port> http://localhost:<port>` (never funnel). 4) Take Playwright screenshots of the preview at 390×844 and 1400×900 and look at them. 5) Draft an email to me (don't send unless I say so) with the preview link, the tailnet link, what changed, and the screenshots attached. " + SAFE + "\n\n{connections}",
    agent: "claude",
  },
  {
    id: "youtube-to-wiki", cat: "knowledge", title: "Channel → RAG → weekly wiki digest",
    pitch: "Pull a channel's new videos into the local RAG, ask it what changed this week, and file a cited digest page in the wiki.",
    needs: [N.ytdlp, N.ytrag, N.wiki], optional: [N.ollama, C("YouTube Data API", "svc:youtube-data-api"), C("Modal (cloud GPUs)", "acct:modal")],
    steps: ["Ask which channels (or reuse the ones already ingested)", "Ingest videos from the last 7 days with yt-transcriber", "Query the corpus for this week's themes, claims and disagreements", "Write synthesis/<channel>-weekly-{date}.md with [hh:mm:ss] quotes", "Update index.md and log.md per the wiki schema"],
    prompt: "Weekly YouTube digest into my wiki. Read ~/wiki/CLAUDE.md first and follow its schema. Ask me which channel(s) to cover, or list the channels already in the yt-transcriber RAG and suggest those. Use the yt-transcriber skill to ingest only videos from the last 7 days, then query the channel corpus for the week's main themes, new claims, and anything that contradicts what my wiki already says. Write `synthesis/<channel>-weekly-{date}.md` with a TLDR, 5–8 takeaways, notable quotes with [hh:mm:ss] timestamps and video links, and [[wikilinks]] into my projects where it connects (Human Design apps, AI video, agent orchestration). Update index.md and append log.md. Summarize; never paste transcripts wholesale.\n\n{connections}",
    folder: "~/wiki", agent: "claude",
  },
  {
    id: "morning-revenue-brief", cat: "commerce", title: "Morning revenue brief",
    pitch: "Gumroad sales and customer email in one five-minute read, with reply drafts waiting for you.",
    needs: [N.gumroad, N.gmail], optional: [N.stripe, N.calendar, N.telegram],
    steps: ["Yesterday's and this week's sales, refunds and top products from Gumroad", "Customer emails from the last 24h that need a reply", "Draft replies (not sent)", "Today's calendar at a glance", "One-screen brief, optionally sent to my Telegram bot chat"],
    prompt: "Write my morning revenue brief for {date}. From Gumroad: sales and refunds for yesterday and the last 7 days, revenue by product, anything unusual (spikes, refunds, new offer-code use). From Gmail: customer and buyer emails from the last 24 hours that need me, each with a one-line summary and a DRAFT reply (do not send). If a calendar is connected, list today's events. Put it in one screen: numbers first, then what needs me, then drafts. If Telegram is set up, offer to send the brief to my bot chat, and only send when I say yes. " + SAFE + "\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "nightly-repo-report", cat: "code", title: "Nightly repo health",
    pitch: "Every repo's tests, uncommitted work, unpushed commits and stale branches in one report — then offer to make it a nightly job.",
    needs: [N.git, N.github], optional: [N.herdr, N.telegram, N.jev, C("Sentry", "acct:sentry"), N.linear],
    steps: ["Walk every git repo under ~/Documents/Projects", "Uncommitted files, unpushed commits, stale branches, last activity", "Run each project's own test command (read-only, time-boxed)", "Rank what needs attention first", "Write the report; offer a launchd/systemd timer to repeat it"],
    prompt: "Make a repo health report for every git repository under ~/Documents/Projects (one level deep). For each: branch, uncommitted files, unpushed commits, stale local branches (>30 days), last commit date, and the result of the project's own test command (detect from package.json/Cargo/go.mod/pytest/Makefile; 3-minute cap each; never install dependencies or change files). Rank the repos by what needs me most (failing tests on active repos first, then uncommitted work older than 3 days). Save it as ~/Documents/Projects/REPO-HEALTH-{date}.md and summarize the top 5 here. If Jev is available, use `jev ask` to flag which items are low-stakes. Then offer (don't create) a nightly launchd/systemd timer that reruns this.\n\n{connections}",
    folder: "~/Documents/Projects", agent: "claude",
  },
  {
    id: "screenshot-to-post", cat: "media", title: "Screenshot → polished post",
    pitch: "Your latest screenshot, cleaned up with Adobe, laid out for social, with a caption draft in English, Hebrew and Russian.",
    needs: [N.adobe], optional: [N.canva, N.x, N.telegram],
    steps: ["Find the newest screenshot on the Desktop (or ask for one)", "Crop, straighten and enhance it with the Adobe tools", "Make square and 9:16 versions", "Draft a caption in EN / HE / RU", "Post nothing until I approve"],
    prompt: "Turn my latest screenshot into a post. Find the newest screenshot on ~/Desktop (or ask me for one). Use the Adobe connector to crop it to the interesting part, straighten, enhance, and remove clutter; then make a 1:1 and a 9:16 version (Canva if it's connected and gives a better layout). Write a caption in English, Hebrew and Russian, each under 220 characters, in my voice (curious, concrete, no hype). Show me the results side by side. Do not post anywhere unless I say so.\n\n{connections}",
    folder: "~/Desktop", agent: "claude",
  },
  {
    id: "render-on-linux", cat: "devices", title: "Render on the Linux box",
    pitch: "Offload a heavy Blender or ffmpeg job to the Linux machine over SSH, keep working, and pull the result back when it's done.",
    needs: [N.ssh, N.blender], optional: [N.tailscale],
    steps: ["Pick the job and its input files", "Copy inputs to the Linux box (rsync over SSH)", "Start the render there under nohup/tmux, logging to a file", "Poll until done; pull outputs back", "Compare time against a local run estimate"],
    prompt: "Offload a render to my Linux machine. Ask me which Blender scene or ffmpeg job (or suggest the heaviest pending one in this folder). Check the Linux box has the tool (`ssh <host> which blender ffmpeg`). rsync the inputs to ~/render-jobs/<name>/ there, start the job under tmux or nohup with a log file, and poll every minute (don't hold my session hostage: report progress lines). When it finishes, rsync the outputs back next to the inputs here and tell me the wall time. Never delete anything on either machine.\n\n{connections}",
    agent: "claude",
  },
  {
    id: "jev-go-no-go", cat: "ai", title: "Jev-judged go / no-go",
    pitch: "Before you ship: every gate (tests, diff, TODOs, env, migrations) checked, and Jev's calibrated call on each.",
    needs: [N.jev, N.git], optional: [N.github, N.netlify],
    steps: ["Collect the gates: tests, lint, diff size, TODO/FIXME added, env and migration changes", "Ask Jev for a go/no-go with confidence on each gate", "Record each outcome with jev outcome after I decide", "One table; no deploy happens here"],
    prompt: "Run a go/no-go review of the current branch. Gather the gates: test and lint results, diff size and risky files, TODO/FIXME added, env var or config changes, database migrations, and anything that touches payments or auth. For each gate, ask Jev (`jev ask`) for a calibrated go/no-go with its confidence, and show one table: gate, evidence, Jev's call, confidence. Give your own overall recommendation separately. Don't deploy, merge or push. After I decide, record what I chose with `jev outcome`.\n\n{connections}",
    agent: "claude",
  },
  {
    id: "daily-transit-short", cat: "media", title: "Today's transit → 20-second short",
    pitch: "Today's Human Design transit as a vertical short: script, ElevenLabs voice, HyperFrames render, captions in three languages.",
    needs: [N.hyperframes, N.eleven, N.ffmpeg], optional: [N.postgres, N.higgsfield, C("fal or Replicate", "svc:fal", "svc:replicate"), C("Suno", "acct:suno")],
    steps: ["Compute today's Sun and Moon gates with my HD engine", "Write a 3-beat, 20-second script (hook, meaning, invitation)", "Voice it with ElevenLabs (say the credit cost first)", "Render 9:16 with HyperFrames; normalize audio with ffmpeg", "Captions in EN / HE / RU; save to the project, publish nothing"],
    prompt: "Make today's ({date}) Human Design transit short. Use my own HD engine (hd-core / astra-apple, or the hd_kb Postgres database if it's quicker) to get today's Sun and Moon gates and any channels they complete; don't invent gate meanings: pull them from my sources. Write a 20-second, 3-beat script (hook, what it means today, a small invitation). Tell me the ElevenLabs credit cost, then voice it. Load the hyperframes skill and render a 9:16 MP4 with the bodygraph as the hero visual; normalize loudness with ffmpeg. Write burned-in captions plus caption files in English, Hebrew and Russian. Save everything under a dated folder here. Publish nothing.\n\n{connections}",
    folder: "~/Documents/Projects/story-reel", agent: "claude",
  },
  {
    id: "funnel-pulse", cat: "commerce", title: "2027 Prophecy funnel pulse",
    pitch: "Sales, community chatter and replies about the 2027 funnel in one weekly page, with three content ideas that answer real questions.",
    needs: [N.gumroad, N.last30], optional: [N.fbgroup, N.gmail, N.wiki, C("PostHog or Plausible", "acct:posthog", "acct:plausible")],
    steps: ["Load the astra-2027-ops skill", "Gumroad sales for the 2027 products, week over week", "last30days on '2027 human design' across Reddit, X and YouTube", "Hebrew FB group questions about 2027", "Weekly page in the wiki + three content ideas"],
    prompt: "Weekly 2027 Prophecy funnel pulse. Load the astra-2027-ops skill first. Pull Gumroad sales for the 2027 products (this week vs last), run last30days on '2027 human design prophecy' (Reddit, X, YouTube), and, if the Facebook group archive is available, search it for this week's 2027 questions (Hebrew is fine, summarize in English). Check Gmail for buyer replies. Write ~/wiki/synthesis/2027-funnel-pulse-{date}.md: numbers, what people are actually asking, objections, and three content ideas that answer a real question each (with the source link). Update the wiki index and log. Change nothing on the live site.\n\n{connections}",
    folder: "~/Documents/Projects/astra-apple", agent: "claude",
  },
  {
    id: "inbox-triage", cat: "comms", title: "Inbox to decisions",
    pitch: "The last 48 hours of email reduced to what needs you, with drafts written and calendar holds proposed.",
    needs: [N.gmail], optional: [N.calendar, N.jev],
    steps: ["Read threads from the last 48h", "Sort: needs me / FYI / can archive", "Draft replies for 'needs me' (not sent)", "Propose calendar holds for anything that needs time", "Nothing sent or archived without my OK"],
    prompt: "Triage my Gmail from the last 48 hours. Sort threads into: needs me (with why, one line), FYI, and safe to archive. For each 'needs me', write a DRAFT reply in my voice. Where something needs a block of time or a meeting, propose a calendar hold (don't create it). If Jev is available, use it to mark which decisions are low-stakes. Show one compact list. Don't send, archive or label anything until I say so.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "osint-self-audit", cat: "research", title: "Self-exposure check",
    pitch: "Your own usernames and emails through Maigret and Holehe, compared with last time, summarized without leaking anything.",
    needs: [N.maigret, N.holehe], optional: [N.ghunt, N.wiki],
    steps: ["Confirm the handles and emails are mine", "Run Maigret on usernames, Holehe on emails", "Compare with the previous run", "Privacy-safe summary: what's new, what to close", "Keep raw results local"],
    prompt: "Run a defensive self-exposure check. First ask me for the usernames and email addresses to check and confirm they're mine; don't check anyone else's. Run Maigret on the usernames and Holehe on the emails (GHunt on my Google address only if I say so). Save raw results under ~/.config/self-audit/{date}/ (never in a repo or the wiki). Compare with the previous run if there is one. Give me a short, privacy-safe summary: new accounts found, old ones that should be closed or locked down, and the three most useful next steps. If I want it in the wiki, write only the summary, no identifiers.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "community-pulse", cat: "research", title: "What the HD community is asking",
    pitch: "The Facebook group archive plus Reddit, X and YouTube chatter, turned into a ranked board of questions worth answering.",
    needs: [N.fbgroup, N.last30], optional: [N.wiki, N.docs, C("Apify", "svc:apify")],
    steps: ["Search the FB group archive for the last 30 days", "Run last30days on Human Design topics", "Cluster questions and pain points; count and quote", "Rank by demand × fit with my products", "File the board in the wiki"],
    prompt: "Build a 'what people are asking' board for Human Design. Use the fb-group MCP (recent_posts, semantic_search, top_authors) for the last 30 days of the Hebrew group, and last30days for Reddit (r/humandesign), X and YouTube. Cluster the questions and pain points, with counts and 1–2 short quotes each (link, no personal details). Rank clusters by demand and by fit with my products (HD Chat / Atlas, 2027 Prophecy, bodygraph apps). Write it to ~/wiki/synthesis/hd-community-questions-{date}.md with [[links]] to the relevant project pages; update index and log.\n\n{connections}",
    folder: "~/wiki", agent: "claude",
  },
  {
    id: "private-brief", cat: "ai", title: "Local-only brief",
    pitch: "Summarize something sensitive with local Ollama models only: nothing leaves this machine.",
    needs: [N.ollama], optional: [],
    steps: ["Pick the file or folder", "List the local models and choose one", "Chunk and summarize through localhost:11434 only", "Write the brief next to the source", "Confirm no cloud API was called"],
    prompt: "Make a private brief. Ask me which file or folder. Use ONLY the local Ollama API at http://localhost:11434 (list the installed models and pick the best fit; gemma or qwen for text). Don't send any of the content to a cloud model, including yourself beyond reading file names: do the reading and summarizing through Ollama with a small script. Write a one-page brief (what it is, key points, open questions, anything time-sensitive) next to the source as BRIEF.local.md, and tell me which model produced it.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "model-bakeoff", cat: "ai", title: "Model bake-off",
    pitch: "One real task through Claude, Codex and a few OpenRouter models, scored with promptfoo, judged blind.",
    needs: [N.claude, N.openrouter], optional: [N.codex, N.promptfoo, N.ollama, N.jev, C("Groq", "svc:groq")],
    steps: ["Pick one real task and 5–10 test inputs", "Write a promptfoo config with the models", "Run and collect outputs, cost and latency", "Blind-judge (and ask Jev where it's a pick-one)", "Scorecard with a recommendation"],
    prompt: "Run a model bake-off on a real task. Ask me for the task (or suggest one from my current projects) and build 5–10 test inputs with expected qualities. Write a promptfoo config comparing Claude via the API, 2–3 OpenRouter models (one cheap, one strong, one open-weights) and a local Ollama model if present; add Codex as a separate run if it fits. Run it, collect outputs, cost and latency, then judge blind (strip model names). Where it's a pick-one judgment, ask Jev too. Give me a scorecard and a recommendation with the cost per 1,000 runs. Keep spend under $2 and tell me before anything bigger.\n\n{connections}",
    folder: "~/Documents/Projects", agent: "claude",
  },
  {
    id: "phone-qa", cat: "browsers", title: "Phone QA pass",
    pitch: "Dev server on your tailnet, Playwright at phone and desktop sizes, console errors caught, issues listed with screenshots.",
    needs: [N.playwright, N.tailscale], optional: [N.email],
    steps: ["Start the dev server", "Share it on the tailnet", "Screenshots at 390×844 and 1400×900 of the main flows", "Collect console errors and layout overflow", "Issue list with screenshots; the link for my phone"],
    prompt: "Do a phone QA pass on this project. Start the dev server (or use the running one), share it with `tailscale serve --bg --https=<port> http://localhost:<port>` and give me the link for my phone. With Playwright, walk the main flows at 390×844 and 1400×900: screenshot each screen, collect console errors, horizontal overflow and tap targets under 40px. Look at every screenshot yourself. Give me a numbered issue list (screenshot path, what's wrong, proposed fix). Fix nothing until I pick.\n\n{connections}",
    agent: "claude",
  },
  {
    id: "one-hour-game", cat: "media", title: "A game in an hour",
    pitch: "A mobile-first Phaser prototype from one sentence, deployed as a preview and playable on your phone before lunch.",
    needs: [N.netlify, N.tailscale], optional: [N.eleven, N.godot, N.playwright, C("itch.io or CrazyGames", "acct:itch", "acct:crazygames"), C("Suno", "acct:suno")],
    steps: ["One-sentence pitch → core loop", "Scaffold with the mobile-web-game-studio skill", "Playable loop with placeholder art, then generated art", "Phone test over the tailnet", "Netlify preview deploy"],
    prompt: "Let's make a small mobile web game in about an hour. Load the mobile-web-game-studio skill. Ask me for a one-sentence pitch (or offer three that fit my world: Israeli comedy, Human Design, noir mystery). Build the core loop first with placeholder shapes, get it playable on my phone over the tailnet, then add generated art and, if ElevenLabs is set up, a few sound effects (tell me the credit cost). Playwright-check it at 390×844. Deploy a Netlify PREVIEW and give me both links.\n\n{connections}",
    folder: "~/Documents/Projects", agent: "claude",
  },
  {
    id: "db-health", cat: "data", title: "Database health tour",
    pitch: "Every local Postgres database: size, bloat, missing indexes, pgvector stats, and a tested backup plan.",
    needs: [N.postgres], optional: [N.rclone, N.neon],
    steps: ["List databases and sizes", "Largest tables, dead tuples, last vacuum/analyze", "Unused and missing indexes; pgvector index health", "pg_dump plan with a restore test into a scratch DB", "Offer an rclone off-site copy"],
    prompt: "Give me a health tour of my local Postgres. For every database (read-only queries only): size, largest tables, dead tuples and last vacuum/analyze, unused indexes, likely missing indexes from pg_stat_statements if enabled, and pgvector index sizes and types where present. Then propose a backup plan: a pg_dump command per database, and prove it by restoring one small database into a scratch database you create and drop afterwards (ask first). If rclone is set up, offer an off-site copy command with --dry-run. One report, worst problems first.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "offsite-backup", cat: "cloud", title: "Off-site backup, verified",
    pitch: "The wiki, the deck's settings and the project data you pick, synced to Dropbox or Drive with checksums and a restore note.",
    needs: [N.rclone], optional: [N.postgres],
    steps: ["Choose what to back up and which remote", "rclone sync --dry-run and show the plan", "Run it after I approve", "rclone check to verify", "Write RESTORE.md"],
    prompt: "Set up a verified off-site backup with rclone. List my rclone remotes and ask which to use. Propose what to include: ~/wiki, ~/.config/herdr-deck (excluding *.token files), and the data folders of my active projects (ask). Exclude node_modules, .venv, caches and every .env. Run `rclone sync ... --dry-run` and show me the plan and size. After I approve, run it, then `rclone check` to verify, and write RESTORE.md with the exact restore commands. Never delete on the remote without asking.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "voice-note-to-wiki", cat: "knowledge", title: "Voice memo → wiki note",
    pitch: "Talk for five minutes; get a structured, linked note in the wiki with decisions and to-dos pulled out.",
    needs: [N.wiki, N.stt], optional: [N.reminders, N.notes],
    steps: ["Take the audio file (or the newest Voice Memo export)", "Transcribe locally if possible", "Structure: summary, decisions, ideas, to-dos", "Link into the right project pages", "Offer to add to-dos to Reminders"],
    prompt: "Turn a voice memo into a wiki note. Ask me for the audio file (or find the newest .m4a in ~/Downloads or ~/Desktop). Transcribe it, locally with Ollama/Whisper if available, otherwise with the speech-to-text service that's set up (tell me which and the cost). Mixed Hebrew/English/Russian is normal. Write a note following ~/wiki/CLAUDE.md: TLDR, decisions, ideas, to-dos, with [[links]] to the projects it mentions, filed where the schema says. Offer to add the to-dos to Reminders; add them only if I say yes.\n\n{connections}",
    folder: "~/wiki", agent: "claude",
  },
  {
    id: "telegram-standup", cat: "automation", title: "Agent standup to Telegram",
    pitch: "Every agent session that needs you, on every machine, as a five-line Telegram message — on demand or every morning.",
    needs: [N.telegram, N.deckMcp], optional: [N.herdr],
    steps: ["Read sessions from the deck's MCP (deck_sessions)", "Pick what needs me: waiting, finished unseen, failing checks", "Five lines with links", "Send to my own bot chat after I approve the format", "Offer a launchd job for 08:30"],
    prompt: "Build me an agent standup for Telegram. Use the herdr deck MCP (deck_sessions, deck_decisions) to collect every session on every machine that needs me: waiting for input, finished and unseen, or failing its proof-of-done check. Write it as at most five lines (project · what it needs · age). Show me the message first; after I approve, send it to my own Telegram bot chat using the token from the environment (never print it). Then offer (don't create) a launchd job that sends it every morning at 08:30.\n\n{connections}",
    folder: "~/Documents/Projects/herdr-deck", agent: "claude",
  },
  {
    id: "shortcut-trigger", cat: "automation", title: "“Ask my agents” Shortcut",
    pitch: "A Shortcut on your Mac (and phone, over the tailnet) that sends a sentence to an agent session through the deck.",
    needs: [N.shortcuts, N.deckMcp], optional: [N.tailscale],
    steps: ["Design the Shortcut: ask for text, pick a session", "Call the deck's MCP deck_send over HTTP with the token from its file", "Test it with `shortcuts run`", "Explain how to use it from the phone over the tailnet"],
    prompt: "Make a macOS Shortcut called “Ask my agents”. It should ask for a line of text, then POST it to the herdr deck MCP (`deck_send`, streamable HTTP at the deck's /mcp endpoint) using the bearer token read from ~/.config/herdr-deck/mcp.token at run time; never embed the token in the Shortcut. Default target: the most recently active Claude session (use deck_sessions). Build it, test it with `shortcuts run \"Ask my agents\"` with a harmless message like 'ping from Shortcuts, no action needed', and show me the result. Then explain how to reach it from my phone over the tailnet. Don't expose anything outside the tailnet.\n\n{connections}",
    folder: "~/Documents/Projects/herdr-deck", agent: "claude",
  },
  {
    id: "services-watchdog", cat: "automation", title: "Background services audit",
    pitch: "Every launchd and systemd service on both machines: what's running, what's crashing, what's stale — with a fix list.",
    needs: [N.bg], optional: [N.ssh],
    steps: ["List user services here (launchd) and on the Linux box (systemd --user)", "State, last exit code, restarts, log freshness", "Flag crash loops, duplicates, stale jobs", "Fix list, most important first", "Change nothing without approval"],
    prompt: "Audit my background services. On this machine list every user launchd agent (or systemd --user unit on Linux) with its state, last exit status, and how fresh its log is; do the same on my other machine over SSH. Flag crash loops, services that point at missing files, duplicates, and jobs that haven't run when they should. For the worst five, read the last 30 log lines and explain the cause. Give me a fix list, most important first. Don't stop, restart or edit anything until I approve each one.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "market-brief-doc", cat: "research", title: "One-page market brief",
    pitch: "What's being said about a topic in the last 30 days plus fresh search results, as a shareable one-page doc.",
    needs: [N.last30], optional: [N.search, N.docs, C("Exa", "acct:exa")],
    steps: ["Take the topic", "last30days across Reddit, X, YouTube, HN", "Web search for the latest facts and numbers", "One page: what's true, what's hype, what to do", "Publish to Claude Docs or Google Drive if I want"],
    prompt: "Write a one-page market brief on a topic I'll give you. Run last30days on it, then use web search (Brave or Serper if set up) for the latest facts and numbers. One page: the three things that are actually happening, what's hype, who's winning and why, and what I should do this week given my projects (read ~/wiki/index.md for context). Cite every claim with a link. Save it as markdown here; if Claude Docs or Google Drive is connected, offer to publish it there.\n\n{connections}",
    folder: "~/wiki", agent: "claude",
  },
  {
    id: "wiki-explainer-video", cat: "media", title: "Wiki page → explainer video",
    pitch: "Pick any wiki page and get a faceless explainer: designed scenes, a voiceover, captions, rendered to MP4.",
    needs: [N.hyperframes], optional: [N.eleven, N.ffmpeg],
    steps: ["Pick the wiki page", "Script it into 6–10 scenes", "Voiceover (ElevenLabs if set up)", "Render with HyperFrames via the faceless-explainer skill", "Captions and a thumbnail"],
    prompt: "Turn one of my wiki pages into a faceless explainer video. Ask me which page (or suggest three strong candidates from ~/wiki/index.md). Load the faceless-explainer skill and follow it: script 6–10 scenes, a voiceover (ElevenLabs if set up; tell me the credit cost first), designed scenes rendered with HyperFrames, burned-in captions, and a thumbnail. Keep it under 90 seconds. Save the project under ~/Documents/Projects/explainers/<slug>/ and show me the render. Publish nothing.\n\n{connections}",
    folder: "~/Documents/Projects", agent: "claude",
  },
  {
    id: "secrets-sweep", cat: "code", title: "Secrets hygiene sweep",
    pitch: "Find committed keys across your repos without ever printing one, check .env files are ignored, and plan rotations.",
    needs: [N.git], optional: [N.github, N.onepass],
    steps: ["Scan every repo's tracked files and history for key patterns", "Report file, line and key NAME only — never the value", "Check .env files are gitignored and untracked", "Which keys appear in several projects", "Rotation plan, most exposed first"],
    prompt: "Do a secrets hygiene sweep of my repos under ~/Documents/Projects. For each repo, search tracked files and git history for API key patterns (sk-, ghp_, xox, AKIA, private key headers, long base64 near KEY/TOKEN/SECRET). Report only repo, file, line/commit and the variable NAME — never print, log or copy a value, not even partly. Check every .env / .env.local is gitignored and not tracked. Note which key names appear in several projects. Then give me a rotation plan, most exposed first (public GitHub repos first; check visibility with gh). Change nothing without my OK.\n\n{connections}",
    folder: "~/Documents/Projects", agent: "claude",
  },
  {
    id: "linux-long-job", cat: "devices", title: "Hand a long job to the Linux box",
    pitch: "Start a long-running job (a RAG ingest, a test matrix, a big render) in its own session on the Linux machine; the deck tells you when it's done.",
    needs: [N.ssh, N.herdr], optional: [N.telegram],
    steps: ["This session runs on the Linux machine", "Clone or sync what the job needs", "Run it with progress written to a log", "Report a summary when done", "The deck shows it in your Inbox"],
    prompt: "You're on my Linux machine. I want to hand you a long-running job. Ask me which one (for example: ingest a YouTube channel into a RAG, run a full test matrix, render a video). Check the tools it needs are installed here, sync or clone what's missing, then run it with progress written to ~/jobs/{date}-<name>.log. Post a short progress line every few minutes and a summary when it's done (runtime, outputs, anything that failed). Don't touch other sessions or services on this machine.\n\n{connections}",
    folder: "~", agent: "claude", machine: "other",
  },
  {
    id: "calendar-focus-plan", cat: "comms", title: "Calendar-aware focus plan",
    pitch: "Today's meetings plus every agent that's waiting on you, turned into time blocks you can accept in one go.",
    needs: [N.calendar], optional: [N.deckMcp, N.reminders, C("Cal.com or Calendly", "acct:cal-com", "acct:calendly")],
    steps: ["Today's events", "Sessions waiting on me (deck MCP)", "Estimate each decision's time", "Propose time blocks around meetings", "Create holds only after I accept"],
    prompt: "Plan my day ({date}). Read today's calendar. From the herdr deck MCP, list sessions that need me (waiting, finished unseen, failing checks) and estimate how long each decision takes. Propose a time-blocked plan around my meetings: short decisions batched, one deep-work block, a buffer. Show it as a simple timeline. Create calendar holds (or Reminders) only for the blocks I accept.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "migration-rehearsal", cat: "data", title: "Migration rehearsal on a branch",
    pitch: "Run this project's pending migrations on a throwaway Neon or Supabase branch, diff the schema, then clean up.",
    needs: [N.neon], optional: [N.postgres],
    steps: ["Find pending migrations in this repo", "Create a throwaway database branch", "Apply migrations there; capture timing and errors", "Schema diff before/after", "Delete the branch; report"],
    prompt: "Rehearse this project's pending database migrations safely. Find the migration tool and the pending migrations. Create a throwaway branch (Neon: `neonctl branches create`; Supabase: a local `supabase db reset` or a branch) — ask me before creating anything billable. Apply the migrations there, capture timing, locks and errors, and produce a before/after schema diff. Delete the branch afterwards. Report: safe to run in production or not, and why. Never touch the main branch or production.\n\n{connections}",
    agent: "claude",
  },
  {
    id: "hd-report-product", cat: "commerce", title: "HD report → Gumroad draft",
    pitch: "A Human Design report rendered to a designed PDF and set up as an unpublished Gumroad product with a launch offer code.",
    needs: [N.pandoc, N.gumroad], optional: [N.adobe, C("Stripe or Lemon Squeezy", "svc:stripe", "svc:lemon-squeezy")],
    steps: ["Pick the report source (markdown or chart output)", "Render a designed PDF (Pandoc / nano-pdf)", "Polish the cover with Adobe", "Create the Gumroad product as a draft", "Make a launch offer code, disabled until I say"],
    prompt: "Package a Human Design report as a product. Ask me for the source (a markdown report or chart output from my HD engine). Render it to a clean, designed PDF with Pandoc (nano-pdf for fixes), a cover page and a table of contents; polish the cover with Adobe if connected. Show me the PDF. Then create the product on Gumroad as a DRAFT (not published), with title, description in my voice, price I confirm, and a launch offer code. Publish nothing and enable nothing until I say so.\n\n{connections}",
    folder: "~/Documents/Projects/astra-apple", agent: "claude",
  },
  {
    id: "storyboard-to-shots", cat: "media", title: "Storyboard → generated shots, on a budget",
    pitch: "An approved storyboard turned into Higgsfield shots with a hard credit budget, then cut together with ffmpeg.",
    needs: [N.higgsfield], optional: [N.ffmpeg, N.eleven, C("fal, Kling, Runway or Luma", "svc:fal", "acct:kling", "svc:runway", "acct:luma")],
    steps: ["Read the storyboard", "Estimate credits per shot; agree a budget", "Generate one test shot, review", "Generate the rest within budget", "Assemble a rough cut"],
    prompt: "Turn my storyboard into shots with Higgsfield. Ask me for the storyboard file. For each shot, write the generation prompt and estimate its credit cost, and show me the total; don't generate anything until I set a budget. Generate ONE test shot first and wait for my review. Then generate the rest, stopping if the budget would be exceeded (remember plan credits and API balance are separate). Assemble a rough cut with ffmpeg (and ElevenLabs VO if I ask). Keep a ledger of every generation and its cost.\n\n{connections}",
    agent: "claude",
  },
  // ── social and sites (accounts) ──
  {
    id: "cross-post-short", cat: "social", title: "Cross-post a short everywhere",
    pitch: "One rendered 9:16 short, trimmed and captioned per platform, uploaded as private drafts to YouTube, TikTok and Instagram for you to publish.",
    needs: [N.shorts, N.chrome], optional: [N.hyperframes, N.ffmpeg, N.scheduler],
    steps: ["Pick the MP4 (newest HyperFrames render, or ask)", "Make platform versions with ffmpeg: length, loudness, safe zones", "Title, description and hashtags per platform in EN / HE / RU", "Upload as private or draft: official API where it's set up, otherwise Claude in Chrome", "Stop before Publish; give me the links"],
    prompt: "Cross-post a short. Ask me which MP4 (or take the newest 9:16 render under ~/Documents/Projects/story-reel or a HyperFrames project). With ffmpeg, make platform versions: YouTube Shorts (under 60 s), TikTok and Instagram Reels (9:16, -14 LUFS, captions clear of the bottom 20%). Write a title, description and hashtags for each platform in my voice, in English, Hebrew and Russian, and show them to me. Then upload each one as PRIVATE / DRAFT: use the official API where this machine has it set up (YouTube Data API with OAuth), otherwise use Claude in Chrome in my signed-in Chrome (check my Accounts in the connections below). Stop before the final Publish or Post button on every platform and give me the draft links. Never publish, never change account settings. " + SAFE + "\n\n{connections}",
    folder: "~/Documents/Projects/story-reel", agent: "claude",
  },
  {
    id: "prophecy-mentions", cat: "social", title: "Who's talking about the 2027 prophecy",
    pitch: "Reddit and Hacker News mentions of the 2027 prophecy and 2027prophecy.com this week, sorted into questions, critiques and chances to help, with reply drafts.",
    needs: [N.mentions], optional: [N.forums, N.gumroad, N.wiki, C("Apify", "svc:apify")],
    steps: ["Search Reddit (public JSON / RSS) and HN (Algolia API) for the last 7 days", "Also run last30days on '2027 human design prophecy'", "Sort: questions, critiques, mentions of my site, opportunities", "Draft helpful replies (no links unless asked for)", "File a wiki page; post nothing"],
    prompt: "Find this week's mentions of the 2027 prophecy. Search Reddit (the public .json or .rss search endpoints; r/humandesign first) and Hacker News (hn.algolia.com/api/v1/search_by_date) for '2027 prophecy', 'human design 2027', '2027prophecy' and '2027prophecy.com' over the last 7 days; add last30days if it's set up. For each hit: link, community, date, one-line summary, and whether it's a question, critique, mention of my site, or a chance to help. Draft short, genuinely helpful replies for the best five (no self-promotion, no links unless someone asks, respect each subreddit's rules). If Gumroad is connected, note whether sales moved on days with mentions. Write ~/wiki/synthesis/2027-mentions-{date}.md and update the wiki index and log. Post nothing, vote nothing.\n\n{connections}",
    folder: "~/wiki", agent: "claude",
  },
  {
    id: "weekly-x-thread", cat: "social", title: "Weekly X thread from the wiki",
    pitch: "What changed in your wiki this week, turned into one honest 5–7 post thread, saved as a draft for you to post.",
    needs: [N.wiki, N.xAcct], optional: [N.scheduler, N.chrome],
    steps: ["Read the last 7 days of ~/wiki/log.md", "Pick the one story worth telling", "Write a 5–7 post thread in my voice, with one image idea", "Save it as a draft (Typefully/Buffer if set up) or show it", "Post only when I say so"],
    prompt: "Write this week's X thread from my wiki. Read ~/wiki/log.md for the last 7 days and the pages it touches; pick the ONE story most worth telling (a shipped project, a finding, a lesson), not a changelog. Write a 5–7 post thread in my voice: concrete, curious, no hype, no hashtags spam, first post works on its own. Suggest one image or screenshot per thread. Check nothing private leaks (people, money, health, unreleased client work). If Typefully or Buffer is set up, save it there as a draft; otherwise show it to me. If I say post, use the X API if set up, otherwise Claude in Chrome on x.com. " + SAFE + "\n\n{connections}",
    folder: "~/wiki", agent: "claude",
  },
  {
    id: "profile-consistency", cat: "social", title: "Make my profiles consistent",
    pitch: "Every social profile you have, read from its public page and compared: name, bio, avatar and links, with one consistent set proposed.",
    needs: [N.social, N.chrome], optional: [N.wiki],
    steps: ["List my accounts and handles from the connections", "Read each public profile page", "Table: name, bio, link, avatar, last post", "Propose one bio per platform and where links should point", "Change nothing; I'll apply what I like"],
    prompt: "Audit my social profiles for consistency. Take the accounts and handles in the connections below (ask me for any handle that's missing). Open each PUBLIC profile page in Chrome (read only): note display name, bio, link(s), avatar, pinned post and the date of the last post. Put it in one table. Then propose a consistent set: one bio per platform within its length limit (EN, plus HE/RU where the audience is), which link each should point to (2027prophecy.com, my site, or a link page), and which accounts look abandoned. Read ~/wiki/index.md for what I'm working on. Change nothing on any account.\n\n{connections}",
    folder: "~", agent: "claude",
  },
  {
    id: "launch-kit", cat: "social", title: "Launch kit: Product Hunt, Show HN, Reddit",
    pitch: "For the project you're in: a Show HN post, a Product Hunt listing, subreddit posts that follow the rules, and screenshots — ready, not posted.",
    needs: [N.launch], optional: [N.xAcct, N.playwright, N.chrome],
    steps: ["Read the project's README and what's new", "Show HN title and first comment by HN's guidelines", "Product Hunt tagline, description, gallery list, maker comment", "Two or three subreddits whose rules allow it, with posts", "Screenshots with Playwright; submit nothing"],
    prompt: "Prepare a launch kit for this project. Read its README and recent commits. Write: 1) a Show HN title and first comment that follow HN's Show HN guidelines (plain, no marketing words); 2) a Product Hunt listing: tagline under 60 characters, description, 4–6 gallery shots to capture, the maker's first comment; 3) two or three subreddits where self-posts like this are allowed (check each one's rules and quote the relevant rule), with a post for each; 4) an X post if an X account is connected. Take the gallery screenshots with Playwright at 1270×760 and 390×844 and look at them. Save everything to LAUNCH.md in the repo. Submit, post or schedule nothing.\n\n{connections}",
    agent: "claude",
  },
  {
    id: "newsletter-from-wiki", cat: "social", title: "Newsletter issue from the wiki",
    pitch: "A short weekly newsletter drafted from your wiki and blog, saved as a draft on Substack, beehiiv, Buttondown or Kit.",
    needs: [N.wiki, N.newsletter], optional: [N.chrome],
    steps: ["Read the week's wiki log and any new blog posts", "Pick three items readers would care about", "Write the issue: subject, preview text, body", "Save as a draft on the newsletter platform", "Send nothing"],
    prompt: "Draft this week's newsletter issue. Read ~/wiki/log.md (last 7 days) and any new posts in my blogs (hd2027-blog, stasmaksin). Pick three things a reader would care about and write the issue: subject line, preview text, and a body of under 400 words with one clear call to action (2027prophecy.com where it fits). Keep private things out (people, money, clients). Save it as a DRAFT on the newsletter platform I have (API if set up, otherwise Claude in Chrome), and show it to me. Never send or schedule.\n\n{connections}",
    folder: "~/wiki", agent: "claude",
  },
];

// ── readiness against one machine's scan ────────────────────────────────────
export type NeedState = "ready" | "partial" | "missing";
export type NeedCheck = { label: string; state: NeedState; id?: string; name?: string };
export type Readiness = { state: "ready" | "almost" | "missing"; needs: NeedCheck[]; optional: NeedCheck[]; missing: number };

function check(need: Need, items: Item[]): NeedCheck {
  let best: NeedCheck = { label: need.label, state: "missing" };
  for (const pat of need.any) {
    // A card also answers for the ids it replaced (a project card for its MCP server and service card).
    const hits = pat.endsWith("*") ? items.filter((i) => i.id.startsWith(pat.slice(0, -1)) || i.aliases?.some((a) => a.startsWith(pat.slice(0, -1)))) : items.filter((i) => i.id === pat || i.aliases?.includes(pat));
    for (const i of hits) {
      const st = stateOf(i);
      const s: NeedState = st === "ready" ? "ready" : st === "off" ? "missing" : "partial";
      if (s === "ready") return { label: need.label, state: s, id: i.id, name: i.name };
      if (s === "partial" && best.state === "missing") best = { label: need.label, state: s, id: i.id, name: i.name };
    }
  }
  return best;
}
export function readiness(r: Recipe, inv: Inventory | undefined): Readiness {
  const items = inv ? allItems(inv) : []; // hidden cards still count: hiding is about the view
  const needs = r.needs.map((n) => check(n, items));
  const optional = (r.optional ?? []).map((n) => check(n, items));
  const missing = needs.filter((n) => n.state === "missing").length;
  const state = missing ? "missing" : needs.some((n) => n.state === "partial") ? "almost" : "ready";
  return { state, needs, optional, missing };
}
const RANK = { ready: 0, almost: 1, missing: 2 };
/** Ready first, then almost-ready, then by how few are missing; yours before built-ins at the same level. */
export function rankRecipes<T extends Recipe>(list: T[], inv: Inventory | undefined): (T & { ready: Readiness })[] {
  return list.map((r) => ({ ...r, ready: readiness(r, inv) }))
    .sort((a, b) => RANK[a.ready.state] - RANK[b.ready.state] || a.ready.missing - b.ready.missing || Number(!!b.custom) - Number(!!a.custom) || a.title.localeCompare(b.title));
}
/** Ids of the connections a recipe will use on this machine (needs and optionals that are there). */
export function recipeIds(r: Recipe, inv: Inventory | undefined): string[] {
  const rd = readiness(r, inv);
  return [...rd.needs, ...rd.optional].filter((n) => n.id && n.state !== "missing").map((n) => n.id!);
}
export function fillPrompt(r: Recipe, v: { connections: string; machine: string; date?: string; selected?: string }): string {
  const date = v.date ?? new Date().toISOString().slice(0, 10);
  let p = r.prompt.replaceAll("{machine}", v.machine).replaceAll("{date}", date).replaceAll("{selected}", v.selected ?? "");
  const ctx = [v.connections, v.selected ? `Also use these connections I picked:\n${v.selected}` : ""].filter(Boolean).join("\n\n");
  p = p.includes("{connections}") ? p.replaceAll("{connections}", ctx) : `${p}\n\n${ctx}`;
  return p.trim();
}

// ── your recipes ────────────────────────────────────────────────────────────
const FILE = () => `${homedir()}/.config/herdr-deck/recipes.json`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
export function loadCustom(): Recipe[] {
  try { const j = JSON.parse(readFileSync(FILE(), "utf8")); return (Array.isArray(j.custom) ? j.custom : []).map((r: Recipe) => ({ ...r, custom: true })); } catch { return []; }
}
function writeCustom(list: Recipe[]) {
  mkdirSync(`${homedir()}/.config/herdr-deck`, { recursive: true });
  writeFileSync(FILE(), JSON.stringify({ custom: list.map(({ custom, ...r }) => r) }, null, 1));
}
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const needList = (v: unknown): Need[] => (Array.isArray(v) ? v : []).slice(0, 12).map((n: any) => ({ label: str(n?.label, 80), any: (Array.isArray(n?.any) ? n.any : []).map((x: unknown) => str(x, 120)).filter(Boolean).slice(0, 8) })).filter((n) => n.label && n.any.length);
/** Validate and save one of your recipes (new, or an edit of one of yours). Built-ins are never changed: customizing one saves a copy. */
export function saveCustom(input: any): Recipe {
  const title = str(input?.title, 80);
  if (!title) throw new Error("A recipe needs a title");
  const prompt = str(input?.prompt, 8000);
  if (!prompt) throw new Error("A recipe needs a prompt");
  const list = loadCustom();
  const editing = typeof input?.id === "string" && list.some((r) => r.id === input.id) ? input.id : undefined;
  let id = editing ?? `mine:${slug(title) || "recipe"}`;
  if (!editing) { let n = 2; const base = id; while (list.some((r) => r.id === id)) id = `${base}-${n++}`; }
  const agent = ["claude", "codex", "opencode"].includes(input?.agent) ? input.agent : "claude";
  const r: Recipe = {
    id, title, prompt, agent,
    pitch: str(input?.pitch, 240), cat: str(input?.cat, 20) || "yours",
    needs: needList(input?.needs), optional: needList(input?.optional),
    steps: (Array.isArray(input?.steps) ? input.steps : String(input?.steps ?? "").split("\n")).map((s: unknown) => str(s, 300)).filter(Boolean).slice(0, 12),
    folder: str(input?.folder, 300) || undefined,
    machine: input?.machine === "other" ? "other" : undefined,
    from: str(input?.from, 80) || undefined,
    custom: true,
  };
  writeCustom([...list.filter((x) => x.id !== id), r]);
  return r;
}
export function deleteCustom(id: string) {
  const list = loadCustom();
  if (!list.some((r) => r.id === id)) throw new Error("Only your own recipes can be deleted");
  writeCustom(list.filter((r) => r.id !== id));
}
export const allRecipes = () => [...loadCustom(), ...RECIPES];
