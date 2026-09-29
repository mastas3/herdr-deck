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
