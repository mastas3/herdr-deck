import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The chat's model + effort chip (public/js/model-chip.js). Run just its pure block: names, labels, who can change
// what, and what gets typed into Claude Code.
const src = readFileSync(new URL("../public/js/model-chip.js", import.meta.url), "utf8");
const { mchipModelName, mchipLabel, mchipMode, mchipFamily, mchipClaudeCommand } = new Function(
  `${src.slice(src.indexOf("// <model-chip-pure>"), src.indexOf("// </model-chip-pure>"))}; return { mchipModelName, mchipLabel, mchipMode, mchipFamily, mchipClaudeCommand };`,
)();

describe("model names", () => {
  test("Claude ids read as their family and version", () => {
    expect(mchipModelName({ agent: "claude", model: "claude-opus-5-5" })).toBe("Opus 5.5");
    expect(mchipModelName({ agent: "claude", model: "claude-haiku-4-5-20251001" })).toBe("Haiku 4.5");
    expect(mchipModelName({ agent: "claude", model: "claude-fable-5-1" })).toBe("Fable 5.1");
  });
  test("a model Claude Code just switched to wins over the last reply's", () => {
    expect(mchipModelName({ agent: "claude", model: "claude-opus-5-5", modelName: "Sonnet 5.5" })).toBe("Sonnet 5.5");
  });
  test("before the first reply, the flags it was started with say what it runs on", () => {
    const fresh = { agent: "claude", command: "claude --model haiku --effort=max --dangerously-skip-permissions" };
    expect(mchipModelName(fresh)).toBe("Haiku");
    expect(mchipLabel(fresh)).toBe("Haiku · max");
    expect(mchipLabel({ agent: "claude", command: "/Users/x/.local/bin/claude --model claude-opus-5-5" })).toBe("Opus 5.5");
    expect(mchipLabel({ agent: "codex", command: `codex -m gpt-6-astra -c model_reasoning_effort="low"` })).toBe("gpt-6-astra · low");
    // What the session reports wins over how it was started.
    expect(mchipLabel({ ...fresh, model: "claude-sonnet-5-5", effort: "high" })).toBe("Sonnet 5.5 · high");
    expect(mchipFamily(fresh)).toBe("haiku");
  });
  test("other agents keep their id; OpenCode drops the vendor prefix", () => {
    expect(mchipModelName({ agent: "codex", model: "gpt-6-astra" })).toBe("gpt-6-astra");
    expect(mchipModelName({ agent: "opencode", model: "deepseek/deepseek-v4-flash" })).toBe("deepseek-v4-flash");
    expect(mchipModelName({ agent: "claude" })).toBe("");
  });
});

describe("the chip's label", () => {
  test("model and effort, shorter on a phone", () => {
    const r = { agent: "claude", model: "claude-opus-5-5", effort: "xhigh" };
    expect(mchipLabel(r)).toBe("Opus 5.5 · xhigh");
    expect(mchipLabel(r, true)).toBe("Opus · xhigh");
  });
  test("no model yet reads as the default; no effort is left out", () => {
    expect(mchipLabel({ agent: "claude" })).toBe("Default model");
    expect(mchipLabel({ agent: "codex", model: "gpt-6-astra" })).toBe("gpt-6-astra");
  });
});

describe("who can change what", () => {
  test("Claude Code panes take typed commands; Codex app tasks use the app; Codex CLI and OpenCode use their own picker", () => {
    expect(mchipMode({ agent: "claude" })).toBe("claude");
    expect(mchipMode({ agent: "codex", app: "codex" })).toBe("codex-app");
    expect(mchipMode({ agent: "codex" })).toBe("terminal");
    expect(mchipMode({ agent: "opencode" })).toBe("terminal");
  });
  test("past sessions and other agents get no chip", () => {
    expect(mchipMode({ agent: "claude", hist: true })).toBe("");
    expect(mchipMode({ agent: "gemini" })).toBe("");
    expect(mchipMode(undefined)).toBe("");
  });
  test("the Claude family is found from the id or the switched-to name", () => {
    expect(mchipFamily({ agent: "claude", model: "claude-opus-5-5" })).toBe("opus");
    expect(mchipFamily({ agent: "claude", model: "claude-opus-5-5", modelName: "Fable 5.1" })).toBe("fable");
    expect(mchipFamily({ agent: "claude" })).toBe("");
  });
});

describe("what gets typed into Claude Code", () => {
  test("model aliases and effort levels", () => {
    expect(mchipClaudeCommand("model", "sonnet")).toBe("/model sonnet");
    expect(mchipClaudeCommand("effort", "max")).toBe("/effort max");
    expect(mchipClaudeCommand("effort", "auto")).toBe("/effort auto");
  });
  test("anything else is refused, so nothing odd is ever typed into a pane", () => {
    expect(mchipClaudeCommand("model", "opus; rm -rf")).toBeNull();
    expect(mchipClaudeCommand("effort", "huge")).toBeNull();
    expect(mchipClaudeCommand("mode", "plan")).toBeNull();
  });
});
