// Proof of done: when an agent says it's finished, re-run the project's own checks and keep the result.
// Nothing runs until you approve a command for that project once (or edit it); "never" is remembered too.
// Checks only run while the agent is idle, one at a time, and never twice for the same repo state.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const FILE = `${homedir()}/.config/herdr-deck/checks.json`;

export type Approval = { cmd: string; allow: boolean; at: number };
export type CheckResult = {
  state: "needs-approval" | "queued" | "running" | "pass" | "fail" | "error" | "skipped";
  cmd?: string;
  root: string;
  sig?: string; // the repo state it ran against
  exit?: number | null;
  ms?: number;
  at?: number;
  tail?: string[];
  reason?: string;
};

type Store = { approvals: Record<string, Approval>; results: Record<string, CheckResult> };
let store: Store = { approvals: {}, results: {} };
try { store = { approvals: {}, results: {}, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch {}
const save = () => { try { writeFileSync(FILE, JSON.stringify(store, null, 1)); } catch {} };

export const approvalFor = (root: string) => store.approvals[root];
export const resultFor = (root: string) => store.results[root];

/** The command a person would run to check this repo, from its manifest. */
export function detectCheck(root: string): string | undefined {
  const has = (f: string) => existsSync(`${root}/${f}`);
  if (has("package.json")) {
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).scripts ?? {}; } catch {}
    const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const real = (k: string) => scripts[k] && !/no test specified/.test(scripts[k]) && !/\b(watch|--watch|dev)\b/.test(scripts[k]);
    const picks = ["typecheck", "check", "test"].filter(real);
    // typecheck and test together are the usual "is it really done" pair; each alone is fine too.
    const ordered = picks.includes("test") ? [...picks.filter((p) => p !== "test" && p !== "check"), "test"] : picks.slice(0, 1);
    if (ordered.length) return ordered.map((s) => `${pm} run ${s}`).join(" && ");
    if (pm === "bun" && (has("test") || has("tests"))) return "bun test";
    if (real("build")) return `${pm} run build`;
  }
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg")) {
    if (has("tests") || has("test") || has("pytest.ini")) return has("uv.lock") ? "uv run pytest -q" : "pytest -q";
  }
  if (has("Makefile")) {
    try { if (/^test:/m.test(readFileSync(`${root}/Makefile`, "utf8"))) return "make test"; } catch {}
  }
}

export function setApproval(root: string, cmd: string, allow: boolean) {
  store.approvals[root] = { cmd: cmd.trim(), allow, at: Date.now() };
  if (!allow) store.results[root] = { state: "skipped", root, reason: "You turned checks off for this project", at: Date.now() };
  save();
}

async function git(root: string, args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return p.exitCode === 0 ? out : undefined;
}

/** A fingerprint of the working tree: HEAD plus what's uncommitted. Same fingerprint, same result. */
export async function repoSig(root: string): Promise<string | undefined> {
  const [head, status, diff] = await Promise.all([git(root, ["rev-parse", "HEAD"]), git(root, ["status", "--porcelain"]), git(root, ["diff", "HEAD"])]);
  if (head === undefined) return;
  return Bun.hash(`${head}\n${status}\n${diff}`).toString(36);
}

const PATH = [`${homedir()}/.bun/bin`, `${homedir()}/.local/bin`, `${homedir()}/.cargo/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${homedir()}/go/bin`, process.env.PATH ?? ""].join(":");
const TIMEOUT = Number(process.env.DECK_CHECK_TIMEOUT_MS ?? 10 * 60_000);

let queue: { root: string; cmd: string; sig: string; done: (r: CheckResult) => void }[] = [];
let busy = false;
const listeners = new Set<(root: string, r: CheckResult) => void>();
export const onCheck = (fn: (root: string, r: CheckResult) => void) => listeners.add(fn);
const emit = (root: string, r: CheckResult) => { store.results[root] = r; save(); for (const f of listeners) f(root, r); };

async function drain() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  emit(job.root, { state: "running", cmd: job.cmd, root: job.root, sig: job.sig, at: Date.now() });
  const t0 = Date.now();
  let res: CheckResult;
  try {
    // Own process group, so a timeout takes the whole test tree down with it.
    const p = Bun.spawn(["/bin/bash", "-c", job.cmd], { cwd: job.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true } as any);
    const timer = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill(9); } }, TIMEOUT);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(timer);
    const lines = (out + (err ? "\n" + err : "")).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const timedOut = Date.now() - t0 >= TIMEOUT - 50;
    res = { state: p.exitCode === 0 ? "pass" : "fail", cmd: job.cmd, root: job.root, sig: job.sig, exit: p.exitCode, ms: Date.now() - t0, at: Date.now(), tail: lines.slice(-60), reason: timedOut ? "timed out" : undefined };
  } catch (e: any) {
    res = { state: "error", cmd: job.cmd, root: job.root, sig: job.sig, ms: Date.now() - t0, at: Date.now(), reason: String(e?.message ?? e) };
  }
  emit(job.root, res);
  job.done(res);
  busy = false;
  drain();
}

/**
 * Verify a repo now. `force` re-runs even if this exact state already has a result.
 * Returns the (possibly cached, possibly pending) result right away.
 */
export async function verify(root: string, opts: { force?: boolean } = {}): Promise<CheckResult> {
  const appr = store.approvals[root];
  const detected = appr?.cmd ?? detectCheck(root);
  if (!detected) return (store.results[root] = { state: "skipped", root, reason: "No test or typecheck command found", at: Date.now() });
  if (!appr) { const r: CheckResult = { state: "needs-approval", cmd: detected, root, at: Date.now() }; emit(root, r); return r; }
  if (!appr.allow) return store.results[root] ?? { state: "skipped", root, reason: "You turned checks off for this project" };
  const sig = await repoSig(root);
  if (!sig) return { state: "skipped", root, reason: "Not a git repository" };
  const prev = store.results[root];
  if (!opts.force && prev?.sig === sig && prev.state !== "needs-approval") return prev;
  if (queue.some((j) => j.root === root) || (prev?.state === "running" && prev.sig === sig)) return prev!;
  const r: CheckResult = { state: "queued", cmd: appr.cmd, root, sig, at: Date.now() };
  emit(root, r);
  queue.push({ root, cmd: appr.cmd, sig, done: () => {} });
  drain();
  return r;
}

/** "Done", "all tests pass", "fixed", "shipped"… in the agent's last words, and not a question back to you. */
export function claimsDone(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.slice(-2500).toLowerCase();
  const last = t.trim().split("\n").filter(Boolean).pop() ?? "";
  if (/\?\s*$/.test(last) && !/\b(anything else|want me to|should i|shall i)\b/.test(last)) return false;
  return /\b(all (tests|checks) pass|tests? (now )?pass|passing|is (now )?(done|complete|fixed|working|live|deployed)|(it'?s|that'?s|everything'?s|all) (done|live|deployed|fixed|working)|implemented|fixed|shipped|deployed|committed|pushed|verified|ready (for|to) (review|merge|ship))\b/.test(t);
}
