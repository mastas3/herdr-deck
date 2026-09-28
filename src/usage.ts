// Plan usage for the header: Claude's rate-limit cache and the newest Codex session's rate limits. Core (src/http/live.ts
// polls it); the connections scan reads the Codex plan from here too.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
/** JSON, tolerating a BOM. */
const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return undefined; } };
const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };

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
