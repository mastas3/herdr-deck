// The GitHub CLI (`gh api`), async, with a timeout, for Discover's searches and Leads' GitHub issues.
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const BIN_DIRS = [`${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":")];
const GH = BIN_DIRS.map((d) => `${d}/gh`).find((p) => existsSync(p));
export const ghAvailable = () => !!GH;
/** Where `gh` is, for commands other than `gh api` (a pull request from a worktree). */
export const ghPath = () => GH;
export type GhRes = { ok: boolean; status: number; data?: any; error?: string; remaining?: number; reset?: number };
export async function gh(args: string[], timeoutMs = 15_000): Promise<GhRes> {
  if (!GH) return { ok: false, status: 0, error: "The GitHub CLI (gh) isn't installed" };
  let p: ReturnType<typeof Bun.spawn> | undefined;
  try {
    p = Bun.spawn([GH, "api", "-i", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
    const read = (async () => [await new Response(p!.stdout as ReadableStream).text(), await new Response(p!.stderr as ReadableStream).text()] as const)();
    const got = await Promise.race([read, Bun.sleep(timeoutMs).then(() => null)]);
    if (!got) return { ok: false, status: 0, error: "GitHub didn't answer in time" };
    const [out, err] = got;
    const cut = out.search(/\r?\n\r?\n/);
    const head = cut >= 0 ? out.slice(0, cut) : "";
    const body = cut >= 0 ? out.slice(cut).trim() : out.trim();
    const status = Number(head.match(/^HTTP\/[\d.]+\s+(\d+)/)?.[1] ?? 0);
    const hdr = (k: string) => head.match(new RegExp(`^${k}:\\s*(\\S+)`, "im"))?.[1];
    let data: any; try { data = JSON.parse(body); } catch {}
    const remaining = hdr("x-ratelimit-remaining") != null ? Number(hdr("x-ratelimit-remaining")) : undefined;
    const reset = hdr("x-ratelimit-reset") != null ? Number(hdr("x-ratelimit-reset")) * 1000 : undefined;
    const ok = status >= 200 && status < 300 && !!data;
    return { ok, status, data, remaining, reset, error: ok ? undefined : data?.message ?? (err.trim().split("\n").pop() || `GitHub said ${status || "nothing"}`) };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  } finally {
    try { p?.kill(9); } catch {}
  }
}
