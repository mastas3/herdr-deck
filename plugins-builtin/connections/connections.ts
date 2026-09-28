// What this machine can reach: CLIs and whether they're signed in, MCP servers each agent has, AI
// subscriptions, API keys (names and where they're set, never values), browser profiles, skills,
// tailnet devices, background services. It's the map agents need to take on big projects, and what
// the Connections store and its recipes reason over.
//
// The one rule: this records names, versions and signed-in flags only. It never reads a secret value
// into memory it keeps: env files are matched line by line for the NAME, credential files are only
// checked for existence (or a user/account field's presence), and probes print names, never tokens.
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { mergeAccounts, recommend, type Account, type Evidence, type RecInfo } from "./accounts";
import type { Site } from "../../src/catalog";
import type { LoginScan } from "./logins";
import { detectProjects, projectItems, type ServiceRef, type SkillRef } from "./projconn";
import type { Cat, State } from "./store";
import { latestCodexLimits } from "../../src/usage";

const HOME = homedir();
const MAC = platform() === "darwin";
/** The login-shell PATH plus the places tools hide: every nvm Node, bun, deno, cargo, go, pnpm, conda, Docker.app. */
function buildPath() {
  const nvm = (() => { try { return readdirSync(`${HOME}/.nvm/versions/node`).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((v) => `${HOME}/.nvm/versions/node/${v}/bin`); } catch { return []; } })();
  const dirs = [`${HOME}/.bun/bin`, `${HOME}/.local/bin`, `${HOME}/.opencode/bin`, `${HOME}/.deno/bin`, `${HOME}/.cargo/bin`, `${HOME}/go/bin`, `${HOME}/.npm-global/bin`, `${HOME}/Library/pnpm`, `${HOME}/.local/share/pnpm`,
    ...nvm, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/snap/bin", "/Applications/Docker.app/Contents/Resources/bin", "/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@15/bin", "/opt/homebrew/opt/postgresql@14/bin",
    ...(process.env.PATH ?? "").split(":"), "/opt/miniconda3/bin", `${HOME}/miniconda3/bin`, `${HOME}/anaconda3/bin`, `${HOME}/Library/Android/sdk/platform-tools`, `${HOME}/Android/Sdk/platform-tools`];
  return [...new Set(dirs.filter(Boolean))].join(":");
}
const PATH = buildPath();

export type Item = {
  id: string; name: string; kind: string; group?: string;
  cat?: Cat; state?: State; color?: string;
  status?: "ready" | "partial" | "off";
  detail?: string; // what it's for
  note?: string; // state: version, signed in…
  via?: string[]; // how it's reached: CLI, npx, MCP, key names
  use?: string; // how an agent should use it
  since?: number; // first seen on this machine (0 = there since the first scan)
  custom?: boolean; hidden?: boolean;
  // accounts (social media, sites): see accounts.ts
  site?: string; // catalog id
  glyph?: string; // short badge text
  handle?: string; url?: string; // your public handle / profile link, when you added one
  own?: { handle?: string; url?: string; notes?: string }; // the account as you added it
  logins?: string[]; // where a saved login is: "Chrome · Default profile"
  connect?: string[]; // how agents can connect it, best first
  sites?: string[]; // "Other sites" only: registrable domains, shown in the deck, never written to CONNECTIONS.md
  rec?: RecInfo; // "Recommended" only
  // your projects (projconn.ts)
  path?: string; // ~/Documents/Projects/x
  aliases?: string[]; // card ids this one replaces (its MCP server, a service card), so recipes still match
  tools?: string[]; // MCP tool names found in the server's source
};
export type Section = { id: string; title: string; hint: string; items: Item[] };
export type Inventory = { machine: string; at: number; ms: number; sections: Section[]; file?: string; platform?: string };

/** JSON, tolerating a BOM (Azure writes one). */
const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")); } catch { return undefined; } };
/** JSON with comments and trailing commas (OpenCode's .jsonc, Zed's settings). */
function readJsonc(p: string) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { return undefined; }
  let o = "", str = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (str) { o += c; if (c === "\\") o += t[++i] ?? ""; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; o += c; continue; }
    if (c === "/" && t[i + 1] === "/") { while (i < t.length && t[i] !== "\n") i++; o += "\n"; continue; }
    if (c === "/" && t[i + 1] === "*") { const e = t.indexOf("*/", i + 2); i = e < 0 ? t.length : e + 1; continue; }
    o += c;
  }
  try { return JSON.parse(o.replace(/,(\s*[}\]])/g, "$1")); } catch { return undefined; }
}
const readText = (p: string, max = 1 << 20) => { try { const s = statSync(p); if (!s.isFile() || s.size > max) return ""; return readFileSync(p, "utf8"); } catch { return ""; } };
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const abs = (rel: string) => (rel.startsWith("/") ? rel : `${HOME}/${rel}`);
const has = (rel: string) => existsSync(abs(rel));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function which(bin: string): string | undefined {
  for (const dir of PATH.split(":")) if (dir && existsSync(`${dir}/${bin}`)) return `${dir}/${bin}`;
}
const ENV = () => ({ ...process.env, PATH, NO_COLOR: "1", CI: "1", NO_UPDATE_NOTIFIER: "1", TERM: "dumb" });
/** Stop a probe. One that timed out goes with everything it started (it runs in its own process group), so a shell
 * wrapper (like macOS's /usr/local/bin/tailscale) can't leave its hung child behind. */
function stop(p: ReturnType<typeof Bun.spawn> | undefined, timedOut: boolean) {
  if (!p) return;
  try { if (timedOut) process.kill(-p.pid, "SIGKILL"); else p.kill(9); } catch { try { p.kill(9); } catch {} }
}
/** Run a probe and give it at most `ms`: a probe that hangs (or leaves a child holding its pipe) is abandoned. */
async function run(cmd: string[], ms = 2500): Promise<{ out: string; code: number | null }> {
  let p: ReturnType<typeof Bun.spawn> | undefined, timedOut = true;
  try {
    p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: ENV(), detached: true } as any);
    const done = (async () => { const out = await new Response(p!.stdout as ReadableStream).text(); return { out, code: await p!.exited }; })();
    const r = await Promise.race([done, Bun.sleep(ms).then(() => undefined)]);
    timedOut = !r;
    return r ?? { out: "", code: null };
  } catch {
    return { out: "", code: null };
  } finally {
    stop(p, timedOut);
  }
}
/** A tool's version, never waiting more than 2.5s. */
async function version(path: string, arg = "--version"): Promise<string | undefined> {
  let p: ReturnType<typeof Bun.spawn> | undefined, timedOut = true;
  try {
    p = Bun.spawn([path, arg], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: ENV(), detached: true } as any);
    const read = (async () => (await new Response(p!.stdout as ReadableStream).text()) || (await new Response(p!.stderr as ReadableStream).text()))();
    const out = await Promise.race([read, Bun.sleep(2500).then(() => undefined)]);
    timedOut = out === undefined;
    return out?.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/)?.[1]?.slice(0, 30);
  } catch {
    return undefined;
  } finally {
    stop(p, timedOut);
  }
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

// ── key names: shell files, agent env files, ~/.config/<x>/.env, project .env files ──
// Each line is matched for the NAME only; the value part of the line is never captured or kept.
const NAME_LINE = /^\s*(?:export\s+|set\s+-gx\s+)?([A-Z][A-Z0-9_]*)\s*(?:=|\s)/;
const KEYISH = /(?:API_KEY|_KEY|TOKEN|SECRET|_PAT|_ID)$/;
const KEY_STRICT = /(?:API_KEY|_KEY|TOKEN|SECRET|_PAT)$/;
const NOT_KEY = /^(PATH|HOME|NVM|PYENV|FZF|STARSHIP|MANPAGER|EDITOR|VISUAL|PAGER|JAVA_HOME|ANDROID|BUN_INSTALL)/;
function envNames(path: string): string[] {
  const out: string[] = [];
  let open = ""; // inside a quoted value that spans lines (a PEM key…): skip until it closes
  for (const line of readText(path, 256 * 1024).split("\n")) {
    if (open) { if (line.includes(open)) open = ""; continue; }
    const m = line.match(NAME_LINE);
    if (!m || m[1].length > 64) continue;
    const rest = line.slice(line.indexOf(m[1]) + m[1].length).replace(/^\s*=?\s*/, "");
    const q = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
    if (q && rest.indexOf(q, 1) < 0) open = q;
    if (!NOT_KEY.test(m[1])) out.push(m[1]);
  }
  return out;
}
/** Folders that hold projects: their .env / .env.local are read for key names (one level deep). */
const PROJECT_ROOTS = ["Documents/Projects", "Projects", "projects", "code", "src", "dev", "work", "repos"];
export type KeyName = { name: string; where: string; projects?: string[] };
/** Key items (names and where), and every env NAME seen, mapped to whether it's only in project .env files. */
export function keyNames(): { keys: KeyName[]; names: Map<string, boolean> } {
  const out = new Map<string, KeyName>();
  const names = new Map<string, boolean>();
  const add = (n: string, where: string, strict = false) => {
    names.set(n, false);
    if (!(strict ? KEY_STRICT : KEYISH).test(n) || out.has(n)) return;
    out.set(n, { name: n, where });
  };
  for (const f of [".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish", ".env"]) for (const n of envNames(`${HOME}/${f}`)) add(n, `~/${f}`);
  // Agent homes keep their own env files.
  for (const d of [".hermes", ".stasclaw", ".openclaw", ".clawdbot", ".claude-code-router", ".n8n", ".goose", ".aider"]) for (const f of [".env", "env"]) for (const n of envNames(`${HOME}/${d}/${f}`)) add(n, `~/${d}/${f}`, true);
  for (const d of ls(`${HOME}/.config`)) {
    for (const n of envNames(`${HOME}/.config/${d}/.env`)) add(n, `~/.config/${d}/.env`, true);
    for (const f of ls(`${HOME}/.config/${d}`)) {
      if (/^(api[-_]?key|token|credentials?|apikeys)(\.txt|\.json)?$/i.test(f)) { const n = `${d.toUpperCase().replace(/\W/g, "_")} (file)`; names.set(n, false); if (!out.has(n)) out.set(n, { name: n, where: `~/.config/${d}/${f}` }); }
    }
  }
  // Project .env files: names that look like keys, with the projects that have them.
  const proj = new Map<string, string[]>();
  let files = 0;
  for (const root of PROJECT_ROOTS) {
    for (const p of ls(`${HOME}/${root}`)) {
      if (p.startsWith(".") || files > 600) continue;
      for (const f of [".env", ".env.local"]) {
        const path = `${HOME}/${root}/${p}/${f}`;
        if (!existsSync(path)) continue;
        files++;
        for (const n of envNames(path)) { if (!names.has(n)) names.set(n, true); if (KEY_STRICT.test(n)) proj.set(n, [...new Set([...(proj.get(n) ?? []), p])]); }
      }
    }
  }
  for (const [n, ps] of proj) if (!out.has(n)) out.set(n, { name: n, where: `${ps.length} project${ps.length > 1 ? "s" : ""}: ${ps.slice(0, 3).join(", ")}${ps.length > 3 ? "…" : ""}`, projects: ps });
  return { keys: [...out.values()], names };
}

// ── services: one card per thing you can use, however it's reached ─────────
type Probe = { note?: string; via?: string[]; running?: boolean; signed?: boolean };
type Svc = {
  name: string; cat: Cat; what: string; use: string; color?: string;
  bins?: string[]; npx?: string[]; apps?: string[]; paths?: string[];
  login?: string[]; loginJson?: [string, (j: any) => boolean];
  env?: RegExp; mcp?: RegExp;
  mac?: boolean; // macOS only: skipped elsewhere
  local?: boolean; // works without an account, so installed means ready
  quiet?: boolean; // niche or personal: never listed under "Not set up"
  nover?: boolean; // don't run `--version` (slow, or a script that might do something)
  probe?: (x: ProbeCtx) => Promise<Probe | undefined>;
};
type ProbeCtx = { bin: (b: string) => string | undefined; tailscale: () => Promise<any> };

const PG = async (x: ProbeCtx): Promise<Probe | undefined> => {
  const psql = x.bin("psql");
  if (!psql) return;
  const { out, code } = await run([psql, "-w", "-X", "-l", "-t", "-A", "-d", "postgres"]);
  if (code !== 0) return { running: false, note: "no local server answering" };
  const dbs = out.split("\n").map((l) => l.split("|")[0].trim()).filter((d) => d && !/^(template\d|postgres)$/.test(d) && !d.includes("="));
  return { running: true, note: `running locally · ${dbs.length} database${dbs.length === 1 ? "" : "s"}`, via: dbs.slice(0, 10).map((d) => `db ${d}`) };
};
const OBSIDIAN = async (): Promise<Probe | undefined> => {
  const j = readJson(`${HOME}/${MAC ? "Library/Application Support/obsidian" : ".config/obsidian"}/obsidian.json`);
  const vaults = Object.values<any>(j?.vaults ?? {}).map((v) => String(v?.path ?? "").split("/").pop()).filter(Boolean);
  return vaults.length ? { note: `${vaults.length} vault${vaults.length > 1 ? "s" : ""}`, via: vaults.slice(0, 6).map((v) => `vault ${v}`) } : undefined;
};
const APPLE = (app: string, what: string, use: string, cat: Cat, color: string): Svc => ({ name: app.replace(/\.app$/, ""), cat, what, use, color, apps: [`/System/Applications/${app}`], mac: true, local: true, quiet: true });

export const SERVICES: Svc[] = [
  // Code & Git
  { name: "GitHub", cat: "code", color: "#24292f", what: "Repos, PRs, issues, Actions", bins: ["gh"], login: [".config/gh/hosts.yml"], env: /^(GH|GITHUB)_/, mcp: /github/i, use: "Use `gh`: `gh pr create`, `gh pr view --comments`, `gh run watch`, `gh issue list`. Prefer it over the web UI." },
  { name: "npm", cat: "code", color: "#cb3837", what: "Publish packages", bins: ["npm"], loginJson: [".npmrc", () => /_authToken/.test(readText(`${HOME}/.npmrc`))], use: "`npm publish` is signed in; ask before publishing." },
  { name: "Linear", cat: "code", color: "#5e6ad2", what: "Issues", env: /^LINEAR_/, mcp: /linear/i, use: "Use the Linear connector tools." },
  { name: "GitLab", cat: "code", color: "#fc6d26", what: "Repos, merge requests, pipelines", bins: ["glab"], login: [".config/glab-cli/config.yml"], env: /^GITLAB_/, mcp: /gitlab/i, quiet: true, use: "`glab mr list`, `glab ci view`, or the gitlab MCP tools." },
  { name: "Atlassian (Jira, Rovo Dev)", cat: "code", color: "#0052cc", what: "Jira issues and Atlassian's Rovo Dev agent", bins: ["acli"], paths: [".config/atlassian-cli/jira_config.yaml"], nover: true, use: "`acli jira workitem search` / `acli jira workitem create`; `acli rovodev run` for Atlassian's agent." },
  { name: "VS Code", cat: "code", color: "#007acc", what: "Editor", bins: ["code"], apps: ["Visual Studio Code.app"], local: true, nover: true, use: "`code <path>` opens a folder or file for the user to look at." },
  { name: "Cursor", cat: "code", color: "#1b1b1b", what: "AI editor", apps: ["Cursor.app"], paths: [".cursor/mcp.json"], local: true, quiet: true, use: "Cursor editor; its CLI agent is `cursor-agent`." },
  { name: "Zed", cat: "code", color: "#0751cf", what: "Editor", bins: ["zed"], apps: ["Zed.app"], paths: [".config/zed/settings.json"], local: true, quiet: true, nover: true, use: "`zed <path>` opens a folder." },
  { name: "Windsurf", cat: "code", color: "#09b6a2", what: "AI editor (Codeium)", apps: ["Windsurf.app"], paths: [".windsurf", ".codeium/windsurf"], local: true, quiet: true, use: "Windsurf editor; MCP config in ~/.codeium/windsurf." },
  { name: "GitHub Copilot", cat: "ai", color: "#6e40c9", what: "Copilot in editors and the CLI", bins: ["copilot"], paths: [".config/github-copilot", ".copilot"], quiet: true, nover: true, use: "Copilot runs inside editors; `copilot` CLI if installed." },
  { name: "Lighthouse", cat: "code", color: "#f44b21", what: "Performance, accessibility and SEO audits", npx: ["lighthouse"], local: true, quiet: true, use: "`npx lighthouse <url> --output=json --quiet --chrome-flags=--headless` for audits." },
  { name: "Repomix", cat: "code", color: "#f97316", what: "Pack a repo into one file for an LLM", bins: ["repomix"], local: true, quiet: true, use: "`repomix` in a repo writes repomix-output.xml for pasting into a model." },
  { name: "Android SDK", cat: "code", color: "#3ddc84", what: "Build and install Android apps; talk to your phone", bins: ["adb", "sdkmanager"], paths: ["Library/Android/sdk", "Android/Sdk"], local: true, quiet: true, nover: true, use: "`adb devices`, `adb install app.apk`; ask before touching a connected phone." },
  // Cloud & deploy
  { name: "Vercel", cat: "cloud", color: "#000000", what: "Deploys, domains, env vars", bins: ["vercel"], npx: ["vercel"], login: [MAC ? "Library/Application Support/com.vercel.cli/auth.json" : ".local/share/com.vercel.cli/auth.json"], env: /^VERCEL_/, mcp: /vercel/i, use: "`vercel` for preview deploys, `vercel --prod` for production, `vercel env pull` for env vars, `vercel logs <url>` to debug." },
  { name: "Netlify", cat: "cloud", color: "#00ad9f", what: "Deploys, forms, functions", bins: ["netlify", "ntl"], npx: ["netlify-cli"], loginJson: [MAC ? "Library/Preferences/netlify/config.json" : ".config/netlify/config.json", (j) => Object.keys(j?.users ?? {}).length > 0], env: /^NETLIFY_/, mcp: /netlify/i, use: "`npx netlify-cli deploy` (add `--prod` for production); `npx netlify-cli status` shows the account and linked site." },
  { name: "Cloudflare", cat: "cloud", color: "#f38020", what: "Workers, Pages, DNS, R2, D1, tunnels", bins: ["wrangler", "cloudflared"], npx: ["wrangler"], login: [MAC ? "Library/Preferences/.wrangler/config/default.toml" : ".config/.wrangler/config/default.toml", ".wrangler/config/default.toml", ".cloudflared/cert.pem"], env: /^(CLOUDFLARE|CF)_/, mcp: /cloudflare/i, use: "`npx wrangler deploy` for Workers/Pages, `npx wrangler d1|r2|kv` for storage (`npx wrangler login` if it asks). `cloudflared tunnel --url http://localhost:<port>` exposes a local port publicly — only when asked." },
  { name: "Firebase", cat: "cloud", color: "#ffca28", what: "Hosting, auth, Firestore", bins: ["firebase"], npx: ["firebase-tools"], loginJson: [".config/configstore/firebase-tools.json", (j) => !!(j?.tokens || j?.user)], env: /^FIREBASE_/, use: "`firebase deploy --only hosting`, `firebase emulators:start` for local testing." },
  { name: "Fly.io", cat: "cloud", color: "#7b3fe4", what: "App hosting", bins: ["flyctl", "fly"], login: [".fly/config.yml"], env: /^FLY_/, use: "`fly deploy`, `fly logs`, `fly secrets set`." },
  { name: "Railway", cat: "cloud", color: "#0b0d0e", what: "App hosting", bins: ["railway"], npx: ["@railway/cli"], login: [".railway/config.json"], env: /^RAILWAY_/, use: "`railway up` to deploy, `railway logs`." },
  { name: "Render", cat: "cloud", color: "#46e3b7", what: "App hosting", bins: ["render"], env: /^RENDER_/, quiet: true, use: "`render` CLI or the Render API with RENDER_API_KEY." },
  { name: "Heroku", cat: "cloud", color: "#430098", what: "App hosting", bins: ["heroku"], env: /^HEROKU_/, use: "`heroku` CLI: `git push heroku main`, `heroku logs --tail`." },
  { name: "DigitalOcean", cat: "cloud", color: "#0080ff", what: "Droplets, apps, Spaces", bins: ["doctl"], env: /^(DIGITALOCEAN|DO_)/, quiet: true, use: "`doctl` with the default context." },
  { name: "AWS", cat: "cloud", color: "#ff9900", what: "Cloud", bins: ["aws"], login: [".aws/credentials", ".aws/config"], env: /^AWS_/, mcp: /aws/i, use: "`aws` CLI with the default profile; say which profile/region before changing anything." },
  { name: "Google Cloud", cat: "cloud", color: "#4285f4", what: "Cloud, Vertex AI, Cloud Run, Cloud SQL", bins: ["gcloud", "cloud-sql-proxy"], login: [".config/gcloud/credentials.db", ".config/gcloud/active_config"], env: /^(GCP|GOOGLE_CLOUD|GCLOUD)_/, nover: true, use: "`gcloud` CLI; check `gcloud config list` for the active project first. `cloud-sql-proxy` reaches Cloud SQL." },
  { name: "Azure", cat: "cloud", color: "#0078d4", what: "Cloud", bins: ["az"], loginJson: [".azure/azureProfile.json", (j) => (j?.subscriptions ?? []).length > 0], env: /^AZURE_/, nover: true, use: "`az` CLI; `az account show` for the active subscription." },
  { name: "Docker", cat: "cloud", color: "#2496ed", what: "Containers", bins: ["docker"], apps: ["Docker.app"], local: true, use: "`docker compose up -d` for local services; Docker Desktop must be running.",
    probe: async (x) => { const d = x.bin("docker"); if (!d) return; const { out, code } = await run([d, "ps", "--format", "{{.Names}}"], 3000); if (code !== 0) return { running: false, note: "installed; Docker isn't running" }; const n = out.split("\n").filter(Boolean); return { running: true, note: `running · ${n.length} container${n.length === 1 ? "" : "s"}`, via: n.slice(0, 6).map((c) => `container ${c}`) }; } },
  { name: "Kubernetes", cat: "cloud", color: "#326ce5", what: "Clusters", bins: ["kubectl"], login: [".kube/config"], use: "`kubectl` with the current context (`kubectl config current-context`); read-only unless asked." },
  { name: "Auth0", cat: "cloud", color: "#eb5424", what: "Auth tenants, apps and users", bins: ["auth0"], login: [".config/auth0/config.json"], env: /^AUTH0_/, nover: true, use: "`auth0 apps list`, `auth0 logs tail`; ask before changing a tenant." },
  { name: "rclone", cat: "cloud", color: "#3f79ad", what: "Sync files to Dropbox, Google Drive, S3 and 70 more", bins: ["rclone"], use: "`rclone lsd <remote>:`, `rclone sync <src> <remote>:<path> --dry-run` first; never delete on a remote without asking.",
    probe: async (x) => { const r = x.bin("rclone"); if (!r) return; const { out } = await run([r, "listremotes"]); const rem = out.split("\n").map((l) => l.trim().replace(/:$/, "")).filter(Boolean); return { signed: rem.length > 0, note: rem.length ? `${rem.length} remote${rem.length > 1 ? "s" : ""}` : "no remotes set up", via: rem.map((n) => `remote ${n}:`) }; } },
  { name: "S3 storage", cat: "cloud", color: "#569a31", what: "S3-compatible object storage", env: /^(S3_|R2_|MINIO_)/, quiet: true, use: "S3 API with the credentials in the project's env; list before you write, never delete without asking." },
  { name: "Portainer", cat: "cloud", color: "#13bef9", what: "Manage Docker hosts and stacks", env: /^PORTAINER/, quiet: true, use: "Portainer API; read-only unless asked." },
  { name: "Graylog", cat: "data", color: "#ff3633", what: "Log search", env: /^GRAYLOG/, quiet: true, use: "Graylog API for log searches." },
  { name: "Google Maps Platform", cat: "cloud", color: "#34a853", what: "Maps, geocoding, places", env: /(MAPS_API_KEY|MAPS_SERVER_KEY|GEOCODING_API_KEY)$/, quiet: true, use: "Google Maps / geocoding APIs with the key from the project's .env." },
  // Data & databases
  { name: "Supabase", cat: "data", color: "#3ecf8e", what: "Postgres, auth, storage, edge functions", bins: ["supabase"], npx: ["supabase", "@supabase/mcp-server-supabase"], login: [".supabase/access-token"], env: /SUPABASE_/, mcp: /supabase/i, use: "`npx supabase` for migrations (`db push`, `migration new`) and `gen types`. Never print keys." },
  { name: "Postgres", cat: "data", color: "#336791", what: "Database shell and local server", bins: ["psql"], env: /^(DATABASE_URL|PG|POSTGRES_URL)|_DATABASE_URL$/, local: true, probe: PG, use: "`psql $DATABASE_URL` or `psql -d <db>` for the local server; read-only queries unless asked." },
  { name: "Redis", cat: "data", color: "#dc382d", what: "Cache / queues", bins: ["redis-cli"], env: /^REDIS_URL$/, local: true, use: "`redis-cli` against a local Redis.",
    probe: async (x) => { const r = x.bin("redis-cli"); if (!r) return; const { out } = await run([r, "ping"], 2000); return /PONG/.test(out) ? { running: true, note: "running locally" } : { running: false, note: "not running" }; } },
  { name: "SQLite", cat: "data", color: "#0f80cc", what: "File databases", bins: ["sqlite3"], local: true, use: "`sqlite3 file.db '.tables'`; copy the file before writing to it." },
  { name: "Neon", cat: "data", color: "#00e599", what: "Serverless Postgres with branches", bins: ["neonctl", "neon"], npx: ["neonctl", "neon"], login: [".config/neon/credentials.json"], env: /^NEON_/, use: "`npx neonctl branches list`, `npx neonctl connection-string <branch>`; branch before migrating." },
  { name: "Upstash", cat: "data", color: "#00e9a3", what: "Serverless Redis and queues", env: /^(UPSTASH_|KV_REST_API)/, quiet: true, use: "Upstash REST API with the URL/token from the project's .env." },
  { name: "MongoDB", cat: "data", color: "#47a248", what: "Document database", bins: ["mongosh"], env: /^MONGO/, quiet: true, use: "`mongosh $MONGODB_URI`; read-only unless asked." },
  // Communication
  { name: "Gmail", cat: "comms", color: "#ea4335", what: "Read and send email", mcp: /gmail/i, use: "Use the Gmail connector tools; draft first, send only when asked." },
  { name: "Google Calendar", cat: "comms", color: "#1a73e8", what: "Calendar", mcp: /calendar/i, use: "Use the Google Calendar connector tools." },
  { name: "Microsoft 365", cat: "comms", color: "#0078d4", what: "Outlook mail, calendar, Teams, OneDrive", env: /^(MICROSOFT|MS_GRAPH|AZURE_AD)_/, mcp: /microsoft|outlook|m365/i, quiet: true, use: "Use the Microsoft 365 MCP tools; draft first, send only when asked." },
  { name: "Google Chat", cat: "comms", color: "#00ac47", what: "Spaces and messages", mcp: /google-chat|gchat/i, quiet: true, use: "Use the Google Chat MCP tools; post only when asked." },
  { name: "WhatsApp", cat: "comms", color: "#25d366", what: "WhatsApp Business messages", env: /^WHATSAPP_/, quiet: true, use: "WhatsApp Business API from the project's env; never message anyone without asking." },
  { name: "Telegram", cat: "comms", color: "#26a5e4", what: "Bots and messages", env: /^TELEGRAM_/, mcp: /telegram/i, use: "Bot API with the TELEGRAM token in the environment." },
  { name: "Resend", cat: "comms", color: "#000000", what: "Transactional email", env: /^RESEND_/, use: "Resend API with RESEND_API_KEY." },
  { name: "Slack", cat: "comms", color: "#4a154b", what: "Workspace messages and bots", env: /^SLACK_/, mcp: /slack/i, use: "Slack Web API with the bot token; post only when asked." },
  { name: "Discord", cat: "comms", color: "#5865f2", what: "Bots and servers", env: /^DISCORD_/, mcp: /discord/i, quiet: true, use: "Discord bot token from the project's .env; post only when asked." },
  { name: "Twilio", cat: "comms", color: "#f22f46", what: "SMS, WhatsApp and voice", env: /^TWILIO_/, quiet: true, use: "Twilio API; every message costs money, so ask first." },
  { name: "X (Twitter)", cat: "comms", color: "#000000", what: "Post and read on X", env: /^(TWITTER|X_API)_/, quiet: true, use: "X API credentials in an env file; draft posts, publish only when asked." },
  { name: "iMessage (BlueBubbles)", cat: "comms", color: "#34c759", what: "Send and read iMessages through a BlueBubbles server", env: /BLUEBUBBLES/, quiet: true, use: "BlueBubbles server URL from the project's .env; never message anyone without asking." },
  { name: "Zoom", cat: "comms", color: "#0b5cff", what: "Meetings", apps: ["zoom.us.app"], quiet: true, local: true, use: "The user's meeting app; nothing for agents to run." },
  APPLE("Mail.app", "Apple Mail: every account set up on this Mac", "AppleScript via `osascript`: read mailboxes, draft messages; send only when asked.", "comms", "#1a8cff"),
  APPLE("Messages.app", "iMessage and SMS", "AppleScript: `tell application \"Messages\" to send …` — only when the user asks, to people they name.", "comms", "#34c759"),
  APPLE("Calendar.app", "Calendars on this Mac (iCloud, Google, Exchange)", "AppleScript or `icalBuddy`-style reads via `osascript`; ask before adding events.", "comms", "#ff3b30"),
  APPLE("Reminders.app", "Reminders and lists", "AppleScript: `tell application \"Reminders\" to make new reminder …`.", "comms", "#ff9500"),
  APPLE("Contacts.app", "Address book", "AppleScript reads; never export contacts anywhere.", "comms", "#8e8e93"),
  // Media & creative
  { name: "Adobe", cat: "media", color: "#fa0f00", what: "Images, PDFs, Express designs, Firefly", mcp: /adobe/i, use: "Use the Adobe connector tools for image edits, PDFs and designs." },
  { name: "Canva", cat: "media", color: "#00c4cc", what: "Designs", mcp: /canva/i, use: "Use the Canva connector tools." },
  { name: "Figma", cat: "media", color: "#a259ff", what: "Designs", apps: ["Figma.app"], env: /^FIGMA_/, mcp: /figma/i, use: "Use the Figma MCP tools to read designs." },
  { name: "Blender", cat: "media", color: "#e87d0d", what: "3D, rendering", bins: ["blender"], apps: ["Blender.app"], local: true, use: `Headless: \`${MAC ? "/Applications/Blender.app/Contents/MacOS/Blender" : "blender"} -b file.blend -P script.py\`.` },
  { name: "Godot", cat: "media", color: "#478cbf", what: "Game engine", bins: ["godot"], apps: ["Godot.app"], local: true, use: "Godot editor/CLI for game projects: `godot --headless --export-release`." },
  { name: "ffmpeg", cat: "media", color: "#007808", what: "Audio and video processing", bins: ["ffmpeg"], local: true, use: "`ffmpeg` for cuts, transcodes, frames." },
  { name: "yt-dlp", cat: "media", color: "#ff0000", what: "Download video/audio", bins: ["yt-dlp"], local: true, use: "`yt-dlp` to fetch media for processing." },
  { name: "HyperFrames", cat: "media", color: "#ff4f00", what: "HTML video compositions rendered to MP4", npx: ["hyperframes"], paths: [".hyperframes/config.json"], local: true, quiet: true, use: "`npx hyperframes` (init, preview, render); load the hyperframes skill first." },
  { name: "ElevenLabs", cat: "media", color: "#000000", what: "Voice, speech and sound effects", bins: ["elevenlabs"], env: /ELEVEN/, mcp: /eleven/i, nover: true, use: "Text-to-speech via the ElevenLabs API key in the environment (or the `elevenlabs` CLI). Costs credits: say how many first." },
  { name: "Higgsfield", cat: "media", color: "#c6ff00", what: "AI video and image generation", login: [".config/higgsfield/credentials.json"], paths: [".config/higgsfield"], env: /^HIGGSFIELD/, quiet: true, use: "Higgsfield CLI/API with the saved credentials; plan credits and API balance are separate. Say the credit cost before generating." },
  { name: "InVideo", cat: "media", color: "#5b3df5", what: "AI video editing", mcp: /invideo/i, quiet: true, use: "Use the InVideo connector tools." },
  { name: "fal", cat: "media", color: "#7c3aed", what: "Image and video generation", env: /^FAL_/, use: "fal.ai API with FAL_KEY." },
  { name: "Replicate", cat: "ai", color: "#000000", what: "Hosted open models", env: /^REPLICATE_/, use: "Replicate API with REPLICATE_API_TOKEN." },
  { name: "HeyGen", cat: "media", color: "#7559ff", what: "Avatar video", env: /^HEYGEN_/, quiet: true, use: "HeyGen API; videos cost credits, ask first." },
  { name: "Runway", cat: "media", color: "#000000", what: "Video generation", env: /^RUNWAY/, quiet: true, use: "Runway API; ask before spending credits." },
  { name: "Cloudinary", cat: "media", color: "#3448c5", what: "Image and video hosting and transforms", env: /^CLOUDINARY_/, quiet: true, use: "Cloudinary API with the project's credentials." },
  { name: "Tesseract OCR", cat: "media", color: "#5e5e5e", what: "Text from images", bins: ["tesseract"], local: true, quiet: true, use: "`tesseract image.png - -l eng+heb` prints the text." },
  { name: "ImageMagick", cat: "media", color: "#1e3a8a", what: "Image conversion", bins: ["magick"], local: true, quiet: true, use: "`magick in.png -resize 50% out.webp`." },
  APPLE("Photos.app", "Photo library", "AppleScript can export selected photos; ask before reading the library.", "media", "#ff9500"),
  APPLE("Music.app", "Music library and playback", "AppleScript: play, pause, current track.", "media", "#fa243c"),
  // Knowledge & notes
  { name: "Obsidian", cat: "knowledge", color: "#7c3aed", what: "Markdown vaults", apps: ["Obsidian.app"], bins: ["obsidian"], local: true, nover: true, probe: OBSIDIAN, use: "Vaults are plain markdown folders; edit the files directly and keep [[wikilinks]] intact." },
  { name: "LLM Wiki", cat: "knowledge", color: "#0f766e", what: "Your compiled, cross-linked knowledge base at ~/wiki", paths: ["wiki/index.md"], local: true, quiet: true, use: "Read ~/wiki/index.md first, then the project page. Follow ~/wiki/CLAUDE.md for ingest/query/lint; only edit it when doing wiki work.",
    probe: async () => { let n = 0; for (const d of ["projects", "concepts", "entities", "synthesis", "sources"]) n += ls(`${HOME}/wiki/${d}`).filter((f) => f.endsWith(".md")).length; return { note: `${n} pages` }; } },
  { name: "Notion", cat: "knowledge", color: "#000000", what: "Docs and databases", npx: ["@notionhq/notion-mcp-server"], env: /^NOTION_/, mcp: /notion/i, use: "Use the Notion connector tools." },
  { name: "Google Drive", cat: "knowledge", color: "#1fa463", what: "Docs and files", mcp: /drive/i, use: "Use the Google Drive connector tools." },
  { name: "Claude Docs", cat: "knowledge", color: "#d97757", what: "Living documents on claude.ai", mcp: /claude docs/i, quiet: true, use: "Use the Claude Docs connector to create and edit shared docs." },
  { name: "agentmemory", cat: "knowledge", color: "#8b5cf6", what: "Memory shared across agent sessions", bins: ["agentmemory"], mcp: /agentmemory/i, quiet: true, nover: true, use: "agentmemory MCP tools: recall past sessions, remember decisions." },
  { name: "YouTube RAG (yt-transcriber)", cat: "knowledge", color: "#ff0033", what: "Channel transcripts in a local Chroma corpus you can query", paths: ["Documents/Projects/yt-transcriber", ".yt-transcriber"], local: true, quiet: true, use: "Drive it through the yt-transcriber skill (dashboard on :8088); channel corpora live in rag_store/chroma." },
  { name: "Pandoc", cat: "knowledge", color: "#4a6fa5", what: "Convert between Markdown, DOCX, PDF, HTML", bins: ["pandoc"], local: true, use: "`pandoc in.md -o out.docx` (or .pdf, .html)." },
  { name: "nano-pdf", cat: "knowledge", color: "#b91c1c", what: "Edit PDFs with natural language", bins: ["nano-pdf"], local: true, quiet: true, nover: true, use: "`nano-pdf edit file.pdf <page> \"instruction\"`." },
  APPLE("Notes.app", "Apple Notes", "AppleScript: list folders, read and create notes; ask before editing existing ones.", "knowledge", "#ffcc00"),
  // Commerce & payments
  { name: "Stripe", cat: "commerce", color: "#635bff", what: "Payments, webhooks", bins: ["stripe"], login: [".config/stripe/config.toml"], env: /^STRIPE_/, mcp: /stripe/i, use: "`stripe listen --forward-to localhost:<port>/webhook` to test webhooks; use test-mode keys only." },
  { name: "Gumroad", cat: "commerce", color: "#ff90e8", what: "Products, sales, offer codes", npx: ["gumroad-mcp"], env: /^GUMROAD_/, mcp: /gumroad/i, use: "Use the gumroad MCP tools for products, sales and offer codes." },
  { name: "Shopify", cat: "commerce", color: "#95bf47", what: "Storefront, products, orders", env: /^SHOPIFY_/, quiet: true, use: "Shopify Admin API with the project's access token; read-only unless asked." },
  { name: "Lemon Squeezy", cat: "commerce", color: "#ffc233", what: "Digital products and subscriptions", env: /^LEMON/, quiet: true, use: "Lemon Squeezy API." },
  { name: "PayPal", cat: "commerce", color: "#003087", what: "Payments", env: /^PAYPAL_/, quiet: true, use: "PayPal API; sandbox first." },
  { name: "TON", cat: "commerce", color: "#0098ea", what: "TON blockchain (Toncenter API)", env: /^TONCENTER_/, quiet: true, use: "Toncenter API; read-only, never move funds." },
  // Automation
  { name: "Shortcuts", cat: "automation", color: "#e53e8a", what: "Run and list your Shortcuts from the command line", bins: ["shortcuts"], mac: true, local: true, nover: true, use: "`shortcuts list`, `shortcuts run \"Name\" --input-path file`; ask before running one that sends or buys anything.",
    probe: async (x) => { const s = x.bin("shortcuts"); if (!s) return; const { out, code } = await run([s, "list"], 4000); if (code !== 0) return; const l = out.split("\n").filter(Boolean); return { note: `${l.length} shortcut${l.length === 1 ? "" : "s"}` }; } },
  { name: "AppleScript", cat: "automation", color: "#6e6e73", what: "Script any Mac app (Mail, Messages, Calendar, Finder…)", bins: ["osascript"], mac: true, local: true, nover: true, use: "`osascript -e '…'`; the first run of an app may show a permission prompt the user has to accept." },
  { name: "cliclick", cat: "automation", color: "#6e6e73", what: "Click and type on the Mac screen", bins: ["cliclick"], mac: true, local: true, quiet: true, nover: true, use: "`cliclick c:x,y` clicks; only when asked and when no API exists." },
  { name: "n8n", cat: "automation", color: "#ea4b71", what: "Workflow automation", npx: ["n8n-mcp", "n8n"], paths: [".n8n-mcp", ".n8n"], env: /^N8N_/, mcp: /n8n/i, quiet: true, use: "n8n workflows via its API or the n8n MCP; ask before activating a workflow." },
  { name: "Raycast", cat: "automation", color: "#ff6363", what: "Launcher, scripts and extensions", apps: ["Raycast.app"], mac: true, quiet: true, local: true, use: "Raycast script commands live in a folder the user chose." },
  { name: "Alfred", cat: "automation", color: "#5c1f87", what: "Launcher and workflows", apps: ["Alfred 5.app", "Alfred 4.app"], mac: true, quiet: true, local: true, use: "Alfred workflows run from the app." },
  { name: "Keyboard Maestro", cat: "automation", color: "#6b4c9a", what: "Macros", apps: ["Keyboard Maestro.app"], mac: true, quiet: true, local: true, use: "Trigger macros via `osascript`." },
  { name: "tmux-cli", cat: "automation", color: "#1bb91f", what: "Drive CLI apps in tmux panes (debuggers, REPLs, other agents)", bins: ["tmux-cli"], local: true, quiet: true, nover: true, use: "`tmux-cli launch zsh`, then `tmux-cli send` / `tmux-cli capture`." },
  // Search & OSINT
  { name: "last30days", cat: "research", color: "#f59e0b", what: "What people said in the last 30 days: Reddit, X, YouTube, HN, GitHub", paths: [".config/last30days", ".local/share/last30days"], local: true, quiet: true, use: "Load the last30days skill; run its doctor first if a source looks empty." },
  { name: "Brave Search", cat: "research", color: "#fb542b", what: "Web search API", npx: ["@modelcontextprotocol/server-brave-search"], env: /^BRAVE(_SEARCH)?_API_KEY$/, mcp: /brave/i, quiet: true, use: "Brave Search API with the key from the env file." },
  { name: "Serper", cat: "research", color: "#4f46e5", what: "Google search results API", env: /^SERPER_/, quiet: true, use: "Serper API for Google results." },
  { name: "Perplexity", cat: "research", color: "#20808d", what: "Answer engine API", env: /^(PERPLEXITY|PPLX)_/, quiet: true, use: "Perplexity API (OpenAI-compatible)." },
  { name: "Tavily", cat: "research", color: "#2563eb", what: "Search API for agents", env: /^TAVILY_/, quiet: true, use: "Tavily search API." },
  { name: "Firecrawl", cat: "research", color: "#ff6b00", what: "Crawl sites to markdown", env: /^FIRECRAWL_/, quiet: true, use: "Firecrawl API." },
  { name: "Apify", cat: "research", color: "#97d700", what: "Scrapers and actors", env: /^APIFY_/, quiet: true, use: "Apify API; runs cost money." },
  { name: "Crawl4AI", cat: "research", color: "#0ea5e9", what: "Local crawler that turns pages into LLM-ready markdown", bins: ["crwl"], paths: [".crawl4ai"], local: true, quiet: true, nover: true, use: "`crwl <url> -o markdown`; respect robots and rate limits." },
  { name: "YouTube Data API", cat: "research", color: "#ff0000", what: "Channel, video and comment data", env: /^YOUTUBE_API_KEY$/, quiet: true, use: "YouTube Data API v3 with YOUTUBE_API_KEY; mind the daily quota." },
  { name: "Hunter", cat: "research", color: "#fa5320", what: "Find and verify work emails", env: /^HUNTER_/, quiet: true, use: "Hunter API; B2B lookups only, never private individuals." },
  { name: "Apollo", cat: "research", color: "#1a1a1a", what: "B2B contact and company data", env: /^APOLLO_/, quiet: true, use: "Apollo API; B2B prospecting only." },
  { name: "Maigret", cat: "research", color: "#334155", what: "Username search across sites (OSINT)", bins: ["maigret"], local: true, quiet: true, nover: true, use: "`maigret <username>` — only for the user's own handles or with clear consent." },
  { name: "Holehe", cat: "research", color: "#334155", what: "Which sites an email is registered on (OSINT)", bins: ["holehe"], local: true, quiet: true, nover: true, use: "`holehe <email>` — the user's own addresses only." },
  { name: "GHunt", cat: "research", color: "#334155", what: "Google account OSINT", bins: ["ghunt"], quiet: true, nover: true, use: "`ghunt email <address>` — the user's own accounts only." },
  { name: "SpiderFoot", cat: "research", color: "#334155", what: "Automated OSINT scans", bins: ["spiderfoot", "sf"], paths: [".spiderfoot"], quiet: true, nover: true, use: "SpiderFoot scans; defensive self-audits only." },
  { name: "Facebook group archive", cat: "research", color: "#1877f2", what: "Archived Facebook group posts you can search (fb-scraper)", bins: ["fb-scraper"], mcp: /fb-group/i, quiet: true, nover: true, use: "fb-group MCP tools: search_posts, semantic_search, top_authors." },
  // Devices & network
  { name: "Tailscale", cat: "devices", color: "#242424", what: "Private network; share dev servers to your phone", bins: ["tailscale"], apps: ["Tailscale.app"], use: "`tailscale serve --bg --https=<port> http://localhost:<port>` shares a dev server on the tailnet. Never `tailscale funnel`.",
    probe: async (x) => { const j = await x.tailscale(); if (!j) return; const peers = Object.values<any>(j.Peer ?? {}); return { signed: j.BackendState === "Running", running: j.BackendState === "Running", note: `${peers.length + 1} devices · ${peers.filter((p) => p.Online).length + 1} online` }; } },
  { name: "ngrok", cat: "devices", color: "#1f1e37", what: "Public tunnels", bins: ["ngrok"], login: [MAC ? "Library/Application Support/ngrok/ngrok.yml" : ".config/ngrok/ngrok.yml"], env: /^NGROK_/, use: "`ngrok http <port>` gives a public URL — only when asked for a public link." },
  { name: "Twingate", cat: "devices", color: "#2c2c2c", what: "Zero-trust network access", apps: ["Twingate.app"], use: "Remote network access; nothing for agents to run." },
  { name: "AnyDesk", cat: "devices", color: "#ef443b", what: "Remote desktop", apps: ["AnyDesk.app"], quiet: true, local: true, use: "Remote desktop for the user; nothing for agents to run." },
  { name: "Chrome Remote Desktop", cat: "devices", color: "#4285f4", what: "Reach this Mac's screen from anywhere", apps: ["Chrome Remote Desktop Host Uninstaller.app"], quiet: true, local: true, use: "Remote desktop for the user; nothing for agents to run." },
  { name: "mosh", cat: "devices", color: "#4b5563", what: "SSH that survives flaky networks", bins: ["mosh"], local: true, quiet: true, nover: true, use: "`mosh <host>` for interactive sessions; agents use plain `ssh`." },
  // AI
  { name: "Ollama", cat: "ai", color: "#111111", what: "Local models", bins: ["ollama"], apps: ["Ollama.app"], local: true, use: "`ollama run <model>` or the API at http://localhost:11434 for private/offline LLM work." },
  { name: "LM Studio", cat: "ai", color: "#4338ca", what: "Local models with an OpenAI-compatible server", bins: ["lms"], apps: ["LM Studio.app"], paths: [".lmstudio"], local: true, quiet: true, nover: true, use: "`lms server start`, then http://localhost:1234/v1." },
  { name: "Jev", cat: "ai", color: "#0ea5e9", what: "Calibrated yes/no and pick-one decisions (TypeSafe)", bins: ["jev"], env: /^TYPESAFE/, nover: true, use: "`jev ask` / `jev select` for bounded judgments; record outcomes with `jev outcome`." },
  { name: "OpenRouter", cat: "ai", color: "#6467f2", what: "Hundreds of models behind one API", env: /^OPENROUTER_/, use: "OpenAI-compatible API at https://openrouter.ai/api/v1 with OPENROUTER_API_KEY." },
  { name: "OpenAI API", cat: "ai", color: "#10a37f", what: "GPT, images, embeddings, speech", env: /^OPENAI_/, use: "Use OPENAI_API_KEY from the environment; never print it." },
  { name: "Anthropic API", cat: "ai", color: "#d97757", what: "Claude models via API", env: /^ANTHROPIC_/, use: "Use ANTHROPIC_API_KEY from the environment." },
  { name: "Google AI", cat: "ai", color: "#4285f4", what: "Gemini API", env: /^(GEMINI|GOOGLE_API|GOOGLE_GENERATIVE)/, use: "Use GEMINI_API_KEY / GOOGLE_API_KEY from the environment." },
  { name: "DeepSeek", cat: "ai", color: "#4d6bfe", what: "DeepSeek models", env: /^DEEPSEEK_/, quiet: true, use: "OpenAI-compatible API at https://api.deepseek.com with DEEPSEEK_API_KEY." },
  { name: "NanoGPT", cat: "ai", color: "#111827", what: "Pay-per-prompt access to many models", env: /^NANOGPT_/, quiet: true, use: "NanoGPT API (OpenAI-compatible)." },
  { name: "Groq", cat: "ai", color: "#f55036", what: "Very fast inference", env: /^GROQ_/, quiet: true, use: "OpenAI-compatible API at https://api.groq.com/openai/v1." },
  { name: "Mistral", cat: "ai", color: "#fa520f", what: "Mistral models", env: /^MISTRAL_/, quiet: true, use: "Mistral API with MISTRAL_API_KEY." },
  { name: "xAI", cat: "ai", color: "#000000", what: "Grok models", env: /^(XAI|GROK)_/, quiet: true, use: "xAI API with XAI_API_KEY." },
  { name: "Soniox", cat: "ai", color: "#111827", what: "Speech-to-text", env: /^SONIOX/, quiet: true, use: "Soniox API for transcription." },
  { name: "Deepgram", cat: "ai", color: "#13ef93", what: "Speech-to-text", env: /^DEEPGRAM_/, quiet: true, use: "Deepgram API for transcription." },
  { name: "Picovoice", cat: "ai", color: "#377dff", what: "On-device wake word and speech", env: /^PICOVOICE_/, quiet: true, use: "Picovoice SDKs with the access key." },
  { name: "Hugging Face", cat: "ai", color: "#ffd21e", what: "Models, datasets", bins: ["huggingface-cli", "hf"], login: [".cache/huggingface/token"], env: /^(HF|HUGGING)/, use: "`hf` / huggingface-cli for downloads; token in ~/.cache/huggingface." },
  { name: "promptfoo", cat: "ai", color: "#e11d48", what: "Evals and red-teaming for prompts and models", bins: ["promptfoo"], paths: [".promptfoo"], local: true, quiet: true, nover: true, use: "`promptfoo eval -c promptfooconfig.yaml`, `promptfoo view` for results." },
  { name: "Claude app", cat: "ai", color: "#d97757", what: "Claude desktop (chat, connectors, Claude in Chrome)", apps: ["Claude.app"], mac: true, local: true, quiet: true, use: "The user's Claude desktop app." },
  { name: "ChatGPT app", cat: "ai", color: "#10a37f", what: "ChatGPT desktop", apps: ["ChatGPT.app"], mac: true, local: true, quiet: true, use: "The user's ChatGPT desktop app." },
  { name: "Gemini app", cat: "ai", color: "#8e75b2", what: "Gemini desktop", apps: ["Gemini.app"], mac: true, local: true, quiet: true, use: "The user's Gemini desktop app." },
  { name: "Antigravity", cat: "ai", color: "#4285f4", what: "Google's agent IDE", apps: ["Antigravity.app", "Antigravity IDE.app"], paths: [".antigravity"], local: true, quiet: true, use: "Antigravity IDE; its MCP config is in ~/.gemini/antigravity." },
  { name: "Open WebUI", cat: "ai", color: "#000000", what: "Self-hosted chat UI (here: in front of Hermes)", paths: [".local/share/open-webui"], local: true, quiet: true, use: "Open WebUI serves chat on the tailnet; configure models through its admin." },
  { name: "Claude Code Router", cat: "ai", color: "#d97757", what: "Route Claude Code to other models", bins: ["ccr"], paths: [".claude-code-router"], local: true, quiet: true, nover: true, use: "`ccr code` starts Claude Code through the router; models in ~/.claude-code-router/config.json." },
  { name: "OpenClaw", cat: "ai", color: "#ef4444", what: "Personal agent gateway (multi-channel)", bins: ["openclaw", "clawdbot"], paths: [".openclaw"], quiet: true, nover: true, use: "OpenClaw gateway; `openclaw status`." },
  // Browsers
  { name: "Playwright", cat: "browsers", color: "#2ead33", what: "Browser automation", bins: ["playwright"], npx: ["@playwright/mcp", "playwright"], mcp: /playwright/i, use: "Playwright MCP or `npx playwright` for screenshots and UI checks." },
  { name: "Chrome", cat: "browsers", color: "#4285f4", what: "Real browser with your logins", apps: ["Google Chrome.app"], bins: ["google-chrome"], mcp: /chrome/i, local: true, nover: true, use: "Claude in Chrome tools act in your real signed-in Chrome; ask before submitting anything." },
  { name: "Chrome DevTools MCP", cat: "browsers", color: "#1a73e8", what: "Performance traces, network and console from a real Chrome", npx: ["chrome-devtools-mcp"], local: true, quiet: true, use: "`npx chrome-devtools-mcp` as an MCP server for traces and console logs." },
  { name: "browser-use", cat: "browsers", color: "#111827", what: "LLM-driven browser agent", bins: ["browser-use"], local: true, quiet: true, nover: true, use: "`browser-use` runs a browsing agent; prefer Playwright for deterministic checks." },
  { name: "Brave", cat: "browsers", color: "#fb542b", what: "Browser", apps: ["Brave Browser.app"], bins: ["brave-browser"], local: true, quiet: true, nover: true, use: "The user's Brave browser." },
  { name: "Safari", cat: "browsers", color: "#006cff", what: "Browser", apps: ["Safari.app"], mac: true, local: true, quiet: true, use: "Safari; `safaridriver` for WebDriver automation." },
  { name: "Firefox", cat: "browsers", color: "#ff7139", what: "Browser", apps: ["Firefox.app"], bins: ["firefox"], local: true, quiet: true, nover: true, use: "The user's Firefox." },
  { name: "Arc", cat: "browsers", color: "#fc4e5b", what: "Browser", apps: ["Arc.app"], mac: true, local: true, quiet: true, use: "The user's Arc browser." },
  // Keys & secrets
  { name: "1Password", cat: "keys", color: "#0572ec", what: "Secrets", bins: ["op"], use: "`op read op://vault/item/field` — ask before reading any secret." },
];

const CORE = new Set(["Git", "Homebrew", "Bun", "Node", "Deno", "Python", "uv", "pnpm", "Rust", "Go", "tmux", "jq", "ripgrep", "herdr", "WezTerm"]);
const DEV: [string, string, string][] = [
  ["Git", "git", "Version control"], ["Git LFS", "git-lfs", "Large files in git"], ["lazygit", "lazygit", "Git TUI"], ["Homebrew", "brew", "Packages"], ["Bun", "bun", "JS runtime"], ["Node", "node", "JS runtime"], ["Deno", "deno", "JS runtime"],
  ["pnpm", "pnpm", "JS packages"], ["Python", "python3", "Runtime"], ["uv", "uv", "Python packages"], ["pipx", "pipx", "Python apps"], ["Conda", "conda", "Python environments"], ["Rust", "cargo", "Toolchain"], ["wasm-pack", "wasm-pack", "Rust to WebAssembly"], ["Go", "go", "Toolchain"], ["Java", "java", "JDK"],
  ["tmux", "tmux", "Terminal multiplexer"], ["herdr", "herdr", "Agent multiplexer"], ["WezTerm", "wezterm", "Terminal"], ["Neovim", "nvim", "Editor"], ["jq", "jq", "JSON on the command line"], ["ripgrep", "rg", "Fast search"], ["fd", "fd", "Fast find"], ["fzf", "fzf", "Fuzzy finder"], ["bat", "bat", "cat with syntax colors"],
];
const AGENTS: [string, string, string][] = [
  ["Claude Code", "claude", "Anthropic's coding agent"], ["Codex", "codex", "OpenAI's coding agent"], ["OpenCode", "opencode", "Open-source agent, any model"], ["Gemini CLI", "gemini", "Google's coding agent"],
  ["Hermes", "hermes", "Nous Research agent"], ["Cursor agent", "cursor-agent", "Cursor's CLI agent"], ["Aider", "aider", "Pair programmer"], ["Amp", "amp", "Sourcegraph's agent"], ["Goose", "goose", "Block's agent"], ["Copilot CLI", "copilot", "GitHub's CLI agent"], ["Crush", "crush", "Charm's coding agent"],
];

const AGENT_COLOR: Record<string, string> = { claude: "#d97757", codex: "#10a37f", opencode: "#211e1e", gemini: "#4285f4", hermes: "#7c3aed", "cursor-agent": "#1b1b1b", aider: "#14b014", amp: "#f34e3f", goose: "#000000", copilot: "#6e40c9", crush: "#6b50ff" };
/** `hints`: the command, args, cwd and local URL, used only to match a server to one of your projects (projconn.ts). Never stored or shown: args can hold tokens. */
type McpEntry = { name: string; where: string; remote: boolean; hints: string[] };
const LOCAL_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])[:/]/;
function mcpHints(c: any): string[] {
  const h: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.length < 600) h.push(v); };
  (Array.isArray(c?.command) ? c.command : [c?.command]).forEach(push);
  (Array.isArray(c?.args) ? c.args : []).forEach(push);
  push(c?.cwd);
  for (const u of [c?.url, c?.httpUrl, c?.serverUrl]) if (typeof u === "string" && LOCAL_URL.test(u)) h.push(u);
  return h;
}
/** Server names (and whether they're remote) from every agent app's config. Env, headers and args are never kept. */
export function mcpEntries(): McpEntry[] {
  const out: McpEntry[] = [];
  const add = (obj: any, where: string) => { if (obj && typeof obj === "object") for (const [n, c] of Object.entries<any>(obj)) out.push({ name: n, where, remote: !!(c?.url || c?.httpUrl || c?.serverUrl || c?.type === "remote" || c?.type === "http" || c?.type === "sse"), hints: mcpHints(c) }); };
  const cj = readJson(`${HOME}/.claude.json`) ?? {};
  add(cj.mcpServers, "Claude Code");
  for (const p of Object.values<any>(cj.projects ?? {})) add(p?.mcpServers, "Claude Code (project)");
  for (const n of cj.claudeAiMcpEverConnected ?? []) out.push({ name: String(n).replace(/^claude\.ai /, ""), where: "claude.ai connector", remote: true, hints: [] });
  const plugins = readJson(`${HOME}/.claude/plugins/installed_plugins.json`)?.plugins ?? {};
  for (const [id, inst] of Object.entries<any>(plugins)) {
    const root = (Array.isArray(inst) ? inst[inst.length - 1] : inst)?.installPath;
    if (root) { const j = readJson(`${root}/.mcp.json`); add(j?.mcpServers ?? j, `Claude plugin ${id.split("@")[0]}`); }
  }
  for (const m of readText(`${HOME}/.codex/config.toml`).matchAll(/^\[mcp_servers\.([^\].]+)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) {
    const hints = [...m[2].matchAll(/^\s*(?:command|cwd|args|url)\s*=\s*(.+)$/gm)].flatMap((x) => [...x[1].matchAll(/"([^"]*)"/g)].map((y) => y[1])).filter((v) => !/^https?:/.test(v) || LOCAL_URL.test(v));
    out.push({ name: m[1], where: "Codex", remote: /^\s*url\s*=/m.test(m[2]), hints });
  }
  // Project-scoped servers: a .mcp.json at the top of a project (Claude Code reads it there).
  for (const root of PROJECT_ROOTS) for (const d of ls(`${HOME}/${root}`)) { if (d.startsWith(".")) continue; const j = readJson(`${HOME}/${root}/${d}/.mcp.json`); if (j?.mcpServers) add(j.mcpServers, `Claude Code (${d} project)`); }
  const oc = readJsonc(`${HOME}/.config/opencode/opencode.jsonc`) ?? readJson(`${HOME}/.config/opencode/opencode.json`) ?? readJson(`${HOME}/.config/opencode/config.json`) ?? {};
  add(oc.mcp, "OpenCode");
  add(readJson(`${HOME}/.gemini/settings.json`)?.mcpServers, "Gemini CLI");
  for (const d of ["antigravity", "antigravity-ide", "config"]) add(readJson(`${HOME}/.gemini/${d}/mcp_config.json`)?.mcpServers, "Antigravity");
  add(readJson(`${HOME}/.cursor/mcp.json`)?.mcpServers, "Cursor");
  add(readJson(`${HOME}/.codeium/windsurf/mcp_config.json`)?.mcpServers, "Windsurf");
  add(readJsonc(`${HOME}/.config/zed/settings.json`)?.context_servers, "Zed");
  // Hermes and Goose keep YAML: take the keys under the MCP block by indentation, nothing else.
  for (const [file, block, where] of [[".hermes/config.yaml", "mcp_servers", "Hermes"], [".config/goose/config.yaml", "extensions", "Goose"]] as const) {
    const lines = readText(`${HOME}/${file}`).split("\n");
    const i = lines.findIndex((l) => new RegExp(`^${block}:\\s*$`).test(l));
    if (i < 0) continue;
    let indent = -1;
    for (const l of lines.slice(i + 1)) {
      if (!l.trim() || l.trim().startsWith("#")) continue;
      const lead = l.length - l.trimStart().length;
      if (lead === 0) break;
      if (indent < 0) indent = lead;
      const m = lead === indent && l.trim().match(/^([\w.-]+):/);
      if (m) out.push({ name: m[1], where, remote: false, hints: [] });
    }
  }
  if (MAC) {
    add(readJson(`${HOME}/Library/Application Support/Claude/claude_desktop_config.json`)?.mcpServers, "Claude Desktop");
    add(readJson(`${HOME}/Library/Application Support/Code/User/mcp.json`)?.servers, "VS Code");
    add(readJson(`${HOME}/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`)?.mcpServers, "Cline");
  } else {
    add(readJson(`${HOME}/.config/Code/User/mcp.json`)?.servers, "VS Code");
    add(readJson(`${HOME}/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`)?.mcpServers, "Cline");
  }
  return out;
}

/** Cline names servers by repo path ("github.com/org/fetch-mcp"): the last segment is the server. */
const mcpName = (n: string) => (n.includes("/") ? n.split("/").filter(Boolean).pop()! : n);
const appPath = (a: string) => (a.startsWith("/") ? a : [`/Applications/${a}`, `${HOME}/Applications/${a}`].find((p) => existsSync(p)));
async function services(names: Map<string, boolean>, mcps: McpEntry[], npx: Map<string, string>, ctx: ProbeCtx): Promise<Item[]> {
  const list = SERVICES.filter((s) => MAC || !s.mac);
  const found = await Promise.all(list.map(async (s): Promise<Item | undefined> => {
    const via: string[] = [];
    let installed = false;
    for (const b of s.bins ?? []) {
      const p = which(b);
      if (!p) continue;
      installed = true;
      const v = s.nover ? undefined : await version(p, b === "kubectl" ? "version" : "--version");
      via.push(`${b}${v ? ` ${v}` : ""}`);
    }
    for (const pkg of s.npx ?? []) if (npx.has(pkg)) { installed = true; via.push(`npx ${pkg} ${npx.get(pkg)}`); }
    if (MAC) for (const a of s.apps ?? []) { const p = appPath(a); if (p && existsSync(p)) { installed = true; via.push(a.split("/").pop()!.replace(/\.app$/, "") + " app"); } }
    for (const p of s.paths ?? []) if (has(p)) { installed = true; break; }
    const k = s.env ? [...names.keys()].filter((n) => s.env!.test(n)) : [];
    const projOnly = k.length > 0 && k.every((n) => names.get(n));
    for (const x of k.slice(0, 4)) via.push(`key ${x}`);
    if (k.length > 4) via.push(`+${k.length - 4} keys`);
    const m = s.mcp ? [...new Set(mcps.filter((x) => s.mcp!.test(mcpName(x.name))).map((x) => `${mcpName(x.name)} (${x.where})`))] : [];
    for (const x of m.slice(0, 3)) via.push(`MCP ${x}`);
    let signed: boolean | undefined;
    if (s.loginJson) { const j = readJson(abs(s.loginJson[0])); signed = s.loginJson[1](j); }
    else if (s.login) signed = s.login.some(has);
    const pr = installed && s.probe ? await s.probe(ctx).catch(() => undefined) : undefined;
    if (pr?.via) via.push(...pr.via);
    if (pr?.signed !== undefined) signed = pr.signed;
    const any = installed || k.length > 0 || m.length > 0;
    if (!any && s.quiet) return; // niche: not worth a "Not set up" card
    const other = k.length > 0 || m.length > 0;
    let state: State = "ready";
    if (!any) state = "off";
    else if (signed === false && !other) state = "signed-out";
    else if (pr?.running === false && !other) state = "installed";
    else if (installed && !other && signed === undefined && !s.local) state = "installed";
    const status: Item["status"] = state === "off" ? "off" : state === "signed-out" ? "partial" : "ready";
    const note = !any ? "not set up"
      : pr?.note && (signed !== false || other) ? pr.note
      : signed === true ? "signed in"
      : state === "signed-out" ? "installed, not signed in"
      : m.length ? "connected via MCP"
      : k.length ? (projOnly ? "API key in project .env" : "API key set")
      : pr?.note ?? "installed";
    return { id: `svc:${slug(s.name)}`, name: s.name, kind: "service", cat: s.cat, group: s.cat, color: s.color, status, state, detail: s.what, note, via, use: s.use };
  }));
  return found.filter(Boolean) as Item[];
}

async function agents(): Promise<Item[]> {
  const found = await Promise.all(AGENTS.map(async ([name, bin, what]) => {
    const path = which(bin);
    if (!path) return;
    const v = await version(path);
    return { id: `agent:${bin}`, name, kind: "agent", cat: "ai" as Cat, color: AGENT_COLOR[bin], status: "ready" as const, detail: what, note: v ? `v${v}` : "installed", via: [bin] };
  }));
  return found.filter(Boolean) as Item[];
}
async function devTools(): Promise<Item[]> {
  const found = await Promise.all(DEV.map(async ([name, bin, what]) => {
    const p = which(bin);
    if (!p) return;
    const v = await version(p, bin === "go" ? "version" : "--version");
    return { id: `dev:${bin}`, name, kind: "cli", cat: "code" as Cat, status: "ready" as const, detail: what, note: v ? `v${v}` : "installed", via: [bin] };
  }));
  return found.filter(Boolean) as Item[];
}

function subscriptions(): Item[] {
  const out: Item[] = [];
  const oa = readJson(`${HOME}/.claude.json`)?.oauthAccount;
  if (oa) out.push({ id: "sub:claude", name: "Claude", kind: "sub", cat: "ai", color: "#d97757", status: "ready", detail: [oa.billingType?.replace(/_/g, " "), oa.organizationRateLimitTier ?? oa.userRateLimitTier].filter(Boolean).join(" · ") || "signed in", note: "signed in" });
  const codexPlan = latestCodexLimits()?.plan;
  if (existsSync(`${HOME}/.codex/auth.json`)) out.push({ id: "sub:chatgpt", name: "ChatGPT / Codex", kind: "sub", cat: "ai", color: "#10a37f", status: "ready", detail: codexPlan ? `${codexPlan} plan` : "signed in", note: "signed in" });
  if (existsSync(`${HOME}/.gemini`)) out.push({ id: "sub:gemini", name: "Gemini", kind: "sub", cat: "ai", color: "#8e75b2", status: "ready", detail: existsSync(`${HOME}/.gemini/oauth_creds.json`) ? "Google sign-in" : "configured" });
  const models = ls(`${HOME}/.ollama/models/manifests/registry.ollama.ai/library`);
  if (models.length) out.push({ id: "sub:ollama", name: "Ollama models", kind: "sub", cat: "ai", color: "#111111", status: "ready", detail: `${models.length} local model${models.length > 1 ? "s" : ""}`, note: models.slice(0, 8).join(", "), via: models.slice(0, 12) });
  const lm = ls(`${HOME}/.lmstudio/models`).flatMap((pub) => ls(`${HOME}/.lmstudio/models/${pub}`));
  if (lm.length) out.push({ id: "sub:lmstudio", name: "LM Studio models", kind: "sub", cat: "ai", color: "#4338ca", status: "ready", detail: `${lm.length} local model${lm.length > 1 ? "s" : ""}`, note: lm.slice(0, 8).join(", ") });
  return out;
}

function sshHosts(): Item[] {
  const out: Item[] = [];
  for (const m of readText(`${HOME}/.ssh/config`).matchAll(/^\s*Host\s+(.+)$/gim)) {
    for (const h of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(h)) out.push({ id: `ssh:${h}`, name: h, kind: "ssh", cat: "devices", status: "ready", detail: "SSH host", via: [`ssh ${h}`], use: `\`ssh ${h}\` (key auth; non-interactive commands work).` });
  }
  return out;
}

/** Tailnet devices: names, OS and whether they're online. Never addresses or keys. */
function devices(j: any): Item[] {
  if (!j) return [];
  const one = (p: any, self: boolean): Item => {
    const name = String(p.HostName || p.DNSName?.split(".")[0] || "device");
    const host = String(p.DNSName ?? "").replace(/\.$/, "");
    return { id: `device:${slug(host.split(".")[0] || name)}`, name, kind: "device", cat: "devices", status: p.Online || self ? "ready" : "partial", state: p.Online || self ? "ready" : "offline", detail: `${p.OS || "device"} on your tailnet${self ? " (this machine)" : ""}`, note: self ? "this machine" : p.Online ? "online" : "offline", via: host ? [host.split(".")[0]] : [], use: host ? `Reachable on the tailnet as ${host.split(".")[0]} (MagicDNS). Try \`ssh ${host.split(".")[0]}\` or its served ports.` : undefined };
  };
  return [...(j.Self ? [one(j.Self, true)] : []), ...Object.values<any>(j.Peer ?? {}).map((p) => one(p, false))];
}

/** Your own background services: launchd user agents on a Mac, systemd --user units on Linux. Names and state only. */
const VENDOR = /^(com\.apple|com\.google|com\.trendmicro|com\.openai|com\.microsoft|us\.zoom|com\.adobe|com\.docker|com\.anydesk|org\.chromium|com\.brave|io\.tailscale|com\.dropbox|com\.spotify)/;
async function background(): Promise<Item[]> {
  const out: Item[] = [];
  if (MAC) {
    const labels = ls(`${HOME}/Library/LaunchAgents`).filter((f) => f.endsWith(".plist")).map((f) => f.replace(/\.plist$/, "")).filter((l) => !VENDOR.test(l));
    if (!labels.length) return out;
    const { out: lst } = await run(["/bin/launchctl", "list"], 2500);
    const st = new Map<string, string>();
    for (const line of lst.split("\n").slice(1)) { const [pid, , label] = line.split("\t"); if (label) st.set(label.trim(), pid !== "-" ? "running" : "loaded"); }
    for (const l of labels) {
      const s = st.get(l);
      const pretty = l.replace(/^homebrew\.mxcl\./, "").replace(/^(com|dev|ai|local|io|org|net|me|app)\./, "");
      out.push({ id: `bg:${slug(l)}`, name: pretty, kind: "background", cat: "automation", status: "ready", state: s === "running" ? "ready" : "installed", detail: l.startsWith("homebrew.mxcl.") ? "Homebrew service (launchd)" : "Background service (launchd)", note: s === "running" ? "running" : s === "loaded" ? "loaded, not running now" : "not loaded", via: [l], use: `launchd agent ${l}: \`launchctl print gui/$(id -u)/${l}\` for state and log paths; ask before stopping or restarting it.` });
    }
  } else {
    const units = ls(`${HOME}/.config/systemd/user`).filter((f) => f.endsWith(".service"));
    if (!units.length) return out;
    const { out: lst } = await run(["systemctl", "--user", "list-units", "--type=service", "--all", "--no-legend", "--plain"], 2500);
    const st = new Map<string, string>();
    for (const line of lst.split("\n")) { const [u, , active, sub] = line.trim().split(/\s+/); if (u) st.set(u, `${active}/${sub}`); }
    for (const u of units) {
      const s = st.get(u) ?? "";
      const running = /running/.test(s);
      out.push({ id: `bg:${slug(u)}`, name: u.replace(/\.service$/, ""), kind: "background", cat: "automation", status: "ready", state: running ? "ready" : "installed", detail: "Background service (systemd --user)", note: running ? "running" : s ? s.replace("/", ", ") : "not loaded", via: [u], use: `systemd user unit ${u}: \`systemctl --user status ${u}\`, \`journalctl --user -u ${u} -n 50\`; ask before restarting it.` });
    }
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
    for (const [id, p] of Object.entries<any>(cache)) out.push({ id: `browser:${slug(b)}:${slug(id)}`, name: p.name || id, kind: "browser", cat: "browsers", group: b, status: p.user_name ? "ready" : "partial", state: p.user_name ? "ready" : "installed", detail: `${b} profile`, note: p.user_name ? "signed in to Google" : "no Google account" });
  }
  return out;
}

/** Saved-login site names, read in their own process with a hard timeout (logins.ts). DECK_NO_LOGINS=1 turns it off. */
async function loginScan(): Promise<LoginScan> {
  if (process.env.DECK_NO_LOGINS) return { profiles: [], files: 0, ms: 0, error: "turned off (DECK_NO_LOGINS)" };
  const { out } = await run([process.execPath, `${import.meta.dir}/logins.ts`, "--logins"], Number(process.env.DECK_LOGINS_MS) || 6000);
  try { const j = JSON.parse(out); if (Array.isArray(j?.profiles)) return j; } catch {}
  return { profiles: [], files: 0, ms: 0, error: "didn't finish in time" };
}
/** Apps, CLIs, key names and MCP servers that show you have a catalog account. Names only, like the rest of the scan. */
function accountEvidence(names: Map<string, boolean>, mcps: McpEntry[]) {
  return (s: Site): Evidence => {
    const via: string[] = [];
    let strong = false, app = false;
    for (const b of s.bins ?? []) if (which(b)) { via.push(b); if (s.cat === "social") app = true; else strong = true; }
    if (MAC) for (const a of s.apps ?? []) if (appPath(a)) { via.push(`${a.replace(/\.app$/, "")} app`); app = true; }
    const k = s.env ? [...names.keys()].filter((n) => s.env!.test(n)) : [];
    for (const x of k.slice(0, 3)) via.push(`key ${x}`);
    const m = s.mcp ? [...new Set(mcps.filter((x) => s.mcp!.test(mcpName(x.name))).map((x) => mcpName(x.name)))] : [];
    for (const x of m.slice(0, 2)) via.push(`MCP ${x}`);
    if (k.length || m.length) strong = true;
    return { via: [...new Set(via)], strong, app };
  };
}

/** Ports something listens on right now, each with its process's working folder (lsof on macOS, ss + /proc on Linux).
 *  Nothing connects to the ports; the folders are only used to tell which project is running. Undefined when unknown. */
async function listeningPorts(): Promise<Map<number, string | undefined> | undefined> {
  const lsof = which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
  const portPid = new Map<number, number>();
  if (lsof) {
    const { out } = await run([lsof, "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], 3000);
    let pid = 0;
    for (const l of out.split("\n")) { if (l[0] === "p") pid = Number(l.slice(1)); else if (l[0] === "n") { const m = l.match(/:(\d+)$/); if (m && !portPid.has(Number(m[1]))) portPid.set(Number(m[1]), pid); } }
    if (!out) return undefined;
    const pids = [...new Set(portPid.values())].filter(Boolean);
    const cwd = new Map<number, string>();
    if (pids.length) {
      const { out: o2 } = await run([lsof, "-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], 3000);
      let p = 0;
      for (const l of o2.split("\n")) { if (l[0] === "p") p = Number(l.slice(1)); else if (l[0] === "n" && p) cwd.set(p, l.slice(1)); }
    }
    return new Map([...portPid].map(([port, p]) => [port, cwd.get(p)]));
  }
  const ss = which("ss");
  if (!ss) return undefined;
  const { out, code } = await run([ss, "-ltnpH"], 2500);
  if (code !== 0) return undefined;
  const res = new Map<number, string | undefined>();
  for (const l of out.split("\n")) {
    const port = Number(l.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1]);
    if (!port || res.has(port)) continue;
    const pid = l.match(/pid=(\d+)/)?.[1];
    let dir: string | undefined;
    try { if (pid) dir = readlinkSync(`/proc/${pid}/cwd`); } catch {}
    res.set(port, dir);
  }
  return res;
}
/** Your launchd agents / systemd units with their file text, so a project can be matched to the service that runs it. */
function serviceRefs(bg: Item[]): ServiceRef[] {
  return bg.map((b) => {
    const label = b.via?.[0] ?? b.name;
    const file = MAC ? `${HOME}/Library/LaunchAgents/${label}.plist` : `${HOME}/.config/systemd/user/${label}`;
    return { label, kind: MAC ? "launchd" as const : "systemd" as const, running: b.note === "running", loaded: b.note !== "not loaded", text: readText(file, 64 * 1024) };
  });
}
const SKILL_DIRS = [".claude/skills", ".agents/skills", ".codex/skills", ".config/opencode/skills", ".hermes/skills"];
function skillRefs(): SkillRef[] {
  const out: SkillRef[] = [];
  for (const dir of SKILL_DIRS) for (const n of ls(`${HOME}/${dir}`)) { const t = readText(`${HOME}/${dir}/${n}/SKILL.md`, 128 * 1024); if (t && !out.some((x) => x.name === n)) out.push({ name: n, text: t }); }
  return out;
}

function skills(): Item[] {
  const out = new Map<string, Item>();
  for (const [where, dir] of [["Claude Code", ".claude/skills"], ["Codex / agents", ".agents/skills"], ["Codex", ".codex/skills"], ["OpenCode", ".config/opencode/skills"], ["Hermes", ".hermes/skills"]] as const) {
    for (const n of ls(`${HOME}/${dir}`)) {
      if (n.startsWith(".") || n.endsWith(".md")) continue;
      const md = readText(`${HOME}/${dir}/${n}/SKILL.md`);
      if (!md && where === "Hermes") continue; // Hermes keeps category folders here too
      const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").slice(0, 200);
      const prev = out.get(n);
      if (prev) { if (!prev.group!.includes(where)) prev.group = `${prev.group}, ${where}`; continue; }
      out.set(n, { id: `skill:${n}`, name: n, kind: "skill", cat: "skills", group: where, status: "ready", detail: desc, use: `Skill "${n}": load it when the task matches.` });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── your edits: custom connections, hidden items, notes ─────────────────────
const CONF = `${HOME}/.config/herdr-deck/connections.json`;
export type ConnConf = { custom: Item[]; hidden: string[]; notes: Record<string, string>; accounts: Account[] };
export function loadConnConf(): ConnConf {
  const j = readJson(CONF) ?? {};
  return { custom: j.custom ?? [], hidden: j.hidden ?? [], notes: j.notes ?? {}, accounts: Array.isArray(j.accounts) ? j.accounts : [] };
}
export function saveConnConf(c: ConnConf) {
  try { mkdirSync(`${HOME}/.config/herdr-deck`, { recursive: true }); writeFileSync(CONF, JSON.stringify(c, null, 1)); } catch {}
  cached = undefined;
}

let cached: Inventory | undefined;
let building: Promise<Inventory> | undefined;

/**
 * The scan runs in its own short-lived process: it reads big config files and probes ~50 CLIs, which would
 * stall the server's event loop, and a probe that hangs can't take the server with it.
 */
export async function inventory(force = false): Promise<Inventory> {
  if (cached && !force && Date.now() - cached.at < 10 * 60_000) return cached;
  if (building) return building;
  building = (async () => {
    const p = Bun.spawn([process.execPath, import.meta.path, "--scan"], { stdin: "ignore", stdout: "pipe", stderr: "inherit", env: process.env });
    const timer = setTimeout(() => p.kill(9), 45_000);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    try { cached = JSON.parse(out) as Inventory; }
    catch { if (!cached) throw new Error("The connections scan didn’t finish; try Rescan"); }
    return cached!;
  })().finally(() => { building = undefined; });
  return building;
}

/** First-seen times per item id, per machine, so the store can show what's new. The first scan is the baseline (0). */
const SEEN = `${HOME}/.config/herdr-deck/connections-seen.json`;
const SEEN_V = 2;
function stampSeen(items: Item[], dry: boolean) {
  const j = readJson(SEEN) ?? {};
  const ids: Record<string, number> = j.ids ?? {};
  // The first scan is the baseline, and so is the first scan of a deck version that adds kinds of cards
  // (v2: accounts, your projects), so an upgrade doesn't mark everything "New".
  const first = !j.ids || (j.v ?? 1) < SEEN_V;
  const now = Date.now();
  let changed = first;
  for (const i of items) if (!(i.id in ids)) { ids[i.id] = first ? 0 : now; changed = true; }
  for (const i of items) if (ids[i.id]) i.since = ids[i.id];
  if (changed && !dry) { try { mkdirSync(`${HOME}/.config/herdr-deck`, { recursive: true }); writeFileSync(SEEN, JSON.stringify({ v: SEEN_V, ids })); } catch {} }
}

async function scan(): Promise<Inventory> {
  const t0 = Date.now();
  const dry = !!process.env.DECK_SCAN_DRY;
  const { keys, names } = keyNames(), mcps = mcpEntries(), npx = npxCache();
  const t1 = Date.now();
  const cap = <T,>(p: Promise<T>, fallback: T, what: string) => Promise.race([p, Bun.sleep(20_000).then(() => { console.warn(`connections: ${what} took over 20s; showing without it`); return fallback; })]);
  let ts: Promise<any> | undefined;
  const ctx: ProbeCtx = {
    bin: which,
    tailscale: () => (ts ??= (async () => { const b = which("tailscale") ?? (MAC && existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale") ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : undefined); if (!b) return; const { out } = await run([b, "status", "--json"], 3000); try { return JSON.parse(out); } catch { return undefined; } })()),
  };
  const listenP = listeningPorts();
  const [svc0, ag, dev, bg, tsj, lg] = await Promise.all([
    cap(services(names, mcps, npx, ctx), [] as Item[], "services"), cap(agents(), [] as Item[], "agents"), cap(devTools(), [] as Item[], "dev tools"),
    cap(background(), [] as Item[], "background services"), cap(ctx.tailscale(), undefined, "tailscale"),
    cap(loginScan(), { profiles: [], files: 0, ms: 0, error: "didn't finish in time" } as LoginScan, "saved-login site names"),
  ]);
  const listening = await cap(listenP, undefined, "listening ports");
  console.error(`connections: scanned in ${Date.now() - t0}ms (files ${t1 - t0}ms, probes ${Date.now() - t1}ms, saved-login names ${lg.ms}ms from ${lg.profiles.length} profiles${lg.error ? `: ${lg.error}` : ""})`);
  const conf = loadConnConf();
  const hid = new Set(conf.hidden);
  const dress = (it: Item): Item => ({ ...it, use: conf.notes[it.id] ?? it.use, hidden: hid.has(it.id) });
  const merged = mergeAccounts({ svc: svc0, logins: lg.profiles, accounts: conf.accounts, evidence: accountEvidence(names, mcps) });
  // Your projects that agents can use. A project's MCP card, and a service card it fully explains, fold into it.
  const projs = detectProjects({ home: HOME, roots: PROJECT_ROOTS.map((r) => `${HOME}/${r}`), mcps, services: serviceRefs(bg), skills: skillRefs(), listening, wikiDir: `${HOME}/wiki` });
  const projItems = projectItems(projs, HOME);
  const defs = new Map(SERVICES.map((d) => [`svc:${slug(d.name)}`, d]));
  const folded = new Set<string>();
  projs.forEach((p, k) => {
    const it = projItems[k];
    const names = p.mcp.map((m) => mcpName(m.name));
    for (const sv of merged.svc) {
      const d = defs.get(sv.id);
      if (!d || sv.status === "off") continue;
      const byPath = (d.paths ?? []).some((x) => { const a = abs(x); return a === p.root || a.startsWith(`${p.root}/`); });
      const explained = (sv.via ?? []).every((v) => names.some((n) => v.startsWith(`MCP ${n} `)) || p.cli.includes(v.split(" ")[0]));
      if (!explained || !(byPath || (d.mcp && names.some((n) => d.mcp!.test(n))) || (d.bins ?? []).some((b) => p.cli.includes(b)))) continue;
      folded.add(sv.id);
      it.aliases = [...(it.aliases ?? []), sv.id];
      if (!it.detail || it.detail.startsWith("Your project at")) it.detail = sv.detail;
    }
  });
  const svc = merged.svc.filter((x) => !folded.has(x.id));
  const used = new Set([...svc.filter((x) => x.status !== "off"), ...merged.accounts].flatMap((x) => x.via ?? []));
  const mcpItems: Item[] = [];
  const byName = new Map<string, McpEntry[]>();
  for (const m of mcps) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  for (const [n, es] of byName) mcpItems.push({ id: `mcp:${slug(n)}`, name: mcpName(n), kind: "mcp", cat: "mcp", status: "ready", detail: es[0].remote ? "Remote MCP server" : "Local MCP server", note: [...new Set(es.map((e) => e.where))].slice(0, 3).join(", "), via: [...new Set(es.map((e) => e.where))], use: `MCP server "${n}" (${[...new Set(es.map((e) => e.where))].join(", ")}): use its tools when relevant.` });
  const keyItems: Item[] = keys.map((k) => ({ id: `key:${slug(k.name)}`, name: k.name, kind: "key", cat: "keys", status: "ready", detail: k.projects ? `in ${k.where}` : `set in ${k.where}`, note: used.has(`key ${k.name}`) ? "used by a service above" : "", use: k.projects ? `Env var ${k.name} is in the .env of ${k.projects.slice(0, 5).join(", ")} (value never shown).` : `Env var ${k.name} is available (value never shown).` }));
  const sections: Section[] = [
    { id: "services", title: "Services", hint: "What agents can deploy to, pay with, store in, and talk to — and how", items: svc.filter((x) => x.status !== "off") },
    { id: "projects", title: "Your projects", hint: "Your own projects agents can use: MCP servers, CLIs, dashboards, services and skills", items: projItems },
    { id: "accounts", title: "Accounts", hint: "Social media and sites you have accounts on: site names from saved logins, apps, key names, or added by you", items: [...merged.accounts, ...(merged.other ? [merged.other] : [])] },
    { id: "ai", title: "AI", hint: "Coding agents and the plans and models behind them", items: [...ag, ...subscriptions()] },
    { id: "mcp", title: "MCP servers & connectors", hint: "Tool servers each agent app can call", items: mcpItems.filter((m) => !projItems.some((p) => p.aliases?.includes(m.id))) },
    { id: "machines", title: "Machines", hint: "SSH hosts this machine can reach", items: sshHosts() },
    { id: "devices", title: "Tailnet devices", hint: "Devices on your Tailscale network", items: devices(tsj) },
    { id: "keys", title: "API keys", hint: "Names and where they're set. Values are never read or sent.", items: keyItems },
    { id: "dev", title: "Dev tools", hint: "Runtimes and everyday CLIs", items: dev },
    { id: "background", title: "Background services", hint: "Your own services that run on their own", items: bg },
    { id: "browser", title: "Browsers", hint: "Profiles and whether they're signed in", items: browsers() },
    { id: "skills", title: "Skills", hint: "Packaged know-how agents can load", items: skills() },
    { id: "custom", title: "Yours", hint: "Connections you added by hand", items: conf.custom.map((c) => ({ ...c, custom: true, kind: c.kind || "custom", status: c.status ?? "ready" })) },
    { id: "missing", title: "Not set up", hint: "Common services this machine can't reach yet", items: svc.filter((x) => x.status === "off") },
  ];
  // Services you don't have yet, best fit first. A recommended service replaces its "Not set up" card.
  const wiki = `${readText(`${HOME}/wiki/index.md`, 512 * 1024)}\n${readText(`${HOME}/wiki/overview.md`, 256 * 1024)}`;
  const recs = recommend(sections.flatMap((x) => x.items), lg.profiles, conf.accounts, wiki);
  const recOwn = new Set(recs.flatMap((x) => x.rec?.owns ?? []));
  sections.find((x) => x.id === "missing")!.items = svc.filter((x) => x.status === "off" && !recOwn.has(x.id));
  sections.push({ id: "recommended", title: "Recommended for you", hint: "Services worth signing up for, ranked by fit with your projects", items: recs });
  for (const sec of sections) sec.items = sec.items.map(dress);
  stampSeen(sections.filter((s) => s.id !== "missing" && s.id !== "recommended").flatMap((s) => s.items), dry);
  const inv: Inventory = { machine: hostname().replace(/\.local$/, ""), platform: platform(), at: Date.now(), ms: Date.now() - t0, sections };
  inv.file = dry ? undefined : writeConnectionsMd(inv);
  return inv;
}


const stateWord = (i: Item) => (i.kind === "project" ? (i.state === "installed" ? " (not running now)" : "") : i.state === "installed" ? " (installed; not signed in or not running)" : i.state === "offline" ? " (offline)" : i.state === "account" ? " (you have an account; not set up for agents here)" : i.status === "partial" ? " (needs sign-in)" : "");
const handleOf = (h?: string) => { const t = String(h ?? "").trim(); return !t ? "" : /^https?:\/\//.test(t) || t.startsWith("@") || t.includes(".") || t.includes("/") ? t : `@${t}`; };
/** An account for agents: name, your public handle, where it's signed in, how they may use it. Never a password or token. */
const accountLine = (i: Item) => i.kind === "sites"
  ? `- **${i.name}**: ${i.sites?.length ?? 0} more site${i.sites?.length === 1 ? "" : "s"} with saved logins (the names stay in the deck)`
  : `- **${i.name}**${i.handle ? ` ${handleOf(i.handle)}` : ""}${i.url ? ` (${i.url})` : ""}${stateWord(i)}${i.detail ? ` — ${i.detail}` : ""}${i.logins?.length ? `. Signed in: saved login in ${i.logins.join(", ")}` : ""}${i.use ? `\n  How agents may use it: ${i.use}` : ""}${i.connect?.length ? `\n  Connect: ${i.connect.slice(0, 2).join("; ")}` : ""}`;
const itemLine = (i: Item) => `- **${i.name}**${stateWord(i)}${i.detail ? ` — ${i.detail.replace(/\.$/, "")}` : ""}${i.via?.length ? `. Via: ${i.via.join(", ")}` : ""}${i.use ? `\n  How: ${i.use}` : ""}`;

/** Plain text for agents (MCP, "suggest projects", CONNECTIONS.md): capabilities and how to use them, never secrets. */
export function inventoryText(inv: Inventory, only?: Set<string>): string {
  const lines = [`# Connections on ${inv.machine}`, "", "What this machine can reach and how to use it. Never print or log secret values; ask before anything public, paid or destructive."];
  for (const s of inv.sections) {
    if (s.id === "missing" || s.id === "recommended") continue;
    const items = s.items.filter((i) => !i.hidden && (!only || only.has(i.id)) && (s.id !== "keys" || !i.note) && (s.id !== "skills" || only));
    if (!items.length) continue;
    if (s.id === "accounts") { lines.push("", "## Accounts", "Accounts you have (never passwords or tokens). Handles are public. Ask before posting, messaging, buying or changing anything.", ...items.map(accountLine)); continue; }
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

// Last, so every const above is initialized before the scan runs (it writes CONNECTIONS.md with inventoryText).
if (import.meta.main && process.argv.includes("--scan")) {
  const inv = await scan();
  // Wait for the write to drain: exiting straight after a >64 KB write to a pipe cuts it short.
  await new Promise<void>((done) => process.stdout.write(JSON.stringify(inv), () => done()));
  process.exit(0);
}
