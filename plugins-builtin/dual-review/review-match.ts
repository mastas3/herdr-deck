// Dual review, the pure part: what each reviewer is asked, how its findings file is read, how two lists of findings
// are matched (same file, lines close together, similar words) and the one message that goes back to the session.
import { repairJson } from "../../src/text";

export type Severity = "high" | "medium" | "low";
export type Finding = { file: string; line?: number; endLine?: number; severity: Severity; title: string; detail: string };
export type Side = "claude" | "codex";
export type Group = { status: "agree" | "claude" | "codex"; claude?: Finding; codex?: Finding; score?: number };

/** A git range the reviewers are given: "" (uncommitted changes), "base" (this branch since base), "a..b" or "a...b". */
export function parseRange(range: string): { ok: true; range: string; diff: string[]; words: string } | { ok: false; error: string } {
  const r = String(range ?? "").trim();
  if (!r) return { ok: true, range: "", diff: ["diff", "HEAD"], words: "the uncommitted changes (`git diff HEAD`)" };
  const ref = /^(?!-)[\w.\/@^~{}-]{1,120}$/;
  const m = r.match(/^(.+?)(\.\.\.?)(.+)$/);
  if (m) {
    if (!ref.test(m[1]) || !ref.test(m[3])) return { ok: false, error: `“${r}” isn’t a git range I can pass on` };
    return { ok: true, range: r, diff: ["diff", r], words: `the changes in \`git diff ${r}\`` };
  }
  if (!ref.test(r) || r.includes("..")) return { ok: false, error: `“${r}” isn’t a git ref I can pass on` };
  return { ok: true, range: r, diff: ["diff", `${r}...HEAD`], words: `the commits on this branch since ${r} (\`git diff ${r}...HEAD\`)` };
}

const FORMAT = `{"reviewer":"<you>","findings":[{"file":"src/a.ts","line":12,"endLine":14,"severity":"high","title":"One line: what is wrong","detail":"Why it matters and how to fix it"}]}`;

/** The first message each reviewer gets. Both get the same words so the two lists can be compared. */
export function reviewPrompt(o: { side: Side; cwd: string; words: string; file: string; focus?: string }) {
  return [
    `Review ${o.words} in ${o.cwd}.`,
    `Look for real problems: bugs, security holes, broken edge cases, data loss, missing tests for risky logic. Skip style nits. Do not change any file in the repo.${o.focus ? `\nFocus on: ${o.focus.trim()}` : ""}`,
    `When you are done, write your findings to ${o.file} as JSON in this shape (severity is high, medium or low; paths relative to the repo root; line numbers from the new version):`,
    FORMAT.replace("<you>", o.side),
    `Write {"reviewer":"${o.side}","findings":[]} if you find nothing. Write that file once, at the end, then say "review written".`,
  ].join("\n\n");
}

const SEV: Record<string, Severity> = { high: "high", critical: "high", blocker: "high", major: "high", medium: "medium", moderate: "medium", med: "medium", low: "low", minor: "low", nit: "low", info: "low" };
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined; };
export const normFile = (f: unknown) => String(f ?? "").trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^[ab]\//, "");

function finding(o: any): Finding | undefined {
  if (!o || typeof o !== "object") return;
  let file = normFile(o.file ?? o.path ?? o.location);
  let line = num(o.line ?? o.startLine ?? o.start_line);
  const loc = file.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (loc) { file = loc[1]; line ??= num(loc[2]); o.endLine ??= loc[3]; }
  const title = String(o.title ?? o.summary ?? o.issue ?? "").trim();
  const detail = String(o.detail ?? o.details ?? o.description ?? o.body ?? "").trim();
  if (!title && !detail) return;
  const endLine = num(o.endLine ?? o.end_line);
  return { file, line, endLine: endLine && line && endLine >= line ? endLine : undefined, severity: SEV[String(o.severity ?? o.priority ?? "").toLowerCase()] ?? "medium", title: (title || detail).slice(0, 240), detail: title ? detail.slice(0, 4000) : "" };
}

/** A findings file as the agent wrote it: JSON as asked, JSON with prose around it, or a markdown list
 *  ("- [high] src/a.ts:12 — title"). `undefined` while there's nothing readable yet. */
export function parseFindings(text: string): Finding[] | undefined {
  const t = String(text ?? "").trim();
  if (!t) return;
  let j: any;
  try { j = JSON.parse(t); } catch { j = repairJson(t); }
  const list = Array.isArray(j) ? j : Array.isArray(j?.findings) ? j.findings : undefined;
  if (list) return list.map(finding).filter(Boolean) as Finding[];
  const md = [...t.matchAll(/^\s*(?:[-*]|\d+\.)\s+(?:\[(\w+)\]\s*)?`?([\w./-]+\.\w+)(?::(\d+)(?:-(\d+))?)?`?\s*[—:-]+\s*(.+)$/gm)];
  if (!md.length) return;
  return md.map((m) => finding({ severity: m[1], file: m[2], line: m[3], endLine: m[4], title: m[5] })).filter(Boolean) as Finding[];
}

const STOP = new Set("the and for that this with from are was were not but can could should would may might will into when then than there their them they its it's has have had does did doing done use used uses using any all one two also only just more most some such very what which while where who why how here missing issue problem bug code file line lines function method value values call calls".split(" "));
const words = (f: Finding) => new Set(`${f.title} ${f.detail}`.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g)?.filter((w) => !STOP.has(w)) ?? []);
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}
/** How many lines apart two findings are (0 when their ranges overlap). */
function gap(a: Finding, b: Finding) {
  if (!a.line || !b.line) return undefined;
  const a2 = a.endLine ?? a.line, b2 = b.endLine ?? b.line;
  return Math.max(0, Math.max(a.line, b.line) - Math.min(a2, b2));
}

/** How alike two findings are, 0..1; 0 when they can't be the same (different files). */
export function likeness(a: Finding, b: Finding, slack = 6): number {
  if (normFile(a.file) !== normFile(b.file)) return 0;
  const text = jaccard(words(a), words(b));
  const g = gap(a, b);
  if (g === undefined) return text >= 0.3 ? text : 0; // no line numbers: the words alone must agree
  if (g <= slack) return text >= 0.08 || g === 0 ? 0.55 + 0.45 * text : 0;
  if (g <= slack * 4) return text >= 0.3 ? 0.35 + 0.5 * text : 0;
  return text >= 0.55 ? 0.3 + 0.4 * text : 0;
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
/** Both lists as groups: pairs that match (best pairs first, each finding used once), then the rest on their own.
 *  Agreements first, then by severity, then by file and line. */
export function matchFindings(claude: Finding[], codex: Finding[], min = 0.3): Group[] {
  const pairs: { i: number; j: number; s: number }[] = [];
  claude.forEach((a, i) => codex.forEach((b, j) => { const s = likeness(a, b); if (s >= min) pairs.push({ i, j, s }); }));
  pairs.sort((x, y) => y.s - x.s);
  const usedA = new Set<number>(), usedB = new Set<number>(), out: Group[] = [];
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i); usedB.add(p.j);
    out.push({ status: "agree", claude: claude[p.i], codex: codex[p.j], score: Math.round(p.s * 100) / 100 });
  }
  claude.forEach((f, i) => { if (!usedA.has(i)) out.push({ status: "claude", claude: f }); });
  codex.forEach((f, j) => { if (!usedB.has(j)) out.push({ status: "codex", codex: f }); });
  const sev = (g: Group) => Math.min(RANK[g.claude?.severity ?? "low"], RANK[g.codex?.severity ?? "low"]);
  const at = (g: Group) => g.claude ?? g.codex!;
  const st = { agree: 0, claude: 1, codex: 1 };
  return out.sort((x, y) => st[x.status] - st[y.status] || sev(x) - sev(y) || at(x).file.localeCompare(at(y).file) || (at(x).line ?? 0) - (at(y).line ?? 0));
}

const WHO = { agree: "both found", claude: "only Claude", codex: "only Codex" };
const where = (f: Finding) => (f.file ? `${f.file}${f.line ? `:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}` : ""}` : "(no file)");

/** The one message sent back to the session that made the change. */
export function composeMessage(groups: Group[], o: { words: string }): string {
  const items = groups.map((g, n) => {
    const f = g.claude ?? g.codex!;
    const sev = g.claude && g.codex && RANK[g.codex.severity] < RANK[g.claude.severity] ? g.codex.severity : f.severity;
    const detail = [g.claude?.detail && `${g.codex ? "Claude: " : ""}${g.claude.detail}`, g.codex?.detail && `${g.claude ? "Codex: " : ""}${g.codex.detail}`].filter(Boolean).map((d) => `   ${String(d).replace(/\n+/g, " ")}`);
    return [`${n + 1}. [${WHO[g.status]}, ${sev}] ${where(f)}: ${f.title}`, ...detail].join("\n");
  });
  return [`Claude and Codex both reviewed ${o.words}. Here ${groups.length === 1 ? "is the finding" : `are ${groups.length} findings`} I picked:`, ...items, "Fix what is right. If a finding is wrong, say which one and why."].join("\n\n");
}
