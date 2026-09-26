// What this machine can reach: CLIs and whether they're signed in, MCP servers each agent has, AI
// subscriptions, API keys (names and where they're set, never values), browser profiles, skills.
// It's the map agents need to take on big projects, and what "suggest projects" reasons over.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";

const HOME = homedir();
const MAC = platform() === "darwin";
const PATH = [`${HOME}/.bun/bin`, `${HOME}/.local/bin`, `${HOME}/.cargo/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${HOME}/go/bin`, `${HOME}/.npm-global/bin`, process.env.PATH ?? ""].join(":");

export type Item = { name: string; kind: string; detail?: string; ok?: boolean; note?: string; group?: string };
export type Inventory = { machine: string; at: number; ms: number; sections: { id: string; title: string; hint: string; items: Item[] }[] };

// name, binary, what it's for, a config path whose presence means "signed in / configured"
const CLIS: [string, string, string, string?][] = [
  ["GitHub", "gh", "repos, PRs, issues, Actions", ".config/gh/hosts.yml"],
  ["Git", "git", "version control"],
  ["Vercel", "vercel", "deploys, domains, env", MAC ? "Library/Application Support/com.vercel.cli/auth.json" : ".local/share/com.vercel.cli/auth.json"],
  ["Netlify", "netlify", "deploys, forms, functions", MAC ? "Library/Preferences/netlify/config.json" : ".config/netlify/config.json"],
  ["Supabase", "supabase", "Postgres, auth, storage", ".supabase/access-token"],
  ["Stripe", "stripe", "payments, webhooks", ".config/stripe/config.toml"],
  ["Cloudflare", "wrangler", "Workers, Pages, DNS, R2", ".wrangler/config/default.toml"],
  ["Fly.io", "flyctl", "app hosting", ".fly/config.yml"],
  ["Railway", "railway", "app hosting", ".railway/config.json"],
  ["AWS", "aws", "cloud", ".aws/credentials"],
  ["Google Cloud", "gcloud", "cloud", ".config/gcloud/active_config"],
  ["Firebase", "firebase", "hosting, auth, Firestore", ".config/configstore/firebase-tools.json"],
  ["Docker", "docker", "containers"],
  ["Kubernetes", "kubectl", "clusters", ".kube/config"],
  ["Tailscale", "tailscale", "private network, share dev servers"],
  ["Ollama", "ollama", "local models"],
  ["1Password", "op", "secrets"],
  ["Postgres", "psql", "database shell"],
  ["ffmpeg", "ffmpeg", "audio and video"],
  ["yt-dlp", "yt-dlp", "download video"],
  ["Playwright", "playwright", "browser automation"],
  ["Homebrew", "brew", "packages"],
  ["Bun", "bun", "JS runtime"],
  ["Node", "node", "JS runtime"],
  ["Python", "python3", "runtime"],
  ["uv", "uv", "Python packages"],
  ["Rust", "cargo", "toolchain"],
  ["Go", "go", "toolchain"],
  ["Terraform", "terraform", "infrastructure"],
  ["Jev", "jev", "calibrated decisions (TypeSafe)"],
];
const AGENTS: [string, string][] = [
  ["Claude Code", "claude"], ["Codex", "codex"], ["OpenCode", "opencode"], ["Gemini CLI", "gemini"], ["Hermes", "hermes"],
  ["Cursor agent", "cursor-agent"], ["Aider", "aider"], ["Amp", "amp"], ["Goose", "goose"],
];

function which(bin: string): string | undefined {
  for (const dir of PATH.split(":")) if (dir && existsSync(`${dir}/${bin}`)) return `${dir}/${bin}`;
}
async function version(path: string, arg = "--version"): Promise<string | undefined> {
  try {
    const p = Bun.spawn([path, arg], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH, NO_COLOR: "1" } });
    const t = setTimeout(() => p.kill(9), 2500);
    const out = (await new Response(p.stdout).text()) || (await new Response(p.stderr).text());
    clearTimeout(t);
    return out.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^.*?(\d+\.\d+[\w.\-+]*).*$/, "$1").slice(0, 40);
  } catch {}
}
const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };

async function clis(): Promise<Item[]> {
  return Promise.all(CLIS.map(async ([name, bin, what, cfg]) => {
    const path = which(bin);
    if (!path) return { name, kind: "cli", detail: what, ok: false, note: "not installed", group: bin };
    const v = await version(path, bin === "go" ? "version" : "--version");
    const signed = cfg ? existsSync(`${HOME}/${cfg}`) : undefined;
    return { name, kind: "cli", detail: what, ok: true, note: [v && `v${v}`, signed === true ? "signed in" : signed === false ? "not signed in" : ""].filter(Boolean).join(" · "), group: bin };
  }));
}

async function agents(): Promise<Item[]> {
  const out: Item[] = [];
  for (const [name, bin] of AGENTS) {
    const path = which(bin);
    if (!path) continue;
    const v = await version(path);
    out.push({ name, kind: "agent", ok: true, note: v ? `v${v}` : "installed", group: bin });
  }
  return out;
}

function mcpServers(): Item[] {
  const out: Item[] = [];
  const cj = readJson(`${HOME}/.claude.json`) ?? {};
  for (const [n, c] of Object.entries<any>(cj.mcpServers ?? {})) out.push({ name: n, kind: "mcp", detail: c.url ? "remote (http)" : c.command ? `local: ${String(c.command).split("/").pop()}` : "", group: "Claude Code (user)" });
  const projectMcp = new Map<string, string[]>();
  for (const [dir, p] of Object.entries<any>(cj.projects ?? {})) for (const n of Object.keys(p?.mcpServers ?? {})) projectMcp.set(n, [...(projectMcp.get(n) ?? []), dir.replace(HOME, "~")]);
  for (const [n, dirs] of projectMcp) out.push({ name: n, kind: "mcp", detail: `in ${dirs.length} project${dirs.length > 1 ? "s" : ""}`, note: dirs.slice(0, 3).join(", "), group: "Claude Code (project)" });
  for (const n of cj.claudeAiMcpEverConnected ?? []) out.push({ name: String(n).replace(/^claude\.ai /, ""), kind: "mcp", detail: "claude.ai connector", group: "Claude connectors" });
  // Plugins can bring their own MCP servers (playwright, context7…)
  const plugins = readJson(`${HOME}/.claude/plugins/installed_plugins.json`)?.plugins ?? {};
  for (const id of Object.keys(plugins)) out.push({ name: id.split("@")[0], kind: "plugin", detail: id.split("@")[1] ?? "", group: "Claude Code plugins" });
  const toml = readText(`${HOME}/.codex/config.toml`);
  for (const m of toml.matchAll(/^\[mcp_servers\.([^\].]+)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) {
    const body = m[2];
    out.push({ name: m[1], kind: "mcp", detail: /^\s*url\s*=/m.test(body) ? "remote (http)" : `local: ${(body.match(/^\s*command\s*=\s*"([^"]+)"/m)?.[1] ?? "").split("/").pop()}`, group: "Codex" });
  }
  const oc = readJson(`${HOME}/.config/opencode/opencode.json`) ?? readJson(`${HOME}/.config/opencode/config.json`) ?? {};
  for (const n of Object.keys(oc.mcp ?? {})) out.push({ name: n, kind: "mcp", group: "OpenCode" });
  return out;
}

function subscriptions(): Item[] {
  const out: Item[] = [];
  const oa = readJson(`${HOME}/.claude.json`)?.oauthAccount;
  if (oa) out.push({ name: "Claude", kind: "sub", detail: [oa.billingType?.replace(/_/g, " "), oa.organizationRateLimitTier ?? oa.userRateLimitTier].filter(Boolean).join(" · ") || "signed in", note: oa.emailAddress, ok: true });
  // Codex writes its plan into every rate-limit event
  const codexPlan = latestCodexLimits()?.plan;
  if (existsSync(`${HOME}/.codex/auth.json`)) out.push({ name: "ChatGPT / Codex", kind: "sub", detail: codexPlan ? `${codexPlan} plan` : "signed in", ok: true });
  if (existsSync(`${HOME}/.gemini`)) out.push({ name: "Gemini", kind: "sub", detail: existsSync(`${HOME}/.gemini/oauth_creds.json`) ? "Google sign-in" : "configured", ok: true });
  const models = ls(`${HOME}/.ollama/models/manifests/registry.ollama.ai/library`);
  if (models.length) out.push({ name: "Ollama (local)", kind: "sub", detail: `${models.length} model${models.length > 1 ? "s" : ""}`, note: models.slice(0, 8).join(", "), ok: true });
  return out;
}

/** Key NAMES from shell startup files and ~/.config/*\/api-key style files. Values are never read into the result. */
function apiKeys(): Item[] {
  const out = new Map<string, Item>();
  const files = [".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"];
  for (const f of files) {
    for (const line of readText(`${HOME}/${f}`).split("\n")) {
      const m = line.match(/^\s*(?:export\s+|set\s+-gx\s+)?([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|TOKEN|SECRET|_PAT))\b/);
      if (m && !out.has(m[1])) out.set(m[1], { name: m[1], kind: "key", detail: `set in ~/${f}`, group: vendorOf(m[1]) });
    }
  }
  for (const d of ls(`${HOME}/.config`)) {
    for (const f of ls(`${HOME}/.config/${d}`)) {
      if (/^(api[-_]?key|token|credentials?)(\.txt|\.json)?$/i.test(f)) out.set(`${d}/${f}`, { name: `${d} key file`, kind: "key", detail: `~/.config/${d}/${f}`, group: vendorOf(d) });
    }
  }
  return [...out.values()];
}
function vendorOf(n: string) {
  const s = n.toLowerCase();
  const v = [["openai", "OpenAI"], ["anthropic", "Anthropic"], ["openrouter", "OpenRouter"], ["gemini", "Google"], ["google", "Google"], ["typesafe", "TypeSafe (Jev)"], ["elevenlabs", "ElevenLabs"], ["github", "GitHub"], ["stripe", "Stripe"], ["supabase", "Supabase"], ["vercel", "Vercel"], ["replicate", "Replicate"], ["fal", "fal"], ["groq", "Groq"], ["perplexity", "Perplexity"], ["xai", "xAI"], ["grok", "xAI"], ["brave", "Brave"], ["exa", "Exa"], ["tavily", "Tavily"], ["firecrawl", "Firecrawl"], ["apify", "Apify"], ["scrapecreators", "ScrapeCreators"], ["resend", "Resend"], ["twilio", "Twilio"], ["gumroad", "Gumroad"], ["notion", "Notion"], ["linear", "Linear"], ["telegram", "Telegram"], ["discord", "Discord"], ["slack", "Slack"], ["hf", "Hugging Face"], ["hugging", "Hugging Face"]]
    .find(([k]) => s.includes(k));
  return v?.[1] ?? "Other";
}

function browsers(): Item[] {
  const out: Item[] = [];
  const roots: [string, string][] = MAC
    ? [["Chrome", "Library/Application Support/Google/Chrome"], ["Brave", "Library/Application Support/BraveSoftware/Brave-Browser"], ["Arc", "Library/Application Support/Arc/User Data"], ["Edge", "Library/Application Support/Microsoft Edge"]]
    : [["Chrome", ".config/google-chrome"], ["Chromium", ".config/chromium"], ["Brave", ".config/BraveSoftware/Brave-Browser"]];
  for (const [b, dir] of roots) {
    const st = readJson(`${HOME}/${dir}/Local State`);
    const cache = st?.profile?.info_cache ?? {};
    for (const [id, p] of Object.entries<any>(cache)) out.push({ name: p.name || id, kind: "browser", detail: p.user_name || "not signed in to a Google account", group: b, ok: !!p.user_name });
  }
  if (MAC && existsSync(`${HOME}/Library/Application Support/Firefox/Profiles`)) out.push({ name: "Firefox", kind: "browser", detail: `${ls(`${HOME}/Library/Application Support/Firefox/Profiles`).length} profile(s)`, group: "Firefox" });
  return out;
}

function skills(): Item[] {
  const out = new Map<string, Item>();
  for (const [where, dir] of [["Claude Code", ".claude/skills"], ["Codex / agents", ".agents/skills"], ["Codex", ".codex/skills"]] as const) {
    for (const n of ls(`${HOME}/${dir}`)) {
      if (n.startsWith(".") || n.endsWith(".md")) continue;
      const md = readText(`${HOME}/${dir}/${n}/SKILL.md`);
      const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").slice(0, 160);
      const prev = out.get(n);
      if (prev) { prev.group = prev.group!.includes(where) ? prev.group : `${prev.group}, ${where}`; continue; }
      out.set(n, { name: n, kind: "skill", detail: desc, group: where });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
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
export async function inventory(force = false): Promise<Inventory> {
  if (cached && !force && Date.now() - cached.at < 10 * 60_000) return cached;
  const t0 = Date.now();
  const [c, a] = await Promise.all([clis(), agents()]);
  cached = {
    machine: hostname().replace(/\.local$/, ""),
    at: Date.now(),
    ms: 0,
    sections: [
      { id: "agents", title: "Coding agents", hint: "Installed agent CLIs", items: a },
      { id: "subs", title: "AI subscriptions & models", hint: "Plans you're signed in to, and local models", items: subscriptions() },
      { id: "mcp", title: "MCP servers & connectors", hint: "Tools each agent can call", items: mcpServers() },
      { id: "cli", title: "Command-line tools", hint: "Installed CLIs, and whether they're signed in", items: c.filter((x) => x.ok) },
      { id: "keys", title: "API keys", hint: "Names and where they're set. Values are never shown or sent anywhere.", items: apiKeys() },
      { id: "browser", title: "Browser profiles", hint: "Profiles and the accounts signed in to them", items: browsers() },
      { id: "skills", title: "Skills", hint: "Packaged know-how agents can load", items: skills() },
      { id: "missing", title: "Not installed", hint: "Common tools this machine doesn't have", items: c.filter((x) => !x.ok) },
    ],
  };
  cached.ms = Date.now() - t0;
  return cached;
}

/** Plain-text version for agents (MCP, "suggest projects"): names and capabilities, no emails or paths. */
export function inventoryText(inv: Inventory): string {
  const lines = [`Machine: ${inv.machine}`];
  for (const s of inv.sections) {
    if (s.id === "missing" || !s.items.length) continue;
    lines.push(`\n## ${s.title}`);
    for (const i of s.items) lines.push(`- ${i.name}${i.group && s.id !== "cli" ? ` [${i.group}]` : ""}${i.detail && s.id !== "browser" && s.id !== "subs" ? `: ${i.detail}` : ""}${s.id === "subs" && i.detail ? `: ${i.detail}` : ""}${s.id === "cli" && i.note ? ` (${i.note})` : ""}`);
  }
  return lines.join("\n");
}
