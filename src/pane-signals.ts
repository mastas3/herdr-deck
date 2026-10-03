// Only public display tokens cross into the deck. Never forward arbitrary plugin metadata or env values.
export type PaneSignals = Partial<Record<"ctx" | "cache" | "stall" | "acct_t", string>>;
export function paneSignals(tokens: unknown): PaneSignals | undefined {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return;
  const out: PaneSignals = {};
  for (const name of ["ctx", "cache", "stall", "acct_t"] as const) {
    const value = (tokens as any)[name];
    if (typeof value !== "string") continue;
    const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160);
    if (text) out[name] = text;
  }
  return Object.keys(out).length ? out : undefined;
}
