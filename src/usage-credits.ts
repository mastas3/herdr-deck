// Credit balances of the pay-as-you-go API keys on this machine (OpenCode's providers, or the usual env names), from
// each provider's documented read-only endpoint. Keys are read here, sent only to their own provider, and never kept in
// what this returns, logged, or sent to the page: an account is known by a one-way fingerprint of its key.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readJson } from "./usage";
import type { Account } from "./usage-accounts";

export const fingerprint = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

type Api = { name: string; env: string; fetch: (key: string) => Promise<{ left?: number; total?: number; used?: number }> };
const getJson = async (url: string, init: RequestInit) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (r.status === 401 || r.status === 403) throw new Error("the provider rejected this key");
  if (!r.ok) throw new Error(`the provider answered ${r.status}`);
  return r.json() as Promise<any>;
};
const n = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
const spent = (total?: number, used?: number) => ({ total, used, left: total != null && used != null ? Math.round((total - used) * 100) / 100 : undefined });

/** Providers with a documented balance endpoint. */
export const APIS: Record<string, Api> = {
  // https://openrouter.ai/docs/api-reference/get-credits: credits bought and used, for the key's account
  openrouter: { name: "OpenRouter", env: "OPENROUTER_API_KEY", fetch: async (key) => { const d = (await getJson("https://openrouter.ai/api/v1/credits", { headers: { authorization: `Bearer ${key}` } })).data; return spent(n(d?.total_credits), n(d?.total_usage)); } },
  // https://docs.nano-gpt.com/api-reference/endpoint/check-balance
  "nano-gpt": { name: "NanoGPT", env: "NANOGPT_API_KEY", fetch: async (key) => ({ left: n((await getJson("https://nano-gpt.com/api/check-balance", { method: "POST", headers: { "x-api-key": key } })).usd_balance) }) },
  // https://docs.abliteration.ai/api-reference/credits/get-the-credit-balance-for-the-api-keys-organization
  "abliteration-ai": { name: "abliteration.ai", env: "ABLITERATION_API_KEY", fetch: async (key) => { const d = (await getJson("https://api.abliteration.ai/v1/credits", { headers: { authorization: `Bearer ${key}` } })).data; return spent(n(d?.total_credits), n(d?.total_usage)); } },
};
export const providerName = (p: string) => APIS[p]?.name ?? p.replace(/(^|-)(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());

type Key = { provider: string; key: string; source: string };
/** OpenCode's API-key providers, then the env names, one entry per distinct key. */
export function apiKeys(home = homedir(), env: Record<string, string | undefined> = process.env): Key[] {
  const out: Key[] = [];
  const auth = readJson(`${home}/.local/share/opencode/auth.json`) ?? {};
  for (const [provider, v] of Object.entries<any>(auth)) if (v?.type === "api" && typeof v.key === "string" && v.key) out.push({ provider, key: v.key, source: "OpenCode key" });
  for (const [provider, api] of Object.entries(APIS)) { const k = env[api.env]; if (k) out.push({ provider, key: k, source: `$${api.env}` }); }
  const seen = new Set<string>();
  return out.filter((k) => { const id = `${k.provider}:${fingerprint(k.key)}`; if (seen.has(id)) return false; seen.add(id); return true; });
}

/** OpenCode's other sign-ins (OAuth and the like): signed in, nothing to read. */
export function otherSignIns(home = homedir()): Account[] {
  const auth = readJson(`${home}/.local/share/opencode/auth.json`) ?? {};
  return Object.entries<any>(auth).filter(([, v]) => v && v.type !== "api").map(([provider, v]) => ({
    id: `${provider}:opencode-${String(v.type).replace(/\W/g, "")}`, provider, name: providerName(provider), label: "OpenCode", kind: "signin" as const, note: `signed in to OpenCode (${v.type}); it has no usage data to read`,
  }));
}

// The last answer per key, kept between refreshes (every 10 minutes from src/http/live.ts).
const cache = new Map<string, Account>();
export function creditAccounts(home = homedir(), env = process.env): Account[] {
  return apiKeys(home, env).map((k) => {
    const id = `${k.provider}:${fingerprint(k.key)}`;
    return cache.get(id) ?? { id, provider: k.provider, name: providerName(k.provider), label: k.source, kind: APIS[k.provider] ? "credits" : "signin", note: APIS[k.provider] ? "checking the balance…" : "API key set; this provider has no documented balance endpoint" };
  });
}
export async function refreshCredits(home = homedir(), env = process.env, fetcher?: (p: string, key: string) => Promise<{ left?: number; total?: number; used?: number }>) {
  for (const k of apiKeys(home, env)) {
    const api = APIS[k.provider];
    if (!api) continue;
    const id = `${k.provider}:${fingerprint(k.key)}`;
    const base: Account = { id, provider: k.provider, name: api.name, label: k.source, kind: "credits" };
    try {
      const b = await (fetcher ? fetcher(k.provider, k.key) : api.fetch(k.key));
      cache.set(id, { ...base, at: Date.now(), balance: { ...b, currency: "USD" } });
    } catch (e: any) {
      // Our own words only: a provider's error body could echo the key back.
      const msg = /rejected|answered \d+/.test(String(e?.message)) ? String(e.message) : "couldn’t reach the provider";
      const prev = cache.get(id);
      cache.set(id, { ...base, at: prev?.balance ? prev.at : undefined, balance: prev?.balance, error: msg }); // an old balance keeps its own time
    }
  }
}
