// Founder Library: the client for bin/library-bridge.py, the Python process that owns the library's Chroma store and
// drives yt-transcriber. It is started on first use (at low priority), found again through <library>/bridge.json by
// any deck process or the CLI, and exits by itself after 45 idle minutes.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export type BridgeInfo = { pid: number; port: number; token: string };
export type BridgeOpts = { dir: string; ytDir?: string; python?: string };
export type Bridge = {
  available: () => { ok: boolean; why?: string };
  call: <T = any>(path: string, body: unknown, timeoutMs?: number) => Promise<T>;
};

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function ytTranscriberDir() { return process.env.DECK_YT_TRANSCRIBER || `${homedir()}/Documents/Projects/yt-transcriber`; }

export function createBridge(o: BridgeOpts): Bridge {
  const yt = o.ytDir ?? ytTranscriberDir();
  const script = new URL("../bin/library-bridge.py", import.meta.url).pathname;
  const python = o.python ?? process.env.DECK_LIBRARY_PYTHON ?? (existsSync(`${yt}/venv/bin/python`) ? `${yt}/venv/bin/python` : "python3");
  let starting: Promise<BridgeInfo> | undefined;

  const readInfo = (): BridgeInfo | undefined => {
    try { const j = JSON.parse(readFileSync(`${o.dir}/bridge.json`, "utf8")); return j.port && j.token && alive(j.pid) ? j : undefined; } catch { return undefined; }
  };
  const ping = async (i: BridgeInfo) => {
    try { const r = await fetch(`http://127.0.0.1:${i.port}/health`, { method: "POST", headers: { "x-token": i.token }, body: "{}", signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
  };

  async function start(): Promise<BridgeInfo> {
    const had = readInfo();
    if (had && (await ping(had))) return had;
    const before = had?.pid;
    // nice: ingestion is background work; the deck and your agents come first.
    const cmd = process.platform === "win32" ? [python, script] : ["nice", "-n", "10", python, script];
    Bun.spawn([...cmd, "--dir", o.dir, "--yt", yt], { stdin: "ignore", stdout: "ignore", stderr: Bun.file(`${o.dir}/bridge.log`), env: { ...process.env, PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" } }).unref();
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      await Bun.sleep(300);
      const i = readInfo();
      if (i && i.pid !== before && (await ping(i))) return i;
    }
    throw new Error("The library's Python bridge didn't start (see library/bridge.log)");
  }
  async function info() {
    const i = readInfo();
    if (i) return i;
    starting ??= start().finally(() => { starting = undefined; });
    return starting;
  }

  return {
    available() {
      if (!existsSync(`${yt}/rag_corpus.py`)) return { ok: false, why: `yt-transcriber isn't at ${yt}` };
      if (!existsSync(script)) return { ok: false, why: "bin/library-bridge.py is missing" };
      return { ok: true };
    },
    async call(path, body, timeoutMs = 15_000) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const i = await info();
        let r: Response;
        try {
          r = await fetch(`http://127.0.0.1:${i.port}${path}`, { method: "POST", headers: { "x-token": i.token, "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs) });
        } catch (e: any) {
          // A bridge that went away between calls (idle exit, crash) is started again once.
          if (attempt === 0 && !alive(i.pid)) continue;
          throw new Error(e?.name === "TimeoutError" ? "The library bridge took too long" : `Library bridge: ${e?.message ?? e}`);
        }
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Library bridge said ${r.status}`);
        return j;
      }
      throw new Error("The library bridge isn't running");
    },
  };
}
