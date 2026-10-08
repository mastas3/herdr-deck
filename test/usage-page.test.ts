import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The page's pure usage logic sits in a marked block of public/js/usage.js; evaluate it on its own.
const src = readFileSync(new URL("../public/js/usage.js", import.meta.url), "utf8");
const a = src.indexOf("// ── usage logic (pure");
const b = src.indexOf("// ── end usage logic");
const L = new Function(`${src.slice(a, b)}; return { accountFor, accountTag, usageState, windowNow, usageMachine };`)();

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

describe("a machine with two Claude logins (a Max profile on the work machine)", () => {
  const two = {
    self: "mac",
    accounts: [
      { id: "claude:max", provider: "claude", label: "personal", machines: ["mac", "linux"], profilesOn: { mac: ["/Users/me/.claude"], linux: ["/home/me/.claude-mac"] }, defaultOn: ["mac"] },
      { id: "claude:team", provider: "claude", label: "Corp LTD", machines: ["linux"], profilesOn: { linux: ["/home/me/.claude"] }, defaultOn: ["linux"] },
    ],
  };
  test("a session spends the login of its own profile, on either machine", () => {
    expect(L.accountFor({ agent: "claude", machine: "linux", claudeProfile: "/home/me/.claude-mac" }, two, "mac").id).toBe("claude:max");
    expect(L.accountFor({ agent: "claude", machine: "linux", claudeProfile: "/home/me/.claude" }, two, "mac").id).toBe("claude:team");
    expect(L.accountFor({ agent: "claude", machine: "mac", claudeProfile: "/Users/me/.claude" }, two, "mac").id).toBe("claude:max");
  });
  test("no profile yet: the machine's default login; an unread profile: unknown, never the other account", () => {
    expect(L.accountFor({ agent: "claude", machine: "linux" }, two, "mac").id).toBe("claude:team");
    expect(L.accountFor({ agent: "claude", machine: "linux", claudeProfile: "/home/me/.claude-other" }, two, "mac")).toBeUndefined();
  });
  test("a row's account tag names the plan's kind, so a stale herdr tag can be replaced", () => {
    expect(L.accountTag({ name: "Claude", label: "personal", plan: "Max 20x" })).toEqual({ text: "Max", title: "Claude · personal · Max 20x" });
    expect(L.accountTag({ name: "Claude", label: "Corp LTD", plan: "Team (Max 5x seat)" }).text).toBe("Team");
    expect(L.accountTag({ name: "Claude", label: "personal" }).text).toBe("personal");
    expect(L.accountTag(undefined)).toBeUndefined();
  });
  test("an older node sends no profiles: its one login is the machine's", () => {
    expect(L.accountFor({ agent: "claude", machine: "linux", claudeProfile: "/home/me/.claude-mac" }, usage, "mac").id).toBe("claude:w");
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
