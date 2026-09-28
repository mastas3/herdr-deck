// What the deck keeps current on its own: the history index, plan usage, which dev servers are shared on the
// tailnet, and proof of done. Started once at startup (src/server.ts), in this order.
import { startHistory, historyStats } from "../history";
import { usage } from "../usage";
import { servedPorts } from "../share";
import { claimsDone, onCheck, resultFor, verify } from "../verify";
import type { Automations } from "../automations";
import type { Deck, Row } from "../deck";
import type { Detail } from "../transcript";

type Deps = {
  deck: Deck; broadcast: (event: string, data: unknown) => void; auto: Automations | undefined;
  game: { onCheck: (root: string, r: any) => void }; detailFor: (row: Row) => Promise<Detail | undefined>;
};

export function startLive(o: Deps) {
  const { deck, broadcast, auto, game, detailFor } = o;
  startHistory({ changed: () => broadcast("history", historyStats()) });
  setInterval(() => broadcast("history", historyStats()), 5_000);

  let currentUsage = usage();
  setInterval(() => {
    const u = usage();
    if (JSON.stringify(u) !== JSON.stringify(currentUsage)) { currentUsage = u; broadcast("usage", u); }
  }, 20_000);

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

  return { usage: () => currentUsage, refreshShared };
}
