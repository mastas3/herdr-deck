// What this machine can reach: CLIs and whether they're signed in, MCP servers each agent has, AI
// subscriptions, API keys (names and where they're set, never values), browser profiles, skills.
// It's the map agents need to take on big projects, and what "suggest projects" reasons over.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";

const HOME = homedir();
const MAC = platform() === "darwin";
/** The login-shell PATH plus the places tools hide: every nvm Node, bun, deno, cargo, go, pnpm, Docker.app. */
function buildPath() {
  const nvm = (() => { try { return readdirSync(`${HOME}/.nvm/versions/node`).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => `${HOME}/.nvm/versions/node/${v}/bin`); } catch { return []; } })();
  const dirs = [`${HOME}/.bun/bin`, `${HOME}/.local/bin`, `${HOME}/.opencode/bin`, `${HOME}/.deno/bin`, `${HOME}/.cargo/bin`, `${HOME}/go/bin`, `${HOME}/.npm-global/bin`, `${HOME}/Library/pnpm`, `${HOME}/.local/share/pnpm`,
    ...nvm, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/snap/bin", "/Applications/Docker.app/Contents/Resources/bin", ...(process.env.PATH ?? "").split(":")];
  return [...new Set(dirs.filter(Boolean))].join(":");
}
const PATH = buildPath();

export type Item = {
  id: string; name: string; kind: string; group?: string;
  status?: "ready" | "partial" | "off";
  detail?: string; // what it's for
  note?: string; // state: version, signed in…
  via?: string[]; // how it's reached: CLI, npx, MCP, key names
  use?: string; // how an agent should use it
  custom?: boolean; hidden?: boolean;
};
export type Section = { id: string; title: string; hint: string; items: Item[] };
export type Inventory = { machine: string; at: number; ms: number; sections: Section[]; file?: string };

const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const has = (rel: string) => existsSync(rel.startsWith("/") ? rel : `${HOME}/${rel}`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function which(bin: string): string | undefined {
  for (const dir of PATH.split(":")) if (dir && existsSync(`${dir}/${bin}`)) return `${dir}/${bin}`;
}
async function version(path: string, arg = "--version"): Promise<string | undefined> {
  try {
    const p = Bun.spawn([path, arg], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH, NO_COLOR: "1" } });
    const t = setTimeout(() => p.kill(9), 2500);
    const out = (await new Response(p.stdout).text()) || (await new Response(p.stderr).text());
    clearTimeout(t);
    return out.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/)?.[1]?.slice(0, 30);
  } catch {}
}

/** CLIs you run with npx: what's in npm's npx cache, newest version per package. */
function npxCache(): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of ls(`${HOME}/.npm/_npx`)) {
    const nm = `${HOME}/.npm/_npx/${d}/node_modules`;
    for (const n of ls(nm)) {
      const pkgs = n.startsWith("@") ? ls(`${nm}/${n}`).map((x) => `${n}/${x}`) : [n];
      for (const pkg of pkgs) {
        const v = readJson(`${nm}/${pkg}/package.json`)?.version;
        if (v && (!out.has(pkg) || String(v).localeCompare(out.get(pkg)!, undefined, { numeric: true }) > 0)) out.set(pkg, v);
      }
    }
  }
  return out;
}

/** Environment variable NAMES set in shell startup files, and ~/.config/<x>/api-key style files. Never values. */
function keyNames(): { name: string; where: string }[] {
  const out = new Map<string, string>();
  for (const f of [".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish", ".env"]) {
    for (const line of readText(`${HOME}/${f}`).split("\n")) {
      const m = line.match(/^\s*(?:export\s+|set\s+-gx\s+)?([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|TOKEN|SECRET|_PAT|_ID))\b\s*=?/);
      if (m && !out.has(m[1]) && !/^(PATH|HOME|NVM|PYENV)/.test(m[1])) out.set(m[1], `~/${f}`);
    }
  }
  for (const d of ls(`${HOME}/.config`)) for (const f of ls(`${HOME}/.config/${d}`)) {
    if (/^(api[-_]?key|token|credentials?)(\.txt|\.json)?$/i.test(f)) out.set(`${d.toUpperCase().replace(/\W/g, "_")} (file)`, `~/.config/${d}/${f}`);
  }
  return [...out].map(([name, where]) => ({ name, where }));
}

// ── services: one card per thing you can use, however it's reached ─────────
type Svc = {
  name: string; what: string; use: string;
  bins?: string[]; npx?: string[]; login?: string[]; loginJson?: [string, (j: any) => boolean];
  env?: RegExp; mcp?: RegExp; app?: string; group: string;
};
const L = platform() === "linux";
const SERVICES: Svc[] = [
  { name: "GitHub", group: "Code & deploy", what: "Repos, PRs, issues, Actions", bins: ["gh"], login: [".config/gh/hosts.yml"], env: /^(GH|GITHUB)_/, mcp: /github/i, use: "Use `gh`: `gh pr create`, `gh pr view --comments`, `gh run watch`, `gh issue list`. Prefer it over the web UI." },
  { name: "Vercel", group: "Code & deploy", what: "Deploys, domains, env vars", bins: ["vercel"], npx: ["vercel"], login: [MAC ? "Library/Application Support/com.vercel.cli/auth.json" : ".local/share/com.vercel.cli/auth.json"], env: /^VERCEL_/, mcp: /vercel/i, use: "`vercel` for preview deploys, `vercel --prod` for production, `vercel env pull` for env vars, `vercel logs <url>` to debug." },
  { name: "Netlify", group: "Code & deploy", what: "Deploys, forms, functions", bins: ["netlify", "ntl"], npx: ["netlify-cli"], loginJson: [MAC ? "Library/Preferences/netlify/config.json" : ".config/netlify/config.json", (j) => Object.keys(j?.users ?? {}).length > 0], env: /^NETLIFY_/, mcp: /netlify/i, use: "`npx netlify-cli deploy` (add `--prod` for production); `npx netlify-cli status` shows the account and linked site." },
  { name: "Cloudflare", group: "Code & deploy", what: "Workers, Pages, DNS, R2, D1, tunnels", bins: ["wrangler", "cloudflared"], npx: ["wrangler"], login: [MAC ? "Library/Preferences/.wrangler/config/default.toml" : ".config/.wrangler/config/default.toml", ".wrangler/config/default.toml", ".cloudflared/cert.pem"], env: /^(CLOUDFLARE|CF)_/, mcp: /cloudflare/i, use: "`npx wrangler deploy` for Workers/Pages, `npx wrangler d1|r2|kv` for storage (`npx wrangler login` if it asks). `cloudflared tunnel --url http://localhost:<port>` exposes a local port publicly — only when asked." },
  { name: "Supabase", group: "Data", what: "Postgres, auth, storage, edge functions", bins: ["supabase"], npx: ["supabase"], login: [".supabase/access-token"], env: /^SUPABASE_/, mcp: /supabase/i, use: "`npx supabase` for migrations (`db push`, `migration new`) and `gen types`. Never print keys." },
  { name: "Firebase", group: "Code & deploy", what: "Hosting, auth, Firestore", bins: ["firebase"], npx: ["firebase-tools"], loginJson: [".config/configstore/firebase-tools.json", (j) => !!(j?.tokens || j?.user)], env: /^FIREBASE_/, use: "`firebase deploy --only hosting`, `firebase emulators:start` for local testing." },
  { name: "Fly.io", group: "Code & deploy", what: "App hosting", bins: ["flyctl", "fly"], login: [".fly/config.yml"], env: /^FLY_/, use: "`fly deploy`, `fly logs`, `fly secrets set`." },
  { name: "Railway", group: "Code & deploy", what: "App hosting", bins: ["railway"], npx: ["@railway/cli"], login: [".railway/config.json"], env: /^RAILWAY_/, use: "`railway up` to deploy, `railway logs`." },
  { name: "Heroku", group: "Code & deploy", what: "App hosting", bins: ["heroku"], env: /^HEROKU_/, use: "`heroku` CLI: `git push heroku main`, `heroku logs --tail`." },
  { name: "Stripe", group: "Payments", what: "Payments, webhooks", bins: ["stripe"], login: [".config/stripe/config.toml"], env: /^STRIPE_/, mcp: /stripe/i, use: "`stripe listen --forward-to localhost:<port>/webhook` to test webhooks; use test-mode keys only." },
  { name: "Gumroad", group: "Payments", what: "Products, sales, offer codes", env: /^GUMROAD_/, mcp: /gumroad/i, use: "Use the gumroad MCP tools for products, sales and offer codes." },
  { name: "AWS", group: "Cloud", what: "Cloud", bins: ["aws"], login: [".aws/credentials", ".aws/config"], env: /^AWS_/, mcp: /aws/i, use: "`aws` CLI with the default profile; say which profile/region before changing anything." },
  { name: "Google Cloud", group: "Cloud", what: "Cloud, Vertex AI, GKE", bins: ["gcloud"], login: [".config/gcloud/credentials.db", ".config/gcloud/active_config"], env: /^(GCP|GOOGLE_CLOUD|GCLOUD)_/, use: "`gcloud` CLI; check `gcloud config list` for the active project first." },
  { name: "Azure", group: "Cloud", what: "Cloud", bins: ["az"], loginJson: [".azure/azureProfile.json", (j) => (j?.subscriptions ?? []).length > 0], env: /^AZURE_/, use: "`az` CLI; `az account show` for the active subscription." },
  { name: "Docker", group: "Cloud", what: "Containers", bins: ["docker"], app: "Docker.app", login: [".docker/config.json"], use: "`docker compose up -d` for local services; Docker Desktop must be running." },
  { name: "Kubernetes", group: "Cloud", what: "Clusters", bins: ["kubectl"], login: [".kube/config"], use: "`kubectl` with the current context (`kubectl config current-context`); read-only unless asked." },
  { name: "Tailscale", group: "Network", what: "Private network; share dev servers to your phone", bins: ["tailscale"], app: "Tailscale.app", use: "`tailscale serve --bg --https=<port> http://localhost:<port>` shares a dev server on the tailnet. Never `tailscale funnel`." },
  { name: "ngrok", group: "Network", what: "Public tunnels", bins: ["ngrok"], login: [MAC ? "Library/Application Support/ngrok/ngrok.yml" : ".config/ngrok/ngrok.yml"], env: /^NGROK_/, use: "`ngrok http <port>` gives a public URL — only when asked for a public link." },
  { name: "Twingate", group: "Network", what: "Zero-trust network access", app: "Twingate.app", use: "Remote network access; nothing for agents to run." },
  { name: "Ollama", group: "AI", what: "Local models", bins: ["ollama"], app: "Ollama.app", use: "`ollama run <model>` or the API at http://localhost:11434 for private/offline LLM work." },
  { name: "Jev", group: "AI", what: "Calibrated yes/no and pick-one decisions (TypeSafe)", bins: ["jev"], env: /^TYPESAFE_/, use: "`jev ask` / `jev select` for bounded judgments; record outcomes with `jev outcome`." },
  { name: "OpenRouter", group: "AI", what: "Hundreds of models behind one API", env: /^OPENROUTER_/, use: "OpenAI-compatible API at https://openrouter.ai/api/v1 with OPENROUTER_API_KEY." },
  { name: "OpenAI API", group: "AI", what: "GPT, images, embeddings, speech", env: /^OPENAI_/, use: "Use OPENAI_API_KEY from the environment; never print it." },
  { name: "Anthropic API", group: "AI", what: "Claude models via API", env: /^ANTHROPIC_/, use: "Use ANTHROPIC_API_KEY from the environment." },
  { name: "Google AI", group: "AI", what: "Gemini API", env: /^(GEMINI|GOOGLE_API|GOOGLE_GENERATIVE)/, use: "Use GEMINI_API_KEY / GOOGLE_API_KEY from the environment." },
  { name: "ElevenLabs", group: "AI", what: "Voice and speech", env: /^ELEVEN/, mcp: /eleven/i, use: "Text-to-speech via the ElevenLabs API key in the environment." },
  { name: "Replicate", group: "AI", what: "Hosted open models", env: /^REPLICATE_/, use: "Replicate API with REPLICATE_API_TOKEN." },
  { name: "fal", group: "AI", what: "Image and video generation", env: /^FAL_/, use: "fal.ai API with FAL_KEY." },
  { name: "Hugging Face", group: "AI", what: "Models, datasets", bins: ["huggingface-cli", "hf"], login: [".cache/huggingface/token"], env: /^(HF|HUGGING)/, use: "`hf` / huggingface-cli for downloads; token in ~/.cache/huggingface." },
  { name: "1Password", group: "Secrets", what: "Secrets", bins: ["op"], use: "`op read op://vault/item/field` — ask before reading any secret." },
  { name: "npm", group: "Code & deploy", what: "Publish packages", bins: ["npm"], loginJson: [".npmrc", () => /_authToken/.test(readText(`${HOME}/.npmrc`))], use: "`npm publish` is signed in; ask before publishing." },
  { name: "Postgres", group: "Data", what: "Database shell", bins: ["psql"], env: /^(DATABASE_URL|PG)/, use: "`psql $DATABASE_URL`; read-only queries unless asked." },
  { name: "Redis", group: "Data", what: "Cache / queues", bins: ["redis-cli"], use: "`redis-cli` against a local Redis." },
  { name: "Resend", group: "Messaging", what: "Transactional email", env: /^RESEND_/, use: "Resend API with RESEND_API_KEY." },
  { name: "Telegram", group: "Messaging", what: "Bots and messages", env: /^TELEGRAM_/, mcp: /telegram/i, use: "Bot API with the TELEGRAM token in the environment." },
  { name: "Gmail", group: "Messaging", what: "Read and send email", mcp: /gmail/i, use: "Use the Gmail connector tools; draft first, send only when asked." },
  { name: "Google Drive", group: "Messaging", what: "Docs and files", mcp: /drive/i, use: "Use the Google Drive connector tools." },
  { name: "Google Calendar", group: "Messaging", what: "Calendar", mcp: /calendar/i, use: "Use the Google Calendar connector tools." },
  { name: "Notion", group: "Messaging", what: "Docs and databases", env: /^NOTION_/, mcp: /notion/i, use: "Use the Notion connector tools." },
  { name: "Linear", group: "Messaging", what: "Issues", env: /^LINEAR_/, mcp: /linear/i, use: "Use the Linear connector tools." },
  { name: "Figma", group: "Design", what: "Designs", app: "Figma.app", env: /^FIGMA_/, mcp: /figma/i, use: "Use the Figma MCP tools to read designs." },
  { name: "Adobe", group: "Design", what: "Images, PDFs, Express designs", mcp: /adobe/i, use: "Use the Adobe connector tools for image edits, PDFs and designs." },
  { name: "Canva", group: "Design", what: "Designs", mcp: /canva/i, use: "Use the Canva connector tools." },
  { name: "Blender", group: "Design", what: "3D, rendering", bins: ["blender"], app: "Blender.app", use: `Headless: \`${MAC ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender"} -b file.blend -P script.py\`.` },
  { name: "Godot", group: "Design", what: "Game engine", bins: ["godot"], app: "Godot.app", use: "Godot editor/CLI for game projects." },
  { name: "ffmpeg", group: "Media", what: "Audio and video processing", bins: ["ffmpeg"], use: "`ffmpeg` for cuts, transcodes, frames." },
  { name: "yt-dlp", group: "Media", what: "Download video/audio", bins: ["yt-dlp"], use: "`yt-dlp` to fetch media for processing." },
  { name: "Playwright", group: "Media", what: "Browser automation", bins: ["playwright"], mcp: /playwright/i, use: "Playwright MCP or `npx playwright` for screenshots and UI checks." },
  { name: "Chrome", group: "Media", what: "Real browser with your logins", app: "Google Chrome.app", mcp: /chrome/i, use: "Claude in Chrome tools act in your real signed-in Chrome; ask before submitting anything." },
];
const CORE = new Set(["Git", "Homebrew", "Bun", "Node", "Deno", "Python", "uv", "pnpm", "Rust", "Go", "tmux", "jq", "ripgrep", "herdr", "WezTerm"]);
const DEV: [string, string, string][] = [
  ["Git", "git", "Version control"], ["Homebrew", "brew", "Packages"], ["Bun", "bun", "JS runtime"], ["Node", "node", "JS runtime"], ["Deno", "deno", "JS runtime"],
  ["pnpm", "pnpm", "JS packages"], ["Python", "python3", "Runtime"], ["uv", "uv", "Python packages"], ["Rust", "cargo", "Toolchain"], ["Go", "go", "Toolchain"],
  ["tmux", "tmux", "Terminal multiplexer"], ["herdr", "herdr", "Agent multiplexer"], ["WezTerm", "wezterm", "Terminal"], ["jq", "jq", "JSON on the command line"], ["ripgrep", "rg", "Fast search"],
];
const AGENTS: [string, string, string][] = [
  ["Claude Code", "claude", "Anthropic's coding agent"], ["Codex", "codex", "OpenAI's coding agent"], ["OpenCode", "opencode", "Open-source agent, any model"], ["Gemini CLI", "gemini", "Google's coding agent"],
  ["Hermes", "hermes", "Nous Research agent"], ["Cursor agent", "cursor-agent", "Cursor's CLI agent"], ["Aider", "aider", "Pair programmer"], ["Amp", "amp", "Sourcegraph's agent"], ["Goose", "goose", "Block's agent"],
];

type McpEntry = { name: string; where: string; remote: boolean };
function mcpEntries(): McpEntry[] {
  const out: McpEntry[] = [];
  const add = (obj: any, where: string) => { for (const [n, c] of Object.entries<any>(obj ?? {})) out.push({ name: n, where, remote: !!(c?.url || c?.httpUrl || c?.serverUrl) }); };
  const cj = readJson(`${HOME}/.claude.json`) ?? {};
  add(cj.mcpServers, "Claude Code");
  for (const p of Object.values<any>(cj.projects ?? {})) add(p?.mcpServers, "Claude Code (project)");
  for (const n of cj.claudeAiMcpEverConnected ?? []) out.push({ name: String(n).replace(/^claude\.ai /, ""), where: "claude.ai connector", remote: true });
  const plugins = readJson(`${HOME}/.claude/plugins/installed_plugins.json`)?.plugins ?? {};
  for (const [id, inst] of Object.entries<any>(plugins)) {
    const root = (Array.isArray(inst) ? inst[inst.length - 1] : inst)?.installPath;
    if (root) add(readJson(`${root}/.mcp.json`)?.mcpServers ?? readJson(`${root}/.mcp.json`), `Claude plugin ${id.split("@")[0]}`);
  }
  for (const m of readText(`${HOME}/.codex/config.toml`).matchAll(/^\[mcp_servers\.([^\].]+)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) out.push({ name: m[1], where: "Codex", remote: /^\s*url\s*=/m.test(m[2]) });
  const oc = readJson(`${HOME}/.config/opencode/opencode.json`) ?? readJson(`${HOME}/.config/opencode/config.json`) ?? {};
  add(oc.mcp, "OpenCode");
  add(readJson(`${HOME}/.gemini/settings.json`)?.mcpServers, "Gemini CLI");
  add(readJson(`${HOME}/.cursor/mcp.json`)?.mcpServers, "Cursor");
  add(readJson(`${HOME}/.codeium/windsurf/mcp_config.json`)?.mcpServers, "Windsurf");
  if (MAC) {
    add(readJson(`${HOME}/Library/Application Support/Claude/claude_desktop_config.json`)?.mcpServers, "Claude Desktop");
    add(readJson(`${HOME}/Library/Application Support/Code/User/mcp.json`)?.servers, "VS Code");
  } else add(readJson(`${HOME}/.config/Code/User/mcp.json`)?.servers, "VS Code");
  return out;
}

async function services(keys: { name: string; where: string }[], mcps: McpEntry[], npx: Map<string, string>): Promise<Item[]> {
  return Promise.all(SERVICES.map(async (s) => {
    const via: string[] = [];
    let installed = false;
    for (const b of s.bins ?? []) {
      const p = which(b);
      if (!p) continue;
      installed = true;
      const v = b === "az" || b === "gcloud" ? undefined : await version(p, b === "go" || b === "kubectl" ? "version" : "--version");
      via.push(`${b}${v ? ` ${v}` : ""}`);
    }
    for (const pkg of s.npx ?? []) if (npx.has(pkg)) { installed = true; via.push(`npx ${pkg} ${npx.get(pkg)}`); }
    if (s.app && MAC && existsSync(`/Applications/${s.app}`)) { installed = true; via.push(s.app.replace(/\.app$/, "") + " app"); }
    const k = s.env ? keys.filter((x) => s.env!.test(x.name)) : [];
    for (const x of k) via.push(`key ${x.name}`);
    const m = s.mcp ? [...new Set(mcps.filter((x) => s.mcp!.test(x.name)).map((x) => `${x.name} (${x.where})`))] : [];
    for (const x of m.slice(0, 3)) via.push(`MCP ${x}`);
    let signed: boolean | undefined;
    if (s.loginJson) { const j = readJson(`${HOME}/${s.loginJson[0]}`); signed = s.loginJson[1](j); }
    else if (s.login) signed = s.login.some(has);
    const any = installed || k.length > 0 || m.length > 0;
    const status: Item["status"] = !any ? "off" : signed === false && !k.length && !m.length ? "partial" : "ready";
    const note = !any ? "not set up" : signed === true ? "signed in" : signed === false && installed && !k.length && !m.length ? "installed, not signed in" : m.length && !installed ? "via MCP" : k.length && !installed ? "API key set" : installed ? "installed" : "";
    return { id: `svc:${slug(s.name)}`, name: s.name, kind: "service", group: s.group, status, detail: s.what, note, via, use: s.use };
  }));
}

async function agents(): Promise<Item[]> {
  const out: Item[] = [];
  for (const [name, bin, what] of AGENTS) {
    const path = which(bin);
    if (!path) continue;
    const v = await version(path);
    out.push({ id: `agent:${bin}`, name, kind: "agent", status: "ready", detail: what, note: v ? `v${v}` : "installed", via: [bin] });
  }
  return out;
}
async function devTools(): Promise<Item[]> {
  const found = await Promise.all(DEV.map(async ([name, bin, what]) => {
    const p = which(bin);
    if (!p) return;
    const v = await version(p, bin === "go" ? "version" : "--version");
    return { id: `dev:${bin}`, name, kind: "cli", status: "ready" as const, detail: what, note: v ? `v${v}` : "installed", via: [bin] };
  }));
  return found.filter(Boolean) as Item[];
}

function subscriptions(): Item[] {
  const out: Item[] = [];
  const oa = readJson(`${HOME}/.claude.json`)?.oauthAccount;
  if (oa) out.push({ id: "sub:claude", name: "Claude", kind: "sub", status: "ready", detail: [oa.billingType?.replace(/_/g, " "), oa.organizationRateLimitTier ?? oa.userRateLimitTier].filter(Boolean).join(" · ") || "signed in", note: "signed in" });
  const codexPlan = latestCodexLimits()?.plan;
  if (existsSync(`${HOME}/.codex/auth.json`)) out.push({ id: "sub:chatgpt", name: "ChatGPT / Codex", kind: "sub", status: "ready", detail: codexPlan ? `${codexPlan} plan` : "signed in", note: "signed in" });
  if (existsSync(`${HOME}/.gemini`)) out.push({ id: "sub:gemini", name: "Gemini", kind: "sub", status: "ready", detail: existsSync(`${HOME}/.gemini/oauth_creds.json`) ? "Google sign-in" : "configured" });
  const models = ls(`${HOME}/.ollama/models/manifests/registry.ollama.ai/library`);
  if (models.length) out.push({ id: "sub:ollama", name: "Ollama models", kind: "sub", status: "ready", detail: `${models.length} local model${models.length > 1 ? "s" : ""}`, note: models.slice(0, 8).join(", ") });
  return out;
}

function sshHosts(): Item[] {
  const out: Item[] = [];
  for (const m of readText(`${HOME}/.ssh/config`).matchAll(/^\s*Host\s+(.+)$/gim)) {
    for (const h of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(h)) out.push({ id: `ssh:${h}`, name: h, kind: "ssh", status: "ready", detail: "SSH host", via: [`ssh ${h}`], use: `\`ssh ${h}\` (key auth; non-interactive commands work).` });
  }
  return out;
}

function browsers(): Item[] {
  const out: Item[] = [];
  const roots: [string, string][] = MAC
    ? [["Chrome", "Library/Application Support/Google/Chrome"], ["Brave", "Library/Application Support/BraveSoftware/Brave-Browser"], ["Arc", "Library/Application Support/Arc/User Data"], ["Edge", "Library/Application Support/Microsoft Edge"]]
    : [["Chrome", ".config/google-chrome"], ["Chromium", ".config/chromium"], ["Brave", ".config/BraveSoftware/Brave-Browser"]];
  for (const [b, dir] of roots) {
    const cache = readJson(`${HOME}/${dir}/Local State`)?.profile?.info_cache ?? {};
    for (const [id, p] of Object.entries<any>(cache)) out.push({ id: `browser:${slug(b)}:${slug(id)}`, name: p.name || id, kind: "browser", group: b, status: p.user_name ? "ready" : "partial", detail: `${b} profile`, note: p.user_name ? "signed in to Google" : "no Google account" });
  }
  return out;
}

function skills(): Item[] {
  const out = new Map<string, Item>();
  for (const [where, dir] of [["Claude Code", ".claude/skills"], ["Codex / agents", ".agents/skills"], ["Codex", ".codex/skills"]] as const) {
    for (const n of ls(`${HOME}/${dir}`)) {
      if (n.startsWith(".") || n.endsWith(".md")) continue;
      const md = readText(`${HOME}/${dir}/${n}/SKILL.md`);
      const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").slice(0, 200);
      const prev = out.get(n);
      if (prev) { if (!prev.group!.includes(where)) prev.group = `${prev.group}, ${where}`; continue; }
      out.set(n, { id: `skill:${n}`, name: n, kind: "skill", group: where, status: "ready", detail: desc, use: `Skill "${n}": load it when the task matches.` });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── your edits: custom connections, hidden items, notes ─────────────────────
const CONF = `${HOME}/.config/herdr-deck/connections.json`;
export type ConnConf = { custom: Item[]; hidden: string[]; notes: Record<string, string> };
export function loadConnConf(): ConnConf {
  const j = readJson(CONF) ?? {};
  return { custom: j.custom ?? [], hidden: j.hidden ?? [], notes: j.notes ?? {} };
}
export function saveConnConf(c: ConnConf) {
  try { mkdirSync(`${HOME}/.config/herdr-deck`, { recursive: true }); writeFileSync(CONF, JSON.stringify(c, null, 1)); } catch {}
  cached = undefined;
}

export function latestCodexLimits(): { plan?: string; windows: { label: string; pct: number; resets?: number; minutes?: number }[]; at?: number } | undefined {
  const root = `${HOME}/.codex/sessions`;
  const files: { f: string; m: number }[] = [];
  const now = new Date();
  for (let back = 0; back < 4 && files.length < 6; back++) {
    const d = new Date(now.getTime() - back * 86400_000);
    const dir = `${root}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    for (const n of ls(dir)) if (n.endsWith(".jsonl")) { try { files.push({ f: `${dir}/${n}`, m: statSync(`${dir}/${n}`).mtimeMs }); } catch {} }
  }
  files.sort((a, b) => b.m - a.m);
  for (const { f, m } of files.slice(0, 6)) {
    let tail = "";
    try {
      const size = statSync(f).size;
      const fd = openSync(f, "r");
      const len = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      closeSync(fd);
      tail = buf.toString("utf8");
    } catch { continue; }
    const hits = [...tail.matchAll(/"rate_limits":(\{"limit_id".*?"plan_type":(?:"[^"]*"|null)[^}]*\})/g)];
    const last = hits[hits.length - 1]?.[1];
    if (!last) continue;
    let o: any;
    try { o = JSON.parse(last); } catch { continue; }
    const w = (x: any) => x && { pct: Number(x.used_percent), resets: x.resets_at ? x.resets_at * 1000 : undefined, minutes: x.window_minutes, label: x.window_minutes >= 10000 ? "Weekly" : x.window_minutes >= 250 ? `${Math.round(x.window_minutes / 60)}h` : `${x.window_minutes}m` };
    return { plan: o.plan_type ?? undefined, windows: [w(o.primary), w(o.secondary)].filter(Boolean), at: m };
  }
}

export function usage() {
  let claude: any;
  const rc = readJson(`${HOME}/.claude/rate-cache.json`);
  if (rc) {
    const n = (v: any) => (v === "" || v == null ? undefined : Number(v));
    let at = rc.at ? rc.at * 1000 : undefined;
    try { at ??= statSync(`${HOME}/.claude/rate-cache.json`).mtimeMs; } catch {}
    claude = { fiveHour: n(rc.five_hour), weekly: n(rc.seven_day), fiveHourResets: rc.five_hour_resets ? rc.five_hour_resets * 1000 : undefined, weeklyResets: rc.seven_day_resets ? rc.seven_day_resets * 1000 : undefined, at };
  }
  return { claude, codex: latestCodexLimits() };
}

let cached: Inventory | undefined;
let building: Promise<Inventory> | undefined;
export async function inventory(force = false): Promise<Inventory> {
  if (cached && !force && Date.now() - cached.at < 10 * 60_000) return cached;
  if (building) return building;
  building = (async () => {
    const t0 = Date.now();
    const keys = keyNames(), mcps = mcpEntries(), npx = npxCache();
    const [svc, ag, dev] = await Promise.all([services(keys, mcps, npx), agents(), devTools()]);
    const conf = loadConnConf();
    const hid = new Set(conf.hidden);
    const dress = (it: Item): Item => ({ ...it, use: conf.notes[it.id] ?? it.use, hidden: hid.has(it.id) });
    const used = new Set(svc.filter((x) => x.status !== "off").flatMap((x) => x.via ?? []));
    const mcpItems: Item[] = [];
    const byName = new Map<string, McpEntry[]>();
    for (const m of mcps) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
    for (const [n, es] of byName) mcpItems.push({ id: `mcp:${slug(n)}`, name: n, kind: "mcp", status: "ready", detail: es[0].remote ? "Remote MCP server" : "Local MCP server", note: [...new Set(es.map((e) => e.where))].slice(0, 3).join(", "), via: [...new Set(es.map((e) => e.where))], use: `MCP server "${n}" (${[...new Set(es.map((e) => e.where))].join(", ")}): use its tools when relevant.` });
    const keyItems: Item[] = keys.map((k) => ({ id: `key:${slug(k.name)}`, name: k.name, kind: "key", status: "ready", detail: `set in ${k.where}`, note: used.has(`key ${k.name}`) ? "used by a service above" : "", use: `Env var ${k.name} is available (value never shown).` }));
    const sections: Section[] = [
      { id: "services", title: "Services", hint: "What agents can deploy to, pay with, store in, and talk to — and how", items: svc.filter((x) => x.status !== "off") },
      { id: "ai", title: "AI", hint: "Coding agents and the plans and models behind them", items: [...ag, ...subscriptions()] },
      { id: "mcp", title: "MCP servers & connectors", hint: "Tool servers each agent app can call", items: mcpItems },
      { id: "machines", title: "Machines", hint: "SSH hosts this machine can reach", items: sshHosts() },
      { id: "keys", title: "API keys", hint: "Names and where they're set. Values are never read or sent.", items: keyItems },
      { id: "dev", title: "Dev tools", hint: "Runtimes and everyday CLIs", items: dev },
      { id: "browser", title: "Browsers", hint: "Profiles and whether they're signed in", items: browsers() },
      { id: "skills", title: "Skills", hint: "Packaged know-how agents can load", items: skills() },
      { id: "custom", title: "Yours", hint: "Connections you added by hand", items: conf.custom.map((c) => ({ ...c, custom: true, kind: c.kind || "custom", status: c.status ?? "ready" })) },
      { id: "missing", title: "Not set up", hint: "Common services this machine can't reach yet", items: svc.filter((x) => x.status === "off") },
    ].map((sec) => ({ ...sec, items: sec.items.map(dress) }));
    const inv: Inventory = { machine: hostname().replace(/\.local$/, ""), at: Date.now(), ms: Date.now() - t0, sections };
    inv.file = writeConnectionsMd(inv);
    cached = inv;
    return inv;
  })().finally(() => { building = undefined; });
  return building;
}

const itemLine = (i: Item) => `- **${i.name}**${i.status === "partial" ? " (needs sign-in)" : ""}${i.detail ? ` — ${i.detail}` : ""}${i.via?.length ? `. Via: ${i.via.join(", ")}` : ""}${i.use ? `\n  How: ${i.use}` : ""}`;

/** Plain text for agents (MCP, "suggest projects", CONNECTIONS.md): capabilities and how to use them, never secrets. */
export function inventoryText(inv: Inventory, only?: Set<string>): string {
  const lines = [`# Connections on ${inv.machine}`, "", "What this machine can reach and how to use it. Never print or log secret values; ask before anything public, paid or destructive."];
  for (const s of inv.sections) {
    if (s.id === "missing") continue;
    const items = s.items.filter((i) => !i.hidden && (!only || only.has(i.id)) && (s.id !== "keys" || !i.note) && (s.id !== "skills" || only));
    if (!items.length) continue;
    lines.push("", `## ${s.title}`, ...items.map(itemLine));
  }
  if (!only) {
    const sk = inv.sections.find((s) => s.id === "skills")?.items.filter((i) => !i.hidden) ?? [];
    if (sk.length) lines.push("", "## Skills", sk.map((i) => i.name).join(", "));
  }
  return lines.join("\n");
}

const MD_FILE = `${HOME}/.config/herdr-deck/CONNECTIONS.md`;
function writeConnectionsMd(inv: Inventory) {
  try { mkdirSync(`${HOME}/.config/herdr-deck`, { recursive: true }); writeFileSync(MD_FILE, inventoryText(inv) + `\n\n_Updated ${new Date(inv.at).toISOString()} by herdr deck._\n`); return MD_FILE; } catch {}
}
