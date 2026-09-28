import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The page's pure usage logic sits in a marked block of public/js/usage.js; evaluate it on its own.
const src = readFileSync(new URL("../public/js/usage.js", import.meta.url), "utf8");
const a = src.indexOf("// ── usage logic (pure");
const b = src.indexOf("// ── end usage logic");
const L = new Function(`${src.slice(a, b)}; return { accountFor, usageState, windowNow, usageMachine };`)();

const NOW = 1_790_602_400_000;
const usage = {
  self: "mac",
  accounts: [
    { id: "claude:p", provider: "claude", label: "personal", machines: ["mac"], at: NOW - 60_000, windows: [{ id: "5h", label: "5h", pct: 14, resets: NOW + 3600_000 }] },
    { id: "claude:w", provider: "claude", label: "Omnitelecom LTD", machines: ["linux"], at: NOW - 60_000, windows: [{ id: "5h", label: "5h", pct: 18, resets: NOW + 3600_000 }] },
    { id: "codex:x", provider: "codex", label: "personal", machines: ["mac", "linux"], from: "mac", at: NOW - 120_000, windows: [{ id: "week", label: "week", pct: 31 }] },
    { id: "openrouter:f", provider: "openrouter", label: "OpenCode", kind: "credits", machines: ["mac"], at: NOW, balance: { left: 12.21 } },
  ],
};

describe("which account a session spends", () => {
  test("Claude: the session's own machine's login, so the Mac and the Linux box differ", () => {
    expect(L.accountFor({ agent: "claude", machine: "mac" }, usage, "mac").id).toBe("claude:p");
    expect(L.accountFor({ agent: "claude", machine: "linux" }, usage, "mac").id).toBe("claude:w");
  });
  test("Codex: one account signed in on both machines; Codex app threads are this machine's", () => {
    expect(L.accountFor({ agent: "codex", machine: "linux" }, usage, "mac").id).toBe("codex:x");
    expect(L.accountFor({ agent: "codex", machine: "codex-app" }, usage, "mac").id).toBe("codex:x");
  });
  test("OpenCode: the provider its model is from; unknown provider or machine: nothing", () => {
    expect(L.accountFor({ agent: "opencode", machine: "mac", provider: "openrouter" }, usage, "mac").id).toBe("openrouter:f");
    expect(L.accountFor({ agent: "opencode", machine: "linux", provider: "openrouter" }, usage, "mac")).toBeUndefined();
    expect(L.accountFor({ agent: "opencode", machine: "mac" }, usage, "mac")).toBeUndefined();
    expect(L.accountFor({ agent: "claude", machine: "pi" }, usage, "mac")).toBeUndefined();
    expect(L.accountFor({ agent: "claude", machine: "mac" }, {}, "mac")).toBeUndefined();
  });
});

describe("stale and unknown are never shown as current", () => {
  test("fresh within 30 minutes, stale after, unknown with no reading, error when refused with nothing older", () => {
    expect(L.usageState({ at: NOW - 29 * 60_000, windows: [{ pct: 1 }] }, NOW)).toBe("fresh");
    expect(L.usageState({ at: NOW - 31 * 60_000, windows: [{ pct: 1 }] }, NOW)).toBe("stale");
    expect(L.usageState({ windows: [{ pct: 1 }] }, NOW)).toBe("unknown");
    expect(L.usageState({ at: NOW, windows: [] }, NOW)).toBe("unknown");
    expect(L.usageState({ kind: "signin" }, NOW)).toBe("unknown");
    expect(L.usageState(undefined, NOW)).toBe("unknown");
    expect(L.usageState({ error: "the provider rejected this key" }, NOW)).toBe("error");
    expect(L.usageState({ error: "x", at: NOW - 60_000, balance: { left: 3 } }, NOW)).toBe("fresh");
  });
  test("a window never read, or reset since its reading, has no percent (not 0%)", () => {
    expect(L.windowNow({ label: "5h" }, NOW)).toMatchObject({ pct: null, why: "unknown" });
    expect(L.windowNow({ label: "5h", pct: 40, resets: NOW - 1 }, NOW)).toMatchObject({ pct: null, why: "reset" });
    expect(L.windowNow({ label: "5h", pct: 0, resets: NOW + 1 }, NOW)).toMatchObject({ pct: 0, why: "" });
  });
});
