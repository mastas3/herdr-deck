// Minimal client for the herdr socket API: newline-delimited JSON over a Unix socket.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

export type HerdrSession = { name: string; socket: string };

export class HerdrError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Every herdr server on this machine: the default one plus named `--session` servers. */
export function discoverSessions(base = `${homedir()}/.config/herdr`): HerdrSession[] {
  const out: HerdrSession[] = [];
  if (existsSync(`${base}/herdr.sock`)) out.push({ name: "default", socket: `${base}/herdr.sock` });
  try {
    for (const d of readdirSync(`${base}/sessions`)) {
      const socket = `${base}/sessions/${d}/herdr.sock`;
      if (existsSync(socket)) out.push({ name: d, socket });
    }
  } catch {}
  return out;
}

let seq = 0;

/** One request per connection: herdr answers in well under a millisecond, so pooling buys nothing. */
export function call<T = any>(socket: string, method: string, params: object = {}, timeoutMs = 4000): Promise<T> {
  const id = `deck_${++seq}`;
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    const finish = (fn: () => void, s?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { s?.end(); } catch {}
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new HerdrError("timeout", `${method} timed out`))), timeoutMs);
    Bun.connect({
      unix: socket,
      socket: {
        open(s) { s.write(JSON.stringify({ id, method, params }) + "\n"); },
        data(s, d) {
          buf += d.toString();
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          let msg: any;
          try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { return finish(() => reject(e), s); }
          if (msg.error) finish(() => reject(new HerdrError(msg.error.code, msg.error.message)), s);
          else finish(() => resolve(msg.result), s);
        },
        close() { finish(() => reject(new HerdrError("closed", `${method}: connection closed`))); },
        error(_s, e) { finish(() => reject(e)); },
      },
    }).catch((e) => finish(() => reject(e)));
  });
}

const EVENT_TYPES = [
  "workspace.created", "workspace.updated", "workspace.renamed", "workspace.closed", "workspace.focused",
  "tab.created", "tab.closed", "tab.focused", "tab.renamed", "tab.moved",
  "pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved", "pane.exited", "pane.agent_detected",
];

/** Long-lived event stream. Calls onEvent for every pushed event; reconnects are the caller's job. */
export async function subscribe(socket: string, onEvent: (ev: any) => void, onClose: () => void) {
  let buf = "";
  const s = await Bun.connect({
    unix: socket,
    socket: {
      open(s) {
        s.write(JSON.stringify({ id: "deck_sub", method: "events.subscribe", params: { subscriptions: EVENT_TYPES.map((type) => ({ type })) } }) + "\n");
      },
      data(_s, d) {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try { onEvent(JSON.parse(line)); } catch {}
        }
      },
      close() { onClose(); },
      error() { onClose(); },
    },
  });
  return () => s.end();
}
