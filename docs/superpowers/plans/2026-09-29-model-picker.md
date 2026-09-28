# Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model choice in the deck becomes a searchable Provider + Model picker, and OpenCode's connected providers and all their models are listed in it.

**Architecture:** A server catalog (`src/model-catalog.ts`) turns `opencode models --verbose`, the Claude aliases and Codex's model cache into one `providers → models` shape, cached with stale-while-revalidate. On the page, a pure search module (`model-search.js`) and a DOM module (`model-picker.js`, a registry plus an HTML string plus one delegated listener, because three screens rebuild their markup with `innerHTML`) render two buttons that open a top-layer popover list. Four screens switch to it: New session, Codex task settings, Research, Studio engine.

**Tech Stack:** Bun + TypeScript (server), vanilla JS/CSS classic scripts sharing one global scope (page), `bun test`, the Popover API, node + global Playwright (`bin/ui-snapshot.mjs`). No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-09-29-model-picker-design.md` (approved 2026-09-29)

## Global Constraints

- One Bun process, no dependencies, no build step: no `npm install`, no bundler, no framework.
- Keep each page file under 400 lines; `test/assets.test.ts` checks that and that no two scripts declare the same top-level name. Prefix new names with `mp` or `model`.
- The server caches the HTML at startup: restart the deck (`bin/install.sh`) or use `bun run dev` after UI edits.
- Nothing blocks the event loop: OpenCode is spawned, never run inline, and cached.
- Bind to `127.0.0.1` only; keep the Host check, the action token and the Tailscale login check. Never add `tailscale funnel`. Do not touch port 8448 or 4747.
- Match the surrounding code: short direct comments that explain why, plain-English UI text.
- Must work on macOS and Linux; guard platform-specific calls.
- Run `bun test` before every commit; a test deck on port 4799 must be fully isolated (see Task 8).
- The value each screen sends is unchanged: `fable`/`opus`/… for Claude, a Codex slug, `provider/model` for OpenCode, `claude:haiku`, `ollama:<x>`, `template` for Studio. Saved `opts:<kind>` keep working.
- Commit messages end with the line `Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR`.

## Review Focus

The spec is silent on these; each has a test in the task that owns the code.

1. **OpenCode IDs that are not plain `word/word`.** `openrouter/~anthropic/claude-sonnet-latest`, IDs with `:` and extra `/`. Today's filter drops 238 of 998. Expected: all kept. (Task 1)
2. **Regex characters in the search box** (`c++`, `gpt-4.1`, `(`, `[`, `\`). Expected: no exception, literal matching. (Task 3)
3. **HTML in a model name, an ID or the typed query.** Expected: shown as text in rows, highlights and the "Use 'x'" row, never parsed. (Tasks 3 and 4)
4. **OpenCode missing or hanging.** Expected: the dialog opens at once with a short reason, typing an ID still works, and repeated opens do not spawn the process each time. (Tasks 1 and 4)
5. **A saved model that is no longer offered** (an uninstalled Codex model, a removed OpenRouter one). Expected: stays selected, labelled custom, never silently reset to Default. (Tasks 3 and 4)

---

### Task 1: The model catalog (server)

**Files:**
- Create: `src/model-catalog.ts`
- Test: `test/model-catalog.test.ts`

**Interfaces:**
- Produces (Task 2 relies on these exact names):
  - `type ModelInfo = { v: string; l?: string; ctx?: number; price?: { in: number; out: number }; free?: boolean; reasoning?: boolean; efforts?: string[] }`
  - `type ProviderInfo = { id: string; label: string; models: ModelInfo[] }`
  - `type OpencodeCatalog = { providers: ProviderInfo[]; error?: string }`
  - `providerLabel(id: string): string`
  - `parseOpencodeVerbose(text: string): ProviderInfo[]`, `parseOpencodePlain(text: string): ProviderInfo[]`
  - `createOpencodeCatalog(o: { run: (args: string[]) => Promise<string>; now?: () => number; ttlMs?: number }): { get(): Promise<OpencodeCatalog>; refresh(): Promise<OpencodeCatalog> }`
  - `runOpencode(args: string[], timeoutMs?: number): Promise<string>`, `opencodeCatalog` (the shared instance)
  - `claudeProvider(): ProviderInfo`, `codexProvider(models: { v: string; l?: string; efforts?: string[] }[]): ProviderInfo`, `flatModels(providers: ProviderInfo[]): { v: string; l?: string; efforts?: string[] }[]`

- [ ] **Step 1: Write the failing tests**

Create `test/model-catalog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { claudeProvider, codexProvider, createOpencodeCatalog, flatModels, parseOpencodePlain, parseOpencodeVerbose, providerLabel } from "../src/model-catalog";

// `opencode models --verbose`: a provider/model line at column 0, then that model's pretty-printed JSON.
const VERBOSE = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 200000, "output": 32000 },
  "capabilities": { "reasoning": true }
}
openrouter/anthropic/claude-sonnet-4.5
{
  "id": "anthropic/claude-sonnet-4.5",
  "providerID": "openrouter",
  "name": "Claude Sonnet 4.5",
  "cost": { "input": 3, "output": 15 },
  "limit": { "context": 1000000 },
  "capabilities": { "reasoning": false }
}
openrouter/~anthropic/claude-sonnet-latest
{
  "name": "Claude Sonnet Latest",
  "cost": { "input": 3, "output": 15 },
  "limit": { "context": 200000 }
}
nano-gpt/deepseek/deepseek-r1:free
{ this is not json
}
`;

describe("parsing OpenCode's model list", () => {
  test("groups the verbose output by provider, in the order OpenCode lists them, with labels and details", () => {
    const ps = parseOpencodeVerbose(VERBOSE);
    expect(ps.map((p) => [p.id, p.label, p.models.length])).toEqual([["opencode", "OpenCode Zen", 1], ["openrouter", "OpenRouter", 2], ["nano-gpt", "NanoGPT", 1]]);
    expect(ps[0].models[0]).toEqual({ v: "opencode/big-pickle", l: "Big Pickle", ctx: 200000, free: true, reasoning: true });
    expect(ps[1].models[0]).toEqual({ v: "openrouter/anthropic/claude-sonnet-4.5", l: "Claude Sonnet 4.5", ctx: 1000000, price: { in: 3, out: 15 } });
  });
  test("keeps IDs that are not plain word/word: a ~ alias, a : suffix, extra slashes", () => {
    const ids = parseOpencodeVerbose(VERBOSE).flatMap((p) => p.models.map((m) => m.v));
    expect(ids).toContain("openrouter/~anthropic/claude-sonnet-latest");
    expect(ids).toContain("nano-gpt/deepseek/deepseek-r1:free");
    expect(parseOpencodePlain("openrouter/~google/gemini-pro-latest\nopenrouter/a/b/c").flatMap((p) => p.models.map((m) => m.v))).toEqual(["openrouter/~google/gemini-pro-latest", "openrouter/a/b/c"]);
  });
  test("a model whose JSON is broken is still listed, with no details", () => {
    expect(parseOpencodeVerbose(VERBOSE).at(-1)!.models).toEqual([{ v: "nano-gpt/deepseek/deepseek-r1:free" }]);
  });
  test("plain output: IDs only; error text and blank lines are ignored", () => {
    const ps = parseOpencodePlain("opencode/a\n\nError: something went wrong\nopenrouter/x/y\nopencode/b\n");
    expect(ps.map((p) => [p.id, p.models.map((m) => m.v)])).toEqual([["opencode", ["opencode/a", "opencode/b"]], ["openrouter", ["openrouter/x/y"]]]);
  });
  test("an unknown provider is labelled with its ID, dashes as spaces", () => {
    expect(providerLabel("some-new-provider")).toBe("some new provider");
    expect(providerLabel("openrouter")).toBe("OpenRouter");
  });
});

/** A fake `opencode`: counts its calls and answers from a table. */
function fake(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    const a = answers[key];
    if (a instanceof Error) throw a;
    return a ?? "";
  };
  return { run, calls };
}

describe("the OpenCode catalog", () => {
  test("serves the cache while it is fresh, then the old list at once while it refreshes in the background", async () => {
    let t = 0;
    const f = fake({ "models --verbose": VERBOSE });
    const cat = createOpencodeCatalog({ run: f.run, now: () => t, ttlMs: 1000 });
    expect((await cat.get()).providers.length).toBe(3);
    t = 500; await cat.get();
    expect(f.calls).toEqual(["models --verbose"]);
    t = 1500;
    const stale = await cat.get(); // returns immediately with the old list…
    expect(stale.providers.length).toBe(3);
    await cat.refresh(); // …and the refresh was already running
    expect(f.calls).toEqual(["models --verbose", "models --verbose"]);
  });
  test("falls back to the plain list when the verbose one is empty", async () => {
    const f = fake({ "models --verbose": "", "models": "opencode/a\nopenrouter/b/c" });
    const r = await createOpencodeCatalog({ run: f.run }).get();
    expect(r.error).toBeUndefined();
    expect(r.providers.map((p) => p.id)).toEqual(["opencode", "openrouter"]);
  });
  test("not installed: an empty list with a plain reason, and it is not retried for a minute", async () => {
    let t = 0;
    const f = fake({ "models --verbose": Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }), "models": Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }) });
    const cat = createOpencodeCatalog({ run: f.run, now: () => t });
    expect(await cat.get()).toEqual({ providers: [], error: "OpenCode isn't installed on this machine" });
    const n = f.calls.length;
    t = 30_000; await cat.get(); await cat.get();
    expect(f.calls.length).toBe(n); // no respawn while it is known to be missing
    t = 61_000; await cat.get();
    expect(f.calls.length).toBeGreaterThan(n);
  });
  test("a failed refresh keeps the old list and waits a minute before trying again", async () => {
    let t = 0, fail = false;
    const calls: string[] = [];
    const run = async (args: string[]) => { calls.push(args.join(" ")); if (fail) throw new Error("boom"); return VERBOSE; };
    const cat = createOpencodeCatalog({ run, now: () => t, ttlMs: 1000 });
    await cat.get();
    fail = true; t = 2000;
    expect((await cat.get()).providers.length).toBe(3);
    await cat.refresh();
    const n = calls.length;
    t = 2500; await cat.get();
    expect(calls.length).toBe(n); // backed off: it does not look again yet
    t = 62_001; await cat.get(); await cat.refresh(); // stale again: one more try (the refresh is already in flight)
    expect(calls.length).toBeGreaterThan(n);
  });
  test("concurrent first calls share one spawn", async () => {
    const f = fake({ "models --verbose": VERBOSE });
    const cat = createOpencodeCatalog({ run: f.run });
    await Promise.all([cat.get(), cat.get(), cat.get()]);
    expect(f.calls).toEqual(["models --verbose"]);
  });
});

describe("the other agents' providers", () => {
  test("Claude is one provider with the four aliases; Codex is OpenAI with each model's efforts", () => {
    expect(claudeProvider()).toEqual({ id: "anthropic", label: "Anthropic", models: [{ v: "fable", l: "Fable" }, { v: "opus", l: "Opus" }, { v: "sonnet", l: "Sonnet" }, { v: "haiku", l: "Haiku" }] });
    const cx = codexProvider([{ v: "gpt-5", l: "GPT-5", efforts: ["low", "high"] }, { v: "plain" }]);
    expect(cx).toEqual({ id: "openai", label: "OpenAI", models: [{ v: "gpt-5", l: "GPT-5", efforts: ["low", "high"], reasoning: true }, { v: "plain" }] });
  });
  test("flatModels gives the old flat list back", () => {
    expect(flatModels([claudeProvider(), codexProvider([{ v: "gpt-5", efforts: ["low"] }])]).map((m) => m.v)).toEqual(["fable", "opus", "sonnet", "haiku", "gpt-5"]);
    expect(flatModels([codexProvider([{ v: "gpt-5", l: "GPT-5", efforts: ["low"] }])])).toEqual([{ v: "gpt-5", l: "GPT-5", efforts: ["low"] }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/model-catalog.test.ts`
Expected: FAIL (`Cannot find module "../src/model-catalog"`).

- [ ] **Step 3: Write the implementation**

Create `src/model-catalog.ts`:

```ts
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
 *  is not retried for a minute, so a missing or hanging OpenCode never makes the New session dialog wait twice. */
export function createOpencodeCatalog(o: { run: (args: string[]) => Promise<string>; now?: () => number; ttlMs?: number }) {
  const ttl = o.ttlMs ?? 10 * 60_000, now = o.now ?? Date.now, RETRY = 60_000;
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
      return refresh();
    },
    refresh,
  };
}

const HOME = homedir();
const OPENCODE = process.env.DECK_OPENCODE_BIN || [`${HOME}/.opencode/bin`, `${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"].map((d) => `${d}/opencode`).find((p) => existsSync(p)) || "opencode";
/** Runs the opencode CLI (a service's PATH often lacks ~/.opencode/bin) and returns its text. Never inline: it takes ~2 s. */
export async function runOpencode(args: string[], timeoutMs = 20_000): Promise<string> {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/model-catalog.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Check the parser against the real CLI**

Run:
```bash
cd /Users/stas-2/Documents/Projects/herdr-deck && bun -e 'import { runOpencode, parseOpencodeVerbose } from "./src/model-catalog"; const t = Date.now(); const ps = parseOpencodeVerbose(await runOpencode(["models", "--verbose"])); console.log(Date.now() - t, "ms", ps.map((p) => p.id + " " + p.models.length).join(", "), "total", ps.reduce((n, p) => n + p.models.length, 0));'
```
Expected: about 2000 ms, a line like `opencode 8, nano-gpt 602, openrouter 385, abliteration-ai 3 total 998` (order and counts follow this machine's connections; the total must equal `opencode models | wc -l`).

- [ ] **Step 6: Commit**

```bash
git add src/model-catalog.ts test/model-catalog.test.ts
git commit -m "Add the model catalog: providers and models for OpenCode, Claude and Codex" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

---

### Task 2: New session options use the catalog

**Files:**
- Modify: `src/http/new-session.ts:1-58` (imports, the old `opencodeModels`, `agentChoices`)
- Modify: `src/server.ts` (import, and one warm-up line after `setTimeout(warmSlash, 8_000);`)
- Test: `test/new-session-choices.test.ts`

**Interfaces:**
- Consumes: `opencodeCatalog`, `claudeProvider`, `codexProvider`, `flatModels`, `OpencodeCatalog` from Task 1.
- Produces: `agentChoices(oc?: { get(): Promise<OpencodeCatalog> })` exported from `src/http/new-session.ts`. Each of `choices.claude|codex|opencode` gains `providers: ProviderInfo[]`; `choices.opencode` gains `error?: string`; every existing field (`models` flat with the leading `{ v: "", l: "Default" }`, `efforts`, `modes`, `defaultEffort`) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/new-session-choices.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseOpencodePlain } from "../src/model-catalog";
import { agentChoices } from "../src/http/new-session";

describe("what the New session dialog is offered", () => {
  test("every agent carries its providers, and the flat model list is what it was", async () => {
    const c = await agentChoices({ get: async () => ({ providers: parseOpencodePlain("opencode/a\nopenrouter/b/c\nopenrouter/~d/e") }) });
    expect(c.claude.providers.map((p) => p.label)).toEqual(["Anthropic"]);
    expect(c.claude.models.map((m) => m.v)).toEqual(["", "fable", "opus", "sonnet", "haiku"]);
    expect(c.claude.models[0]).toEqual({ v: "", l: "Default" });
    expect(c.opencode.providers.map((p) => [p.id, p.models.length])).toEqual([["opencode", 1], ["openrouter", 2]]);
    expect(c.opencode.models.map((m) => m.v)).toEqual(["", "opencode/a", "openrouter/b/c", "openrouter/~d/e"]);
    expect(c.opencode.efforts).toEqual([]);
    expect(c.opencode.modes.map((m) => m.v)).toEqual(["", "plan"]);
    expect("error" in c.opencode).toBe(false);
    expect(c.codex.providers[0].label).toBe("OpenAI"); // present even when this machine has no Codex model cache
  });
  test("when OpenCode is unavailable the reason travels with an empty provider list", async () => {
    const c = await agentChoices({ get: async () => ({ providers: [], error: "OpenCode isn't installed on this machine" }) });
    expect(c.opencode.providers).toEqual([]);
    expect(c.opencode.error).toBe("OpenCode isn't installed on this machine");
    expect(c.opencode.models).toEqual([{ v: "", l: "Default" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/new-session-choices.test.ts`
Expected: FAIL (`agentChoices` is not exported).

- [ ] **Step 3: Rewrite the top of `src/http/new-session.ts`**

Replace lines 1 to 58 (from the file's first comment through the end of `agentChoices`) with:

```ts
// What the New session dialog offers: folders you work in, each agent's providers, models, efforts and modes, and the
// flags you tend to start each agent with.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { Deck } from "../deck";
import type { Graves } from "./config";
import { claudeProvider, codexProvider, flatModels, opencodeCatalog, type OpencodeCatalog } from "../model-catalog";

type Opt = { v: string; l?: string; efforts?: string[] };

function codexChoices() {
  let models: Opt[] = [], defModel = "", defEffort = "";
  try {
    const d = JSON.parse(readFileSync(`${homedir()}/.codex/models_cache.json`, "utf8"));
    const arr = Array.isArray(d) ? d : d.models ?? [];
    models = arr.map((m: any) => ({ v: m.slug ?? m.id, l: m.display_name ?? undefined, efforts: (m.supported_reasoning_levels ?? []).map((x: any) => x.effort ?? x).filter(Boolean) })).filter((m: Opt) => m.v);
  } catch {}
  try {
    const cfg = readFileSync(`${homedir()}/.codex/config.toml`, "utf8");
    defModel = cfg.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    defEffort = cfg.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  } catch {}
  return { models, defModel, defEffort };
}

/** `oc` is injectable so a test needn't run OpenCode. `models` stays the flat list (with "Default" first); `providers`
 *  is the same models grouped for the page's picker. */
export async function agentChoices(oc: { get(): Promise<OpencodeCatalog> } = opencodeCatalog) {
  const cx = codexChoices();
  const ocat = await oc.get();
  const claude = [claudeProvider()], codex = [codexProvider(cx.models)];
  return {
    claude: {
      models: [{ v: "", l: "Default" }, ...flatModels(claude)],
      providers: claude,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      modes: [{ v: "", l: "Ask first" }, { v: "acceptEdits", l: "Accept edits" }, { v: "auto", l: "Auto" }, { v: "plan", l: "Plan only" }, { v: "bypassPermissions", l: "Skip all checks" }],
    },
    codex: {
      models: [{ v: "", l: `Default${cx.defModel ? ` (${cx.defModel})` : ""}` }, ...cx.models],
      providers: codex,
      efforts: [...new Set(cx.models.flatMap((m) => m.efforts ?? []))],
      defaultEffort: cx.defEffort,
      modes: [{ v: "", l: "Default" }, { v: "read-only", l: "Read only" }, { v: "workspace-write", l: "Workspace write" }, { v: "yolo", l: "No sandbox, no approvals" }],
    },
    opencode: {
      models: [{ v: "", l: "Default" }, ...flatModels(ocat.providers)],
      providers: ocat.providers,
      ...(ocat.error ? { error: ocat.error } : {}),
      efforts: [],
      modes: [{ v: "", l: "Build (default)" }, { v: "plan", l: "Plan" }],
    },
  };
}
```

Leave everything from `export const AGENT_KINDS = …` onward untouched.

- [ ] **Step 4: Warm the OpenCode list at startup**

In `src/server.ts`, add next to the `warmSlash` import (line 6):

```ts
import { opencodeCatalog } from "./model-catalog";
```

and directly after the line `setTimeout(warmSlash, 8_000);` add:

```ts
// The New session dialog lists every OpenCode model; the first read takes ~2 s, so do it before anyone opens the dialog.
setTimeout(() => void opencodeCatalog.get(), 3_000);
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/new-session-choices.test.ts test/model-catalog.test.ts`
Expected: PASS.

Then the whole suite: `bun test`
Expected: PASS (nothing else reads `opencodeModels`; if a test fails on the removed function, it was reading the old private helper: update it to `agentChoices`).

- [ ] **Step 6: Check it against the real OpenCode**

Run:
```bash
cd /Users/stas-2/Documents/Projects/herdr-deck && bun -e 'import { agentChoices } from "./src/http/new-session"; const t = Date.now(); const o = (await agentChoices()).opencode; console.log(Date.now() - t, "ms", o.providers.map((p) => p.id + ":" + p.models.length).join(" "), "flat", o.models.length, "error", o.error ?? "none");'
```
Expected: about 2000 ms once (the first read), providers such as `opencode:8 nano-gpt:602 openrouter:385 abliteration-ai:3` (this machine's connections), `flat` equal to the total plus 1 (998 + 1 = 999), `error none`. The HTTP route itself (`/api/new-options`, which needs the deck's action token) is exercised by the snapshot views in Task 4 and the click-through in Task 8.

- [ ] **Step 7: Commit**

```bash
git add src/http/new-session.ts src/server.ts test/new-session-choices.test.ts
git commit -m "New session options carry providers, from the catalog; warm the OpenCode list at startup" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

---

### Task 3: The pure search helpers (page)

**Files:**
- Create: `public/js/model-search.js`
- Modify: `public/assets.json` (add the script after `js/format.js`)
- Test: `test/model-picker.test.ts`

**Interfaces:**
- Produces (Task 4 relies on these exact names; all top-level declarations, no DOM):
  - `MODEL_MAX_ROWS = 60`
  - `modelEsc(s): string`
  - `modelSearch(models, query, max = MODEL_MAX_ROWS): { rows: Model[]; total: number }`: every word must match; empty query returns the first `max` in order.
  - `modelMarks(text, query): string`: HTML-safe text with `<mark>` around matches.
  - `modelRecent(list: string[], value: string, max = 5): string[]`
  - `modelFind(providers, v): { m, p } | null`
  - `modelCtx(n): string`, `modelPrice(p): string`, `modelBadges(m): { k: string; t: string; title?: string }[]`
  - where `Model = { v, l?, ctx?, price?, free?, reasoning?, efforts?, note? }` (`note` is a short page-only label such as "private").

- [ ] **Step 1: Write the failing tests**

Create `test/model-picker.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// model-search.js is pure (no DOM), so run the whole file.
const src = readFileSync(new URL("../public/js/model-search.js", import.meta.url), "utf8");
const { MODEL_MAX_ROWS, modelSearch, modelMarks, modelRecent, modelFind, modelCtx, modelPrice, modelBadges } = new Function(`${src}; return { MODEL_MAX_ROWS, modelSearch, modelMarks, modelRecent, modelFind, modelCtx, modelPrice, modelBadges };`)();
const ids = (r: any) => r.rows.map((m: any) => m.v);

describe("searching models", () => {
  const list = [
    { v: "x/foo-claude", l: "Foo Claude" },
    { v: "x/claude-1", l: "Claude One" },
    { v: "x/anthropic/claude-2" },
    { v: "x/reclaude" },
    { v: "x/gpt-4" },
    { v: "x/gpt-4.1", l: "GPT 4.1" },
  ];
  test("an empty query keeps the order and reports the total", () => {
    const r = modelSearch(list, "  ");
    expect(ids(r)).toEqual(list.map((m) => m.v));
    expect(r.total).toBe(6);
  });
  test("ranks a name prefix, then a word start, then anything else; ties keep the original order", () => {
    expect(ids(modelSearch(list, "claude"))).toEqual(["x/claude-1", "x/foo-claude", "x/anthropic/claude-2", "x/reclaude"]);
  });
  test("every word must match, in any order", () => {
    expect(ids(modelSearch(list, "one claude"))).toEqual(["x/claude-1"]);
    expect(ids(modelSearch(list, "claude nothing"))).toEqual([]);
  });
  test("an exact ID comes first", () => {
    expect(ids(modelSearch(list, "x/gpt-4"))[0]).toBe("x/gpt-4");
  });
  test("draws at most 60 rows but reports how many matched, so 998 models stay instant", () => {
    const many = Array.from({ length: 998 }, (_, i) => ({ v: `p/m${i}` }));
    const r = modelSearch(many, "m");
    expect(MODEL_MAX_ROWS).toBe(60);
    expect([r.rows.length, r.total]).toEqual([60, 998]);
    expect(modelSearch(many, "").rows.length).toBe(60);
  });
  test("regex characters are literal: c++, gpt-4.1, (, [ and a backslash never throw or over-match", () => {
    const odd = [{ v: "x/c++" }, { v: "x/cc" }, { v: "x/gpt-4.1" }, { v: "x/gpt-4x1" }, { v: "x/(paren" }, { v: "x/[br" }, { v: "x/a\\b" }];
    expect(ids(modelSearch(odd, "c++"))).toEqual(["x/c++"]);
    expect(ids(modelSearch(odd, "gpt-4.1"))).toEqual(["x/gpt-4.1"]);
    for (const q of ["(", "[", "\\", ")", "*", "?", "$", "^", "|"]) expect(() => modelSearch(odd, q)).not.toThrow();
    expect(ids(modelSearch(odd, "("))).toEqual(["x/(paren"]);
    expect(ids(modelSearch(odd, "["))).toEqual(["x/[br"]);
    expect(ids(modelSearch(odd, "\\"))).toEqual(["x/a\\b"]);
  });
  test("finds ~ aliases and slashes in the ID", () => {
    const m = [{ v: "openrouter/~anthropic/claude-sonnet-latest", l: "Claude Sonnet Latest" }];
    expect(ids(modelSearch(m, "~anthropic"))).toEqual([m[0].v]);
    expect(ids(modelSearch(m, "openrouter/~anthropic"))).toEqual([m[0].v]);
  });
});

describe("highlighting", () => {
  test("wraps matches, ignoring case, and merges overlaps", () => {
    expect(modelMarks("Claude Sonnet", "son")).toBe("Claude <mark>Son</mark>net");
    expect(modelMarks("Claude Sonnet", "son sonnet")).toBe("Claude <mark>Sonnet</mark>");
    expect(modelMarks("abc", "")).toBe("abc");
  });
  test("HTML in a name, an ID or the query is shown as text, never parsed", () => {
    expect(modelMarks("A<b>", "b")).toBe("A&lt;<mark>b</mark>&gt;");
    expect(modelMarks('<img src=x onerror="alert(1)">', "img")).toBe('&lt;<mark>img</mark> src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(modelMarks("plain", "<script>")).toBe("plain");
  });
});

describe("recent models", () => {
  test("newest first, no duplicates, at most five, empty values ignored", () => {
    expect(modelRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(modelRecent(["1", "2", "3", "4", "5"], "6")).toEqual(["6", "1", "2", "3", "4"]);
    expect(modelRecent(["a"], "")).toEqual(["a"]);
  });
});

describe("finding the chosen model", () => {
  const ps = [{ id: "p", label: "P", models: [{ v: "p/a" }] }, { id: "q", label: "Q", models: [{ v: "q/b", l: "B" }] }];
  test("returns the model and its provider", () => {
    expect(modelFind(ps, "q/b")).toEqual({ m: { v: "q/b", l: "B" }, p: ps[1] });
  });
  test("a saved model that is no longer offered is null, never guessed", () => {
    expect(modelFind(ps, "retired-model")).toBeNull();
    expect(modelFind(ps, "")).toBeNull();
    expect(modelFind([], "p/a")).toBeNull();
  });
});

describe("row details", () => {
  test("context, price and badges read at a glance", () => {
    expect([200000, 262144, 1000000, 1500000, 8192, 500, 0, undefined].map(modelCtx)).toEqual(["200k", "262k", "1M", "1.5M", "8k", "500", "", ""]);
    expect(modelPrice({ in: 3, out: 15 })).toBe("$3 / $15");
    expect(modelPrice({ in: 0.15, out: 0.6 })).toBe("$0.15 / $0.6");
    expect(modelPrice({ in: 0.075, out: 22.5 })).toBe("$0.075 / $22.5");
    expect(modelBadges({ v: "a", ctx: 200000, price: { in: 3, out: 15 }, reasoning: true }).map((b: any) => [b.k, b.t])).toEqual([["ctx", "200k"], ["price", "$3 / $15"], ["reason", "Reasoning"]]);
    expect(modelBadges({ v: "a", free: true }).map((b: any) => b.t)).toEqual(["Free"]);
    expect(modelBadges({ v: "a", efforts: ["low", "high"] }).map((b: any) => b.t)).toEqual(["Reasoning: low, high"]);
    expect(modelBadges({ v: "a", note: "private" }).map((b: any) => [b.k, b.t])).toEqual([["note", "private"]]);
    expect(modelBadges({ v: "a" })).toEqual([]); // a missing detail is skipped, never a blank badge
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/model-picker.test.ts`
Expected: FAIL (the file `public/js/model-search.js` does not exist).

- [ ] **Step 3: Write the module**

Create `public/js/model-search.js`:

```js
"use strict";
// Pure helpers for the model picker (no DOM, so a test runs this whole file): search and ranking, highlight marks,
// the recent list, finding the chosen model, and the labels on a row.
const MODEL_MAX_ROWS = 60;
const MODEL_RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const modelEsc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const modelWords = (q) => String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
const modelStart = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(MODEL_RE_SPECIAL, "\\$&")}`);
/** How well one word matches a model: 3 a name prefix, 2 a word start in the name or ID, 1 anywhere in either, 0 not at all. */
function modelWordScore(name, id, w, start) {
  if (name.startsWith(w)) return 3;
  if (start.test(name) || start.test(id)) return 2;
  return name.includes(w) || id.includes(w) ? 1 : 0;
}
/** The best `max` models for a query (every word must match), and how many matched in all. Ties keep the list's order. */
function modelSearch(models, query, max = MODEL_MAX_ROWS) {
  const words = modelWords(query);
  if (!words.length) return { rows: models.slice(0, max), total: models.length };
  const starts = words.map(modelStart), exact = words.join(" "), hits = [];
  models.forEach((m, i) => {
    const name = (m.l ?? "").toLowerCase(), id = m.v.toLowerCase();
    let score = id === exact ? 10 : 0;
    for (let k = 0; k < words.length; k++) { const s = modelWordScore(name, id, words[k], starts[k]); if (!s) return; score += s; }
    hits.push({ m, i, score });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return { rows: hits.slice(0, max).map((h) => h.m), total: hits.length };
}
/** `text` as safe HTML with every match of a query word wrapped in <mark>. */
function modelMarks(text, query) {
  const t = String(text ?? ""), low = t.toLowerCase(), spans = [];
  for (const w of modelWords(query)) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) spans.push([i, i + w.length]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) { const last = merged[merged.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([s[0], s[1]]); }
  let out = "", at = 0;
  for (const [a, b] of merged) { out += `${modelEsc(t.slice(at, a))}<mark>${modelEsc(t.slice(a, b))}</mark>`; at = b; }
  return out + modelEsc(t.slice(at));
}
/** The recent list after choosing `value`: newest first, no duplicates, at most `max`. */
const modelRecent = (list, value, max = 5) => (value ? [value, ...list.filter((x) => x !== value)].slice(0, max) : list);
/** The chosen model and its provider, or null when it isn't offered (a saved model that has since gone). */
function modelFind(providers, v) {
  if (!v) return null;
  for (const p of providers) { const m = p.models.find((x) => x.v === v); if (m) return { m, p }; }
  return null;
}
const modelCtx = (n) => (!(n > 0) ? "" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const modelMoney = (n) => `$${+n.toFixed(n < 1 ? 3 : 2)}`;
const modelPrice = (p) => (p ? `${modelMoney(p.in)} / ${modelMoney(p.out)}` : "");
/** The small labels under a model's name. A detail the source didn't give is skipped. */
function modelBadges(m) {
  const b = [];
  if (m.ctx) b.push({ k: "ctx", t: modelCtx(m.ctx), title: "Context window" });
  if (m.free) b.push({ k: "free", t: "Free" });
  else if (m.price) b.push({ k: "price", t: modelPrice(m.price), title: "USD per million tokens (input / output)" });
  if (m.reasoning || m.efforts?.length) b.push({ k: "reason", t: m.efforts?.length ? `Reasoning: ${m.efforts.join(", ")}` : "Reasoning" });
  if (m.note) b.push({ k: "note", t: m.note });
  return b;
}
```

- [ ] **Step 4: List the script in the manifest**

In `public/assets.json`, add `"js/model-search.js",` on its own line directly after `"js/format.js",`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/model-picker.test.ts test/assets.test.ts`
Expected: PASS. (`assets.test.ts` checks the new file is under 400 lines and declares no name another script does; if it reports a clash, rename the clashing new name with an `mp`/`model` prefix.)

- [ ] **Step 6: Commit**

```bash
git add public/js/model-search.js public/assets.json test/model-picker.test.ts
git commit -m "Add the model picker's pure search helpers" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

---

### Task 4: The picker component, and New session

**Files:**
- Create: `public/js/model-picker.js`, `public/css/model-picker.css`
- Modify: `public/assets.json` (script after `js/model-search.js`; stylesheet after `css/menus.css`)
- Modify: `public/index.html:117` (the Model field)
- Modify: `public/js/new-session.js:82-85` and `:111-113`
- Modify: `bin/ui-snapshot.mjs` (new views, next to `codex-settings-save`)
- (`public/css/menus.css` keeps its `.sugg` rules: the Folder and Extra flags fields still use them.)

**Interfaces:**
- Consumes: everything from Task 3, and the core globals `esc`, `load`, `store`, `isPhone`.
- Produces (Tasks 5 to 7 rely on these exact signatures):
  - `modelPickerSet(id: string, cfg): state`, where `cfg` is `{ providers: Provider[]; value?: string; label?: string; onChange?: (v: string) => void; allowCustom?: boolean; allowDefault?: boolean; defaultLabel?: string; compact?: boolean; recentKey?: string; hint?: string }` and `Provider = { id; label; models: Model[]; off?: string }` (`off` is a reason string: the provider is listed dimmed and cannot be chosen).
  - `modelPickerHTML(id: string): string` (a `<div class="mp" data-mp-root="id">` holding the buttons), for screens that build a template string
  - `modelPickerMount(el: Element, id: string): void`: draws the picker into a slot, and if it is already there redraws it in place so keyboard focus stays on its button (for screens that re-render on every change)
  - `modelPickerValue(id): string`, `modelPickerPick(id, v): void` (acts like a user pick: updates the buttons and calls `onChange`), `modelPickerDrop(id): void`
  - Markup hooks the harness and tests use: `[data-mp="<id>"][data-mp-open="provider|model"]` buttons, `.mp-pop` (the open list), `.mp-opt` rows.

- [ ] **Step 1: Write the component**

Create `public/js/model-picker.js`:

```js
"use strict";
// The model picker: a Provider button and a Model button that each open a searchable list. Screens rebuild their markup
// with innerHTML, so a picker is a registry entry (modelPickerSet) plus a string (modelPickerHTML); one delegated
// listener on document opens the list. The list is a top-layer popover inside the closest <dialog>: a modal dialog
// makes everything outside it inert, and a scrolling dialog would clip it. Search, marks and badges: model-search.js.
const mpState = new Map(); // id -> the picker's config and state (see modelPickerSet)
let mpPop = null; // the open list: { id, kind, pid, el, uid, input, list, foot, rows, active }
let mpSeq = 0;
const MP_CHEV = '<svg class="mp-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MP_X = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/** Register or update a picker. `filter` (the provider being browsed) and `last` survive an update. */
function modelPickerSet(id, cfg) {
  const prev = mpState.get(id) ?? {};
  const st = { providers: [], value: "", label: "Model", onChange: null, allowCustom: false, allowDefault: false, defaultLabel: "Default", compact: false, recentKey: "", hint: "", filter: null, last: "", ...prev, ...cfg };
  mpState.set(id, st);
  return st;
}
const modelPickerValue = (id) => mpState.get(id)?.value ?? "";
function modelPickerDrop(id) { if (mpPop?.id === id) mpClose(false); mpState.delete(id); }
/** Choose `v` as if the user had: the buttons update, the open list closes, `onChange` runs. */
function modelPickerPick(id, v) {
  const st = mpState.get(id);
  if (!st) return;
  const at = modelFind(st.providers, v);
  if (at) st.last = at.p.id;
  if (v && st.recentKey) store("recent:" + st.recentKey, modelRecent(load("recent:" + st.recentKey, []), v));
  st.value = v; st.filter = null;
  if (mpPop?.id === id) mpClose(); else mpRefresh(id);
  st.onChange?.(v);
}
const mpRecents = (st) => (st.recentKey ? load("recent:" + st.recentKey, []) : []);
const modelPickerHTML = (id) => (mpState.has(id) ? `<div class="mp" data-mp-root="${esc(id)}">${mpInner(id, mpState.get(id))}</div>` : "");
/** Draw a picker into a screen's slot; if it is already there, redraw in place so keyboard focus stays on its button. */
function modelPickerMount(el, id) {
  if (el.firstElementChild?.dataset.mpRoot === id) mpRefresh(id); else el.innerHTML = modelPickerHTML(id);
}

/** The provider the buttons show and the model list is filtered to: the one being browsed, else the value's own, else the last used. */
function mpProvider(st) {
  if (st.filter === "*") return { id: "*", label: "All providers", models: st.providers.flatMap((p) => p.models) };
  const id = st.filter ?? modelFind(st.providers, st.value)?.p.id ?? st.last;
  return st.providers.find((p) => p.id === id) ?? st.providers[0];
}
function mpInner(id, st) {
  const cur = modelFind(st.providers, st.value), prov = mpProvider(st);
  let name = cur ? cur.m.l ?? cur.m.v : st.value || (st.allowDefault ? st.defaultLabel : "Choose…");
  if (st.compact && cur && !name.toLowerCase().startsWith(cur.p.label.toLowerCase())) name = `${cur.p.label} · ${name}`;
  const btn = (kind, cls, label, body) => `<button type="button" class="mp-btn ${cls}" data-mp="${esc(id)}" data-mp-open="${kind}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}">${body}${MP_CHEV}</button>`;
  const model = btn("model", "mp-model", st.label, `<span class="mp-v${st.value && !cur ? " mp-custom" : ""}">${esc(name)}</span>`);
  if (st.compact) return model;
  const provider = st.providers.length > 1 ? btn("provider", "mp-prov", `${st.label} provider`, `<span class="mp-k">Provider</span><span class="mp-v">${esc(prov.label)}</span><span class="mp-n">${prov.models.length}</span>`)
    : st.providers[0] ? `<span class="mp-fixed" title="Provider">${esc(st.providers[0].label)}</span>` : "";
  return `${provider}${model}${!st.providers.length && st.hint ? `<span class="hint mp-hint">${esc(st.hint)}</span>` : ""}`;
}
const mpRoots = (id) => [...document.querySelectorAll("[data-mp-root]")].filter((r) => r.dataset.mpRoot === id);
const mpTrigger = (id, kind) => mpRoots(id).map((r) => r.querySelector(`[data-mp-open="${kind}"]`)).find(Boolean);
/** Redraw a picker's buttons in place, keeping keyboard focus on the button it was on. */
function mpRefresh(id) {
  const st = mpState.get(id);
  if (!st) return;
  for (const root of mpRoots(id)) {
    const at = root.contains(document.activeElement) ? document.activeElement.dataset.mpOpen : "";
    root.innerHTML = mpInner(id, st);
    if (at) root.querySelector(`[data-mp-open="${at}"]`)?.focus();
  }
}

// ── the open list ──
const mpSelectable = (r) => (r.t === "model" || r.t === "provider" || r.t === "custom") && !r.off;
function mpOpen(id, kind, trigger) {
  const st = mpState.get(id);
  if (!st || !trigger) return;
  const again = mpPop && mpPop.id === id && mpPop.kind === kind;
  mpClose(false);
  if (again) return; // the button toggles its own list
  const uid = `mp${++mpSeq}`, provider = kind === "model" ? mpProvider(st) : null;
  const what = kind === "provider" ? "provider" : st.label.toLowerCase();
  const chips = kind === "model" && st.compact && st.providers.length > 1
    ? `<div class="mp-chips" role="group" aria-label="Provider">${[{ id: "*", label: "All" }, ...st.providers].map((p) => `<button type="button" class="mp-chip" data-mp-chip="${esc(p.id)}" aria-pressed="${p.id === provider?.id}">${esc(p.label)}</button>`).join("")}</div>` : "";
  const el = document.createElement("div");
  el.className = "mp-pop"; el.setAttribute("popover", "manual");
  el.innerHTML = `<div class="mp-head"><input class="mp-q" type="text" role="combobox" aria-expanded="true" aria-controls="${uid}l" aria-autocomplete="list" aria-label="Search ${esc(what)}" placeholder="Search ${esc(what)}…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"><button type="button" class="mp-x" aria-label="Close">${MP_X}</button></div>${chips}<div class="mp-list" id="${uid}l" role="listbox" aria-label="${esc(what)} list"></div><div class="mp-foot" hidden></div>`;
  el.addEventListener("input", (e) => { if (e.target === mpPop?.input) mpRender(true); });
  el.addEventListener("keydown", mpKey);
  el.addEventListener("mousedown", (e) => { if (!e.target.closest(".mp-q")) e.preventDefault(); }); // keep focus in the search box
  el.addEventListener("click", (e) => {
    const o = e.target.closest(".mp-opt"), c = e.target.closest("[data-mp-chip]");
    if (o) mpChoose(+o.dataset.i);
    else if (c) { mpPop.pid = c.dataset.mpChip; for (const x of el.querySelectorAll("[data-mp-chip]")) x.setAttribute("aria-pressed", x === c); mpRender(true); }
    else if (e.target.closest(".mp-x")) mpClose();
  });
  el.addEventListener("mousemove", (e) => { const o = e.target.closest(".mp-opt:not(.off)"); if (o && mpPop && +o.dataset.i !== mpPop.active) mpActive(+o.dataset.i); });
  (trigger.closest("dialog") ?? document.body).append(el);
  mpPop = { id, kind, pid: provider?.id, el, uid, input: el.querySelector(".mp-q"), list: el.querySelector(".mp-list"), foot: el.querySelector(".mp-foot"), rows: [], active: -1 };
  trigger.setAttribute("aria-expanded", "true");
  el.showPopover();
  mpPlace(); mpViewport(); mpRender(true);
  mpPop.input.focus({ preventScroll: true });
  window.visualViewport?.addEventListener("resize", mpViewport);
  window.visualViewport?.addEventListener("scroll", mpViewport);
}
function mpClose(focus = true) {
  const pop = mpPop;
  if (!pop) return;
  mpPop = null;
  window.visualViewport?.removeEventListener("resize", mpViewport);
  window.visualViewport?.removeEventListener("scroll", mpViewport);
  try { pop.el.hidePopover(); } catch {}
  pop.el.remove();
  const st = mpState.get(pop.id);
  if (st && pop.kind === "model") st.filter = null; // browsing a provider ends with the list
  mpRefresh(pop.id);
  if (focus) mpTrigger(pop.id, pop.kind)?.focus();
}
/** Under the button on a desktop (above it when there's no room); a bottom sheet on a phone, which the CSS positions. */
function mpPlace() {
  const pop = mpPop, s = pop.el.style;
  if (isPhone()) { for (const k of ["left", "top", "bottom", "width", "max-height"]) s.removeProperty(k); return; }
  const r = mpTrigger(pop.id, pop.kind)?.getBoundingClientRect();
  if (!r) return;
  const w = Math.min(Math.max(r.width, 340), innerWidth - 16), below = innerHeight - r.bottom - 12, above = r.top - 12, up = below < 260 && above > below;
  s.width = `${w}px`; s.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  s.maxHeight = `${Math.min(440, up ? above : below)}px`;
  if (up) { s.bottom = `${innerHeight - r.top + 4}px`; s.top = "auto"; } else { s.top = `${r.bottom + 4}px`; s.bottom = "auto"; }
}
/** A phone's keyboard shrinks the visual viewport but not the layout one: keep the sheet above it. */
function mpViewport() {
  const v = window.visualViewport;
  if (!v || !mpPop) return;
  mpPop.el.style.setProperty("--mp-kb", `${Math.max(0, Math.round(innerHeight - v.height - v.offsetTop))}px`);
  mpPop.el.style.setProperty("--mp-vh", `${Math.round(v.height)}px`);
}

/** The rows for the open list: a provider list, or the models of one provider (or all) with Default, Recent and "Use 'x'". */
function mpRows(st, pop) {
  const q = pop.input.value.trim(), ql = q.toLowerCase(), rows = [];
  if (pop.kind === "provider") {
    if (st.providers.length > 1 && (!q || "all providers".includes(ql))) rows.push({ t: "provider", v: "*", label: "All providers", n: st.providers.reduce((n, p) => n + p.models.length, 0) });
    for (const p of st.providers) if (!q || p.label.toLowerCase().includes(ql) || p.id.includes(ql)) rows.push({ t: "provider", v: p.id, label: p.label, n: p.models.length, off: p.off || (p.models.length ? "" : "No models") });
    return { rows, shown: rows.length, total: rows.length };
  }
  const scoped = st.providers.filter((p) => pop.pid === "*" || p.id === pop.pid).flatMap((p) => p.models.map((m) => ({ ...m, _p: p })));
  if (st.allowDefault && (!q || "default".includes(ql) || st.defaultLabel.toLowerCase().includes(ql))) rows.push({ t: "model", v: "", m: { v: "", l: st.defaultLabel }, def: true });
  const seen = new Set();
  if (!q) {
    const recent = mpRecents(st).map((v) => scoped.find((m) => m.v === v)).filter(Boolean);
    if (recent.length) { rows.push({ t: "head", label: "Recent" }); for (const m of recent) { seen.add(m.v); rows.push({ t: "model", v: m.v, m }); } rows.push({ t: "head", label: "All models" }); }
  }
  const found = modelSearch(scoped.filter((m) => !seen.has(m.v)), q);
  for (const m of found.rows) rows.push({ t: "model", v: m.v, m });
  if (st.allowCustom && q && !scoped.some((m) => m.v === q)) rows.push({ t: "custom", v: q });
  return { rows, shown: found.rows.length, total: found.total };
}
function mpRowHTML(st, pop, r, i) {
  if (r.t === "head") return `<div class="mp-h" role="presentation">${esc(r.label)}</div>`;
  const id = `id="${pop.uid}o${i}" data-i="${i}"`, cls = `mp-opt${i === pop.active ? " on" : ""}${r.off ? " off" : ""}`, dis = r.off ? ' aria-disabled="true"' : "";
  if (r.t === "provider") return `<div class="${cls}" role="option" ${id} aria-selected="${r.v === pop.pid}"${dis}><div class="mp-l1"><span class="mp-name">${esc(r.label)}</span><span class="mp-n">${r.off ? esc(r.off) : `${r.n} model${r.n === 1 ? "" : "s"}`}</span></div></div>`;
  if (r.t === "custom") return `<div class="${cls}" role="option" ${id} aria-selected="false"><div class="mp-l1"><span class="mp-name">Use “${esc(r.v)}”</span><span class="mp-n">custom ID</span></div></div>`;
  const m = r.m, q = pop.input.value.trim(), off = m._p?.off, name = m.l ?? m.v;
  const badges = r.def || off ? [] : modelBadges(m);
  return `<div class="${cls}" role="option" ${id} aria-selected="${r.v === st.value}"${off ? ' aria-disabled="true"' : ""}><div class="mp-l1"><span class="mp-name">${modelMarks(name, q)}</span>${pop.pid === "*" && m._p ? `<span class="mp-pv">${esc(m._p.label)}</span>` : ""}</div>${m.l && m.l !== m.v && !r.def ? `<div class="mp-id">${modelMarks(m.v, q)}</div>` : ""}${off ? `<div class="mp-badges"><span class="mp-b">${esc(off)}</span></div>` : badges.length ? `<div class="mp-badges">${badges.map((b) => `<span class="mp-b ${b.k}"${b.title ? ` title="${esc(b.title)}"` : ""}>${esc(b.t)}</span>`).join("")}</div>` : ""}</div>`;
}
function mpRender(reset) {
  const pop = mpPop, st = mpState.get(pop.id), { rows, shown, total } = mpRows(st, pop);
  pop.rows = rows;
  if (reset) {
    const i = pop.input.value.trim() ? -1 : rows.findIndex((r) => mpSelectable(r) && (pop.kind === "provider" ? r.v === pop.pid : r.t === "model" && r.v === st.value));
    pop.active = i >= 0 ? i : rows.findIndex(mpSelectable);
  }
  pop.list.innerHTML = rows.length ? rows.map((r, i) => mpRowHTML(st, pop, r, i)).join("") : `<div class="mp-empty">${esc(pop.kind === "model" && !st.providers.length ? st.hint || "No models" : "Nothing matches")}</div>`;
  pop.foot.hidden = shown >= total;
  pop.foot.textContent = shown < total ? `Showing ${shown} of ${total}. Keep typing to narrow it down.` : "";
  pop.input.setAttribute("aria-activedescendant", pop.active >= 0 ? `${pop.uid}o${pop.active}` : "");
  pop.list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}
function mpActive(i) {
  const pop = mpPop;
  pop.list.querySelector(".on")?.classList.remove("on");
  pop.active = i;
  const el = pop.list.querySelector(`[data-i="${i}"]`);
  el?.classList.add("on");
  el?.scrollIntoView({ block: "nearest" });
  pop.input.setAttribute("aria-activedescendant", el ? el.id : "");
}
function mpStep(d) {
  const sel = mpPop.rows.map((r, i) => (mpSelectable(r) ? i : -1)).filter((i) => i >= 0);
  if (sel.length) mpActive(sel[Math.max(0, Math.min(sel.length - 1, Math.max(0, sel.indexOf(mpPop.active)) + d))]);
}
function mpKey(e) {
  const pop = mpPop;
  if (!pop) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mpStep(e.key === "ArrowDown" ? 1 : -1); }
  else if (e.key === "PageDown" || e.key === "PageUp") { e.preventDefault(); mpStep(e.key === "PageDown" ? 8 : -8); }
  else if ((e.key === "Home" || e.key === "End") && (!pop.input.value || e.ctrlKey || e.metaKey)) { e.preventDefault(); mpStep(e.key === "Home" ? -1e9 : 1e9); } // otherwise they move the caret
  else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); mpChoose(pop.active); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); mpClose(); } // closes the list, not the dialog under it
}
function mpChoose(i) {
  const pop = mpPop, r = pop?.rows[i], st = pop && mpState.get(pop.id);
  if (!r || !mpSelectable(r)) return;
  if (r.t === "provider") { const id = pop.id; st.filter = r.v; mpClose(false); mpOpen(id, "model", mpTrigger(id, "model")); return; } // choosing a provider goes straight to its models
  modelPickerPick(pop.id, r.v);
}

document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-mp-open]"); if (b) { e.preventDefault(); mpOpen(b.dataset.mp, b.dataset.mpOpen, b); } });
document.addEventListener("keydown", (e) => { const b = e.target.closest?.("[data-mp-open]"); if (b && e.key === "ArrowDown") { e.preventDefault(); mpOpen(b.dataset.mp, b.dataset.mpOpen, b); } });
document.addEventListener("pointerdown", (e) => { if (mpPop && !mpPop.el.contains(e.target) && !e.target.closest?.("[data-mp-open]")) mpClose(false); }, true);
window.addEventListener("resize", () => { if (mpPop) mpPlace(); });
document.addEventListener("scroll", (e) => { if (mpPop && !mpPop.el.contains(e.target)) mpPlace(); }, true);
```

- [ ] **Step 2: Write the styles**

Create `public/css/model-picker.css`:

```css
/* The model picker (js/model-picker.js): a Provider and a Model button that each open a searchable list. */
.mp { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mp-btn { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; text-align: left; background: var(--bg); border: 1px solid var(--line-2); border-radius: 8px; padding: 8px 10px; font: 15px var(--read); color: var(--ink); cursor: pointer; }
.mp-btn:hover { border-color: var(--ink-3); }
.mp-btn[aria-expanded="true"] { border-color: var(--accent); }
.mp-btn:focus-visible, .mp-chip:focus-visible, .mp-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mp-prov { background: transparent; padding: 5px 10px; font-size: 14px; color: var(--ink-2); }
.mp-k { flex: none; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); }
.mp-v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-custom::after { content: " · custom"; color: var(--ink-3); font-size: 12.5px; }
.mp-n { flex: none; font-size: 12.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.mp-chev { flex: none; width: 12px; height: 12px; color: var(--ink-3); }
.mp-fixed { font-size: 13px; color: var(--ink-3); padding: 0 2px; }
.mp-hint { margin-top: 2px; }

.mp-pop { inset: auto; margin: 0; padding: 0; width: 340px; max-height: 440px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--raise); color: var(--ink); box-shadow: 0 18px 50px rgba(0, 0, 0, .4); overflow: hidden; }
.mp-pop:popover-open { display: flex; flex-direction: column; }
.mp-head { display: flex; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line); }
.mp-q { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--line-2); border-radius: 8px; padding: 8px 10px; font: 15px var(--read); color: var(--ink); }
.mp-q:focus { outline: none; border-color: var(--accent); }
.mp-x { display: none; flex: none; width: 36px; height: 36px; align-items: center; justify-content: center; border: 0; background: none; color: var(--ink-3); border-radius: 8px; }
.mp-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 8px 0; }
.mp-chip { border: 1px solid var(--line-2); background: transparent; border-radius: 999px; padding: 2px 10px; font-size: 13px; color: var(--ink-2); }
.mp-chip[aria-pressed="true"] { border-color: var(--accent); background: var(--sel); color: var(--ink); }
.mp-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; overscroll-behavior: contain; }
.mp-h { padding: 8px 10px 3px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); }
.mp-opt { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.mp-opt.on { background: var(--sel); }
.mp-opt.off { opacity: .5; cursor: default; }
.mp-opt[aria-selected="true"] .mp-name::after { content: " ✓"; color: var(--accent); }
.mp-l1 { display: flex; align-items: baseline; gap: 8px; width: 100%; min-width: 0; }
.mp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.mp-name mark, .mp-id mark { background: none; color: var(--accent); font-weight: 700; }
.mp-pv { flex: none; padding: 0 5px; border: 1px solid var(--line-2); border-radius: 4px; font-size: 11.5px; color: var(--ink-3); }
.mp-id { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); color: var(--ink-3); }
.mp-badges { display: flex; flex-wrap: wrap; gap: 4px; width: 100%; margin-top: 2px; }
.mp-b { padding: 0 6px; border-radius: 4px; background: var(--hover); font-size: 11.5px; color: var(--ink-2); white-space: nowrap; }
.mp-b.free { color: var(--idle); }
.mp-b.reason { color: var(--unknown); }
.mp-empty { padding: 14px; font-size: 14px; color: var(--ink-3); }
.mp-foot { padding: 8px 14px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--ink-3); }

@media (prefers-reduced-motion: no-preference) {
  .mp-pop { transition: opacity .12s var(--ease), transform .16s var(--ease), overlay .16s allow-discrete, display .16s allow-discrete; }
  .mp-pop:not(:popover-open) { opacity: 0; transform: translateY(-4px); }
  @starting-style { .mp-pop:popover-open { opacity: 0; transform: translateY(-4px); } }
}
:root[data-motion="reduce"] .mp-pop { transition: none; }

/* A phone: a bottom sheet above the keyboard (--mp-kb and --mp-vh come from the visual viewport), rows big enough to tap. */
@media (max-width: 760px) {
  .mp-pop { left: 0; right: 0; top: auto; bottom: var(--mp-kb, 0px); width: auto; max-height: min(72dvh, calc(var(--mp-vh, 100dvh) - 24px)); border-width: 1px 0 0; border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom); }
  .mp-pop::backdrop { background: rgba(8, 12, 18, .45); }
  .mp-q { font-size: 16px; }
  .mp-x { display: flex; }
  .mp-opt { min-height: 44px; align-content: center; }
  .mp-chip { padding: 5px 12px; }
  @media (prefers-reduced-motion: no-preference) {
    .mp-pop:not(:popover-open) { transform: translateY(100%); }
    @starting-style { .mp-pop:popover-open { transform: translateY(100%); } }
  }
}
```

- [ ] **Step 3: List both files in the manifest**

In `public/assets.json`: add `"js/model-picker.js",` directly after `"js/model-search.js",`, and add `"css/model-picker.css",` directly after `"css/menus.css",`.

- [ ] **Step 4: Switch the New session dialog over**

In `public/index.html`, replace the Model field (line 117):

```html
          <label class="field"><span>Model</span><input id="nModel" list="nModelList" spellcheck="false" autocomplete="off" placeholder="Default"><datalist id="nModelList"></datalist><div class="sugg" id="nModelSugg"></div></label>
```

with:

```html
          <div class="field"><span>Model</span><div id="nModelPick"></div></div>
```

In `public/js/new-session.js`, replace lines 82 to 85 (the `$("nModel").value = …` line, the `nModelList` line, the `quick` line and the `nModelSugg` line) with:

```js
  // An older node's options have no providers: fall back to one list, so the picker still works.
  const providers = ch.providers ?? [{ id: newKind, label: (KINDS.find(([k]) => k === newKind) ?? [newKind, newKind])[1], models: ch.models.filter((m) => m.v) }];
  const pid = "new:" + newKind;
  modelPickerSet(pid, { providers, value: nSel.model, label: "Model", allowCustom: true, allowDefault: true, defaultLabel: ch.models[0]?.v === "" ? ch.models[0].l : "Default", recentKey: "new-" + newKind, hint: ch.error ? `${ch.error}. You can still type a model ID.` : "", onChange: (v) => { nSel.model = v; saveOpts(); } });
  modelPickerMount($("nModelPick"), pid);
```

and delete the three listener lines that used the old controls (lines 111 to 113):

```js
$("nModelSugg").addEventListener("click", (e) => { const b = e.target.closest("[data-model]"); if (b) { nSel.model = b.dataset.model; saveOpts(); } });
$("nModel").addEventListener("change", (e) => { nSel.model = e.target.value.trim(); saveOpts(); });
$("nModel").addEventListener("input", (e) => { nSel.model = e.target.value.trim(); store("opts:" + newKind, nSel); renderCmd(); });
```

The lines after (`const model = ch.models.find(…)`, the effort buttons, `renderCmd()`) stay as they are.

- [ ] **Step 5: Add snapshot views**

In `bin/ui-snapshot.mjs`, inside `VIEWS`, directly after the `"codex-settings-save"` entry, add:

```js
  "picker-new": `(async () => { await openNew({ kind: "claude", cwd: "/tmp/acme-api", project: "acme-api" }); const b = document.querySelector('[data-mp="new:claude"][data-mp-open="model"]'); if (!b) throw new Error("The model picker is missing"); b.click(); await new Promise((r) => setTimeout(r, 250)); const n = document.querySelectorAll(".mp-pop .mp-opt").length; if (n < 5) throw new Error("Expected Default plus four Claude models, got " + n); const q = document.querySelector(".mp-q"); q.value = "<img src=x onerror=1>"; q.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 100)); if (document.querySelector(".mp-pop img")) throw new Error("HTML typed into the search box was parsed"); if (!document.querySelector(".mp-pop .mp-opt")?.textContent.includes("<img")) throw new Error("The custom-ID row must show the typed text"); q.value = "son"; q.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 100)); })()`,
  "picker-new-opencode": `(async () => { await openNew({ kind: "opencode", cwd: "/tmp/acme-api", project: "acme-api" }); const b = document.querySelector('[data-mp="new:opencode"][data-mp-open="model"]'); if (!b) throw new Error("The model picker is missing"); b.click(); await new Promise((r) => setTimeout(r, 250)); if (!document.querySelector(".mp-pop")) throw new Error("The model list did not open"); })()`,
  "picker-new-retired": `(async () => { store("opts:claude", { model: "retired-model", effort: "", mode: "" }); await openNew({ kind: "claude", cwd: "/tmp/acme-api", project: "acme-api" }); const b = document.querySelector('[data-mp="new:claude"][data-mp-open="model"]'); if (!b?.textContent.includes("retired-model")) throw new Error("A saved model that is no longer offered was dropped"); if (!$("nCmd").textContent.includes("--model retired-model")) throw new Error("The command lost the saved model"); })()`,
```

- [ ] **Step 6: Run the unit tests and the file checks**

Run: `bun test test/assets.test.ts test/model-picker.test.ts`
Expected: PASS (`model-picker.js` is well under 400 lines and clashes with no name; if a clash is reported, rename that name with the `mp` prefix).

- [ ] **Step 7: Run the snapshot views**

Run:
```bash
cd /Users/stas-2/Documents/Projects/herdr-deck && node bin/ui-snapshot.mjs --out /tmp/snap-picker-new --port 4772 --views picker-new,picker-new-opencode,picker-new-retired,codex-new
```
Expected: it prints the written files; `picker-new-*.json` have an empty `errors` array; open `/tmp/snap-picker-new/picker-new-desktop.png` and `-phone.png` and look at them: the Model field shows a fixed "Anthropic" label above a model button, and the open list shows a search box, "Default", four models with a check on none, a "Use …" row for the typed text. The phone image shows a bottom sheet with a close button. (View the PNGs with the Read tool.)

To check OpenCode being missing, run:
```bash
node bin/ui-snapshot.mjs --out /tmp/snap-picker-oc-off --port 4772 --views picker-new-opencode --env DECK_OPENCODE_BIN=/nonexistent
```
Expected: no page errors; the model button opens a list whose empty state reads "OpenCode isn't installed on this machine. You can still type a model ID." and typing shows a "Use …" row.

- [ ] **Step 8: Commit**

```bash
git add public/js/model-picker.js public/css/model-picker.css public/assets.json public/index.html public/js/new-session.js bin/ui-snapshot.mjs
git commit -m "Add the provider + model picker and use it in the New session dialog" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

---

### Task 5: Codex task settings

**Files:**
- Modify: `public/js/codex-task-actions.js:26-27`, `:37` and following (the `showCodexSettings` function)
- Modify: `bin/ui-snapshot.mjs` (the `codex-settings-save` view; a new `picker-codex-settings` view)

**Interfaces:**
- Consumes: `modelPickerSet`, `modelPickerHTML`, `modelPickerPick`, `modelPickerDrop`.

- [ ] **Step 1: Swap the model control**

In `showCodexSettings` in `public/js/codex-task-actions.js`:

1. Replace the Model line of the `dlg.innerHTML` template:
```html
    <label class="field"><span>Model</span><select name="model">${models.map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join("")}</select></label>
```
with:
```html
    <div class="field"><span>Model</span><div id="codexModelPick"></div></div>
```

2. Replace the `const form = …` line:
```js
  const form = dlg.querySelector("form"), model = form.elements.model, effort = form.elements.effort, permission = form.elements.permissionMode;
```
with:
```js
  const form = dlg.querySelector("form"), effort = form.elements.effort, permission = form.elements.permissionMode;
```

3. Replace `model.value = settings.model ?? models[0]?.id ?? "";` with:
```js
  let modelId = settings.model ?? models[0]?.id ?? ""; // the picker's value; the server only takes a model from its own list
```

4. In `syncEffort`, replace `models.find((m) => m.id === model.value)` with `models.find((m) => m.id === modelId)`.

5. Replace these two lines:
```js
  syncEffort(settings.effort);
  model.onchange = () => syncEffort(effort.value);
```
with:
```js
  modelPickerSet("codex-settings", { label: "Model", value: modelId, providers: [{ id: "openai", label: "OpenAI", models: models.map((m) => ({ v: m.id, ...(m.label && m.label !== m.id ? { l: m.label } : {}), efforts: m.efforts, reasoning: !!m.efforts?.length })) }], onChange: (v) => { modelId = v; syncEffort(effort.value); } });
  modelPickerMount(dlg.querySelector("#codexModelPick"), "codex-settings");
  syncEffort(settings.effort);
```

6. Replace `dlg.addEventListener("close", () => dlg.remove());` with:
```js
  dlg.addEventListener("close", () => { modelPickerDrop("codex-settings"); dlg.remove(); });
```

7. In the submit handler, replace `if (model.value !== settings.model) patch.model = model.value;` with `if (modelId !== settings.model) patch.model = modelId;`.

8. Replace the last line of the function, `dlg.showModal(); model.focus();`, with:
```js
  dlg.showModal(); dlg.querySelector('[data-mp-open="model"]')?.focus();
```

- [ ] **Step 2: Update the snapshot harness**

In `bin/ui-snapshot.mjs`, in the `"codex-settings-save"` view, replace `form.elements.model.value = "fixture-fast"; form.elements.model.dispatchEvent(new Event("change"));` with `modelPickerPick("codex-settings", "fixture-fast");`.

Add, next to the other `picker-*` views:

```js
  "picker-codex-settings": `(async () => { select("fake:codex", { scroll: true, open: true }); await openCodexSettings(rowOf(S.sel)); const b = document.querySelector('.native-settings [data-mp-open="model"]'); if (!b) throw new Error("The model picker is missing"); b.click(); await new Promise((r) => setTimeout(r, 250)); if (!document.querySelector(".mp-pop .mp-opt")) throw new Error("The model list is empty"); if (document.querySelector('.mp-pop [data-mp-chip]')) throw new Error("A single provider needs no provider chips"); })()`,
```

- [ ] **Step 3: Run the harness**

Run:
```bash
node bin/ui-snapshot.mjs --out /tmp/snap-picker-codex --port 4772 --views codex-settings,codex-settings-managed,codex-settings-save,picker-codex-settings
```
Expected: no `errors` in any of the four JSON files (`codex-settings-save` still records the save request with `model: "fixture-fast"` and `effort: "low"`; open its JSON and confirm the request body). Look at `picker-codex-settings-desktop.png`: the settings dialog with the picker list open over it, not clipped by the dialog's scroll area, and the reasoning effort list still following the model.

- [ ] **Step 4: Run the suite and commit**

Run: `bun test`
Expected: PASS.

```bash
git add public/js/codex-task-actions.js bin/ui-snapshot.mjs
git commit -m "Use the model picker in Codex task settings" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

---

### Task 6: Research

**Files:**
- Modify: `plugins-builtin/research/research.js` (the `rsNew` function, around lines 106, 112, 121, 128, 158)
- Modify: `bin/ui-snapshot.mjs` (a new `picker-research` view)

**Interfaces:**
- Consumes: `modelPickerSet`, `modelPickerHTML`, `modelPickerValue`, `modelPickerDrop`. The server takes only `""`, `sonnet`, `opus`, `haiku` or `fable` (`plugins-builtin/research/autoresearch.ts:38`), so no custom IDs.

- [ ] **Step 1: Swap the model control**

In `rsNew` in `plugins-builtin/research/research.js`:

1. Directly before `const d = document.createElement("dialog");` add:
```js
  modelPickerSet("research", { label: "Model", value: "", allowDefault: true, providers: [{ id: "anthropic", label: "Anthropic", models: [{ v: "sonnet", l: "Sonnet" }, { v: "opus", l: "Opus" }, { v: "haiku", l: "Haiku" }, { v: "fable", l: "Fable" }] }] });
```

2. In the template, replace:
```html
<label class="field"><span>Model</span><select name="model"><option value="">Default</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></label>
```
with:
```html
<div class="field"><span>Model</span>${modelPickerHTML("research")}</div>
```
(It keeps the `field` class so the "Review" step, which hides every `.field`, hides it too.)

3. In `body()`, replace `model: f.model.value,` with `model: modelPickerValue("research"),`.

4. Replace `d.addEventListener("close", () => motion.drop(d));` with:
```js
  d.addEventListener("close", () => { motion.drop(d); modelPickerDrop("research"); });
```

- [ ] **Step 2: Add the snapshot view**

In `bin/ui-snapshot.mjs`, next to the other `picker-*` views:

```js
  "picker-research": `(async () => { setMode("discover"); discTab("research"); await new Promise((r) => setTimeout(r, 600)); await rsNew(); const b = document.querySelector('.rsdlg [data-mp-open="model"]'); if (!b) throw new Error("The model picker is missing"); b.click(); await new Promise((r) => setTimeout(r, 250)); const n = document.querySelectorAll(".mp-pop .mp-opt").length; if (n < 5) throw new Error("Expected Default plus four models, got " + n); const q = document.querySelector(".mp-q"); q.value = "zzz"; q.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 100)); if ([...document.querySelectorAll(".mp-pop .mp-opt")].some((o) => o.textContent.includes("Use"))) throw new Error("Research takes no custom model"); })()`,
```

- [ ] **Step 3: Run the harness**

Run: `node bin/ui-snapshot.mjs --out /tmp/snap-picker-research --port 4772 --views discover-research,picker-research`
Expected: no `errors`; `discover-research` is unchanged from before apart from nothing (the campaign list does not contain the model). In `picker-research-desktop.png` the New campaign dialog shows the picker list over it with Default first.

Then check a campaign draft still carries the model: in a scratch scenario, run `node -e` is not needed; instead read `body()` once in the page: add nothing, but confirm by grep that no other code reads `f.model`: `grep -n "f.model" plugins-builtin/research/research.js` must print nothing.

- [ ] **Step 4: Run the suite and commit**

Run: `bun test`
Expected: PASS.

```bash
git add plugins-builtin/research/research.js bin/ui-snapshot.mjs
git commit -m "Use the model picker in Research" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

---

### Task 7: Studio engine

**Files:**
- Modify: `plugins-builtin/discover/js/studio.js:28-35` (`stBarHTML`)
- Modify: `plugins-builtin/discover/js/studio-actions.js:275-278` (remove the `[data-steng]` change handler)
- Modify: `plugins-builtin/discover/css/studio.css:29-32` and `:257-258`
- Modify: `bin/ui-snapshot.mjs` (a new `picker-studio` view)

**Interfaces:**
- Consumes: `modelPickerSet`, `modelPickerHTML` with `compact: true`. Values stay `claude:haiku`, `claude:sonnet`, `ollama:<x>` and `template`; the server takes no others (`plugins-builtin/discover/studio.ts:88-89`).

- [ ] **Step 1: Build the picker in `stBarHTML`**

In `plugins-builtin/discover/js/studio.js`, in `stBarHTML`, replace these two lines:

```js
  const opts = [["claude:haiku", "Claude Haiku · fast", e && !e.claude], ["claude:sonnet", "Claude Sonnet · deeper", e && !e.claude], ...(e?.ollama ?? []).map((x) => [`ollama:${x}`, `Ollama · ${x} · private`]), ["template", "Templates · instant, offline"]];
  if (!opts.some(([v]) => v === st.engine)) opts.push([st.engine, st.engine]);
```

with:

```js
  const off = e && !e.claude ? "Claude Code isn't installed here" : "";
  modelPickerSet("studio-engine", { label: "Engine", compact: true, value: st.engine, onChange: (v) => { S.studio.engine = v; store("studioEngine", v); }, providers: [
    { id: "claude", label: "Claude", off, models: [{ v: "claude:haiku", l: "Claude Haiku", note: "fast" }, { v: "claude:sonnet", l: "Claude Sonnet", note: "deeper" }] },
    ...(e?.ollama?.length ? [{ id: "ollama", label: "Ollama", models: e.ollama.map((x) => ({ v: `ollama:${x}`, l: x, note: "private" })) }] : []),
    { id: "template", label: "Templates", models: [{ v: "template", l: "Templates", note: "instant, offline" }] },
  ] });
```

and replace the `<label class="steng">…</label>` in the returned template:

```html
    <label class="steng"><span class="sr">Engine</span><select data-steng aria-label="Engine">${opts.map(([v, l, dis]) => `<option value="${esc(v)}"${v === st.engine ? " selected" : ""}${dis ? " disabled" : ""}>${esc(l)}</option>`).join("")}</select>${ICON.chev}</label>
```

with:

```html
    <div class="steng">${modelPickerHTML("studio-engine")}</div>
```

- [ ] **Step 2: Remove the old change handler**

In `plugins-builtin/discover/js/studio-actions.js`, delete:

```js
$("dbody").addEventListener("change", (e) => {
  if (S.mode !== "discover" || !e.target.matches("[data-steng]")) return;
  S.studio.engine = e.target.value; store("studioEngine", S.studio.engine);
});
```

(The picker's `onChange` above does the same.)

- [ ] **Step 3: Restyle the bar**

In `plugins-builtin/discover/css/studio.css`, replace the four `.steng` rules at lines 29 to 32:

```css
.steng { position: relative; display: inline-flex; align-items: center; min-width: 0; flex: 0 1 230px; }
.steng select { … }
.steng select:focus-visible { … }
.steng svg { … }
```

with:

```css
.steng { display: inline-flex; min-width: 0; flex: 0 1 230px; }
.steng .mp { width: 100%; }
.steng .mp-btn { padding: 6px 10px; border-radius: 10px; border-color: var(--line); background: var(--raise); color: var(--ink-2); font: 500 13.5px var(--read); }
```

and in the phone block (lines 257 and 258) keep `.steng { flex-basis: 150px; }` and delete `.steng select { padding-right: 24px; }`.

- [ ] **Step 4: Add the snapshot view**

In `bin/ui-snapshot.mjs`, next to the other `picker-*` views:

```js
  "picker-studio": `(async () => { setMode("discover"); discTab("mix"); await new Promise((r) => setTimeout(r, 600)); const b = document.querySelector('.steng [data-mp-open="model"]'); if (!b) throw new Error("The engine picker is missing"); if (!b.textContent.includes("Claude Haiku")) throw new Error("The engine button should name the chosen engine, got " + b.textContent); b.click(); await new Promise((r) => setTimeout(r, 250)); if (document.querySelectorAll(".mp-pop .mp-opt").length < 3) throw new Error("Expected Claude Haiku, Claude Sonnet and Templates"); if (!document.querySelector(".mp-pop [data-mp-chip]")) throw new Error("The compact picker needs provider chips"); document.querySelector('.mp-pop [data-mp-chip="template"]').click(); await new Promise((r) => setTimeout(r, 100)); if (document.querySelectorAll(".mp-pop .mp-opt").length !== 1) throw new Error("The Templates chip should leave one engine"); })()`,
```

- [ ] **Step 5: Run the harness and the suite**

Run:
```bash
node bin/ui-snapshot.mjs --out /tmp/snap-picker-studio --port 4772 --views discover-mix,picker-studio
```
Expected: no `errors`; in `picker-studio-desktop.png` the Studio bar shows one compact button ("Claude Haiku") and its list open under it with All / Claude / Templates chips; the phone image shows the bottom sheet. Then `bun test` (PASS).

- [ ] **Step 6: Commit**

```bash
git add plugins-builtin/discover/js/studio.js plugins-builtin/discover/js/studio-actions.js plugins-builtin/discover/css/studio.css bin/ui-snapshot.mjs
git commit -m "Use the model picker for the Studio engine" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

---

### Task 8: Docs and full verification

**Files:**
- Modify: `AGENTS.md` (the "Shape" section)

- [ ] **Step 1: Document the new files**

In `AGENTS.md`, in the "Shape" list, after the bullet that begins `- \`src/plugin-format.ts\``, add:

```markdown
- `src/model-catalog.ts` is what the model picker lists: every provider OpenCode is connected to (from `opencode models
  --verbose`, cached, refreshed in the background), Anthropic for Claude Code and OpenAI for Codex, in one
  `providers → models` shape. The page side is `public/js/model-search.js` (pure: search, highlights, badges) and
  `public/js/model-picker.js` (`modelPickerSet(id, cfg)` registers a picker and `modelPickerHTML(id)` draws it, so a screen
  that rebuilds its markup just calls it again). A screen that gets a new model choice uses the picker instead of a
  `<select>`. The design is `docs/superpowers/specs/2026-09-29-model-picker-design.md`.
```

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: PASS (the previous total plus the new tests: 11 in `model-catalog`, 2 in `new-session-choices`, the `model-picker` and asset tests). Report the exact totals.

- [ ] **Step 3: Before/after snapshots of everything else**

Run (the base is the commit before this work, `c924f24`, the spec commit):
```bash
rm -rf /tmp/deck-base && mkdir -p /tmp/deck-base && git archive c924f24 | tar -x -C /tmp/deck-base
node bin/ui-snapshot.mjs --repo /tmp/deck-base --out /tmp/snap-before --port 4772 --views all-but-new
node bin/ui-snapshot.mjs --out /tmp/snap-after --port 4772 --views all-but-new
node bin/ui-compare.mjs /tmp/snap-before /tmp/snap-after --ignore-requests '^GET /(js|plugins|css)/'
```
Expected: it exits 1 and lists differences only in the views that contain a model choice: `codex-settings*`, `codex-new*` (the New session dialog's model field), `discover-mix` (the Studio bar) and `discover-research` if its dialog is part of it. Any difference elsewhere is a regression: fix it before continuing. The `codex-settings-save` request set must be identical (same POST bodies).

- [ ] **Step 4: A real click-through on an isolated test deck**

First list the deck's current data-dir and off switches, because they change over time:
```bash
grep -n "process.env.DECK_" src/server.ts | cut -c1-160
```
Start the test deck with every data dir pointed at a scratch folder (per the `test-deck-isolation` memory), with the real `HOME` so OpenCode's real credentials are used:
```bash
S=$(mktemp -d /tmp/deck-pick.XXXX)
DECK_PORT=4799 DECK_ROLE=node DECK_PLUGINS_DIR=$S/p DECK_PUSH_DIR=$S/push DECK_DISCOVER_DIR=$S/d DECK_JOURNEY_DIR=$S/j DECK_JOURNEY_AI=0 DECK_NO_LIBRARY=1 DECK_NO_JEV=1 DECK_NO_GUMROAD=1 bun src/server.ts > $S/log 2>&1 &
sleep 4; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4799/
```
Expected: `200`. (Add any new `DECK_*` switch the grep shows that reads or writes real data. Never touch ports 4747 or 8448.)

Write a scratch Playwright script (not committed) to the scratchpad directory and run it with node:

```js
// /private/tmp/claude-501/-Users-stas-2-Documents-Projects-herdr-deck/717f458f-0dbc-42ca-8e0d-f11c5727c5d1/scratchpad/pick.mjs
import { chromium } from "/Users/stas-2/.nvm/versions/node/v20.16.0/lib/node_modules/playwright/index.mjs";
const out = process.argv[2];
const browser = await chromium.launch();
for (const [name, vp] of [["desktop", { width: 1400, height: 900 }], ["phone", { width: 393, height: 873 }]]) {
  const page = await (await browser.newContext({ viewport: vp, isMobile: name === "phone" })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:4799/");
  await page.waitForFunction(() => typeof openNew === "function");
  await page.evaluate(() => openNew());
  await page.click('[data-kind="opencode"]');
  await page.click('[data-mp="new:opencode"][data-mp-open="provider"]');
  const provs = await page.$$eval(".mp-pop .mp-opt .mp-name", (n) => n.map((x) => x.textContent));
  console.log(name, "providers:", provs.join(" | "));
  await page.screenshot({ path: `${out}/${name}-1-providers.png` });
  await page.click('.mp-pop .mp-opt:has-text("OpenRouter")'); // goes straight to its models
  await page.waitForSelector(".mp-pop .mp-q");
  const total = await page.$eval(".mp-foot", (f) => f.textContent).catch(() => "");
  console.log(name, "footer:", total);
  await page.keyboard.type("claude sonnet");
  await page.waitForTimeout(150);
  const first = await page.$eval(".mp-pop .mp-opt.on .mp-id", (n) => n.textContent).catch(() => "(none)");
  console.log(name, "top match:", first);
  await page.screenshot({ path: `${out}/${name}-2-search.png` });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const cmd = await page.$eval("#nCmd", (n) => n.textContent);
  console.log(name, "command:", cmd);
  // ArrowDown on the button opens the list without also moving the deck's own selection.
  const sel0 = await page.evaluate(() => S.sel);
  await page.focus('[data-mp="new:opencode"][data-mp-open="model"]');
  await page.keyboard.press("ArrowDown");
  console.log(name, "ArrowDown opens the list:", !!(await page.$(".mp-pop")), "| the deck's selection unchanged:", (await page.evaluate(() => S.sel)) === sel0);
  await page.keyboard.press("Escape");
  // The model just chosen is pinned under "Recent", and the search box announces the highlighted row to a screen reader.
  await page.click('[data-mp="new:opencode"][data-mp-open="model"]');
  console.log(name, "groups:", await page.$$eval(".mp-pop .mp-h", (n) => n.map((x) => x.textContent).join(" | ")));
  console.log(name, "aria-activedescendant matches the highlight:", await page.evaluate(() => document.querySelector(".mp-q").getAttribute("aria-activedescendant") === document.querySelector(".mp-opt.on")?.id));
  await page.keyboard.press("Escape");
  // Esc closes the list, not the dialog.
  await page.click('[data-mp="new:opencode"][data-mp-open="model"]');
  await page.keyboard.press("Escape");
  console.log(name, "dialog still open after Esc in the list:", await page.$eval("#newDlg", (d) => d.open));
  // Typing an ID that is not listed.
  await page.click('[data-mp="new:opencode"][data-mp-open="model"]');
  await page.keyboard.type("someprovider/brand-new-model");
  await page.keyboard.press("Enter");
  console.log(name, "custom command:", await page.$eval("#nCmd", (n) => n.textContent));
  console.log(name, "page errors:", errors.length ? errors.join("; ") : "none");
  await page.close();
}
await browser.close();
```
Run: `mkdir -p /tmp/pick-shots && node <that path>/pick.mjs /tmp/pick-shots`
Expected, for both viewports: the provider list shows "All providers" plus this machine's OpenCode providers (at least OpenRouter, NanoGPT, abliteration.ai, OpenCode Zen) with model counts that add up to the `opencode models | wc -l` total; the footer says `Showing 60 of 385` (or the provider's own count) before typing; the top match for "claude sonnet" is a Claude Sonnet model's ID; `command:` ends with `-m openrouter/…claude-sonnet…`; `ArrowDown opens the list: true | the deck's selection unchanged: true` (if the deck's own key handler moves the selection or the list does not open, drop the ArrowDown shortcut from `model-picker.js`; Enter and Space still open it); `groups:` reads `Recent | All models`; `aria-activedescendant matches the highlight: true`; the dialog is still open after Esc in the list; `custom command:` contains `-m someprovider/brand-new-model`; `page errors: none`. Open the four PNGs with the Read tool and check they look right (aligned rows, highlighted matches, badges, the phone bottom sheet above where the keyboard would be).

Also run the same flow for Claude and Codex kinds by hand-adapting `[data-kind]` and the ID prefix (`new:claude`, `new:codex`) and confirm the Provider shows as a fixed label ("Anthropic", "OpenAI") with no provider button, and that the Codex effort chips still follow the chosen model.

Stop the test deck when done (each command runs in its own shell, so use the port): `lsof -ti tcp:4799 | xargs kill`. Leave it running through Step 5 if the user will check the phone.

- [ ] **Step 5: Tailnet check for the phone**

Per the machine's rule for showing work on the tailnet, share the test deck (tailnet only, never funnel), give the user the link, and remember to turn it off:
```bash
tailscale serve --bg --https=4799 http://localhost:4799
tailscale status --json | jq -r .Self.DNSName
```
The link is `https://<that name without the trailing dot>:4799`. The deck admits only the owner's Tailscale login and has a Host check: if the page is refused for the tailnet host name, tell the user instead of loosening the check. Ask the user to try the New session picker on their phone (the keyboard covering the list is the one thing Playwright cannot check). Afterwards: `tailscale serve --https=4799 off`. Do not touch port 8448.

- [ ] **Step 6: Restart the real deck and commit**

Only after the user has confirmed the phone check (or said to skip it): stop the test deck and the tailnet share, then restart the real deck so the running service serves the new page (`bin/install.sh` reloads the launchd service) and load it once: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4747/` must print `200`. Another machine's node (the Linux laptop) keeps its old New session options until it is redeployed with `bin/deploy-node.sh <ssh-host>`; the page falls back to one flat list for it, which still works.

```bash
git add AGENTS.md
git commit -m "Document the model picker and its catalog" -m "Claude-Session: https://claude.ai/code/session_01Ee6GCJA9JHsqsAx2KZ2xSR"
```

Then report to the user: test totals, the snapshot comparison result, what the click-through showed (with the measured provider counts), and anything not verified (an iPhone keyboard, if the phone check was skipped).
