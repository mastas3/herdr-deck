// Only public display tokens cross into the deck. Never forward arbitrary plugin metadata or env values.
// The account tag comes in one token per account kind (herdr-namesync: acct_t Team, acct_m Max, acct_o OpenAI), so a Max
// session on the work machine keeps its tag.
const NAMES = ["ctx", "cache", "stall", "acct_t", "acct_m", "acct_o"] as const;
export type PaneSignals = Partial<Record<(typeof NAMES)[number], string>>;
export function paneSignals(tokens: unknown): PaneSignals | undefined {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return;
  const out: PaneSignals = {};
  for (const name of NAMES) {
    const value = (tokens as any)[name];
    if (typeof value !== "string") continue;
    const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160);
    if (text) out[name] = text;
  }
  return Object.keys(out).length ? out : undefined;
}
