// Every machine's accounts as one list for the page. The same account on several machines (one ChatGPT login on the
// Mac and the Linux box) is one entry: its limits are the account's, so the freshest reading wins, and it lists the
// machines it's signed in on.
import type { Account, MachineUsage } from "./usage-accounts";

export type MergedAccount = Account & { machines: string[]; from?: string };
/** What the page gets as `usage`: `machines` holds each deck's own reading, so a hub can merge a node's again. */
export type UsagePayload = { self: string; machines: Record<string, MachineUsage>; accounts: MergedAccount[] };

const ORDER = ["claude", "codex", "gemini"];
const rank = (a: Account) => (ORDER.includes(a.provider) ? ORDER.indexOf(a.provider) : a.kind === "credits" ? 10 : 20);

export function mergeUsage(self: string, byMachine: Record<string, MachineUsage | undefined>): UsagePayload {
  const machines: Record<string, MachineUsage> = {};
  const map = new Map<string, MergedAccount>();
  for (const [m, mu] of Object.entries(byMachine)) {
    if (!mu || !Array.isArray(mu.accounts)) continue;
    machines[m] = mu;
    for (const a of mu.accounts) {
      if (!a?.id) continue;
      const prev = map.get(a.id);
      if (!prev) { map.set(a.id, { ...a, machines: [m], from: a.at ? m : undefined }); continue; }
      if (!prev.machines.includes(m)) prev.machines.push(m);
      if ((a.at ?? -1) > (prev.at ?? -1)) map.set(a.id, { ...a, machines: prev.machines, from: m });
    }
  }
  const accounts = [...map.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || String(a.label).localeCompare(String(b.label)));
  return { self, machines, accounts };
}

/** A node's own reading out of the payload its deck sends (older decks send another shape: nothing). */
export const nodeUsage = (u: any): MachineUsage | undefined => (u && typeof u.self === "string" ? u.machines?.[u.self] : undefined);
