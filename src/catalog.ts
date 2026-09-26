// The accounts catalog: which sites and services a saved login (or an account you add by hand) stands for, what
// agents can do with each, and how to connect it. Plus the curated list of services worth signing up for.
// Pure data: no imports with side effects, so the store, the scanner and the tests can all share it.

/** How an agent reaches a service. */
export type How = "api" | "cli" | "mcp" | "browser" | "rss" | "export";
export const HOW_LABEL: Record<How, string> = { api: "API", cli: "CLI", mcp: "MCP", browser: "Claude in Chrome", rss: "RSS", export: "Export" };

export type Site = {
  id: string; name: string;
  /** Store category of the card. "social" and "sites" are account categories; others keep an existing service card where it is. */
  cat: string;
  color: string; glyph?: string;
  /** Registrable domains or hosts; a login on any subdomain matches. The longest match wins. */
  domains: string[];
  /** Android app ids that stand for the site in "android://…@<package>/" logins. */
  android?: string[];
  what: string; // what it is
  agents: string; // what agents can do with it
  connect: [How, string][]; // how to connect, best first
  /** Merge into this scanner card (e.g. "svc:x-twitter") instead of making an "acct:<id>" card. */
  svc?: string;
  /** A saved login in Chrome makes it usable by agents (Claude in Chrome). False for API-first services. */
  browser?: boolean;
  /** Extra evidence: desktop apps (macOS .app names), CLIs, env var names, MCP server names. */
  apps?: string[]; bins?: string[]; env?: RegExp; mcp?: RegExp;
  /** Profile URL for a handle: {h} is the handle without a leading @. */
  profile?: string;
};

const B = "browser" as const, A = "api" as const, R = "rss" as const, E = "export" as const, M = "mcp" as const, L = "cli" as const;
const DRAFT = "Draft first; post, send or change anything only when asked.";

// ── Social media ─────────────────────────────────────────────────────────────
const SOCIAL: Site[] = [
  { id: "x", name: "X (Twitter)", cat: "social", color: "#000000", glyph: "X", domains: ["x.com", "twitter.com"], android: ["com.twitter.android"], svc: "svc:x-twitter", browser: true, profile: "https://x.com/{h}",
    what: "Posts, threads, replies and DMs", agents: `Draft threads and replies, read mentions and your timeline. ${DRAFT}`,
    connect: [[A, "X API v2 with keys in an env file (posting needs a paid tier)"], [B, "x.com in your signed-in Chrome"], [M, "Typefully or Buffer to schedule drafts"]] },
  { id: "instagram", name: "Instagram", cat: "social", color: "#e1306c", glyph: "IG", domains: ["instagram.com"], android: ["com.instagram.android"], browser: true, profile: "https://www.instagram.com/{h}/",
    what: "Photos, reels and stories", agents: `Prepare reels and captions, read comments and insights. ${DRAFT}`,
    connect: [[A, "Instagram Graph API (needs a Business or Creator account linked to a Facebook Page)"], [B, "instagram.com in your signed-in Chrome"], [E, "Download your data (JSON)"]] },
  { id: "tiktok", name: "TikTok", cat: "social", color: "#010101", glyph: "TT", domains: ["tiktok.com"], android: ["com.zhiliaoapp.musically"], browser: true, profile: "https://www.tiktok.com/@{h}",
    what: "Short vertical video", agents: `Prepare shorts, captions and hashtags; upload as a draft for your review. ${DRAFT}`,
    connect: [[A, "TikTok Content Posting API (needs an approved developer app)"], [B, "TikTok Studio in your signed-in Chrome"]] },
  { id: "youtube", name: "YouTube", cat: "social", color: "#ff0000", glyph: "YT", domains: ["youtube.com", "studio.youtube.com"], android: ["com.google.android.youtube"], svc: "svc:youtube-data-api", browser: true, env: /^YOUTUBE_/, profile: "https://www.youtube.com/@{h}",
    what: "Your channel, Shorts and comments", agents: `Upload videos and Shorts as private or unlisted, write titles and descriptions, read comments and analytics. ${DRAFT}`,
    connect: [[A, "YouTube Data API v3 (uploads need OAuth; reads work with an API key)"], [B, "YouTube Studio in your signed-in Chrome"], [R, "Channel RSS: youtube.com/feeds/videos.xml?channel_id=…"], [L, "yt-dlp to read public videos"]] },
  { id: "facebook", name: "Facebook", cat: "social", color: "#1877f2", glyph: "f", domains: ["facebook.com", "fb.com", "messenger.com"], android: ["com.facebook.katana"], browser: true, profile: "https://www.facebook.com/{h}",
    what: "Profile, Pages and groups", agents: `Draft Page posts, read group discussions you're in. ${DRAFT}`,
    connect: [[A, "Graph API for Pages you manage"], [B, "facebook.com in your signed-in Chrome"], [E, "Download your information"]] },
  { id: "linkedin", name: "LinkedIn", cat: "social", color: "#0a66c2", glyph: "in", domains: ["linkedin.com"], android: ["com.linkedin.android"], browser: true, profile: "https://www.linkedin.com/in/{h}/",
    what: "Professional profile and posts", agents: `Draft posts and profile updates, read your feed and messages. ${DRAFT}`,
    connect: [[A, "LinkedIn Posts API (needs an approved app)"], [B, "linkedin.com in your signed-in Chrome"], [E, "Get a copy of your data"]] },
  { id: "reddit", name: "Reddit", cat: "social", color: "#ff4500", glyph: "r/", domains: ["reddit.com"], android: ["com.reddit.frontpage"], browser: true, profile: "https://www.reddit.com/user/{h}/",
    what: "Communities, posts and comments", agents: `Search subreddits for questions and mentions, draft replies that follow each subreddit's rules. ${DRAFT}`,
    connect: [[A, "Reddit API with a script app (OAuth)"], [R, "Add .rss to any subreddit or search URL"], [B, "reddit.com in your signed-in Chrome"]] },
  { id: "threads", name: "Threads", cat: "social", color: "#000000", glyph: "@", domains: ["threads.net", "threads.com"], android: ["com.instagram.barcelona"], browser: true, profile: "https://www.threads.net/@{h}",
    what: "Meta's text posts", agents: `Draft posts and replies. ${DRAFT}`,
    connect: [[A, "Threads API (Meta developer app)"], [B, "threads.net in your signed-in Chrome"]] },
  { id: "bluesky", name: "Bluesky", cat: "social", color: "#0085ff", glyph: "B", domains: ["bsky.app", "bsky.social"], android: ["xyz.blueskyweb.app"], browser: true, env: /^(BLUESKY|BSKY)_/, profile: "https://bsky.app/profile/{h}",
    what: "Open social network (AT Protocol)", agents: `Post and read with an app password; easy to automate. ${DRAFT}`,
    connect: [[A, "AT Protocol API with an app password (Settings → App passwords)"], [R, "Profile RSS: bsky.app/profile/<handle>/rss"], [B, "bsky.app in your signed-in Chrome"]] },
  { id: "mastodon", name: "Mastodon", cat: "social", color: "#6364ff", glyph: "M", domains: ["mastodon.social", "mastodon.online", "mstdn.social", "fosstodon.org", "hachyderm.io", "infosec.exchange", "techhub.social"], browser: true, env: /^MASTODON_/,
    what: "Fediverse posts", agents: `Post and read with an access token. ${DRAFT}`,
    connect: [[A, "Mastodon REST API with an access token from your server's Development settings"], [R, "Profile RSS: <server>/@<handle>.rss"]] },
  { id: "telegram", name: "Telegram", cat: "social", color: "#26a5e4", glyph: "TG", domains: ["telegram.org", "t.me"], android: ["org.telegram.messenger"], svc: "svc:telegram", browser: false, apps: ["Telegram.app", "Telegram Desktop.app"], bins: ["telegram-desktop"], profile: "https://t.me/{h}",
    what: "Chats, channels and bots", agents: "Send to your own bot chat or channel with a bot token; never message people without asking.",
    connect: [[A, "Bot API: create a bot with @BotFather, keep the token in an env file"], [B, "web.telegram.org in your signed-in Chrome"], [E, "Telegram Desktop → Export chat history"]] },
  { id: "whatsapp", name: "WhatsApp", cat: "social", color: "#25d366", glyph: "WA", domains: ["whatsapp.com"], android: ["com.whatsapp"], svc: "svc:whatsapp", browser: false, apps: ["WhatsApp.app"],
    what: "Chats and groups", agents: "Read what you point it at; never message anyone without asking.",
    connect: [[A, "WhatsApp Business Cloud API (a business number)"], [B, "web.whatsapp.com in your signed-in Chrome"], [E, "Export chat (per conversation)"]] },
  { id: "discord", name: "Discord", cat: "social", color: "#5865f2", glyph: "DC", domains: ["discord.com", "discordapp.com", "discord.gg"], svc: "svc:discord", browser: false, apps: ["Discord.app"], bins: ["discord"],
    what: "Servers, channels and bots", agents: "Post to your own server through a bot; read channels the bot can see.",
    connect: [[A, "Discord bot token (discord.com/developers)"], [A, "Channel webhooks for one-way posts"], [B, "discord.com in your signed-in Chrome"]] },
  { id: "pinterest", name: "Pinterest", cat: "social", color: "#e60023", glyph: "P", domains: ["pinterest.com", "pinterest.co.uk", "pinterest.de", "pinterest.fr", "pinterest.ca"], browser: true, profile: "https://www.pinterest.com/{h}/",
    what: "Pins and boards", agents: `Pin images and videos to boards with links back to your site. ${DRAFT}`,
    connect: [[A, "Pinterest API v5"], [B, "pinterest.com in your signed-in Chrome"], [R, "Board RSS: pinterest.com/<user>/<board>.rss"]] },
  { id: "medium", name: "Medium", cat: "social", color: "#000000", glyph: "Me", domains: ["medium.com"], browser: true, profile: "https://medium.com/@{h}",
    what: "Blog posts", agents: `Draft and import stories; cross-post from your blog with a canonical link. ${DRAFT}`,
    connect: [[B, "medium.com in your signed-in Chrome (import a story from a URL)"], [R, "medium.com/feed/@<handle>"]] },
  { id: "substack", name: "Substack", cat: "social", color: "#ff6719", glyph: "S", domains: ["substack.com"], browser: true, profile: "https://{h}.substack.com",
    what: "Newsletter and posts", agents: `Draft posts and Notes; read subscriber counts. ${DRAFT}`,
    connect: [[B, "substack.com in your signed-in Chrome"], [R, "<name>.substack.com/feed"], [E, "Subscriber CSV export"]] },
  { id: "product-hunt", name: "Product Hunt", cat: "social", color: "#da552f", glyph: "PH", domains: ["producthunt.com"], browser: true, profile: "https://www.producthunt.com/@{h}",
    what: "Launches and maker profile", agents: `Prepare a launch: tagline, gallery, first comment. ${DRAFT}`,
    connect: [[A, "Product Hunt API v2 (GraphQL, mostly read)"], [B, "producthunt.com in your signed-in Chrome"]] },
  { id: "hacker-news", name: "Hacker News", cat: "social", color: "#ff6600", glyph: "Y", domains: ["news.ycombinator.com"], browser: true, profile: "https://news.ycombinator.com/user?id={h}",
    what: "Show HN, comments", agents: `Search stories and comments (no login needed), draft a Show HN. ${DRAFT}`,
    connect: [[A, "HN Algolia search API and the Firebase API (read, no key)"], [B, "news.ycombinator.com in your signed-in Chrome to post"]] },
  { id: "dev-to", name: "DEV", cat: "social", color: "#0a0a0a", glyph: "DEV", domains: ["dev.to"], browser: true, env: /^(DEVTO|DEV_TO|FOREM)_/, profile: "https://dev.to/{h}",
    what: "Developer articles", agents: `Publish articles as drafts from markdown. ${DRAFT}`,
    connect: [[A, "Forem API with an API key (Settings → Extensions)"], [R, "dev.to/feed/<handle>"]] },
  { id: "indie-hackers", name: "Indie Hackers", cat: "social", color: "#0e2439", glyph: "IH", domains: ["indiehackers.com"], browser: true, profile: "https://www.indiehackers.com/{h}",
    what: "Founder community and product pages", agents: `Draft milestone posts and product updates. ${DRAFT}`,
    connect: [[B, "indiehackers.com in your signed-in Chrome"]] },
  { id: "twitch", name: "Twitch", cat: "social", color: "#9146ff", glyph: "Tw", domains: ["twitch.tv"], browser: true, profile: "https://www.twitch.tv/{h}",
    what: "Live streams and clips", agents: "Read stream and clip data; manage titles.", connect: [[A, "Twitch Helix API"], [B, "twitch.tv in your signed-in Chrome"]] },
  { id: "vk", name: "VK", cat: "social", color: "#0077ff", glyph: "VK", domains: ["vk.com", "vk.ru"], browser: true, profile: "https://vk.com/{h}",
    what: "Russian-language social network", agents: `Draft posts for Russian-speaking audiences. ${DRAFT}`, connect: [[A, "VK API with a user or community token"], [B, "vk.com in your signed-in Chrome"]] },
  { id: "tumblr", name: "Tumblr", cat: "social", color: "#001935", glyph: "t", domains: ["tumblr.com"], browser: true, what: "Blog posts and reblogs", agents: DRAFT, connect: [[A, "Tumblr API"], [R, "<blog>.tumblr.com/rss"]] },
  { id: "snapchat", name: "Snapchat", cat: "social", color: "#fffc00", glyph: "Sc", domains: ["snapchat.com"], browser: true, what: "Stories and Spotlight", agents: DRAFT, connect: [[B, "Snapchat web in your signed-in Chrome"]] },
];

// ── Sites & accounts: logins that merge into existing service cards ─────────
// (cat stays where the scanner puts the card; the login is added as evidence.)
const s = (id: string, svc: string, domains: string[], name: string, cat: string, color: string): Site => ({ id, svc, domains, name, cat, color, what: "", agents: "", connect: [] });
const MERGE: Site[] = [
  s("github", "svc:github", ["github.com"], "GitHub", "code", "#24292f"), s("gitlab", "svc:gitlab", ["gitlab.com"], "GitLab", "code", "#fc6d26"),
  s("npm", "svc:npm", ["npmjs.com"], "npm", "code", "#cb3837"), s("linear", "svc:linear", ["linear.app"], "Linear", "code", "#5e6ad2"),
  s("atlassian", "svc:atlassian-jira-rovo-dev", ["atlassian.net", "atlassian.com"], "Atlassian", "code", "#0052cc"),
  s("cursor", "svc:cursor", ["cursor.com", "cursor.sh"], "Cursor", "code", "#1b1b1b"),
  s("vercel", "svc:vercel", ["vercel.com"], "Vercel", "cloud", "#000000"), s("netlify", "svc:netlify", ["netlify.com"], "Netlify", "cloud", "#00ad9f"),
  s("cloudflare", "svc:cloudflare", ["cloudflare.com"], "Cloudflare", "cloud", "#f38020"), s("firebase", "svc:firebase", ["console.firebase.google.com"], "Firebase", "cloud", "#ffca28"),
  s("fly", "svc:fly-io", ["fly.io"], "Fly.io", "cloud", "#7b3fe4"), s("railway", "svc:railway", ["railway.app", "railway.com"], "Railway", "cloud", "#0b0d0e"),
  s("render", "svc:render", ["render.com"], "Render", "cloud", "#46e3b7"), s("heroku", "svc:heroku", ["heroku.com"], "Heroku", "cloud", "#430098"),
  s("digitalocean", "svc:digitalocean", ["digitalocean.com"], "DigitalOcean", "cloud", "#0080ff"), s("aws", "svc:aws", ["aws.amazon.com", "signin.aws.amazon.com", "console.aws.amazon.com"], "AWS", "cloud", "#ff9900"),
  s("gcloud", "svc:google-cloud", ["console.cloud.google.com", "cloud.google.com"], "Google Cloud", "cloud", "#4285f4"), s("azure", "svc:azure", ["portal.azure.com", "azure.com"], "Azure", "cloud", "#0078d4"),
  s("docker", "svc:docker", ["docker.com"], "Docker", "cloud", "#2496ed"), s("auth0", "svc:auth0", ["auth0.com"], "Auth0", "cloud", "#eb5424"),
  s("tailscale", "svc:tailscale", ["tailscale.com"], "Tailscale", "devices", "#242424"), s("ngrok", "svc:ngrok", ["ngrok.com"], "ngrok", "devices", "#1f1e37"),
  s("supabase", "svc:supabase", ["supabase.com", "supabase.io"], "Supabase", "data", "#3ecf8e"), s("neon", "svc:neon", ["neon.tech", "neon.com"], "Neon", "data", "#00e599"),
  s("upstash", "svc:upstash", ["upstash.com"], "Upstash", "data", "#00e9a3"), s("mongodb", "svc:mongodb", ["mongodb.com"], "MongoDB", "data", "#47a248"),
  s("slack", "svc:slack", ["slack.com"], "Slack", "comms", "#4a154b"), s("twilio", "svc:twilio", ["twilio.com"], "Twilio", "comms", "#f22f46"),
  s("resend", "svc:resend", ["resend.com"], "Resend", "comms", "#000000"), s("zoom", "svc:zoom", ["zoom.us"], "Zoom", "comms", "#0b5cff"),
  s("adobe", "svc:adobe", ["adobe.com"], "Adobe", "media", "#fa0f00"), s("canva", "svc:canva", ["canva.com"], "Canva", "media", "#00c4cc"),
  s("figma", "svc:figma", ["figma.com"], "Figma", "media", "#a259ff"), s("elevenlabs", "svc:elevenlabs", ["elevenlabs.io"], "ElevenLabs", "media", "#000000"),
  s("higgsfield", "svc:higgsfield", ["higgsfield.ai"], "Higgsfield", "media", "#c6ff00"), s("invideo", "svc:invideo", ["invideo.io"], "InVideo", "media", "#5b3df5"),
  s("fal", "svc:fal", ["fal.ai"], "fal", "media", "#7c3aed"), s("heygen", "svc:heygen", ["heygen.com"], "HeyGen", "media", "#7559ff"),
  s("runway", "svc:runway", ["runwayml.com"], "Runway", "media", "#000000"), s("cloudinary", "svc:cloudinary", ["cloudinary.com"], "Cloudinary", "media", "#3448c5"),
  s("notion", "svc:notion", ["notion.so", "notion.com"], "Notion", "knowledge", "#000000"), s("gdrive", "svc:google-drive", ["drive.google.com", "docs.google.com"], "Google Drive", "knowledge", "#1fa463"),
  s("stripe", "svc:stripe", ["stripe.com"], "Stripe", "commerce", "#635bff"), s("gumroad", "svc:gumroad", ["gumroad.com"], "Gumroad", "commerce", "#ff90e8"),
  s("shopify", "svc:shopify", ["shopify.com", "myshopify.com"], "Shopify", "commerce", "#95bf47"), s("lemon-squeezy", "svc:lemon-squeezy", ["lemonsqueezy.com"], "Lemon Squeezy", "commerce", "#ffc233"),
  s("n8n", "svc:n8n", ["n8n.io", "n8n.cloud"], "n8n", "automation", "#ea4b71"),
  s("openai", "svc:openai-api", ["openai.com", "chatgpt.com"], "OpenAI", "ai", "#10a37f"), s("anthropic", "svc:anthropic-api", ["anthropic.com", "claude.ai", "claude.com"], "Anthropic", "ai", "#d97757"),
  s("openrouter", "svc:openrouter", ["openrouter.ai"], "OpenRouter", "ai", "#6467f2"), s("huggingface", "svc:hugging-face", ["huggingface.co"], "Hugging Face", "ai", "#ffd21e"),
  s("replicate", "svc:replicate", ["replicate.com"], "Replicate", "ai", "#000000"), s("gemini", "svc:google-ai", ["aistudio.google.com", "gemini.google.com"], "Google AI", "ai", "#4285f4"),
  s("deepseek", "svc:deepseek", ["deepseek.com"], "DeepSeek", "ai", "#4d6bfe"), s("groq", "svc:groq", ["groq.com"], "Groq", "ai", "#f55036"),
  s("mistral", "svc:mistral", ["mistral.ai"], "Mistral", "ai", "#fa520f"), s("xai", "svc:xai", ["x.ai", "console.x.ai"], "xAI", "ai", "#000000"),
  s("deepgram", "svc:deepgram", ["deepgram.com"], "Deepgram", "ai", "#13ef93"), s("perplexity", "svc:perplexity", ["perplexity.ai"], "Perplexity", "research", "#20808d"),
  s("tavily", "svc:tavily", ["tavily.com"], "Tavily", "research", "#2563eb"), s("firecrawl", "svc:firecrawl", ["firecrawl.dev"], "Firecrawl", "research", "#ff6b00"),
  s("apify", "svc:apify", ["apify.com"], "Apify", "research", "#97d700"), s("serper", "svc:serper", ["serper.dev"], "Serper", "research", "#4f46e5"),
  s("brave-search", "svc:brave-search", ["api-dashboard.search.brave.com", "api.search.brave.com"], "Brave Search", "research", "#fb542b"),
  s("hunter", "svc:hunter", ["hunter.io"], "Hunter", "research", "#fa5320"), s("apollo", "svc:apollo", ["apollo.io"], "Apollo", "research", "#1a1a1a"),
  s("onepassword", "svc:1password", ["1password.com"], "1Password", "keys", "#0572ec"),
];

// ── Sites & accounts: everything else worth a card ───────────────────────────
const site = (id: string, name: string, color: string, glyph: string | undefined, domains: string[], what: string, agents: string, connect: [How, string][], more: Partial<Site> = {}): Site =>
  ({ id, name, cat: "sites", color, glyph, domains, what, agents, connect, browser: true, ...more });
const CHROME = (host: string): [How, string] => [B, `${host} in your signed-in Chrome`];
const SITES: Site[] = [
  site("google", "Google account", "#4285f4", "G", ["accounts.google.com", "google.com", "myaccount.google.com"], "Gmail, Drive, Calendar, YouTube, Search Console", "Use the Gmail, Drive and Calendar connectors; Search Console and Analytics through the browser.", [[M, "claude.ai Gmail, Drive and Calendar connectors"], CHROME("Google")]),
  site("microsoft", "Microsoft account", "#0078d4", "Ms", ["live.com", "microsoft.com", "outlook.com", "office.com", "microsoftonline.com"], "Outlook, OneDrive, Office", "Read mail and files through Microsoft Graph or the browser.", [[A, "Microsoft Graph"], CHROME("outlook.com")]),
  site("apple", "Apple ID", "#555555", "A", ["apple.com", "icloud.com", "appstoreconnect.apple.com", "developer.apple.com"], "App Store Connect, developer account", "Check App Store Connect builds and reviews through the browser (never Keychain).", [CHROME("App Store Connect"), [L, "xcrun altool / notarytool for uploads"]]),
  site("amazon", "Amazon", "#ff9900", "a", ["amazon.com", "amazon.de", "amazon.co.uk"], "Shopping and orders", "Look up orders and products; never buy without asking.", [CHROME("amazon.com")]),
  site("bitbucket", "Bitbucket", "#0052cc", "Bb", ["bitbucket.org"], "Git repos", "Clone and review repos with an app password.", [[A, "Bitbucket REST API with an app password"], [L, "git over SSH"]], { browser: false }),
  site("replit", "Replit", "#f26207", "Re", ["replit.com"], "Cloud IDE and hosting", "Open and run Repls through the browser.", [CHROME("replit.com")]),
  site("lovable", "Lovable", "#ff4f7b", "Lv", ["lovable.dev"], "AI app builder", "Prompt and iterate on a Lovable app, then sync to GitHub.", [CHROME("lovable.dev"), [L, "GitHub sync, then work on the repo locally"]]),
  site("v0", "v0", "#000000", "v0", ["v0.dev", "v0.app"], "AI UI builder (Vercel)", "Generate UI and pull it into a repo with the shadcn CLI.", [CHROME("v0.dev"), [L, "npx shadcn add <v0 url>"]]),
  site("bolt", "Bolt", "#1389fd", "Bo", ["bolt.new", "stackblitz.com"], "AI app builder", "Prompt apps in the browser and export them.", [CHROME("bolt.new")]),
  site("kling", "Kling AI", "#0c0c0c", "Kl", ["klingai.com"], "AI video generation", "Generate shots in the browser; say the credit cost first.", [CHROME("klingai.com"), [A, "Kling API (separate developer balance)"]]),
  site("luma", "Luma", "#111111", "Lu", ["lumalabs.ai"], "Dream Machine video and Ray models", "Generate shots; say the credit cost first.", [[A, "Luma API"], CHROME("lumalabs.ai")]),
  site("pika", "Pika", "#000000", "Pk", ["pika.art"], "AI video effects", "Generate clips in the browser.", [CHROME("pika.art")]),
  site("midjourney", "Midjourney", "#000000", "MJ", ["midjourney.com"], "Image generation", "Generate and download images in the web app.", [CHROME("midjourney.com")]),
  site("ideogram", "Ideogram", "#000000", "Id", ["ideogram.ai"], "Image generation with good text", "Generate posters and thumbnails.", [[A, "Ideogram API"], CHROME("ideogram.ai")]),
  site("leonardo", "Leonardo", "#6c47ff", "Le", ["leonardo.ai"], "Image generation", "Generate images and textures.", [[A, "Leonardo API"], CHROME("leonardo.ai")]),
  site("krea", "Krea", "#000000", "Kr", ["krea.ai"], "Real-time image and video generation", "Generate and upscale images.", [CHROME("krea.ai")]),
  site("suno", "Suno", "#000000", "Su", ["suno.com", "suno.ai"], "AI music", "Generate songs and stems for videos.", [CHROME("suno.com")]),
  site("udio", "Udio", "#e30b5c", "Ud", ["udio.com"], "AI music", "Generate tracks for videos.", [CHROME("udio.com")]),
  site("capcut", "CapCut", "#000000", "CC", ["capcut.com"], "Video editor", "Edit and caption shorts in the web editor.", [CHROME("capcut.com")]),
  site("descript", "Descript", "#0b0bff", "De", ["descript.com"], "Edit audio and video by text", "Transcribe and cut in the web app.", [CHROME("descript.com")]),
  site("spotify", "Spotify", "#1db954", "Sp", ["spotify.com"], "Music and podcasts", "Read your playlists and podcast stats.", [[A, "Spotify Web API"], CHROME("spotify.com")]),
  site("soundcloud", "SoundCloud", "#ff5500", "SC", ["soundcloud.com"], "Audio hosting", "Upload tracks for sharing.", [CHROME("soundcloud.com")]),
  site("behance", "Behance", "#1769ff", "Be", ["behance.net"], "Design portfolio", "Publish project pages.", [CHROME("behance.net")]),
  site("dribbble", "Dribbble", "#ea4c89", "Dr", ["dribbble.com"], "Design shots", "Publish shots.", [CHROME("dribbble.com")]),
  site("unsplash", "Unsplash", "#000000", "U", ["unsplash.com"], "Free stock photos", "Search and download photos with credit.", [[A, "Unsplash API"]]),
  site("gamma", "Gamma", "#6b4eff", "Ga", ["gamma.app"], "AI decks and pages", "Generate decks and one-pagers.", [[A, "Gamma API"], CHROME("gamma.app")]),
  site("obsidian", "Obsidian account", "#7c3aed", "Ob", ["obsidian.md"], "Sync and Publish", "Vaults are local folders; Publish through the app.", [[L, "Edit the vault's markdown directly"]]),
  site("dropbox", "Dropbox", "#0061ff", "Db", ["dropbox.com"], "File storage", "Sync files with rclone.", [[L, "rclone remote"], [A, "Dropbox API"]], { browser: false }),
  site("wetransfer", "WeTransfer", "#409fff", "WT", ["wetransfer.com"], "Send big files", "Share renders through the browser.", [CHROME("wetransfer.com")]),
  site("airtable", "Airtable", "#18bfff", "At", ["airtable.com"], "Spreadsheet databases", "Read and write bases.", [[A, "Airtable API with a personal access token"], [M, "Airtable MCP server"]]),
  site("trello", "Trello", "#0052cc", "Tr", ["trello.com"], "Boards", "Create and move cards.", [[A, "Trello REST API"]]),
  site("asana", "Asana", "#f06a6a", "As", ["asana.com"], "Projects and tasks", "Create and update tasks.", [[A, "Asana API"], [M, "Asana MCP server"]]),
  site("clickup", "ClickUp", "#7b68ee", "CU", ["clickup.com"], "Projects and docs", "Create and update tasks.", [[A, "ClickUp API"]]),
  site("monday", "monday.com", "#ff3d57", "mo", ["monday.com"], "Work management", "Read and update boards.", [[A, "monday GraphQL API"], [M, "monday MCP server"]]),
  site("calendly", "Calendly", "#006bff", "Ca", ["calendly.com"], "Booking pages", "Read bookings; share links.", [[A, "Calendly API"]]),
  site("cal-com", "Cal.com", "#111827", "Cal", ["cal.com"], "Open-source booking", "Create booking types and read bookings.", [[A, "Cal.com API"]]),
  site("typeform", "Typeform", "#262627", "Ty", ["typeform.com"], "Forms and quizzes", "Read responses; build forms.", [[A, "Typeform API"]]),
  site("tally", "Tally", "#000000", "Ta", ["tally.so"], "Forms", "Read responses through webhooks.", [[A, "Webhooks and API"]]),
  site("zapier", "Zapier", "#ff4f00", "Z", ["zapier.com"], "Automation", "Trigger Zaps; Zapier MCP exposes actions to agents.", [[M, "Zapier MCP"], [A, "Webhooks"]]),
  site("make", "Make", "#6d00cc", "Mk", ["make.com", "integromat.com"], "Automation scenarios", "Run scenarios through webhooks.", [[A, "Make API and webhooks"]]),
  site("ifttt", "IFTTT", "#000000", "If", ["ifttt.com"], "Simple automations", "Trigger applets through webhooks.", [[A, "Webhooks service"]]),
  site("mailchimp", "Mailchimp", "#ffe01b", "Mc", ["mailchimp.com"], "Email marketing", "Draft campaigns; read list stats.", [[A, "Mailchimp Marketing API"]]),
  site("beehiiv", "beehiiv", "#fbbf24", "bh", ["beehiiv.com"], "Newsletter platform", "Draft posts; read subscriber stats.", [[A, "beehiiv API"], CHROME("beehiiv.com")]),
  site("buttondown", "Buttondown", "#0069ff", "Bd", ["buttondown.email", "buttondown.com"], "Markdown newsletter", "Draft emails from markdown.", [[A, "Buttondown API"]]),
  site("kit", "Kit (ConvertKit)", "#fb6970", "K", ["convertkit.com", "kit.com"], "Creator email", "Draft broadcasts; read subscriber stats.", [[A, "Kit API"]]),
  site("sendgrid", "SendGrid", "#1a82e2", "SG", ["sendgrid.com"], "Transactional email", "Send through the API.", [[A, "SendGrid API"]], { browser: false }),
  site("postmark", "Postmark", "#ffde00", "Pm", ["postmarkapp.com"], "Transactional email", "Send through the API.", [[A, "Postmark API"]], { browser: false }),
  site("buffer", "Buffer", "#231f20", "Bu", ["buffer.com"], "Schedule social posts", "Queue drafts across channels for your approval.", [[A, "Buffer API"], CHROME("buffer.com")]),
  site("typefully", "Typefully", "#000000", "Tf", ["typefully.com"], "Write and schedule threads", "Save thread drafts for review.", [[A, "Typefully API"], CHROME("typefully.com")]),
  site("hootsuite", "Hootsuite", "#143059", "Hs", ["hootsuite.com"], "Social scheduling", "Queue posts.", [CHROME("hootsuite.com")]),
  site("patreon", "Patreon", "#ff424d", "Pa", ["patreon.com"], "Memberships", "Draft posts; read member counts.", [[A, "Patreon API"], CHROME("patreon.com")]),
  site("buymeacoffee", "Buy Me a Coffee", "#ffdd00", "BMC", ["buymeacoffee.com"], "Tips and memberships", "Read supporters.", [CHROME("buymeacoffee.com")]),
  site("ko-fi", "Ko-fi", "#29abe0", "Ko", ["ko-fi.com"], "Tips and shop", "Read supporters.", [CHROME("ko-fi.com")]),
  site("etsy", "Etsy", "#f1641e", "Et", ["etsy.com"], "Handmade and digital shop", "Manage listings.", [[A, "Etsy Open API"], CHROME("etsy.com")]),
  site("ebay", "eBay", "#e53238", "eB", ["ebay.com"], "Marketplace", "Look up listings and orders; never buy without asking.", [CHROME("ebay.com")]),
  site("aliexpress", "AliExpress", "#e62e04", "Ae", ["aliexpress.com"], "Marketplace", "Look up orders; never buy without asking.", [CHROME("aliexpress.com")]),
  site("upwork", "Upwork", "#14a800", "Up", ["upwork.com"], "Freelance marketplace", "Draft proposals; read messages.", [CHROME("upwork.com")]),
  site("fiverr", "Fiverr", "#1dbf73", "Fi", ["fiverr.com"], "Freelance marketplace", "Draft gig copy; read orders.", [CHROME("fiverr.com")]),
  site("wix", "Wix", "#000000", "Wx", ["wix.com"], "Website builder", "Edit pages; read site stats.", [[A, "Wix REST API"], CHROME("wix.com")]),
  site("wordpress", "WordPress.com", "#21759b", "W", ["wordpress.com"], "Blogs and sites", "Draft posts through the REST API.", [[A, "WordPress REST API with an application password"]]),
  site("webflow", "Webflow", "#146ef5", "Wf", ["webflow.com"], "Website builder and CMS", "Write CMS items.", [[A, "Webflow Data API"], [M, "Webflow MCP server"]]),
  site("framer", "Framer", "#0055ff", "Fr", ["framer.com"], "Website builder", "Edit pages in the browser.", [CHROME("framer.com")]),
  site("squarespace", "Squarespace", "#000000", "Sq", ["squarespace.com"], "Website builder", "Edit pages in the browser.", [CHROME("squarespace.com")]),
  site("namecheap", "Namecheap", "#de3723", "Nc", ["namecheap.com"], "Domains and DNS", "Check domains and DNS; change records only when asked.", [[A, "Namecheap API (IP allow-list)"], CHROME("namecheap.com")]),
  site("porkbun", "Porkbun", "#ef7878", "Pb", ["porkbun.com"], "Domains and DNS", "Check domains and DNS; change records only when asked.", [[A, "Porkbun API"]]),
  site("godaddy", "GoDaddy", "#1bdbdb", "GD", ["godaddy.com"], "Domains and DNS", "Check domains and DNS; change records only when asked.", [[A, "GoDaddy API"], CHROME("godaddy.com")]),
  site("sentry", "Sentry", "#362d59", "Se", ["sentry.io"], "Error monitoring", "Read issues and stack traces.", [[L, "sentry-cli"], [A, "Sentry API"], [M, "Sentry MCP server"]], { browser: false }),
  site("posthog", "PostHog", "#f54e00", "PH", ["posthog.com"], "Product analytics", "Query funnels and events.", [[A, "PostHog API"], [M, "PostHog MCP server"]], { browser: false }),
  site("plausible", "Plausible", "#5850ec", "Pl", ["plausible.io"], "Privacy-friendly analytics", "Read traffic stats.", [[A, "Plausible Stats API"]]),
  site("pinecone", "Pinecone", "#000000", "Pc", ["pinecone.io"], "Vector database", "Upsert and query vectors.", [[A, "Pinecone API"]], { browser: false }),
  site("algolia", "Algolia", "#003dff", "Al", ["algolia.com"], "Search API", "Index and search.", [[A, "Algolia API"]], { browser: false }),
  site("mapbox", "Mapbox", "#000000", "Mb", ["mapbox.com"], "Maps and geocoding", "Maps, tiles and geocoding with a token.", [[A, "Mapbox APIs"]], { browser: false }),
  site("rapidapi", "RapidAPI", "#0055ff", "Ra", ["rapidapi.com"], "API marketplace", "Call subscribed APIs with one key.", [[A, "RapidAPI key"]], { browser: false }),
  site("modal", "Modal", "#7fee64", "Mo", ["modal.com"], "Serverless GPUs", "Run Python jobs on GPUs.", [[L, "modal CLI"], [A, "Modal SDK"]], { browser: false, bins: ["modal"], env: /^MODAL_/ }),
  site("browserbase", "Browserbase", "#ff4f00", "Bb", ["browserbase.com"], "Cloud browsers for agents", "Run Playwright sessions in the cloud.", [[A, "Browserbase API"], [M, "Browserbase MCP server"]], { browser: false, env: /^BROWSERBASE_/ }),
  site("exa", "Exa", "#1f40ed", "Ex", ["exa.ai"], "Search API for agents", "Semantic web search and contents.", [[A, "Exa API"], [M, "Exa MCP server"]], { browser: false, env: /^EXA_/ }),
  site("together", "Together AI", "#0f6fff", "To", ["together.ai", "together.xyz"], "Open models API", "OpenAI-compatible API.", [[A, "Together API"]], { browser: false, env: /^TOGETHER_/ }),
  site("kaggle", "Kaggle", "#20beff", "Kg", ["kaggle.com"], "Datasets and notebooks", "Download datasets.", [[L, "kaggle CLI"]], { bins: ["kaggle"] }),
  site("stackoverflow", "Stack Overflow", "#f48024", "SO", ["stackoverflow.com", "stackexchange.com"], "Q&A", "Search answers (no login needed).", [[A, "Stack Exchange API"]]),
  site("itch", "itch.io", "#fa5c5c", "it", ["itch.io"], "Publish indie and browser games", "Upload builds with butler.", [[L, "butler push <dir> user/game:html5"], CHROME("itch.io")], { bins: ["butler"] }),
  site("crazygames", "CrazyGames", "#6842ff", "CG", ["crazygames.com", "developer.crazygames.com"], "Browser game portal", "Submit web game builds.", [CHROME("developer.crazygames.com")]),
  site("newgrounds", "Newgrounds", "#fda238", "NG", ["newgrounds.com"], "Browser games and animation", "Upload games.", [CHROME("newgrounds.com")]),
  site("steam", "Steam", "#171a21", "St", ["steampowered.com", "steamcommunity.com"], "Games", "Read library and store pages.", [CHROME("store.steampowered.com")]),
  site("udemy", "Udemy", "#a435f0", "Ud", ["udemy.com"], "Courses", "Read your courses.", [CHROME("udemy.com")]),
  site("coursera", "Coursera", "#0056d2", "Co", ["coursera.org"], "Courses", "Read your courses.", [CHROME("coursera.org")]),
  site("airbnb", "Airbnb", "#ff5a5f", "Ab", ["airbnb.com"], "Stays", "Search stays; never book without asking.", [CHROME("airbnb.com")]),
  site("booking", "Booking.com", "#003580", "Bk", ["booking.com"], "Hotels", "Search hotels; never book without asking.", [CHROME("booking.com")]),
  site("wolt", "Wolt", "#009de0", "Wo", ["wolt.com"], "Food delivery", "Look up restaurants; never order without asking.", [CHROME("wolt.com")]),
  site("goodreads", "Goodreads", "#553b08", "Gr", ["goodreads.com"], "Books", "Read your shelves.", [[E, "Export library (CSV)"]]),
  site("letterboxd", "Letterboxd", "#00e054", "Lb", ["letterboxd.com"], "Films", "Read your diary.", [[R, "letterboxd.com/<user>/rss"]]),
  site("wikipedia", "Wikipedia", "#000000", "W", ["wikipedia.org", "wikimedia.org"], "Encyclopedia", "Read articles (no login needed).", [[A, "MediaWiki API"]]),
  site("archive", "Internet Archive", "#000000", "IA", ["archive.org"], "Wayback Machine and uploads", "Save and look up snapshots.", [[A, "Wayback and archive.org APIs"]]),
  site("codepen", "CodePen", "#000000", "CP", ["codepen.io"], "Front-end playground", "Share demos.", [CHROME("codepen.io")]),
  site("glitch", "Glitch", "#3333ff", "Gl", ["glitch.com"], "Small web apps", "Remix and host small apps.", [CHROME("glitch.com")]),
  site("expo", "Expo", "#000020", "Ex", ["expo.dev"], "React Native builds", "Build and submit apps with EAS.", [[L, "eas build / eas submit"]], { browser: false, bins: ["eas"] }),
];

export const SITES_CATALOG: Site[] = [...SOCIAL, ...MERGE, ...SITES];

// ── Sites that never get a card, not even a count ───────────────────────────
// Banks, payments and investing, health, government; dating and adult too. Dropped before anything leaves the reader.
const SENSITIVE_DOMAINS = new Set([
  "paypal.com", "paypal.me", "payoneer.com", "wise.com", "transferwise.com", "revolut.com", "monzo.com", "n26.com", "venmo.com", "cash.app", "zellepay.com", "klarna.com", "affirm.com", "afterpay.com",
  "chase.com", "wellsfargo.com", "citi.com", "capitalone.com", "americanexpress.com", "discover.com", "hsbc.com", "barclays.co.uk", "santander.com", "ing.com",
  "robinhood.com", "etoro.com", "plus500.com", "interactivebrokers.com", "schwab.com", "fidelity.com", "vanguard.com", "tradingview.com", "webull.com", "ibkr.com", "binance.com", "kraken.com", "bybit.com", "okx.com", "bitpanda.com", "metamask.io", "ledger.com", "trezor.io", "blockchain.com", "exodus.com", "turbotax.com", "intuit.com", "creditkarma.com", "mint.com", "ynab.com",
  // Israel: banks, cards, investment and insurance houses, payments
  "leumi.co.il", "bankhapoalim.co.il", "discountbank.co.il", "mizrahi-tefahot.co.il", "fibi.co.il", "bankjerusalem.co.il", "bank-yahav.co.il", "mercantile.co.il", "onezero.co.il", "pepper.co.il",
  "isracard.co.il", "cal-online.co.il", "max.co.il", "leumi-card.co.il", "americanexpress.co.il", "bit.co.il", "paybox.co.il", "meitav.co.il", "altshul.co.il", "psagot.co.il", "migdal.co.il", "harel-group.co.il", "clalbit.co.il", "menoramivt.co.il", "fnx.co.il", "ayalon-ins.co.il", "hachshara.co.il", "moreinvest.co.il", "excellence.co.il",
  // Israel: health funds and hospitals
  "clalit.co.il", "maccabi4u.co.il", "maccabi-dent.com", "meuhedet.co.il", "leumit.co.il", "sheba.co.il", "hadassah.org.il", "tasmc.org.il", "assuta.co.il", "superpharm.co.il", "be.co.il",
  // health elsewhere
  "zocdoc.com", "teladoc.com", "mychart.com", "epic.com", "labcorp.com", "questdiagnostics.com", "23andme.com", "ancestry.com", "cvs.com", "walgreens.com", "goodrx.com", "betterhelp.com", "talkspace.com", "headspace.com", "calm.com", "myfitnesspal.com", "flo.health",
  // dating and adult
  "tinder.com", "bumble.com", "okcupid.com", "hinge.co", "match.com", "grindr.com", "badoo.com", "plentyoffish.com", "pof.com", "feeld.co", "onlyfans.com", "fansly.com", "pornhub.com", "xvideos.com", "xhamster.com", "chaturbate.com",
]);
const SENSITIVE_WORDS = /bank|banc|credit|loan|mortgage|insur|invest|broker|trading|crypto|coin|wallet|finan|pension|forex|health|clinic|hospital|medic|pharm|doctor|dental|dentist|therap|patient|porn|xxx|dating|escort/;
const GOV_LABELS = new Set(["gov", "mil", "gouv", "gob", "govt", "gv", "nhs", "gc"]);

/** Hosting platforms where each subdomain is a separate site (a slice of the public suffix list). */
const PLATFORM = ["github.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "herokuapp.com", "web.app", "firebaseapp.com", "blogspot.com", "myshopify.com", "notion.site", "glitch.me", "fly.dev", "onrender.com", "up.railway.app", "azurewebsites.net", "cloudfront.net", "ngrok.io", "ngrok-free.app", "replit.app", "lovable.app", "surge.sh", "wixsite.com"];
const SECOND = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne", "go", "muni", "k12", "ltd", "plc", "me", "idf"]);

/** The host a login is for, lowercased, from an origin URL or signon realm. Android realms map through the catalog. Undefined for local or non-web entries. */
export function hostOf(originUrl: string | null | undefined, realm: string | null | undefined): string | undefined {
  for (const raw of [originUrl, realm]) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    const android = v.match(/^android:\/\/[^@]*@([\w.]+)\/?/i);
    if (android) { const hit = SITES_CATALOG.find((x) => x.android?.includes(android[1])); if (hit) return hit.domains[0]; continue; }
    let h = "";
    try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) continue; h = u.hostname; } catch { continue; }
    h = h.toLowerCase().replace(/\.$/, "").replace(/^www\d?\./, "");
    if (!h || !h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || /(^|\.)(localhost|local|internal|lan|home|test|invalid|example|ts\.net|localdomain)$/.test(h)) continue;
    return h;
  }
}
/** The registrable domain ("eTLD+1") of a host: news.ycombinator.com → ycombinator.com, shop.co.il → shop.co.il, me.netlify.app → me.netlify.app. */
export function registrable(host: string): string {
  const h = host.toLowerCase();
  const plat = PLATFORM.find((p) => h === p || h.endsWith(`.${p}`));
  if (plat) { const rest = h.slice(0, h.length - plat.length - 1).split(".").filter(Boolean); return rest.length ? `${rest[rest.length - 1]}.${plat}` : plat; }
  const l = h.split(".");
  if (l.length <= 2) return h;
  const n = l[l.length - 2].length <= 3 && SECOND.has(l[l.length - 2]) && l[l.length - 1].length === 2 ? 3 : 2;
  return l.slice(-n).join(".");
}
/** Banks, finance, health, government, dating and adult sites: never shown, never counted. */
export function sensitive(host: string): boolean {
  const h = host.toLowerCase();
  const d = registrable(h);
  if (SENSITIVE_DOMAINS.has(d) || SENSITIVE_DOMAINS.has(h)) return true;
  const labels = h.split(".");
  if (labels.some((x) => GOV_LABELS.has(x))) return true;
  if (labels.length >= 3 && labels[labels.length - 2] === "go" && labels[labels.length - 1].length === 2) return true; // go.jp, go.kr…
  const name = d.split(".")[0];
  return SENSITIVE_WORDS.test(name);
}
/** The catalog entry for a host: the longest matching domain wins (aws.amazon.com beats amazon.com). */
export function siteFor(host: string): Site | undefined {
  let best: Site | undefined, len = 0;
  for (const x of SITES_CATALOG) for (const d of x.domains) if ((host === d || host.endsWith(`.${d}`)) && d.length > len) { best = x; len = d.length; }
  return best;
}
/** The card id a catalog entry uses. */
export const cardId = (x: Site) => x.svc ?? `acct:${x.id}`;

// ── Recommended: services worth signing up for ──────────────────────────────
/** Interests read from the wiki: key → how to spot it, and the project name a reason cites. */
export const INTERESTS: Record<string, { re: RegExp; label: string }> = {
  hd: { re: /human design|bodygraph|hd-chat|hd chat|hd-atlas|astra/g, label: "Human Design apps (HD Chat, bodygraph-3d)" },
  funnel: { re: /2027|prophecy|gumroad|funnel/g, label: "2027 Prophecy funnel" },
  video: { re: /hyperframes|story-reel|shorts|higgsfield|kling|video|film/g, label: "AI video (story-reel, HyperFrames)" },
  ytrag: { re: /yt-transcriber|youtube|transcri/g, label: "YouTube RAG (yt-transcriber)" },
  osint: { re: /osint|scrap|worldscope|evidence/g, label: "OSINT (llm-osint, worldscope)" },
  games: { re: /phaser|game|godot|falafel|viktor/g, label: "Browser games (Falafel Rush, Viktor games)" },
  agents: { re: /agent|orchestration|stasclaw|herdr|hermes|mcp/g, label: "Agent orchestration (StasClaw, herdr deck)" },
  maps: { re: /\bmap|geo|city|globe|postgis|cartograph/g, label: "Maps (makom-ai, worldscope, God's Eye View)" },
  telegram: { re: /telegram|russian/g, label: "Russian and Telegram audience" },
  leads: { re: /lead|outbound|tender|business-automation|bizgen/g, label: "Lead gen (bizgen, gov-tender-sniper)" },
  blog: { re: /blog|astro|seo|newsletter|content/g, label: "Blogs and SEO (hd2027-blog, stasmaksin)" },
  oss: { re: /open-source|herdr-deck|github|public install/g, label: "Open-source tools (herdr deck)" },
  rag: { re: /\brag\b|chroma|pgvector|embedding|corpus/g, label: "RAG corpora (hd-atlas, esoteric-rag)" },
};

export type Rec = {
  id: string; name: string; cat: string; color: string; glyph?: string;
  url: string; // official sign-up / home page
  free: string; // well-known facts only; "Check pricing" when unsure
  what: string;
  base: number; // fit before your interests
  fit: Record<string, string>; // interest key → why, in terms of that project
  why: string; // fallback reason
  /** You already have it when any of these cards is set up, or a login matches these domains. */
  owns: string[]; domains?: string[];
};
const FREE = "Free tier", CHECK = "Check pricing";
const r = (id: string, name: string, cat: string, color: string, url: string, free: string, what: string, base: number, why: string, fit: Record<string, string>, owns: string[] = [], domains: string[] = [], glyph?: string): Rec =>
  ({ id, name, cat, color, url, free, what, base, why, fit, owns: owns.length ? owns : [`acct:${id}`], domains, glyph });

export const RECS: Rec[] = [
  r("resend", "Resend", "comms", "#000000", "https://resend.com", `${FREE} (3,000 emails a month)`, "Transactional email API with your own domain", 5, "Send email from your apps with a real domain and good deliverability.",
    { funnel: "email 2027 Prophecy buyers their reading and follow-ups from your own domain", hd: "send HD Chat sign-in links and saved readings" }, ["svc:resend"], ["resend.com"]),
  r("upstash", "Upstash", "data", "#00e9a3", "https://upstash.com", FREE, "Serverless Redis, queues (QStash) and vector", 3, "Rate limits, caches and scheduled jobs without running a server.",
    { agents: "queues and cron for StasClaw and scheduled agent jobs", hd: "rate limits and caching for HD Chat" }, ["svc:upstash"], ["upstash.com"]),
  r("neon", "Neon", "data", "#00e599", "https://neon.tech", FREE, "Serverless Postgres with instant branches", 3, "Hosted Postgres you can branch for every migration.",
    { rag: "host a pgvector copy of hd_kb that phones and deploys can reach", hd: "branch the Astra database before risky migrations" }, ["svc:neon", "svc:supabase"], ["neon.tech", "neon.com"]),
  r("modal", "Modal", "ai", "#7fee64", "https://modal.com", "Free monthly credits", "Serverless GPUs for Python", 4, "Run GPU jobs without owning a GPU.",
    { ytrag: "run Whisper transcription for yt-transcriber on cloud GPUs instead of the Mac", video: "run open video and image models for story-reel shots" }, ["acct:modal"], ["modal.com"]),
  r("replicate", "Replicate", "ai", "#000000", "https://replicate.com", `${CHECK} (pay per run)`, "Hosted open models behind one API", 3, "Call thousands of open models from a script.",
    { video: "generate b-roll, upscales and lip-sync for shorts from one API", hd: "illustrate HD reports with image models" }, ["svc:replicate"], ["replicate.com"]),
  r("fal", "fal", "media", "#7c3aed", "https://fal.ai", `${CHECK} (pay per use)`, "Fast image and video generation APIs (Kling, Veo, Flux…)", 4, "One API for the newest image and video models.",
    { video: "script story-reel shots through Kling and Veo models with a hard budget", games: "generate sprites and backgrounds for the browser games" }, ["svc:fal"], ["fal.ai"]),
  r("elevenlabs", "ElevenLabs", "media", "#000000", "https://elevenlabs.io", FREE, "Voices, speech and sound effects", 4, "Voiceovers and sound effects from text.",
    { video: "voice the daily transit shorts and explainers", games: "sound effects and character voices for the games", telegram: "Russian and Hebrew voiceovers for 2027 content" }, ["svc:elevenlabs"], ["elevenlabs.io"]),
  r("deepgram", "Deepgram", "ai", "#13ef93", "https://deepgram.com", "Free credit on sign-up", "Fast speech-to-text", 2, "Transcribe audio quickly and cheaply.",
    { ytrag: "a fast fallback transcriber for yt-transcriber ingests", agents: "voice notes into the wiki and agent voice input" }, ["svc:deepgram", "svc:soniox"], ["deepgram.com"]),
  r("posthog", "PostHog", "code", "#f54e00", "https://posthog.com", FREE, "Product analytics, funnels, session replay, feature flags", 5, "See where users drop off.",
    { funnel: "measure the 2027prophecy.com funnel from landing to Gumroad checkout", hd: "see which HD Chat features people actually use" }, ["acct:posthog"], ["posthog.com"]),
  r("plausible", "Plausible", "code", "#5850ec", "https://plausible.io", "No free tier (30-day trial; free if self-hosted)", "Privacy-friendly web analytics", 2, "Simple, cookie-free traffic stats.",
    { blog: "cookie-free traffic stats for hd2027-blog and stasmaksin" }, ["acct:plausible"], ["plausible.io"]),
  r("sentry", "Sentry", "code", "#362d59", "https://sentry.io", `${FREE} (developer plan)`, "Error and performance monitoring", 4, "Know about production errors before users tell you.",
    { hd: "catch HD Chat and Astra production errors with stack traces agents can read", agents: "error alerts from StasClaw and the deck" }, ["acct:sentry"], ["sentry.io"]),
  r("stripe", "Stripe", "commerce", "#635bff", "https://stripe.com", "No monthly fee (per-transaction)", "Payments, subscriptions, checkout", 3, "Subscriptions and one-off payments on your own checkout.",
    { funnel: "subscriptions and upsells beyond Gumroad for 2027 Prophecy", hd: "paid HD Chat plans" }, ["svc:stripe"], ["stripe.com"]),
  r("lemon-squeezy", "Lemon Squeezy", "commerce", "#ffc233", "https://www.lemonsqueezy.com", "No monthly fee (per-transaction)", "Merchant of record for digital products", 2, "Sell digital products with tax handled for you.",
    { funnel: "a merchant-of-record alternative to Gumroad for 2027 reports" }, ["svc:lemon-squeezy"], ["lemonsqueezy.com"]),
  r("beehiiv", "beehiiv", "social", "#fbbf24", "https://www.beehiiv.com", FREE, "Newsletter platform with growth tools", 3, "A newsletter with referrals and a web archive.",
    { funnel: "a 2027 Prophecy newsletter that nurtures free readers into buyers", blog: "turn hd2027-blog posts into a weekly issue" }, ["acct:beehiiv", "acct:substack", "acct:buttondown", "acct:kit"], ["beehiiv.com"]),
  r("buttondown", "Buttondown", "social", "#0069ff", "https://buttondown.com", `${FREE} (up to 100 subscribers)`, "Markdown-first newsletter with an API", 2, "A newsletter you can write from markdown and an API.",
    { blog: "send wiki and blog updates as a markdown newsletter an agent can draft", oss: "release notes for herdr deck" }, ["acct:buttondown", "acct:beehiiv", "acct:substack"], ["buttondown.email", "buttondown.com"]),
  r("buffer", "Buffer", "social", "#231f20", "https://buffer.com", FREE, "Schedule posts across social networks", 4, "Queue posts for several networks in one place.",
    { video: "schedule each short to YouTube, TikTok and Instagram from one queue", funnel: "a steady posting rhythm for 2027 content" }, ["acct:buffer", "acct:hootsuite"], ["buffer.com"]),
  r("typefully", "Typefully", "social", "#000000", "https://typefully.com", FREE, "Write and schedule X, Threads and LinkedIn posts", 3, "Draft threads with an API agents can write to.",
    { agents: "agents save thread drafts for you to approve", oss: "launch threads for herdr deck" }, ["acct:typefully"], ["typefully.com"]),
  r("apify", "Apify", "research", "#97d700", "https://apify.com", "Free plan (monthly credits)", "Ready-made scrapers (actors) for social sites and the web", 4, "Scrape public pages without building a scraper.",
    { osint: "public-social collectors for llm-osint self-audits", leads: "lead lists for bizgen", funnel: "watch competitors' 2027 content" }, ["svc:apify"], ["apify.com"]),
  r("browserbase", "Browserbase", "browsers", "#ff4f00", "https://www.browserbase.com", CHECK, "Cloud browsers for agents", 2, "Headless browsers in the cloud with sessions and recordings.",
    { agents: "run browser agents without tying up your Chrome", osint: "isolated sessions for public-web collection" }, ["acct:browserbase"], ["browserbase.com"]),
  r("firecrawl", "Firecrawl", "research", "#ff6b00", "https://www.firecrawl.dev", CHECK, "Crawl sites into clean markdown", 3, "Turn whole sites into LLM-ready markdown.",
    { rag: "pull HD sites and docs into your RAG corpora", osint: "evidence capture for worldscope" }, ["svc:firecrawl", "svc:crawl4ai"], ["firecrawl.dev"]),
  r("exa", "Exa", "research", "#1f40ed", "https://exa.ai", CHECK, "Semantic search API for agents", 3, "Search the web by meaning, with page contents.",
    { osint: "find sources by meaning for llm-osint", agents: "a search tool for StasClaw and research agents" }, ["acct:exa", "svc:tavily", "svc:brave-search"], ["exa.ai"]),
  r("perplexity", "Perplexity API", "research", "#20808d", "https://www.perplexity.ai", "No free API tier (pay as you go)", "Answers with citations over an API", 2, "Cited answers for research steps.",
    { agents: "cited research answers inside agent workflows" }, ["svc:perplexity"], ["perplexity.ai"]),
  r("supabase", "Supabase", "data", "#3ecf8e", "https://supabase.com", FREE, "Postgres, auth, storage and edge functions", 3, "A backend with auth and storage in minutes.",
    { hd: "auth and saved charts for HD apps", games: "leaderboards for the browser games" }, ["svc:supabase"], ["supabase.com"]),
  r("railway", "Railway", "cloud", "#0b0d0e", "https://railway.com", "Trial credit, then paid", "Deploy services and databases from a repo", 2, "Push a repo and get a running service.",
    { agents: "host small agent services and bots", hd: "host the HD API next to its database" }, ["svc:railway", "svc:fly-io", "svc:render"], ["railway.app", "railway.com"]),
  r("fly", "Fly.io", "cloud", "#7b3fe4", "https://fly.io", CHECK, "Run app servers close to users", 1, "Long-running servers and websockets near users.",
    { agents: "always-on bots and websocket services" }, ["svc:fly-io", "svc:railway", "svc:render"], ["fly.io"]),
  r("cloudflare", "Cloudflare", "cloud", "#f38020", "https://www.cloudflare.com", `${FREE} (Workers, Pages, R2)`, "Workers, Pages, R2 storage, Workers AI", 4, "Edge hosting, storage and models with a generous free tier.",
    { video: "R2 storage for renders with no egress fees", games: "host the browser games on Pages", hd: "edge caching for HD Chat" }, ["svc:cloudflare"], ["cloudflare.com"]),
  r("pinecone", "Pinecone", "data", "#000000", "https://www.pinecone.io", `${FREE} (starter)`, "Managed vector database", 1, "Vector search without running a database.",
    { rag: "host HD and YouTube corpora for phone and web apps" }, ["acct:pinecone", "svc:postgres"], ["pinecone.io"]),
  r("turbopuffer", "turbopuffer", "data", "#111111", "https://turbopuffer.com", CHECK, "Cheap vector and full-text search on object storage", 1, "Large vector indexes at low cost.",
    { rag: "a cheap home for large transcript corpora" }, ["acct:turbopuffer", "acct:pinecone"], ["turbopuffer.com"]),
  r("linear", "Linear", "code", "#5e6ad2", "https://linear.app", FREE, "Issue tracking agents can use", 2, "Issues with a great API and an MCP server.",
    { agents: "one issue board agents file into and pick up from" }, ["svc:linear"], ["linear.app"]),
  r("cal-com", "Cal.com", "comms", "#111827", "https://cal.com", `${FREE} (individuals)`, "Booking pages with an API", 3, "Let people book time with you.",
    { hd: "book paid HD readings and pair sessions", funnel: "a reading call upsell after the 2027 report" }, ["acct:cal-com", "acct:calendly"], ["cal.com"]),
  r("n8n-cloud", "n8n Cloud", "automation", "#ea4b71", "https://n8n.io", "Paid (trial); self-hosting is free", "Hosted n8n workflows", 1, "Hosted workflow automation.",
    { leads: "run lead-gen workflows without keeping a machine on" }, ["svc:n8n"], ["n8n.io", "n8n.cloud"]),
  r("zapier", "Zapier", "automation", "#ff4f00", "https://zapier.com", FREE, "Connect thousands of apps; Zapier MCP for agents", 2, "Glue between apps, now callable by agents.",
    { funnel: "Gumroad sale → email, sheet and Telegram without code", agents: "give agents actions in apps that have no API key yet" }, ["acct:zapier", "acct:make", "svc:n8n"], ["zapier.com"]),
  r("make", "Make", "automation", "#6d00cc", "https://www.make.com", FREE, "Visual automation scenarios", 1, "Visual automations with webhooks.",
    { funnel: "no-code funnel automations" }, ["acct:make", "acct:zapier", "svc:n8n"], ["make.com"]),
  r("twilio", "Twilio", "comms", "#f22f46", "https://www.twilio.com", "Trial credit, then pay as you go", "SMS, WhatsApp and voice APIs", 1, "Programmable SMS and WhatsApp.",
    { agents: "SMS and WhatsApp alerts from agents" }, ["svc:twilio"], ["twilio.com"]),
  r("telegram-bot", "Telegram bot", "social", "#26a5e4", "https://core.telegram.org/bots/tutorial", "Free", "Your own bot for alerts and a channel", 4, "A free way for agents to reach your phone.",
    { telegram: "a Russian-language 2027 channel and bot", agents: "agent standups and alerts on your phone" }, ["svc:telegram"], [], "TG"),
  r("discord-bot", "Discord bot", "social", "#5865f2", "https://discord.com/developers/applications", "Free", "A bot for your own server", 1, "Community and alerts on Discord.",
    { games: "a community server for the games with build announcements" }, ["svc:discord"], [], "DC"),
  r("lovable", "Lovable", "code", "#ff4f7b", "https://lovable.dev", FREE, "Prompt-to-app builder", 1, "Quick app prototypes you can sync to GitHub.",
    { hd: "fast landing-page experiments for HD products" }, ["acct:lovable"], ["lovable.dev"]),
  r("v0", "v0", "code", "#000000", "https://v0.dev", FREE, "Prompt-to-UI by Vercel", 1, "UI components from a prompt, straight into your repo.",
    { funnel: "landing page variants for 2027prophecy.com" }, ["acct:v0"], ["v0.dev", "v0.app"]),
  r("runway", "Runway", "media", "#000000", "https://runwayml.com", CHECK, "AI video generation and editing", 2, "Generate and edit video shots.",
    { video: "hero shots for story-reel and films" }, ["svc:runway"], ["runwayml.com"]),
  r("kling", "Kling AI", "media", "#0c0c0c", "https://klingai.com", CHECK, "AI video generation", 2, "Strong motion for generated shots.",
    { video: "motion shots for shorts and films" }, ["acct:kling", "svc:higgsfield"], ["klingai.com"]),
  r("luma", "Luma", "media", "#111111", "https://lumalabs.ai", CHECK, "Dream Machine video, with an API", 1, "Generated video with an API.",
    { video: "API-driven shots for story-reel" }, ["acct:luma"], ["lumalabs.ai"]),
  r("suno", "Suno", "media", "#000000", "https://suno.com", "Free tier (daily credits, non-commercial)", "AI music and songs", 2, "Music beds and songs from a prompt.",
    { video: "music beds for shorts", games: "game soundtracks" }, ["acct:suno", "acct:udio"], ["suno.com", "suno.ai"]),
  r("udio", "Udio", "media", "#e30b5c", "https://www.udio.com", CHECK, "AI music", 1, "Music from a prompt.", { video: "music beds for shorts" }, ["acct:udio", "acct:suno"], ["udio.com"]),
  r("midjourney", "Midjourney", "media", "#000000", "https://www.midjourney.com", "No free tier", "Image generation", 1, "Striking images and styles.",
    { hd: "art direction for HD reports and covers" }, ["acct:midjourney"], ["midjourney.com"]),
  r("heygen", "HeyGen", "media", "#7559ff", "https://www.heygen.com", CHECK, "Avatar and translated video", 1, "Talking-head video and dubbing.",
    { telegram: "dub 2027 videos into Russian and Hebrew" }, ["svc:heygen"], ["heygen.com"]),
  r("algolia", "Algolia", "code", "#003dff", "https://www.algolia.com", FREE, "Hosted search", 1, "Instant search for sites.", { blog: "search across hd2027-blog" }, ["acct:algolia"], ["algolia.com"]),
  r("mapbox", "Mapbox", "code", "#000000", "https://www.mapbox.com", FREE, "Maps, tiles and geocoding", 2, "Beautiful maps with a free tier.",
    { maps: "vector maps and geocoding for makom-ai and worldscope" }, ["acct:mapbox", "svc:google-maps-platform"], ["mapbox.com"]),
  r("overpass", "OpenStreetMap / Overpass", "research", "#7ebc6f", "https://overpass-api.de", "Free, no sign-up (fair use)", "Query OpenStreetMap data", 2, "Open map data: shops, roads, places.",
    { maps: "places and amenities for makom-ai and local-signal" }, ["acct:overpass", "acct:openstreetmap"], ["openstreetmap.org"], "OSM"),
  r("rapidapi", "RapidAPI", "code", "#0055ff", "https://rapidapi.com", "Free to join (each API has its own plans)", "API marketplace", 1, "Thousands of APIs behind one key.",
    { osint: "quick access to niche data APIs" }, ["acct:rapidapi"], ["rapidapi.com"]),
  r("github-sponsors", "GitHub Sponsors", "commerce", "#db61a2", "https://github.com/sponsors", "Free (no fee on personal accounts)", "Get paid for open source", 2, "Let people fund your open-source work.",
    { oss: "let herdr deck users sponsor it" }, ["acct:github-sponsors"], [], "GS"),
  r("product-hunt", "Product Hunt", "social", "#da552f", "https://www.producthunt.com", "Free", "Launch products to early adopters", 2, "A launch day for a finished product.",
    { oss: "launch herdr deck", hd: "launch bodygraph-3d" }, ["acct:product-hunt"], ["producthunt.com"]),
  r("indie-hackers", "Indie Hackers", "social", "#0e2439", "https://www.indiehackers.com", "Free", "Founder community", 1, "Share revenue milestones and learn from founders.",
    { funnel: "share the 2027 funnel's numbers and lessons" }, ["acct:indie-hackers"], ["indiehackers.com"]),
  r("tiktok", "TikTok creator account", "social", "#010101", "https://www.tiktok.com/signup", "Free", "Short vertical video", 4, "Where short video reaches new people.",
    { funnel: "the 2027 strategy's TikTok channel", video: "publish the HD shorts you already render" }, ["acct:tiktok"], ["tiktok.com"], "TT"),
  r("youtube", "YouTube channel", "social", "#ff0000", "https://www.youtube.com/create_channel", "Free", "Your channel and Shorts", 3, "Long-lived, searchable video.",
    { video: "a home for explainers and Shorts", hd: "HD explainers that rank in search" }, ["svc:youtube-data-api"], ["youtube.com"], "YT"),
  r("instagram", "Instagram", "social", "#e1306c", "https://www.instagram.com/accounts/emailsignup/", "Free", "Reels and stories", 2, "Reels reach a different crowd than TikTok.",
    { video: "cross-post Reels from your shorts", funnel: "2027 reels with a link in bio" }, ["acct:instagram"], ["instagram.com"], "IG"),
  r("bluesky", "Bluesky", "social", "#0085ff", "https://bsky.app", "Free", "Open social network with an easy API", 2, "The easiest network to automate honestly.",
    { agents: "agent-drafted posts through app passwords", oss: "reach developers for herdr deck" }, ["acct:bluesky"], ["bsky.app"], "B"),
  r("itch", "itch.io", "media", "#fa5c5c", "https://itch.io", "Free (you choose the revenue share)", "Publish browser and indie games", 3, "A home for playable web builds.",
    { games: "publish Falafel Rush and the Viktor games as playable pages" }, ["acct:itch"], ["itch.io"], "it"),
  r("crazygames", "CrazyGames (developers)", "media", "#6842ff", "https://developer.crazygames.com", "Free", "Browser game portal with ad revenue share", 2, "Players for web games without marketing.",
    { games: "put the Phaser games in front of players" }, ["acct:crazygames"], ["crazygames.com"], "CG"),
  r("groq", "Groq", "ai", "#f55036", "https://console.groq.com", "Free tier (rate-limited)", "Very fast open-model inference", 2, "Near-instant responses for open models.",
    { agents: "fast cheap model calls for routing and classification", hd: "instant replies for simple HD Chat turns" }, ["svc:groq"], ["groq.com"]),
  r("tavily", "Tavily", "research", "#2563eb", "https://tavily.com", CHECK, "Search API built for agents", 1, "Search results shaped for LLMs.",
    { agents: "a search tool for research agents" }, ["svc:tavily", "acct:exa", "svc:brave-search"], ["tavily.com"]),
];
