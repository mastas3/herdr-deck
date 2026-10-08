import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { latestCodexLimits, parseClaudeCache, parseCodexLine } from "../src/usage";
import { claudeAccount, claudeAccounts, claudePlan, codexAccount, geminiAccount, labelFor, localUsage } from "../src/usage-accounts";
import { apiKeys, creditAccounts, refreshCredits } from "../src/usage-credits";
import { mergeUsage, nodeUsage } from "../src/usage-merge";

const S = 1000;
describe("Claude's rate-limit cache, both shapes", () => {
  test("the Mac statusline's shape: strings, seconds, `at`", () => {
    const l = parseClaudeCache({ five_hour: "14", seven_day: "60", five_hour_resets: 1790609400, seven_day_resets: 1790841600, at: 1790602393 })!;
    expect(l.at).toBe(1790602393 * S);
    expect(l.windows).toEqual([
      { id: "5h", label: "5h", minutes: 300, pct: 14, resets: 1790609400 * S },
      { id: "week", label: "week", minutes: 10080, pct: 60, resets: 1790841600 * S },
    ]);
  });
  test("the Linux statusline's shape: r5/r7, reset times as strings, `ts`", () => {
    const l = parseClaudeCache({ r5: 18, r7: 8, r5_resets_at: "1790607000", r7_resets_at: "1791039600", context_pct: 18, model: "Opus", cwd: "/x", ts: 1790602426 })!;
    expect(l.at).toBe(1790602426 * S);
    expect(l.windows.map((w) => [w.id, w.pct, w.resets])).toEqual([["5h", 18, 1790607000 * S], ["week", 8, 1791039600 * S]]);
  });
  test("absent limits are unknown, never 0%: empty strings, and the r5 script's 0 with no reset time", () => {
    expect(parseClaudeCache({ five_hour: "", seven_day: "", at: 5 })!.windows).toEqual([]);
    expect(parseClaudeCache({ r5: 0, r7: 0, r5_resets_at: "", r7_resets_at: "", ts: 5 })!.windows).toEqual([]);
    // a real 0% has a reset time
    expect(parseClaudeCache({ r5: 0, r7: 3, r5_resets_at: "1790607000", r7_resets_at: "1791039600", ts: 5 })!.windows[0].pct).toBe(0);
    const half = parseClaudeCache({ r5: 12, r7: 0, r5_resets_at: "1790607000", r7_resets_at: "", ts: 5 })!;
    expect(half.windows.map((w) => w.pct)).toEqual([12, undefined]);
  });
  test("no `at` falls back to the file's time; junk is nothing", () => {
    expect(parseClaudeCache({ five_hour: "1" }, 1234)!.at).toBe(1234);
    expect(parseClaudeCache(undefined)).toBeUndefined();
    expect(parseClaudeCache("x")).toBeUndefined();
  });
});

const codexLine = (ts: string, pct: number, plan = "pro") => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: pct, window_minutes: 10080, resets_at: 1791047604 }, secondary: null, plan_type: plan } } });
describe("Codex rate limits", () => {
  test("a line's reading is timed by the event, not the file", () => {
    const l = parseCodexLine(codexLine("2026-09-28T13:07:23.360Z", 31))!;
    expect(l).toEqual({ at: Date.parse("2026-09-28T13:07:23.360Z"), plan: "pro", windows: [{ id: "week", label: "week", pct: 31, resets: 1791047604 * S, minutes: 10080 }] });
    expect(parseCodexLine('{"type":"x"}')).toBeUndefined();
  });
  test("a resumed old rollout (newest file, old reading) loses to the newest reading", () => {
    const home = mkdtempSync(`${tmpdir()}/usage-codex-`);
    const d1 = `${home}/.codex/sessions/2026/09/09`, d2 = `${home}/.codex/sessions/2026/09/28`;
    mkdirSync(d1, { recursive: true }); mkdirSync(d2, { recursive: true });
    writeFileSync(`${d1}/old.jsonl`, codexLine("2026-09-09T11:00:47Z", 46, "prolite") + "\n" + JSON.stringify({ timestamp: "2026-09-28T13:10:00Z", type: "response_item" }) + "\n");
    writeFileSync(`${d2}/new.jsonl`, codexLine("2026-09-28T10:00:00Z", 20) + "\n" + codexLine("2026-09-28T13:07:23Z", 31) + "\n");
    const t = Date.now() / 1000;
    utimesSync(`${d2}/new.jsonl`, t - 600, t - 600);
    utimesSync(`${d1}/old.jsonl`, t, t); // written last (resumed), but its last rate_limits are weeks old
    const l = latestCodexLimits(home)!;
    expect(l.at).toBe(Date.parse("2026-09-28T13:07:23Z"));
    expect(l.windows[0].pct).toBe(31);
    expect(l.plan).toBe("pro");
  });
});

const jwt = (claims: object) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.SIGNATURE-SECRET`;
describe("who each account is", () => {
  test("Claude plans and labels", () => {
    expect(claudePlan({ organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" })).toBe("Max 20x");
    expect(claudePlan({ organizationType: "claude_team", seatTier: "team_tier_1", userRateLimitTier: "default_claude_max_5x" })).toBe("Team (Max 5x seat)");
    expect(claudePlan({ organizationType: "claude_pro" })).toBe("Pro");
    const personal = claudeAccount({ oauthAccount: { emailAddress: "me@gmail.com", organizationUuid: "org-1", organizationType: "claude_max", organizationName: "me@gmail.com's Organization" } }, undefined)!;
    expect(personal.label).toBe("personal");
    expect(personal.note).toContain("statusline");
    expect(personal.at).toBeUndefined();
    const work = claudeAccount({ oauthAccount: { emailAddress: "me@corp.example", organizationUuid: "org-2", organizationType: "claude_team", organizationName: "Corp LTD" } }, { at: 5, windows: [{ id: "5h", label: "5h", pct: 3 }] })!;
    expect(work.label).toBe("Corp LTD");
    expect(work.at).toBe(5);
    expect(work.id).not.toBe(personal.id);
    expect(work.id).not.toContain("org-2");
  });
  test("Codex from the id_token's claims only", () => {
    const a = codexAccount({ tokens: { id_token: jwt({ email: "me@gmail.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-123" } }), access_token: "AT", refresh_token: "RT" } }, undefined)!;
    expect(a).toMatchObject({ provider: "codex", email: "me@gmail.com", plan: "Pro", label: "personal", kind: "plan" });
    expect(JSON.stringify(a)).not.toContain("acct-123");
    expect(codexAccount({ tokens: { id_token: jwt({ email: "x@y.com", "https://api.openai.com/auth": { chatgpt_plan_type: "team" } }) } }, undefined)!.label).toBe("work");
  });
  test("Gemini's active login; labels", () => {
    expect(geminiAccount({ active: "me@corp.example" }, { security: { auth: { selectedType: "oauth-personal" } } })).toMatchObject({ label: "corp.example", plan: "Google login", kind: "signin" });
    expect(geminiAccount({ active: null }, {})).toBeUndefined();
    expect(labelFor("a@gmail.com")).toBe("personal");
    expect(labelFor("a@corp.example", "Corp")).toBe("Corp");
  });
});

describe("several Claude logins on one machine (CLAUDE_CONFIG_DIR profiles)", () => {
  const team = { emailAddress: "me@corp.example", organizationUuid: "org-team", organizationType: "claude_team", organizationName: "Corp LTD" };
  const max = { emailAddress: "me@gmail.com", organizationUuid: "org-max", organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" };
  function twoLogins() {
    const home = mkdtempSync(`${tmpdir()}/usage-profiles-`);
    for (const d of [".claude/projects", ".claude-mac/projects"]) mkdirSync(`${home}/${d}`, { recursive: true });
    writeFileSync(`${home}/.claude.json`, JSON.stringify({ oauthAccount: team }));
    writeFileSync(`${home}/.claude/rate-cache.json`, JSON.stringify({ r5: 40, r7: 100, r5_resets_at: "1790607000", r7_resets_at: "1791039600", ts: 1790602000 }));
    writeFileSync(`${home}/.claude-mac/.claude.json`, JSON.stringify({ oauthAccount: max }));
    writeFileSync(`${home}/.claude-mac/rate-cache.json`, JSON.stringify({ r5: 3, r7: 9, r5_resets_at: "1790607000", r7_resets_at: "1791039600", ts: 1790602100 }));
    return home;
  }
  test("each profile is its own account with its own limits; ~/.claude is the default", () => {
    const home = twoLogins();
    const list = claudeAccounts(home, { CLAUDE_CONFIG_DIR: "", DECK_CLAUDE_CONFIG_DIRS: "" });
    expect(list.map((a) => [a.label, a.plan, a.profiles, a.isDefault, a.windows?.map((w) => w.pct)])).toEqual([
      ["Corp LTD", "Team", [`${home}/.claude`], true, [40, 100]],
      ["personal", "Max 20x", [`${home}/.claude-mac`], false, [3, 9]],
    ]);
  });
  test("a profile with no limits of its own never borrows the other login's", () => {
    const home = twoLogins();
    rmSync(`${home}/.claude-mac/rate-cache.json`);
    const max1 = claudeAccounts(home, { CLAUDE_CONFIG_DIR: "", DECK_CLAUDE_CONFIG_DIRS: "" }).find((a) => a.plan === "Max 20x")!;
    expect(max1.windows).toBeUndefined();
    expect(max1.note).toContain("statusline");
  });
  test("two profiles signed in to one account are one entry listing both", () => {
    const home = twoLogins();
    writeFileSync(`${home}/.claude-mac/.claude.json`, JSON.stringify({ oauthAccount: team }));
    const list = claudeAccounts(home, { CLAUDE_CONFIG_DIR: "", DECK_CLAUDE_CONFIG_DIRS: "" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ profiles: [`${home}/.claude`, `${home}/.claude-mac`], isDefault: true, at: 1790602100 * S });
  });
  test("the hub keeps which profile on which machine spends each account", () => {
    const home = twoLogins();
    const linux = localUsage(home, { CLAUDE_CONFIG_DIR: "", DECK_CLAUDE_CONFIG_DIRS: "" });
    const mac = { at: 1, accounts: [{ ...claudeAccount({ oauthAccount: max }, { at: 1790602200 * S, windows: [{ id: "week", label: "week", pct: 11 }] })!, profiles: ["/Users/me/.claude"], isDefault: true }] };
    const u = mergeUsage("mac", { mac, linux });
    const m = u.accounts.find((a) => a.plan === "Max 20x")!;
    expect(m.machines).toEqual(["mac", "linux"]);
    expect(m.profilesOn).toEqual({ mac: ["/Users/me/.claude"], linux: [`${home}/.claude-mac`] });
    expect(m.defaultOn).toEqual(["mac"]);
    expect(m.windows![0].pct).toBe(11); // the Mac's newer reading of the same account
    expect(JSON.stringify(m)).not.toContain('"isDefault"');
    const t = u.accounts.find((a) => a.label === "Corp LTD")!;
    expect(t).toMatchObject({ machines: ["linux"], profilesOn: { linux: [`${home}/.claude`] }, defaultOn: ["linux"] });
    expect(nodeUsage(u)).toEqual(mac); // a node's own reading is passed on untouched
  });
});

describe("one list for every machine", () => {
  const acct = (id: string, provider: string, at?: number, pct?: number) => ({ id, provider, name: provider, kind: "plan" as const, at, windows: pct == null ? undefined : [{ id: "week", label: "week", pct }] });
  test("the same account on two machines is one entry; the freshest reading wins and both machines are listed", () => {
    const u = mergeUsage("mac", {
      mac: { at: 1, accounts: [acct("claude:p", "claude", 100, 14), acct("codex:x", "codex", 500, 31)] },
      linux: { at: 1, accounts: [acct("claude:w", "claude", 200, 18), acct("codex:x", "codex", 300, 6)] },
      old: undefined,
    });
    expect(u.accounts.map((a) => a.id)).toEqual(["claude:p", "claude:w", "codex:x"]);
    const codex = u.accounts.find((a) => a.id === "codex:x")!;
    expect(codex.machines).toEqual(["mac", "linux"]);
    expect(codex.from).toBe("mac");
    expect(codex.windows![0].pct).toBe(31);
    // the other way round
    const v = mergeUsage("mac", { linux: { at: 1, accounts: [acct("codex:x", "codex", 900, 50)] }, mac: { at: 1, accounts: [acct("codex:x", "codex", 500, 31)] } });
    expect(v.accounts[0]).toMatchObject({ from: "linux", machines: ["linux", "mac"] });
    expect(v.accounts[0].windows![0].pct).toBe(50);
  });
  test("a reading beats no reading; a node's own part comes out of its payload; an older deck's shape is ignored", () => {
    const u = mergeUsage("a", { a: { at: 1, accounts: [acct("codex:x", "codex")] }, b: { at: 1, accounts: [acct("codex:x", "codex", 5, 1)] } });
    expect(u.accounts[0].from).toBe("b");
    expect(nodeUsage(u)).toEqual({ at: 1, accounts: [acct("codex:x", "codex")] });
    expect(nodeUsage({ claude: { fiveHour: 3 }, codex: undefined })).toBeUndefined();
  });
});

describe("secrets never leave the server", () => {
  const SECRETS = ["sk-or-v1-PLANTED-OPENROUTER", "PLANTED-NANO-KEY", "PLANTED-ABL-KEY", "PLANTED-ENV-OR-KEY", "PLANTED-ACCESS-TOKEN", "PLANTED-REFRESH-TOKEN", "SIGNATURE-SECRET", "PLANTED-GEMINI-REFRESH", "PLANTED-CLAUDE-OAUTH", "sk-openai-PLANTED"];
  function fakeHome() {
    const home = mkdtempSync(`${tmpdir()}/usage-secrets-`);
    for (const d of [".claude", ".codex/sessions/2026/09/28", ".gemini", ".local/share/opencode"]) mkdirSync(`${home}/${d}`, { recursive: true });
    writeFileSync(`${home}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: "me@gmail.com", organizationUuid: "u1", organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" }, primaryApiKey: "PLANTED-CLAUDE-OAUTH" }));
    writeFileSync(`${home}/.claude/rate-cache.json`, JSON.stringify({ five_hour: "14", seven_day: "60", five_hour_resets: 1790609400, seven_day_resets: 1790841600, at: 1790602393 }));
    writeFileSync(`${home}/.codex/auth.json`, JSON.stringify({ OPENAI_API_KEY: "sk-openai-PLANTED", tokens: { id_token: jwt({ email: "me@gmail.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "a1" } }), access_token: "PLANTED-ACCESS-TOKEN", refresh_token: "PLANTED-REFRESH-TOKEN", account_id: "a1" } }));
    writeFileSync(`${home}/.codex/sessions/2026/09/28/r.jsonl`, codexLine("2026-09-28T13:07:23Z", 31) + "\n");
    writeFileSync(`${home}/.gemini/google_accounts.json`, JSON.stringify({ active: "me@gmail.com", old: [] }));
    writeFileSync(`${home}/.gemini/oauth_creds.json`, JSON.stringify({ refresh_token: "PLANTED-GEMINI-REFRESH" }));
    writeFileSync(`${home}/.local/share/opencode/auth.json`, JSON.stringify({ openrouter: { type: "api", key: "sk-or-v1-PLANTED-OPENROUTER" }, "nano-gpt": { type: "api", key: "PLANTED-NANO-KEY" }, "abliteration-ai": { type: "api", key: "PLANTED-ABL-KEY" }, "github-copilot": { type: "oauth", refresh: "PLANTED-ACCESS-TOKEN" } }));
    return home;
  }
  test("every account comes out, with balances, and no key, token or id_token anywhere in it", async () => {
    const home = fakeHome();
    const env = { OPENROUTER_API_KEY: "PLANTED-ENV-OR-KEY" };
    const used: string[] = [];
    await refreshCredits(home, env, async (provider, key) => {
      used.push(key);
      if (provider === "nano-gpt") throw new Error(`bad key ${key}`); // an error that echoes the key
      return provider === "openrouter" ? { total: 270, used: 257.79, left: 12.21 } : { total: 156.36, used: 154.43, left: 1.93 };
    });
    expect(used.sort()).toEqual(["PLANTED-ABL-KEY", "PLANTED-ENV-OR-KEY", "PLANTED-NANO-KEY", "sk-or-v1-PLANTED-OPENROUTER"].sort());
    const out = JSON.stringify(mergeUsage("mac", { mac: localUsage(home, env) }));
    for (const s of SECRETS) expect(out).not.toContain(s);
    const u = JSON.parse(out);
    const by = (p: string) => u.accounts.filter((a: any) => a.provider === p);
    expect(by("claude")[0]).toMatchObject({ label: "personal", plan: "Max 20x", email: "me@gmail.com" });
    expect(by("claude")[0].windows.map((w: any) => w.pct)).toEqual([14, 60]);
    expect(by("codex")[0].windows[0].pct).toBe(31);
    expect(by("gemini")[0].kind).toBe("signin");
    expect(by("openrouter").map((a: any) => [a.label, a.balance?.left]).sort()).toEqual([["$OPENROUTER_API_KEY", 12.21], ["OpenCode key", 12.21]]);
    expect(by("nano-gpt")[0].error).toBe("couldn’t reach the provider");
    expect(by("abliteration-ai")[0].balance).toEqual({ total: 156.36, used: 154.43, left: 1.93, currency: "USD" });
    expect(by("github-copilot")[0].kind).toBe("signin");
  });
  test("the same key twice (OpenCode and the env) is one account", () => {
    const home = fakeHome();
    expect(apiKeys(home, { OPENROUTER_API_KEY: "sk-or-v1-PLANTED-OPENROUTER" }).filter((k) => k.provider === "openrouter")).toHaveLength(1);
    expect(creditAccounts(home, {}).every((a) => !JSON.stringify(a).includes("PLANTED"))).toBe(true);
  });
});
