// Which sites you have saved logins for, by NAME only: Chromium browsers (Chrome, Brave, Edge, Arc, Vivaldi,
// Chromium) keep them in each profile's "Login Data" SQLite file. The file is copied to a private temp folder
// (the browser keeps it locked), only the origin_url and signon_realm columns are read, each is reduced to a
// host, banks/finance/health/government/dating/adult sites are dropped, and the copy is deleted. Usernames,
// passwords and cookies are never selected. Safari and the Keychain are never touched; history is never read.
// The scanner runs this file as its own short-lived process with a timeout (bun src/logins.ts --logins).
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { hostOf, sensitive } from "./catalog";

export type LoginProfile = { browser: string; profile: string; label: string; hosts: string[] };
export type LoginScan = { profiles: LoginProfile[]; files: number; ms: number; error?: string };

/** Every Chromium browser's user-data folder on this OS: [browser name, absolute path]. Missing ones are skipped later. */
export function browserRoots(home = homedir(), mac = platform() === "darwin"): [string, string][] {
  const A = `${home}/Library/Application Support`;
  const list: [string, string][] = mac
    ? [["Chrome", `${A}/Google/Chrome`], ["Chrome Beta", `${A}/Google/Chrome Beta`], ["Chrome Canary", `${A}/Google/Chrome Canary`], ["Chromium", `${A}/Chromium`],
      ["Brave", `${A}/BraveSoftware/Brave-Browser`], ["Edge", `${A}/Microsoft Edge`], ["Arc", `${A}/Arc/User Data`], ["Vivaldi", `${A}/Vivaldi`]]
    : [["Chrome", `${home}/.config/google-chrome`], ["Chrome Beta", `${home}/.config/google-chrome-beta`], ["Chromium", `${home}/.config/chromium`], ["Chromium", `${home}/snap/chromium/common/chromium`],
      ["Brave", `${home}/.config/BraveSoftware/Brave-Browser`], ["Brave", `${home}/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser`], ["Chrome", `${home}/.var/app/com.google.Chrome/config/google-chrome`],
      ["Edge", `${home}/.config/microsoft-edge`], ["Vivaldi", `${home}/.config/vivaldi`]];
  return list.filter(([, p]) => existsSync(p));
}

/** Hosts in one Login Data file, sensitive ones dropped. Reads a private copy, never the browser's file. */
export function readLoginFile(file: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "deck-logins-"));
  const hosts = new Set<string>();
  try {
    const tmp = join(dir, "login.db");
    copyFileSync(file, tmp);
    const db = new Database(tmp, { readonly: true });
    try {
      let rows: { origin_url: string | null; signon_realm: string | null }[];
      // Only these two columns, ever. "Never save for this site" entries aren't accounts, so they're skipped.
      try { rows = db.query("SELECT origin_url, signon_realm FROM logins WHERE blacklisted_by_user = 0").all() as any; }
      catch { rows = db.query("SELECT origin_url, signon_realm FROM logins").all() as any; }
      for (const r of rows) { const h = hostOf(r.origin_url, r.signon_realm); if (h && !sensitive(h)) hosts.add(h); }
    } finally { db.close(); }
  } catch {
    // A locked, corrupt or unexpected file: this profile simply contributes nothing.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return [...hosts].sort();
}

/** "Chrome · Default profile", "Chrome · Default profile (Stas)", "Brave · Work". */
export function profileLabel(browser: string, dir: string, name: string) {
  if (dir === "Default") return `${browser} · Default profile${name && !/^(Person \d+|Default|Your Chrome|Profile \d+)$/i.test(name) ? ` (${name})` : ""}`;
  return `${browser} · ${name || dir}`;
}
const SKIP_PROFILE = /^(System Profile|Guest Profile)$/;
/** Every profile of every Chromium browser here, with the hosts it has saved logins for. */
export function readLogins(home = homedir(), mac = platform() === "darwin"): LoginScan {
  const t0 = Date.now();
  const out: LoginProfile[] = [];
  let files = 0;
  for (const [browser, root] of browserRoots(home, mac)) {
    let names: Record<string, any> = {};
    try { names = JSON.parse(readFileSync(`${root}/Local State`, "utf8"))?.profile?.info_cache ?? {}; } catch {}
    let dirs: string[] = [];
    try { dirs = readdirSync(root); } catch {}
    for (const d of dirs) {
      if (SKIP_PROFILE.test(d)) continue;
      const hosts = new Set<string>();
      let any = false;
      for (const f of ["Login Data", "Login Data For Account"]) {
        const p = `${root}/${d}/${f}`;
        try { if (!statSync(p).isFile()) continue; } catch { continue; }
        any = true; files++;
        for (const h of readLoginFile(p)) hosts.add(h);
      }
      if (!any) continue;
      const name = String(names[d]?.name ?? "").trim() || d;
      out.push({ browser, profile: d, label: profileLabel(browser, d, name), hosts: [...hosts].sort() });
    }
  }
  return { profiles: out, files, ms: Date.now() - t0 };
}

if (import.meta.main && process.argv.includes("--logins")) {
  let res: LoginScan;
  try { res = readLogins(); } catch (e: any) { res = { profiles: [], files: 0, ms: 0, error: String(e?.message ?? e).slice(0, 200) }; }
  await new Promise<void>((done) => process.stdout.write(JSON.stringify(res), () => done()));
  process.exit(0);
}
