import { TerminalError, shellQuote, terminalPath, tmuxArgs, type Run, type TerminalMachine } from "./transport";

export type Shell = { id: string; kept: boolean; title: string; created: number; until: number; exited: boolean };
const ID = /^deck-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FORMAT = "#{session_name}\t#{@deck-keep}\t#{@deck-title}\t#{session_created}\t#{@deck-until}\t#{pane_dead}";
const KEY: Record<string, string> = { enter: "Enter", tab: "Tab", backspace: "BSpace", esc: "Escape", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", delete: "DC", "shift+tab": "BTab" };
const commands = (all: string[][]) => all.flatMap((a, i) => i ? [";", ...a] : a);
export function parseShells(text: string): Shell[] {
  return text.trim().split("\n").flatMap(line => {
    const [id, kept, title, created, until, exited] = line.split("\t");
    if (!ID.test(id)) return [];
    let name = "Terminal"; try { name = decodeURIComponent(title) || name; } catch {}
    return [{ id, kept: kept === "1", title: name, created: Number(created) * 1000, until: Number(until) || 0, exited: exited === "1" }];
  });
}
export function inputCommands(id: string, ops: any): string[][] {
  if (!Array.isArray(ops) || !ops.length || ops.length > 64) throw new TerminalError("Invalid terminal input.");
  let bytes = 0;
  return ops.map(op => {
    if (typeof op?.text === "string" && op.text.length && op.text.length <= 8192 && !op.key) {
      const b = Buffer.from(op.text); bytes += b.length;
      if (bytes > 16384 || op.text.includes("\0")) throw new TerminalError("Terminal input is too large or contains a null character.");
      // Hex bytes prevent user text (including a lone ;) becoming a tmux command separator.
      return ["send-keys", "-t", `${id}:0.0`, "-H", ...[...b].map(n => n.toString(16).padStart(2, "0"))];
    }
    const k = typeof op?.key === "string" ? op.key : "";
    const mapped = KEY[k] || (/^ctrl\+[a-z]$/.test(k) ? "C-" + k.slice(-1) : "");
    if (!mapped) throw new TerminalError("Unsupported terminal key.");
    return ["send-keys", "-t", `${id}:0.0`, mapped];
  });
}
/** tmux expands formats in -c: escape literal #, while allowing only our HOME expansion. */
export function terminalCwd(raw: unknown) {
  if (raw == null || raw === "" || raw === "~") return "#{HOME}";
  if (typeof raw !== "string" || raw.length > 4096 || /[\x00-\x1f]/.test(raw) || !(raw.startsWith("/") || raw.startsWith("~/"))) throw new TerminalError("Choose an absolute folder path or ~/folder.");
  return raw.startsWith("~/") ? "#{HOME}/" + raw.slice(2).replaceAll("#", "##") : raw.replaceAll("#", "##");
}
export function createShells(run: Run, socket: string, options: { now?: () => number; lease?: number; reapSeconds?: number } = {}) {
  const now = options.now || Date.now, lease = options.lease || 5 * 60_000;
  const locks = new Map<string, Promise<unknown>>();
  const size = (n: unknown, fallback: number, max: number) => typeof n === "number" && Number.isFinite(n) ? Math.max(20, Math.min(max, Math.floor(n))) : fallback;
  function serial<T>(m: TerminalMachine, fn: () => Promise<T>): Promise<T> {
    const p = (locks.get(m.id) || Promise.resolve()).catch(() => {}).then(fn);
    locks.set(m.id, p); p.finally(() => { if (locks.get(m.id) === p) locks.delete(m.id); }).catch(() => {}); return p;
  }
  const list = async (m: TerminalMachine) => parseShells(await run(m, ["list-sessions", "-F", FORMAT]));
  const find = async (m: TerminalMachine, id: string) => {
    if (!ID.test(id)) throw new TerminalError("Invalid terminal identifier.");
    const s = (await list(m)).find(s => s.id === id);
    if (!s) throw new TerminalError("This terminal has ended.", 410);
    return s;
  };
  const leaseArgs = (id: string) => ["set-option", "-t", id, "@deck-until", String(Math.ceil((now() + lease) / 1000))];
  const renew = (m: TerminalMachine, id: string) => run(m, leaseArgs(id));
  const kill = (m: TerminalMachine, id: string) => run(m, ["kill-session", "-t", `${id}`]);
  function watchdog(id: string) {
    const cmd = (args: string[]) => tmuxArgs(socket, args).map(shellQuote).join(" ");
    // Lives with tmux, so an abandoned temporary shell also expires if the deck itself crashes.
    return terminalPath + `while sleep ${options.reapSeconds || 30}; do k=$(${cmd(["show-option", "-qv", "-t", `${id}`, "@deck-keep"])} 2>/dev/null) || exit; [ "$k" = 1 ] && exit; e=$(${cmd(["show-option", "-qv", "-t", `${id}`, "@deck-until"])} 2>/dev/null) || exit; case "$e" in ''|*[!0-9]*) exit;; esac; [ "$(date +%s)" -lt "$e" ] || { ${cmd(["kill-session", "-t", `${id}`])}; exit; }; done`;
  }
  async function action(m: TerminalMachine, b: any) {
    return serial(m, async () => {
      if (b.op === "list") return { terminals: await list(m) };
      const id = b.id;
      if (!ID.test(id || "")) throw new TerminalError("Invalid terminal identifier.");
      if (b.op === "open") {
        const cwd = terminalCwd(b.cwd);
        const all = await list(m), old = all.find(s => s.id === id);
        if (old) { await renew(m, id); return { terminal: old }; }
        if (all.length >= 12) throw new TerminalError("Close a terminal before opening another (12 per machine).", 429);
        try {
          await run(m, commands([
            ["new-session", "-d", "-s", id, "-n", "shell", "-c", cwd, "-x", String(size(b.cols, 100, 240)), "-y", String(size(b.rows, 30, 80))],
            ["set-option", "-t", id, "@deck-keep", "0"], ["set-option", "-t", id, "@deck-title", "Terminal"],
            ["set-window-option", "-t", `${id}:0`, "remain-on-exit", "on"], leaseArgs(id), ["run-shell", "-b", watchdog(id)],
          ]));
          return { terminal: await find(m, id) };
        } catch (e) { await kill(m, id).catch(() => {}); throw e; }
      }
      if (b.op === "close") { if ((await list(m)).some(s => s.id === id)) await kill(m, id); return { ok: true }; }
      const s = await find(m, id);
      if (!s.kept && s.until * 1000 < now()) { await kill(m, id); throw new TerminalError("This temporary terminal expired. Open a fresh one.", 410); }
      if (b.op === "keep") {
        if (typeof b.kept !== "boolean") throw new TerminalError("Choose whether to keep this terminal.");
        const title = typeof b.title === "string" ? b.title.trim().slice(0, 80) : s.title;
        await renew(m, id);
        await run(m, ["set-option", "-t", `${id}`, "@deck-keep", b.kept ? "1" : "0", ";", "set-option", "-t", `${id}`, "@deck-title", encodeURIComponent(title || "Terminal")]);
        if (!b.kept && s.kept) await run(m, ["run-shell", "-b", watchdog(id)]);
        return { terminal: { ...s, kept: b.kept, title: title || "Terminal" } };
      }
      if (b.op === "release") { if (!s.kept) await kill(m, id); return { ok: true }; }
      if (b.op === "read" || b.op === "input") {
        if (b.op === "input") {
          if (s.exited) throw new TerminalError("The shell has exited. Open a new terminal.", 410);
          await run(m, commands([leaseArgs(id), ...inputCommands(id, b.ops)]));
          return { ok: true };
        }
        const args = [leaseArgs(id)];
        if (b.cols && b.rows) args.push(["resize-window", "-t", `${id}:0`, "-x", String(size(b.cols, 100, 240)), "-y", String(size(b.rows, 30, 80))]);
        args.push(["capture-pane", "-p", "-e", "-t", `${id}:0.0`, "-S", "-500"]);
        return { terminal: s, text: await run(m, commands(args)) };
      }
      throw new TerminalError("Unknown terminal action.");
    });
  }
  const cleanup = (m: TerminalMachine) => serial(m, async () => {
    for (const s of await list(m)) if (!s.kept) await kill(m, s.id).catch(() => {});
  });
  return { action, list, cleanup };
}
