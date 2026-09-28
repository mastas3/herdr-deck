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
