import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeWindow, contextLimit, parseClaudeHead, parseClaudeTail, parseCodex, resumeCommand } from "../src/agents";

const j = (...o: object[]) => o.map((x) => JSON.stringify(x));

describe("Claude transcripts", () => {
  test("head: creation time and first real prompt, skipping command caveats", () => {
    const head = j(
      { type: "permission-mode", sessionId: "s" },
      { type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: "<local-command-caveat>x</local-command-caveat>" } },
      { type: "user", timestamp: "2026-09-20T10:00:05Z", message: { content: [{ type: "text", text: "Build the <b>deck</b>" }] } },
    );
    const h = parseClaudeHead(head);
    expect(h.createdAt).toBe(Date.parse("2026-09-20T10:00:00Z"));
    expect(h.firstPrompt).toBe("Build the deck");
  });

  test("tail: last activity, model, context from the last real assistant turn", () => {
    const tail = j(
      { type: "assistant", timestamp: "2026-09-21T09:00:00Z", message: { model: "claude-opus-5-5", usage: { input_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 96 }, content: [{ type: "text", text: "Done." }] } },
      { type: "assistant", timestamp: "2026-09-21T09:00:01Z", message: { model: "<synthetic>", usage: { input_tokens: 0 }, content: [] } },
      { type: "system", timestamp: "2026-09-22T00:00:00Z" },
    );
    const t = parseClaudeTail(tail);
    expect(t).toMatchObject({ model: "claude-opus-5-5", ctxTokens: 1100, lastMessage: "Done.", lastActiveAt: Date.parse("2026-09-21T09:00:01Z") });
  });
});

describe("Codex rollouts", () => {
  test("reads meta, context window and last agent message", () => {
    const head = j(
      { timestamp: "2026-07-26T22:20:53Z", type: "session_meta", payload: { timestamp: "2026-07-26T22:18:05Z" } },
      { timestamp: "2026-07-26T22:21:00Z", type: "event_msg", payload: { type: "user_message", message: "List sessions" } },
    );
    const tail = j(
      { timestamp: "2026-07-27T00:49:10Z", type: "turn_context", payload: { model: "gpt-6" } },
      { timestamp: "2026-07-27T00:49:11Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000 }, model_context_window: 250000 } } },
      { timestamp: "2026-07-27T00:49:12Z", type: "event_msg", payload: { type: "agent_message", message: "Here they are." } },
    );
    const m = parseCodex(head, tail);
    expect(m).toMatchObject({
      createdAt: Date.parse("2026-07-26T22:18:05Z"),
      firstPrompt: "List sessions",
      model: "gpt-6",
      ctxTokens: 5000,
      ctxWindow: 250000,
      lastMessage: "Here they are.",
      empty: false,
    });
  });
  test("model falls back to the first turn when the tail has no turn_context; the tail's wins", () => {
    const head = j(
      { timestamp: "2026-07-26T22:20:53Z", type: "session_meta", payload: { timestamp: "2026-07-26T22:18:05Z" } },
      { timestamp: "2026-07-26T22:20:54Z", type: "turn_context", payload: { model: "gpt-6-astra" } },
      { timestamp: "2026-07-26T22:21:00Z", type: "event_msg", payload: { type: "user_message", message: "Hi" } },
    );
    const tail = j({ timestamp: "2026-07-27T00:49:11Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 70000 }, model_context_window: 258400 } } });
    expect(parseCodex(head, tail)).toMatchObject({ model: "gpt-6-astra", ctxTokens: 70000, ctxWindow: 258400 });
    const newer = j({ timestamp: "2026-07-27T00:50:00Z", type: "turn_context", payload: { model: "gpt-6-sol" } });
    expect(parseCodex(head, newer).model).toBe("gpt-6-sol");
  });
});

describe("OpenCode context windows", () => {
  const cat = { openrouter: { models: { "x-ai/grok-4.6": { limit: { context: 500000 } } } }, "x-ai": { models: { "grok-9": { limit: { context: 2000000 } } } }, odd: { models: { m: { limit: { context: 0 } } } } };
  test("looks the model up under its provider", () => expect(contextLimit(cat, "openrouter", "x-ai/grok-4.6")).toBe(500000));
  test("falls back to the vendor prefix of the id", () => expect(contextLimit(cat, "nowhere", "x-ai/grok-9")).toBe(2000000));
  test("unknown or bad entries give nothing", () => {
    expect(contextLimit(cat, "openrouter", "nope")).toBeUndefined();
    expect(contextLimit(cat, "odd", "m")).toBeUndefined();
    expect(contextLimit(undefined, "openrouter", "x-ai/grok-4.6")).toBeUndefined();
    expect(contextLimit(cat, "openrouter", undefined)).toBeUndefined();
  });
});

describe("Claude context windows", () => {
  const home = mkdtempSync(`${tmpdir()}/deck-ctx-`);
  mkdirSync(`${home}/.claude/context-cache`, { recursive: true });
  const put = (id: string, body: string) => writeFileSync(`${home}/.claude/context-cache/${id}.json`, body);
  test("the window the status line saved for the session", () => {
    put("s1m", '{"window":1000000,"used":12,"at":1}');
    expect(claudeWindow("s1m", "claude-opus-5-5", home, 1000)).toBe(1000000);
  });
  test("a session without one borrows the window last seen for its model", () => {
    expect(claudeWindow("snone", "claude-opus-5-5", home, 1000)).toBe(1000000);
    expect(claudeWindow("snone", "claude-haiku-4-5", home, 1000)).toBeUndefined();
  });
  test("re-read after 30 s, so a new file or a /model switch shows up", () => {
    expect(claudeWindow("slate", undefined, home, 1000)).toBeUndefined();
    put("slate", '{"window":200000}');
    expect(claudeWindow("slate", undefined, home, 2000)).toBeUndefined();
    expect(claudeWindow("slate", undefined, home, 32_000)).toBe(200000);
  });
  test("bad files give nothing", () => {
    put("sbad", "{not json");
    put("szero", '{"window":0}');
    expect(claudeWindow("sbad", undefined, home, 1000)).toBeUndefined();
    expect(claudeWindow("szero", undefined, home, 1000)).toBeUndefined();
  });
});

test("resume commands", () => {
  expect(resumeCommand("claude", "abc")).toBe("claude --resume abc");
  expect(resumeCommand("codex", "abc")).toBe("codex resume abc");
  expect(resumeCommand("opencode", "ses_1")).toBe("opencode -s ses_1");
  expect(resumeCommand("shell", "x")).toBeUndefined();
});
