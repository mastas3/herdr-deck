// The pre-mortem: for each idea that survived judging, the three most likely reasons it fails (each tied to a success
// pattern it breaks and to evidence when there is some), and a revised version that fixes the biggest one. Both are
// judged the same way (Jev p10, the success patterns, evidence, the slop gate) and the better one stays; the card keeps
// "why this could fail → how this version fixes it".
import type { Idea, Inventory, PainPost } from "./types";
import type { ClaudeRunner } from "./llm";
import { builderSummary, ideaCard } from "./judge";
import { extractRecords, list, str } from "./json";
import { normalizeIdea } from "./strategies";
import { PATTERNS, PATTERN_LINES } from "./success";
import type { Passage } from "./library";
import { CH_LABEL, type Comparables } from "../library-strategy";

type Premortem = NonNullable<Idea["premortem"]>;
export const ABANDON = /^(?:abandon|drop|don'?t (?:ship|build)|skip this|merge|consolidate|ship i\d+\b.{0,40}\binstead)|duplicate of i\d+/i;
type PremortemInput = { idea: Idea; posts: PainPost[]; outside: Passage[]; comparables?: Comparables };
/** Comparable founders as citable evidence lines, "(c1-2) Acme [Mar 2024]: …", with what they sold, how, and what failed. */
export function comparableEvidence(r: Comparables | undefined, i: number, max = 3): string[] {
  return (r?.comparables ?? []).slice(0, max).map((c, j) => {
    const ch = c.first.find((x) => x.channel !== "other") ?? c.first[0];
    const bits = [c.sells ? `sold ${str(c.sells, 90)}` : "", c.price ? `price "${str(c.price.text, 50)}"` : "", c.revenue ? `claimed revenue "${str(c.revenue.text, 50)}"` : "",
      ch ? `first customers via ${CH_LABEL[ch.channel] ?? ch.channel}: ${str(ch.text, 120)}` : "", c.failed[0] ? `what failed: ${str(c.failed[0].text, 140)}` : ""].filter(Boolean);
    return `(c${i + 1}-${j + 1}) comparable ${c.name}${c.published ? ` [${c.published}${c.old ? `, ${c.old}` : ""}]` : ""}: ${bits.join("; ")} ${c.failed[0]?.link ?? c.url}`;
  });
}

function premortemPrompt(items: PremortemInput[], inv: Inventory) {
  const system = "You are a skeptical operator who has watched many small products fail. You find the specific, likely reasons an idea fails for this builder, then rewrite it into a stronger version. No hype, no invented statistics, no made-up quotes. Strict JSON only: no prose, no Markdown fences.";
  const blocks = items.map((it, i) => {
    const ev = [
      ...it.posts.slice(0, 3).map((p) => `(${p.id}) ${p.source}: "${str(p.snippet, 200)}"`),
      ...(it.idea.trend?.signals ?? []).slice(0, 2).map((s) => `(${s.id}) trend: ${str(s.title, 140)}`),
      ...it.outside.slice(0, 3).map((p, j) => `(x${i + 1}-${j + 1}) ${p.source}: "${str(p.text, 240)}"${p.url ? ` ${p.url}` : ""}`),
      ...comparableEvidence(it.comparables, i),
    ];
    const check = it.comparables?.checks.length ? `\nStrategy check against comparables: ${it.comparables.checks.join(" ")}` : "";
    return `[i${i + 1}] ${JSON.stringify(ideaCard(it.idea, `i${i + 1}`))}\nEvidence you may cite by id:\n${ev.length ? ev.join("\n") : "(none)"}${check}`;
  });
  const user = [
    "THE BUILDER", builderSummary(inv), "",
    "SUCCESS PATTERNS (from real indie businesses; cite by number):", ...PATTERN_LINES, "",
    "IDEAS", ...blocks, "",
    "For each idea:",
    "- failures: the 3 most likely reasons it fails, most likely first. Be specific to this buyer and market (e.g. \"coaches already get free charts from Genetic Matrix\", \"Telegram payments are awkward for Israeli buyers\"), not generic (\"competition\", \"marketing is hard\"). Each names the pattern number it breaks and an evidence id from the list, or \"none\".",
    "- Comparable founders (ids c…) are real businesses like this one. When one stalled, failed or needed something this idea lacks, make that a failure and cite it (\"comparable Acme stalled on retention\", evidence c1-2). When this idea's price or channel is far from what they did, say so. Only what their line says; never add to it.",
    "- fix: one sentence: which failure the revised version removes, and how.",
    "- revised: the stronger version, with every field of the original (name, hook, buyer, pain, offer, price, channel, mvp, stack, needs, days_to_first_dollar, difficulty, quests, edge). Keep what was good; change what the biggest failure requires (buyer, offer, price, channel or format). Keep the builder's own project in the stack.",
    "",
    'Reply exactly: {"premortems":[{"ref":"i1","failures":[{"reason":"...","pattern":1,"evidence":"id or none"}],"fix":"...","revised":{"name":"...","hook":"...","buyer":"...","pain":"...","offer":"...","price":"...","channel":"...","mvp":"...","stack":[{"name":"...","role":"..."}],"needs":[],"days_to_first_dollar":14,"difficulty":"week","quests":["...","...","..."],"edge":"..."}}]}',
  ].join("\n");
  return { system, user };
}
/** Parse the reply: per original idea, its pre-mortem and the revised idea (as a normal Idea, same strategy and round). */
export function parsePremortems(text: string, items: PremortemInput[], inv: Inventory): Map<string, { premortem: Premortem; revised?: Idea }> {
  const out = new Map<string, { premortem: Premortem; revised?: Idea }>();
  extractRecords(text, ["premortems"], ["ref", "failures"]).forEach((r, i) => {
    const m = String(r?.ref ?? "").match(/\d+/);
    const it = items[m ? Number(m[0]) - 1 : i];
    if (!it || out.has(it.idea.id)) return;
    const failures = (Array.isArray(r.failures) ? r.failures : []).slice(0, 3).map((f: any) => {
      const n = Number(String(f?.pattern ?? "").match(/\d/)?.[0]);
      const raw = /^none$/i.test(String(f?.evidence ?? "none").trim()) ? undefined : str(f?.evidence, 160);
      // A comparable's id becomes its name and the link to the moment, so the card can show where it came from.
      const cm = raw?.match(/^\(?c(\d+)-(\d+)\)?$/);
      const comp = cm && Number(cm[1]) - 1 === items.indexOf(it) ? it.comparables?.comparables[Number(cm[2]) - 1] : undefined;
      const evidence = comp ? `${comp.name}: ${comp.failed[0]?.link ?? comp.url}` : raw;
      // A number with no evidence behind it is the model's guess: say so rather than present it as fact.
      const reason = str(f?.reason, 220);
      return { reason: !evidence && /\d/.test(reason) ? `${reason} (numbers are the model's estimate, not sourced)` : reason, pattern: PATTERNS[n - 1]?.label, evidence };
    }).filter((f: any) => f.reason);
    const fix = str(r.fix, 300);
    // "Abandon", "merge into i2", "duplicate of i3": the critic says this one shouldn't be built as is.
    const verdict = ABANDON.test(fix) ? "abandon" : "improve";
    const premortem: Premortem = { failures, fix, verdict };
    const o = it.idea;
    // The revision cites the same posts and rides the same trend as the original.
    const brief = { id: o.briefId ?? o.id, strategy: o.strategy, pain: { quotes: it.posts } as any, compat: 0, demand: 0 };
    const rev = r.revised ? normalizeIdea({ ...r.revised, evidence_ids: o.evidenceIds }, brief as any, o.strategy, "premortem", o.round, inv) : undefined;
    if (rev) { rev.id = `${o.id}:pm`; rev.trend = o.trend; rev.premortem = { ...premortem, pivotedFrom: { name: o.name, hook: o.hook } }; }
    out.set(o.id, { premortem, revised: rev });
  });
  return out;
}
export async function runPremortems(items: PremortemInput[], inv: Inventory, claude: ClaudeRunner, tag: string, model = "haiku") {
  const p = premortemPrompt(items, inv);
  const r = await claude({ system: p.system, user: p.user, model, tag });
  return { results: parsePremortems(r.text, items, inv), run: r };
}
/** Which version to keep: the one with the higher comparable score (the revision must win by a margin to replace). */
export const keepRevised = (orig: number, rev: number, margin = 0.02) => rev > orig + margin;
