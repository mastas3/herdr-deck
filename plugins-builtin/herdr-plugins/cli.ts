// The herdr binary and socket this deck talks to for workflow plugins. Tests and dev decks point both somewhere else:
// DECK_HERDR_BIN (a fake or wrapped `herdr`) and DECK_HERDR_SOCKET (a scratch server), so nothing reaches the real herdr.
// The CLI answers `--json` / API-backed commands as {"id":…,"result":…} or {"id":…,"error":{code,message}}.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { call, discoverSessions } from "../../src/herdr";

export type Env = (name: string) => string | undefined;
export type RunResult = { code: number; out: string; err: string };

const BIN_DIRS = () => [`${homedir()}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH ?? "").split(":")];

export class HerdrCliError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function createCli(env: Env) {
  const bin = () => env("DECK_HERDR_BIN") || BIN_DIRS().map((d) => `${d}/herdr`).find((p) => existsSync(p));
  /** The default herdr server's socket (plugins are global to the user, so any session's server would do). */
  const socket = () => env("DECK_HERDR_SOCKET") || discoverSessions()[0]?.socket || `${homedir()}/.config/herdr/herdr.sock`;
  /** The deck may itself run inside a herdr pane: never let that pane's ids or socket leak into what we run. */
  const childEnv = () => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v != null && !k.startsWith("HERDR_")) e[k] = v;
    e.HERDR_SOCKET_PATH = socket();
    e.NO_COLOR = "1";
    return e;
  };

  /** Runs `herdr <args>`; `onLine` gets output as it comes (install progress). Never throws for a non-zero exit. */
  async function run(args: string[], o: { timeoutMs?: number; onLine?: (line: string, err: boolean) => void; signal?: AbortSignal } = {}): Promise<RunResult> {
    const b = bin();
    if (!b) throw new HerdrCliError("no_herdr", "herdr isn't installed on this machine");
    const p = Bun.spawn([b, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() });
    const kill = () => { try { p.kill(9); } catch {} };
    o.signal?.addEventListener("abort", kill);
    const timer = setTimeout(kill, o.timeoutMs ?? 15_000);
    const pump = async (s: ReadableStream, isErr: boolean) => {
      let all = "", buf = "";
      const dec = new TextDecoder();
      for await (const chunk of s as any) {
        const t = dec.decode(chunk, { stream: true });
        all += t;
        if (!o.onLine) continue;
        buf += t;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { o.onLine(buf.slice(0, nl), isErr); buf = buf.slice(nl + 1); }
      }
      if (o.onLine && buf) o.onLine(buf, isErr);
      return all;
    };
    try {
      const [out, err, code] = await Promise.all([pump(p.stdout as ReadableStream, false), pump(p.stderr as ReadableStream, true), p.exited]);
      return { code, out, err };
    } finally { clearTimeout(timer); o.signal?.removeEventListener("abort", kill); }
  }

  /** An API-backed command: its JSON result, or a HerdrCliError with herdr's own code and message. */
  async function json<T = any>(args: string[], timeoutMs = 15_000): Promise<T> {
    const r = await run(args, { timeoutMs });
    const line = r.out.trim().split("\n").find((l) => l.startsWith("{"));
    let msg: any;
    try { msg = line ? JSON.parse(line) : undefined; } catch {}
    if (msg?.error) throw new HerdrCliError(msg.error.code ?? "error", msg.error.message ?? "herdr said no");
    if (msg && "result" in msg) return msg.result as T;
    throw new HerdrCliError("bad_output", (r.err || r.out).trim().split("\n").pop() || `herdr exited with ${r.code}`);
  }

  async function version(): Promise<string | undefined> {
    try { return (await run(["--version"], { timeoutMs: 5_000 })).out.match(/(\d+\.\d+\.\d+)/)?.[1]; } catch { return undefined; }
  }

  /** The socket API directly, for what the CLI can't say: an action invoked for a given pane. */
  const api = <T = any>(method: string, params: object, sock?: string) => call<T>(env("DECK_HERDR_SOCKET") || sock || socket(), method, params, 8_000);

  return { bin, socket, run, json, version, api };
}
export type Cli = ReturnType<typeof createCli>;

/** herdr's name for this OS, as manifests list it in `platforms`. */
export const platformName = (p = process.platform) => (p === "darwin" ? "macos" : p === "win32" ? "windows" : p);
