// Founder Library: spot-checking the local model's cards against Claude's reading of the same transcript, with the
// same prompt and the same claim checks. It spends real Claude calls (headless `claude -p`, as the Studio does), so
// it is capped: 15 calls in all, counted in <library>/spotcheck/calls.json. Reports go next to it as JSON.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Library } from "./library";
import { amounts, buildCard, EXTRACT_SYSTEM, extractUser, parseCardJson, toLines, transcriptParts, type Card } from "./library-extract";
import { runClaude } from "../../src/model-run";

export const SPOTCHECK_CAP = 15;
const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const amt = (c?: { text: string }) => c?.text ?? "";

/** Field-by-field agreement between two cards of the same video. */
export function compareCards(local: Card, ref: Card) {
  const chans = (c: Card) => new Set(c.first.map((x) => x.channel));
  const a = chans(local), b = chans(ref);
  const inter = [...a].filter((x) => b.has(x)).length, union = new Set([...a, ...b]).size;
  const nameMatch = !!local.business && !!ref.business && (norm(local.business).includes(norm(ref.business)) || norm(ref.business).includes(norm(local.business)));
  return {
    id: local.id, title: local.title,
    business: { local: local.business, claude: ref.business, match: nameMatch || (!local.business && !ref.business) },
    btype: { local: local.btype, claude: ref.btype, match: local.btype === ref.btype },
    // Same claim = both have one and they state the same amount (wording differs: "11,000 MR" vs "$11,000/month").
    revenue: { local: amt(local.revenue), claude: amt(ref.revenue), match: !!local.revenue === !!ref.revenue && (!local.revenue || amounts(local.revenue.text)[0] === amounts(ref.revenue!.text)[0]) },
    price: { local: amt(local.price), claude: amt(ref.price), match: !!local.price === !!ref.price },
    firstChannels: { local: [...a], claude: [...b], jaccard: union ? +(inter / union).toFixed(2) : 1 },
    counts: { local: [local.first.length, local.lessons.length, local.failed.length], claude: [ref.first.length, ref.lessons.length, ref.failed.length] },
    dropped: { local: local.checks.dropped, claude: ref.checks.dropped },
  };
}

export async function spotCheck(lib: Library, n: number, ids: string[] = [], model = "sonnet") {
  const dir = `${lib.dir}/spotcheck`;
  mkdirSync(dir, { recursive: true });
  let used = 0;
  try { used = JSON.parse(readFileSync(`${dir}/calls.json`, "utf8")).used ?? 0; } catch {}
  const left = SPOTCHECK_CAP - used;
  if (left <= 0) { console.log(`The spot-check budget (${SPOTCHECK_CAP} Claude calls) is used up.`); return []; }
  const all = lib.cards().all().filter((c) => c.kind === "founder_story");
  const pick = (ids.length ? all.filter((c) => ids.includes(c.id)) : all.sort((x, y) => (y.views ?? 0) - (x.views ?? 0))).slice(0, Math.min(n, left));
  const out = [];
  for (const local of pick) {
    const src = lib.config().sources.find((s) => s.id === local.source)!;
    const q = lib.queues.read(src.id);
    const segs = JSON.parse(readFileSync(lib.transcriptPath(q, src.id, local.id), "utf8")).segments ?? [];
    const lines = toLines(segs);
    const parts = transcriptParts(lines);
    const raws = [];
    const t0 = Date.now();
    for (let i = 0; i < parts.length && used < SPOTCHECK_CAP; i++) {
      used++;
      writeFileSync(`${dir}/calls.json`, JSON.stringify({ used }));
      const r = await runClaude({ system: EXTRACT_SYSTEM, user: extractUser(local.title, q.title ?? src.id, parts[i], i, parts.length), timeoutMs: 180_000, signal: AbortSignal.timeout(180_000), onText: () => {}, model });
      const j = parseCardJson(r.text);
      if (j) raws.push(j);
    }
    const ref = buildCard(raws, lines, { id: local.id, source: local.source, title: local.title, url: local.url, duration: local.duration }, `claude-${model}`);
    const cmp = { ...compareCards(local, ref), claudeMs: Date.now() - t0, claudeCard: ref, localCard: local };
    out.push(cmp);
    console.log(`${local.id} ${local.title.slice(0, 50)} | business ${cmp.business.match ? "=" : "≠"} (${cmp.business.local} / ${cmp.business.claude}) | revenue ${cmp.revenue.match ? "=" : "≠"} (${cmp.revenue.local} / ${cmp.revenue.claude}) | type ${cmp.btype.match ? "=" : "≠"} | channels J=${cmp.firstChannels.jaccard} (${cmp.firstChannels.local.join(",")} / ${cmp.firstChannels.claude.join(",")}) | items L${cmp.counts.local} C${cmp.counts.claude} | dropped L${local.checks.dropped.length} C${ref.checks.dropped.length}`);
  }
  writeFileSync(`${dir}/report-${Date.now()}.json`, JSON.stringify(out, null, 1));
  console.log(`Claude calls used: ${used} of ${SPOTCHECK_CAP}`);
  return out;
}
