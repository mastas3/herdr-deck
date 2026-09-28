// What the deck keeps current on its own: the history index, AI accounts and their limits (this machine's, merged with
// the other machines' decks), which dev servers are shared on the tailnet, and proof of done. Started once at startup
// (src/server.ts), in this order.
import { startHistory, historyStats } from "../history";
import { localUsage, type MachineUsage } from "../usage-accounts";
import { refreshCredits } from "../usage-credits";
import { mergeUsage } from "../usage-merge";
import { servedPorts } from "../share";
import { claimsDone, onCheck, resultFor, verify } from "../verify";
import type { Automations } from "../automations";
import type { Deck, Row } from "../deck";
import type { Detail } from "../transcript";

type Deps = {
  deck: Deck; broadcast: (event: string, data: unknown) => void; auto: Automations | undefined;
  game: { onCheck: (root: string, r: any) => void }; detailFor: (row: Row) => Promise<Detail | undefined>;
  selfId: string; remoteUsage: () => Record<string, MachineUsage | undefined>;
};

export function startLive(o: Deps) {
  const { deck, broadcast, auto, game, detailFor } = o;
  startHistory({ changed: () => broadcast("history", historyStats()) });
  setInterval(() => broadcast("history", historyStats()), 5_000);

  // Local files every 20 s; credit balances from the providers every 10 minutes; a node's reading when it sends one.
  let local = localUsage();
  const usage = () => mergeUsage(o.selfId, { [o.selfId]: local, ...o.remoteUsage() });
  const pushUsage = () => broadcast("usage", usage());
  const readLocal = () => {
    const u = localUsage();
    if (JSON.stringify(u.accounts) !== JSON.stringify(local.accounts)) { local = u; pushUsage(); }
  };
  setInterval(readLocal, 20_000);
  const credits = () => refreshCredits().then(readLocal, () => {});
  credits();
  setInterval(credits, 10 * 60_000);

  async function refreshShared() {
    const m = await servedPorts().catch(() => new Map());
    if (JSON.stringify([...m]) !== JSON.stringify([...deck.shared])) { deck.shared = m; deck.refresh(); }
  }
  refreshShared();
  setInterval(refreshShared, 15_000);

  // A finished session that claims it's done gets its project's checks re-run (once you've approved them).
  for (const row of deck.rows.values()) { const r = row.projectRoot && resultFor(row.projectRoot); if (r) deck.checks.set(row.projectRoot!, r); }
  onCheck((root, r) => {
    game.onCheck(root, r);
    deck.checks.set(root, r);
    deck.refresh();
    if (["pass", "fail", "error"].includes(r.state)) auto?.record("proof", `${root.split("/").pop()}: ${r.state === "pass" ? "checks passed" : r.state === "fail" ? `checks failed (exit ${r.exit})` : `couldn’t run (${r.reason ?? "error"})`} · ${r.cmd ?? ""}`, r.state === "pass");
  });
  const claimSeen = new Map<string, number>();
  async function maybeVerify(row: Row) {
    if (row.app || !row.projectRoot || row.status !== "done" || row.seen || !row.sessionId) return;
    if (auto && !auto.rules.proof.on) return; // Settings → Automations → Proof of done
    if (claimSeen.get(row.key) === row.lastActiveAt) return;
    claimSeen.set(row.key, row.lastActiveAt ?? 0);
    const d = await detailFor(row).catch(() => undefined);
    const last = [...(d?.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.text)?.text;
    if (!claimsDone(last)) return;
    const r = await verify(row.projectRoot).catch(() => undefined);
    if (r) { deck.checks.set(row.projectRoot, r); deck.refresh(); }
  }
  deck.onPatch((patch) => { for (const r of patch.upsert) maybeVerify(r); });

  return { usage, pushUsage, refreshShared };
}
