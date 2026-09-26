import { describe, expect, test } from "bun:test";
import { cleanTail, isShellOnly } from "../src/tail";
import { cleanTitle } from "../src/deck";

describe("cleanTail", () => {
  test("drops Claude Code chrome and keeps the work", () => {
    const screen = [
      "⏺ Ran the test suite: 88 passing.",
      "✻ Brewed for 6m 25s · done 3:55 PM",
      "⏺ Remote Control disconnected — OAuth token unavailable — run /login to restore Remote Control",
      "────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────",
      "  Opus 5.5  main Weekly:99% 13h 15m wiki",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(cleanTail(screen)).toEqual(["⏺ Ran the test suite: 88 passing."]);
  });

  test("drops OpenCode footer and status lines", () => {
    const screen = [
      "     Commit bd272ee, deployed, verified on the live CSS chunk.",
      "     ▣  Build · Abliterated Model Large V2 · 4m 41s",
      "  ┃",
      "  ┃  Build · Abliterated Model Large V2 abliteration.ai · high",
      "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "   ~/wiki:main",
      "   /Users/me/notes          92.0K (9%) · $5.30  ctrl+p commands   • OpenCode 1.18.31",
    ].join("\n");
    expect(cleanTail(screen)).toEqual(["  Commit bd272ee, deployed, verified on the live CSS chunk."]);
  });

  test("keeps only the last N lines", () => {
    expect(cleanTail("a\nb\nc\nd\ne\nf", 2)).toEqual(["e", "f"]);
  });
});

describe("isShellOnly", () => {
  test("empty foreground or a bare shell is empty", () => {
    expect(isShellOnly([])).toBe(true);
    expect(isShellOnly([{ name: "zsh", argv0: "zsh" }])).toBe(true);
  });
  test("a running command is not empty", () => {
    expect(isShellOnly([{ name: "node", argv0: "npm" }])).toBe(false);
  });
});

describe("cleanTitle", () => {
  test("strips agent decorations", () => {
    expect(cleanTitle("OC | Honest project review", "xxx-quiz")).toBe("Honest project review");
    expect(cleanTitle("List latest Codex sessions | wiki", "wiki")).toBe("List latest Codex sessions");
    expect(cleanTitle("OpenCode", "wiki")).toBe("");
  });
});
