// The Inbox's decisions (every session that needs you, as a question with options), rebuilt on each patch, and the
// stuck-and-drift radar that runs on the same beat.
import { splitKey, type RemoteHost } from "../federation";
import { buildDecision, judge, needsYou, type Decision } from "../decisions";
import { jevAvailable, jevFeature, jevUsage } from "../jev";
import { linkPath, type Automations } from "../automations";
import { call } from "../herdr";
import { Radar } from "../radar";
import type { PushStore } from "../push";
import type { Deck, Row } from "../deck";
import type { Detail } from "../transcript";

type Deps = {
  deck: Deck; remotes: Map<string, RemoteHost>; allRows: () => Row[]; detailFor: (row: Row) => Promise<Detail | undefined>;
  broadcast: (event: string, data: unknown) => void; isNode: () => boolean; push: PushStore; auto: Automations | undefined; viewing: (key: string) => boolean;
};

export function createDecisions(o: Deps) {
  const { deck, remotes, allRows, detailFor, broadcast, isNode, push, auto, viewing } = o;
  const decisions = new Map<string, Decision>();
  const chatTail = async (row: Row) => {
    const route = splitKey(row.key, remotes);
    if (route.remote) return (await route.remote.post("/api/chat", { key: route.key, limit: 40 })).data;
    const d = await detailFor(row);
    return d ? { messages: d.messages.slice(-40) } : undefined;
  };
  /** What a waiting pane shows right now (full screen, blank lines kept), on whichever machine it's on. */
  const screenOf = async (row: Row): Promise<string[] | undefined> => {
    const route = splitKey(row.key, remotes);
    let text: string | undefined;
    if (route.remote) text = (await route.remote.post("/api/read", { key: route.key, lines: 60 })).data?.text;
    else {
      const f = deck.find(row.key);
      if (!f) return;
      text = (await call(f.sess.socket, "pane.read", { pane_id: f.row.paneId, source: "visible" }))?.read?.text;
    }
    return text ? String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").slice(-60) : undefined;
  };
  let decTimer: Timer | undefined;
  // The radar runs on the same beat but on its own: the decisions rebuild never waits for it.
  const scheduleDecisions = () => { clearTimeout(decTimer); decTimer = setTimeout(() => { rebuildDecisions(); radar.pass(allRows()).catch(() => {}); }, 350); };
  async function rebuildDecisions() {
    const rows = allRows().filter(needsYou);
    const next = new Map<string, Decision>();
    await Promise.all(rows.map(async (r) => {
      const d = await buildDecision(r, chatTail, screenOf).catch(() => undefined);
      if (!d) return;
      next.set(r.key, d);
      judge(d, r, chatTail, scheduleDecisions).catch(() => {});
    }));
    const before = JSON.stringify([...decisions.values()]);
    decisions.clear();
    for (const [k, v] of next) decisions.set(k, v);
    if (JSON.stringify([...decisions.values()]) !== before) broadcast("decisions", [...decisions.values()]);
    const u = jevUsage();
    if (u.calls !== lastJevCalls) { lastJevCalls = u.calls; broadcast("jev", u); }
  }
  let lastJevCalls = jevUsage().calls;
  // Stuck and drift radar: running sessions that look stuck get a Jev read, shown as a chip; two confident
  // "stuck" reads in a row push once (as a "needs you" alert, so device choices and quiet hours apply).
  const radar = new Radar({
    chat: chatTail,
    changed: (list) => broadcast("radar", list),
    enabled: () => !isNode() && jevFeature("radar") && jevAvailable(), // only the hub asks
    push: (m, r) => {
      const rules = auto?.rules.alerts;
      if (isNode() || (rules && !(rules.on && rules.needs)) || viewing(r.key)) return;
      push.deliver({ ...m, url: linkPath(r) }, { urgency: "high", ttl: 6 * 3600, topic: `r${Bun.hash(r.key).toString(36)}` }).catch(() => {});
    },
  });
  return { decisions, chatTail, screenOf, scheduleDecisions, radar };
}
