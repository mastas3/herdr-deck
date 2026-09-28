// The providers and models each agent can use, in one shape for the page's model picker: every provider OpenCode is
// connected to, Anthropic for Claude Code, OpenAI for Codex.
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export type ModelInfo = { v: string; l?: string; ctx?: number; price?: { in: number; out: number }; free?: boolean; reasoning?: boolean; efforts?: string[] };
export type ProviderInfo = { id: string; label: string; models: ModelInfo[] };
export type OpencodeCatalog = { providers: ProviderInfo[]; error?: string };

const LABELS: Record<string, string> = { opencode: "OpenCode Zen", openrouter: "OpenRouter", "nano-gpt": "NanoGPT", "abliteration-ai": "abliteration.ai", anthropic: "Anthropic", openai: "OpenAI", google: "Google", xai: "xAI", groq: "Groq", mistral: "Mistral", deepseek: "DeepSeek", ollama: "Ollama" };
export const providerLabel = (id: string) => LABELS[id] ?? id.replace(/-/g, " ");

// A model line has no spaces and holds a "/": provider/model, where the model may hold more slashes, a ":" or a "~"
// (OpenRouter's `~anthropic/…-latest` aliases). The first segment can't be JSON punctuation, so a model's own JSON
// (which is indented, or a lone { or }) never reads as an ID.
const ID_LINE = /^[^\s/{}"]+\/\S+$/;

function modelFrom(v: string, info: any): ModelInfo {
  const m: ModelInfo = { v };
  if (typeof info?.name === "string" && info.name) m.l = info.name;
  const ctx = Number(info?.limit?.context);
  if (ctx > 0) m.ctx = ctx;
  const cin = info?.cost?.input, cout = info?.cost?.output; // USD per million tokens
  if (typeof cin === "number" && typeof cout === "number") { if (cin === 0 && cout === 0) m.free = true; else m.price = { in: cin, out: cout }; }
  if (info?.capabilities?.reasoning === true) m.reasoning = true;
  return m;
}
function group(entries: { id: string; info?: any }[]): ProviderInfo[] {
  const by = new Map<string, ProviderInfo>();
  for (const { id, info } of entries) {
    const pid = id.slice(0, id.indexOf("/"));
    let p = by.get(pid);
    if (!p) by.set(pid, (p = { id: pid, label: providerLabel(pid), models: [] }));
    p.models.push(modelFrom(id, info));
  }
  return [...by.values()];
}

/** `opencode models --verbose`: an ID line, then that model's JSON, repeated. A model whose JSON won't parse is kept bare. */
export function parseOpencodeVerbose(text: string): ProviderInfo[] {
  const entries: { id: string; info?: any }[] = [];
  let id = "", buf: string[] = [];
  const flush = () => {
    if (!id) return;
    let info: any;
    try { info = JSON.parse(buf.join("\n")); } catch {}
    entries.push({ id, info });
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (ID_LINE.test(line)) { flush(); id = line; buf = []; } else if (id) buf.push(line);
  }
  flush();
  return group(entries);
}
/** `opencode models`: one ID per line, no details. */
export const parseOpencodePlain = (text: string): ProviderInfo[] => group(text.split("\n").map((l) => l.trim()).filter((l) => ID_LINE.test(l)).map((id) => ({ id })));

const errorText = (e: any) => (e?.code === "ENOENT" || /ENOENT|no such file|not found/i.test(String(e?.message)) ? "OpenCode isn't installed on this machine" : String(e?.message ?? e));

/** Cached like a small stale-while-revalidate store: a stale list is served at once while one refresh runs, and a failure
 *  is not retried for a minute. A first call waits at most `waitMs` for OpenCode (a cold OpenCode takes 10+ s to answer):
 *  after that the New session dialog opens without the list, and the refresh finishes for the next call. */
export function createOpencodeCatalog(o: { run: (args: string[]) => Promise<string>; now?: () => number; ttlMs?: number; waitMs?: number }) {
  const ttl = o.ttlMs ?? 10 * 60_000, now = o.now ?? Date.now, RETRY = 60_000, waitMs = o.waitMs ?? 2500;
  let cache: { at: number; providers: ProviderInfo[] } | undefined;
  let failed: { at: number; error: string } | undefined;
  let inflight: Promise<OpencodeCatalog> | undefined;
  async function fetchAll(): Promise<OpencodeCatalog> {
    let providers: ProviderInfo[] = [], error = "";
    try { providers = parseOpencodeVerbose(await o.run(["models", "--verbose"])); } catch (e) { error = errorText(e); }
    if (!providers.length) {
      try { providers = parseOpencodePlain(await o.run(["models"])); if (providers.length) error = ""; } catch (e) { error ||= errorText(e); }
    }
    if (providers.length) { cache = { at: now(), providers }; failed = undefined; return { providers }; }
    error ||= "OpenCode returned no models";
    failed = { at: now(), error };
    if (cache) cache = { ...cache, at: now() - ttl + RETRY }; // keep the old list; look again in a minute
    return { providers: cache?.providers ?? [], error };
  }
  const refresh = () => (inflight ??= fetchAll().finally(() => { inflight = undefined; }));
  return {
    async get(): Promise<OpencodeCatalog> {
      if (cache) { if (now() - cache.at > ttl) void refresh(); return { providers: cache.providers }; }
      if (failed && now() - failed.at < RETRY) return { providers: [], error: failed.error };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([refresh(), new Promise<null>((ok) => { timer = setTimeout(() => ok(null), waitMs); })]).finally(() => clearTimeout(timer));
      return r ?? { providers: [], error: "OpenCode is still loading its models" };
    },
    refresh,
  };
}

const HOME = homedir();
const OPENCODE = process.env.DECK_OPENCODE_BIN || [`${HOME}/.opencode/bin`, `${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"].map((d) => `${d}/opencode`).find((p) => existsSync(p)) || "opencode";
/** Runs the opencode CLI (a service's PATH often lacks ~/.opencode/bin) and returns its text. Never inline: it takes ~1 s,
 *  or 12+ s when OpenCode refreshes its own model cache, and killing that early only makes the next try start over. */
export async function runOpencode(args: string[], timeoutMs = 60_000): Promise<string> {
  const p = Bun.spawn([OPENCODE, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, NO_COLOR: "1" } });
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs);
  try {
    const out = await new Response(p.stdout).text();
    if (timedOut) throw new Error("OpenCode didn't answer in time");
    return out.replace(/\x1b\[[0-9;]*m/g, "");
  } finally { clearTimeout(t); }
}
export const opencodeCatalog = createOpencodeCatalog({ run: runOpencode });

export const claudeProvider = (): ProviderInfo => ({ id: "anthropic", label: "Anthropic", models: [{ v: "fable", l: "Fable" }, { v: "opus", l: "Opus" }, { v: "sonnet", l: "Sonnet" }, { v: "haiku", l: "Haiku" }] });
export function codexProvider(models: { v: string; l?: string; efforts?: string[] }[]): ProviderInfo {
  return { id: "openai", label: "OpenAI", models: models.map((m) => ({ v: m.v, ...(m.l ? { l: m.l } : {}), ...(m.efforts?.length ? { efforts: m.efforts, reasoning: true } : {}) })) };
}
/** The flat `{ v, l, efforts }` list the dialog used before providers existed. */
export const flatModels = (providers: ProviderInfo[]) => providers.flatMap((p) => p.models.map((m) => ({ v: m.v, ...(m.l ? { l: m.l } : {}), ...(m.efforts ? { efforts: m.efforts } : {}) })));
