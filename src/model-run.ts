// The small-model engines: headless Claude Code (`claude -p`, no tools) and a local Ollama model, each streaming its
// text back and stopping on a signal. Discover's Mixer, Studio and feed, Opportunities, Research and the Library use them.
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

const HOME = homedir();
const BIN_DIRS = [`${HOME}/.local/bin`, `${HOME}/.claude/local`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH ?? "").split(":")];
const CLAUDE = process.env.DECK_CLAUDE_BIN || BIN_DIRS.map((d) => `${d}/claude`).find((p) => existsSync(p));
/** Whether this machine has Claude Code (DECK_CLAUDE_BIN overrides the search). */
export const claudeInstalled = () => !!CLAUDE;
const OLLAMA_URL = process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "http://127.0.0.1:11434";
export type RunOpts = { system: string; user: string; timeoutMs: number; signal: AbortSignal; onText: (all: string) => void; onStage?: (s: string) => void; model?: string; /** Ollama: ask for JSON output (default true). */ json?: boolean };

/** Headless Claude Code: print mode, no tools, no MCP, no settings or plugins, nothing saved. Streams text as it comes. */
export async function runClaude(o: RunOpts): Promise<{ text: string; model: string }> {
  if (!CLAUDE) throw new Error("Claude Code (claude) isn't installed here");
  const models = o.model ? [o.model] : ["haiku", "sonnet"];
  let lastErr = "";
  for (const model of models) {
    if (o.signal.aborted) break;
    // Fast over deep: little thinking, low effort. Six short ideas don't need a long chain of thought.
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", MAX_THINKING_TOKENS: "0", NO_COLOR: "1" };
    delete env.CLAUDECODE;
    const p = Bun.spawn([CLAUDE, "-p", "--safe-mode", "--model", model, "--effort", "low", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--system-prompt", o.system],
      { cwd: tmpdir(), stdin: new Blob([o.user]), stdout: "pipe", stderr: "pipe", env });
    const kill = () => { try { p.kill(9); } catch {} };
    o.signal.addEventListener("abort", kill, { once: true });
    o.onStage?.("Starting Claude…");
    let text = "", result = "", isErr = false, buf = "";
    try {
      const dec = new TextDecoder();
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          let ev: any; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "system") o.onStage?.("Thinking…");
          else if (ev.type === "stream_event") {
            const d = ev.event?.delta;
            if (d?.type === "text_delta" && d.text) { text += d.text; o.onText(text); }
            else if (d?.type === "thinking_delta") o.onStage?.("Thinking…");
          } else if (ev.type === "assistant" && !text) {
            const t = (ev.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
            if (t) { text = t; o.onText(text); }
          } else if (ev.type === "result") { result = String(ev.result ?? ""); isErr = !!ev.is_error; }
        }
      }
      await p.exited;
    } finally { o.signal.removeEventListener("abort", kill); kill(); }
    if (o.signal.aborted) break;
    const out = result || text;
    if (!isErr && out.trim()) return { text: out, model };
    const err = (await new Response(p.stderr as ReadableStream).text().catch(() => "")).trim();
    lastErr = (isErr ? result : "") || err.split("\n").pop() || "Claude returned nothing";
    // Only a model problem is worth trying the next model for.
    if (!/model|not found|not available|invalid/i.test(lastErr)) break;
  }
  throw new Error(o.signal.aborted ? "cancelled" : lastErr || "Claude returned nothing");
}

/** Chat models Ollama has (embedding and vision-only models left out), best guess first. */
export async function ollamaModels(timeoutMs = 1200): Promise<string[]> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return [];
    const j: any = await r.json();
    const names: string[] = (j.models ?? []).map((m: any) => String(m.name ?? m.model ?? "")).filter(Boolean);
    const chat = names.filter((n) => !/embed|bge|nomic|paraphrase|minilm|llava|vision|rerank|clip/i.test(n));
    const rank = (n: string) => { const fam = ["gemma4", "gemma3", "qwen3", "llama3", "mistral", "phi", "aya"].findIndex((f) => n.includes(f)); return (fam < 0 ? 9 : fam) + (/abliterated|uncensored|hermes/i.test(n) ? 5 : 0); };
    return chat.sort((a, b) => rank(a) - rank(b));
  } catch { return []; }
}
/** A local Ollama model: nothing leaves the machine. Streams tokens, asks for JSON output. */
export async function runOllama(o: RunOpts): Promise<{ text: string; model: string }> {
  const model = o.model || (await ollamaModels())[0];
  if (!model) throw new Error("No Ollama chat model is installed");
  o.onStage?.(`Loading ${model}…`);
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST", signal: o.signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, ...(o.json === false ? {} : { format: "json" }), keep_alive: "10m", options: { temperature: 0.9, num_predict: 3000 }, messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }] }),
  });
  if (!r.ok || !r.body) throw new Error(`Ollama said ${r.status}`);
  let text = "", buf = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body as ReadableStream<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let ev: any; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.error) throw new Error(String(ev.error));
      const t = ev.message?.content ?? "";
      if (t) { if (!text) o.onStage?.("Writing…"); text += t; o.onText(text); }
    }
  }
  return { text, model };
}
