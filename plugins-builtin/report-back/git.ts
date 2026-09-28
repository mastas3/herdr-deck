// What a turn changed in git: the uncommitted diff against HEAD plus the commits made since the turn began.
// Numbers only (files, lines added and removed, commits); a folder that isn't a repo gives nothing.

async function git(cwd: string, args: string[], timeoutMs = 4000): Promise<string | undefined> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  return p.exitCode === 0 ? out : undefined;
}

/** Sums `--numstat` lines ("12\t3\tpath"; binary files are "-\t-\tpath") into the totals. */
export function addNumstat(out: string, t: { files: Set<string>; add: number; del: number }) {
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    t.files.add(m[3]);
    t.add += m[1] === "-" ? 0 : Number(m[1]);
    t.del += m[2] === "-" ? 0 : Number(m[2]);
  }
}

export async function gitDelta(cwd: string, since?: number) {
  if (!cwd || (await git(cwd, ["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return;
  const t = { files: new Set<string>(), add: 0, del: 0 };
  let commits = 0;
  if (since) {
    const log = await git(cwd, ["log", `--since=@${Math.floor(since / 1000)}`, "--numstat", "--format=@@%H"]);
    if (log) { commits = (log.match(/^@@/gm) ?? []).length; addNumstat(log, t); }
  }
  const diff = await git(cwd, ["diff", "--numstat", "HEAD"]);
  if (diff) addNumstat(diff, t);
  return { files: t.files.size, add: t.add, del: t.del, commits };
}
