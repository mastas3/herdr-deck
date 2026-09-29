// A pull request from a worktree's branch: only when `gh` is signed in for the repo's GitHub host. The dialog shows
// both commands before you confirm; they run in the worktree.
import { ghPath } from "./gh";
import { git, gitError } from "./wt-git";
import { WtError, type WtStatus } from "./wt-ops";

/** "github.com" from an https or ssh remote URL. */
export function remoteHost(url: string) {
  return url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i)?.[1] ?? url.match(/^[^@\s]+@([^:]+):/)?.[1];
}

async function run(cmd: string[], cwd: string, timeoutMs: number) {
  const p = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/** Whether a PR can be opened from here, and the exact commands. */
export async function prPlan(s: Pick<WtStatus, "path" | "branch" | "base">) {
  const gh = ghPath();
  const url = (await git(s.path, ["remote", "get-url", "origin"], 5000)).out.trim();
  const host = url ? remoteHost(url) : undefined;
  const commands = [`git push -u origin ${s.branch}`, `gh pr create --base ${s.base} --head ${s.branch} --fill`];
  if (!gh) return { ok: false, why: "The GitHub CLI (gh) isn't installed on this machine", commands };
  if (!host) return { ok: false, why: "This repo has no “origin” remote to push to", commands };
  const auth = await run([gh, "auth", "status", "--hostname", host], s.path, 10_000);
  if (!auth.ok) return { ok: false, why: `gh isn't signed in to ${host} (run \`gh auth login\` there)`, commands };
  return { ok: true, host, commands };
}

export async function openPr(s: Pick<WtStatus, "path" | "branch" | "base">) {
  const plan = await prPlan(s);
  if (!plan.ok) throw new WtError(plan.why!, 409);
  const push = await git(s.path, ["push", "-u", "origin", s.branch], 120_000);
  if (!push.ok) throw new WtError(`git push failed: ${gitError(push)}`, 409);
  const pr = await run([ghPath()!, "pr", "create", "--base", s.base, "--head", s.branch, "--fill"], s.path, 60_000);
  if (!pr.ok) throw new WtError(`gh pr create failed: ${pr.err.split("\n").pop() || "no reason given"}`, 409);
  return { ok: true, url: pr.out.split("\n").filter((l) => /^https?:\/\//.test(l)).pop() ?? pr.out.split("\n").pop() };
}
