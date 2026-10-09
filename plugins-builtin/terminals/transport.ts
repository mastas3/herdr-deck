import { createHash } from "node:crypto";
import type { Host } from "../../src/plugin-api";

export type TerminalMachine = { id: string; label: string; local: boolean; online: boolean; ssh?: string };
export type Run = (machine: TerminalMachine, args: string[]) => Promise<string>;
export class TerminalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export const terminalSocket = (dir: string) => "deck-term-" + createHash("sha256").update(dir).digest("hex").slice(0, 16);
// A separate server ignores personal tmux configuration and never touches existing tmux sessions.
export const tmuxArgs = (socket: string, args: string[]) => ["tmux", "-u", "-L", socket, "-f", "/dev/null", ...args];
export const terminalPath = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; export PATH; ';
export function terminalCommand(socket: string, args: string[]) {
  // tmux silently falls back to HOME if -c cannot be opened. Check on the target machine first.
  let check = "";
  const cwd = args[0] === "new-session" && args.includes("-c") ? args[args.indexOf("-c") + 1] : "";
  if (cwd) {
    const home = cwd === "#{HOME}" || cwd.startsWith("#{HOME}/");
    const path = (home ? '"$HOME"' : "") + shellQuote((home ? cwd.slice(7) : cwd).replaceAll("##", "#"));
    check = `if ! (cd ${path}) 2>/dev/null; then printf '%s\\n' 'The selected folder no longer exists or cannot be opened.' >&2; exit 72; fi; `;
  }
  return terminalPath + check + "exec " + tmuxArgs(socket, args).map(shellQuote).join(" ");
}
export function terminalMachines(host: Host): TerminalMachine[] {
  const remotes = host.use<Map<string, { conf: { ssh: string } }>>("remotes");
  return host.machines().filter(m => m.kind !== "app").map(m => ({ ...m, ssh: m.local ? undefined : remotes?.get(m.id)?.conf.ssh }));
}
export function createTerminalRunner(socket: string, env = process.env): Run {
  return async (machine, args) => {
    if (!machine.local && (!machine.ssh || machine.ssh.startsWith("-"))) throw new TerminalError("That machine is no longer configured.");
    const command = terminalCommand(socket, args);
    const argv = machine.local ? ["/bin/sh", "-c", command] : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", machine.ssh!, command];
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...env, TMUX: "" } });
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (code) {
        // No server is the normal empty state. Transport failures must remain visible.
        if (args[0] === "list-sessions" && /no server running|error connecting to .*No such file|failed to connect to server/.test(err)) return "";
        if (/tmux: (not found|command not found)|exec: tmux: not found/.test(err)) throw new TerminalError(`Install tmux on ${machine.label} to open terminals.`, 503);
        if (/can't find (session|pane)|no such session|no server running|error connecting to .*No such file/.test(err)) throw new TerminalError("This terminal has ended.", 410);
        throw new TerminalError(`Could not reach the terminal on ${machine.label}: ${err.trim().slice(-350) || "connection timed out"}`, 503);
      }
      return out;
    } finally { clearTimeout(timer); }
  };
}
