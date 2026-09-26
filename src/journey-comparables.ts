// Project pages → Founder Library: what founders most like this project did at the milestone it's working toward.
// The page's "Plan the next milestone" prompt adds this text (public/js/journey-comparables.js asks for it), so the
// plan starts from real tactics with links instead of generic advice. Word matching only: instant, no model call.
import { comparablesFor, milestoneKind, tacticsText, type Comparables, type Target } from "./library-strategy";

type JourneyLike = { project: string; pitch?: string; tldr?: string; tags?: string[]; milestones: { id: string; title: string; state: string }[]; next: string[] };

export function journeyComparables(j: JourneyLike, find: (t: Target) => Comparables | undefined = comparablesFor) {
  const m = j.milestones.find((x) => x.id === j.next[0]) ?? j.milestones.find((x) => x.state !== "unlocked");
  const r = find({ name: j.project, offer: j.pitch, text: [j.tldr, ...(j.tags ?? [])].filter(Boolean).join(" ") });
  const milestone = m?.title ?? "first paying customer";
  const tactics = tacticsText(r, milestone);
  return {
    project: j.project, milestone, kind: milestoneKind(milestone),
    text: tactics ? `${tactics}${r?.summary.length ? `\nAcross them: ${r.summary.join(" ")}` : ""}\nUse these where they fit this project (cite the links in the plan); they are other founders' claims, not facts about this market.` : "",
    items: (r?.comparables ?? []).slice(0, 4).map((c) => ({ name: c.name, link: c.url, published: c.published, old: c.old, revenue: c.revenue?.text })),
  };
}
