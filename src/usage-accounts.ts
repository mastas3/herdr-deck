// Every AI account signed in on this machine, with its limits or balance where the tool or provider gives one: Claude
// Code, Codex, Gemini CLI, and OpenCode's providers. Identity is who you are (email, organisation, plan), read from the
// tools' own files; tokens and keys are never kept, and account ids are one-way fingerprints.
import { homedir } from "node:os";
import { claudeLimits, latestCodexLimits, readJson, type Limits, type Window } from "./usage";
import { creditAccounts, fingerprint, otherSignIns } from "./usage-credits";

export type Balance = { left?: number; total?: number; used?: number; currency: "USD" };
export type Account = {
  id: string; provider: string; name: string;
  /** Short, for the status line: "personal", an organisation, or where a key comes from. */
  label?: string; email?: string; plan?: string;
  kind: "plan" | "credits" | "signin";
  /** When the reading (windows or balance) was taken. */
  at?: number; windows?: Window[]; balance?: Balance; error?: string; note?: string;
};
/** One machine's accounts, as its own deck reads them. */
export type MachineUsage = { at: number; accounts: Account[] };

const PERSONAL = /@(gmail|googlemail|outlook|hotmail|live|icloud|me|mac|yahoo|proton|protonmail|pm)\./i;
/** "personal" for a consumer address, else the organisation or the address's domain. */
export const labelFor = (email?: string, org?: string) => org || (email && !PERSONAL.test(email) ? email.split("@")[1] : "personal");
const cap = (s?: string) => (s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : undefined);

/** Claude plan from ~/.claude.json's oauthAccount: "Max 20x", "Team (Max 5x seat)", "Pro". */
export function claudePlan(oa: any): string | undefined {
  if (!oa) return;
  const x = (t?: string) => t?.match(/max_(\d+x)/)?.[1];
  const type = String(oa.organizationType ?? "").replace(/^claude_/, "");
  const tier = x(oa.organizationRateLimitTier) ?? x(oa.userRateLimitTier);
  if (type === "max") return tier ? `Max ${tier}` : "Max";
  if (type) return x(oa.userRateLimitTier) ? `${cap(type)} (Max ${x(oa.userRateLimitTier)} seat)` : cap(type);
  return oa.billingType === "stripe_subscription" ? "subscription" : undefined;
}

export function claudeAccount(claudeJson: any, limits: Limits | undefined): Account | undefined {
  const oa = claudeJson?.oauthAccount;
  if (!oa && !limits) return;
  const work = /team|enterprise/.test(String(oa?.organizationType ?? ""));
  const acct: Account = {
    id: `claude:${fingerprint(String(oa?.organizationUuid ?? oa?.accountUuid ?? oa?.emailAddress ?? "local"))}`, provider: "claude", name: "Claude",
    label: oa ? labelFor(oa.emailAddress, work ? oa.organizationName : undefined) : undefined, email: oa?.emailAddress, plan: claudePlan(oa), kind: "plan",
  };
  if (limits?.windows.length) return { ...acct, at: limits.at, windows: limits.windows };
  return { ...acct, note: limits ? "Claude Code hasn’t reported limits here lately" : "no limits cached yet: the statusline script writes them while a session runs" };
}

/** The id_token's claims (email, plan, account). Only its payload is decoded; no token leaves this function. */
export function jwtClaims(token: unknown): any {
  if (typeof token !== "string") return;
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")); } catch {}
}

export function codexAccount(auth: any, limits: Limits | undefined): Account | undefined {
  if (!auth) return;
  const c = jwtClaims(auth.tokens?.id_token);
  const a = c?.["https://api.openai.com/auth"] ?? {};
  if (!c && auth.OPENAI_API_KEY) return { id: `codex:${fingerprint(String(auth.OPENAI_API_KEY))}`, provider: "codex", name: "Codex", label: "API key", kind: "signin", note: "signed in with an OpenAI API key; Codex reports no plan limits for it" };
  if (!c) return;
  const plan = limits?.plan ?? a.chatgpt_plan_type;
  const acct: Account = {
    id: `codex:${fingerprint(String(a.chatgpt_account_id ?? auth.tokens?.account_id ?? c.email ?? "local"))}`, provider: "codex", name: "Codex",
    label: /team|business|enterprise|edu/.test(String(plan)) ? labelFor(c.email, "work") : labelFor(c.email), email: c.email, plan: cap(plan), kind: "plan",
  };
  if (limits?.windows.length) return { ...acct, at: limits.at, windows: limits.windows };
  return { ...acct, note: "no Codex session has reported limits here yet" };
}

export function geminiAccount(accounts: any, settings: any): Account | undefined {
  const email = accounts?.active;
  if (!email) return;
  const how = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType;
  return { id: `gemini:${fingerprint(email)}`, provider: "gemini", name: "Gemini", label: labelFor(email), email, plan: how === "oauth-personal" ? "Google login" : cap(how), kind: "signin", note: "Gemini CLI writes no usage data" };
}

/** This machine's accounts, read now (credit balances come from the last refresh). */
export function localUsage(home = homedir(), env = process.env): MachineUsage {
  const accounts = [
    claudeAccount(readJson(`${home}/.claude.json`), claudeLimits(home)),
    codexAccount(readJson(`${home}/.codex/auth.json`), latestCodexLimits(home)),
    geminiAccount(readJson(`${home}/.gemini/google_accounts.json`), readJson(`${home}/.gemini/settings.json`)),
    ...creditAccounts(home, env),
    ...otherSignIns(home),
  ].filter(Boolean) as Account[];
  return { at: Date.now(), accounts };
}
